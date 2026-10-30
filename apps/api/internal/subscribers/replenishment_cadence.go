package subscribers

// SUB-061 — Expected Date of Next Order per profile (replenishment cadence).
//
// average_days_between_orders / expected_next_order_at / last_order_at are
// replenishment-cadence signals stored as subscriber_computed_traits rows
// (table 0324) under three well-known keys. A commerce worker
// (internal/commerce/replenishment_cadence_analyzer.go) computes them from
// commerce_orders as order events arrive; this file is the read/write API
// surface over those three specific traits, so the slideover can show a
// "next order expected" projection and a flow / segment can reference the
// cadence without the operator hand-maintaining computed traits.
//
// No new table: the three keys live in subscriber_computed_traits alongside
// every other computed trait (mirrors catalog_attributes.go, SUB-013). We
// deliberately constrain this endpoint to exactly the three cadence keys so
// a typo can't scribble an arbitrary trait through the cadence surface.

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

// Cadence-trait keys. These are the ONLY keys this endpoint reads/writes.
const (
	TraitAverageDaysBetweenOrders = "average_days_between_orders"
	TraitExpectedNextOrderAt      = "expected_next_order_at"
	TraitLastOrderAt              = "last_order_at"
)

// ReplenishmentCadence is the structured read response. Each field is the
// decoded computed-trait value, nil when the trait has never been computed
// for this subscriber (the subscriber simply has no order history yet).
type ReplenishmentCadence struct {
	SubscriberID             string     `json:"subscriber_id"`
	AverageDaysBetweenOrders *float64   `json:"average_days_between_orders"`
	ExpectedNextOrderAt      *time.Time `json:"expected_next_order_at"`
	LastOrderAt              *time.Time `json:"last_order_at"`
	ComputedAt               *time.Time `json:"computed_at,omitempty"`
}

// ReplenishmentCadenceInput is the PATCH body. Both supplied fields are
// optional; a non-nil field upserts the corresponding trait. When
// AverageDaysBetweenOrders and LastOrderAt are both present and
// ExpectedNextOrderAt is omitted, the expected date is derived as
// last_order_at + average_days so the operator can patch a cadence without
// hand-computing the projection.
type ReplenishmentCadenceInput struct {
	AverageDaysBetweenOrders *float64   `json:"average_days_between_orders"`
	ExpectedNextOrderAt      *time.Time `json:"expected_next_order_at"`
	LastOrderAt              *time.Time `json:"last_order_at"`
}

// GetReplenishmentCadence reads the three cadence traits for a subscriber.
// Returns ErrNotFound when the subscriber does not exist. Absent traits
// surface as nil fields rather than an error.
func (r *Repo) GetReplenishmentCadence(ctx context.Context, tenantID, subscriberID string) (*ReplenishmentCadence, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	out := &ReplenishmentCadence{SubscriberID: sub.ID}
	rows, err := tx.Query(ctx, `
SELECT key, value, computed_at
  FROM subscriber_computed_traits
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND key IN ($3, $4, $5)`,
		tenantID, sub.ID, TraitAverageDaysBetweenOrders, TraitExpectedNextOrderAt, TraitLastOrderAt)
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
		switch key {
		case TraitAverageDaysBetweenOrders:
			out.AverageDaysBetweenOrders = decodeTraitFloat(valueRaw)
		case TraitExpectedNextOrderAt:
			out.ExpectedNextOrderAt = decodeTraitTime(valueRaw)
		case TraitLastOrderAt:
			out.LastOrderAt = decodeTraitTime(valueRaw)
		}
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

// SetReplenishmentCadence upserts whichever of the three cadence traits are
// present in the input, reusing the shared UpsertTrait path so the
// computed-traits invariants (value_type CHECK, source CHECK) are enforced
// once. source is fixed to "model" — these are derived signals, not
// operator-entered values. When the caller supplies an average + last-order
// date but omits the expected date, it is derived as
// last_order_at + average_days. Returns the refreshed read view.
func (r *Repo) SetReplenishmentCadence(ctx context.Context, tenantID, subscriberID string, in ReplenishmentCadenceInput) (*ReplenishmentCadence, error) {
	// Derive the expected date when the operator gave us enough to project it.
	if in.ExpectedNextOrderAt == nil && in.AverageDaysBetweenOrders != nil && in.LastOrderAt != nil {
		next := ProjectNextOrder(*in.LastOrderAt, *in.AverageDaysBetweenOrders)
		in.ExpectedNextOrderAt = &next
	}
	if in.AverageDaysBetweenOrders != nil {
		if _, err := r.UpsertTrait(ctx, tenantID, subscriberID, TraitAverageDaysBetweenOrders, TraitInput{
			Value:     *in.AverageDaysBetweenOrders,
			ValueType: "number",
			Source:    "model",
		}); err != nil {
			return nil, err
		}
	}
	if in.LastOrderAt != nil {
		if _, err := r.UpsertTrait(ctx, tenantID, subscriberID, TraitLastOrderAt, TraitInput{
			Value:     in.LastOrderAt.UTC().Format(time.RFC3339),
			ValueType: "datetime",
			Source:    "model",
		}); err != nil {
			return nil, err
		}
	}
	if in.ExpectedNextOrderAt != nil {
		if _, err := r.UpsertTrait(ctx, tenantID, subscriberID, TraitExpectedNextOrderAt, TraitInput{
			Value:     in.ExpectedNextOrderAt.UTC().Format(time.RFC3339),
			ValueType: "datetime",
			Source:    "model",
		}); err != nil {
			return nil, err
		}
	}
	return r.GetReplenishmentCadence(ctx, tenantID, subscriberID)
}

// ProjectNextOrder returns last + averageDays, the expected-next-order
// projection. Exported so the commerce worker derives the date the same way
// the PATCH surface does. A non-positive averageDays yields last unchanged
// (no meaningful projection from a degenerate cadence).
func ProjectNextOrder(last time.Time, averageDays float64) time.Time {
	if averageDays <= 0 {
		return last.UTC()
	}
	return last.UTC().Add(time.Duration(averageDays * float64(24*time.Hour)))
}

// decodeTraitFloat decodes a numeric computed-trait value into *float64. A
// nil/empty/non-numeric blob decodes to nil.
func decodeTraitFloat(raw []byte) *float64 {
	v := decodeTraitValue(raw)
	switch n := v.(type) {
	case float64:
		return &n
	case json.Number:
		if f, err := n.Float64(); err == nil {
			return &f
		}
	}
	return nil
}

// decodeTraitTime decodes a datetime computed-trait value (stored as an
// RFC3339 string) into *time.Time. A nil/empty/unparseable blob decodes to
// nil.
func decodeTraitTime(raw []byte) *time.Time {
	v := decodeTraitValue(raw)
	s, ok := v.(string)
	if !ok || s == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339} {
		if t, err := time.Parse(layout, s); err == nil {
			u := t.UTC()
			return &u
		}
	}
	return nil
}

// MountReplenishmentCadenceRoutes registers the replenishment-cadence
// read/write endpoints. GET is read-scoped, PATCH is write-scoped.
func MountReplenishmentCadenceRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/replenishment-cadence", d.GetReplenishmentCadence)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Patch("/api/v1/subscribers/{id}/replenishment-cadence", d.SetReplenishmentCadence)
}

// GetReplenishmentCadence GET /api/v1/subscribers/{id}/replenishment-cadence
func (d *Deps) GetReplenishmentCadence(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetReplenishmentCadence(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// SetReplenishmentCadence PATCH /api/v1/subscribers/{id}/replenishment-cadence
func (d *Deps) SetReplenishmentCadence(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in ReplenishmentCadenceInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.AverageDaysBetweenOrders == nil && in.ExpectedNextOrderAt == nil && in.LastOrderAt == nil {
		httperror.WriteValidation(w, "validation_failed",
			"at least one of average_days_between_orders, expected_next_order_at or last_order_at is required")
		return
	}
	if in.AverageDaysBetweenOrders != nil && *in.AverageDaysBetweenOrders < 0 {
		httperror.WriteValidation(w, "validation_failed",
			"average_days_between_orders must be >= 0")
		return
	}
	out, err := d.Repo.SetReplenishmentCadence(r.Context(), t.ID, chi.URLParam(r, "id"), in)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	d.emit(t.ID, "subscriber.replenishment_cadence.updated", map[string]any{"id": out.SubscriberID})
	writeJSON(w, http.StatusOK, out)
}
