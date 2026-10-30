package tags

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Action enum mirrors the values stored in tag_history.action. The
// 'tag_added' / 'tag_removed' entries match the 0028_mailchimp_compatibility
// activity_log surface so existing readers (subscribers.timeline) keep
// working when they bridge to this log.
const (
	ActionTagAdded    = "tag_added"
	ActionTagRemoved  = "tag_removed"
	ActionTagCreated  = "tag_created"
	ActionTagUpdated  = "tag_updated"
	ActionTagArchived = "tag_archived"
	ActionTagRestored = "tag_restored"
	ActionTagDeleted  = "tag_deleted"
	ActionTagRenamed  = "tag_renamed"
	ActionTagMerged   = "tag_merged"
	ActionTagRedacted = "tag_redacted"
)

// HistoryEvent is one row in tag_history. Either TagID or TagName (or
// both) should be populated; SubscriberID is optional and only set for
// per-subscriber events (add/remove). Source defaults to "manual".
type HistoryEvent struct {
	TenantID     string
	TagID        string
	TagName      string
	SubscriberID string
	Action       string
	Source       string
	ActorID      string
	Reason       string
	Metadata     map[string]any
	OccurredAt   time.Time
}

// HistoryRow is the read projection returned by the API.
type HistoryRow struct {
	ID           string         `json:"id"`
	TagID        string         `json:"tag_id,omitempty"`
	TagName      string         `json:"tag_name,omitempty"`
	SubscriberID string         `json:"subscriber_id,omitempty"`
	Action       string         `json:"action"`
	Source       string         `json:"source"`
	ActorID      string         `json:"actor_id,omitempty"`
	Reason       string         `json:"reason,omitempty"`
	Metadata     map[string]any `json:"metadata,omitempty"`
	OccurredAt   time.Time      `json:"occurred_at"`
}

// WebhookFireInput is the package-local shape passed to the injected
// dispatcher. Kept narrow so the tags package doesn't import the
// webhooks package directly (matches the subscribers / campaigns
// adapter pattern wired up in main.go).
type WebhookFireInput struct {
	TenantID  string
	EventType string
	Body      any
}

// WebhookDispatcher is the minimal slice of webhooks.Dispatcher that
// tag_history needs. Fire piggybacks on the caller's tx so a failed
// outbox append rolls back the underlying mutation, and a successful
// commit guarantees the event will eventually deliver.
type WebhookDispatcher interface {
	Fire(ctx context.Context, tx pgx.Tx, in WebhookFireInput) (int, error)
}

// FlowTriggerEvent is the package-local payload passed to the flow
// trigger fan-out. Mirrors the tag_history shape but flat for the
// flowbuilder adapter to translate into a TriggerMatch lookup +
// flow_runs insert per match.
type FlowTriggerEvent struct {
	TenantID     string
	Action       string // 'tag_added' | 'tag_removed'
	TagID        string
	TagName      string
	SubscriberID string
}

// FlowTriggerDispatcher is the surface the tags package depends on for
// fanning a tag mutation out to every active flow whose trigger matches
// tag.added/tag.removed. Implementation lives in main.go to keep tags
// free of a flowbuilder import. Fan-out is hard-capped by the adapter
// (N=10) so a tag wired into many flows can't runaway.
type FlowTriggerDispatcher interface {
	Dispatch(ctx context.Context, tx pgx.Tx, in FlowTriggerEvent) error
}

// History is the emitter + reader for tag_history. Emit is fire-and-
// forget on a tx-aware writer to avoid coupling latency to caller
// paths; on tx rollback the event is dropped (acceptable since the
// underlying mutation also rolled back).
type History struct {
	Pool         *db.Pool
	Webhooks     WebhookDispatcher
	FlowTriggers FlowTriggerDispatcher
}

// historyToWebhook maps a tag_history.action to its outbound webhook
// event type. Returns "" for actions that aren't part of the public
// catalog (e.g. tag_redacted, tag_archived) — those stay internal.
func historyToWebhook(action string) string {
	switch action {
	case ActionTagAdded:
		return "tag.added"
	case ActionTagRemoved:
		return "tag.removed"
	case ActionTagMerged:
		return "tag.merged"
	case ActionTagDeleted:
		return "tag.deleted"
	}
	return ""
}

// fireWebhook enqueues the matching outbound event on the same tx as
// the history insert so delivery is atomic with the audit row. Errors
// are swallowed: webhook delivery must never block the underlying
// mutation, and the outbox is best-effort by design at the tag layer.
func (h *History) fireWebhook(ctx context.Context, tx pgx.Tx, ev HistoryEvent) {
	if h == nil || h.Webhooks == nil {
		return
	}
	et := historyToWebhook(ev.Action)
	if et == "" {
		return
	}
	occurred := ev.OccurredAt
	if occurred.IsZero() {
		occurred = time.Now().UTC()
	}
	body := map[string]any{
		"tag_id":        ev.TagID,
		"tag_name":      ev.TagName,
		"subscriber_id": ev.SubscriberID,
		"source":        strings.TrimSpace(ev.Source),
		"occurred_at":   occurred.UTC().Format(time.RFC3339Nano),
	}
	if body["source"] == "" {
		body["source"] = "manual"
	}
	if len(ev.Metadata) > 0 {
		body["metadata"] = ev.Metadata
	}
	_, _ = h.Webhooks.Fire(ctx, tx, WebhookFireInput{
		TenantID:  ev.TenantID,
		EventType: et,
		Body:      body,
	})
}

// Emit writes one event in its own tenant-scoped tx. Best-effort: a
// failure to write the audit row is logged but does not fail the
// caller. Callers inside an existing tx should use EmitTx instead.
func (h *History) Emit(ctx context.Context, ev HistoryEvent) {
	if h == nil || h.Pool == nil || ev.TenantID == "" || ev.Action == "" {
		return
	}
	tx, err := db.WithTenant(ctx, h.Pool, ev.TenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := emitInTx(ctx, tx, ev); err != nil {
		return
	}
	// Enqueue the outbound webhook on the same tx so the row only
	// exists if the audit insert committed.
	h.fireWebhook(ctx, tx, ev)
	h.fireFlowTriggers(ctx, tx, ev)
	_ = tx.Commit(ctx)
}

// EmitTx writes one event inside a caller-owned, tenant-scoped tx.
// On tx rollback the event is dropped — which is the desired
// semantic since the underlying mutation also rolls back.
func (h *History) EmitTx(ctx context.Context, tx pgx.Tx, ev HistoryEvent) error {
	if ev.TenantID == "" || ev.Action == "" {
		return nil
	}
	if err := emitInTx(ctx, tx, ev); err != nil {
		return err
	}
	h.fireWebhook(ctx, tx, ev)
	h.fireFlowTriggers(ctx, tx, ev)
	return nil
}

// fireFlowTriggers fans the event out to every active flow whose
// trigger.kind matches tag.added/tag.removed and whose tag.name
// selector matches. Best-effort: a dispatcher error never fails the
// caller's tx — the source mutation + audit row remain authoritative,
// and flow trigger fan-out is documented as eventual.
func (h *History) fireFlowTriggers(ctx context.Context, tx pgx.Tx, ev HistoryEvent) {
	if h == nil || h.FlowTriggers == nil {
		return
	}
	if ev.Action != ActionTagAdded && ev.Action != ActionTagRemoved {
		return
	}
	if strings.TrimSpace(ev.SubscriberID) == "" {
		return
	}
	_ = h.FlowTriggers.Dispatch(ctx, tx, FlowTriggerEvent{
		TenantID:     ev.TenantID,
		Action:       ev.Action,
		TagID:        ev.TagID,
		TagName:      ev.TagName,
		SubscriberID: ev.SubscriberID,
	})
}

func emitInTx(ctx context.Context, tx pgx.Tx, ev HistoryEvent) error {
	source := strings.TrimSpace(ev.Source)
	if source == "" {
		source = "manual"
	}
	meta := ev.Metadata
	if meta == nil {
		meta = map[string]any{}
	}
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	// Resolve a stable id at write time whenever the registry already knows
	// the supplied name. Legacy callers may still provide names only; leaving
	// the id NULL on a genuine orphan is honest, while silently skipping the
	// lookup made ordinary events invisible to per-tag history.
	if strings.TrimSpace(ev.TagID) == "" && strings.TrimSpace(ev.TagName) != "" {
		resolveErr := tx.QueryRow(ctx, `
SELECT id::text FROM tags
 WHERE tenant_id = $1::uuid AND name = $2::citext`,
			ev.TenantID, strings.TrimSpace(ev.TagName)).Scan(&ev.TagID)
		if resolveErr != nil && !errors.Is(resolveErr, pgx.ErrNoRows) {
			return resolveErr
		}
	}
	_, err = tx.Exec(ctx, `
INSERT INTO tag_history (tenant_id, tag_id, tag_name, subscriber_id, action,
                         source, actor_id, reason, metadata, occurred_at)
VALUES ($1::uuid,
        NULLIF($2, '')::uuid,
        NULLIF($3, ''),
        NULLIF($4, '')::uuid,
        $5,
        $6,
        NULLIF($7, '')::uuid,
        NULLIF($8, ''),
        $9::jsonb,
        COALESCE($10, now()))`,
		ev.TenantID, ev.TagID, ev.TagName, ev.SubscriberID,
		ev.Action, source, ev.ActorID, ev.Reason, string(metaJSON),
		nullableTime(ev.OccurredAt),
	)
	return err
}

// EmitSunsetTagApplied writes one tag_added row driven by the sunset
// engine's ActionTag path. Satisfies sunset.TagHistoryEmitter.
func (h *History) EmitSunsetTagApplied(ctx context.Context, tenantID, policyID, subscriberID, tagName string) {
	h.Emit(ctx, HistoryEvent{
		TenantID:     tenantID,
		TagName:      tagName,
		SubscriberID: subscriberID,
		Action:       ActionTagAdded,
		Source:       "sunset",
		Reason:       "policy=" + policyID,
		Metadata:     map[string]any{"policy_id": policyID},
	})
}

// EmitSubscriberTagDelta writes one tag_history row per added/removed
// tag inside a caller-owned tx. Satisfies the
// subscribers.TagHistoryEmitter interface so the dual-write path can
// stay decoupled from this package's import.
func (h *History) EmitSubscriberTagDelta(ctx context.Context, tx pgx.Tx, tenantID, subscriberID string, added, removed []string, actorID, source string) error {
	if h == nil || tenantID == "" {
		return nil
	}
	src := strings.TrimSpace(source)
	if src == "" {
		src = "subscriber_update"
	}
	for _, name := range added {
		if strings.TrimSpace(name) == "" {
			continue
		}
		if err := h.EmitTx(ctx, tx, HistoryEvent{
			TenantID:     tenantID,
			TagName:      name,
			SubscriberID: subscriberID,
			Action:       ActionTagAdded,
			Source:       src,
			ActorID:      actorID,
		}); err != nil {
			return err
		}
	}
	for _, name := range removed {
		if strings.TrimSpace(name) == "" {
			continue
		}
		if err := h.EmitTx(ctx, tx, HistoryEvent{
			TenantID:     tenantID,
			TagName:      name,
			SubscriberID: subscriberID,
			Action:       ActionTagRemoved,
			Source:       src,
			ActorID:      actorID,
		}); err != nil {
			return err
		}
	}
	return nil
}

// EmitErasureRedaction writes one 'tag_redacted' row per (subscriber,
// tag) join row that still exists for the subject's plaintext email.
// Called BEFORE subscribers.tags is nulled so the join is still
// resolvable. Satisfies privacy.TagHistoryRedactor.
func (h *History) EmitErasureRedaction(ctx context.Context, tx pgx.Tx, tenantID, subjectEmail string) error {
	if h == nil || tenantID == "" || strings.TrimSpace(subjectEmail) == "" {
		return nil
	}
	meta := map[string]any{"basis": "GDPR Art.17"}
	metaJSON, _ := json.Marshal(meta)
	if _, err := tx.Exec(ctx, `
INSERT INTO tag_history (tenant_id, tag_id, tag_name, subscriber_id, action,
                         source, actor_id, reason, metadata, occurred_at)
SELECT $1::uuid, st.tag_id, t.name::text, st.subscriber_id, 'tag_redacted',
       'privacy_erasure', NULL, 'GDPR Art.17 erasure', $3::jsonb, now()
  FROM subscriber_tags st
  JOIN subscribers s ON s.tenant_id = st.tenant_id AND s.id = st.subscriber_id
  JOIN tags t        ON t.tenant_id = st.tenant_id AND t.id = st.tag_id
 WHERE st.tenant_id = $1::uuid
   AND s.tenant_id  = $1::uuid
   AND lower(s.email::text) = $2`,
		tenantID, subjectEmail, string(metaJSON)); err != nil {
		if strings.Contains(err.Error(), "subscriber_tags") && strings.Contains(err.Error(), "does not exist") {
			return nil
		}
		return err
	}
	return nil
}

// EmitRedaction writes a redaction row that nulls actor_id but keeps
// tag_id + occurred_at so the audit chain survives a GDPR erasure.
// Called from the privacy worker after the subscriber row is
// anonymized.
func (h *History) EmitRedaction(ctx context.Context, tx pgx.Tx, tenantID, subjectEmail string, subscriberIDs []string) error {
	if tenantID == "" {
		return nil
	}
	if len(subscriberIDs) == 0 {
		return nil
	}
	meta := map[string]any{"subject": "subscriber"}
	metaJSON, _ := json.Marshal(meta)
	for _, sid := range subscriberIDs {
		if strings.TrimSpace(sid) == "" {
			continue
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO tag_history (tenant_id, tag_id, tag_name, subscriber_id, action,
                         source, actor_id, reason, metadata, occurred_at)
SELECT $1::uuid, st.tag_id, t.name::text, st.subscriber_id, 'tag_redacted',
       'privacy_erasure', NULL, 'GDPR Art.17 erasure', $3::jsonb, now()
  FROM subscriber_tags st
  JOIN tags t ON t.tenant_id = st.tenant_id AND t.id = st.tag_id
 WHERE st.tenant_id = $1::uuid
   AND st.subscriber_id = $2::uuid`,
			tenantID, sid, string(metaJSON)); err != nil {
			// If the join table doesn't exist yet (pre-0244 deploy),
			// skip rather than fail the erasure.
			if strings.Contains(err.Error(), "subscriber_tags") && strings.Contains(err.Error(), "does not exist") {
				return nil
			}
			return err
		}
	}
	return nil
}

func nullableTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}

type historyPageCursor struct {
	OccurredAt time.Time `json:"occurred_at"`
	ID         string    `json:"id"`
}

const maxUUID = "ffffffff-ffff-ffff-ffff-ffffffffffff"

func encodeHistoryCursor(row HistoryRow) string {
	payload, _ := json.Marshal(historyPageCursor{
		OccurredAt: row.OccurredAt.UTC(),
		ID:         row.ID,
	})
	return base64.RawURLEncoding.EncodeToString(payload)
}

func decodeHistoryCursor(value string) (historyPageCursor, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return historyPageCursor{}, nil
	}

	// Accept the old timestamp-only cursor for a bounded compatibility
	// window. Using the maximum UUID includes the entire equal-timestamp
	// cohort (at worst repeating rows) instead of silently dropping rows.
	if occurredAt, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return historyPageCursor{OccurredAt: occurredAt.UTC(), ID: maxUUID}, nil
	}

	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return historyPageCursor{}, err
	}
	var cursor historyPageCursor
	if err := json.Unmarshal(raw, &cursor); err != nil {
		return historyPageCursor{}, err
	}
	parsedID, err := uuid.Parse(strings.TrimSpace(cursor.ID))
	if err != nil || cursor.OccurredAt.IsZero() {
		return historyPageCursor{}, errors.New("invalid history cursor")
	}
	cursor.ID = parsedID.String()
	cursor.OccurredAt = cursor.OccurredAt.UTC()
	return cursor, nil
}

// ListByTag returns the most recent history rows for one tag in stable
// (occurred_at, id) descending order. The composite cursor prevents rows
// sharing the same timestamp from being skipped between pages.
func (h *History) ListByTag(ctx context.Context, tenantID, tagID string, cursor historyPageCursor, limit int) ([]HistoryRow, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, h.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text,
       COALESCE(tag_id::text, ''),
       COALESCE(tag_name, ''),
       COALESCE(subscriber_id::text, ''),
       action,
       source,
       COALESCE(actor_id::text, ''),
       COALESCE(reason, ''),
       metadata,
       occurred_at
  FROM tag_history
 WHERE tenant_id = $1::uuid
   AND tag_id    = $2::uuid
   AND ($3::timestamptz IS NULL OR (occurred_at, id) < ($3, NULLIF($4::text, '')::uuid))
 ORDER BY occurred_at DESC, id DESC
LIMIT $5`, tenantID, tagID, nullableTime(cursor.OccurredAt), cursor.ID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []HistoryRow{}
	for rows.Next() {
		var r HistoryRow
		var metaRaw []byte
		if err := rows.Scan(&r.ID, &r.TagID, &r.TagName, &r.SubscriberID,
			&r.Action, &r.Source, &r.ActorID, &r.Reason, &metaRaw, &r.OccurredAt); err != nil {
			return nil, err
		}
		if len(metaRaw) > 0 {
			_ = json.Unmarshal(metaRaw, &r.Metadata)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// HistoryDeps wires the GET /api/v1/tags/{id}/history route.
type HistoryDeps struct {
	History *History
	// Logger, when non-nil, is used by httperror.WriteInternal to log
	// the raw error text server-side while keeping the client response
	// generic. Optional — nil-safe in tests.
	Logger *slog.Logger
}

func (d *HistoryDeps) MountRoutes(r chi.Router) {
	if d == nil || d.History == nil {
		return
	}
	r.Get("/api/v1/tags/{id}/history", d.List)
}

func (d *HistoryDeps) List(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	parsedID, err := uuid.Parse(strings.TrimSpace(chi.URLParam(r, "id")))
	if err != nil {
		httperror.Write(w, http.StatusBadRequest, "invalid_id", "id must be a UUID")
		return
	}
	id := parsedID.String()
	limit := 50
	if v := strings.TrimSpace(r.URL.Query().Get("limit")); v != "" {
		n, parseErr := parseLimit(v)
		if parseErr != nil || n > 200 {
			httperror.Write(w, http.StatusBadRequest, "invalid_limit", "limit must be from 1 to 200")
			return
		}
		limit = n
	}
	var cursor historyPageCursor
	if v := strings.TrimSpace(r.URL.Query().Get("cursor")); v != "" {
		parsedCursor, parseErr := decodeHistoryCursor(v)
		if parseErr != nil {
			httperror.Write(w, http.StatusBadRequest, "invalid_cursor", "cursor must be a value returned by this endpoint")
			return
		}
		cursor = parsedCursor
	}
	rows, err := d.History.ListByTag(r.Context(), t.ID, id, cursor, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	var nextCursor string
	if len(rows) == limit {
		nextCursor = encodeHistoryCursor(rows[len(rows)-1])
	}
	identifiersRedacted := !canViewTagHistoryIdentifiers(r)
	if identifiersRedacted {
		for index := range rows {
			rows[index].SubscriberID = ""
			rows[index].ActorID = ""
			rows[index].Metadata = nil
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"items":       rows,
		"next_cursor": nextCursor,
		"coverage": map[string]any{
			"completeness":         "partial_legacy_history",
			"coverage_started_at":  nil,
			"as_of":                time.Now().UTC(),
			"source":               "tag_history",
			"identifiers_redacted": identifiersRedacted,
			"membership_source":    "tag_membership_events",
			"known_limitations": []string{
				"pre-1774 membership events may contain only tag names",
				"bulk legacy events are aggregate rows rather than per-member transitions",
			},
		},
	})
}

func canViewTagHistoryIdentifiers(r *http.Request) bool {
	if middleware.IsAPIKeyAuth(r.Context()) {
		return apikeys.HasScope(r.Context(), apikeys.ScopeAdmin)
	}
	user, ok := middleware.UserFromContext(r.Context())
	if !ok {
		return false
	}
	role := strings.ToLower(strings.TrimSpace(user.EffectiveRoleOrDurable()))
	return role == "owner" || role == "admin"
}
