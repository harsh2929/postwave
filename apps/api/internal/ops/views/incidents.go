package views

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// ErrIncidentCursorNotFound is intentionally shared by a deleted cursor and a
// cursor belonging to another incident. The handler maps both to the same 404
// so one incident cannot be used to probe another incident's update IDs.
var ErrIncidentCursorNotFound = errors.New("incident timeline cursor not found")

// isNoRows reports whether err is pgx's "no rows" sentinel, so a missing
// incident becomes a 404 rather than a 500.
func isNoRows(err error) bool {
	return errors.Is(err, pgx.ErrNoRows)
}

// Incident severities and statuses — the only values the ops_incidents CHECK
// constraints accept. Validated in Go before a write so a bad value is a 400,
// not a database constraint error surfaced as a 500.
func ValidSeverity(s string) bool {
	return s == "sev1" || s == "sev2" || s == "sev3"
}

func ValidIncidentStatus(s string) bool {
	return s == "open" || s == "monitoring" || s == "resolved"
}

// IncidentRow is one incident header for the timeline list.
type IncidentRow struct {
	ID         string     `json:"id"`
	Title      string     `json:"title"`
	Severity   string     `json:"severity"`
	Status     string     `json:"status"`
	OpenedBy   string     `json:"opened_by"`
	OpenedAt   time.Time  `json:"opened_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
	ResolvedAt *time.Time `json:"resolved_at,omitempty"`
}

// IncidentUpdate is one append-only entry in an incident's timeline.
type IncidentUpdate struct {
	ID              string    `json:"id"`
	Body            string    `json:"body"`
	Author          string    `json:"author"`
	RequestedStatus string    `json:"requested_status,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
}

// IncidentDetail is an incident header plus its full update stream.
type IncidentDetail struct {
	IncidentRow
	Updates          []IncidentUpdate `json:"updates"`
	UpdatesTruncated bool             `json:"updates_truncated,omitempty"`
	NextBefore       string           `json:"next_before,omitempty"`
}

// incidentTimelineUpdateLimit bounds a single response and the service's
// memory use. When an incident exceeds the cap, the newest entries are returned
// (in chronological order) and UpdatesTruncated tells the caller older history
// exists.
const incidentTimelineUpdateLimit = 500

// ListIncidents returns incidents for the console. Unresolved always sort first
// (an open incident outranks any resolved one), then most-recently-opened. When
// includeResolved is false, resolved incidents are omitted entirely.
//
// ops_incidents is a platform table postwave_ops holds direct SELECT on, so this
// reads it directly — no SECURITY DEFINER wrapper (there is no tenant row to
// protect; these are the operator's own records).
func (r *Reader) ListIncidents(ctx context.Context, includeResolved bool, limit int) ([]IncidentRow, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := r.Pool.Query(ctx, `
SELECT id::text, title, severity, status, opened_by, opened_at, updated_at, resolved_at
  FROM ops_incidents
 WHERE ($1 OR status <> 'resolved')
 ORDER BY (status = 'resolved') ASC, opened_at DESC
 LIMIT $2`, includeResolved, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []IncidentRow{}
	for rows.Next() {
		var row IncidentRow
		if err := rows.Scan(&row.ID, &row.Title, &row.Severity, &row.Status,
			&row.OpenedBy, &row.OpenedAt, &row.UpdatedAt, &row.ResolvedAt); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// IncidentTimeline returns one incident page oldest-first. before is an
// incident-bound update UUID: when present, only rows strictly older than that
// row's deterministic (created_at,id) position are returned. Returns (nil,
// nil) when the incident does not exist. A missing/deleted/cross-incident
// cursor returns ErrIncidentCursorNotFound without disclosing where it exists.
func (r *Reader) IncidentTimeline(ctx context.Context, id, before string) (*IncidentDetail, error) {
	tx, err := r.Pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var d IncidentDetail
	err = tx.QueryRow(ctx, `
SELECT id::text, title, severity, status, opened_by, opened_at, updated_at, resolved_at
  FROM ops_incidents WHERE id = $1`, id).
		Scan(&d.ID, &d.Title, &d.Severity, &d.Status, &d.OpenedBy, &d.OpenedAt, &d.UpdatedAt, &d.ResolvedAt)
	if err != nil {
		if isNoRows(err) {
			return nil, nil
		}
		return nil, err
	}

	var rows pgx.Rows
	if before == "" {
		rows, err = tx.Query(ctx, `
SELECT recent.id::text, recent.body, recent.author,
       COALESCE(recent.requested_status, ''), recent.created_at
  FROM (
        SELECT id, body, author, requested_status, created_at
          FROM ops_incident_updates
         WHERE incident_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2
       ) AS recent
		 ORDER BY recent.created_at ASC, recent.id ASC`, id, incidentTimelineUpdateLimit+1)
	} else {
		var beforeAt time.Time
		if err := tx.QueryRow(ctx, `
SELECT created_at
  FROM ops_incident_updates
 WHERE incident_id = $1
   AND id = $2`, id, before).Scan(&beforeAt); err != nil {
			if isNoRows(err) {
				return nil, ErrIncidentCursorNotFound
			}
			return nil, err
		}
		rows, err = tx.Query(ctx, `
SELECT recent.id::text, recent.body, recent.author,
       COALESCE(recent.requested_status, ''), recent.created_at
  FROM (
        SELECT id, body, author, requested_status, created_at
          FROM ops_incident_updates
         WHERE incident_id = $1
           AND (created_at, id) < ($3, $4::uuid)
         ORDER BY created_at DESC, id DESC
         LIMIT $2
       ) AS recent
 ORDER BY recent.created_at ASC, recent.id ASC`,
			id, incidentTimelineUpdateLimit+1, beforeAt, before)
	}
	if err != nil {
		return nil, err
	}
	d.Updates = []IncidentUpdate{}
	for rows.Next() {
		var u IncidentUpdate
		if err := rows.Scan(&u.ID, &u.Body, &u.Author, &u.RequestedStatus, &u.CreatedAt); err != nil {
			return nil, err
		}
		d.Updates = append(d.Updates, u)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(d.Updates) > incidentTimelineUpdateLimit {
		d.Updates = d.Updates[1:]
		d.UpdatesTruncated = true
		d.NextBefore = d.Updates[0].ID
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &d, nil
}
