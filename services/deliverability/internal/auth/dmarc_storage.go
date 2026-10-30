// Postgres-backed storage for parsed DMARC aggregate reports.
//
// One Persist() call writes the parent dmarc_aggregate_reports row plus
// every dmarc_aggregate_records row inside a single transaction so a
// crash mid-flight cannot leave a half-ingested report. The (tenant_id,
// org_name, report_id) UNIQUE makes re-running the same poll idempotent:
// the second insert hits ON CONFLICT DO NOTHING and Persist returns the
// existing report id with isDuplicate=true so the caller can mark the
// IMAP message Seen without re-processing.
//
// All queries set app.tenant_id first so RLS scopes both tables.

package auth

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Store is the Postgres-backed writer for DMARC aggregate reports.
type Store struct {
	Pool *pgxpool.Pool
}

// NewStore constructs a Store. Returns an error if the pool is nil so we
// fail loudly at startup rather than NPE on the first Persist call.
func NewStore(p *pgxpool.Pool) (*Store, error) {
	if p == nil {
		return nil, errors.New("dmarc storage: nil pgx pool")
	}
	return &Store{Pool: p}, nil
}

// PersistedReport is the row shape returned by ListReports / GetReport.
type PersistedReport struct {
	ID              string    `json:"id"`
	TenantID        string    `json:"tenant_id"`
	OrgName         string    `json:"org_name"`
	ReportID        string    `json:"report_id"`
	DateRangeBegin  time.Time `json:"date_range_begin"`
	DateRangeEnd    time.Time `json:"date_range_end"`
	Domain          string    `json:"domain"`
	PolicyP         string    `json:"policy_p"`
	PolicySP        string    `json:"policy_sp"`
	PolicyPct       int       `json:"policy_pct"`
	IngestedAt      time.Time `json:"ingested_at"`
	SourceMessageID string    `json:"source_message_id"`
}

// PersistedRecord is one source-IP row inside a report.
type PersistedRecord struct {
	ID           string `json:"id"`
	ReportID     string `json:"report_id"`
	SourceIP     string `json:"source_ip"`
	Count        int    `json:"count"`
	Disposition  string `json:"disposition"`
	DKIMResult   string `json:"dkim_result"`
	SPFResult    string `json:"spf_result"`
	HeaderFrom   string `json:"header_from"`
	EnvelopeFrom string `json:"envelope_from"`
	EnvelopeTo   string `json:"envelope_to"`
}

// ReportDetail is what GetReport returns: the parent + its records.
type ReportDetail struct {
	Report  PersistedReport   `json:"report"`
	Records []PersistedRecord `json:"records"`
}

// Stats are the aggregate pass/fail counters used by the dashboard.
type Stats struct {
	TotalReports int `json:"total_reports"`
	TotalRecords int `json:"total_records"`
	TotalCount   int `json:"total_count"`
	DKIMPass     int `json:"dkim_pass"`
	DKIMFail     int `json:"dkim_fail"`
	SPFPass      int `json:"spf_pass"`
	SPFFail      int `json:"spf_fail"`
	PassCount    int `json:"pass_count"` // both DKIM+SPF pass
	FailCount    int `json:"fail_count"` // either failed
}

// Persist writes a parsed report and its records inside one transaction.
// If a row with the same (tenant_id, org_name, report_id) already exists
// the existing id is returned with isDuplicate=true and no records are
// re-inserted (the records are tied to the prior id by FK). The caller
// should treat duplicate-true as a success path — typically: mark the
// IMAP message Seen, increment the counter with result=duplicate, move on.
func (s *Store) Persist(
	ctx context.Context,
	tenantID string,
	parsed *Report,
	sourceMessageID string,
) (reportID string, isDuplicate bool, err error) {
	if tenantID == "" {
		return "", false, errors.New("dmarc storage: tenant id required")
	}
	if parsed == nil {
		return "", false, errors.New("dmarc storage: nil parsed report")
	}

	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Re-marshal raw XML so re-parsing later doesn't depend on the original
	// network buffer. We keep this as bytea + nullable; if the caller hasn't
	// stashed the raw bytes onto the parsed report we just write NULL.
	var rawXML []byte // currently nil; the parser doesn't carry the original
	pct := parsePct(parsed.PolicyPub.Pct)

	// First-write path: ON CONFLICT DO NOTHING. If a row already exists the
	// RETURNING is empty and we fall through to the SELECT to recover the id.
	var newID string
	err = tx.QueryRow(ctx, `
		INSERT INTO dmarc_aggregate_reports (
			tenant_id, org_name, report_id,
			date_range_begin, date_range_end,
			domain, policy_p, policy_sp, policy_pct,
			raw_xml, source_message_id
		) VALUES (
			$1::uuid, $2, $3,
			$4, $5,
			$6, $7, $8, $9,
			$10, $11
		)
		ON CONFLICT (tenant_id, org_name, report_id) DO NOTHING
		RETURNING id::text
	`,
		tenantID,
		parsed.ReportMeta.OrgName,
		parsed.ReportMeta.ReportID,
		parsed.ReportMeta.BeginAt,
		parsed.ReportMeta.EndAt,
		parsed.PolicyPub.Domain,
		nullableStr(parsed.PolicyPub.P),
		nullableStr(parsed.PolicyPub.SP),
		nullablePct(pct),
		nullableBytes(rawXML),
		nullableStr(sourceMessageID),
	).Scan(&newID)

	if err == nil {
		// First-write success: insert records, commit.
		if err := insertRecords(ctx, tx, newID, parsed); err != nil {
			return "", false, err
		}
		if err := tx.Commit(ctx); err != nil {
			return "", false, fmt.Errorf("dmarc storage: commit: %w", err)
		}
		return newID, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", false, fmt.Errorf("dmarc storage: insert report: %w", err)
	}

	// Duplicate path — recover the existing id. Records were already inserted
	// during the prior successful Persist; do not double-insert.
	var existingID string
	if err := tx.QueryRow(ctx, `
		SELECT id::text FROM dmarc_aggregate_reports
		WHERE tenant_id = $1::uuid AND org_name = $2 AND report_id = $3
	`, tenantID, parsed.ReportMeta.OrgName, parsed.ReportMeta.ReportID).Scan(&existingID); err != nil {
		return "", false, fmt.Errorf("dmarc storage: recover existing id: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return "", false, fmt.Errorf("dmarc storage: commit duplicate: %w", err)
	}
	return existingID, true, nil
}

// insertRecords writes all records for a freshly-inserted report.
//
// We use a simple per-row INSERT here rather than COPY; the per-report
// record count is small (typically <50) and COPY can't easily participate
// in the same RLS-scoped transaction with a single tenant_id setting.
func insertRecords(ctx context.Context, tx pgx.Tx, reportID string, parsed *Report) error {
	for i := range parsed.Records {
		r := &parsed.Records[i]
		var dkim, spf string
		// Store the DMARC-EVALUATED (aligned) dkim/spf from
		// `policy_evaluated`, NOT the raw auth_results. collapseAuthResult
		// over auth_results returns "pass" if ANY signature passed —
		// including a forwarder's or spoofer's own d= domain signature that
		// is NOT aligned with the header From — which inflated alignedPct
		// and the p=quarantine/reject ramp advisor (D10#2). Fall back to the
		// raw collapse only if policy_evaluated is absent.
		dkim = strings.ToLower(strings.TrimSpace(r.Row.Policy.DKIM))
		if dkim == "" {
			dkim = collapseAuthResult(authResults(r, "dkim"))
		}
		spf = strings.ToLower(strings.TrimSpace(r.Row.Policy.SPF))
		if spf == "" {
			spf = collapseAuthResult(authResults(r, "spf"))
		}

		_, err := tx.Exec(ctx, `
			INSERT INTO dmarc_aggregate_records (
				report_id, source_ip, count,
				disposition, dkim_result, spf_result,
				header_from, envelope_from, envelope_to
			) VALUES (
				$1::uuid, $2::inet, $3,
				$4, $5, $6,
				$7, $8, $9
			)
		`,
			reportID,
			r.Row.SourceIP,
			r.Row.Count,
			nullableStr(r.Row.Policy.Disposition),
			nullableStr(dkim),
			nullableStr(spf),
			nullableStr(r.Identifiers.HeaderFrom),
			nil, // envelope_from not in current parser surface
			nil, // envelope_to not in current parser surface
		)
		if err != nil {
			return fmt.Errorf("dmarc storage: insert record %d: %w", i, err)
		}
	}
	return nil
}

// authResults pulls the slice of result strings for either dkim or spf.
// Returns nil if the type is unrecognised.
func authResults(r *DMARCRecord, kind string) []string {
	switch kind {
	case "dkim":
		out := make([]string, 0, len(r.AuthResults.DKIM))
		for _, x := range r.AuthResults.DKIM {
			out = append(out, x.Result)
		}
		return out
	case "spf":
		out := make([]string, 0, len(r.AuthResults.SPF))
		for _, x := range r.AuthResults.SPF {
			out = append(out, x.Result)
		}
		return out
	}
	return nil
}

// collapseAuthResult: pass if any pass, fail if any reported but no pass,
// empty if no entries.
func collapseAuthResult(rs []string) string {
	if len(rs) == 0 {
		return ""
	}
	for _, r := range rs {
		if r == "pass" {
			return "pass"
		}
	}
	return "fail"
}

// ListReports returns paginated reports for a tenant, newest end-date first.
func (s *Store) ListReports(ctx context.Context, tenantID string, limit, offset int) ([]PersistedReport, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
		SELECT id::text, tenant_id::text, org_name, report_id,
		       date_range_begin, date_range_end,
		       domain,
		       COALESCE(policy_p, ''),
		       COALESCE(policy_sp, ''),
		       COALESCE(policy_pct, 0),
		       ingested_at,
		       COALESCE(source_message_id, '')
		  FROM dmarc_aggregate_reports
		 WHERE tenant_id = $1::uuid
		 ORDER BY date_range_end DESC, ingested_at DESC
		 LIMIT $2 OFFSET $3
	`, tenantID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("dmarc storage: list reports: %w", err)
	}
	defer rows.Close()

	out := make([]PersistedReport, 0, limit)
	for rows.Next() {
		var p PersistedReport
		if err := rows.Scan(
			&p.ID, &p.TenantID, &p.OrgName, &p.ReportID,
			&p.DateRangeBegin, &p.DateRangeEnd,
			&p.Domain, &p.PolicyP, &p.PolicySP, &p.PolicyPct,
			&p.IngestedAt, &p.SourceMessageID,
		); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// GetReport fetches the parent row + all records joined.
func (s *Store) GetReport(ctx context.Context, tenantID, id string) (*ReportDetail, error) {
	if id == "" {
		return nil, errors.New("dmarc storage: id required")
	}
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var p PersistedReport
	err = tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, org_name, report_id,
		       date_range_begin, date_range_end,
		       domain,
		       COALESCE(policy_p, ''),
		       COALESCE(policy_sp, ''),
		       COALESCE(policy_pct, 0),
		       ingested_at,
		       COALESCE(source_message_id, '')
		  FROM dmarc_aggregate_reports
		 WHERE id = $1::uuid AND tenant_id = $2::uuid
	`, id, tenantID).Scan(
		&p.ID, &p.TenantID, &p.OrgName, &p.ReportID,
		&p.DateRangeBegin, &p.DateRangeEnd,
		&p.Domain, &p.PolicyP, &p.PolicySP, &p.PolicyPct,
		&p.IngestedAt, &p.SourceMessageID,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("dmarc storage: report %s not found", id)
		}
		return nil, err
	}

	rows, err := tx.Query(ctx, `
		SELECT id::text, report_id::text, host(source_ip), count,
		       COALESCE(disposition, ''),
		       COALESCE(dkim_result, ''),
		       COALESCE(spf_result, ''),
		       COALESCE(header_from, ''),
		       COALESCE(envelope_from, ''),
		       COALESCE(envelope_to, '')
		  FROM dmarc_aggregate_records
		 WHERE report_id = $1::uuid
		 ORDER BY count DESC, source_ip
	`, id)
	if err != nil {
		return nil, fmt.Errorf("dmarc storage: list records: %w", err)
	}
	defer rows.Close()

	out := &ReportDetail{Report: p, Records: make([]PersistedRecord, 0)}
	for rows.Next() {
		var rec PersistedRecord
		if err := rows.Scan(
			&rec.ID, &rec.ReportID, &rec.SourceIP, &rec.Count,
			&rec.Disposition, &rec.DKIMResult, &rec.SPFResult,
			&rec.HeaderFrom, &rec.EnvelopeFrom, &rec.EnvelopeTo,
		); err != nil {
			return nil, err
		}
		out.Records = append(out.Records, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// Stats returns aggregate pass/fail counters across reports whose
// date_range_end is at or after `since`. Used by the dashboard to
// chart authentication health over a window.
func (s *Store) Stats(ctx context.Context, tenantID string, since time.Time) (*Stats, error) {
	tx, err := s.beginTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	st := &Stats{}
	if err := tx.QueryRow(ctx, `
		WITH scoped AS (
			SELECT r.id
			  FROM dmarc_aggregate_reports r
			 WHERE r.tenant_id = $1::uuid AND r.date_range_end >= $2
		)
		SELECT
			(SELECT COUNT(*) FROM scoped),
			COALESCE(COUNT(rec.id), 0),
			COALESCE(SUM(rec.count), 0),
			COALESCE(SUM(rec.count) FILTER (WHERE rec.dkim_result = 'pass'), 0),
			COALESCE(SUM(rec.count) FILTER (WHERE rec.dkim_result = 'fail'), 0),
			COALESCE(SUM(rec.count) FILTER (WHERE rec.spf_result  = 'pass'), 0),
			COALESCE(SUM(rec.count) FILTER (WHERE rec.spf_result  = 'fail'), 0),
			COALESCE(SUM(rec.count) FILTER (WHERE rec.dkim_result = 'pass' AND rec.spf_result = 'pass'), 0),
			COALESCE(SUM(rec.count) FILTER (WHERE rec.dkim_result <> 'pass' OR  rec.spf_result <> 'pass'), 0)
		  FROM scoped
		  LEFT JOIN dmarc_aggregate_records rec ON rec.report_id = scoped.id
	`, tenantID, since).Scan(
		&st.TotalReports, &st.TotalRecords, &st.TotalCount,
		&st.DKIMPass, &st.DKIMFail, &st.SPFPass, &st.SPFFail,
		&st.PassCount, &st.FailCount,
	); err != nil {
		return nil, fmt.Errorf("dmarc storage: stats: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return st, nil
}

// beginTenant opens a transaction with app.tenant_id set so RLS scopes
// every read & write that follows.
func (s *Store) beginTenant(ctx context.Context, tenantID string) (pgx.Tx, error) {
	if tenantID == "" {
		return nil, errors.New("dmarc storage: tenant id required")
	}
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// parsePct converts the textual `pct` field on PolicyPublished into an int.
// We tolerate empty / non-numeric values rather than fail the whole insert.
func parsePct(s string) int {
	if s == "" {
		return 0
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return n
}

func nullableStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullableBytes(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return b
}

func nullablePct(n int) any {
	if n <= 0 {
		return nil
	}
	return n
}
