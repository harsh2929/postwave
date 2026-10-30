// SPDX-License-Identifier: AGPL-3.0-only

package subscriber_dedupe

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	defaultScanPageSize = 50
	maxScanPageSize     = 200
)

var (
	errScanNotFound = errors.New("subscriber duplicate scan not found")
	errScanExpired  = errors.New("subscriber duplicate scan expired")
	errScanRunning  = errors.New("subscriber duplicate scan already running")
)

// Evidence is one deterministic, server-evaluated reason two rows were
// surfaced together. It deliberately carries no matched identifier: the
// authorized UI already has the two subscriber emails, while phones and
// upstream IDs must never leak into errors, logs, or scan persistence.
type Evidence struct {
	Kind       string  `json:"kind"`
	Confidence float64 `json:"confidence"`
	Reason     string  `json:"reason"`
}

// Scan describes one immutable, complete candidate manifest. CandidateCount
// is the total across every page, so zero is a truthful workspace-wide result
// rather than "nothing was found in the first sample".
type Scan struct {
	ID              string     `json:"scan_id"`
	Status          string     `json:"status"`
	SubscriberCount int64      `json:"subscriber_count"`
	CandidateCount  int64      `json:"candidate_count"`
	CreatedAt       time.Time  `json:"created_at"`
	CompletedAt     *time.Time `json:"completed_at,omitempty"`
	ExpiresAt       time.Time  `json:"expires_at"`
	Complete        bool       `json:"complete"`
}

// ScanPair is one reviewed unit. Updated-at versions are bound into both the
// preview and apply contracts; Stale turns true if either row changed or
// disappeared after the immutable scan was materialized.
type ScanPair struct {
	PrimaryID          string     `json:"primary_id"`
	PrimaryEmail       string     `json:"primary_email"`
	DuplicateID        string     `json:"duplicate_id"`
	DuplicateEmail     string     `json:"duplicate_email"`
	PrimaryUpdatedAt   time.Time  `json:"primary_updated_at"`
	DuplicateUpdatedAt time.Time  `json:"duplicate_updated_at"`
	Kind               string     `json:"kind"`
	Confidence         float64    `json:"confidence"`
	Evidence           []Evidence `json:"evidence"`
	Stale              bool       `json:"stale"`
}

type scanPage struct {
	Scan       Scan       `json:"scan"`
	Pairs      []ScanPair `json:"pairs"`
	Count      int64      `json:"count"`
	NextCursor string     `json:"next_cursor,omitempty"`
	Complete   bool       `json:"complete"`
}

// StartScan materializes an exhaustive manifest in one tenant-scoped
// transaction. Equality joins run over tenant-scoped SHA-256 projections
// maintained by a subscriber trigger; unlike the historical implementation there is no
// sampled candidate cap and no query error is ignored.
func (d *Deps) StartScan(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	scan, err := d.createCompleteScan(r.Context(), tenant.ID)
	if err != nil {
		if errors.Is(err, errScanRunning) {
			httperror.Write(w, http.StatusConflict, "duplicate_scan_in_progress", "A complete duplicate scan is already running for this workspace.")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusCreated, scan)
}

// List preserves the original GET route for SDK compatibility, but now backs
// it with a complete materialized scan and an honest cursor. Existing clients
// can keep reading pairs/count; mature clients should retain scan.scan_id and
// follow next_cursor until the exact candidate_count is reviewed.
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	scan, err := d.createCompleteScan(r.Context(), tenant.ID)
	if err != nil {
		if errors.Is(err, errScanRunning) {
			httperror.Write(w, http.StatusConflict, "duplicate_scan_in_progress", "A complete duplicate scan is already running for this workspace.")
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	limit := parsePageLimit(r.URL.Query().Get("limit"))
	page, err := d.loadScanPage(r.Context(), tenant.ID, scan.ID, 0, limit)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenant.ID))
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (d *Deps) GetScan(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	scanID := chi.URLParam(r, "scanID")
	if _, err := uuid.Parse(scanID); err != nil {
		httperror.Write(w, http.StatusNotFound, "scan_not_found", "Duplicate scan not found.")
		return
	}
	tx, err := db.WithTenant(r.Context(), d.Pool, tenant.ID)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	scan, err := loadScan(r.Context(), tx, tenant.ID, scanID)
	if err != nil {
		writeScanReadError(w, d, r, tenant.ID, err)
		return
	}
	writeJSON(w, http.StatusOK, scan)
}

func (d *Deps) ListScanPairs(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "")
		return
	}
	cursor, err := parseCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		httperror.WriteValidation(w, "invalid_cursor", "The duplicate-scan cursor is invalid.")
		return
	}
	scanID := chi.URLParam(r, "scanID")
	if _, err := uuid.Parse(scanID); err != nil {
		httperror.Write(w, http.StatusNotFound, "scan_not_found", "Duplicate scan not found.")
		return
	}
	page, err := d.loadScanPage(
		r.Context(), tenant.ID, scanID, cursor,
		parsePageLimit(r.URL.Query().Get("limit")),
	)
	if err != nil {
		writeScanReadError(w, d, r, tenant.ID, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func writeScanReadError(w http.ResponseWriter, d *Deps, r *http.Request, tenantID string, err error) {
	switch {
	case errors.Is(err, errScanNotFound):
		httperror.Write(w, http.StatusNotFound, "scan_not_found", "Duplicate scan not found.")
	case errors.Is(err, errScanExpired):
		httperror.Write(w, http.StatusGone, "scan_expired", "This duplicate scan expired. Start a new scan.")
	default:
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), tenantID))
	}
}

func parsePageLimit(raw string) int {
	if raw == "" {
		return defaultScanPageSize
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return defaultScanPageSize
	}
	if value > maxScanPageSize {
		return maxScanPageSize
	}
	return value
}

func parseCursor(raw string) (int64, error) {
	if strings.TrimSpace(raw) == "" {
		return 0, nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		return 0, errors.New("invalid cursor")
	}
	return value, nil
}

func (d *Deps) createCompleteScan(ctx context.Context, tenantID string) (*Scan, error) {
	if tenantID == "" {
		return nil, errors.New("subscriber duplicate scan requires a tenant")
	}
	// One repeatable-read snapshot binds the manifest and its authoritative
	// subscriber_count to the same exact workspace state, even while imports or
	// profile edits commit concurrently.
	tx, err := d.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return nil, fmt.Errorf("begin subscriber duplicate scan: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT set_config('app.tenant_id', $1, true)", tenantID); err != nil {
		return nil, fmt.Errorf("bind subscriber duplicate scan tenant: %w", err)
	}
	var acquired bool
	if err := tx.QueryRow(ctx, `
SELECT pg_try_advisory_xact_lock(
    hashtextextended($1 || ':subscriber-duplicate-scan', 0)
)`, tenantID).Scan(&acquired); err != nil {
		return nil, fmt.Errorf("lock subscriber duplicate scan: %w", err)
	}
	if !acquired {
		return nil, errScanRunning
	}

	var scan Scan
	if err := tx.QueryRow(ctx, `
INSERT INTO subscriber_duplicate_scans (tenant_id)
VALUES ($1::uuid)
RETURNING id::text, status, subscriber_count, candidate_count,
          created_at, completed_at, expires_at`, tenantID).Scan(
		&scan.ID, &scan.Status, &scan.SubscriberCount, &scan.CandidateCount,
		&scan.CreatedAt, &scan.CompletedAt, &scan.ExpiresAt,
	); err != nil {
		return nil, err
	}

	if _, err := tx.Exec(ctx, materializeScanPairsSQL, tenantID, scan.ID); err != nil {
		return nil, fmt.Errorf("materialize subscriber duplicate scan: %w", err)
	}
	if err := tx.QueryRow(ctx, `
UPDATE subscriber_duplicate_scans scan
   SET status = 'complete',
       subscriber_count = (
           SELECT count(*)
             FROM subscribers s
            WHERE s.tenant_id = $1::uuid
              AND s.archived_at IS NULL
              AND NOT (COALESCE(s.custom_fields, '{}'::jsonb) ? 'merged_into')
       ),
       candidate_count = (
           SELECT count(*)
             FROM subscriber_duplicate_scan_pairs pairs
            WHERE pairs.tenant_id = $1::uuid AND pairs.scan_id = scan.id
       ),
       completed_at = statement_timestamp(),
       expires_at = statement_timestamp() + interval '24 hours'
 WHERE scan.tenant_id = $1::uuid AND scan.id = $2::uuid
RETURNING scan.id::text, scan.status, scan.subscriber_count,
          scan.candidate_count, scan.created_at, scan.completed_at,
          scan.expires_at`, tenantID, scan.ID).Scan(
		&scan.ID, &scan.Status, &scan.SubscriberCount, &scan.CandidateCount,
		&scan.CreatedAt, &scan.CompletedAt, &scan.ExpiresAt,
	); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	scan.Complete = scan.Status == "complete"
	return &scan, nil
}

func loadScan(ctx context.Context, tx pgx.Tx, tenantID, scanID string) (*Scan, error) {
	var scan Scan
	err := tx.QueryRow(ctx, `
SELECT id::text, status, subscriber_count, candidate_count,
       created_at, completed_at, expires_at
  FROM subscriber_duplicate_scans
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, scanID).Scan(
		&scan.ID, &scan.Status, &scan.SubscriberCount, &scan.CandidateCount,
		&scan.CreatedAt, &scan.CompletedAt, &scan.ExpiresAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errScanNotFound
	}
	if err != nil {
		return nil, err
	}
	if !scan.ExpiresAt.After(time.Now()) {
		return nil, errScanExpired
	}
	scan.Complete = scan.Status == "complete"
	return &scan, nil
}

func (d *Deps) loadScanPage(ctx context.Context, tenantID, scanID string, cursor int64, limit int) (*scanPage, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	scan, err := loadScan(ctx, tx, tenantID, scanID)
	if err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT pairs.ordinal,
       pairs.primary_id::text,
       COALESCE(primary_row.email::text, ''),
       pairs.duplicate_id::text,
       COALESCE(duplicate_row.email::text, ''),
       pairs.primary_updated_at,
       pairs.duplicate_updated_at,
       pairs.confidence::float8,
       pairs.evidence,
       primary_row.id IS NULL OR duplicate_row.id IS NULL OR
       primary_row.updated_at IS DISTINCT FROM pairs.primary_updated_at OR
       duplicate_row.updated_at IS DISTINCT FROM pairs.duplicate_updated_at OR
       (COALESCE(primary_row.custom_fields, '{}'::jsonb) ? 'merged_into') OR
       (COALESCE(duplicate_row.custom_fields, '{}'::jsonb) ? 'merged_into') AS stale
  FROM subscriber_duplicate_scan_pairs pairs
  LEFT JOIN subscribers primary_row
    ON primary_row.tenant_id = pairs.tenant_id AND primary_row.id = pairs.primary_id
  LEFT JOIN subscribers duplicate_row
    ON duplicate_row.tenant_id = pairs.tenant_id AND duplicate_row.id = pairs.duplicate_id
 WHERE pairs.tenant_id = $1::uuid AND pairs.scan_id = $2::uuid
   AND pairs.ordinal > $3
 ORDER BY pairs.ordinal
 LIMIT $4`, tenantID, scanID, cursor, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	pairs := make([]ScanPair, 0, limit)
	var lastOrdinal int64
	for rows.Next() {
		var pair ScanPair
		var evidenceRaw []byte
		var ordinal int64
		if err := rows.Scan(
			&ordinal, &pair.PrimaryID, &pair.PrimaryEmail,
			&pair.DuplicateID, &pair.DuplicateEmail,
			&pair.PrimaryUpdatedAt, &pair.DuplicateUpdatedAt,
			&pair.Confidence, &evidenceRaw, &pair.Stale,
		); err != nil {
			return nil, err
		}
		if len(pairs) == limit {
			break
		}
		if err := json.Unmarshal(evidenceRaw, &pair.Evidence); err != nil || len(pair.Evidence) == 0 {
			return nil, errors.New("invalid duplicate scan evidence")
		}
		pair.Kind = pair.Evidence[0].Kind
		pairs = append(pairs, pair)
		lastOrdinal = ordinal
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	hasMore := int64(cursor+int64(len(pairs))) < scan.CandidateCount
	nextCursor := ""
	if hasMore && len(pairs) > 0 {
		nextCursor = strconv.FormatInt(lastOrdinal, 10)
	}
	return &scanPage{
		Scan:       *scan,
		Pairs:      pairs,
		Count:      scan.CandidateCount,
		NextCursor: nextCursor,
		Complete:   scan.Complete,
	}, nil
}

// materializeScanPairsSQL deliberately contains only deterministic,
// index-backed equivalence signals. The former edit-distance rule was both
// sampled and unsafe for automatic identity conclusions; it is not part of
// this complete manifest. Each key cluster chooses its oldest row as the
// suggested primary, then emits each other row once. Multiple rules for the
// same pair become an ordered evidence array rather than duplicate cards.
const materializeScanPairsSQL = `
WITH active AS MATERIALIZED (
    SELECT keys.*
      FROM subscriber_dedupe_keys keys
      JOIN subscribers subscriber
        ON subscriber.tenant_id = keys.tenant_id
       AND subscriber.id = keys.subscriber_id
     WHERE keys.tenant_id = $1::uuid
       AND subscriber.archived_at IS NULL
       AND NOT (COALESCE(subscriber.custom_fields, '{}'::jsonb) ? 'merged_into')
),
email_ranked AS (
    SELECT active.*,
           first_value(subscriber_id) OVER email_window AS primary_id,
           row_number() OVER email_window AS row_number,
           count(*) OVER (PARTITION BY email_key) AS group_count
      FROM active
    WINDOW email_window AS (
        PARTITION BY email_key
        ORDER BY subscriber_created_at, subscriber_id
    )
),
plus_ranked AS (
    SELECT active.*,
           first_value(subscriber_id) OVER plus_window AS primary_id,
           row_number() OVER plus_window AS row_number,
           bool_or(plus_changed) OVER (PARTITION BY plus_key) AS group_changed
      FROM active
    WINDOW plus_window AS (
        PARTITION BY plus_key
        ORDER BY subscriber_created_at, subscriber_id
    )
),
dot_ranked AS (
    SELECT active.*,
           first_value(subscriber_id) OVER dot_window AS primary_id,
           row_number() OVER dot_window AS row_number,
           bool_or(dot_changed) OVER (PARTITION BY dot_key) AS group_changed
      FROM active
    WINDOW dot_window AS (
        PARTITION BY dot_key
        ORDER BY subscriber_created_at, subscriber_id
    )
),
domain_ranked AS (
    SELECT active.*,
           first_value(subscriber_id) OVER domain_window AS primary_id,
           row_number() OVER domain_window AS row_number,
           bool_or(domain_changed) OVER (PARTITION BY domain_key) AS group_changed
      FROM active
    WINDOW domain_window AS (
        PARTITION BY domain_key
        ORDER BY subscriber_created_at, subscriber_id
    )
),
homoglyph_ranked AS (
    SELECT active.*,
           first_value(subscriber_id) OVER homoglyph_window AS primary_id,
           row_number() OVER homoglyph_window AS row_number,
           bool_or(homoglyph_changed) OVER (PARTITION BY homoglyph_key) AS group_changed
      FROM active
    WINDOW homoglyph_window AS (
        PARTITION BY homoglyph_key
        ORDER BY subscriber_created_at, subscriber_id
    )
),
phone_ranked AS (
    SELECT active.*,
           first_value(subscriber_id) OVER phone_window AS primary_id,
           row_number() OVER phone_window AS row_number
      FROM active
     WHERE phone_key IS NOT NULL
    WINDOW phone_window AS (
        PARTITION BY phone_key
        ORDER BY subscriber_created_at, subscriber_id
    )
),
external_ranked AS (
    SELECT active.*,
           first_value(subscriber_id) OVER external_window AS primary_id,
           row_number() OVER external_window AS row_number
      FROM active
     WHERE external_id_key IS NOT NULL
    WINDOW external_window AS (
        PARTITION BY external_id_key
        ORDER BY subscriber_created_at, subscriber_id
    )
),
evidence AS (
    SELECT primary_id, subscriber_id AS duplicate_id,
           'case_diff'::text AS kind, 1.000::numeric AS confidence,
           'The stored email addresses normalize to the same case-insensitive value.'::text AS reason
      FROM email_ranked WHERE row_number > 1 AND group_count > 1
    UNION ALL
    SELECT primary_id, subscriber_id, 'plus_alias', 0.900,
           'Removing a plus-address suffix resolves both rows to the same mailbox.'
      FROM plus_ranked WHERE row_number > 1 AND group_changed
    UNION ALL
    SELECT primary_id, subscriber_id, 'dot_alias', 0.850,
           'Gmail dot normalization resolves both rows to the same mailbox.'
      FROM dot_ranked WHERE row_number > 1 AND group_changed
    UNION ALL
    SELECT primary_id, subscriber_id, 'domain_substitution', 0.950,
           'Provider-equivalent email domains resolve both rows to the same address.'
      FROM domain_ranked WHERE row_number > 1 AND group_changed
    UNION ALL
    SELECT primary_id, subscriber_id, 'homoglyph', 0.800,
           'Confusable look-alike characters normalize to the same email address.'
      FROM homoglyph_ranked WHERE row_number > 1 AND group_changed
    UNION ALL
    SELECT primary_id, subscriber_id, 'phone_collision', 0.900,
           'Both rows have the same non-empty normalized phone identifier.'
      FROM phone_ranked WHERE row_number > 1
    UNION ALL
    SELECT primary_id, subscriber_id, 'external_id_collision', 1.000,
           'Both rows claim the same non-empty upstream profile identifier.'
      FROM external_ranked WHERE row_number > 1
),
collapsed AS (
    SELECT evidence.primary_id, evidence.duplicate_id,
           max(evidence.confidence) AS confidence,
           jsonb_agg(
               jsonb_build_object(
                   'kind', evidence.kind,
                   'confidence', evidence.confidence,
                   'reason', evidence.reason
               ) ORDER BY evidence.confidence DESC, evidence.kind
           ) AS evidence
      FROM evidence
     WHERE evidence.primary_id <> evidence.duplicate_id
     GROUP BY evidence.primary_id, evidence.duplicate_id
),
ordered AS (
    SELECT collapsed.*,
           primary_key.subscriber_updated_at AS primary_updated_at,
           duplicate_key.subscriber_updated_at AS duplicate_updated_at,
           row_number() OVER (
               ORDER BY primary_key.subscriber_created_at,
                        collapsed.primary_id,
                        duplicate_key.subscriber_created_at,
                        collapsed.duplicate_id
           ) AS ordinal
      FROM collapsed
      JOIN active primary_key ON primary_key.subscriber_id = collapsed.primary_id
      JOIN active duplicate_key ON duplicate_key.subscriber_id = collapsed.duplicate_id
)
INSERT INTO subscriber_duplicate_scan_pairs (
    tenant_id, scan_id, ordinal, primary_id, duplicate_id,
    primary_updated_at, duplicate_updated_at, confidence, evidence
)
SELECT $1::uuid, $2::uuid, ordinal, primary_id, duplicate_id,
       primary_updated_at, duplicate_updated_at, confidence, evidence
  FROM ordered
 ORDER BY ordinal`
