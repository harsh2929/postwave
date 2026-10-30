package flowbuilder

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

// resolveReEnrollment applies PATCH semantics and validates the effective
// policy as one unit. In particular, a cooldown policy is never allowed to
// persist with a zero-hour window (which the runtime rejects).
func resolveReEnrollment(
	in FlowInput,
	currentPolicy string,
	currentCooldownHours int,
) (string, int, error) {
	policy := strings.TrimSpace(strings.ToLower(currentPolicy))
	if policy == "" {
		policy = "once"
	}
	if in.ReEnrollment != nil {
		policy = strings.TrimSpace(strings.ToLower(*in.ReEnrollment))
	}
	if !ValidReEnrollment(policy) {
		return "", 0, fmt.Errorf("%w: re_enrollment must be once|always|cooldown", ErrInvalidInput)
	}

	cooldownHours := currentCooldownHours
	if in.ReEnrollmentCooldownHours != nil {
		cooldownHours = *in.ReEnrollmentCooldownHours
	}
	if cooldownHours < 0 {
		return "", 0, fmt.Errorf("%w: re_enrollment_cooldown_hours must be >= 0", ErrInvalidInput)
	}
	if policy == "cooldown" && cooldownHours <= 0 {
		return "", 0, fmt.Errorf("%w: re_enrollment_cooldown_hours must be > 0 for cooldown policy", ErrInvalidInput)
	}
	return policy, cooldownHours, nil
}

type Repo struct {
	Pool *db.Pool
}

// ListFlows returns flows newest-first with keyset pagination on
// (updated_at, id). limit is the page size (caller clamps via
// pagination.ReadParamsWithDefault); a non-empty next cursor is returned
// when more rows remain. updated_at is mutable, so a flow edited
// concurrently with paging may shift between pages — acceptable for this
// admin list.
func (r *Repo) ListFlows(ctx context.Context, tenantID, status string, limit int, cursor pagination.Cursor) ([]Flow, string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if strings.TrimSpace(status) == "" {
		status = ""
	} else {
		status = normalizeFlowStatus(status)
	}
	// $1 tenant, $2 status filter, $3 limit+1; the keyset bound (when
	// paging) takes $4/$5.
	args := []any{tenantID, status, limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (j.updated_at, j.id) < ($4::timestamptz, $5::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, flowSelectSQL+`
WHERE j.tenant_id = $1::uuid AND ($2 = '' OR j.status = $2)
`+keyset+`
ORDER BY j.updated_at DESC, j.id DESC
LIMIT $3`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []Flow{}
	for rows.Next() {
		flow, err := scanFlow(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, *flow)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.UpdatedAt, ID: last.ID})
	}
	return out, next, nil
}

func (r *Repo) CreateFlow(ctx context.Context, tenantID string, in FlowInput) (*Flow, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return nil, fmt.Errorf("validation: name is required")
	}
	status := normalizeFlowStatus(in.Status)
	if !validFlowStatus(status) {
		return nil, fmt.Errorf("validation: status must be draft, active, paused, or archived")
	}
	if status != "draft" {
		return nil, ErrFlowRuntimeUnavailable
	}
	reEnrollment, cooldownHours, err := resolveReEnrollment(in, "once", 0)
	if err != nil {
		return nil, err
	}
	graph, _ := in.EffectiveGraph(FlowGraph{})
	analytics := nonNilMap(in.Analytics)
	graphRaw, triggersRaw, nodesRaw, edgesRaw, goalsRaw, analyticsRaw := marshalFlowPayloads(graph, analytics)
	versionStatus := "draft"
	var publishedAt any
	if status == "active" {
		versionStatus = "published"
		publishedAt = time.Now().UTC()
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var flowID string
	if err := tx.QueryRow(ctx, `
INSERT INTO automation_journeys
    (tenant_id, name, status, version, re_enrollment, re_enrollment_cooldown_hours,
     triggers, nodes, edges, goals, analytics, published_at)
VALUES
    ($1::uuid, $2, $3, 1, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
     CASE WHEN $3 = 'active' THEN now() ELSE NULL END)
RETURNING id::text`,
		tenantID, name, status, reEnrollment, cooldownHours, string(triggersRaw), string(nodesRaw),
		string(edgesRaw), string(goalsRaw), string(analyticsRaw)).Scan(&flowID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO automation_flow_versions
    (tenant_id, journey_id, version, status, graph, generated_by, source_ref, published_at)
VALUES
    ($1::uuid, $2::uuid, 1, $3, $4::jsonb, $5, $6, $7)`,
		tenantID, flowID, versionStatus, string(graphRaw), normalizeGeneratedBy(in.GeneratedBy),
		strings.TrimSpace(in.SourceRef), publishedAt); err != nil {
		return nil, err
	}
	out, err := getFlowTx(ctx, tx, tenantID, flowID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) GetFlow(ctx context.Context, tenantID, id string) (*Flow, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := getFlowTx(ctx, tx, tenantID, id)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) UpdateFlow(ctx context.Context, tenantID string, existing *Flow, in FlowInput) (*Flow, error) {
	if existing == nil {
		return nil, ErrNotFound
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = existing.Name
	}
	status := normalizeFlowStatus(in.Status)
	if strings.TrimSpace(in.Status) == "" {
		status = existing.Status
	}
	if !validFlowStatus(status) {
		return nil, fmt.Errorf("validation: status must be draft, active, paused, or archived")
	}
	if status == "active" {
		return nil, ErrFlowRuntimeUnavailable
	}
	graph, _ := in.EffectiveGraph(existing.Graph)
	analytics := existing.Analytics
	if in.Analytics != nil {
		analytics = in.Analytics
	}
	analytics = nonNilMap(analytics)
	graphRaw, triggersRaw, nodesRaw, edgesRaw, goalsRaw, analyticsRaw := marshalFlowPayloads(graph, analytics)
	nextVersion := existing.Version + 1
	versionStatus := "draft"
	var publishedAt any
	if status == "active" {
		versionStatus = "published"
		publishedAt = time.Now().UTC()
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	reEnrollment, cooldownHours, err := resolveReEnrollment(
		in,
		existing.ReEnrollment,
		existing.ReEnrollmentCooldownHours,
	)
	if err != nil {
		return nil, err
	}
	tag, err := tx.Exec(ctx, `
UPDATE automation_journeys
   SET name = $3,
       status = $4,
       version = $5,
       triggers = $6::jsonb,
       nodes = $7::jsonb,
       edges = $8::jsonb,
       goals = $9::jsonb,
       analytics = $10::jsonb,
       re_enrollment = $11,
       re_enrollment_cooldown_hours = $12,
       published_at = CASE WHEN $4 = 'active' THEN COALESCE(published_at, now()) ELSE published_at END,
       updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND updated_at = $13::timestamptz`,
		tenantID, existing.ID, name, status, nextVersion, string(triggersRaw),
		string(nodesRaw), string(edgesRaw), string(goalsRaw), string(analyticsRaw),
		reEnrollment, cooldownHours, existing.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() != 1 {
		return nil, ErrPreconditionFailed
	}
	if status == "active" {
		if _, err := tx.Exec(ctx, `
UPDATE automation_flow_versions
   SET status = 'archived'
 WHERE tenant_id = $1::uuid AND journey_id = $2::uuid AND status = 'published'`,
			tenantID, existing.ID); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO automation_flow_versions
    (tenant_id, journey_id, version, status, graph, generated_by, source_ref, published_at)
VALUES
    ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7, $8)`,
		tenantID, existing.ID, nextVersion, versionStatus, string(graphRaw),
		normalizeGeneratedBy(in.GeneratedBy), strings.TrimSpace(in.SourceRef), publishedAt); err != nil {
		return nil, err
	}
	out, err := getFlowTx(ctx, tx, tenantID, existing.ID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// ListVersions returns a flow's versions newest-first with keyset
// pagination on (created_at, id). version is monotonic with created_at,
// so ordering by created_at DESC matches the prior "ORDER BY version
// DESC" while giving a stable keyset tiebreaker. limit is the page size
// (caller clamps via pagination.ReadParamsWithDefault); a non-empty next
// cursor is returned when more rows remain. This list was previously
// unbounded; 200 is the new default page size.
func (r *Repo) ListVersions(ctx context.Context, tenantID, flowID string, limit int, cursor pagination.Cursor) ([]FlowVersion, string, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := getFlowTx(ctx, tx, tenantID, flowID); err != nil {
		return nil, "", err
	}
	// $1 tenant, $2 journey, $3 limit+1; the keyset bound (when paging)
	// takes $4/$5.
	args := []any{tenantID, strings.TrimSpace(flowID), limit + 1}
	keyset := ""
	if cursor.ID != "" {
		keyset = "AND (created_at, id) < ($4::timestamptz, $5::uuid)"
		args = append(args, cursor.SortKey.UTC(), cursor.ID)
	}
	rows, err := tx.Query(ctx, versionSelectSQL+`
WHERE tenant_id = $1::uuid AND journey_id = $2::uuid
`+keyset+`
ORDER BY created_at DESC, id DESC
LIMIT $3`, args...)
	if err != nil {
		return nil, "", err
	}
	defer rows.Close()
	out := []FlowVersion{}
	for rows.Next() {
		item, err := scanVersion(rows)
		if err != nil {
			return nil, "", err
		}
		out = append(out, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, "", err
	}
	out, more := pagination.HasMore(out, limit)
	next := ""
	if more {
		last := out[len(out)-1]
		next = pagination.Encode(pagination.Cursor{SortKey: last.CreatedAt, ID: last.ID})
	}
	return out, next, nil
}

func (r *Repo) CreateVersion(ctx context.Context, tenantID string, existing *Flow, in VersionInput, graph FlowGraph) (*FlowVersion, error) {
	version, _, err := r.CreateVersionWithFlow(ctx, tenantID, existing, in, graph)
	return version, err
}

// CreateVersionWithFlow returns the immutable version and the mutable flow
// representation from the same transaction. That pairs the response ETag with
// the state it protects instead of fetching a possibly newer token afterward.
func (r *Repo) CreateVersionWithFlow(ctx context.Context, tenantID string, existing *Flow, in VersionInput, graph FlowGraph) (*FlowVersion, *Flow, error) {
	if existing == nil {
		return nil, nil, ErrNotFound
	}
	graphRaw, triggersRaw, nodesRaw, edgesRaw, goalsRaw, _ := marshalFlowPayloads(graph, existing.Analytics)
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Serialize every version-producing write on the parent row, then verify
	// the caller's representation is still current. The handler check gives a
	// fast 412; this check closes the race between that read and this tx.
	var currentUpdatedAt time.Time
	if err := tx.QueryRow(ctx, `
SELECT updated_at
FROM automation_journeys
WHERE tenant_id = $1::uuid AND id = $2::uuid
FOR UPDATE`, tenantID, existing.ID).Scan(&currentUpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil, ErrNotFound
		}
		return nil, nil, err
	}
	if !currentUpdatedAt.Equal(existing.UpdatedAt) {
		return nil, nil, ErrPreconditionFailed
	}
	nextVersion, err := nextVersionTx(ctx, tx, tenantID, existing.ID)
	if err != nil {
		return nil, nil, err
	}
	row := tx.QueryRow(ctx, `
INSERT INTO automation_flow_versions
    (tenant_id, journey_id, version, status, graph, generated_by, source_ref)
VALUES
    ($1::uuid, $2::uuid, $3, 'draft', $4::jsonb, $5, $6)
RETURNING `+versionColumns,
		tenantID, existing.ID, nextVersion, string(graphRaw), normalizeGeneratedBy(in.GeneratedBy),
		strings.TrimSpace(in.SourceRef))
	version, err := scanVersion(row)
	if err != nil {
		return nil, nil, err
	}
	var tag pgconn.CommandTag
	if existing.Status != "active" {
		tag, err = tx.Exec(ctx, `
UPDATE automation_journeys
   SET version = $3,
       triggers = $4::jsonb,
       nodes = $5::jsonb,
       edges = $6::jsonb,
       goals = $7::jsonb,
	       updated_at = clock_timestamp()
	 WHERE tenant_id = $1::uuid AND id = $2::uuid
	   AND updated_at = $8::timestamptz`,
			tenantID, existing.ID, nextVersion, string(triggersRaw), string(nodesRaw),
			string(edgesRaw), string(goalsRaw), existing.UpdatedAt)
	} else {
		// A draft version must advance the concurrency token even though it must
		// not replace the active journey graph before an explicit Publish.
		tag, err = tx.Exec(ctx, `
UPDATE automation_journeys
   SET updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid
   AND updated_at = $3::timestamptz`, tenantID, existing.ID, existing.UpdatedAt)
	}
	if err != nil {
		return nil, nil, err
	}
	if tag.RowsAffected() != 1 {
		return nil, nil, ErrPreconditionFailed
	}
	current, err := getFlowTx(ctx, tx, tenantID, existing.ID)
	if err != nil {
		return nil, nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	return version, current, nil
}

func (r *Repo) GetVersion(ctx context.Context, tenantID, flowID, versionID string) (*FlowVersion, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := getVersionTx(ctx, tx, tenantID, flowID, versionID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (r *Repo) PromoteVersion(ctx context.Context, tenantID, flowID string, version *FlowVersion, activate bool) (*Flow, error) {
	if !flowRuntimeQualified {
		return nil, ErrFlowRuntimeUnavailable
	}
	if version == nil {
		return nil, ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	flow, err := promoteVersionTx(ctx, tx, tenantID, flowID, version, activate)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return flow, nil
}

// PublishFlow promotes a draft version's graph into an ACTIVE flow's live
// journey columns (FLOW-008). It is deliberately NOT gated on
// flowRuntimeQualified: it performs no execution transition — it only swaps the
// graph an already-active (still contained) journey exposes. promoteVersionTx
// with activate=false can never turn a non-active row 'active', and the
// active-only guard here means Publish can never START execution. versionID
// empty ⇒ publish the latest version.
func (r *Repo) PublishFlow(ctx context.Context, tenantID, flowID, versionID string, expectedUpdatedAt time.Time) (*Flow, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var currentUpdatedAt time.Time
	if err := tx.QueryRow(ctx, `
SELECT updated_at
FROM automation_journeys
WHERE tenant_id = $1::uuid AND id = $2::uuid
FOR UPDATE`, tenantID, flowID).Scan(&currentUpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if !currentUpdatedAt.Equal(expectedUpdatedAt) {
		return nil, ErrPreconditionFailed
	}
	existing, err := getFlowTx(ctx, tx, tenantID, flowID)
	if err != nil {
		return nil, err
	}
	if existing.Status != "active" {
		return nil, fmt.Errorf("%w: publish applies only to an active flow", ErrInvalidInput)
	}
	var version *FlowVersion
	if strings.TrimSpace(versionID) != "" {
		version, err = getVersionTx(ctx, tx, tenantID, flowID, versionID)
	} else {
		version, err = latestVersionTx(ctx, tx, tenantID, flowID)
	}
	if err != nil {
		return nil, err
	}
	if validation := ValidateFlowGraph(version.Graph); !validation.Valid {
		return nil, fmt.Errorf("%w: the version graph is invalid", ErrInvalidInput)
	}
	flow, err := promoteVersionTx(ctx, tx, tenantID, flowID, version, false)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return flow, nil
}

func (r *Repo) ActivateFlow(ctx context.Context, tenantID, flowID string) (*Flow, error) {
	if !flowRuntimeQualified {
		return nil, ErrFlowRuntimeUnavailable
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	flow, err := getFlowTx(ctx, tx, tenantID, flowID)
	if err != nil {
		return nil, err
	}
	version, err := latestVersionTx(ctx, tx, tenantID, flow.ID)
	if err != nil {
		return nil, err
	}
	validation := ValidateFlowGraph(version.Graph)
	if !validation.Executable {
		return nil, validationError{Validation: &validation}
	}
	out, err := promoteVersionTx(ctx, tx, tenantID, flow.ID, version, true)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func getFlowTx(ctx context.Context, tx pgx.Tx, tenantID, id string) (*Flow, error) {
	row := tx.QueryRow(ctx, flowSelectSQL+`
WHERE j.tenant_id = $1::uuid AND j.id = $2::uuid
LIMIT 1`, tenantID, strings.TrimSpace(id))
	out, err := scanFlow(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

func getVersionTx(ctx context.Context, tx pgx.Tx, tenantID, flowID, versionID string) (*FlowVersion, error) {
	row := tx.QueryRow(ctx, versionSelectSQL+`
WHERE tenant_id = $1::uuid AND journey_id = $2::uuid AND id = $3::uuid
LIMIT 1`, tenantID, strings.TrimSpace(flowID), strings.TrimSpace(versionID))
	out, err := scanVersion(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

func latestVersionTx(ctx context.Context, tx pgx.Tx, tenantID, flowID string) (*FlowVersion, error) {
	row := tx.QueryRow(ctx, versionSelectSQL+`
WHERE tenant_id = $1::uuid AND journey_id = $2::uuid
ORDER BY version DESC
LIMIT 1`, tenantID, strings.TrimSpace(flowID))
	out, err := scanVersion(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return out, nil
}

func nextVersionTx(ctx context.Context, tx pgx.Tx, tenantID, flowID string) (int, error) {
	var version int
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(max(version), 0) + 1
FROM automation_flow_versions
WHERE tenant_id = $1::uuid AND journey_id = $2::uuid`, tenantID, strings.TrimSpace(flowID)).Scan(&version); err != nil {
		return 0, err
	}
	return version, nil
}

func promoteVersionTx(ctx context.Context, tx pgx.Tx, tenantID, flowID string, version *FlowVersion, activate bool) (*Flow, error) {
	graph := version.Graph
	normalizeGraph(&graph)
	_, triggersRaw, nodesRaw, edgesRaw, goalsRaw, _ := marshalFlowPayloads(graph, nil)
	if _, err := tx.Exec(ctx, `
UPDATE automation_flow_versions
   SET status = CASE WHEN id = $3::uuid THEN 'published'
                     WHEN status = 'published' THEN 'archived'
                     ELSE status END,
       published_at = CASE WHEN id = $3::uuid THEN COALESCE(published_at, now()) ELSE published_at END
 WHERE tenant_id = $1::uuid AND journey_id = $2::uuid`,
		tenantID, flowID, version.ID); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
UPDATE automation_journeys
   SET status = CASE WHEN $8 THEN 'active' ELSE CASE WHEN status = 'archived' THEN 'paused' ELSE status END END,
       version = $3,
       triggers = $4::jsonb,
       nodes = $5::jsonb,
       edges = $6::jsonb,
       goals = $7::jsonb,
       published_at = COALESCE(published_at, now()),
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, flowID, version.Version, string(triggersRaw), string(nodesRaw),
		string(edgesRaw), string(goalsRaw), activate); err != nil {
		return nil, err
	}
	return getFlowTx(ctx, tx, tenantID, flowID)
}

const flowSelectSQL = `
SELECT j.id::text,
       j.tenant_id::text,
       j.name,
       j.status,
       j.version,
       j.re_enrollment,
       j.re_enrollment_cooldown_hours,
       j.triggers,
       j.nodes,
       j.edges,
       j.goals,
       j.analytics,
       j.published_at,
       j.created_at,
       j.updated_at,
       COALESCE(v.id::text, ''),
       COALESCE(v.version, 0),
       COALESCE(v.status, ''),
       COALESCE(v.graph, '{}'::jsonb),
       COALESCE(v.generated_by, ''),
       COALESCE(v.source_ref, ''),
       v.published_at,
       v.created_at
FROM automation_journeys j
LEFT JOIN LATERAL (
    SELECT id, version, status, graph, generated_by, source_ref, published_at, created_at
    FROM automation_flow_versions
    WHERE tenant_id = j.tenant_id AND journey_id = j.id
    ORDER BY version DESC
    LIMIT 1
) v ON true
`

const versionSelectSQL = `SELECT ` + versionColumns + ` FROM automation_flow_versions `
const versionColumns = `id::text, tenant_id::text, journey_id::text, version, status, graph, generated_by, source_ref, published_at, created_at`

type scanner interface{ Scan(dest ...any) error }

func scanFlow(row scanner) (*Flow, error) {
	var out Flow
	var triggersRaw, nodesRaw, edgesRaw, goalsRaw, analyticsRaw []byte
	var versionID, versionStatus, generatedBy, sourceRef string
	var versionNumber int
	var graphRaw []byte
	var versionPublishedAt, versionCreatedAt *time.Time
	if err := row.Scan(&out.ID, &out.TenantID, &out.Name, &out.Status, &out.Version,
		&out.ReEnrollment, &out.ReEnrollmentCooldownHours,
		&triggersRaw, &nodesRaw, &edgesRaw, &goalsRaw, &analyticsRaw,
		&out.PublishedAt, &out.CreatedAt, &out.UpdatedAt,
		&versionID, &versionNumber, &versionStatus, &graphRaw, &generatedBy,
		&sourceRef, &versionPublishedAt, &versionCreatedAt); err != nil {
		return nil, err
	}
	out.Graph = graphFromJourney(triggersRaw, nodesRaw, edgesRaw, goalsRaw)
	out.Analytics = decodeMap(analyticsRaw)
	if versionID != "" {
		versionGraph := decodeGraph(graphRaw)
		if !flowGraphEmpty(versionGraph) {
			out.Graph = versionGraph
		}
		createdAt := out.CreatedAt
		if versionCreatedAt != nil {
			createdAt = *versionCreatedAt
		}
		out.LatestVersion = &FlowVersion{
			ID:          versionID,
			TenantID:    out.TenantID,
			FlowID:      out.ID,
			Version:     versionNumber,
			Status:      versionStatus,
			Graph:       out.Graph,
			GeneratedBy: generatedBy,
			SourceRef:   sourceRef,
			PublishedAt: versionPublishedAt,
			CreatedAt:   createdAt,
		}
	}
	normalizeGraph(&out.Graph)
	out.Analytics = nonNilMap(out.Analytics)
	return &out, nil
}

func scanVersion(row scanner) (*FlowVersion, error) {
	var out FlowVersion
	var graphRaw []byte
	if err := row.Scan(&out.ID, &out.TenantID, &out.FlowID, &out.Version,
		&out.Status, &graphRaw, &out.GeneratedBy, &out.SourceRef,
		&out.PublishedAt, &out.CreatedAt); err != nil {
		return nil, err
	}
	out.Graph = decodeGraph(graphRaw)
	normalizeGraph(&out.Graph)
	return &out, nil
}

func marshalFlowPayloads(graph FlowGraph, analytics map[string]any) (graphRaw, triggersRaw, nodesRaw, edgesRaw, goalsRaw, analyticsRaw []byte) {
	normalizeGraph(&graph)
	analytics = nonNilMap(analytics)
	graphRaw, _ = json.Marshal(graph)
	triggersRaw, _ = json.Marshal(graph.Triggers)
	nodesRaw, _ = json.Marshal(graph.Nodes)
	edgesRaw, _ = json.Marshal(graph.Edges)
	goalsRaw, _ = json.Marshal(graph.Goals)
	analyticsRaw, _ = json.Marshal(analytics)
	return graphRaw, triggersRaw, nodesRaw, edgesRaw, goalsRaw, analyticsRaw
}

func graphFromJourney(triggersRaw, nodesRaw, edgesRaw, goalsRaw []byte) FlowGraph {
	graph := FlowGraph{}
	_ = json.Unmarshal(triggersRaw, &graph.Triggers)
	_ = json.Unmarshal(nodesRaw, &graph.Nodes)
	_ = json.Unmarshal(edgesRaw, &graph.Edges)
	_ = json.Unmarshal(goalsRaw, &graph.Goals)
	normalizeGraph(&graph)
	return graph
}

func decodeGraph(raw []byte) FlowGraph {
	graph := FlowGraph{}
	_ = json.Unmarshal(raw, &graph)
	normalizeGraph(&graph)
	return graph
}

func decodeMap(raw []byte) map[string]any {
	out := map[string]any{}
	if len(raw) == 0 {
		return out
	}
	_ = json.Unmarshal(raw, &out)
	return nonNilMap(out)
}

func nonNilMap(in map[string]any) map[string]any {
	if in == nil {
		return map[string]any{}
	}
	return in
}

func flowGraphEmpty(graph FlowGraph) bool {
	return graph.EntryID == "" && len(graph.Triggers) == 0 && len(graph.Nodes) == 0 && len(graph.Edges) == 0 && len(graph.Goals) == 0
}

func validFlowStatus(status string) bool {
	switch status {
	case "draft", "active", "paused", "archived":
		return true
	default:
		return false
	}
}
