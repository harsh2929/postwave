package views

// incidents_actions.go — the incident timeline's writes. Unlike the kill switch
// (which mutates a tenant), these mutate ops-owned platform tables postwave_ops
// holds direct DML on, so there is no tenant scoping — but every write still
// records the operator (opened_by / author) and runs on a detached, bounded
// context so a closed tab cannot strand a half-written incident.

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

const incidentWriteTimeout = 30 * time.Second

// IncidentStore is the narrow write surface for incidents. IncidentRepo (over a
// pool) satisfies it; handler tests use a fake.
type IncidentStore interface {
	OpenIncident(ctx context.Context, title, severity, body, actor, idempotencyKey string) (id string, replayed bool, err error)
	AppendUpdate(ctx context.Context, incidentID, body, newStatus, actor, idempotencyKey string) (replayed bool, err error)
}

var (
	ErrIncidentIdempotencyConflict = errors.New("incident idempotency key was reused with a different request")
	ErrIncidentResolved            = errors.New("resolved incidents are terminal")
	ErrIncidentTimelineFull        = errors.New("incident timeline has reached its durable limit")
)

// IncidentRepo writes incidents through the ops pool.
type IncidentRepo struct {
	Pool *pgxpool.Pool
}

// OpenIncident inserts the incident header and its first update atomically, so
// an incident never exists with an empty timeline.
func (repo *IncidentRepo) OpenIncident(ctx context.Context, title, severity, body, actor, idempotencyKey string) (string, bool, error) {
	tx, err := repo.Pool.Begin(ctx)
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var id string
	err = tx.QueryRow(ctx, `
INSERT INTO ops_incidents (title, severity, opened_by, idempotency_key)
VALUES ($1, $2, $3, $4::uuid)
ON CONFLICT (idempotency_key) DO NOTHING
RETURNING id::text`, title, severity, actor, idempotencyKey).Scan(&id)
	if isNoRows(err) {
		var gotTitle, gotSeverity, gotActor string
		if err := tx.QueryRow(ctx, `
SELECT id::text, title, severity, opened_by
  FROM ops_incidents
 WHERE idempotency_key = $1::uuid`, idempotencyKey).
			Scan(&id, &gotTitle, &gotSeverity, &gotActor); err != nil {
			return "", false, err
		}
		var gotIncidentID, gotBody, gotUpdateActor, gotStatus string
		if err := tx.QueryRow(ctx, `
SELECT incident_id::text, body, author, COALESCE(requested_status, '')
  FROM ops_incident_updates
 WHERE idempotency_key = $1::uuid`, idempotencyKey).
			Scan(&gotIncidentID, &gotBody, &gotUpdateActor, &gotStatus); err != nil {
			return "", false, err
		}
		if gotTitle != title || gotSeverity != severity || gotActor != actor ||
			gotIncidentID != id || gotBody != body || gotUpdateActor != actor || gotStatus != "open" {
			return "", false, ErrIncidentIdempotencyConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return "", false, err
		}
		return id, true, nil
	}
	if err != nil {
		return "", false, normalizeIncidentWriteError(err)
	}
	tag, err := tx.Exec(ctx, `
INSERT INTO ops_incident_updates
       (incident_id, body, author, idempotency_key, requested_status)
VALUES ($1::uuid, $2, $3, $4::uuid, 'open')
ON CONFLICT (idempotency_key) DO NOTHING`, id, body, actor, idempotencyKey)
	if err != nil {
		return "", false, normalizeIncidentWriteError(err)
	}
	if tag.RowsAffected() != 1 {
		return "", false, ErrIncidentIdempotencyConflict
	}
	if err := tx.Commit(ctx); err != nil {
		return "", false, err
	}
	return id, false, nil
}

// AppendUpdate adds a timeline entry and, when newStatus is non-empty,
// transitions the incident. The database trigger owns updated_at/resolved_at
// and makes resolved terminal, so the ops principal cannot forge chronology.
// The status write and the update insert are one transaction: the timeline and
// the header never disagree about what happened.
func (repo *IncidentRepo) AppendUpdate(ctx context.Context, incidentID, body, newStatus, actor, idempotencyKey string) (bool, error) {
	tx, err := repo.Pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Resolve the parent first so a missing UUID is a clean 404. The restricted
	// postwave_ops role deliberately has no UPDATE privilege, so it cannot use
	// SELECT FOR UPDATE directly. Migration 1739's SECURITY DEFINER BEFORE
	// trigger takes the parent row lock for every timeline insert; the AFTER
	// trigger then owns the status transition and timestamps.
	var existingID string
	if err := tx.QueryRow(ctx, `
SELECT id::text FROM ops_incidents WHERE id = $1::uuid`, incidentID).
		Scan(&existingID); err != nil {
		return false, err
	}
	tag, err := tx.Exec(ctx, `
INSERT INTO ops_incident_updates
       (incident_id, body, author, idempotency_key, requested_status)
VALUES ($1::uuid, $2, $3, $4::uuid, NULLIF($5, ''))
ON CONFLICT (idempotency_key) DO NOTHING`, incidentID, body, actor, idempotencyKey, newStatus)
	if err != nil {
		return false, normalizeIncidentWriteError(err)
	}
	if tag.RowsAffected() == 0 {
		var gotIncidentID, gotBody, gotActor, gotStatus string
		if err := tx.QueryRow(ctx, `
SELECT incident_id::text, body, author, COALESCE(requested_status, '')
  FROM ops_incident_updates
 WHERE idempotency_key = $1::uuid`, idempotencyKey).
			Scan(&gotIncidentID, &gotBody, &gotActor, &gotStatus); err != nil {
			return false, err
		}
		if gotIncidentID != incidentID || gotBody != body || gotActor != actor || gotStatus != newStatus {
			return false, ErrIncidentIdempotencyConflict
		}
		if err := tx.Commit(ctx); err != nil {
			return false, err
		}
		return true, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return false, nil
}

func normalizeIncidentWriteError(err error) error {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err
	}
	switch pgErr.Code {
	case "23503":
		return pgx.ErrNoRows
	case "23514":
		return ErrIncidentResolved
	case "54000":
		return ErrIncidentTimelineFull
	default:
		return err
	}
}

// --- HTTP handlers ---

type openIncidentBody struct {
	Title          string `json:"title"`
	Severity       string `json:"severity"`
	Body           string `json:"body"`
	IdempotencyKey string `json:"idempotency_key"`
}

// OpenIncidentHandler serves POST /api/internal/ops/views/incidents.
func OpenIncidentHandler(store IncidentStore, audit ActionAudit, operator OperatorResolver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body openIncidentBody
		if !decodeViewJSON(w, r, &body) {
			return
		}
		var ok bool
		if body.Title, ok = boundedSingleLineText(body.Title, 256, 1024); !ok {
			writeViewError(w, http.StatusBadRequest, "invalid_title", "title must be 1 to 256 characters")
			return
		}
		if body.Body, ok = boundedMultilineText(body.Body, 4096, 16384); !ok {
			writeViewError(w, http.StatusBadRequest, "invalid_body", "opening note must be 1 to 4096 characters")
			return
		}
		if !ValidSeverity(body.Severity) {
			writeViewError(w, http.StatusBadRequest, "invalid_severity", "severity must be sev1, sev2, or sev3")
			return
		}
		body.IdempotencyKey, ok = canonicalUUID(body.IdempotencyKey)
		if !ok {
			writeViewError(w, http.StatusBadRequest, "invalid_idempotency_key", "idempotency_key must be a canonical non-zero UUID")
			return
		}
		actor, ok := resolveOperator(operator, r.Context())
		if !ok {
			writeViewError(w, http.StatusInternalServerError, "operator_missing", "incident endpoint reached without an authenticated operator")
			return
		}
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), incidentWriteTimeout)
		defer cancel()

		intent := map[string]any{
			"severity": body.Severity, "title": body.Title, "actor": actor,
			"idempotency_key": body.IdempotencyKey,
		}
		if audit == nil || audit(ctx, "ops.incident.open.intent", intent) != nil {
			writeViewError(w, http.StatusServiceUnavailable, "audit_unavailable", "refusing to open an unauditable incident")
			return
		}

		id, replayed, err := store.OpenIncident(ctx, body.Title, body.Severity, body.Body, actor, body.IdempotencyKey)
		if err != nil {
			writeIncidentStoreError(w, err, "open_incident_failed")
			return
		}
		if err := audit(ctx, "ops.incident.opened", map[string]any{
			"incident_id": id, "severity": body.Severity, "title": body.Title, "actor": actor,
			"idempotency_key": body.IdempotencyKey, "replayed": replayed,
		}); err != nil {
			slog.Error("ops: incident-open outcome audit write failed", "incident_id", id, "err", err)
		}
		status := http.StatusCreated
		if replayed {
			status = http.StatusOK
		}
		writeViewJSONStatus(w, status, map[string]any{"id": id, "status": "open", "replayed": replayed})
	}
}

type updateIncidentBody struct {
	Body           string `json:"body"`
	Status         string `json:"status"` // optional; "" = note only
	IdempotencyKey string `json:"idempotency_key"`
}

// AppendUpdateHandler serves POST /api/internal/ops/views/incidents/{id}/updates.
func AppendUpdateHandler(store IncidentStore, audit ActionAudit, operator OperatorResolver) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		incidentID, ok := canonicalUUID(chi.URLParam(r, "id"))
		if !ok {
			writeViewError(w, http.StatusBadRequest, "invalid_incident_id", "incident id must be a canonical non-zero UUID")
			return
		}
		var body updateIncidentBody
		if !decodeViewJSON(w, r, &body) {
			return
		}
		if body.Body, ok = boundedMultilineText(body.Body, 4096, 16384); !ok {
			writeViewError(w, http.StatusBadRequest, "invalid_body", "update must be 1 to 4096 characters")
			return
		}
		if body.Status != "" && !ValidIncidentStatus(body.Status) {
			writeViewError(w, http.StatusBadRequest, "invalid_status", "status must be open, monitoring, resolved, or empty")
			return
		}
		body.IdempotencyKey, ok = canonicalUUID(body.IdempotencyKey)
		if !ok {
			writeViewError(w, http.StatusBadRequest, "invalid_idempotency_key", "idempotency_key must be a canonical non-zero UUID")
			return
		}
		actor, ok := resolveOperator(operator, r.Context())
		if !ok {
			writeViewError(w, http.StatusInternalServerError, "operator_missing", "incident endpoint reached without an authenticated operator")
			return
		}
		ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), incidentWriteTimeout)
		defer cancel()

		intent := map[string]any{
			"incident_id": incidentID, "status": body.Status, "actor": actor,
			"idempotency_key": body.IdempotencyKey,
		}
		if audit == nil || audit(ctx, "ops.incident.update.intent", intent) != nil {
			writeViewError(w, http.StatusServiceUnavailable, "audit_unavailable", "refusing to append an unauditable incident update")
			return
		}

		replayed, err := store.AppendUpdate(ctx, incidentID, body.Body, body.Status, actor, body.IdempotencyKey)
		if err != nil {
			writeIncidentStoreError(w, err, "append_update_failed")
			return
		}
		if err := audit(ctx, "ops.incident.updated", map[string]any{
			"incident_id": incidentID, "status": body.Status, "actor": actor,
			"idempotency_key": body.IdempotencyKey, "replayed": replayed,
		}); err != nil {
			slog.Error("ops: incident-update outcome audit write failed", "incident_id", incidentID, "err", err)
		}
		writeViewJSON(w, map[string]any{"incident_id": incidentID, "status": "applied", "replayed": replayed})
	}
}

func resolveOperator(operator OperatorResolver, ctx context.Context) (string, bool) {
	if operator == nil {
		return "", false
	}
	actor, ok := boundedSingleLineText(operator(ctx), 320, 320)
	return actor, ok
}

func writeIncidentStoreError(w http.ResponseWriter, err error, fallbackCode string) {
	switch {
	case isNoRows(err):
		writeViewError(w, http.StatusNotFound, "incident_not_found", "incident was not found")
	case errors.Is(err, ErrIncidentIdempotencyConflict):
		writeViewError(w, http.StatusConflict, "idempotency_conflict", "idempotency key was already used for a different incident request")
	case errors.Is(err, ErrIncidentResolved):
		writeViewError(w, http.StatusConflict, "incident_resolved", "resolved incidents are terminal")
	case errors.Is(err, ErrIncidentTimelineFull):
		writeViewError(w, http.StatusConflict, "incident_timeline_full", "incident timeline has reached its durable limit")
	default:
		writeViewError(w, http.StatusInternalServerError, fallbackCode, "incident write failed")
	}
}

// --- read handlers ---

// IncidentLister/Timeliner narrow the Reader for handler tests.
type IncidentLister interface {
	ListIncidents(ctx context.Context, includeResolved bool, limit int) ([]IncidentRow, error)
}

type IncidentTimeliner interface {
	IncidentTimeline(ctx context.Context, id, before string) (*IncidentDetail, error)
}

// IncidentsHandler serves GET /api/internal/ops/views/incidents. ?resolved=1
// includes resolved incidents. Fail-loud.
func IncidentsHandler(l IncidentLister) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		includeResolved := r.URL.Query().Get("resolved") == "1"
		limit := viewLimit(r)
		rows, err := l.ListIncidents(r.Context(), includeResolved, limit)
		if err != nil {
			writeViewError(w, http.StatusInternalServerError, "incidents_unavailable", "incidents are unavailable")
			return
		}
		writeViewJSON(w, map[string]any{"incidents": rows, "truncated": len(rows) >= limit})
	}
}

// IncidentTimelineHandler serves GET /api/internal/ops/views/incidents/{id}.
func IncidentTimelineHandler(t IncidentTimeliner) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := canonicalUUID(chi.URLParam(r, "id"))
		if !ok {
			writeViewError(w, http.StatusBadRequest, "invalid_incident_id", "incident id must be a canonical non-zero UUID")
			return
		}
		before := ""
		query := r.URL.Query()
		for key := range query {
			if key != "before" {
				writeViewError(w, http.StatusBadRequest, "invalid_incident_cursor", "only one canonical before cursor is supported")
				return
			}
		}
		if values, present := query["before"]; present {
			if len(values) != 1 {
				writeViewError(w, http.StatusBadRequest, "invalid_incident_cursor", "only one canonical before cursor is supported")
				return
			}
			var cursorOK bool
			before, cursorOK = canonicalUUID(values[0])
			if !cursorOK {
				writeViewError(w, http.StatusBadRequest, "invalid_incident_cursor", "before must be a canonical non-zero update UUID")
				return
			}
		}
		detail, err := t.IncidentTimeline(r.Context(), id, before)
		if err != nil {
			if errors.Is(err, ErrIncidentCursorNotFound) {
				writeViewError(w, http.StatusNotFound, "incident_cursor_not_found", "incident timeline cursor was not found")
				return
			}
			writeViewError(w, http.StatusInternalServerError, "incident_unavailable", "incident timeline is unavailable")
			return
		}
		if detail == nil {
			writeViewError(w, http.StatusNotFound, "incident_not_found", "incident was not found")
			return
		}
		if err := boundIncidentTimelineResponse(detail); err != nil {
			writeViewError(w, http.StatusInternalServerError, "incident_unavailable", "incident timeline is unavailable")
			return
		}
		writeViewJSON(w, detail)
	}
}
