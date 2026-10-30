package subscribers

// SUB-068 — First-party AI lookalike audiences (subscriber-namespaced).
//
// Generate a new modeled audience by ranking non-seed subscribers by
// first-party similarity to a SEED segment's members (email domain, signup
// source, engagement tier, churn tier — NO third-party cookies / data
// brokers). The seed segment's query_ast is compiled through the canonical
// segment population evaluator; the ranking lives in the predictive package — the same
// engine the audiences-page lookalike (SUB-033) uses, but persisted to the
// subscriber-namespaced tables (migrations 0949/0950) so this UI's saved
// lookalikes do not collide with the audiences UI's.
//
// Wire surface:
//
//	POST   /api/v1/subscribers/lookalike            create/compute   write
//	GET    /api/v1/subscribers/lookalike            list saved       read
//	GET    /api/v1/subscribers/lookalike/{id}       detail + members read
//	DELETE /api/v1/subscribers/lookalike/{id}       discard          write
//	POST   /api/v1/subscribers/lookalike/{id}/export route to dest    write

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/predictive"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

// Lookalike bounds (Klaviyo/Mailchimp parity range).
const (
	MinLookalikeSize     = 100
	MaxLookalikeSize     = 10000
	DefaultLookalikeSize = 1000
	// A live seed below this floor is too small for a stable, supportable
	// centroid. The repository checks it after compiling the saved segment;
	// desktop counts are only a preflight hint and cannot bypass this guard.
	MinLookalikeSeedMembers = 50
	MinLookalikeConfidence  = 0.5
	LookalikeDataUseVersion = "first-party-lookalike-v1"
	// LookalikeCandidatePoolCap bounds how many non-seed subscribers the ranker
	// scores in one synchronous request so a huge tenant can't time out create.
	LookalikeCandidatePoolCap = 50000
	// LookalikeSeedSampleCap bounds how many seed members feed the centroid.
	LookalikeSeedSampleCap = 20000
)

// CreateLookalike generates a lookalike audience from a seed segment and
// persists the audience header + its ranked members in one tenant-scoped tx.
func (r *Repo) CreateLookalike(ctx context.Context, tenantID string, in CreateLookalikeInput) (*LookalikeAudience, error) {
	in.SeedSegmentID = strings.TrimSpace(in.SeedSegmentID)
	in.Name = strings.TrimSpace(in.Name)
	if in.SeedSegmentID == "" {
		return nil, fmt.Errorf("%w: seed_segment_id is required", ErrInvalidInput)
	}
	if _, err := uuid.Parse(in.SeedSegmentID); err != nil {
		return nil, fmt.Errorf("%w: seed_segment_id must be a UUID", ErrInvalidInput)
	}
	if !in.DataUseAcknowledged {
		return nil, fmt.Errorf("%w: data_use_acknowledged must be true", ErrInvalidInput)
	}
	if len(in.Name) > 120 {
		return nil, fmt.Errorf("%w: name must be at most 120 characters", ErrInvalidInput)
	}
	if in.Name == "" {
		in.Name = "Lookalike audience"
	}
	size := in.Size
	if size == 0 {
		size = DefaultLookalikeSize
	}
	if size < MinLookalikeSize || size > MaxLookalikeSize {
		return nil, fmt.Errorf("%w: size must be between %d and %d", ErrInvalidInput, MinLookalikeSize, MaxLookalikeSize)
	}
	if in.ConfidenceThreshold != nil && (*in.ConfidenceThreshold < MinLookalikeConfidence || *in.ConfidenceThreshold > 1) {
		return nil, fmt.Errorf("%w: confidence_threshold must be between %.1f and 1 when supplied", ErrInvalidInput, MinLookalikeConfidence)
	}
	threshold := 0.0
	if in.ConfidenceThreshold != nil {
		threshold = *in.ConfidenceThreshold
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// 1. Seed segment query_ast.
	var astRaw json.RawMessage
	err = tx.QueryRow(ctx, `
SELECT query_ast FROM segments WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenantID, in.SeedSegmentID).Scan(&astRaw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("%w: seed segment", ErrNotFound)
	}
	if err != nil {
		return nil, err
	}

	predicate, err := segments.CompilePopulation(ctx, astRaw, tenantID,
		segments.TransactionSegmentResolver{Queryer: tx}, segments.DefinitionPopulation(false))
	if err != nil {
		return nil, fmt.Errorf("%w: seed segment AST: %v", ErrInvalidInput, err)
	}
	frag, args := predicate.SQL, predicate.Args
	frag = segments.ShiftPlaceholders(frag, 1) // $1 is tenantID below.

	// 2. Seed members' first-party features.
	seed, err := loadLookalikeProfiles(ctx, tx, tenantID,
		"SELECT id::text, COALESCE(email::text,''), COALESCE(signup_source,''), "+
			"COALESCE(engagement_score,0), COALESCE(churn_score,0) "+
			"FROM subscribers WHERE tenant_id = $1::uuid "+
			"AND status = 'enabled' AND archived_at IS NULL AND ("+frag+") "+
			fmt.Sprintf("LIMIT %d", LookalikeSeedSampleCap),
		append([]any{tenantID}, args...)...)
	if err != nil {
		return nil, err
	}
	if len(seed) < MinLookalikeSeedMembers {
		return nil, fmt.Errorf("%w: seed segment needs at least %d live members (found %d)", ErrInvalidInput, MinLookalikeSeedMembers, len(seed))
	}

	// 3. Candidate pool: enabled non-archived subscribers, capped. The ranker
	//    excludes the seed members by id.
	candidates, err := loadLookalikeProfiles(ctx, tx, tenantID,
		"SELECT id::text, COALESCE(email::text,''), COALESCE(signup_source,''), "+
			"COALESCE(engagement_score,0), COALESCE(churn_score,0) "+
			"FROM subscribers WHERE tenant_id = $1::uuid "+
			"AND status = 'enabled' AND archived_at IS NULL "+
			fmt.Sprintf("LIMIT %d", LookalikeCandidatePoolCap),
		tenantID)
	if err != nil {
		return nil, err
	}

	// 4. Rank.
	ranked := predictive.Rank(seed, candidates, threshold, size)

	// 5. Persist header.
	payload := map[string]any{
		"seed_count":              len(seed),
		"candidate_count":         nonSeedLookalikeCandidateCount(seed, candidates),
		"scored":                  len(ranked),
		"feature_dims":            []string{"email_domain", "signup_source", "engagement", "retention"},
		"bands":                   lookalikeBands(ranked),
		"data_use_acknowledged":   true,
		"data_use_notice_version": LookalikeDataUseVersion,
	}
	payloadRaw, _ := json.Marshal(payload)
	a, err := scanLookalikeAudience(tx.QueryRow(ctx, `
INSERT INTO subscriber_lookalike_audiences
  (tenant_id, name, seed_segment_id, size_requested, member_count, seed_count,
   confidence_threshold, model_version, status, payload)
VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, 'first-party-v1', 'ready', $8::jsonb)
RETURNING id::text, name, seed_segment_id::text, size_requested, member_count,
          seed_count, confidence_threshold, model_version, status,
          exported_destination_id::text, payload, error, created_at, updated_at`,
		tenantID, in.Name, in.SeedSegmentID, size, len(ranked), len(seed),
		in.ConfidenceThreshold, payloadRaw))
	if err != nil {
		return nil, err
	}

	for i, s := range ranked {
		featRaw, _ := json.Marshal(s.Features)
		if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_lookalike_members
  (tenant_id, audience_id, subscriber_id, email, similarity_score, rank, features)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb)
ON CONFLICT (audience_id, subscriber_id) DO NOTHING`,
			tenantID, a.ID, s.Profile.SubscriberID, s.Profile.Email,
			roundLookalikeScore(s.Similarity), i+1, featRaw); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return a, nil
}

// ListLookalikes returns all saved lookalike audience headers (newest first).
func (r *Repo) ListLookalikes(ctx context.Context, tenantID string) (*LookalikeAudienceList, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, name, seed_segment_id::text, size_requested, member_count,
       seed_count, confidence_threshold, model_version, status,
       exported_destination_id::text, payload, error, created_at, updated_at
  FROM subscriber_lookalike_audiences
 WHERE tenant_id = $1::uuid
 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := &LookalikeAudienceList{Items: []LookalikeAudience{}}
	for rows.Next() {
		a, err := scanLookalikeAudience(rows)
		if err != nil {
			return nil, err
		}
		out.Items = append(out.Items, *a)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// GetLookalike returns one audience header plus a page of its ranked members.
func (r *Repo) GetLookalike(ctx context.Context, tenantID, id string, page, perPage int, includePII bool) (*LookalikeAudienceDetail, error) {
	if _, err := uuid.Parse(strings.TrimSpace(id)); err != nil {
		return nil, fmt.Errorf("%w: lookalike audience id", ErrNotFound)
	}
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = 100
	}
	if perPage > 1000 {
		perPage = 1000
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	a, err := scanLookalikeAudience(tx.QueryRow(ctx, `
SELECT id::text, name, seed_segment_id::text, size_requested, member_count,
       seed_count, confidence_threshold, model_version, status,
       exported_destination_id::text, payload, error, created_at, updated_at
  FROM subscriber_lookalike_audiences
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	members := []LookalikeMember{}
	if includePII {
		rows, err := tx.Query(ctx, `
SELECT subscriber_id::text, email, similarity_score, rank, features
  FROM subscriber_lookalike_members
 WHERE tenant_id = $1::uuid AND audience_id = $2::uuid
 ORDER BY rank ASC
 LIMIT $3 OFFSET $4`, tenantID, id, perPage, (page-1)*perPage)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var m LookalikeMember
			var featRaw []byte
			if err := rows.Scan(&m.SubscriberID, &m.Email, &m.SimilarityScore, &m.Rank, &featRaw); err != nil {
				return nil, err
			}
			m.Features = map[string]any{}
			if len(featRaw) > 0 {
				_ = json.Unmarshal(featRaw, &m.Features)
			}
			members = append(members, m)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &LookalikeAudienceDetail{
		Audience:    *a,
		Members:     members,
		Page:        page,
		PerPage:     perPage,
		PIIIncluded: includePII,
	}, nil
}

// DeleteLookalike discards an audience (cascading its members).
func (r *Repo) DeleteLookalike(ctx context.Context, tenantID, id string) error {
	if _, err := uuid.Parse(strings.TrimSpace(id)); err != nil {
		return ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `
DELETE FROM subscriber_lookalike_audiences WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// ExportLookalike records a configured workspace destination association. It
// does not start provider delivery; operators use the audience-sync workflow
// for that separate, observable action.
func (r *Repo) ExportLookalike(ctx context.Context, tenantID, id string, in ExportLookalikeInput) (*LookalikeAudience, error) {
	in.DestinationID = strings.TrimSpace(in.DestinationID)
	if in.DestinationID == "" {
		return nil, fmt.Errorf("%w: destination_id is required", ErrInvalidInput)
	}
	if _, err := uuid.Parse(in.DestinationID); err != nil {
		return nil, fmt.Errorf("%w: destination_id must be a UUID", ErrInvalidInput)
	}
	if _, err := uuid.Parse(strings.TrimSpace(id)); err != nil {
		return nil, ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var destinationExists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM audience_destinations
   WHERE tenant_id = $1::uuid AND id = $2::uuid AND status <> 'disconnected'
)`, tenantID, in.DestinationID).Scan(&destinationExists); err != nil {
		return nil, err
	}
	if !destinationExists {
		return nil, fmt.Errorf("%w: destination_id is not a configured workspace destination", ErrInvalidInput)
	}
	a, err := scanLookalikeAudience(tx.QueryRow(ctx, `
UPDATE subscriber_lookalike_audiences
   SET exported_destination_id = $3::uuid, updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2
RETURNING id::text, name, seed_segment_id::text, size_requested, member_count,
          seed_count, confidence_threshold, model_version, status,
          exported_destination_id::text, payload, error, created_at, updated_at`,
		tenantID, id, in.DestinationID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return a, nil
}

// scanLookalikeAudience decodes one audience header row.
func scanLookalikeAudience(row scanner) (*LookalikeAudience, error) {
	var a LookalikeAudience
	var payloadRaw []byte
	var exportedDest *string
	if err := row.Scan(
		&a.ID, &a.Name, &a.SeedSegmentID, &a.SizeRequested, &a.MemberCount,
		&a.SeedCount, &a.ConfidenceThreshold, &a.ModelVersion, &a.Status,
		&exportedDest, &payloadRaw, &a.Error, &a.CreatedAt, &a.UpdatedAt,
	); err != nil {
		return nil, err
	}
	a.ExportedDestinationID = exportedDest
	a.Payload = map[string]any{}
	if len(payloadRaw) > 0 {
		_ = json.Unmarshal(payloadRaw, &a.Payload)
	}
	return &a, nil
}

// loadLookalikeProfiles runs a 5-column profile query into []predictive.Profile.
func loadLookalikeProfiles(ctx context.Context, tx pgx.Tx, tenantID, sql string, args ...any) ([]predictive.Profile, error) {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []predictive.Profile{}
	for rows.Next() {
		var p predictive.Profile
		var eng, churn float64
		if err := rows.Scan(&p.SubscriberID, &p.Email, &p.SignupSource, &eng, &churn); err != nil {
			return nil, err
		}
		p.EngagementScore = eng
		p.ChurnScore = churn
		p.EmailDomain = predictive.DomainOf(p.Email)
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// lookalikeBands buckets the ranked members into similarity bands for the
// preview breakdown (high ≥0.8, medium ≥0.5, low <0.5).
func lookalikeBands(ranked []predictive.Scored) map[string]int {
	bands := map[string]int{"high": 0, "medium": 0, "low": 0}
	for _, s := range ranked {
		switch {
		case s.Similarity >= 0.8:
			bands["high"]++
		case s.Similarity >= 0.5:
			bands["medium"]++
		default:
			bands["low"]++
		}
	}
	return bands
}

func nonSeedLookalikeCandidateCount(seed, candidates []predictive.Profile) int {
	seedIDs := make(map[string]struct{}, len(seed))
	for _, profile := range seed {
		seedIDs[profile.SubscriberID] = struct{}{}
	}
	count := 0
	for _, profile := range candidates {
		if _, isSeed := seedIDs[profile.SubscriberID]; !isSeed {
			count++
		}
	}
	return count
}

// roundLookalikeScore clamps a similarity into the numeric(5,4) range.
func roundLookalikeScore(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return float64(int(v*10000+0.5)) / 10000
}

// MountLookalikeRoutes registers the SUB-068 subscriber-namespaced lookalike
// endpoints. Reads are read-scoped; create/delete/export are write-scoped.
func MountLookalikeRoutes(r chi.Router, d *Deps) {
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/subscribers/lookalike", d.CreateLookalike)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/lookalike", d.ListLookalikes)
	r.With(apikeys.RequireScope(apikeys.ScopeReadSubscribers)).
		Get("/api/v1/subscribers/lookalike/{id}", d.GetLookalike)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Delete("/api/v1/subscribers/lookalike/{id}", d.DeleteLookalike)
	r.With(apikeys.RequireScope(apikeys.ScopeWriteSubscribers)).
		Post("/api/v1/subscribers/lookalike/{id}/export", d.ExportLookalike)
}

// CreateLookalike POST /api/v1/subscribers/lookalike
func (d *Deps) CreateLookalike(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in CreateLookalikeInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.CreateLookalike(r.Context(), t.ID, in)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	d.emit(t.ID, "subscriber.lookalike.created", map[string]any{"id": out.ID})
	writeJSON(w, http.StatusCreated, out)
}

// ListLookalikes GET /api/v1/subscribers/lookalike
func (d *Deps) ListLookalikes(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListLookalikes(r.Context(), t.ID)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// GetLookalike GET /api/v1/subscribers/lookalike/{id}
func (d *Deps) GetLookalike(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	perPage, _ := strconv.Atoi(r.URL.Query().Get("per_page"))
	includePII := r.URL.Query().Get("include_pii") == "true"
	out, err := d.Repo.GetLookalike(r.Context(), t.ID, chi.URLParam(r, "id"), page, perPage, includePII)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// DeleteLookalike DELETE /api/v1/subscribers/lookalike/{id}
func (d *Deps) DeleteLookalike(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	if err := d.Repo.DeleteLookalike(r.Context(), t.ID, chi.URLParam(r, "id")); err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	d.emit(t.ID, "subscriber.lookalike.deleted", map[string]any{"id": chi.URLParam(r, "id")})
	w.WriteHeader(http.StatusNoContent)
}

// ExportLookalike POST /api/v1/subscribers/lookalike/{id}/export
func (d *Deps) ExportLookalike(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	var in ExportLookalikeInput
	if err := httpbody.DecodeJSON(w, r, subscriberJSONMaxBodyBytes, &in); err != nil {
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	out, err := d.Repo.ExportLookalike(r.Context(), t.ID, chi.URLParam(r, "id"), in)
	if err != nil {
		d.writeRepoErr(w, r, err)
		return
	}
	d.emit(t.ID, "subscriber.lookalike.exported", map[string]any{"id": out.ID})
	writeJSON(w, http.StatusOK, out)
}
