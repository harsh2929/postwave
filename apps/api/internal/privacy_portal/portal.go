// SPDX-License-Identifier: AGPL-3.0-only
//
// Package privacy_portal is the centralised view that Braze ships as
// "Privacy Portal" — one screen that answers "what is the privacy
// state of this tenant right now?" without making the operator stitch
// together three half-built dashboards. It assembles its read model
// from rows that already exist elsewhere (privacy_regions,
// privacy_requests, subscriber_suppressions, consent_records,
// subscriber_privacy_flags) and exposes per-region CRUD so the
// operator can declare which framework applies to a new market.
//
// We split the read assembly (Summary) from the per-region admin
// (RegionRepo) so the summary view is cheap (5 SELECTs, no joins
// across tenant boundaries) even when the regions table grows.

package privacy_portal

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Errors surfaced to handlers so HTTP layer can map status codes.
var (
	ErrRegionConflict    = errors.New("region_code already exists for tenant")
	ErrRegionNotFound    = errors.New("region not found")
	ErrInvalidFramework  = errors.New("framework must be one of gdpr|ccpa|lgpd|pipeda|apo|other")
	ErrInvalidRegionCode = errors.New("region_code must be 2-44 uppercase letters, digits, or hyphen-delimited segments")
)

var regionCodeRE = regexp.MustCompile(`^[A-Z0-9]{2,8}(?:-[A-Z0-9]{1,8})*$`)

// validFrameworks mirrors the CHECK constraint on privacy_regions.framework.
// Keep in lockstep with migration 0254.
var validFrameworks = map[string]struct{}{
	"gdpr":   {},
	"ccpa":   {},
	"lgpd":   {},
	"pipeda": {},
	"apo":    {},
	"other":  {},
}

// Region is one row of privacy_regions surfaced to the UI.
type Region struct {
	ID                      string    `json:"id"`
	TenantID                string    `json:"tenantId"`
	RegionCode              string    `json:"region_code"`
	Framework               string    `json:"framework"`
	RequiresDoubleOptIn     bool      `json:"requires_double_optin"`
	RequiresExplicitConsent bool      `json:"requires_explicit_consent"`
	DoNotSellDefault        bool      `json:"do_not_sell_default"`
	GPCHonored              bool      `json:"gpc_honored"`
	CreatedAt               time.Time `json:"created_at"`
	UpdatedAt               time.Time `json:"updated_at"`
}

// RegionInput is the create/update body the portal accepts.
type RegionInput struct {
	RegionCode              string `json:"region_code"`
	Framework               string `json:"framework"`
	RequiresDoubleOptIn     bool   `json:"requires_double_optin"`
	RequiresExplicitConsent bool   `json:"requires_explicit_consent"`
	DoNotSellDefault        bool   `json:"do_not_sell_default"`
	GPCHonored              bool   `json:"gpc_honored"`
}

// SuppressionBreakdown is the count-per-reason tile on the portal.
type SuppressionBreakdown struct {
	Reason string `json:"reason"`
	Count  int64  `json:"count"`
}

// DSARSummary collapses privacy_requests into open/overdue/closed counters
// per request_type — the same shape Braze's portal renders.
type DSARSummary struct {
	RequestType string `json:"request_type"`
	Open        int64  `json:"open"`
	Overdue     int64  `json:"overdue"`
	Closed      int64  `json:"closed"`
}

// ConsentProofSummary tells the operator how much capturable proof they
// have on hand if a regulator asks. Per-source counts so they can
// answer "show me CSV-imported consent" or "show me form-captured
// consent" without writing SQL.
type ConsentProofSummary struct {
	Source string `json:"source"`
	Count  int64  `json:"count"`
}

// Summary is the response shape for GET /api/v1/privacy/portal.
type Summary struct {
	TenantID             string                 `json:"tenantId"`
	Regions              []Region               `json:"regions"`
	DSARRequests         []DSARSummary          `json:"dsar_requests"`
	SuppressionBreakdown []SuppressionBreakdown `json:"suppression_breakdown"`
	ConsentProofSummary  []ConsentProofSummary  `json:"consent_proof_summary"`
	GPCSignaledCount     int64                  `json:"gpc_signaled_count"`
	DoNotSellCount       int64                  `json:"do_not_sell_count"`
	DoubleOptInPending   int64                  `json:"double_optin_pending"`
	GeneratedAt          time.Time              `json:"generated_at"`
}

// Repo is the data-access layer for the portal. All methods route
// through db.WithTenant so RLS clamps reads + writes to the caller.
type Repo struct {
	Pool *db.Pool
}

// Validate normalises a RegionInput in place and returns an error if
// it can't be saved.
func (in *RegionInput) Validate() error {
	in.RegionCode = strings.ToUpper(strings.TrimSpace(in.RegionCode))
	in.Framework = strings.ToLower(strings.TrimSpace(in.Framework))
	if !regionCodeRE.MatchString(in.RegionCode) {
		return ErrInvalidRegionCode
	}
	if _, ok := validFrameworks[in.Framework]; !ok {
		return ErrInvalidFramework
	}
	return nil
}

// ListRegions returns every region row for the tenant ordered by code.
func (r *Repo) ListRegions(ctx context.Context, tenantID string) ([]Region, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, region_code, framework,
       requires_double_optin, requires_explicit_consent,
       do_not_sell_default, gpc_honored,
       created_at, updated_at
  FROM privacy_regions
 WHERE tenant_id = $1::uuid
 ORDER BY region_code ASC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Region{}
	for rows.Next() {
		var rg Region
		if err := rows.Scan(&rg.ID, &rg.RegionCode, &rg.Framework,
			&rg.RequiresDoubleOptIn, &rg.RequiresExplicitConsent,
			&rg.DoNotSellDefault, &rg.GPCHonored,
			&rg.CreatedAt, &rg.UpdatedAt); err != nil {
			return nil, err
		}
		rg.TenantID = tenantID
		out = append(out, rg)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// CreateRegion inserts a new privacy_regions row. Returns
// ErrRegionConflict on (tenant_id, region_code) duplicates so the
// handler can map to 409.
func (r *Repo) CreateRegion(ctx context.Context, tenantID string, in RegionInput, auditMeta db.AuditMeta) (*Region, error) {
	if err := (&in).Validate(); err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var rg Region
	err = tx.QueryRow(ctx, `
INSERT INTO privacy_regions
  (tenant_id, region_code, framework,
   requires_double_optin, requires_explicit_consent,
   do_not_sell_default, gpc_honored)
VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
RETURNING id::text, region_code, framework,
          requires_double_optin, requires_explicit_consent,
          do_not_sell_default, gpc_honored,
          created_at, updated_at`,
		tenantID, in.RegionCode, in.Framework,
		in.RequiresDoubleOptIn, in.RequiresExplicitConsent,
		in.DoNotSellDefault, in.GPCHonored).Scan(
		&rg.ID, &rg.RegionCode, &rg.Framework,
		&rg.RequiresDoubleOptIn, &rg.RequiresExplicitConsent,
		&rg.DoNotSellDefault, &rg.GPCHonored,
		&rg.CreatedAt, &rg.UpdatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return nil, ErrRegionConflict
		}
		return nil, err
	}
	rg.TenantID = tenantID
	if err := db.Audit(ctx, tx, auditMeta, "privacy.portal.region.create", "privacy_region", rg.ID, map[string]any{
		"region_code":    rg.RegionCode,
		"framework":      rg.Framework,
		"route_template": "/api/v1/privacy/portal/regions",
	}); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &rg, nil
}

// DeleteRegion removes a region. Returns ErrRegionNotFound when the
// id doesn't match anything visible to the tenant.
func (r *Repo) DeleteRegion(ctx context.Context, tenantID, id string, auditMeta db.AuditMeta) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var deletedID, regionCode, framework string
	err = tx.QueryRow(ctx, `
DELETE FROM privacy_regions
 WHERE id = $1::uuid
 RETURNING id::text, region_code, framework`, id).Scan(&deletedID, &regionCode, &framework)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "22P02" {
			return ErrRegionNotFound
		}
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrRegionNotFound
		}
		return err
	}
	if err := db.Audit(ctx, tx, auditMeta, "privacy.portal.region.delete", "privacy_region", deletedID, map[string]any{
		"region_code":    regionCode,
		"framework":      framework,
		"route_template": "/api/v1/privacy/portal/regions/{id}",
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// LoadSummary assembles the portal read model in a single tenant-scoped
// tx. Each tile is its own SELECT so a slow privacy_requests table
// doesn't drag down the suppression breakdown.
func (r *Repo) LoadSummary(ctx context.Context, tenantID string) (*Summary, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out := &Summary{TenantID: tenantID, GeneratedAt: time.Now().UTC()}
	regions, err := loadRegionsTx(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	out.Regions = regions
	dsar, err := loadDSARSummary(ctx, tx)
	if err != nil {
		return nil, err
	}
	out.DSARRequests = dsar
	supp, err := loadSuppressionBreakdown(ctx, tx)
	if err != nil {
		return nil, err
	}
	out.SuppressionBreakdown = supp
	consent, err := loadConsentProofSummary(ctx, tx)
	if err != nil {
		return nil, err
	}
	out.ConsentProofSummary = consent
	gpc, dns, err := loadPrivacyFlagCounts(ctx, tx)
	if err != nil {
		return nil, err
	}
	out.GPCSignaledCount = gpc
	out.DoNotSellCount = dns
	pending, err := loadDoubleOptInPending(ctx, tx)
	if err != nil {
		return nil, err
	}
	out.DoubleOptInPending = pending
	return out, tx.Commit(ctx)
}

func loadRegionsTx(ctx context.Context, tx pgx.Tx, tenantID string) ([]Region, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text, region_code, framework,
       requires_double_optin, requires_explicit_consent,
       do_not_sell_default, gpc_honored,
       created_at, updated_at
  FROM privacy_regions
 ORDER BY region_code ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Region{}
	for rows.Next() {
		var rg Region
		if err := rows.Scan(&rg.ID, &rg.RegionCode, &rg.Framework,
			&rg.RequiresDoubleOptIn, &rg.RequiresExplicitConsent,
			&rg.DoNotSellDefault, &rg.GPCHonored,
			&rg.CreatedAt, &rg.UpdatedAt); err != nil {
			return nil, err
		}
		rg.TenantID = tenantID
		out = append(out, rg)
	}
	return out, rows.Err()
}

// loadDSARSummary buckets privacy_requests into open / overdue / closed
// per request_type. Open = neither completed nor fulfilled; overdue =
// open AND due_at < now; closed = completed_at IS NOT NULL.
func loadDSARSummary(ctx context.Context, tx pgx.Tx) ([]DSARSummary, error) {
	rows, err := tx.Query(ctx, `
SELECT request_type,
       COUNT(*) FILTER (WHERE completed_at IS NULL) AS open,
       COUNT(*) FILTER (WHERE completed_at IS NULL AND due_at IS NOT NULL AND due_at < now()) AS overdue,
       COUNT(*) FILTER (WHERE completed_at IS NOT NULL) AS closed
  FROM privacy_requests
 GROUP BY request_type
	 ORDER BY request_type ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DSARSummary{}
	for rows.Next() {
		var d DSARSummary
		if err := rows.Scan(&d.RequestType, &d.Open, &d.Overdue, &d.Closed); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// loadSuppressionBreakdown groups subscriber_suppressions (the X1
// canonical table the converger reads on the send hot path) by reason.
func loadSuppressionBreakdown(ctx context.Context, tx pgx.Tx) ([]SuppressionBreakdown, error) {
	rows, err := tx.Query(ctx, `
SELECT reason, COUNT(*)
  FROM subscriber_suppressions
 GROUP BY reason
	 ORDER BY COUNT(*) DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SuppressionBreakdown{}
	for rows.Next() {
		var s SuppressionBreakdown
		if err := rows.Scan(&s.Reason, &s.Count); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func loadConsentProofSummary(ctx context.Context, tx pgx.Tx) ([]ConsentProofSummary, error) {
	rows, err := tx.Query(ctx, `
SELECT source, COUNT(*)
  FROM consent_records
 GROUP BY source
	 ORDER BY COUNT(*) DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ConsentProofSummary{}
	for rows.Next() {
		var s ConsentProofSummary
		if err := rows.Scan(&s.Source, &s.Count); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

func loadPrivacyFlagCounts(ctx context.Context, tx pgx.Tx) (int64, int64, error) {
	var gpc, dns int64
	err := tx.QueryRow(ctx, `
SELECT
  COUNT(*) FILTER (WHERE gpc_signaled = true) AS gpc,
  COUNT(*) FILTER (WHERE do_not_sell = true) AS dns
  FROM subscriber_privacy_flags`).Scan(&gpc, &dns)
	if err != nil {
		return 0, 0, err
	}
	return gpc, dns, nil
}

func loadDoubleOptInPending(ctx context.Context, tx pgx.Tx) (int64, error) {
	var n int64
	err := tx.QueryRow(ctx, `
SELECT COUNT(*)
  FROM double_optin_pending
 WHERE confirmed_at IS NULL
   AND expires_at > now()`).Scan(&n)
	if err != nil {
		return 0, err
	}
	return n, nil
}

// isMissingRelation is used only for presentation-only preference-center
// defaults. Compliance evidence and pending-confirmation reads must propagate
// missing schema as unavailable, never as a verified empty/zero claim.
func isMissingRelation(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "42P01" {
		return true
	}
	return false
}
