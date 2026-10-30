// SPDX-License-Identifier: AGPL-3.0-only
//
// access_requests.go — audit "Request access" flow (desktop-audit gap
// A14). A user who lacks the audit:read scope can file a request row;
// tenant owners/admins review pending rows through the list endpoint.
//
// Notification mechanism: investigated and documented honest minimum.
// internal/notifications is a preference *gate* (Dispatcher.Gate) with
// no notification-create helper, and audit_export_worker.go explicitly
// avoided introducing a system_notifications table. So this feature
// ships persist + owner-visible list; the HTTP handler additionally
// emits an `audit.access_request.created` audit row so the request is
// visible in the owner's audit trail / SSE live tail. When a real
// in-app notification bus lands, CreateAccessRequest is the single
// place to hook it.
package audit

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// MaxAccessRequestNoteLen bounds the optional note. Long enough for a
// sentence of justification, short enough that the row can't be used
// as free-form blob storage.
const MaxAccessRequestNoteLen = 1000

// AccessRequest is the wire shape for one audit access request row.
type AccessRequest struct {
	ID         string     `json:"id"`
	UserID     *string    `json:"userId,omitempty"`
	UserEmail  string     `json:"userEmail,omitempty"`
	ActorLabel string     `json:"actorLabel,omitempty"`
	Note       string     `json:"note,omitempty"`
	Status     string     `json:"status"`
	CreatedAt  time.Time  `json:"createdAt"`
	ResolvedAt *time.Time `json:"resolvedAt,omitempty"`
}

// CreateAccessRequestInput carries the requester identity resolved by
// the HTTP handler from the request context.
type CreateAccessRequestInput struct {
	TenantID   string
	UserID     string // empty for API-key callers
	UserEmail  string
	ActorLabel string // fallback identity for API-key callers
	Note       string
}

// NormalizeAccessRequestNote trims and bounds the optional note.
// Returns an error (not silent truncation) past the cap so the caller
// knows their justification was rejected rather than clipped.
func NormalizeAccessRequestNote(note string) (string, error) {
	note = strings.TrimSpace(note)
	if len(note) > MaxAccessRequestNoteLen {
		return "", fmt.Errorf("note too long: %d bytes (max %d)", len(note), MaxAccessRequestNoteLen)
	}
	return note, nil
}

// CreateAccessRequest persists one pending request. Idempotent per
// (tenant, user): when the user already has a pending row the existing
// row is returned and created=false — re-clicking the CTA must not
// pile up duplicates (enforced by the partial unique index from
// migration 0382).
func CreateAccessRequest(ctx context.Context, pool *db.Pool, in CreateAccessRequestInput) (*AccessRequest, bool, error) {
	if pool == nil {
		return nil, false, fmt.Errorf("access_requests: pool is required")
	}
	if in.TenantID == "" {
		return nil, false, fmt.Errorf("access_requests: tenant id is required")
	}
	note, err := NormalizeAccessRequestNote(in.Note)
	if err != nil {
		return nil, false, err
	}

	tx, err := db.WithTenant(ctx, pool, in.TenantID)
	if err != nil {
		return nil, false, fmt.Errorf("access_requests: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var userID *string
	if in.UserID != "" {
		userID = &in.UserID
	}

	// Flood guard for API-key callers (desktop-audit gap A14
	// follow-up): rows with requested_by IS NULL sit outside the
	// pending-per-user partial unique index, so without this check
	// every probe inserts a fresh pending row. Serialize their tenant-scoped
	// check+insert against the tenant row before looking for an existing actor
	// request. That gives API-key requests the same atomic "one pending ask"
	// property as the partial unique index gives durable users.
	if userID == nil && in.ActorLabel != "" {
		var tenantLock int
		if err := tx.QueryRow(ctx,
			`SELECT 1 FROM tenants WHERE id = $1::uuid FOR UPDATE`, in.TenantID,
		).Scan(&tenantLock); err != nil {
			return nil, false, fmt.Errorf("access_requests: api-key lock: %w", err)
		}
		var existing AccessRequest
		err := tx.QueryRow(ctx, `
SELECT id::text, requested_by::text, COALESCE(requested_by_email, ''),
       COALESCE(actor_label, ''), note, status, created_at, resolved_at
  FROM audit_access_requests
 WHERE tenant_id = $1::uuid
   AND requested_by IS NULL
   AND actor_label = $2
   AND status = 'pending'
 ORDER BY created_at ASC
 LIMIT 1`,
			in.TenantID, in.ActorLabel,
		).Scan(&existing.ID, &existing.UserID, &existing.UserEmail,
			&existing.ActorLabel, &existing.Note, &existing.Status, &existing.CreatedAt,
			&existing.ResolvedAt)
		switch {
		case err == nil:
			if cerr := tx.Commit(ctx); cerr != nil {
				return nil, false, fmt.Errorf("access_requests: commit: %w", cerr)
			}
			return &existing, false, nil
		case errors.Is(err, pgx.ErrNoRows):
			// No pending row for this actor — fall through to insert.
		default:
			return nil, false, fmt.Errorf("access_requests: api-key dedupe: %w", err)
		}
	}

	// Idempotency: ON CONFLICT on the pending-per-user partial unique
	// index. DO NOTHING + re-select keeps the existing row's note and
	// created_at (first ask wins; the owner sees when the user first
	// requested, not when they last mashed the button). API-key
	// callers (requested_by IS NULL) are outside the index; the serialized
	// actor_label-keyed pre-check above is their equivalent dedupe.
	var out AccessRequest
	err = tx.QueryRow(ctx, `
INSERT INTO audit_access_requests
       (tenant_id, requested_by, requested_by_email, actor_label, note)
VALUES ($1::uuid, $2, $3, $4, $5)
ON CONFLICT (tenant_id, requested_by) WHERE status = 'pending' AND requested_by IS NOT NULL
DO NOTHING
RETURNING id::text, requested_by::text, COALESCE(requested_by_email, ''),
          COALESCE(actor_label, ''), note, status, created_at, resolved_at`,
		in.TenantID, userID, nullable(in.UserEmail), nullable(in.ActorLabel), note,
	).Scan(&out.ID, &out.UserID, &out.UserEmail, &out.ActorLabel,
		&out.Note, &out.Status, &out.CreatedAt, &out.ResolvedAt)
	created := true
	if errors.Is(err, pgx.ErrNoRows) {
		// Conflict path — fetch the existing pending row.
		created = false
		err = tx.QueryRow(ctx, `
SELECT id::text, requested_by::text, COALESCE(requested_by_email, ''),
       COALESCE(actor_label, ''), note, status, created_at, resolved_at
  FROM audit_access_requests
 WHERE tenant_id = $1::uuid AND requested_by = $2::uuid AND status = 'pending'`,
			in.TenantID, in.UserID,
		).Scan(&out.ID, &out.UserID, &out.UserEmail, &out.ActorLabel,
			&out.Note, &out.Status, &out.CreatedAt, &out.ResolvedAt)
	}
	if err != nil {
		return nil, false, fmt.Errorf("access_requests: insert: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, false, fmt.Errorf("access_requests: commit: %w", err)
	}
	return &out, created, nil
}

// ListAccessRequests returns the tenant's requests newest-first.
// status filters when non-empty ("pending" is what the owner UI asks
// for); empty returns all statuses for a full history view.
func ListAccessRequests(ctx context.Context, pool *db.Pool, tenantID, status string, limit int) ([]AccessRequest, error) {
	if pool == nil {
		return nil, fmt.Errorf("access_requests: pool is required")
	}
	if tenantID == "" {
		return nil, fmt.Errorf("access_requests: tenant id is required")
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return nil, fmt.Errorf("access_requests: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT id::text, requested_by::text, COALESCE(requested_by_email, ''),
       COALESCE(actor_label, ''), note, status, created_at, resolved_at
  FROM audit_access_requests
 WHERE tenant_id = $1::uuid
   AND ($2 = '' OR status = $2)
 ORDER BY created_at DESC
 LIMIT $3`, tenantID, status, limit)
	if err != nil {
		return nil, fmt.Errorf("access_requests: query: %w", err)
	}
	defer rows.Close()

	out := []AccessRequest{}
	for rows.Next() {
		var ar AccessRequest
		if err := rows.Scan(&ar.ID, &ar.UserID, &ar.UserEmail, &ar.ActorLabel,
			&ar.Note, &ar.Status, &ar.CreatedAt, &ar.ResolvedAt); err != nil {
			return nil, fmt.Errorf("access_requests: scan: %w", err)
		}
		out = append(out, ar)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("access_requests: rows: %w", err)
	}
	return out, nil
}

// nullable maps "" to a SQL NULL so empty identity fields don't store
// empty strings.
func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
