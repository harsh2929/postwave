// Package audiences implements SUB-033 lookalike audiences: generate a new
// materialised audience by ranking non-seed subscribers by first-party
// similarity to a SEED segment's members (email domain, signup source,
// engagement tier, churn tier — NO third-party data). The seed segment's
// query_ast is compiled through the canonical segment population evaluator;
// the ranking lives in the predictive package.
package audiences

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/predictive"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

// ErrNotFound is returned when a lookalike model (or its seed segment) does
// not exist for the tenant.
var ErrNotFound = errors.New("audiences: not found")

// ErrInvalidInput is returned for a bad create body (missing seed, empty
// seed audience, out-of-range size). Handlers map it to 422.
var ErrInvalidInput = errors.New("audiences: invalid input")

// Repo is the postgres-backed lookalike store. Every method opens its own
// tenant-scoped tx so RLS fires.
type Repo struct {
	Pool *db.Pool
}

// CreateLookalike generates a lookalike audience from a seed segment and
// persists the model + its ranked members. The whole operation runs in one
// tenant-scoped tx so a half-materialised audience never lands. Steps:
//  1. Load the seed segment's query_ast (tenant-scoped).
//  2. Compile it to a SQL fragment and load the seed members' first-party
//     features.
//  3. Load the candidate pool (all non-seed subscribers, capped).
//  4. Rank candidates by centroid-cosine similarity (predictive.Rank).
//  5. Persist the lookalike_models header + top-N lookalike_members rows.
func (r *Repo) CreateLookalike(ctx context.Context, tenantID string, in CreateLookalikeInput) (*LookalikeModel, error) {
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
	seed, err := loadProfiles(ctx, tx, tenantID,
		"SELECT id::text, COALESCE(email::text,''), COALESCE(signup_source,''), "+
			"COALESCE(engagement_score,0), COALESCE(churn_score,0) "+
			"FROM subscribers WHERE tenant_id = $1::uuid "+
			"AND status = 'enabled' AND archived_at IS NULL AND ("+frag+") "+
			fmt.Sprintf("LIMIT %d", SeedSampleCap),
		append([]any{tenantID}, args...)...)
	if err != nil {
		return nil, err
	}
	if len(seed) < MinLookalikeSeedMembers {
		return nil, fmt.Errorf("%w: seed segment needs at least %d live members (found %d)", ErrInvalidInput, MinLookalikeSeedMembers, len(seed))
	}

	// 3. Candidate pool: enabled non-archived subscribers, capped. The ranker
	//    excludes the seed members by id, so we don't have to subtract them in
	//    SQL (keeps the predicate index-friendly).
	candidates, err := loadProfiles(ctx, tx, tenantID,
		"SELECT id::text, COALESCE(email::text,''), COALESCE(signup_source,''), "+
			"COALESCE(engagement_score,0), COALESCE(churn_score,0) "+
			"FROM subscribers WHERE tenant_id = $1::uuid "+
			"AND status = 'enabled' AND archived_at IS NULL "+
			fmt.Sprintf("LIMIT %d", CandidatePoolCap),
		tenantID)
	if err != nil {
		return nil, err
	}

	// 4. Rank.
	ranked := predictive.Rank(seed, candidates, threshold, size)

	// 5. Persist header.
	payload := map[string]any{
		"seed_count":              len(seed),
		"candidate_count":         nonSeedCandidateCount(seed, candidates),
		"scored":                  len(ranked),
		"feature_dims":            []string{"email_domain", "signup_source", "engagement", "retention"},
		"data_use_acknowledged":   true,
		"data_use_notice_version": LookalikeDataUseVersion,
	}
	payloadRaw, _ := json.Marshal(payload)
	var m LookalikeModel
	err = tx.QueryRow(ctx, `
INSERT INTO lookalike_models
  (tenant_id, name, seed_segment_id, size_requested, member_count, seed_count,
   confidence_threshold, model_version, status, payload)
VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, 'first-party-v1', 'ready', $8::jsonb)
RETURNING id::text, name, seed_segment_id::text, size_requested, member_count,
          seed_count, confidence_threshold, model_version, status, payload,
          error, created_at, updated_at`,
		tenantID, in.Name, in.SeedSegmentID, size, len(ranked), len(seed),
		in.ConfidenceThreshold, payloadRaw).Scan(
		&m.ID, &m.Name, &m.SeedSegmentID, &m.SizeRequested, &m.MemberCount,
		&m.SeedCount, &m.ConfidenceThreshold, &m.ModelVersion, &m.Status,
		payloadRawOut(&m), &m.Error, &m.CreatedAt, &m.UpdatedAt)
	if err != nil {
		return nil, err
	}

	// Persist members in rank order.
	for i, s := range ranked {
		featRaw, _ := json.Marshal(s.Features)
		if _, err := tx.Exec(ctx, `
INSERT INTO lookalike_members
  (tenant_id, model_id, subscriber_id, email, similarity_score, rank, features)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::jsonb)
ON CONFLICT (model_id, subscriber_id) DO NOTHING`,
			tenantID, m.ID, s.Profile.SubscriberID, s.Profile.Email,
			roundScore(s.Similarity), i+1, featRaw); err != nil {
			return nil, err
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &m, nil
}

// GetLookalike returns the model header for one lookalike model.
func (r *Repo) GetLookalike(ctx context.Context, tenantID, id string) (*LookalikeModel, error) {
	if _, err := uuid.Parse(strings.TrimSpace(id)); err != nil {
		return nil, ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var m LookalikeModel
	err = tx.QueryRow(ctx, `
SELECT id::text, name, seed_segment_id::text, size_requested, member_count,
       seed_count, confidence_threshold, model_version, status, payload,
       error, created_at, updated_at
  FROM lookalike_models
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id).Scan(
		&m.ID, &m.Name, &m.SeedSegmentID, &m.SizeRequested, &m.MemberCount,
		&m.SeedCount, &m.ConfidenceThreshold, &m.ModelVersion, &m.Status,
		payloadRawOut(&m), &m.Error, &m.CreatedAt, &m.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &m, nil
}

// ListMembers returns the ranked members of a lookalike model, paginated by
// rank ascending (rank 1 = most similar). Returns ErrNotFound when the model
// does not exist.
func (r *Repo) ListMembers(ctx context.Context, tenantID, id string, page, perPage int, includePII bool) (*LookalikeMemberPage, error) {
	if _, err := uuid.Parse(strings.TrimSpace(id)); err != nil {
		return nil, ErrNotFound
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

	// Existence + total via the model header.
	var total int
	err = tx.QueryRow(ctx, `
SELECT member_count FROM lookalike_models
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id).Scan(&total)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	identityExpression := "''::text, ''::text, similarity_score, rank, '{}'::jsonb"
	if includePII {
		identityExpression = "subscriber_id::text, email, similarity_score, rank, features"
	}
	rows, err := tx.Query(ctx, `
SELECT `+identityExpression+`
  FROM lookalike_members
 WHERE tenant_id = $1::uuid AND model_id = $2::uuid
 ORDER BY rank ASC
 LIMIT $3 OFFSET $4`, tenantID, id, perPage, (page-1)*perPage)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []LookalikeMember{}
	for rows.Next() {
		var mem LookalikeMember
		var featRaw []byte
		if err := rows.Scan(&mem.SubscriberID, &mem.Email, &mem.SimilarityScore, &mem.Rank, &featRaw); err != nil {
			return nil, err
		}
		mem.Features = map[string]any{}
		if len(featRaw) > 0 {
			_ = json.Unmarshal(featRaw, &mem.Features)
		}
		items = append(items, mem)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &LookalikeMemberPage{Items: items, Total: total, Page: page, PerPage: perPage, PIIIncluded: includePII}, nil
}

// DeleteLookalike discards a lookalike model (cascading its members).
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
DELETE FROM lookalike_models WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

// loadProfiles runs a profile query (5 columns: id, email, signup_source,
// engagement_score, churn_score) into a []predictive.Profile.
func loadProfiles(ctx context.Context, tx pgx.Tx, tenantID, sql string, args ...any) ([]predictive.Profile, error) {
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

func nonSeedCandidateCount(seed, candidates []predictive.Profile) int {
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

// roundScore clamps a similarity into the numeric(5,4) range the
// lookalike_members CHECK constraint allows (4 decimal places, [0,1]).
func roundScore(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return float64(int(v*10000+0.5)) / 10000
}

// payloadRawOut returns a scan target that decodes the payload jsonb column
// into m.Payload. Used inline in the RETURNING/SELECT scans so the jsonb
// column doesn't need a separate []byte local at every call site.
func payloadRawOut(m *LookalikeModel) jsonbScan {
	return jsonbScan{m: m}
}

// jsonbScan adapts a jsonb column into LookalikeModel.Payload during Scan.
type jsonbScan struct{ m *LookalikeModel }

func (j jsonbScan) Scan(src any) error {
	j.m.Payload = map[string]any{}
	var raw []byte
	switch v := src.(type) {
	case []byte:
		raw = v
	case string:
		raw = []byte(v)
	case nil:
		return nil
	default:
		return fmt.Errorf("jsonbScan: unsupported source %T", src)
	}
	if len(raw) == 0 {
		return nil
	}
	return json.Unmarshal(raw, &j.m.Payload)
}
