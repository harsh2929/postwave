// SPDX-License-Identifier: AGPL-3.0-only
//
// tiers.go — CRUD over `paywall_tiers` (gap feature
// `archive-paywall-integration`).
//
// The publish slideover binds a campaign's `archive_paywall_tier_id` to
// one of the tenant's named tiers. This file owns the list/upsert/
// soft-delete API surfaced under `/api/v1/paywall/tiers`. Resolution
// of "is the visitor in this tier?" lives in paywall.go's
// `AllowedForTier` so the archive PublicGet path can call it through
// the existing paywall.Repo dependency.
//
// Soft-delete is preferred over DELETE because campaigns reference
// tier ids — hard-deleting would sever the binding even though the
// migration's ON DELETE SET NULL keeps the campaigns row valid. Soft
// delete (`active=false`) hides the tier from the picker while
// preserving any historical references for analytics drilldowns.

package paywall

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	// MaxTierReadRows is the complete-result ceiling for the supporting tier
	// registry read used by retention-offer admin surfaces. ListTiers requests
	// one extra row to detect overflow and never returns a partial registry.
	MaxTierReadRows = 1000
	// MaxTierNameBytes matches the strict client tier-name ceiling.
	MaxTierNameBytes = 1000
	// MaxTierDescriptionBytes matches the strict client description ceiling.
	MaxTierDescriptionBytes = 10000
	// MaxTierProviderReferenceBytes bounds the stored Stripe price reference.
	MaxTierProviderReferenceBytes = 512
)

// Tier is the wire shape returned by GET /api/v1/paywall/tiers.
type Tier struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Description   string    `json:"description,omitempty"`
	StripePriceID string    `json:"stripePriceId,omitempty"`
	Active        bool      `json:"active"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

// TierInput is the wire shape accepted by POST /api/v1/paywall/tiers.
// `ID` is optional — supplied for updates, omitted for inserts.
type TierInput struct {
	ID            string `json:"id,omitempty"`
	Name          string `json:"name"`
	Description   string `json:"description,omitempty"`
	StripePriceID string `json:"stripePriceId,omitempty"`
	Active        *bool  `json:"active,omitempty"`
}

var (
	// ErrTierNameRequired is returned when a write attempt omits the name.
	ErrTierNameRequired = errors.New("paywall: tier name required")
	// ErrTierFieldInvalid matches a stored or inbound tier string that cannot
	// be represented by the bounded client contract.
	ErrTierFieldInvalid = errors.New("paywall: tier field violates the bounded wire contract")
	// ErrTierReadSetTooLarge supports stable errors.Is matching for an
	// oversized complete tier registry.
	ErrTierReadSetTooLarge = errors.New("paywall: tier result set exceeds read limit")
)

// TierFieldError identifies the offending field and public byte ceiling but
// never retains the rejected value.
type TierFieldError struct {
	Field    string
	MaxBytes int
}

func (e *TierFieldError) Error() string {
	return fmt.Sprintf("paywall: %s must be a trimmed safe UTF-8 string of at most %d bytes", e.Field, e.MaxBytes)
}

func (e *TierFieldError) Unwrap() error { return ErrTierFieldInvalid }

// TierReadSetTooLargeError is returned when the non-paginated tier endpoint
// cannot return a complete result inside MaxTierReadRows.
type TierReadSetTooLargeError struct {
	Limit int
}

func (e *TierReadSetTooLargeError) Error() string {
	return fmt.Sprintf("paywall: tier result exceeds %d rows", e.Limit)
}

func (e *TierReadSetTooLargeError) Unwrap() error { return ErrTierReadSetTooLarge }

func validateTierString(field, value string, maxBytes int) error {
	if value == "" {
		return nil
	}
	if !utf8.ValidString(value) || len(value) > maxBytes || value != strings.TrimSpace(value) {
		return &TierFieldError{Field: field, MaxBytes: maxBytes}
	}
	for _, character := range value {
		if character <= '\u0008' || character == '\u000b' || character == '\u000c' ||
			(character >= '\u000e' && character <= '\u001f') || character == '\u007f' ||
			(character >= '\u202a' && character <= '\u202e') ||
			(character >= '\u2066' && character <= '\u2069') {
			return &TierFieldError{Field: field, MaxBytes: maxBytes}
		}
	}
	return nil
}

func (t *Tier) validateReadProjection() error {
	if err := validateTierString("name", t.Name, MaxTierNameBytes); err != nil {
		return err
	}
	if err := validateTierString("description", t.Description, MaxTierDescriptionBytes); err != nil {
		return err
	}
	return validateTierString("stripe_price_id", t.StripePriceID, MaxTierProviderReferenceBytes)
}

// ListTiers returns the complete tier registry (active + inactive) for the
// tenant, ordered by active DESC, name ASC, when it fits inside
// MaxTierReadRows. Oversized registries return *TierReadSetTooLargeError;
// partial supporting metadata is never returned.
func (r *Repo) ListTiers(ctx context.Context, tenantID string) ([]Tier, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, name,
       COALESCE(description, ''), COALESCE(stripe_price_id, ''),
       active, created_at, updated_at
 FROM paywall_tiers
 WHERE tenant_id = $1::uuid
 ORDER BY active DESC, name ASC
 LIMIT $2`, tenantID, MaxTierReadRows+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Tier{}
	for rows.Next() {
		var t Tier
		if err := rows.Scan(&t.ID, &t.Name, &t.Description, &t.StripePriceID,
			&t.Active, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		if err := t.validateReadProjection(); err != nil {
			return nil, err
		}
		out = append(out, t)
		if len(out) > MaxTierReadRows {
			return nil, &TierReadSetTooLargeError{Limit: MaxTierReadRows}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// UpsertTier creates a new tier or updates an existing one. Empty
// `in.ID` inserts; non-empty updates. Returns the resulting tier id.
func (r *Repo) UpsertTier(ctx context.Context, tenantID string, in TierInput) (string, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return "", ErrTierNameRequired
	}
	description := strings.TrimSpace(in.Description)
	providerReference := strings.TrimSpace(in.StripePriceID)
	if err := validateTierString("name", name, MaxTierNameBytes); err != nil {
		return "", err
	}
	if err := validateTierString("description", description, MaxTierDescriptionBytes); err != nil {
		return "", err
	}
	if err := validateTierString("stripe_price_id", providerReference, MaxTierProviderReferenceBytes); err != nil {
		return "", err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	active := true
	if in.Active != nil {
		active = *in.Active
	}
	var id string
	if strings.TrimSpace(in.ID) == "" {
		err = tx.QueryRow(ctx, `
INSERT INTO paywall_tiers (tenant_id, name, description, stripe_price_id, active)
VALUES ($1::uuid, $2, NULLIF($3, ''), NULLIF($4, ''), $5)
ON CONFLICT (tenant_id, name) DO UPDATE SET
    description     = COALESCE(EXCLUDED.description, paywall_tiers.description),
    stripe_price_id = COALESCE(EXCLUDED.stripe_price_id, paywall_tiers.stripe_price_id),
    active          = EXCLUDED.active,
    updated_at      = now()
RETURNING id::text`,
			tenantID, name, description, providerReference, active).Scan(&id)
		if err != nil {
			return "", err
		}
	} else {
		err = tx.QueryRow(ctx, `
UPDATE paywall_tiers
   SET name            = $3,
       description     = NULLIF($4, ''),
       stripe_price_id = NULLIF($5, ''),
       active          = $6,
       updated_at      = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
 RETURNING id::text`,
			tenantID, in.ID, name, description, providerReference, active).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrNotFound
		}
		if err != nil {
			return "", err
		}
	}
	return id, tx.Commit(ctx)
}

// DeactivateTier soft-deletes a tier by flipping `active=false`. Hard
// delete is avoided to preserve historical bindings on campaigns.
func (r *Repo) DeactivateTier(ctx context.Context, tenantID, id string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
UPDATE paywall_tiers
   SET active = false, updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// ResolveTierName resolves a tier id back to its display name. Used by
// the archive PublicGet path when rendering the paywall CTA card so
// the teaser can say "Subscribe to the Founders tier" without a
// separate lookup. Returns "" when the id is empty or unresolvable.
func (r *Repo) ResolveTierName(ctx context.Context, tenantID, id string) (string, error) {
	if strings.TrimSpace(id) == "" {
		return "", nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var name string
	err = tx.QueryRow(ctx,
		`SELECT name FROM paywall_tiers
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, id).Scan(&name)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", tx.Commit(ctx)
	}
	if err != nil {
		return "", err
	}
	return name, tx.Commit(ctx)
}

// ---------- HTTP ----------

// MountTierRoutes wires the tier CRUD endpoints. Called from the same
// router-mount path that wires List/Grant/Revoke so the surface stays
// in one place.
func (d *Deps) MountTierRoutes(r chi.Router) {
	r.Get("/api/v1/paywall/tiers", d.ListTiers)
	r.Post("/api/v1/paywall/tiers", d.UpsertTier)
	r.Delete("/api/v1/paywall/tiers/{id}", d.DeactivateTier)
}

func (d *Deps) ListTiers(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	out, err := d.Repo.ListTiers(r.Context(), t.ID)
	if err != nil {
		if writeTierReadSetTooLarge(w, err) {
			return
		}
		if writeStoredTierInvalid(w, err) {
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tiers": out})
}

func writeTierReadSetTooLarge(w http.ResponseWriter, err error) bool {
	if !errors.Is(err, ErrTierReadSetTooLarge) {
		return false
	}
	httperror.Write(w, http.StatusConflict, "result_set_too_large",
		"the complete paywall-tier result exceeds the 1000-row API limit; no partial data was returned")
	return true
}

func writeStoredTierInvalid(w http.ResponseWriter, err error) bool {
	if !errors.Is(err, ErrTierFieldInvalid) {
		return false
	}
	httperror.Write(w, http.StatusConflict, "stored_tier_contract_invalid",
		"stored paywall-tier data violates the bounded API contract; no partial data was returned")
	return true
}

func (d *Deps) UpsertTier(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	var in TierInput
	if err := httpbody.DecodeJSON(w, r, paywallJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	id, err := d.Repo.UpsertTier(r.Context(), t.ID, in)
	if err != nil {
		if errors.Is(err, ErrTierNameRequired) {
			httperror.WriteValidation(w, "name_required", err.Error())
			return
		}
		if errors.Is(err, ErrTierFieldInvalid) {
			httperror.WriteValidation(w, "paywall_tier_field_invalid", err.Error())
			return
		}
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "id": id})
}

func (d *Deps) DeactivateTier(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	id := chi.URLParam(r, "id")
	if strings.TrimSpace(id) == "" {
		writeJSON(w, http.StatusBadRequest, errEnv("id_required", ""))
		return
	}
	if err := d.Repo.DeactivateTier(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrNotFound) {
			writeJSON(w, http.StatusNotFound, errEnv("not_found", ""))
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
