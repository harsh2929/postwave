// SPDX-License-Identifier: AGPL-3.0-only
package referrals

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// errVariantKeyRequired is a typed sentinel so the HTTP layer can safely
// echo a known-stable message back to callers (no pgx text leaks).
var errVariantKeyRequired = errors.New("variant_key required")

type Variant struct {
	ID            string      `json:"id"`
	VariantKey    string      `json:"variant_key"`
	AllocationPct int         `json:"allocation_pct"`
	Milestones    []Milestone `json:"milestones"`
	Active        bool        `json:"active"`
	CreatedAt     time.Time   `json:"created_at"`
	UpdatedAt     time.Time   `json:"updated_at"`
}

// VariantKeyFor deterministically buckets a subscriber into A/B.
// A/B starts as 50/50 control/treatment; the DB allocation model lets
// richer multi-arm routing land without changing existing conversion
// rows, which persist the chosen key.
func VariantKeyFor(subscriberID string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(subscriberID)))
	if sum[0]%2 == 0 {
		return "control"
	}
	return "variant_b"
}

func (r *Repo) ListVariants(ctx context.Context, tenantID string) ([]Variant, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, variant_key, allocation_pct, milestones, active, created_at, updated_at
  FROM referral_program_variants
 WHERE tenant_id = $1::uuid
 ORDER BY variant_key`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Variant{}
	for rows.Next() {
		var v Variant
		var raw []byte
		if err := rows.Scan(&v.ID, &v.VariantKey, &v.AllocationPct, &raw, &v.Active, &v.CreatedAt, &v.UpdatedAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(raw, &v.Milestones)
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) UpsertVariant(ctx context.Context, tenantID string, v Variant) (*Variant, error) {
	key := sanitizeVariantKey(v.VariantKey)
	if key == "" {
		return nil, errVariantKeyRequired
	}
	v.AllocationPct = clampReferralInt(v.AllocationPct, 0, 100)
	for i := range v.Milestones {
		v.Milestones[i].RewardKind = normalizeRewardKind(v.Milestones[i].RewardKind)
	}
	raw, _ := json.Marshal(v.Milestones)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := &Variant{}
	var milestones []byte
	row := tx.QueryRow(ctx, `
INSERT INTO referral_program_variants
    (tenant_id, variant_key, allocation_pct, milestones, active)
VALUES ($1::uuid, $2, $3, $4::jsonb, $5)
ON CONFLICT (tenant_id, variant_key) DO UPDATE SET
    allocation_pct = EXCLUDED.allocation_pct,
    milestones = EXCLUDED.milestones,
    active = EXCLUDED.active,
    updated_at = now()
RETURNING id::text, variant_key, allocation_pct, milestones, active, created_at, updated_at`,
		tenantID, key, v.AllocationPct, string(raw), v.Active)
	if err := row.Scan(&out.ID, &out.VariantKey, &out.AllocationPct, &milestones, &out.Active, &out.CreatedAt, &out.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(milestones, &out.Milestones)
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) DeleteVariant(ctx context.Context, tenantID, key string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM referral_program_variants
 WHERE tenant_id = $1::uuid AND variant_key = $2`, tenantID, sanitizeVariantKey(key))
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return pgx.ErrNoRows
	}
	return tx.Commit(ctx)
}

func (d *Deps) ListVariants(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	items, err := d.Repo.ListVariants(r.Context(), t.ID)
	if err != nil {
		// db/pgx errors may embed query text; route through WriteInternal
		// so the generic envelope ships and the detail lands in the log.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (d *Deps) UpsertVariant(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in Variant
	if err := httpbody.DecodeJSON(w, r, referralJSONMaxBodyBytes, &in); err != nil {
		// httpbody returns operator-safe codes (bad_json / payload_too_large)
		// and the error text is authored by httpbody itself — safe to echo.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.UpsertVariant(r.Context(), t.ID, in)
	if err != nil {
		// errVariantKeyRequired is a typed sentinel with a stable, hand-
		// authored message — safe to echo. Everything else (pgx, db) may
		// embed query/driver text, so route through WriteInternal.
		if errors.Is(err, errVariantKeyRequired) {
			httperror.WriteValidation(w, "save_failed", "request could not be processed")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) DeleteVariant(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	if err := d.Repo.DeleteVariant(r.Context(), t.ID, chi.URLParam(r, "key")); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		// db/pgx errors may embed query text; route through WriteInternal.
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func sanitizeVariantKey(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	if len(s) > 64 {
		s = s[:64]
	}
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' {
			b.WriteRune(r)
		}
	}
	return b.String()
}
