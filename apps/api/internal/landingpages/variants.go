// SPDX-License-Identifier: AGPL-3.0-only
package landingpages

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Variant is one A/B arm of a landing page (LAND-037). Its blocks override the
// page's own content when served; weight is the relative traffic share.
type Variant struct {
	ID        string           `json:"id"`
	PageID    string           `json:"page_id"`
	Name      string           `json:"name"`
	Weight    int              `json:"weight"`
	Blocks    []map[string]any `json:"blocks"`
	IsControl bool             `json:"is_control"`
	CreatedAt time.Time        `json:"created_at"`
	UpdatedAt time.Time        `json:"updated_at"`
	// Per-variant metrics (LAND-037), populated by ListVariants. ConversionRate
	// is conversions/views in [0,1]; 0 when no views yet.
	Views          int64   `json:"views"`
	Conversions    int64   `json:"conversions"`
	ConversionRate float64 `json:"conversion_rate"`
}

// VariantInput is the create/update body. Pointers on update = leave unchanged.
type VariantInput struct {
	Name      string           `json:"name"`
	Weight    *int             `json:"weight,omitempty"`
	Blocks    []map[string]any `json:"blocks,omitempty"`
	IsControl *bool            `json:"is_control,omitempty"`
}

const maxVariantWeight = 1_000_000

// lockPageForTenant confirms the page is visible to the tenant AND takes a
// row lock on it, inside tx. Two reasons:
//  1. landing_page_variants.page_id is a single-column FK, and Postgres FK
//     checks bypass RLS — so without the tenant-scoped SELECT a tenant could
//     file a variant under another tenant's page id (RLS returns no row here).
//  2. FOR UPDATE serializes concurrent variant mutations on the same page, so
//     the "at most one control" invariant (demote-others-then-set-self) can't
//     be raced into two controls by concurrent writers.
func lockPageForTenant(ctx context.Context, tx pgx.Tx, pageID string) (bool, error) {
	var id string
	err := tx.QueryRow(ctx,
		`SELECT id::text FROM landing_pages WHERE id::text = $1 FOR UPDATE`, pageID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// ListVariants returns a page's variants with per-variant view/conversion
// counts. Control-first, then oldest-first.
func (r *Repo) ListVariants(ctx context.Context, tenantID, pageID string) ([]Variant, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT v.id::text, v.page_id::text, v.name, v.weight, v.blocks, v.is_control,
       v.created_at, v.updated_at,
       COALESCE(m.views, 0), COALESCE(m.conversions, 0)
  FROM landing_page_variants v
  LEFT JOIN (
      SELECT variant_id,
             count(*) FILTER (WHERE event_type = 'view')       AS views,
             count(*) FILTER (WHERE event_type = 'conversion')  AS conversions
        FROM growth_surface_events
       WHERE tenant_id = $1::uuid AND surface_type = 'landing_page'
         AND surface_id::text = $2 AND variant_id IS NOT NULL
       GROUP BY variant_id
  ) m ON m.variant_id = v.id
 WHERE v.tenant_id = $1::uuid AND v.page_id::text = $2
 ORDER BY v.is_control DESC, v.created_at ASC`, tenantID, pageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Variant{}
	for rows.Next() {
		v, err := scanVariant(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *v)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// CreateVariant adds a variant to the page. Rejects a foreign/unknown page id.
func (r *Repo) CreateVariant(ctx context.Context, tenantID, pageID string, in VariantInput) (*Variant, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	ok, err := lockPageForTenant(ctx, tx, pageID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrNotFound
	}

	weight := 1
	if in.Weight != nil {
		weight = clampWeight(*in.Weight)
	}
	isControl := in.IsControl != nil && *in.IsControl
	blocksJSON, _ := json.Marshal(nilSlice(in.Blocks))

	// A page has at most one control — demote the others when this one claims it.
	if isControl {
		if _, err := tx.Exec(ctx,
			`UPDATE landing_page_variants SET is_control = false WHERE page_id::text = $1`, pageID); err != nil {
			return nil, err
		}
	}

	var v Variant
	err = tx.QueryRow(ctx, `
INSERT INTO landing_page_variants (tenant_id, page_id, name, weight, blocks, is_control)
VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6)
RETURNING id::text, page_id::text, name, weight, blocks, is_control, created_at, updated_at`,
		tenantID, pageID, in.Name, weight, string(blocksJSON), isControl).
		Scan(&v.ID, &v.PageID, &v.Name, &v.Weight, &rawBlocks{&v.Blocks}, &v.IsControl, &v.CreatedAt, &v.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &v, tx.Commit(ctx)
}

// UpdateVariant patches a variant. nil fields are left unchanged.
func (r *Repo) UpdateVariant(ctx context.Context, tenantID, pageID, variantID string, in VariantInput) (*Variant, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Lock the page first so a concurrent control change can't race this one
	// into two controls; also rejects a foreign/unknown page id.
	if ok, err := lockPageForTenant(ctx, tx, pageID); err != nil {
		return nil, err
	} else if !ok {
		return nil, ErrNotFound
	}
	// Load current (tenant + page scoped, so a foreign id is a 404).
	cur, err := getVariantTx(ctx, tx, pageID, variantID)
	if err != nil {
		return nil, err
	}
	if in.Name != "" {
		cur.Name = in.Name
	}
	if in.Weight != nil {
		cur.Weight = clampWeight(*in.Weight)
	}
	if in.Blocks != nil {
		cur.Blocks = in.Blocks
	}
	if in.IsControl != nil && *in.IsControl && !cur.IsControl {
		if _, err := tx.Exec(ctx,
			`UPDATE landing_page_variants SET is_control = false WHERE page_id::text = $1`, pageID); err != nil {
			return nil, err
		}
		cur.IsControl = true
	} else if in.IsControl != nil {
		cur.IsControl = *in.IsControl
	}
	blocksJSON, _ := json.Marshal(nilSlice(cur.Blocks))
	err = tx.QueryRow(ctx, `
UPDATE landing_page_variants
   SET name = $3, weight = $4, blocks = $5::jsonb, is_control = $6, updated_at = now()
 WHERE id::text = $1 AND page_id::text = $2
RETURNING id::text, page_id::text, name, weight, blocks, is_control, created_at, updated_at`,
		variantID, pageID, cur.Name, cur.Weight, string(blocksJSON), cur.IsControl).
		Scan(&cur.ID, &cur.PageID, &cur.Name, &cur.Weight, &rawBlocks{&cur.Blocks}, &cur.IsControl, &cur.CreatedAt, &cur.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return cur, tx.Commit(ctx)
}

// DeleteVariant removes a variant. ErrNotFound when it isn't the page's.
func (r *Repo) DeleteVariant(ctx context.Context, tenantID, pageID, variantID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx,
		`DELETE FROM landing_page_variants WHERE id::text = $1 AND page_id::text = $2`, variantID, pageID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func getVariantTx(ctx context.Context, tx pgx.Tx, pageID, variantID string) (*Variant, error) {
	var v Variant
	err := tx.QueryRow(ctx, `
SELECT id::text, page_id::text, name, weight, blocks, is_control, created_at, updated_at
  FROM landing_page_variants WHERE id::text = $1 AND page_id::text = $2`, variantID, pageID).
		Scan(&v.ID, &v.PageID, &v.Name, &v.Weight, &rawBlocks{&v.Blocks}, &v.IsControl, &v.CreatedAt, &v.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &v, nil
}

func scanVariant(row rowScanner) (*Variant, error) {
	var v Variant
	if err := row.Scan(&v.ID, &v.PageID, &v.Name, &v.Weight, &rawBlocks{&v.Blocks},
		&v.IsControl, &v.CreatedAt, &v.UpdatedAt, &v.Views, &v.Conversions); err != nil {
		return nil, err
	}
	if v.Views > 0 {
		v.ConversionRate = float64(v.Conversions) / float64(v.Views)
	}
	if v.Blocks == nil {
		v.Blocks = []map[string]any{}
	}
	return &v, nil
}

func clampWeight(w int) int {
	if w < 0 {
		return 0
	}
	if w > maxVariantWeight {
		return maxVariantWeight
	}
	return w
}

// rawBlocks unmarshals a jsonb blocks column into []map[string]any during Scan.
type rawBlocks struct{ dst *[]map[string]any }

func (b *rawBlocks) Scan(src any) error {
	if src == nil {
		*b.dst = nil
		return nil
	}
	var raw []byte
	switch v := src.(type) {
	case []byte:
		raw = v
	case string:
		raw = []byte(v)
	default:
		return errors.New("landingpages: unexpected blocks type")
	}
	if len(raw) == 0 {
		*b.dst = nil
		return nil
	}
	return json.Unmarshal(raw, b.dst)
}

/* ------------------------------- handlers -------------------------------- */

// ListVariantsHandler GET /api/v1/landing-pages/{id}/variants — variants with
// per-variant view/conversion metrics.
func (d *Deps) ListVariantsHandler(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := d.Repo.ListVariants(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

// CreateVariantHandler POST /api/v1/landing-pages/{id}/variants
func (d *Deps) CreateVariantHandler(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	pageID := chi.URLParam(r, "id")
	var in VariantInput
	if err := httpbody.DecodeJSON(w, r, landingPageJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	v, err := d.Repo.CreateVariant(r.Context(), t.ID, pageID, in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "landing page not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	d.emitAudit(r, t.ID, "landing_page.variant.create", pageID, map[string]any{"variant_id": v.ID, "name": v.Name})
	writeJSON(w, http.StatusCreated, v)
}

// UpdateVariantHandler PATCH /api/v1/landing-pages/{id}/variants/{variant_id}
func (d *Deps) UpdateVariantHandler(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	pageID := chi.URLParam(r, "id")
	variantID := chi.URLParam(r, "variant_id")
	var in VariantInput
	if err := httpbody.DecodeJSON(w, r, landingPageJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	v, err := d.Repo.UpdateVariant(r.Context(), t.ID, pageID, variantID, in)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "variant not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	d.emitAudit(r, t.ID, "landing_page.variant.update", pageID, map[string]any{"variant_id": v.ID})
	writeJSON(w, http.StatusOK, v)
}

// DeleteVariantHandler DELETE /api/v1/landing-pages/{id}/variants/{variant_id}
func (d *Deps) DeleteVariantHandler(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	pageID := chi.URLParam(r, "id")
	variantID := chi.URLParam(r, "variant_id")
	if err := d.Repo.DeleteVariant(r.Context(), t.ID, pageID, variantID); err != nil {
		if errors.Is(err, ErrNotFound) {
			httperror.Write(w, http.StatusNotFound, "not_found", "variant not found")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	d.emitAudit(r, t.ID, "landing_page.variant.delete", pageID, map[string]any{"variant_id": variantID})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
