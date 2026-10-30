// SPDX-License-Identifier: AGPL-3.0-only
package inbound_webhooks

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

const (
	ActionIntentAutomationEvent = "automation_event"
	ActionIntentTriggerAction   = "trigger_action"

	ActionIntentPending   = "pending"
	ActionIntentLeased    = "leased"
	ActionIntentSucceeded = "succeeded"
	ActionIntentFailed    = "failed"
)

// RecordEventOptions describes non-trigger work that is known at receive time.
// Explicit inbound_webhook_triggers are always evaluated and snapshotted by
// RecordEventWithActions inside the event transaction.
type RecordEventOptions struct {
	QueueAutomationEvent      bool
	AutomationSubscriberEmail string
	// AuthenticatedRawBodySHA256 binds replay collision checks to the exact
	// sender bytes that were covered by the HMAC, independent of transforms.
	AuthenticatedRawBodySHA256 []byte
}

// ActionIntent is the immutable work snapshot plus its mutable lease state.
// It intentionally carries no stored request/response bodies or raw errors.
// The worker loads the already-retained inbound_events body and records only a
// bounded error code / HTTP status on failure.
type ActionIntent struct {
	ID              string
	TenantID        string
	InboundEventID  int64
	EndpointID      string
	ReplayID        *string
	IntentKind      string
	TriggerID       *string
	TriggerName     *string
	ActionType      *string
	ActionTargetID  *string
	SubscriberEmail *string
	Attempts        int
	LeaseToken      string
	Body            []byte
	OccurredAt      time.Time
}

type plannedAction struct {
	kind            string
	triggerID       *string
	triggerName     *string
	actionType      *string
	actionTargetID  *string
	subscriberEmail *string
	initialState    string
	errorCode       string
	match           Match
}

// RecordEventWithActions atomically claims the sender replay identity, retains
// the processed event, freezes every matching explicit trigger, and inserts a
// general automation-event intent when configured. Exact sender retries nudge
// unfinished pending/expired work but never mint duplicate action rows.
func (r *Repo) RecordEventWithActions(
	ctx context.Context,
	tenantID, endpointID string,
	headersJSON, body []byte,
	sigValid bool,
	sourceEventID string,
	options RecordEventOptions,
) (eventID int64, duplicate bool, actionCount int, err error) {
	sourceEventID = strings.TrimSpace(sourceEventID)
	if !strings.HasPrefix(sourceEventID, inboundReplayKeyPrefix) ||
		len(sourceEventID) != len(inboundReplayKeyPrefix)+(sha256.Size*2) {
		return 0, false, 0, fmt.Errorf("inbound_webhooks: invalid replay key")
	}
	if r == nil || r.Pool == nil {
		return 0, false, 0, errors.New("inbound_webhooks: action outbox repository is unavailable")
	}
	rawDigest := append([]byte(nil), options.AuthenticatedRawBodySHA256...)
	if len(rawDigest) == 0 {
		fallback := sha256.Sum256(body)
		rawDigest = fallback[:]
	}
	if len(rawDigest) != sha256.Size {
		return 0, false, 0, errors.New("inbound_webhooks: authenticated raw body digest must be SHA-256")
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return 0, false, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockEnabledInboundEndpoint(ctx, tx, tenantID, endpointID); err != nil {
		return 0, false, 0, err
	}

	row := tx.QueryRow(ctx, `
INSERT INTO inbound_events
       (tenant_id, endpoint_id, headers, body_bytes, signature_valid,
        source_event_id, authenticated_raw_body_sha256)
VALUES ($1::uuid, $2::uuid, $3::jsonb, $4, $5, $6, $7)
ON CONFLICT (endpoint_id, source_event_id)
    WHERE source_event_id IS NOT NULL
DO NOTHING
RETURNING id`,
		tenantID, endpointID, string(headersJSON), body, sigValid, sourceEventID, rawDigest)
	switch scanErr := row.Scan(&eventID); {
	case scanErr == nil:
		// First receipt. Action planning continues in this transaction.
	case errors.Is(scanErr, pgx.ErrNoRows):
		var existingBody, existingRawDigest []byte
		if queryErr := tx.QueryRow(ctx, `
SELECT id, body_bytes, authenticated_raw_body_sha256
  FROM inbound_events
 WHERE endpoint_id = $1::uuid
   AND source_event_id = $2
 ORDER BY id DESC
 LIMIT 1
 FOR SHARE`, endpointID, sourceEventID).Scan(
			&eventID,
			&existingBody,
			&existingRawDigest,
		); queryErr != nil {
			return 0, false, 0, queryErr
		}
		if len(existingRawDigest) == sha256.Size {
			if !hmac.Equal(existingRawDigest, rawDigest) {
				return 0, false, 0, ErrReplayConflict
			}
		} else if !hmac.Equal(existingBody, body) {
			// Legacy rows predate the authenticated raw digest. Their retained
			// processed bytes are the only collision evidence available.
			return 0, false, 0, ErrReplayConflict
		}
		// A provider retry is also a durable wake-up signal. Reclaim only rows
		// that are not actively leased; succeeded/permanent-failed actions stay
		// terminal and therefore cannot double-apply.
		tag, nudgeErr := tx.Exec(ctx, `
UPDATE inbound_webhook_action_intents
   SET state = 'pending',
       next_attempt_at = now(),
       lease_token = NULL,
       lease_expires_at = NULL,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND inbound_event_id = $2
   AND (
       state = 'pending'
       OR (state = 'leased' AND lease_expires_at <= now())
   )`, tenantID, eventID)
		if nudgeErr != nil {
			return 0, false, 0, nudgeErr
		}
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return 0, false, 0, commitErr
		}
		return eventID, true, int(tag.RowsAffected()), nil
	default:
		return 0, false, 0, scanErr
	}

	plans, _, planErr := r.planTriggerActionsTx(ctx, tx, tenantID, endpointID, body)
	if planErr != nil {
		return 0, false, 0, planErr
	}
	if options.QueueAutomationEvent {
		email := normalizeActionEmail(options.AutomationSubscriberEmail)
		if email == "" {
			return 0, false, 0, errors.New("inbound_webhooks: automation event recipient is invalid")
		}
		plans = append(plans, plannedAction{
			kind:            ActionIntentAutomationEvent,
			subscriberEmail: stringPointer(email),
			initialState:    ActionIntentPending,
		})
	}
	for _, plan := range plans {
		if insertErr := insertActionIntentTx(ctx, tx, tenantID, endpointID, eventID, nil, plan); insertErr != nil {
			return 0, false, 0, insertErr
		}
		if plan.initialState == ActionIntentFailed && plan.triggerID != nil {
			if fireErr := recordFireTx(ctx, tx, tenantID, *plan.triggerID); fireErr != nil {
				return 0, false, 0, fireErr
			}
		}
		actionCount++
	}
	if commitErr := tx.Commit(ctx); commitErr != nil {
		return 0, false, 0, commitErr
	}
	return eventID, false, actionCount, nil
}

// QueueReplay snapshots the triggers that match now and creates one fresh
// semantic attempt. It deliberately does not enqueue the endpoint-wide
// automation_event fanout: the historical replay API has always promised to
// re-run explicit trigger actions only.
func (r *Repo) QueueReplay(
	ctx context.Context,
	tenantID, endpointID string,
	eventID int64,
) (replayID string, matches []Match, err error) {
	return r.QueueReplayWithID(ctx, tenantID, endpointID, eventID, uuid.NewString())
}

// QueueReplayWithID is QueueReplay with a caller-stable replay receipt. The
// same replayID returns the original frozen match set (including the empty
// set), so an HTTP response loss cannot turn one operator click into two
// semantic replay attempts.
func (r *Repo) QueueReplayWithID(
	ctx context.Context,
	tenantID, endpointID string,
	eventID int64,
	replayID string,
) (string, []Match, error) {
	if r == nil || r.Pool == nil {
		return "", nil, errors.New("inbound_webhooks: action outbox repository is unavailable")
	}
	if _, parseErr := uuid.Parse(replayID); parseErr != nil {
		return "", nil, errors.New("inbound_webhooks: replay id must be a UUID")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var storedEndpointID string
	var body []byte
	var signatureValid bool
	if queryErr := tx.QueryRow(ctx, `
SELECT endpoint_id::text, body_bytes, signature_valid
  FROM inbound_events
 WHERE tenant_id = $1::uuid
   AND id = $2
 FOR SHARE`, tenantID, eventID).Scan(&storedEndpointID, &body, &signatureValid); queryErr != nil {
		if errors.Is(queryErr, pgx.ErrNoRows) {
			return "", nil, ErrNotFound
		}
		return "", nil, queryErr
	}
	if storedEndpointID != endpointID {
		return "", nil, ErrNotFound
	}
	if !signatureValid {
		return "", nil, ErrUnverifiedEvent
	}
	if len(body) == 0 {
		return "", nil, ErrPayloadNotRetained
	}

	var insertedReplayID string
	insertErr := tx.QueryRow(ctx, `
INSERT INTO inbound_webhook_replay_receipts
       (id, tenant_id, inbound_event_id, endpoint_id)
VALUES ($1::uuid, $2::uuid, $3, $4::uuid)
ON CONFLICT (id) DO NOTHING
RETURNING id::text`,
		replayID, tenantID, eventID, endpointID,
	).Scan(&insertedReplayID)
	if errors.Is(insertErr, pgx.ErrNoRows) {
		var existingEventID int64
		var existingEndpointID string
		if err := tx.QueryRow(ctx, `
SELECT inbound_event_id, endpoint_id::text
  FROM inbound_webhook_replay_receipts
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
			tenantID, replayID,
		).Scan(&existingEventID, &existingEndpointID); err != nil {
			return "", nil, err
		}
		if existingEventID != eventID || existingEndpointID != endpointID {
			return "", nil, ErrReplayConflict
		}
		matches, err := loadReplayMatchesTx(ctx, tx, tenantID, replayID)
		if err != nil {
			return "", nil, err
		}
		if err := tx.Commit(ctx); err != nil {
			return "", nil, err
		}
		return replayID, matches, nil
	}
	if insertErr != nil {
		return "", nil, insertErr
	}

	if err := lockEnabledInboundEndpoint(ctx, tx, tenantID, endpointID); err != nil {
		return "", nil, err
	}
	plans, matches, planErr := r.planTriggerActionsTx(ctx, tx, tenantID, endpointID, body)
	if planErr != nil {
		return "", nil, planErr
	}
	for _, plan := range plans {
		if insertErr := insertActionIntentTx(ctx, tx, tenantID, endpointID, eventID, &replayID, plan); insertErr != nil {
			return "", nil, insertErr
		}
		if plan.initialState == ActionIntentFailed && plan.triggerID != nil {
			if fireErr := recordFireTx(ctx, tx, tenantID, *plan.triggerID); fireErr != nil {
				return "", nil, fireErr
			}
		}
	}
	if commitErr := tx.Commit(ctx); commitErr != nil {
		return "", nil, commitErr
	}
	return replayID, matches, nil
}

func loadReplayMatchesTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, replayID string,
) ([]Match, error) {
	rows, err := tx.Query(ctx, `
SELECT trigger_id::text,
       COALESCE(trigger_name, ''),
       COALESCE(subscriber_email, ''),
       COALESCE(action_type, ''),
       COALESCE(action_target_id, ''),
       state,
       COALESCE(last_error_code, '')
  FROM inbound_webhook_action_intents
 WHERE tenant_id = $1::uuid
   AND replay_id = $2::uuid
   AND intent_kind = 'trigger_action'
 ORDER BY created_at, id`, tenantID, replayID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var matches []Match
	for rows.Next() {
		var match Match
		var state, errorCode string
		if err := rows.Scan(
			&match.TriggerID,
			&match.Name,
			&match.SubscriberEmail,
			&match.ActionType,
			&match.ActionTargetID,
			&state,
			&errorCode,
		); err != nil {
			return nil, err
		}
		match.Queued = state != ActionIntentFailed
		match.Executed = state == ActionIntentSucceeded
		match.Error = errorCode
		matches = append(matches, match)
	}
	return matches, rows.Err()
}

func (r *Repo) planTriggerActionsTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, endpointID string,
	body []byte,
) ([]plannedAction, []Match, error) {
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, nil, nil
	}
	triggers, err := listActiveTriggersTx(ctx, tx, tenantID, endpointID)
	if err != nil {
		return nil, nil, err
	}
	plans := make([]plannedAction, 0, len(triggers))
	matches := make([]Match, 0, len(triggers))
	for _, trigger := range triggers {
		plan, matched := planOneTrigger(trigger, payload)
		if !matched {
			continue
		}
		plans = append(plans, plan)
		matches = append(matches, plan.match)
	}
	return plans, matches, nil
}

func listActiveTriggersTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, endpointID string,
) ([]Trigger, error) {
	rows, err := tx.Query(ctx, `
SELECT trigger.id::text, trigger.tenant_id::text, trigger.webhook_id::text,
       trigger.name, trigger.active, trigger.match_jsonpath,
       trigger.match_operator, trigger.match_value, trigger.email_jsonpath,
       trigger.action_type, trigger.action_target_id, trigger.fired_count,
       trigger.last_fired_at, trigger.created_at, trigger.updated_at
  FROM inbound_webhook_triggers AS trigger
  JOIN inbound_webhook_endpoints AS endpoint
    ON endpoint.tenant_id = trigger.tenant_id
   AND endpoint.id = trigger.webhook_id
 WHERE trigger.tenant_id = $1::uuid
   AND trigger.webhook_id = $2::uuid
   AND trigger.active = true
   AND endpoint.enabled = true
   AND endpoint.deleted_at IS NULL
 ORDER BY trigger.created_at, trigger.id
 FOR SHARE OF trigger`, tenantID, endpointID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Trigger
	for rows.Next() {
		var trigger Trigger
		if err := rows.Scan(
			&trigger.ID,
			&trigger.TenantID,
			&trigger.WebhookID,
			&trigger.Name,
			&trigger.Active,
			&trigger.MatchJSONPath,
			&trigger.MatchOperator,
			&trigger.MatchValue,
			&trigger.EmailJSONPath,
			&trigger.ActionType,
			&trigger.ActionTargetID,
			&trigger.FiredCount,
			&trigger.LastFiredAt,
			&trigger.CreatedAt,
			&trigger.UpdatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, trigger)
	}
	return out, rows.Err()
}

func planOneTrigger(trigger Trigger, payload any) (plannedAction, bool) {
	matchedValue, found := QueryJSONPath(payload, trigger.MatchJSONPath)
	if !operatorMatches(trigger.MatchOperator, matchedValue, found, trigger.MatchValue) {
		return plannedAction{}, false
	}
	match := Match{
		TriggerID:      trigger.ID,
		Name:           trigger.Name,
		ActionType:     trigger.ActionType,
		ActionTargetID: trigger.ActionTargetID,
	}
	plan := plannedAction{
		kind:           ActionIntentTriggerAction,
		triggerID:      stringPointer(trigger.ID),
		triggerName:    stringPointer(boundUTF8(trigger.Name, maxTriggerNameBytes)),
		actionType:     stringPointer(trigger.ActionType),
		actionTargetID: stringPointer(trigger.ActionTargetID),
		initialState:   ActionIntentPending,
		match:          match,
	}
	if strings.TrimSpace(trigger.ActionTargetID) == "" || len(trigger.ActionTargetID) > maxActionTargetBytes {
		plan.actionTargetID = stringPointer(boundUTF8(trigger.ActionTargetID, maxActionTargetBytes))
		plan.initialState = ActionIntentFailed
		plan.errorCode = "trigger_target_invalid"
		plan.match.Error = "configured action target is missing or exceeds the supported size"
		return plan, true
	}
	emailValue, found := QueryJSONPath(payload, trigger.EmailJSONPath)
	if !found {
		plan.initialState = ActionIntentFailed
		plan.errorCode = "trigger_email_path_missing"
		plan.match.Error = fmt.Sprintf("email_jsonpath %q did not resolve", trigger.EmailJSONPath)
		return plan, true
	}
	email := normalizeActionEmail(stringify(emailValue))
	match.SubscriberEmail = email
	plan.match.SubscriberEmail = email
	if email == "" {
		plan.initialState = ActionIntentFailed
		plan.errorCode = "trigger_email_invalid"
		plan.match.Error = "resolved subscriber email is invalid"
		return plan, true
	}
	plan.subscriberEmail = stringPointer(email)
	plan.match.Queued = true
	return plan, true
}

func insertActionIntentTx(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, endpointID string,
	eventID int64,
	replayID *string,
	plan plannedAction,
) error {
	state := plan.initialState
	if state == "" {
		state = ActionIntentPending
	}
	var completedAt any
	if state == ActionIntentFailed {
		completedAt = time.Now().UTC()
	}
	_, err := tx.Exec(ctx, `
INSERT INTO inbound_webhook_action_intents
       (tenant_id, inbound_event_id, endpoint_id, replay_id, intent_kind,
        trigger_id, trigger_name, action_type, action_target_id,
        subscriber_email, state, last_error_code, completed_at)
VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5,
        $6::uuid, $7, $8, $9, $10, $11, NULLIF($12, ''), $13)`,
		tenantID,
		eventID,
		endpointID,
		replayID,
		plan.kind,
		plan.triggerID,
		plan.triggerName,
		plan.actionType,
		plan.actionTargetID,
		plan.subscriberEmail,
		state,
		plan.errorCode,
		completedAt,
	)
	return err
}

func recordFireTx(ctx context.Context, tx pgx.Tx, tenantID, triggerID string) error {
	_, err := tx.Exec(ctx, `
UPDATE inbound_webhook_triggers
   SET fired_count = fired_count + 1,
       last_fired_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`, tenantID, triggerID)
	return err
}

func normalizeActionEmail(email string) string {
	email = strings.ToLower(strings.TrimSpace(email))
	if len(email) < 3 || len(email) > 320 || !strings.Contains(email, "@") {
		return ""
	}
	return email
}

func stringPointer(value string) *string { return &value }

func boundUTF8(value string, maxBytes int) string {
	if len(value) <= maxBytes {
		return value
	}
	value = value[:maxBytes]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}
