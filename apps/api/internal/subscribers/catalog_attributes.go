package subscribers

// SUB-013 — catalog-linked profile attributes.
//
// favorite_category / last_viewed_sku are catalog-derived signals stored
// as subscriber_computed_traits rows (table 0324) under two well-known
// keys. A commerce worker (internal/commerce/catalog_attributes.go)
// aggregates them from commerce_events; this file is the read/write API
// surface over those two specific traits, so the slideover can show a
// favorite-category histogram + last-viewed SKU without the operator
// hand-maintaining computed traits.
//
// No new table: the two keys live in subscriber_computed_traits alongside
// every other computed trait. We deliberately constrain this endpoint to
// exactly the two catalog keys so a typo can't scribble an arbitrary
// trait through the catalog surface.

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Catalog-trait keys. These are the ONLY keys this endpoint reads/writes.
const (
	TraitFavoriteCategory = "favorite_category"
	TraitLastViewedSKU    = "last_viewed_sku"
)

// CatalogAttributes is the structured read response. Each field is the raw
// computed-trait value (nil when the trait has never been computed for
// this subscriber). FavoriteCategory is JSON-shaped
// ({category, count, timestamp}); LastViewedSKU is a string.
type CatalogAttributes struct {
	SubscriberID     string     `json:"subscriber_id"`
	FavoriteCategory any        `json:"favorite_category"`
	LastViewedSKU    any        `json:"last_viewed_sku"`
	ComputedAt       *time.Time `json:"computed_at,omitempty"`
}

// CatalogAttributesInput is the PATCH body. Both fields are optional; a
// non-nil field upserts the corresponding trait. FavoriteCategory is
// stored value_type=json, LastViewedSKU value_type=string.
type CatalogAttributesInput struct {
	FavoriteCategory any     `json:"favorite_category"`
	LastViewedSKU    *string `json:"last_viewed_sku"`
}

// GetCatalogAttributes reads the two catalog traits for a subscriber.
// Returns ErrNotFound when the subscriber does not exist. Absent traits
// surface as nil fields rather than an error (the subscriber simply has no
// catalog history yet).
func (r *Repo) GetCatalogAttributes(ctx context.Context, tenantID, subscriberID string) (*CatalogAttributes, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	out := &CatalogAttributes{SubscriberID: sub.ID}
	rows, err := tx.Query(ctx, `
SELECT key, value, computed_at
  FROM subscriber_computed_traits
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND key IN ($3, $4)`,
		tenantID, sub.ID, TraitFavoriteCategory, TraitLastViewedSKU)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		var valueRaw []byte
		var computedAt time.Time
		if err := rows.Scan(&key, &valueRaw, &computedAt); err != nil {
			return nil, err
		}
		v := decodeTraitValue(valueRaw)
		switch key {
		case TraitFavoriteCategory:
			out.FavoriteCategory = v
		case TraitLastViewedSKU:
			out.LastViewedSKU = v
		}
		// Surface the most recent computed_at across the two traits.
		if out.ComputedAt == nil || computedAt.After(*out.ComputedAt) {
			t := computedAt
			out.ComputedAt = &t
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// SetCatalogAttributes upserts whichever of the two catalog traits are
// present in the input, reusing the shared UpsertTrait path so the
// computed-traits invariants (value_type CHECK, source CHECK) are
// enforced once. source is fixed to "model" — these are derived signals,
// not operator-entered values. Returns the refreshed read view.
func (r *Repo) SetCatalogAttributes(ctx context.Context, tenantID, subscriberID string, in CatalogAttributesInput) (*CatalogAttributes, error) {
	if in.FavoriteCategory != nil {
		if _, err := r.UpsertTrait(ctx, tenantID, subscriberID, TraitFavoriteCategory, TraitInput{
			Value:     in.FavoriteCategory,
			ValueType: "json",
			Source:    "model",
		}); err != nil {
			return nil, err
		}
	}
	if in.LastViewedSKU != nil {
		if _, err := r.UpsertTrait(ctx, tenantID, subscriberID, TraitLastViewedSKU, TraitInput{
			Value:     *in.LastViewedSKU,
			ValueType: "string",
			Source:    "model",
		}); err != nil {
			return nil, err
		}
	}
	return r.GetCatalogAttributes(ctx, tenantID, subscriberID)
}

// decodeTraitValue unmarshals a trait's jsonb value into a Go any. A nil /
// empty / literal-null blob decodes to nil.
func decodeTraitValue(raw []byte) any {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil
	}
	return v
}

// MountCatalogAttributesRoutes registers the catalog-attributes read/write
// endpoints. GET is read-scoped, PATCH is write-scoped.
func MountCatalogAttributesRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/catalog-attributes", d.GetCatalogAttributes)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Patch("/api/v1/subscribers/{id}/catalog-attributes", d.SetCatalogAttributes)
}

// GetCatalogAttributes GET /api/v1/subscribers/{id}/catalog-attributes
func (d *Deps) GetCatalogAttributes(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetCatalogAttributes(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// SetCatalogAttributes PATCH /api/v1/subscribers/{id}/catalog-attributes
func (d *Deps) SetCatalogAttributes(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in CatalogAttributesInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.FavoriteCategory == nil && in.LastViewedSKU == nil {
		httperror.WriteValidation(w, "validation_failed",
			"at least one of favorite_category or last_viewed_sku is required")
		return
	}
	out, err := d.Repo.SetCatalogAttributes(r.Context(), t.ID, chi.URLParam(r, "id"), in)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	d.emit(t.ID, "subscriber.catalog_attributes.updated", map[string]any{"id": out.SubscriberID})
	writeJSON(w, http.StatusOK, out)
}
