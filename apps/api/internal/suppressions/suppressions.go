// Package suppressions owns the tenant-scoped suppression list. The send
// pipeline must consult it before any outbound message; routes here let
// agents and the dashboard add addresses one-by-one or in bulk.
package suppressions

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type Suppression struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Reason    string    `json:"reason,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

type Repo struct {
	Pool *db.Pool
}

// List returns the tenant's suppressions newest-first. When q is non-empty
// it filters by email substring (case-insensitive ILIKE). limit is capped
// at 200 (default 50). offset paginates.
func (r *Repo) List(ctx context.Context, tenantID, q string, limit, offset int) ([]Suppression, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	if offset < 0 {
		offset = 0
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Read from email_suppressions — the table the Suppressions page lists,
	// the single-add path writes, and bulk/import now write (D05#1). This
	// used to read the legacy `suppressions` table, so the CSV export
	// streamed a different (now-empty) table than the page shows (D05#3).
	// email_suppressions carries the same id/email/reason/created_at columns.
	rows, err := tx.Query(ctx, `
SELECT id::text, email::text, COALESCE(reason, ''), created_at
FROM email_suppressions
WHERE tenant_id = $1::uuid
  AND ($2 = '' OR email ILIKE '%' || $2 || '%')
ORDER BY created_at DESC
LIMIT $3 OFFSET $4`, tenantID, q, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Suppression{}
	for rows.Next() {
		var s Suppression
		if err := rows.Scan(&s.ID, &s.Email, &s.Reason, &s.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) Add(ctx context.Context, tenantID, email, reason string) (*Suppression, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var s Suppression
	err = tx.QueryRow(ctx, `
INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, $3, 'manual', '{}'::jsonb)
ON CONFLICT (tenant_id, email, reason) DO UPDATE
SET suppressed_at = now(), expires_at = NULL
RETURNING id::text, email::text, COALESCE(reason, ''), created_at`,
		tenantID, strings.ToLower(strings.TrimSpace(email)), normalizeBulkReason(reason)).
		Scan(&s.ID, &s.Email, &s.Reason, &s.CreatedAt)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &s, nil
}

// BulkResult reports the outcome of a BulkAdd call.
type BulkResult struct {
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Errors   []string `json:"errors"`
}

// BulkAdd inserts every email in one transaction. Conflicts (already
// suppressed) and invalid rows are counted in Skipped, never aborting the
// import. Returns counts even on partial failure.
func (r *Repo) BulkAdd(ctx context.Context, tenantID string, emails []string, reason string) (*BulkResult, error) {
	out := &BulkResult{Errors: []string{}}
	if len(emails) == 0 {
		return out, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	seen := map[string]struct{}{}
	for _, raw := range emails {
		email := strings.ToLower(strings.TrimSpace(raw))
		if email == "" || !strings.Contains(email, "@") {
			out.Skipped++
			continue
		}
		if _, dup := seen[email]; dup {
			out.Skipped++
			continue
		}
		seen[email] = struct{}{}
		// Write to email_suppressions — the table the Suppressions page
		// list AND the single-add path (subscribers.CreateSuppression) use,
		// and which the send-time converger reads. This used to target the
		// legacy `suppressions` table that nothing on the list or the
		// pre-converger send path consulted, so imports silently vanished
		// from the UI and went unenforced at send (P0 D05#1).
		ct, err := tx.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, $3, 'manual', '{}'::jsonb)
ON CONFLICT (tenant_id, email, reason) DO NOTHING`,
			tenantID, email, normalizeBulkReason(reason))
		if err != nil {
			out.Errors = append(out.Errors, email+": "+err.Error())
			continue
		}
		if ct.RowsAffected() == 0 {
			out.Skipped++
		} else {
			out.Imported++
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

type Deps struct {
	Repo *Repo
	// CanonicalStore makes CSV imports use the same registry as the modern
	// deliverability roster. Nil preserves the legacy adapter composition.
	CanonicalStore *Store
	Audit          *AuditLogger
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// err.Error() server-side with tenant_id+request_id, while the wire
	// envelope stays generic. nil-safe at the httperror call site.
	Logger *slog.Logger
}

const suppressionJSONMaxBodyBytes int64 = 2 << 20 // 2 MiB

// MountLegacyRoutes registers only the retained legacy bulk adapter. The
// canonical POST /api/v1/suppressions owner is subscribers.CreateSuppression;
// keeping that path out of this package makes handler selection independent of
// chi registration order. The scope is enforced here as defense in depth in
// addition to the generated route-authorization manifest.
func (d *Deps) MountLegacyRoutes(r chi.Router) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/suppressions/bulk", d.BulkAdd)
}

type addInput struct {
	Email  string `json:"email"`
	Reason string `json:"reason,omitempty"`
}

func (d *Deps) Add(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	var in addInput
	if err := httpbody.DecodeJSON(w, r, suppressionJSONMaxBodyBytes, &in); err != nil {
		// httpbody error codes (bad_json, payload_too_large) are in the
		// httperror safe-echo allowlist — message text is operator-safe.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.Email == "" {
		httperror.Write(w, http.StatusBadRequest, "missing_field", "email is required")
		return
	}
	s, err := d.Repo.Add(r.Context(), t.ID, in.Email, in.Reason)
	if err != nil {
		// d.Repo.Add wraps pgx errors (WithTenant + QueryRow). Their
		// text can leak SQL/db internals; route through the generic
		// 5xx envelope with server-side logging.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, s)
}

type bulkInput struct {
	Emails []string `json:"emails"`
	Reason string   `json:"reason,omitempty"`
}

func (d *Deps) BulkAdd(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant context missing")
		return
	}
	var in bulkInput
	if err := httpbody.DecodeJSON(w, r, suppressionJSONMaxBodyBytes, &in); err != nil {
		// httpbody error codes (bad_json, payload_too_large) are in the
		// httperror safe-echo allowlist — message text is operator-safe.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if len(in.Emails) > 50000 {
		httperror.Write(w, http.StatusRequestEntityTooLarge, "too_many", "max 50000 per request")
		return
	}
	res, err := d.Repo.BulkAdd(r.Context(), t.ID, in.Emails, in.Reason)
	if err != nil {
		// d.Repo.BulkAdd wraps pgx errors (WithTenant + Commit). Their
		// text can leak SQL/db internals; route through the generic
		// 5xx envelope with server-side logging.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// normalizeBulkReason maps a free-text bulk-import reason onto the
// email_suppressions reason enum (migration 0030 + SUB-047/048), which
// carries a CHECK constraint. Anything unrecognized (including empty or
// UI placeholder text like "imported list") collapses to "imported" so
// a bulk write never fails the enum check.
func normalizeBulkReason(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "hard_bounce", "bounce", "hardbounce", "hard-bounce":
		return "hard_bounce"
	case "soft_bounce", "softbounce", "soft-bounce", "transient":
		return "soft_bounce"
	case "complaint", "spam_complaint", "spam", "fbl":
		return "complaint"
	case "unsubscribe", "manual_unsubscribe", "one_click":
		return "unsubscribe"
	case "list_unsub_header", "list_unsubscribe_header", "list_unsubscribe",
		"list-unsubscribe", "rfc8058":
		return "list_unsub_header"
	case "manual":
		return "manual"
	case "spamtrap", "spam_trap", "honeypot", "trap":
		return "spamtrap"
	case "role_account", "role-account", "role":
		return "role_account"
	case "invalid_address", "invalid", "bad_address":
		return "invalid_address"
	default:
		return "imported"
	}
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
