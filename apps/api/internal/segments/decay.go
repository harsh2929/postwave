// SPDX-License-Identifier: AGPL-3.0-only
//
// decay.go — Segment Decay Radar (feature #5) core: wire types, pure
// anomaly-detection + clause-attribution functions, the DecayStore
// persistence interface (with the production pgx implementation), and
// the HTTP read/dismiss/narrate handlers.
//
// Anomaly detection and attribution are PURE functions (detectAnomalyKind,
// attributionFromClauseAttrs) so they are table-tested with no DB. All
// persistence is behind DecayStore so the worker + handlers are unit-
// tested against a fake (see decay_test.go). The real pgx implementation
// is DecayRepo, which opens its own tenant-scoped tx so RLS fires —
// mirroring repo.go.
//
// Decay numbers #5: this file deliberately uses the decay_ file prefix
// and only adds NEW symbols so it does not collide with feature #4
// (segment P&L) on the shared branch.

package segments

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Anomaly-kind constants. These exact strings are stored in
// segment_decay_events.anomaly_kind (CHECK-constrained in migration
// 0412) and emitted in the audit_log payload.
const (
	AnomalySizeCliff        = "size_cliff"
	AnomalyZeroMatch        = "zero_match"
	AnomalyEveryoneMatch    = "everyone_match"
	AnomalyDefinitionChange = "definition_changed"
)

// AnomalyNone is the sentinel returned by detectAnomalyKind when the
// segment is stable (no alert should be raised).
const AnomalyNone = ""

// Default cliff thresholds (D2, approved). Env-overridable in main.go
// via POSTWAVE_DECAY_CLIFF_PCT / POSTWAVE_DECAY_CLIFF_ABS, surfaced onto
// DecayWorker.CliffPctThreshold / CliffAbsThreshold.
const (
	DefaultCliffPctThreshold = 0.30 // 30% drop
	DefaultCliffAbsThreshold = 50   // and at least 50 members
)

// MembershipLogCapPerDirection is the hard per-direction cap on
// segment_membership_log rows written per segment per day (D1,
// approved). Disclosed in the UI via ComputedFrom.
const MembershipLogCapPerDirection = 1000

// DecayEvent is the wire projection of a segment_decay_events row.
type DecayEvent struct {
	ID             string          `json:"id"`
	TenantID       string          `json:"tenant_id"`
	SegmentID      string          `json:"segment_id"`
	SnapshotDate   string          `json:"snapshot_date"` // YYYY-MM-DD
	AnomalyKind    string          `json:"anomaly_kind"`
	PriorCount     int             `json:"prior_count"`
	NewCount       int             `json:"new_count"`
	LeaverCount    int             `json:"leaver_count"`
	EntrantCount   int             `json:"entrant_count"`
	ClauseAttrs    json.RawMessage `json:"clause_attrs,omitempty"`
	Narration      string          `json:"narration,omitempty"`
	NarrationModel string          `json:"narration_model,omitempty"`
	DismissedAt    *string         `json:"dismissed_at,omitempty"`
	AuditEventID   *int64          `json:"audit_event_id,omitempty"`
	CreatedAt      string          `json:"created_at"`
}

// MembershipDiffEntry is one entrant/leaver row destined for
// segment_membership_log (and the wire projection of a read-back row).
type MembershipDiffEntry struct {
	SubscriberID string          `json:"subscriber_id"`
	Email        string          `json:"email"`
	Direction    string          `json:"direction"` // entered|left
	ClauseAttrs  json.RawMessage `json:"clause_attrs,omitempty"`
}

// DefinitionHistoryEntry is one segment.update/segment.delete audit row
// surfaced for the definition-integrity journal.
type DefinitionHistoryEntry struct {
	AuditID    int64       `json:"audit_id"`
	At         string      `json:"at"`
	ActorLabel string      `json:"actor_label"`
	Action     string      `json:"action"`
	Before     interface{} `json:"before,omitempty"`
	After      interface{} `json:"after,omitempty"`
}

// detectAnomalyKind classifies a segment-size transition. It is the pure
// heart of the radar — no DB, no I/O — so the boundary cases (priorCount
// == 0, totalSubscribers == 0) are exhaustively table-tested.
//
// Precedence (most-severe first):
//   - everyone_match : newCount == totalSubscribers AND priorCount didn't
//     already match everyone (a fresh "matches everybody" event).
//   - zero_match     : newCount == 0 AND priorCount > 0 (a fresh collapse
//     to nobody).
//   - size_cliff     : drop fraction >= pctThreshold AND absolute drop >=
//     absThreshold. Both gates must trip so a tiny segment that loses 1
//     of 3 members never pages anyone.
//   - "" (AnomalyNone): stable / grew / insufficiently large drop.
func detectAnomalyKind(priorCount, newCount, totalSubscribers int, pctThreshold float64, absThreshold int) string {
	// everyone_match: the segment now matches every subscriber and didn't
	// before. Guard totalSubscribers > 0 so an empty tenant (0 subs, 0
	// match) isn't mislabelled as "matches everyone".
	if totalSubscribers > 0 && newCount >= totalSubscribers && priorCount < totalSubscribers {
		return AnomalyEveryoneMatch
	}
	// zero_match: collapsed to nobody from a non-empty prior.
	if newCount == 0 && priorCount > 0 {
		return AnomalyZeroMatch
	}
	// size_cliff: a meaningful drop. priorCount == 0 can't drop, and a
	// non-drop (newCount >= priorCount) is never a cliff.
	if priorCount > 0 && newCount < priorCount {
		drop := priorCount - newCount
		if drop < absThreshold {
			return AnomalyNone
		}
		// priorCount > 0 here, so the division is safe.
		frac := float64(drop) / float64(priorCount)
		if frac >= pctThreshold {
			return AnomalySizeCliff
		}
	}
	return AnomalyNone
}

// attributionFromClauseAttrs folds the per-leaver clause_attrs blobs
// (written to segment_membership_log) into a {clause_index:
// leaver_count} aggregate suitable for segment_decay_events.clause_attrs.
// A leaver is attributed to clause i when its clause_attrs[i] is true
// (the clause was still satisfied at exit — see attributeClauses in
// decay_worker.go). Pure; no DB.
//
// Returns nil (not an empty map) when there is nothing to attribute, so
// the caller stores SQL NULL and the UI shows "attribution unavailable"
// rather than an empty-bars block.
func attributionFromClauseAttrs(perLeaver []map[int]bool) map[int]int {
	if len(perLeaver) == 0 {
		return nil
	}
	out := map[int]int{}
	for _, m := range perLeaver {
		for idx, matched := range m {
			if matched {
				out[idx]++
			}
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// DecayStore is the persistence boundary for decay events + membership
// log. The worker and handlers depend on this interface; the production
// pgx implementation is DecayRepo and the tests use a fake. Every method
// is tenant-scoped (the impl opens db.WithTenant so RLS fires).
type DecayStore interface {
	InsertDecayEvent(ctx context.Context, tenantID string, ev DecayEvent) (string, error)
	ListDecayEvents(ctx context.Context, tenantID, segmentID string, undismissedOnly bool, limit int) ([]DecayEvent, error)
	GetDecayEvent(ctx context.Context, tenantID, eventID string) (*DecayEvent, error)
	DismissDecayEvent(ctx context.Context, tenantID, eventID string) error
	SetNarration(ctx context.Context, tenantID, eventID, narration, model string) error
	InsertMembershipLogBatch(ctx context.Context, tenantID, segmentID string, snapshotDate string, entries []MembershipDiffEntry) error
	ListMembershipLog(ctx context.Context, tenantID, segmentID, snapshotDate, direction string, page, perPage int) (items []MembershipDiffEntry, total int, err error)
	DefinitionHistory(ctx context.Context, tenantID, segmentID string, limit int) ([]DefinitionHistoryEntry, error)
}

// DecayRepo is the postgres-backed DecayStore. It reuses the segments
// Repo's pool; every method opens its own tenant-scoped tx so RLS fires.
type DecayRepo struct {
	Pool *db.Pool
}

var _ DecayStore = (*DecayRepo)(nil)

// InsertDecayEvent writes one segment_decay_events row and returns its id.
func (r *DecayRepo) InsertDecayEvent(ctx context.Context, tenantID string, ev DecayEvent) (string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var clauseAttrs []byte
	if len(ev.ClauseAttrs) > 0 {
		clauseAttrs = []byte(ev.ClauseAttrs)
	}
	var id string
	err = tx.QueryRow(ctx, `
INSERT INTO segment_decay_events
    (tenant_id, segment_id, snapshot_date, anomaly_kind, prior_count,
     new_count, leaver_count, entrant_count, clause_attrs, audit_event_id)
VALUES ($1::uuid, $2::uuid, $3::date, $4, $5, $6, $7, $8, $9::jsonb, $10)
RETURNING id::text`,
		tenantID, ev.SegmentID, ev.SnapshotDate, ev.AnomalyKind, ev.PriorCount,
		ev.NewCount, ev.LeaverCount, ev.EntrantCount, clauseAttrs, ev.AuditEventID).
		Scan(&id)
	if err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return id, nil
}

// ListDecayEvents returns decay events for a segment newest-first.
func (r *DecayRepo) ListDecayEvents(ctx context.Context, tenantID, segmentID string, undismissedOnly bool, limit int) ([]DecayEvent, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := `
SELECT id::text, tenant_id::text, segment_id::text,
       to_char(snapshot_date, 'YYYY-MM-DD'), anomaly_kind, prior_count,
       new_count, leaver_count, entrant_count, clause_attrs, narration,
       narration_model, dismissed_at, audit_event_id, created_at
  FROM segment_decay_events
 WHERE tenant_id = $1::uuid AND segment_id = $2::uuid`
	if undismissedOnly {
		q += ` AND dismissed_at IS NULL`
	}
	q += ` ORDER BY created_at DESC LIMIT $3`
	rows, err := tx.Query(ctx, q, tenantID, segmentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DecayEvent{}
	for rows.Next() {
		ev, err := scanDecayEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// GetDecayEvent fetches a single decay event by id.
func (r *DecayRepo) GetDecayEvent(ctx context.Context, tenantID, eventID string) (*DecayEvent, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT id::text, tenant_id::text, segment_id::text,
       to_char(snapshot_date, 'YYYY-MM-DD'), anomaly_kind, prior_count,
       new_count, leaver_count, entrant_count, clause_attrs, narration,
       narration_model, dismissed_at, audit_event_id, created_at
  FROM segment_decay_events
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, eventID)
	ev, err := scanDecayEvent(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &ev, nil
}

// DismissDecayEvent sets dismissed_at = now() (idempotent).
func (r *DecayRepo) DismissDecayEvent(ctx context.Context, tenantID, eventID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE segment_decay_events
   SET dismissed_at = COALESCE(dismissed_at, now())
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, eventID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// SetNarration caches an LLM narration onto a decay event (on-demand, D3).
func (r *DecayRepo) SetNarration(ctx context.Context, tenantID, eventID, narration, model string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE segment_decay_events
   SET narration = $3, narration_model = $4
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, eventID, narration, model)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// InsertMembershipLogBatch appends the entrant/leaver diff for one
// (segment, day). Callers MUST cap each direction to
// MembershipLogCapPerDirection before calling (the worker does). A
// single multi-row INSERT keeps the round-trip count to one.
func (r *DecayRepo) InsertMembershipLogBatch(ctx context.Context, tenantID, segmentID, snapshotDate string, entries []MembershipDiffEntry) error {
	if len(entries) == 0 {
		return nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows := make([][]interface{}, 0, len(entries))
	for _, e := range entries {
		var attrs []byte
		if len(e.ClauseAttrs) > 0 {
			attrs = []byte(e.ClauseAttrs)
		}
		rows = append(rows, []interface{}{
			tenantID, segmentID, e.SubscriberID, e.Email, e.Direction, snapshotDate, attrs,
		})
	}
	_, err = tx.CopyFrom(ctx,
		pgx.Identifier{"segment_membership_log"},
		[]string{"tenant_id", "segment_id", "subscriber_id", "email", "direction", "snapshot_date", "clause_attrs"},
		pgx.CopyFromRows(rows))
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListMembershipLog pages through the per-member diff for one decay
// event's (segment, day, direction). total is the count in the log
// (bounded by the per-direction cap) so the UI can show ComputedFrom.
func (r *DecayRepo) ListMembershipLog(ctx context.Context, tenantID, segmentID, snapshotDate, direction string, page, perPage int) ([]MembershipDiffEntry, int, error) {
	if perPage <= 0 || perPage > 200 {
		perPage = 50
	}
	if page <= 0 {
		page = 1
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var total int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM segment_membership_log
 WHERE tenant_id = $1::uuid AND segment_id = $2::uuid
   AND snapshot_date = $3::date AND direction = $4`,
		tenantID, segmentID, snapshotDate, direction).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := tx.Query(ctx, `
SELECT subscriber_id::text, email::text, direction, clause_attrs
  FROM segment_membership_log
 WHERE tenant_id = $1::uuid AND segment_id = $2::uuid
   AND snapshot_date = $3::date AND direction = $4
 ORDER BY id ASC
 LIMIT $5 OFFSET $6`,
		tenantID, segmentID, snapshotDate, direction, perPage, (page-1)*perPage)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []MembershipDiffEntry{}
	for rows.Next() {
		var e MembershipDiffEntry
		var attrs []byte
		if err := rows.Scan(&e.SubscriberID, &e.Email, &e.Direction, &attrs); err != nil {
			return nil, 0, err
		}
		if len(attrs) > 0 {
			e.ClauseAttrs = json.RawMessage(attrs)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

// DefinitionHistory reads the audit_log for segment.update/segment.delete
// rows against this segment, newest-first, pulling metadata.before/after
// for the definition-integrity journal.
func (r *DecayRepo) DefinitionHistory(ctx context.Context, tenantID, segmentID string, limit int) ([]DefinitionHistoryEntry, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id, action, COALESCE(actor_label, ''), at,
       metadata->'before', metadata->'after'
  FROM audit_log
 WHERE tenant_id = $1::uuid
   AND resource_type = 'segment'
   AND resource_id = $2
   AND action IN ('segment.update', 'segment.delete')
 ORDER BY id DESC
 LIMIT $3`, tenantID, segmentID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DefinitionHistoryEntry{}
	for rows.Next() {
		var (
			e      DefinitionHistoryEntry
			at     interface{}
			before []byte
			after  []byte
		)
		if err := rows.Scan(&e.AuditID, &e.Action, &e.ActorLabel, &at, &before, &after); err != nil {
			return nil, err
		}
		e.At = toRFC3339(at)
		if len(before) > 0 {
			_ = json.Unmarshal(before, &e.Before)
		}
		if len(after) > 0 {
			_ = json.Unmarshal(after, &e.After)
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// rowScanner is the common surface of pgx.Row and pgx.Rows so
// scanDecayEvent serves both the single-row and list paths.
type rowScanner interface {
	Scan(dest ...interface{}) error
}

func scanDecayEvent(s rowScanner) (DecayEvent, error) {
	var (
		ev      DecayEvent
		attrs   []byte
		narr    *string
		model   *string
		dismiss interface{}
		auditID *int64
		created interface{}
	)
	if err := s.Scan(&ev.ID, &ev.TenantID, &ev.SegmentID, &ev.SnapshotDate,
		&ev.AnomalyKind, &ev.PriorCount, &ev.NewCount, &ev.LeaverCount,
		&ev.EntrantCount, &attrs, &narr, &model, &dismiss, &auditID, &created); err != nil {
		return ev, err
	}
	if len(attrs) > 0 {
		ev.ClauseAttrs = json.RawMessage(attrs)
	}
	if narr != nil {
		ev.Narration = *narr
	}
	if model != nil {
		ev.NarrationModel = *model
	}
	ev.AuditEventID = auditID
	if d := toRFC3339Ptr(dismiss); d != nil {
		ev.DismissedAt = d
	}
	ev.CreatedAt = toRFC3339(created)
	return ev, nil
}

// ----------------------------------------------------------------------
// HTTP handlers — read surface + dismiss + on-demand narrate.
// ----------------------------------------------------------------------

// DecayDeps wires the decay-radar HTTP handlers. Kept separate from the
// shared segments.Deps so this feature can be mounted without mutating
// the existing Deps struct (parallel-work safety on the shared branch).
//
// DecayStore is the persistence boundary (DecayRepo in prod, a fake in
// tests). AIProvider is optional — when nil the /narrate route returns
// 503 ai_unavailable. Logger is optional (nil-safe via httperror).
type DecayDeps struct {
	DecayStore DecayStore
	AIProvider NLProvider
	Logger     *slog.Logger
}

// MountDecayRoutes registers the decay-radar HTTP surface. Reads use
// read:subscribers (same gate as the other segment analytics routes);
// dismiss + narrate (which spends LLM quota) use write:subscribers.
// Mounted from MountExtended via the integrator's manifest edit.
func MountDecayRoutes(r chi.Router, d *DecayDeps) {
	if d == nil || d.DecayStore == nil {
		return
	}
	read := r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers))
	write := r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers))

	read.Get("/api/v1/segments/{id}/decay-events", d.ListDecayEvents)
	read.Get("/api/v1/segments/{id}/decay-events/{event_id}/members", d.DecayEventMembers)
	read.Get("/api/v1/segments/{id}/definition-history", d.DefinitionHistory)
	write.Post("/api/v1/segments/{id}/decay-events/{event_id}/dismiss", d.DismissDecayEvent)
	write.Post("/api/v1/segments/{id}/decay-events/{event_id}/narrate", d.NarrateDecayEvent)
}

// ListDecayEvents GET /api/v1/segments/{id}/decay-events?limit=&undismissed=.
func (d *DecayDeps) ListDecayEvents(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if d.DecayStore == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "decay_unavailable", "segment decay radar is not configured")
		return
	}
	segmentID := chi.URLParam(r, "id")
	limit := atoiDefault(r.URL.Query().Get("limit"), 50)
	undismissed := r.URL.Query().Get("undismissed") == "true"
	items, err := d.DecayStore.ListDecayEvents(r.Context(), t.ID, segmentID, undismissed, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONDecay(w, http.StatusOK, map[string]interface{}{"items": items, "total": len(items)})
}

// DecayEventMembers GET …/decay-events/{event_id}/members?direction=&page=&per_page=.
// Honest-UI: bounded_by_log_cap flags when the log hit the per-direction
// cap so the UI renders ComputedFrom truthfully.
func (d *DecayDeps) DecayEventMembers(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if d.DecayStore == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "decay_unavailable", "segment decay radar is not configured")
		return
	}
	segmentID := chi.URLParam(r, "id")
	eventID := chi.URLParam(r, "event_id")
	ev, err := d.DecayStore.GetDecayEvent(r.Context(), t.ID, eventID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "decay_event_not_found", "decay event not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	direction := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("direction")))
	if direction != "entered" {
		direction = "left"
	}
	page := atoiDefault(r.URL.Query().Get("page"), 1)
	perPage := atoiDefault(r.URL.Query().Get("per_page"), 50)
	items, total, err := d.DecayStore.ListMembershipLog(r.Context(), t.ID, segmentID, ev.SnapshotDate, direction, page, perPage)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONDecay(w, http.StatusOK, map[string]interface{}{
		"items":              items,
		"page":               page,
		"per_page":           perPage,
		"total":              total,
		"total_in_log":       total,
		"bounded_by_log_cap": total >= MembershipLogCapPerDirection,
	})
}

// DefinitionHistory GET /api/v1/segments/{id}/definition-history?limit=.
func (d *DecayDeps) DefinitionHistory(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if d.DecayStore == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "decay_unavailable", "segment decay radar is not configured")
		return
	}
	segmentID := chi.URLParam(r, "id")
	limit := atoiDefault(r.URL.Query().Get("limit"), 20)
	items, err := d.DecayStore.DefinitionHistory(r.Context(), t.ID, segmentID, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONDecay(w, http.StatusOK, map[string]interface{}{"items": items})
}

// DismissDecayEvent POST …/decay-events/{event_id}/dismiss.
func (d *DecayDeps) DismissDecayEvent(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if d.DecayStore == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "decay_unavailable", "segment decay radar is not configured")
		return
	}
	eventID := chi.URLParam(r, "event_id")
	if err := d.DecayStore.DismissDecayEvent(r.Context(), t.ID, eventID); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "decay_event_not_found", "decay event not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSONDecay(w, http.StatusOK, map[string]interface{}{"dismissed": true})
}

// NarrateDecayEvent POST …/decay-events/{event_id}/narrate — on-demand
// LLM "who left and why" (D3). 503 when no AIProvider is wired. The
// narration is cached on the event and returned. The narration field is
// nullable in the schema, so this never fabricates copy when AI is off.
func (d *DecayDeps) NarrateDecayEvent(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	if d.DecayStore == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "decay_unavailable", "segment decay radar is not configured")
		return
	}
	if d.AIProvider == nil {
		httperror.Write(w, http.StatusServiceUnavailable, "ai_unavailable", "AI narration is not configured")
		return
	}
	segmentID := chi.URLParam(r, "id")
	eventID := chi.URLParam(r, "event_id")
	ev, err := d.DecayStore.GetDecayEvent(r.Context(), t.ID, eventID)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "decay_event_not_found", "decay event not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	// Pull a bounded leaver sample for the prompt (first page of the log).
	sample, _, err := d.DecayStore.ListMembershipLog(r.Context(), t.ID, segmentID, ev.SnapshotDate, "left", 1, 50)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	emails := make([]string, 0, len(sample))
	for _, m := range sample {
		emails = append(emails, m.Email)
	}
	narration, model, err := narrateDecay(r.Context(), d.AIProvider, *ev, emails)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	if narration == "" {
		httperror.Write(w, http.StatusServiceUnavailable, "ai_unavailable", "AI narration returned no text")
		return
	}
	if err := d.DecayStore.SetNarration(r.Context(), t.ID, eventID, narration, model); err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	ev.Narration = narration
	ev.NarrationModel = model
	writeJSONDecay(w, http.StatusOK, ev)
}

func writeJSONDecay(w http.ResponseWriter, status int, body interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func atoiDefault(s string, def int) int {
	if s == "" {
		return def
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return def
	}
	return n
}

// toRFC3339 normalises a timestamp scanned from pgx (a time.Time) into an
// RFC3339 string for the wire. Non-time inputs (NULL) yield "".
func toRFC3339(v interface{}) string {
	if t, ok := v.(time.Time); ok {
		return t.UTC().Format(time.RFC3339)
	}
	return ""
}

// toRFC3339Ptr is the nullable variant: returns nil for a NULL/zero
// timestamp so the JSON omits the key (e.g. dismissed_at).
func toRFC3339Ptr(v interface{}) *string {
	if t, ok := v.(time.Time); ok && !t.IsZero() {
		s := t.UTC().Format(time.RFC3339)
		return &s
	}
	return nil
}
