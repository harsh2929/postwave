package subscribers

// SUB-063 — Predicted gender / demographic inference.
//
// Confidence-labelled inferred demographics (gender, age group, interests)
// stored as subscriber_computed_traits rows (table 0324) under the well-known
// inferred_* keys. An optional predictor wired onto Repo.Demographics infers
// them on Upsert; this file is the read/write API surface over those traits,
// so the slideover can render a confidence meter and a flow / segment can
// reference an inferred demographic without the operator hand-maintaining
// computed traits.
//
// No new table: the inferred_* keys live in subscriber_computed_traits
// alongside every other computed trait, and each carries the model confidence
// in the existing confidence column. We constrain the write surface to exactly
// the three inferred_* keys so a typo can't scribble an arbitrary trait
// through the demographics path. Mirrors catalog_attributes.go (SUB-013).

import (
	"context"
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

// Demographic-trait keys. These are the ONLY keys this surface reads/writes.
const (
	TraitInferredGender    = "inferred_gender"
	TraitInferredAgeGroup  = "inferred_age_group"
	TraitInferredInterests = "inferred_interests"
)

// demographicTraitKeys is the fixed set the PUT route accepts via the
// {key}-style write endpoints. Maps the URL key to its computed-trait
// value_type.
var demographicTraitKeys = map[string]string{
	TraitInferredGender:    "string",
	TraitInferredAgeGroup:  "string",
	TraitInferredInterests: "json",
}

// DemographicTrait is one confidence-labelled inferred demographic.
type DemographicTrait struct {
	Value      any        `json:"value"`
	Confidence *float64   `json:"confidence,omitempty"`
	Source     string     `json:"source,omitempty"`
	ComputedAt *time.Time `json:"computed_at,omitempty"`
}

// Demographics is the composite read response: the three inferred demographics
// with their confidence labels. A field is nil when never inferred.
type Demographics struct {
	SubscriberID string            `json:"subscriber_id"`
	Gender       *DemographicTrait `json:"gender"`
	AgeGroup     *DemographicTrait `json:"age_group"`
	Interests    *DemographicTrait `json:"interests"`
}

// HasAny reports whether at least one demographic was inferred.
func (d *Demographics) HasAny() bool {
	return d != nil && (d.Gender != nil || d.AgeGroup != nil || d.Interests != nil)
}

// InferredDemographicInput is the PUT body for a single inferred demographic.
// Value is required; Confidence is optional (clamped to [0,1] by UpsertTrait).
type InferredDemographicInput struct {
	Value      any      `json:"value"`
	Confidence *float64 `json:"confidence,omitempty"`
}

// GetDemographics reads the three demographic traits for a subscriber.
// Returns ErrNotFound when the subscriber does not exist. Absent traits
// surface as nil fields rather than an error.
func (r *Repo) GetDemographics(ctx context.Context, tenantID, subscriberID string) (*Demographics, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	out := &Demographics{SubscriberID: sub.ID}
	rows, err := tx.Query(ctx, `
SELECT key, value, confidence::float8, source, computed_at
  FROM subscriber_computed_traits
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND key IN ($3, $4, $5)`,
		tenantID, sub.ID, TraitInferredGender, TraitInferredAgeGroup, TraitInferredInterests)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		var valueRaw []byte
		var conf *float64
		var source string
		var computedAt time.Time
		if err := rows.Scan(&key, &valueRaw, &conf, &source, &computedAt); err != nil {
			return nil, err
		}
		t := computedAt.UTC()
		trait := &DemographicTrait{
			Value:      decodeTraitValue(valueRaw),
			Confidence: conf,
			Source:     source,
			ComputedAt: &t,
		}
		switch key {
		case TraitInferredGender:
			out.Gender = trait
		case TraitInferredAgeGroup:
			out.AgeGroup = trait
		case TraitInferredInterests:
			out.Interests = trait
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// hydrateDemographics attaches the SUB-063 inferred-demographics projection
// onto a subscriber for the detail GET. Best-effort: a read failure returns
// the error so the caller can log it, but the caller does not fail the GET on
// it. Only attaches when at least one demographic was inferred.
func (r *Repo) hydrateDemographics(ctx context.Context, tenantID string, sub *Subscriber) error {
	demo, err := r.GetDemographics(ctx, tenantID, sub.ID)
	if err != nil {
		return err
	}
	if demo.HasAny() {
		sub.Demographics = demo
	}
	return nil
}

// applyDemographicInference runs the wired predictor over a subscriber's name
// and upserts the inferred_* traits (with confidence) onto
// subscriber_computed_traits. nil-predictor-safe (no-op). Called from the
// Upsert path; failures are surfaced so the caller can log best-effort.
func (r *Repo) applyDemographicInference(ctx context.Context, tenantID, subscriberID, name string) error {
	if r == nil || r.Demographics == nil {
		return nil
	}
	first, full := splitName(name)
	pred, ok := r.Demographics.PredictDemographics(first, full)
	if !ok {
		return nil
	}
	if pred.Gender != "" && !strings.EqualFold(pred.Gender, "unknown") {
		conf := pred.GenderConfidence
		if _, err := r.UpsertTrait(ctx, tenantID, subscriberID, TraitInferredGender, TraitInput{
			Value:      pred.Gender,
			ValueType:  "string",
			Source:     "model",
			Confidence: &conf,
		}); err != nil {
			return err
		}
	}
	if pred.AgeGroup != "" {
		conf := pred.AgeGroupConfidence
		if _, err := r.UpsertTrait(ctx, tenantID, subscriberID, TraitInferredAgeGroup, TraitInput{
			Value:      pred.AgeGroup,
			ValueType:  "string",
			Source:     "model",
			Confidence: &conf,
		}); err != nil {
			return err
		}
	}
	if len(pred.Interests) > 0 {
		conf := pred.InterestsConfidence
		if _, err := r.UpsertTrait(ctx, tenantID, subscriberID, TraitInferredInterests, TraitInput{
			Value:      pred.Interests,
			ValueType:  "json",
			Source:     "model",
			Confidence: &conf,
		}); err != nil {
			return err
		}
	}
	return nil
}

// splitName derives (first, full) from a single display name. first is the
// leading whitespace-delimited token; full is the trimmed whole.
func splitName(name string) (first, full string) {
	full = strings.TrimSpace(name)
	if full == "" {
		return "", ""
	}
	if i := strings.IndexAny(full, " \t"); i >= 0 {
		first = full[:i]
	} else {
		first = full
	}
	return first, full
}

// MountDemographicsRoutes registers the SUB-063 read/write endpoints. GET is
// read-scoped; the per-key PUTs are write-scoped and route through the shared
// trait-upsert path constrained to the three inferred_* keys.
func MountDemographicsRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/demographics", d.GetDemographics)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Put("/api/v1/subscribers/{id}/traits/inferred_gender", d.upsertDemographicTrait(TraitInferredGender))
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Put("/api/v1/subscribers/{id}/traits/inferred_age_group", d.upsertDemographicTrait(TraitInferredAgeGroup))
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Put("/api/v1/subscribers/{id}/traits/inferred_interests", d.upsertDemographicTrait(TraitInferredInterests))
}

// GetDemographics GET /api/v1/subscribers/{id}/demographics
func (d *Deps) GetDemographics(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetDemographics(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// upsertDemographicTrait returns the PUT handler bound to one fixed inferred_*
// key. PUT /api/v1/subscribers/{id}/traits/inferred_{gender,age_group,interests}
func (d *Deps) upsertDemographicTrait(key string) http.HandlerFunc {
	valueType := demographicTraitKeys[key]
	return func(w http.ResponseWriter, r *http.Request) {
		t, ok := middleware.TenantFromContext(r.Context())
		if !ok {
			writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
			return
		}
		var in InferredDemographicInput
		if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
			httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
			return
		}
		if in.Value == nil {
			httperror.WriteValidation(w, "validation_failed", "value is required")
			return
		}
		out, err := d.Repo.UpsertTrait(r.Context(), t.ID, chi.URLParam(r, "id"), key, TraitInput{
			Value:      in.Value,
			ValueType:  valueType,
			Source:     "model",
			Confidence: in.Confidence,
		})
		if err != nil {
			d.writeRepoErr(w, r, err)
			return
		}
		d.emit(t.ID, "subscriber.demographics.updated", map[string]any{
			"id":  out.SubscriberID,
			"key": key,
		})
		writeJSON(w, http.StatusOK, out)
	}
}
