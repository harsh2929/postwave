package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

var (
	ErrLifecycleInboxUnavailable = errors.New("runtime: durable lifecycle inbox unavailable")
	ErrInvalidLifecycleEvent     = errors.New("runtime: invalid lifecycle event")
	ErrLifecycleEventOutOfOrder  = errors.New("runtime: lifecycle event arrived before an earlier transition")
	ErrLifecycleEventConflict    = errors.New("runtime: lifecycle source event replay conflict")
	ErrLifecycleDispatchFailed   = errors.New("runtime: lifecycle automation dispatch failed")
	ErrLifecycleSubscriberAbsent = errors.New("runtime: lifecycle subscriber is not tenant-visible")
)

// LifecycleEventInbox is the required durable receiver for lifecycle-stage
// events. It deliberately sits behind an interface so HTTP contract tests can
// assert fail-closed behavior without a database.
type LifecycleEventInbox interface {
	Dispatch(ctx context.Context, ev EngagementEvent) error
}

// PgxLifecycleEventInbox persists PII-minimised receipts and per-automation
// outcomes in the tables installed by migration 1770. It serializes processing
// for one tenant/subscriber with a session advisory lock, while the monotonic
// cursor makes out-of-order events retry instead of overtaking their predecessor.
type PgxLifecycleEventInbox struct {
	Pool   *pgxpool.Pool
	Lister AutomationLister
	Engine *Engine
}

// NewPgxLifecycleEventInbox refuses an incomplete durability boundary. A
// lifecycle endpoint wired without any one of these dependencies must return
// 503 rather than acknowledging an event it cannot durably dispatch.
func NewPgxLifecycleEventInbox(
	pool *pgxpool.Pool,
	lister AutomationLister,
	engine *Engine,
) (*PgxLifecycleEventInbox, error) {
	if pool == nil || lister == nil || engine == nil || engine.Resolver == nil ||
		engine.Store == nil || engine.Queue == nil {
		return nil, ErrLifecycleInboxUnavailable
	}
	return &PgxLifecycleEventInbox{Pool: pool, Lister: lister, Engine: engine}, nil
}

type lifecycleReceipt struct {
	TenantID           string
	SourceEventID      string
	SubscriberID       string
	TransitionSequence int64
	PreviousStage      string
	NextStage          string
	Score              int
	TransitionedAt     time.Time
	Fingerprint        string
}

func receiptFromEngagementEvent(ev EngagementEvent) (lifecycleReceipt, error) {
	toStage, toStageOK := consistentLifecyclePayloadString(ev.Payload, "to_stage", "stage")
	fromStage, fromStageOK := consistentLifecyclePayloadString(ev.Payload, "from_stage", "previous_stage")
	score, scoreOK := payloadExactInt(ev.Payload, "score")
	r := lifecycleReceipt{
		TenantID:           strings.TrimSpace(ev.TenantID),
		SourceEventID:      strings.TrimSpace(ev.SourceEventID),
		SubscriberID:       strings.TrimSpace(ev.SubscriberID),
		TransitionSequence: ev.TransitionSequence,
		PreviousStage:      fromStage,
		NextStage:          toStage,
		Score:              score,
		TransitionedAt:     ev.At.UTC(),
	}
	tenantUUID, err := uuid.Parse(r.TenantID)
	if err != nil {
		return lifecycleReceipt{}, fmt.Errorf("%w: tenant_id must be a UUID", ErrInvalidLifecycleEvent)
	}
	subscriberUUID, err := uuid.Parse(r.SubscriberID)
	if err != nil {
		return lifecycleReceipt{}, fmt.Errorf("%w: subscriber_id must be a UUID", ErrInvalidLifecycleEvent)
	}
	// Normalize equivalent UUID spellings before hashing and tenant scoping so
	// semantically identical retries cannot conflict merely on text format.
	r.TenantID = tenantUUID.String()
	r.SubscriberID = subscriberUUID.String()
	if len(r.SourceEventID) == 0 || len(r.SourceEventID) > 200 ||
		strings.IndexFunc(r.SourceEventID, func(ch rune) bool { return ch < 0x21 || ch > 0x7e }) >= 0 {
		return lifecycleReceipt{}, fmt.Errorf("%w: source_event_id must be 1-200 printable ASCII characters", ErrInvalidLifecycleEvent)
	}
	if r.TransitionSequence <= 0 {
		return lifecycleReceipt{}, fmt.Errorf("%w: transition_sequence must be positive", ErrInvalidLifecycleEvent)
	}
	if !toStageOK || !fromStageOK || !canonical.ValidLifecycleStage(r.NextStage) ||
		(r.PreviousStage != "" && !canonical.ValidLifecycleStage(r.PreviousStage)) ||
		r.PreviousStage == r.NextStage {
		return lifecycleReceipt{}, fmt.Errorf("%w: lifecycle transition stages are invalid", ErrInvalidLifecycleEvent)
	}
	if eventName, present := ev.Payload["event_name"]; present {
		name, ok := eventName.(string)
		if !ok || name != canonical.TriggerLifecycleStageChanged {
			return lifecycleReceipt{}, fmt.Errorf("%w: payload event_name conflicts with event_type", ErrInvalidLifecycleEvent)
		}
	}
	if _, present := ev.Payload["transition_sequence"]; present {
		payloadSequence, ok := payloadExactPositiveInt64(ev.Payload, "transition_sequence")
		if !ok || payloadSequence != r.TransitionSequence {
			return lifecycleReceipt{}, fmt.Errorf("%w: payload transition_sequence conflicts with the envelope", ErrInvalidLifecycleEvent)
		}
	}
	if !scoreOK || r.Score < 1 || r.Score > 5 {
		return lifecycleReceipt{}, fmt.Errorf("%w: lifecycle score must be an integer from 1 through 5", ErrInvalidLifecycleEvent)
	}
	if r.TransitionedAt.IsZero() {
		return lifecycleReceipt{}, fmt.Errorf("%w: at must be a non-zero timestamp", ErrInvalidLifecycleEvent)
	}
	r.Fingerprint = lifecycleSemanticFingerprint(r)
	return r, nil
}

func consistentLifecyclePayloadString(payload map[string]interface{}, primary, alias string) (string, bool) {
	primaryValue, primaryPresent := payload[primary]
	aliasValue, aliasPresent := payload[alias]
	if !primaryPresent && !aliasPresent {
		return "", true
	}
	var primaryString, aliasString string
	var ok bool
	if primaryPresent {
		primaryString, ok = primaryValue.(string)
		if !ok {
			return "", false
		}
	}
	if aliasPresent {
		aliasString, ok = aliasValue.(string)
		if !ok {
			return "", false
		}
	}
	if primaryPresent && aliasPresent && primaryString != aliasString {
		return "", false
	}
	if primaryPresent {
		return primaryString, true
	}
	return aliasString, true
}

func payloadExactInt(payload map[string]interface{}, key string) (int, bool) {
	value, ok := payload[key]
	if !ok {
		return 0, false
	}
	n, ok := value.(float64)
	if !ok || math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) || n < 1 || n > 5 {
		return 0, false
	}
	return int(n), true
}

func payloadExactPositiveInt64(payload map[string]interface{}, key string) (int64, bool) {
	value, ok := payload[key]
	if !ok {
		return 0, false
	}
	n, ok := value.(float64)
	// JSON numbers above 2^53-1 cannot be represented exactly in an
	// interface{} float64. Reject them instead of comparing rounded values.
	if !ok || math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) ||
		n < 1 || n > 9_007_199_254_740_991 {
		return 0, false
	}
	return int64(n), true
}

func lifecycleSemanticFingerprint(r lifecycleReceipt) string {
	// Length-prefixing avoids separator ambiguity without persisting the input.
	parts := []string{
		r.TenantID,
		r.SourceEventID,
		r.SubscriberID,
		fmt.Sprintf("%d", r.TransitionSequence),
		canonical.TriggerLifecycleStageChanged,
		r.PreviousStage,
		r.NextStage,
		fmt.Sprintf("%d", r.Score),
		r.TransitionedAt.Format(time.RFC3339Nano),
	}
	h := sha256.New()
	for _, part := range parts {
		_, _ = fmt.Fprintf(h, "%d:", len(part))
		_, _ = h.Write([]byte(part))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// Dispatch receives, freezes, and dispatches one lifecycle event. Receipt and
// successful per-automation outcomes commit independently, so a partial failure
// retries only the remaining targets. The stable Engine.TriggerDurable key makes
// the queue side idempotent even if the service dies after enqueue but before an
// outcome commit.
func (i *PgxLifecycleEventInbox) Dispatch(ctx context.Context, ev EngagementEvent) error {
	if i == nil || i.Pool == nil || i.Lister == nil || i.Engine == nil {
		return ErrLifecycleInboxUnavailable
	}
	receipt, err := receiptFromEngagementEvent(ev)
	if err != nil {
		return err
	}
	conn, err := i.Pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("%w: acquire database connection", ErrLifecycleInboxUnavailable)
	}
	lockA, lockB := lifecycleAdvisoryKeys(receipt.TenantID, receipt.SubscriberID)
	locked := false
	defer func() {
		if locked {
			unlockCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			var unlocked bool
			unlockErr := conn.QueryRow(unlockCtx,
				`SELECT pg_advisory_unlock($1, $2)`, lockA, lockB).Scan(&unlocked)
			if unlockErr != nil || !unlocked {
				// Never recycle a session that may still own the ordering mutex.
				// A leaked session lock would make every later transition for this
				// subscriber wait behind an idle pooled connection indefinitely.
				raw := conn.Hijack()
				closeCtx, closeCancel := context.WithTimeout(context.Background(), 2*time.Second)
				defer closeCancel()
				_ = raw.Close(closeCtx)
				return
			}
		}
		conn.Release()
	}()

	if err := i.persistReceipt(ctx, conn, receipt); err != nil {
		return err
	}
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1, $2)`, lockA, lockB); err != nil {
		return fmt.Errorf("%w: acquire subscriber ordering lock", ErrLifecycleInboxUnavailable)
	}
	locked = true

	state, frozen, lastAccepted, err := i.loadState(ctx, conn, receipt)
	if err != nil {
		return err
	}
	if state == "accepted" || state == "subscriber_erased" {
		return nil
	}
	if receipt.TransitionSequence != lastAccepted+1 {
		return fmt.Errorf("%w: got %d after %d", ErrLifecycleEventOutOfOrder,
			receipt.TransitionSequence, lastAccepted)
	}

	if !frozen {
		if err := i.freezeTargets(ctx, conn, receipt, ev); err != nil {
			return err
		}
	}
	targets, err := i.pendingTargets(ctx, conn, receipt)
	if err != nil {
		return err
	}
	// Resolve mutable contact data only after the durable target set is frozen
	// and immediately before dispatch. The inbox never retains this value, and
	// a retry therefore uses the subscriber's current address.
	email, err := i.resolveCurrentEmail(ctx, conn, receipt)
	if errors.Is(err, ErrLifecycleSubscriberAbsent) {
		return i.acceptErased(ctx, conn, receipt)
	}
	if err != nil {
		return err
	}
	payload := lifecycleEnginePayload(receipt)
	for _, automationID := range targets {
		disposition, triggerErr := i.Engine.TriggerDurable(
			WithTenant(ctx, receipt.TenantID),
			automationID,
			canonical.TriggerLifecycleStageChanged,
			email,
			payload,
			receipt.TenantID+"\x00"+receipt.SourceEventID,
		)
		if triggerErr != nil {
			if markErr := i.markDispatchFailure(ctx, conn, receipt, automationID); markErr != nil {
				return errors.Join(fmt.Errorf("%w: automation %s", ErrLifecycleDispatchFailed, automationID), markErr)
			}
			return fmt.Errorf("%w: automation %s", ErrLifecycleDispatchFailed, automationID)
		}
		if err := i.markDispatchAccepted(ctx, conn, receipt, automationID, string(disposition)); err != nil {
			return err
		}
	}
	return i.finalizeReceipt(ctx, conn, receipt)
}

func lifecycleEnginePayload(r lifecycleReceipt) map[string]interface{} {
	return map[string]interface{}{
		"event_name":          canonical.TriggerLifecycleStageChanged,
		"from_stage":          r.PreviousStage,
		"previous_stage":      r.PreviousStage,
		"to_stage":            r.NextStage,
		"stage":               r.NextStage,
		"score":               r.Score,
		"at":                  r.TransitionedAt,
		"subscriber_id":       r.SubscriberID,
		"source_event_id":     r.SourceEventID,
		"transition_sequence": r.TransitionSequence,
	}
}

func lifecycleAdvisoryKeys(tenantID, subscriberID string) (int32, int32) {
	tenantSum := sha256.Sum256([]byte("tenant\x00" + tenantID))
	subscriberSum := sha256.Sum256([]byte("subscriber\x00" + tenantID + "\x00" + subscriberID))
	// #nosec G115 -- PostgreSQL advisory locks accept signed int32 keys; this is
	// an intentional bit-preserving reinterpretation of the hash prefix.
	return int32(binary.BigEndian.Uint32(tenantSum[:4])), int32(binary.BigEndian.Uint32(subscriberSum[:4]))
}

func (i *PgxLifecycleEventInbox) persistReceipt(
	ctx context.Context,
	conn *pgxpool.Conn,
	r lifecycleReceipt,
) error {
	tx, err := beginLifecycleInboxTx(ctx, conn, r.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var existingFingerprint, existingSubscriberKey string
	var existingSequence int64
	existingErr := tx.QueryRow(ctx, `
SELECT semantic_fingerprint, subscriber_key::text, transition_sequence
  FROM public.automation_lifecycle_event_inbox
 WHERE tenant_id = $1::uuid AND source_event_id = $2`,
		r.TenantID, r.SourceEventID).
		Scan(&existingFingerprint, &existingSubscriberKey, &existingSequence)
	if existingErr == nil {
		if existingFingerprint != r.Fingerprint || existingSubscriberKey != r.SubscriberID ||
			existingSequence != r.TransitionSequence {
			return ErrLifecycleEventConflict
		}
		return tx.Commit(ctx)
	}
	if !errors.Is(existingErr, pgx.ErrNoRows) {
		return fmt.Errorf("find lifecycle inbox receipt: %w", existingErr)
	}

	var subscriberExists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM public.subscribers
     WHERE tenant_id = $1::uuid AND id = $2::uuid
)`, r.TenantID, r.SubscriberID).Scan(&subscriberExists); err != nil {
		return fmt.Errorf("validate lifecycle subscriber: %w", err)
	}
	if !subscriberExists {
		return ErrLifecycleSubscriberAbsent
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO public.automation_lifecycle_subscriber_cursors
    (tenant_id, subscriber_id)
VALUES ($1::uuid, $2::uuid)
ON CONFLICT (tenant_id, subscriber_id) DO NOTHING`, r.TenantID, r.SubscriberID); err != nil {
		return fmt.Errorf("create lifecycle cursor: %w", err)
	}
	_, err = tx.Exec(ctx, `
INSERT INTO public.automation_lifecycle_event_inbox
    (tenant_id, source_event_id, subscriber_key, subscriber_id, transition_sequence,
     event_type, previous_stage, next_stage, score, transitioned_at,
     semantic_fingerprint)
VALUES ($1::uuid, $2, $3::uuid, $3::uuid, $4,
        $5, $6, $7, $8::smallint, $9, $10)
ON CONFLICT (tenant_id, source_event_id) DO NOTHING`,
		r.TenantID, r.SourceEventID, r.SubscriberID, r.TransitionSequence,
		canonical.TriggerLifecycleStageChanged, r.PreviousStage, r.NextStage,
		r.Score, r.TransitionedAt, r.Fingerprint)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return ErrLifecycleEventConflict
		}
		return fmt.Errorf("insert lifecycle inbox receipt: %w", err)
	}
	var fingerprint, subscriberKey string
	var sequence int64
	if err := tx.QueryRow(ctx, `
SELECT semantic_fingerprint, subscriber_key::text, transition_sequence
  FROM public.automation_lifecycle_event_inbox
 WHERE tenant_id = $1::uuid AND source_event_id = $2`,
		r.TenantID, r.SourceEventID).Scan(&fingerprint, &subscriberKey, &sequence); err != nil {
		return fmt.Errorf("verify lifecycle inbox receipt: %w", err)
	}
	if fingerprint != r.Fingerprint || subscriberKey != r.SubscriberID || sequence != r.TransitionSequence {
		return ErrLifecycleEventConflict
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit lifecycle inbox receipt: %w", err)
	}
	return nil
}

func (i *PgxLifecycleEventInbox) loadState(
	ctx context.Context,
	conn *pgxpool.Conn,
	r lifecycleReceipt,
) (state string, frozen bool, lastAccepted int64, err error) {
	tx, err := beginLifecycleInboxTx(ctx, conn, r.TenantID)
	if err != nil {
		return "", false, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `
SELECT i.state, i.target_set_frozen, COALESCE(c.last_accepted_sequence, 0)
  FROM public.automation_lifecycle_event_inbox AS i
  LEFT JOIN public.automation_lifecycle_subscriber_cursors AS c
    ON c.tenant_id = i.tenant_id AND c.subscriber_id = i.subscriber_key
 WHERE i.tenant_id = $1::uuid AND i.source_event_id = $2
   AND i.subscriber_key = $3::uuid AND i.transition_sequence = $4`,
		r.TenantID, r.SourceEventID, r.SubscriberID, r.TransitionSequence).
		Scan(&state, &frozen, &lastAccepted); err != nil {
		return "", false, 0, fmt.Errorf("load lifecycle inbox state: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", false, 0, err
	}
	return state, frozen, lastAccepted, nil
}

func (i *PgxLifecycleEventInbox) resolveCurrentEmail(
	ctx context.Context,
	conn *pgxpool.Conn,
	r lifecycleReceipt,
) (string, error) {
	tx, err := beginLifecycleInboxTx(ctx, conn, r.TenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var email string
	err = tx.QueryRow(ctx, `
SELECT email::text
  FROM public.subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND archived_at IS NULL`, r.TenantID, r.SubscriberID).Scan(&email)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrLifecycleSubscriberAbsent
	}
	if err != nil {
		return "", fmt.Errorf("resolve current lifecycle subscriber address: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return email, nil
}

func (i *PgxLifecycleEventInbox) freezeTargets(
	ctx context.Context,
	conn *pgxpool.Conn,
	r lifecycleReceipt,
	ev EngagementEvent,
) error {
	automations, err := i.Lister.ListActiveByTenant(WithTenant(ctx, r.TenantID), r.TenantID)
	if err != nil {
		return fmt.Errorf("%w: list active automations", ErrLifecycleDispatchFailed)
	}
	targetSet := make(map[string]struct{})
	for _, automation := range automations {
		if automation == nil || automation.TenantID != r.TenantID {
			return fmt.Errorf("%w: automation lister crossed tenant boundary", ErrLifecycleDispatchFailed)
		}
		for _, trigger := range automation.Triggers {
			if trigger.Type != canonical.TriggerLifecycleStageChanged {
				continue
			}
			if !canonical.ValidLifecycleTrigger(trigger) {
				return fmt.Errorf("%w: automation %s has a non-canonical lifecycle stage", ErrLifecycleDispatchFailed, automation.ID)
			}
			if matchPlatformTrigger(trigger, ev) {
				targetSet[automation.ID] = struct{}{}
				break
			}
		}
	}
	targets := make([]string, 0, len(targetSet))
	for id := range targetSet {
		if _, err := uuid.Parse(id); err != nil {
			return fmt.Errorf("%w: automation identity is not a UUID", ErrLifecycleDispatchFailed)
		}
		targets = append(targets, id)
	}
	sort.Strings(targets)

	tx, err := beginLifecycleInboxTx(ctx, conn, r.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for _, automationID := range targets {
		if _, err := tx.Exec(ctx, `
INSERT INTO public.automation_lifecycle_event_dispatches
    (tenant_id, source_event_id, automation_id, trigger_type)
VALUES ($1::uuid, $2, $3::uuid, $4)
ON CONFLICT (tenant_id, source_event_id, automation_id) DO NOTHING`,
			r.TenantID, r.SourceEventID, automationID,
			canonical.TriggerLifecycleStageChanged); err != nil {
			return fmt.Errorf("freeze lifecycle dispatch target: %w", err)
		}
	}
	command, err := tx.Exec(ctx, `
UPDATE public.automation_lifecycle_event_inbox
   SET target_set_frozen = true,
       intended_count = $3,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND source_event_id = $2
   AND state = 'received' AND NOT target_set_frozen`,
		r.TenantID, r.SourceEventID, len(targets))
	if err != nil {
		return fmt.Errorf("freeze lifecycle dispatch set: %w", err)
	}
	if command.RowsAffected() != 1 {
		return fmt.Errorf("%w: lifecycle target set changed concurrently", ErrLifecycleEventConflict)
	}
	return tx.Commit(ctx)
}

func (i *PgxLifecycleEventInbox) pendingTargets(
	ctx context.Context,
	conn *pgxpool.Conn,
	r lifecycleReceipt,
) ([]string, error) {
	tx, err := beginLifecycleInboxTx(ctx, conn, r.TenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT automation_id::text
  FROM public.automation_lifecycle_event_dispatches
 WHERE tenant_id = $1::uuid AND source_event_id = $2 AND state = 'pending'
 ORDER BY automation_id`, r.TenantID, r.SourceEventID)
	if err != nil {
		return nil, fmt.Errorf("list pending lifecycle dispatches: %w", err)
	}
	defer rows.Close()
	var targets []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		targets = append(targets, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return targets, nil
}

func (i *PgxLifecycleEventInbox) markDispatchFailure(
	ctx context.Context,
	conn *pgxpool.Conn,
	r lifecycleReceipt,
	automationID string,
) error {
	tx, err := beginLifecycleInboxTx(ctx, conn, r.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
UPDATE public.automation_lifecycle_event_dispatches
   SET attempt_count = attempt_count + 1,
       last_error_code = 'engine_trigger_failed',
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND source_event_id = $2
   AND automation_id = $3::uuid AND state = 'pending'`,
		r.TenantID, r.SourceEventID, automationID)
	if err != nil {
		return fmt.Errorf("record lifecycle dispatch failure: %w", err)
	}
	return tx.Commit(ctx)
}

func (i *PgxLifecycleEventInbox) markDispatchAccepted(
	ctx context.Context,
	conn *pgxpool.Conn,
	r lifecycleReceipt,
	automationID, result string,
) error {
	if result != string(TriggerDispositionQueued) && result != string(TriggerDispositionPolicySkipped) {
		return fmt.Errorf("invalid lifecycle dispatch result %q", result)
	}
	tx, err := beginLifecycleInboxTx(ctx, conn, r.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	command, err := tx.Exec(ctx, `
UPDATE public.automation_lifecycle_event_dispatches
   SET state = 'accepted', result = $4,
       attempt_count = attempt_count + 1,
       last_error_code = NULL,
       accepted_at = clock_timestamp(), updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND source_event_id = $2
   AND automation_id = $3::uuid AND state = 'pending'`,
		r.TenantID, r.SourceEventID, automationID, result)
	if err != nil {
		return fmt.Errorf("accept lifecycle dispatch: %w", err)
	}
	if command.RowsAffected() != 1 {
		return fmt.Errorf("%w: lifecycle dispatch outcome changed concurrently", ErrLifecycleEventConflict)
	}
	return tx.Commit(ctx)
}

func (i *PgxLifecycleEventInbox) finalizeReceipt(
	ctx context.Context,
	conn *pgxpool.Conn,
	r lifecycleReceipt,
) error {
	tx, err := beginLifecycleInboxTx(ctx, conn, r.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var intended, total, accepted int
	if err := tx.QueryRow(ctx, `
SELECT i.intended_count,
       count(d.automation_id)::int,
       count(d.automation_id) FILTER (WHERE d.state = 'accepted')::int
  FROM public.automation_lifecycle_event_inbox AS i
  LEFT JOIN public.automation_lifecycle_event_dispatches AS d
    ON d.tenant_id = i.tenant_id AND d.source_event_id = i.source_event_id
 WHERE i.tenant_id = $1::uuid AND i.source_event_id = $2
   AND i.target_set_frozen
 GROUP BY i.intended_count`, r.TenantID, r.SourceEventID).Scan(&intended, &total, &accepted); err != nil {
		return fmt.Errorf("verify lifecycle dispatch completion: %w", err)
	}
	if intended != total || intended != accepted {
		return fmt.Errorf("%w: accepted %d of %d intended targets (%d durable outcomes)",
			ErrLifecycleDispatchFailed, accepted, intended, total)
	}
	cursor, err := tx.Exec(ctx, `
UPDATE public.automation_lifecycle_subscriber_cursors
   SET last_accepted_sequence = $3,
       last_source_event_id = $2,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND subscriber_id = $4::uuid
   AND last_accepted_sequence = $3 - 1`,
		r.TenantID, r.SourceEventID, r.TransitionSequence, r.SubscriberID)
	if err != nil {
		return fmt.Errorf("advance lifecycle cursor: %w", err)
	}
	if cursor.RowsAffected() != 1 {
		return ErrLifecycleEventOutOfOrder
	}
	if _, err := tx.Exec(ctx, `
UPDATE public.automation_lifecycle_event_inbox
   SET state = 'accepted', accepted_at = clock_timestamp(),
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND source_event_id = $2 AND state = 'received'`,
		r.TenantID, r.SourceEventID); err != nil {
		return fmt.Errorf("accept lifecycle inbox receipt: %w", err)
	}
	return tx.Commit(ctx)
}

func (i *PgxLifecycleEventInbox) acceptErased(
	ctx context.Context,
	conn *pgxpool.Conn,
	r lifecycleReceipt,
) error {
	tx, err := beginLifecycleInboxTx(ctx, conn, r.TenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE public.automation_lifecycle_event_dispatches
   SET state = 'accepted', result = 'subscriber_erased',
       attempt_count = attempt_count + 1,
       last_error_code = NULL,
       accepted_at = clock_timestamp(), updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND source_event_id = $2 AND state = 'pending'`,
		r.TenantID, r.SourceEventID); err != nil {
		return err
	}
	var targetCount int
	if err := tx.QueryRow(ctx, `
SELECT count(*)::int
  FROM public.automation_lifecycle_event_dispatches
 WHERE tenant_id = $1::uuid AND source_event_id = $2`,
		r.TenantID, r.SourceEventID).Scan(&targetCount); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
UPDATE public.automation_lifecycle_event_inbox
   SET target_set_frozen = true, intended_count = $3,
       state = 'subscriber_erased', accepted_at = clock_timestamp(),
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND source_event_id = $2 AND state = 'received'`,
		r.TenantID, r.SourceEventID, targetCount); err != nil {
		return err
	}
	cursor, err := tx.Exec(ctx, `
UPDATE public.automation_lifecycle_subscriber_cursors
   SET last_accepted_sequence = $3, last_source_event_id = $2,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND subscriber_id = $4::uuid
   AND last_accepted_sequence = $3 - 1`,
		r.TenantID, r.SourceEventID, r.TransitionSequence, r.SubscriberID)
	if err != nil {
		return err
	}
	if cursor.RowsAffected() != 1 {
		return ErrLifecycleEventOutOfOrder
	}
	return tx.Commit(ctx)
}

func beginLifecycleInboxTx(
	ctx context.Context,
	conn *pgxpool.Conn,
	tenantID string,
) (pgx.Tx, error) {
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}
