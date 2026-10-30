// SPDX-License-Identifier: AGPL-3.0-only
package dmarc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Report is the bounded public projection of one dmarc_aggregate_reports row.
// ID is the aggregate report's UUID. PolicyPct is legacy report evidence only;
// it is never used to generate policy-change advice.
type Report struct {
	ID         string    `json:"id"`
	OrgName    string    `json:"orgName"`
	ReportID   string    `json:"reportId"`
	Domain     string    `json:"domain"`
	PolicyP    string    `json:"policyP"`
	PolicyPct  *int      `json:"policyPct"`
	DateBegin  time.Time `json:"dateBegin"`
	DateEnd    time.Time `json:"dateEnd"`
	PassCount  int64     `json:"passCount"`
	FailCount  int64     `json:"failCount"`
	ReceivedAt time.Time `json:"receivedAt"`
}

type listScope struct {
	Domain string `json:"domain,omitempty"`
	From   string `json:"from,omitempty"`
	To     string `json:"to,omitempty"`
}

type listMeta struct {
	GeneratedAt              time.Time `json:"generatedAt"`
	Limit                    int       `json:"limit"`
	Returned                 int       `json:"returned"`
	TotalReports             int64     `json:"totalReports"`
	HasMore                  bool      `json:"hasMore"`
	AvailableDomains         []string  `json:"availableDomains"`
	DomainInventoryTruncated bool      `json:"domainInventoryTruncated"`
	Scope                    listScope `json:"scope"`
}

type listResponse struct {
	Items []Report `json:"items"`
	Meta  listMeta `json:"meta"`
}

type listOptions struct {
	Domain string
	From   *time.Time
	To     *time.Time
	Limit  int
}

type queryValidationError struct {
	code    string
	message string
}

func (e *queryValidationError) Error() string { return e.message }

// Deps bundles handler dependencies.
type Deps struct {
	Pool *db.Pool
	// EnableSuggestionAcknowledgements is intentionally false in the native
	// server composition. Acknowledgements are tenant-global, permanent state;
	// they stay unavailable until actor attribution and lifecycle governance are
	// designed and tested.
	EnableSuggestionAcknowledgements bool
	// Logger is used by httperror.WriteInternal to record server-side
	// failure details (with tenant_id and request_id) without leaking
	// the raw error text to the client. May be nil in tests —
	// httperror.WriteInternal tolerates that.
	Logger *slog.Logger
}

// MountRoutes registers the DMARC endpoints:
//
//	GET    /api/v1/deliverability/dmarc-reports        — bounded report evidence
//	GET    /api/v1/deliverability/dmarc-insights       — actionable rollup +
//	                                                     suggestions (insights.go)
//	GET    /api/v1/deliverability/dmarc-sources        — per-source drill-down
//	                                                     (insights.go, PR 2)
//	POST   /api/v1/deliverability/dmarc-suggestions/ack
//	                                                   — default-off mutation
//	DELETE /api/v1/deliverability/dmarc-suggestions/ack/{code}
//	                                                   — default-off mutation
func (d *Deps) MountRoutes(r chi.Router) {
	// Reads (reports / insights / sources) sit on ScopeReadReports — the
	// loosest scope that already covers deliverability dashboards.
	// Suggestion ack/unack are state mutations: an API key without
	// admin scope shouldn't be able to silence a deliverability
	// suggestion that another operator is acting on, so they gate
	// behind ScopeAdmin (matches dedicated_ip_handlers.go).
	read := apikeys.RequireScope(apikeys.ScopeReadReports)
	admin := apikeys.RequireScope(apikeys.ScopeAdmin)
	r.With(read).Get("/api/v1/deliverability/dmarc-reports", d.List)
	r.With(read).Get("/api/v1/deliverability/dmarc-insights", d.Insights)
	r.With(read).Get("/api/v1/deliverability/dmarc-sources", d.SourceDetail)
	r.With(admin).Post("/api/v1/deliverability/dmarc-suggestions/ack", d.AckSuggestion)
	r.With(admin).Delete("/api/v1/deliverability/dmarc-suggestions/ack/{code}", d.UnackSuggestion)
}

// List GET /api/v1/deliverability/dmarc-reports?domain=&from=&to=&limit=
func (d *Deps) List(w http.ResponseWriter, r *http.Request) {
	setSensitiveResponseHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	opts, err := parseListOptions(r.URL.Query())
	if err != nil {
		var validation *queryValidationError
		if errors.As(err, &validation) {
			httperror.WriteValidation(w, validation.code, validation.message)
			return
		}
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	out, err := listReports(r.Context(), d.Pool, t.ID, opts)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// List runs the underlying query. Exported so tests can hit it directly.
func List(ctx context.Context, pool *db.Pool, tenantID, domain, from, to string, limit int) ([]Report, error) {
	values := url.Values{}
	if domain != "" {
		values.Set("domain", domain)
	}
	if from != "" {
		values.Set("from", from)
	}
	if to != "" {
		values.Set("to", to)
	}
	values.Set("limit", strconv.Itoa(limit))
	opts, err := parseListOptions(values)
	if err != nil {
		return nil, err
	}
	page, err := listReports(ctx, pool, tenantID, opts)
	if err != nil {
		return nil, err
	}
	return page.Items, nil
}

func listReports(ctx context.Context, pool *db.Pool, tenantID string, opts listOptions) (*listResponse, error) {
	if pool == nil {
		return nil, errors.New("dmarc reports: nil pool")
	}
	if tenantID == "" {
		return nil, errors.New("dmarc reports: empty tenant id")
	}
	tx, err := db.WithTenantOptions(ctx, pool, tenantID, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	generatedAt, err := snapshotGeneratedAt(ctx, tx)
	if err != nil {
		return nil, fmt.Errorf("dmarc reports: establish snapshot receipt: %w", err)
	}
	// Read the aggregate tables written by the ingestion pipeline. DMARC
	// pass/fail is
	// rolled up from the per-source records: a message passes if EITHER
	// aligned mechanism (DKIM or SPF) passed — the same signal insights.go
	// uses. The public projection deliberately excludes reporter email and
	// retained XML because neither is needed by the desktop evidence view.
	where := ` WHERE rep.tenant_id = $1::uuid AND rep.date_range_begin <= rep.date_range_end`
	args := []any{tenantID}
	if opts.Domain != "" {
		args = append(args, opts.Domain)
		where += ` AND LOWER(rep.domain) = $` + strconv.Itoa(len(args))
	}
	if opts.From != nil {
		args = append(args, *opts.From)
		where += ` AND rep.date_range_end >= $` + strconv.Itoa(len(args))
	}
	if opts.To != nil {
		args = append(args, *opts.To)
		where += ` AND rep.date_range_begin <= $` + strconv.Itoa(len(args))
	}

	var totalReports int64
	if err := tx.QueryRow(ctx, `SELECT COUNT(*) FROM dmarc_aggregate_reports rep`+where, args...).Scan(&totalReports); err != nil {
		return nil, err
	}

	domainRows, err := tx.Query(ctx, `
		SELECT DISTINCT LOWER(domain)
		  FROM dmarc_aggregate_reports
		 WHERE tenant_id = $1::uuid
		   AND date_range_begin <= date_range_end
		 ORDER BY LOWER(domain)
		 LIMIT 501`, tenantID)
	if err != nil {
		return nil, err
	}
	domains := make([]string, 0, 32)
	rawDomainCount := 0
	for domainRows.Next() {
		var storedDomain string
		if err := domainRows.Scan(&storedDomain); err != nil {
			domainRows.Close()
			return nil, err
		}
		rawDomainCount++
		domain, valid := canonicalHostname(storedDomain)
		if valid && len(domains) < 500 {
			domains = append(domains, domain)
		}
	}
	if err := domainRows.Err(); err != nil {
		domainRows.Close()
		return nil, err
	}
	domainRows.Close()
	domainInventoryTruncated := rawDomainCount > 500

	q := `SELECT rep.id::text,
	              COALESCE(
	                NULLIF(LEFT(regexp_replace(LEFT(COALESCE(rep.org_name, ''), 1024), '[[:cntrl:]]', '', 'g'), 256), ''),
	                'Unknown reporter'
	              ),
	              COALESCE(
	                NULLIF(LEFT(regexp_replace(LEFT(COALESCE(rep.report_id, ''), 2048), '[[:cntrl:]]', '', 'g'), 512), ''),
	                rep.id::text
	              ),
	              LOWER(rep.domain),
	              CASE LOWER(COALESCE(rep.policy_p, ''))
	                WHEN '' THEN '' WHEN 'none' THEN 'none'
	                WHEN 'quarantine' THEN 'quarantine' WHEN 'reject' THEN 'reject'
	                ELSE 'unknown' END,
	              CASE WHEN rep.policy_pct BETWEEN 0 AND 100 THEN rep.policy_pct ELSE NULL END,
	              rep.date_range_begin, rep.date_range_end,
	              COALESCE(SUM(rec.count) FILTER (
	                  WHERE LOWER(TRIM(COALESCE(rec.dkim_result, ''))) = 'pass'
	                     OR LOWER(TRIM(COALESCE(rec.spf_result, ''))) = 'pass'
	              ), 0)::bigint AS pass_count,
	              COALESCE(SUM(rec.count) FILTER (
	                  WHERE LOWER(TRIM(COALESCE(rec.dkim_result, ''))) <> 'pass'
	                    AND LOWER(TRIM(COALESCE(rec.spf_result, ''))) <> 'pass'
	              ), 0)::bigint AS fail_count,
	              rep.ingested_at
	         FROM dmarc_aggregate_reports rep
	         LEFT JOIN dmarc_aggregate_records rec ON rec.report_id = rep.id AND rec.count > 0` + where
	q += ` GROUP BY rep.id, rep.org_name, rep.report_id, rep.domain,
	                    rep.policy_p, rep.policy_pct, rep.date_range_begin,
	                    rep.date_range_end, rep.ingested_at`
	args = append(args, opts.Limit)
	q += ` ORDER BY rep.date_range_end DESC, rep.id DESC LIMIT $` + strconv.Itoa(len(args))
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Report{}
	for rows.Next() {
		var r Report
		if err := rows.Scan(&r.ID, &r.OrgName, &r.ReportID, &r.Domain,
			&r.PolicyP, &r.PolicyPct, &r.DateBegin, &r.DateEnd,
			&r.PassCount, &r.FailCount, &r.ReceivedAt); err != nil {
			return nil, err
		}
		r.OrgName = truncateUTF16(r.OrgName, 256)
		r.ReportID = truncateUTF16(r.ReportID, 512)
		domain, valid := canonicalHostname(r.Domain)
		if !valid {
			return nil, errors.New("dmarc reports: stored report contains an invalid domain")
		}
		r.Domain = domain
		if r.DateBegin.After(r.DateEnd) {
			return nil, errors.New("dmarc reports: stored report has an invalid date range")
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	scope := listScope{Domain: opts.Domain}
	if opts.From != nil {
		scope.From = opts.From.UTC().Format(time.RFC3339Nano)
	}
	if opts.To != nil {
		scope.To = opts.To.UTC().Format(time.RFC3339Nano)
	}
	return &listResponse{
		Items: out,
		Meta: listMeta{
			GeneratedAt:              generatedAt,
			Limit:                    opts.Limit,
			Returned:                 len(out),
			TotalReports:             totalReports,
			HasMore:                  totalReports > int64(len(out)),
			AvailableDomains:         domains,
			DomainInventoryTruncated: domainInventoryTruncated,
			Scope:                    scope,
		},
	}, nil
}

// snapshotGeneratedAt returns a database-clock receipt only after the
// repeatable-read transaction has established its snapshot. Capturing a
// process timestamp before BeginTx lets a concurrent ingestion commit become
// visible even though its receipt postdates generatedAt, so generatedAt would
// no longer be an upper bound for the returned snapshot.
func snapshotGeneratedAt(ctx context.Context, tx pgx.Tx) (time.Time, error) {
	var generatedAt time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&generatedAt); err != nil {
		return time.Time{}, err
	}
	return generatedAt.UTC(), nil
}

func parseListOptions(values url.Values) (listOptions, error) {
	if err := validateQueryParameters(values, "domain", "from", "limit", "to"); err != nil {
		return listOptions{}, err
	}
	opts := listOptions{Limit: 50}
	if raw := values.Get("limit"); raw != "" {
		limit, ok := boundedDecimal(raw, 1, 500)
		if !ok {
			return listOptions{}, &queryValidationError{code: "invalid_limit", message: "limit must be an integer between 1 and 500"}
		}
		opts.Limit = limit
	}
	if raw := values.Get("domain"); raw != "" {
		domain, ok := canonicalHostname(raw)
		if !ok {
			return listOptions{}, &queryValidationError{code: "invalid_domain", message: "domain must be a canonical ASCII hostname"}
		}
		opts.Domain = domain
	}
	parseTime := func(name string) (*time.Time, error) {
		raw := values.Get(name)
		if raw == "" {
			return nil, nil
		}
		if len(raw) > 64 {
			return nil, &queryValidationError{code: "invalid_" + name, message: name + " must be an RFC3339 timestamp"}
		}
		parsed, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			return nil, &queryValidationError{code: "invalid_" + name, message: name + " must be an RFC3339 timestamp"}
		}
		parsed = parsed.UTC()
		return &parsed, nil
	}
	var err error
	if opts.From, err = parseTime("from"); err != nil {
		return listOptions{}, err
	}
	if opts.To, err = parseTime("to"); err != nil {
		return listOptions{}, err
	}
	if opts.From != nil && opts.To != nil && opts.From.After(*opts.To) {
		return listOptions{}, &queryValidationError{code: "invalid_window", message: "from must not be later than to"}
	}
	return opts, nil
}

func boundedDecimal(raw string, minimum, maximum int) (int, bool) {
	if raw == "" || len(raw) > 10 {
		return 0, false
	}
	for _, char := range raw {
		if char < '0' || char > '9' {
			return 0, false
		}
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		return 0, false
	}
	return value, true
}

func validateQueryParameters(values url.Values, allowed ...string) *queryValidationError {
	allow := make(map[string]struct{}, len(allowed))
	for _, name := range allowed {
		allow[name] = struct{}{}
	}
	for name, entries := range values {
		if _, ok := allow[name]; !ok {
			return &queryValidationError{code: "invalid_query", message: "request contains an unsupported query parameter"}
		}
		if len(entries) != 1 {
			return &queryValidationError{code: "invalid_query", message: "query parameters must not be repeated"}
		}
	}
	return nil
}

func canonicalHostname(raw string) (string, bool) {
	value := strings.ToLower(strings.TrimSpace(raw))
	if value == "" || len(value) > 253 || strings.HasSuffix(value, ".") || strings.Contains(value, "..") || net.ParseIP(value) != nil {
		return "", false
	}
	for _, r := range value {
		if r > 127 || r < 33 {
			return "", false
		}
	}
	for _, label := range strings.Split(value, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return "", false
		}
		for _, c := range label {
			if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '-' {
				return "", false
			}
		}
	}
	return value, true
}

// JavaScript string limits count UTF-16 code units, while PostgreSQL LEFT and
// Go range over Unicode code points. Truncate at the API boundary so astral
// characters cannot make an otherwise bounded text field violate its wire
// contract.
func truncateUTF16(value string, maximumUnits int) string {
	if maximumUnits <= 0 {
		return ""
	}
	units := 0
	for index, char := range value {
		width := 1
		if char > 0xffff {
			width = 2
		}
		if units+width > maximumUnits {
			return value[:index]
		}
		units += width
	}
	return value
}

func errEnv(code, msg string) map[string]any {
	return map[string]any{"error": map[string]string{"code": code, "message": msg}}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func setSensitiveResponseHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store, max-age=0")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Expires", "0")
}
