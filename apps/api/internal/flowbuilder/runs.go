package flowbuilder

// Workstream 3: source-event → flow fan-out.
//
// This file exposes a thin, tenant-scoped enqueue path for the flow_runs queue
// table (migration 0229). The product-events ingest (apps/api/internal/track)
// looks up active flows whose product_event trigger matches the incoming
// event_name and inserts one queued run per match; the automation service
// drains the queue and advances each run through the flow graph.
//
// The lookup intentionally lives here, not in a registry package, so the
// flowbuilder code that already understands the trigger schema owns
// pattern-matching. RunEnqueuer is an interface so the track handler can be
// unit-tested without spinning up Postgres.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TriggerMatch is a (flow_id, trigger_index) candidate produced by
// MatchFlowsForEvent. The trigger_index is informational — the runtime can
// re-resolve from the latest published version if it wants.
type TriggerMatch struct {
	FlowID        string
	FlowName      string
	TriggerIndex  int
	DelayStrategy string
}

// FlowRunRecord is the durable row written to flow_runs.
type FlowRunRecord struct {
	ID               string     `json:"id"`
	TenantID         string     `json:"tenant_id"`
	FlowID           string     `json:"flow_id"`
	SubscriberID     string     `json:"subscriber_id"`
	TriggerEventID   *int64     `json:"trigger_event_id,omitempty"`
	TriggerEventName string     `json:"trigger_event_name,omitempty"`
	Status           string     `json:"status"`
	ScheduledAt      time.Time  `json:"scheduled_at"`
	StartedAt        *time.Time `json:"started_at,omitempty"`
	FinishedAt       *time.Time `json:"finished_at,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
	// GraphVersionID is the automation_flow_versions row this run enrolled
	// under — the exact graph it is executing.
	//
	// Empty when unknown: runs that predate the column, and callers that could
	// not resolve a version. Deliberately not defaulted to the flow's CURRENT
	// version, which would assert that a run followed a graph it may never have
	// seen — the precise guess this field exists to remove.
	GraphVersionID string `json:"graph_version_id,omitempty"`
}

// RunEnqueueRequest is the payload for a single fan-out target.
type RunEnqueueRequest struct {
	FlowID           string
	SubscriberID     string
	TriggerEventID   *int64
	TriggerEventName string
	ScheduledAt      time.Time
	// TriggerPayload is the match context the runtime re-checks — e.g.
	// {"tag":"vip"} or {"list_id":"..."}. Engine.Trigger runs triggerMatches
	// against it, so a run enqueued without it is silently rejected as a
	// non-match. The producer knows this at enqueue time; it used to throw it
	// away, which is one of the reasons flow_runs never fired anything.
	TriggerPayload map[string]any
	// GraphVersionID binds this run to the graph version the CALLER resolved.
	// Passed in rather than re-resolved here: an edit landing between the
	// caller's read and this insert would otherwise silently bind the run to a
	// graph the trigger never evaluated.
	GraphVersionID string
}

// RunEnqueuer is the surface the track ingest depends on. The production
// implementation is Repo.EnqueueRun (Postgres); tests substitute a fake.
type RunEnqueuer interface {
	MatchFlowsForEvent(ctx context.Context, tenantID, eventName string) ([]TriggerMatch, error)
	EnqueueRun(ctx context.Context, tenantID string, req RunEnqueueRequest) (*FlowRunRecord, error)
}

// MatchFlowsForEvent returns every active flow in the tenant whose trigger
// matches event_name. The match keys on a `product_event` trigger with
// `event_name = <name>`, plus the legacy `custom_event` shape that older
// migrations emit. Empty event_name returns no rows.
func (r *Repo) MatchFlowsForEvent(ctx context.Context, tenantID, eventName string) ([]TriggerMatch, error) {
	if !flowRuntimeQualified {
		return nil, ErrFlowRuntimeUnavailable
	}
	eventName = strings.TrimSpace(eventName)
	if tenantID == "" || eventName == "" {
		return nil, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, name, triggers
  FROM automation_journeys
 WHERE tenant_id = $1::uuid
   AND status = 'active'`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TriggerMatch
	for rows.Next() {
		var id, name string
		var triggersRaw []byte
		if err := rows.Scan(&id, &name, &triggersRaw); err != nil {
			return nil, err
		}
		idx, delayStrategy, matched := matchProductEventTrigger(triggersRaw, eventName)
		if !matched {
			continue
		}
		out = append(out, TriggerMatch{FlowID: id, FlowName: name, TriggerIndex: idx, DelayStrategy: delayStrategy})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// MatchFlowsForTagEventTx returns active flows whose tag trigger matches
// a tag_history event. It runs inside the caller's transaction so tag
// mutations, tag_history, and flow_runs commit atomically.
func (r *Repo) MatchFlowsForTagEventTx(ctx context.Context, tx pgx.Tx, tenantID, action, tagName, tagID string) ([]TriggerMatch, error) {
	if !flowRuntimeQualified {
		return nil, ErrFlowRuntimeUnavailable
	}
	if r == nil || tx == nil || tenantID == "" || TagTriggerEventName(action) == "" {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, name, triggers
  FROM automation_journeys
 WHERE tenant_id = $1::uuid
   AND status = 'active'`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TriggerMatch
	for rows.Next() {
		var id, name string
		var triggersRaw []byte
		if err := rows.Scan(&id, &name, &triggersRaw); err != nil {
			return nil, err
		}
		idx, matched := matchTagEventTrigger(triggersRaw, action, tagName, tagID)
		if !matched {
			continue
		}
		out = append(out, TriggerMatch{FlowID: id, FlowName: name, TriggerIndex: idx})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// EnqueueRun inserts a queued flow_runs row.
func (r *Repo) EnqueueRun(ctx context.Context, tenantID string, req RunEnqueueRequest) (*FlowRunRecord, error) {
	if !flowRuntimeQualified {
		return nil, ErrFlowRuntimeUnavailable
	}
	if tenantID == "" {
		return nil, errors.New("flowbuilder: tenant_id required to enqueue flow run")
	}
	flowID := strings.TrimSpace(req.FlowID)
	subscriberID := strings.TrimSpace(req.SubscriberID)
	if flowID == "" || subscriberID == "" {
		return nil, fmt.Errorf("flowbuilder: flow_id and subscriber_id required (got %q, %q)", flowID, subscriberID)
	}
	scheduled := req.ScheduledAt
	if scheduled.IsZero() {
		scheduled = time.Now().UTC()
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var eventID any
	if req.TriggerEventID != nil {
		eventID = *req.TriggerEventID
	}
	// Which graph this run is entering. Resolved inside the same transaction as
	// the INSERT, so a publish landing mid-enrollment cannot stamp a version the
	// run did not actually start under.
	graphVersion, err := resolveGraphVersion(ctx, tx, tenantID, flowID, req.GraphVersionID)
	if err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
INSERT INTO flow_runs
    (tenant_id, flow_id, subscriber_id, trigger_event_id, trigger_event_name, status, scheduled_at, trigger_payload,
     graph_version_id)
VALUES
    ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'queued', $6, $7, $8::uuid)
RETURNING id::text, tenant_id::text, flow_id::text, subscriber_id::text,
          trigger_event_id, trigger_event_name, status,
          scheduled_at, started_at, finished_at, created_at,
          COALESCE(graph_version_id::text, '')`,
		tenantID, flowID, subscriberID, eventID, strings.TrimSpace(req.TriggerEventName), scheduled,
		triggerPayloadJSON(req.TriggerPayload), graphVersionArg(graphVersion))
	out, err := scanFlowRun(row)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// EnqueueRunInTx inserts a queued flow_runs row using a caller-owned tx.
// It mirrors EnqueueRun but deliberately avoids opening/committing its
// own transaction.
func (r *Repo) EnqueueRunInTx(ctx context.Context, tx pgx.Tx, tenantID string, req RunEnqueueRequest) (*FlowRunRecord, error) {
	if !flowRuntimeQualified {
		return nil, ErrFlowRuntimeUnavailable
	}
	if tenantID == "" {
		return nil, errors.New("flowbuilder: tenant_id required to enqueue flow run")
	}
	if tx == nil {
		return nil, errors.New("flowbuilder: tx required to enqueue flow run")
	}
	flowID := strings.TrimSpace(req.FlowID)
	subscriberID := strings.TrimSpace(req.SubscriberID)
	if flowID == "" || subscriberID == "" {
		return nil, fmt.Errorf("flowbuilder: flow_id and subscriber_id required (got %q, %q)", flowID, subscriberID)
	}
	scheduled := req.ScheduledAt
	if scheduled.IsZero() {
		scheduled = time.Now().UTC()
	}
	var eventID any
	if req.TriggerEventID != nil {
		eventID = *req.TriggerEventID
	}
	// Which graph this run is entering. Resolved inside the same transaction as
	// the INSERT, so a publish landing mid-enrollment cannot stamp a version the
	// run did not actually start under.
	graphVersion, err := resolveGraphVersion(ctx, tx, tenantID, flowID, req.GraphVersionID)
	if err != nil {
		return nil, err
	}
	row := tx.QueryRow(ctx, `
INSERT INTO flow_runs
    (tenant_id, flow_id, subscriber_id, trigger_event_id, trigger_event_name, status, scheduled_at, trigger_payload,
     graph_version_id)
VALUES
    ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'queued', $6, $7, $8::uuid)
RETURNING id::text, tenant_id::text, flow_id::text, subscriber_id::text,
          trigger_event_id, trigger_event_name, status,
          scheduled_at, started_at, finished_at, created_at,
          COALESCE(graph_version_id::text, '')`,
		tenantID, flowID, subscriberID, eventID, strings.TrimSpace(req.TriggerEventName), scheduled,
		triggerPayloadJSON(req.TriggerPayload), graphVersionArg(graphVersion))
	return scanFlowRun(row)
}

// ListRecentRuns is used by future ops/inspector tooling. Kept here so the
// schema is owned by a single package.
func (r *Repo) ListRecentRuns(ctx context.Context, tenantID, flowID string, limit int) ([]FlowRunRecord, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, tenant_id::text, flow_id::text, subscriber_id::text,
       trigger_event_id, trigger_event_name, status,
       scheduled_at, started_at, finished_at, created_at,
       COALESCE(graph_version_id::text, '')
  FROM flow_runs
 WHERE tenant_id = $1::uuid
   AND ($2 = '' OR flow_id::text = $2)
 ORDER BY created_at DESC
 LIMIT $3`, tenantID, strings.TrimSpace(flowID), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []FlowRunRecord{}
	for rows.Next() {
		rec, err := scanFlowRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func scanFlowRun(row scanner) (*FlowRunRecord, error) {
	var rec FlowRunRecord
	var eventID *int64
	if err := row.Scan(&rec.ID, &rec.TenantID, &rec.FlowID, &rec.SubscriberID,
		&eventID, &rec.TriggerEventName, &rec.Status,
		&rec.ScheduledAt, &rec.StartedAt, &rec.FinishedAt, &rec.CreatedAt,
		&rec.GraphVersionID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	rec.TriggerEventID = eventID
	return &rec, nil
}

// matchProductEventTrigger walks the serialized triggers array and returns
// (index, delay_strategy, true) if any product_event/custom_event trigger
// names this event. A dedicated subscriber_delivered_email trigger maps to
// the subscriber.delivered event name so it can share the product-events
// fanout queue without a parallel runtime.
func matchProductEventTrigger(triggersRaw []byte, eventName string) (int, string, bool) {
	if len(triggersRaw) == 0 {
		return 0, "", false
	}
	var triggers []map[string]any
	if err := json.Unmarshal(triggersRaw, &triggers); err != nil {
		return 0, "", false
	}
	want := strings.ToLower(strings.TrimSpace(eventName))
	for i, trig := range triggers {
		typ := strings.ToLower(strings.TrimSpace(stringField(trig, "type")))
		if typ == "subscriber_delivered_email" && want == "subscriber.delivered" {
			return i, triggerDelayStrategy(trig), true
		}
		if typ != "product_event" && typ != "custom_event" {
			continue
		}
		name := strings.ToLower(strings.TrimSpace(stringField(trig, "event_name")))
		if name == "" || name == want {
			// An empty event_name on a product_event trigger is a wildcard for
			// "any event" — preserve that behaviour so a draft flow with no
			// event_name yet still fires during dev.
			return i, triggerDelayStrategy(trig), true
		}
	}
	return 0, "", false
}

func matchTagEventTrigger(triggersRaw []byte, action, tagName, tagID string) (int, bool) {
	if len(triggersRaw) == 0 {
		return 0, false
	}
	want := normalizeTagTriggerAction(action)
	if want == "" {
		return 0, false
	}
	var triggers []map[string]any
	if err := json.Unmarshal(triggersRaw, &triggers); err != nil {
		return 0, false
	}
	tagName = strings.ToLower(strings.TrimSpace(tagName))
	tagID = strings.ToLower(strings.TrimSpace(tagID))
	for i, trig := range triggers {
		typ := normalizeTagTriggerAction(firstStringField(trig, "type", "event", "event_name", "kind"))
		if typ != want {
			continue
		}
		wantID := strings.ToLower(strings.TrimSpace(firstStringField(trig, "tag_id", "tagID")))
		if wantID != "" {
			if tagID != "" && wantID == tagID {
				return i, true
			}
			continue
		}
		wantName := strings.ToLower(strings.TrimSpace(firstStringField(trig, "tag", "tag_name", "tagName", "name")))
		if wantName == "" || wantName == tagName {
			return i, true
		}
	}
	return 0, false
}

// TagTriggerEventName returns the flow_runs trigger_event_name for a
// tag_history action.
func TagTriggerEventName(action string) string {
	switch normalizeTagTriggerAction(action) {
	case "tag_added":
		return "tag.added"
	case "tag_removed":
		return "tag.removed"
	default:
		return ""
	}
}

func normalizeTagTriggerAction(action string) string {
	action = strings.ToLower(strings.TrimSpace(action))
	action = strings.ReplaceAll(action, ".", "_")
	action = strings.ReplaceAll(action, "-", "_")
	switch action {
	case "tag_added", "tag_add", "added", "add_tag":
		return "tag_added"
	case "tag_removed", "tag_remove", "removed", "remove_tag":
		return "tag_removed"
	default:
		return ""
	}
}

func firstStringField(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if v := stringField(m, key); v != "" {
			return v
		}
	}
	return ""
}

func triggerDelayStrategy(m map[string]any) string {
	if v := strings.ToLower(strings.TrimSpace(firstStringField(m, "delay_strategy", "delayStrategy", "trigger_delay_strategy"))); v != "" {
		return v
	}
	if raw, ok := m["delay"].(map[string]any); ok {
		if v := strings.ToLower(strings.TrimSpace(firstStringField(raw, "strategy", "delay_strategy"))); v != "" {
			return v
		}
	}
	if raw, ok := m["optimized_delay"].(bool); ok && raw {
		return "optimized"
	}
	return ""
}

func stringField(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

// triggerPayloadJSON marshals the trigger match-context for storage. A nil or
// unmarshalable payload becomes an empty object rather than NULL, so the
// drainer never has to special-case it.
func triggerPayloadJSON(p map[string]any) []byte {
	if len(p) == 0 {
		return []byte(`{}`)
	}
	b, err := json.Marshal(p)
	if err != nil {
		return []byte(`{}`)
	}
	return b
}

// graphVersionArg turns a caller-supplied version id into a bind value.
//
// An empty or blank id becomes SQL NULL rather than a zero uuid or the flow's
// current version. "Unknown" and "version 1" are different facts, and a column
// that quietly substitutes one for the other is worse than not having it: it
// answers "which graph did this run follow" with a confident wrong answer.

// publishedGraphVersionTx returns the id of the flow's currently PUBLISHED
// version, or "" when it has none.
//
// Resolved at ENROLLMENT, which is the only moment the answer is knowable. A
// flow is a program and `automation_flow_versions` stores each published
// revision of it; without stamping which one a run entered under, an operator
// editing a live flow leaves every in-flight run ambiguous — did it finish the
// graph it started, or switch at its next step? The rows cannot say, and the
// two answers produce different emails for the same person.
//
// EMPTY, NOT AN ERROR, when nothing is published. Migration 1875 made the
// column nullable precisely so "unknown" stays honest; inventing a version here
// — the newest draft, say — would assert exactly the thing the column exists to
// stop guessing at. A flow with no published version is also a flow that should
// not be enrolling, and failing the enrollment on that basis is a different
// decision from this one.
func publishedGraphVersionTx(ctx context.Context, tx pgx.Tx, tenantID, flowID string) (string, error) {
	var id string
	err := tx.QueryRow(ctx, `
SELECT id::text
  FROM automation_flow_versions
 WHERE tenant_id = $1::uuid AND journey_id = $2::uuid AND status = 'published'
 ORDER BY version DESC
 LIMIT 1`, tenantID, strings.TrimSpace(flowID)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return id, nil
}

// resolveGraphVersion prefers what the caller supplied, falling back to the
// flow's published version.
//
// The caller's value wins because a replay or a backfill knows which graph it
// is reconstructing, and overwriting that with "whatever is published now"
// would silently relabel history.
func resolveGraphVersion(
	ctx context.Context, tx pgx.Tx, tenantID, flowID, supplied string,
) (string, error) {
	if strings.TrimSpace(supplied) != "" {
		return strings.TrimSpace(supplied), nil
	}
	return publishedGraphVersionTx(ctx, tx, tenantID, flowID)
}

func graphVersionArg(id string) any {
	if strings.TrimSpace(id) == "" {
		return nil
	}
	return strings.TrimSpace(id)
}
