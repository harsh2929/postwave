package subscribers

// SUB-010 — predictive-score versioning + explainability metadata.
//
// The subscribers row caches two bare predictive scalars (churn_score /
// engagement_score, migration 0180). Those numbers carry no model lineage:
// an operator looking at a churn score can't tell which model produced it,
// how confident the model was, or which features drove it. Klaviyo attaches
// a model version + confidence + per-feature snapshot to every predictive
// score so the operator gets an explainability ("nutrition-facts") panel.
//
// This file is the read/write API surface over subscriber_prediction_metadata
// (migration 0900): one current snapshot per (subscriber, score_type)
// carrying model_version, confidence, and a jsonb feature snapshot. It keeps
// the heavy ML lineage (subscriber_prediction_runs, 0344) untouched and
// stays a lightweight parallel for the two cached scalars.
//
// Wire surface:
//
//	GET   /api/v1/subscribers/{id}/prediction-metadata   read scope
//	PATCH /api/v1/subscribers/{id}/prediction-metadata   write scope
//
// model_version + confidence are ALSO accepted on the generic
// PATCH /api/v1/subscribers/{id} (handled in handlers.go::Update) and
// hydrated onto the Subscriber on the detail GET so the slideover can show
// the lineage badge without a second round-trip.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// GetPredictionMetadata returns every per-score-type metadata snapshot for
// one subscriber (the version-history surface). Ordered by score_type then
// computed_at DESC so the response is stable. Returns ErrNotFound when the
// subscriber does not exist; an empty Items list when the subscriber exists
// but no model has scored it yet.
func (r *Repo) GetPredictionMetadata(ctx context.Context, tenantID, subscriberID string) (*PredictionMetadataList, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	out := &PredictionMetadataList{SubscriberID: sub.ID, Items: []PredictionMetadata{}}
	rows, err := tx.Query(ctx, `
SELECT id::text, score_type, model_version, confidence, features,
       computed_at, created_at, updated_at
  FROM subscriber_prediction_metadata
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
 ORDER BY score_type ASC, computed_at DESC`, tenantID, sub.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		m, err := scanPredictionMetadata(rows, sub.ID)
		if err != nil {
			return nil, err
		}
		out.Items = append(out.Items, *m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// hydratePredictionLineage reads the current model_version + confidence for
// the detail GET and stamps them onto the subscriber. The churn snapshot
// wins when both churn + engagement metadata exist (churn is the headline
// predictive signal), otherwise engagement. Best-effort: a missing row
// leaves both fields nil so they stay omitted from the response. Runs inside
// its own tenant-scoped tx; the caller's GET is unaffected on failure.
func (r *Repo) hydratePredictionLineage(ctx context.Context, tenantID, subscriberID string, sub *Subscriber) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var version string
	var confidence *float64
	// ORDER BY (score_type = 'churn') DESC picks the churn row first when
	// present, then falls back to whatever else scored this subscriber.
	err = tx.QueryRow(ctx, `
SELECT model_version, confidence
  FROM subscriber_prediction_metadata
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
 ORDER BY (score_type = 'churn') DESC, computed_at DESC
 LIMIT 1`, tenantID, subscriberID).Scan(&version, &confidence)
	if errors.Is(err, pgx.ErrNoRows) {
		return tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	if version != "" {
		v := version
		sub.PredictionModelVersion = &v
	}
	sub.PredictionConfidence = confidence
	return tx.Commit(ctx)
}

// UpsertPredictionMetadata writes (or replaces) the current metadata snapshot
// for one (subscriber, score_type). Reuses the migration-0900 unique
// constraint via INSERT ... ON CONFLICT DO UPDATE so the row stays a single
// current snapshot per score type. ModelVersion defaults to 'heuristic-v1'
// when omitted on first write. Returns the refreshed list view.
func (r *Repo) UpsertPredictionMetadata(ctx context.Context, tenantID, subscriberID string, in UpsertPredictionMetadataInput) (*PredictionMetadataList, error) {
	scoreType := in.ScoreType
	if scoreType == "" {
		scoreType = PredictionScoreChurn
	}
	if !ValidPredictionScoreType(scoreType) {
		return nil, fmt.Errorf("%w: invalid score_type %q", ErrInvalidInput, in.ScoreType)
	}
	if in.Confidence != nil && (*in.Confidence < 0 || *in.Confidence > 1) {
		return nil, fmt.Errorf("%w: confidence must be in [0,1]", ErrInvalidInput)
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sub, err := getInTx(ctx, tx, tenantID, subscriberID)
	if err != nil {
		return nil, err
	}
	modelVersion := "heuristic-v1"
	if in.ModelVersion != nil && *in.ModelVersion != "" {
		modelVersion = *in.ModelVersion
	}
	featuresRaw := []byte("{}")
	if in.Features != nil {
		b, err := json.Marshal(in.Features)
		if err != nil {
			return nil, fmt.Errorf("%w: features not JSON-serialisable", ErrInvalidInput)
		}
		featuresRaw = b
	}
	// The endpoint is PATCH-like: on conflict each optional field changes only
	// when the caller supplied it. On the first insert model_version still gets
	// the documented heuristic-v1 default. This prevents a model-version-only
	// restamp from silently clearing confidence or feature evidence.
	_, err = tx.Exec(ctx, `
INSERT INTO subscriber_prediction_metadata
  (tenant_id, subscriber_id, score_type, model_version, confidence, features, computed_at, updated_at)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::jsonb, now(), now())
ON CONFLICT (tenant_id, subscriber_id, score_type) DO UPDATE
   SET model_version = CASE WHEN $7::boolean THEN EXCLUDED.model_version
                            ELSE subscriber_prediction_metadata.model_version END,
       confidence    = CASE WHEN $8::boolean THEN EXCLUDED.confidence
                            ELSE subscriber_prediction_metadata.confidence END,
       features      = CASE WHEN $9::boolean THEN EXCLUDED.features
                            ELSE subscriber_prediction_metadata.features END,
       computed_at   = now(),
       updated_at    = now()`,
		tenantID, sub.ID, scoreType, modelVersion, in.Confidence, featuresRaw,
		in.ModelVersion != nil && *in.ModelVersion != "", in.Confidence != nil, in.Features != nil)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetPredictionMetadata(ctx, tenantID, sub.ID)
}

// scanPredictionMetadata decodes one row into a PredictionMetadata.
func scanPredictionMetadata(row scanner, subscriberID string) (*PredictionMetadata, error) {
	var m PredictionMetadata
	var featuresRaw []byte
	if err := row.Scan(
		&m.ID,
		&m.ScoreType,
		&m.ModelVersion,
		&m.Confidence,
		&featuresRaw,
		&m.ComputedAt,
		&m.CreatedAt,
		&m.UpdatedAt,
	); err != nil {
		return nil, err
	}
	m.SubscriberID = subscriberID
	m.Features = map[string]any{}
	if len(featuresRaw) > 0 {
		if err := json.Unmarshal(featuresRaw, &m.Features); err != nil {
			return nil, fmt.Errorf("decode prediction features: %w", err)
		}
	}
	return &m, nil
}

// MountPredictionMetadataRoutes registers the SUB-010 prediction-metadata
// read/write endpoints. GET is read-scoped, PATCH is write-scoped.
func MountPredictionMetadataRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/{id}/prediction-metadata", d.GetPredictionMetadata)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Patch("/api/v1/subscribers/{id}/prediction-metadata", d.UpsertPredictionMetadata)
}

// GetPredictionMetadata GET /api/v1/subscribers/{id}/prediction-metadata
func (d *Deps) GetPredictionMetadata(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.GetPredictionMetadata(r.Context(), t.ID, chi.URLParam(r, "id"))
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// UpsertPredictionMetadata PATCH /api/v1/subscribers/{id}/prediction-metadata
func (d *Deps) UpsertPredictionMetadata(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in UpsertPredictionMetadataInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if in.ModelVersion == nil && in.Confidence == nil && in.Features == nil {
		httperror.WriteValidation(w, "validation_failed",
			"at least one of model_version, confidence or features is required")
		return
	}
	out, err := d.Repo.UpsertPredictionMetadata(r.Context(), t.ID, chi.URLParam(r, "id"), in)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	d.emit(t.ID, "subscriber.prediction_metadata.updated", map[string]any{"id": out.SubscriberID})
	writeJSON(w, http.StatusOK, out)
}
