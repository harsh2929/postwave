// SPDX-License-Identifier: AGPL-3.0-only
//
// insights.go — actionable aggregation over dmarc_aggregate_reports +
// dmarc_aggregate_records. The parser + storage layer (in
// services/deliverability/internal/auth/dmarc_*) already ingests reports;
// this file turns those rows into the customer-facing decisions:
//
//   - alignment summary: % messages that passed aligned SPF or aligned DKIM
//   - disposition breakdown: receiver-reported DMARC policy actions
//   - top sources: which sending IPs drove the most volume + their
//     failure rate, ordered so the ones to act on bubble up
//   - top failing sources: same shape but filtered to high-volume
//     IPs whose alignment is below a threshold — these are the
//     "fix me first" rows for the dashboard
//   - suggestions: a conservative rule-set that identifies evidence worth
//     investigating without prescribing a DNS change.
//
// Reads only — no writes here. Storage + ingestion live in the
// deliverability service so the API gateway never touches IMAP.

package dmarc

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// InsightsResponse is the wire shape for GET /api/v1/deliverability/dmarc-insights.
// One response covers one (domain, period) slice. All counts are message
// counts (sum of the per-record `count` column), not row counts.
type InsightsResponse struct {
	Domain              string             `json:"domain"`
	PeriodDays          int                `json:"periodDays"`
	GeneratedAt         time.Time          `json:"generatedAt"`
	WindowStart         time.Time          `json:"windowStart"`
	WindowEnd           time.Time          `json:"windowEnd"`
	LatestReportAt      *time.Time         `json:"latestReportAt,omitempty"`
	ReportingDays       int                `json:"reportingDays"`
	ReportCount         int                `json:"reportCount"`
	TotalMessages       int64              `json:"totalMessages"`
	SourceCount         int                `json:"sourceCount"`
	SourceListTruncated bool               `json:"sourceListTruncated"`
	Alignment           AlignmentSummary   `json:"alignment"`
	Disposition         DispositionSummary `json:"disposition"`
	TopSources          []SourceRow        `json:"topSources"`
	TopFailing          []SourceRow        `json:"topFailingSources"`
	Suggestions         []Suggestion       `json:"suggestions"`
	// Per-day alignment evidence for the selected report window.
	Series []DailyPoint `json:"series"`
	// LatestPolicy is an observation copied from the newest report for an
	// explicitly selected domain. It is not a live DNS lookup and must never be
	// presented as the currently published record.
	LatestPolicy string `json:"latestPolicy,omitempty"`
}

// DailyPoint is one day's worth of aggregate alignment data — the
// sum of messages classified by date_range_end (the canonical day
// the reporter ascribes to the records). AlignedPct is 0-1.
type DailyPoint struct {
	Date       string  `json:"date"`
	Messages   int64   `json:"messages"`
	Aligned    int64   `json:"aligned"`
	AlignedPct float64 `json:"alignedPct"`
}

// AlignmentSummary is the "did the message pass DMARC alignment" breakdown.
// A message passes DMARC when at least one authenticated identifier (SPF or
// DKIM) both passes and aligns with the RFC5322.From domain. The stored values
// are the parser's policy-evaluated aligned results.
type AlignmentSummary struct {
	BothPass     int64 `json:"bothPass"`     // dkim=pass AND spf=pass
	DKIMOnlyPass int64 `json:"dkimOnlyPass"` // dkim=pass AND spf!=pass
	SPFOnlyPass  int64 `json:"spfOnlyPass"`  // spf=pass AND dkim!=pass
	NeitherPass  int64 `json:"neitherPass"`  // both fail — the messages reporters can act on
	// AlignedPct = (BothPass + DKIMOnlyPass + SPFOnlyPass) / total.
	// Returned as a 0-1 float so the UI can format whichever way.
	AlignedPct float64 `json:"alignedPct"`
}

// DispositionSummary is the receiver-reported DMARC policy action per
// message. "none" means the reporter explicitly recorded no DMARC policy
// action; it is not proof of inbox placement, acceptance, or final delivery.
// Unrecognised or missing receiver values remain explicit in Unknown.
type DispositionSummary struct {
	None       int64 `json:"none"`
	Quarantine int64 `json:"quarantine"`
	Reject     int64 `json:"reject"`
	Unknown    int64 `json:"unknown"`
}

// SourceRow is one sending IP's slice of the totals.
type SourceRow struct {
	SourceIP    string  `json:"sourceIp"`
	Messages    int64   `json:"messages"`
	DKIMPass    int64   `json:"dkimPass"`
	SPFPass     int64   `json:"spfPass"`
	BothPass    int64   `json:"bothPass"`
	AlignedPct  float64 `json:"alignedPct"`
	Disposition string  `json:"primaryDisposition"`
	Quarantined int64   `json:"quarantined"`
	Rejected    int64   `json:"rejected"`
	// EnvelopeFromDomain is a canonical hostname-only diagnostic. Mailbox
	// local-parts and arbitrary raw envelope identifiers never cross the API
	// boundary.
	EnvelopeFromDomain string `json:"envelopeFromDomain,omitempty"`
}

// Suggestion is one actionable recommendation. Severity is "info" /
// "warning" / "action" — the dashboard banners only escalate at
// "action". The action field is intentionally short and verb-led so
// it fits in a banner without truncation.
//
// Code is a stable identifier per rule. Suggestions intentionally contain no
// copyable DNS record: aggregate reports are historical observations, not a
// safe source of truth for replacing a live DMARC policy.
type Suggestion struct {
	Code     string `json:"code,omitempty"`
	Severity string `json:"severity"`
	Action   string `json:"action"`
	Reason   string `json:"reason,omitempty"`
}

// Insights GET /api/v1/deliverability/dmarc-insights?domain=&days=30.
func (d *Deps) Insights(w http.ResponseWriter, r *http.Request) {
	setSensitiveResponseHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	q := r.URL.Query()
	if err := validateQueryParameters(q, "days", "domain"); err != nil {
		httperror.WriteValidation(w, err.code, err.message)
		return
	}
	domain := ""
	if raw := q.Get("domain"); raw != "" {
		var valid bool
		domain, valid = canonicalHostname(raw)
		if !valid {
			httperror.WriteValidation(w, "invalid_domain", "domain must be a canonical ASCII hostname")
			return
		}
	}
	days, err := parseDays(q.Get("days"))
	if err != nil {
		httperror.WriteValidation(w, "invalid_days", "days must be an integer between 1 and 365")
		return
	}
	resp, err := ComputeInsights(r.Context(), d.Pool, t.ID, domain, days)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// ComputeInsights pulls + rolls up the aggregation. Exported so tests
// can hit it without an HTTP layer. All reads share one repeatable, read-only
// tenant snapshot; ranking and the bounded projections are composed in Go.
func ComputeInsights(ctx context.Context, pool *db.Pool, tenantID, domain string, days int) (*InsightsResponse, error) {
	if pool == nil {
		return nil, errors.New("dmarc insights: nil pool")
	}
	if tenantID == "" {
		return nil, errors.New("dmarc insights: empty tenant id")
	}
	if days < 1 || days > 365 {
		return nil, errors.New("dmarc insights: days must be between 1 and 365")
	}
	if domain != "" {
		var valid bool
		domain, valid = canonicalHostname(domain)
		if !valid {
			return nil, errors.New("dmarc insights: invalid domain")
		}
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
		return nil, fmt.Errorf("dmarc insights: establish snapshot receipt: %w", err)
	}
	cutoff := generatedAt.Add(-time.Duration(days) * 24 * time.Hour)

	// Header query: how many reports + the policy posture for the period.
	var reportCount int
	var latestReport pgtype.Timestamptz
	if err := tx.QueryRow(ctx, `
			SELECT COUNT(*), MAX(ingested_at)
			  FROM dmarc_aggregate_reports
			 WHERE tenant_id = $4::uuid
			   AND ($3 = '' OR LOWER(domain) = $3)
			   AND date_range_begin <= date_range_end
			   AND date_range_end >= $1
			   AND date_range_end <= $2
		`, cutoff, generatedAt, domain, tenantID).Scan(&reportCount, &latestReport); err != nil {
		return nil, fmt.Errorf("count reports: %w", err)
	}
	var latestReportAt *time.Time
	if latestReport.Valid {
		value := latestReport.Time.UTC()
		latestReportAt = &value
	}

	// Per-record roll-up. We aggregate in-DB to keep the wire payload
	// small even when a tenant has 10k+ source IPs.
	rows, err := tx.Query(ctx, `
		WITH scoped AS (
			SELECT
			  HOST(rec.source_ip) AS source_ip,
			  CASE LOWER(TRIM(COALESCE(rec.disposition, '')))
			    WHEN 'none' THEN 'none'
			    WHEN 'quarantine' THEN 'quarantine'
			    WHEN 'reject' THEN 'reject'
			    ELSE 'unknown'
			  END AS disposition,
			  LEFT(regexp_replace(LEFT(COALESCE(rec.envelope_from, ''), 1280), '[[:cntrl:]]', '', 'g'), 320) AS env_from,
			  rec.count::bigint AS messages,
			  LOWER(TRIM(COALESCE(rec.dkim_result, ''))) = 'pass' AS dkim_pass,
			  LOWER(TRIM(COALESCE(rec.spf_result, ''))) = 'pass' AS spf_pass
			FROM dmarc_aggregate_records rec
			JOIN dmarc_aggregate_reports rep ON rep.id = rec.report_id
			WHERE rep.tenant_id = $4::uuid
			  AND ($3 = '' OR LOWER(rep.domain) = $3)
			  AND rep.date_range_begin <= rep.date_range_end
			  AND rep.date_range_end >= $1
			  AND rep.date_range_end <= $2
			  AND rec.count > 0
		)
		SELECT source_ip, disposition, env_from,
		       SUM(messages)::bigint AS messages,
		       COALESCE(SUM(messages) FILTER (WHERE dkim_pass), 0)::bigint AS dkim_pass,
		       COALESCE(SUM(messages) FILTER (WHERE spf_pass), 0)::bigint AS spf_pass,
		       COALESCE(SUM(messages) FILTER (WHERE dkim_pass AND spf_pass), 0)::bigint AS both_pass
		  FROM scoped
		 GROUP BY source_ip, disposition, env_from
	`, cutoff, generatedAt, domain, tenantID)
	if err != nil {
		return nil, fmt.Errorf("aggregate records: %w", err)
	}
	defer rows.Close()

	// Roll the (source_ip, disposition, envelope_from) tuples into a
	// per-IP row. We carry the dominant disposition per source IP
	// (whichever bucket has the most messages) and expose only a canonical
	// envelope-from hostname so a VERP or recipient local-part cannot leak.
	type bucketKey struct {
		ip          string
		disposition string
		envFrom     string
	}
	type bucket struct {
		messages int64
		dkimPass int64
		spfPass  int64
		bothPass int64
	}
	type ipAggregate struct {
		row              SourceRow
		dispositionByVol map[string]int64
		envByVol         map[string]int64
	}
	byIP := map[string]*ipAggregate{}
	for rows.Next() {
		var k bucketKey
		var b bucket
		if err := rows.Scan(&k.ip, &k.disposition, &k.envFrom, &b.messages, &b.dkimPass, &b.spfPass, &b.bothPass); err != nil {
			return nil, fmt.Errorf("scan record: %w", err)
		}
		agg := byIP[k.ip]
		if agg == nil {
			agg = &ipAggregate{
				row:              SourceRow{SourceIP: k.ip},
				dispositionByVol: map[string]int64{},
				envByVol:         map[string]int64{},
			}
			byIP[k.ip] = agg
		}
		agg.row.Messages += b.messages
		agg.row.DKIMPass += b.dkimPass
		agg.row.SPFPass += b.spfPass
		agg.row.BothPass += b.bothPass
		switch k.disposition {
		case "quarantine":
			agg.row.Quarantined += b.messages
		case "reject":
			agg.row.Rejected += b.messages
		}
		agg.dispositionByVol[k.disposition] += b.messages
		if envelopeDomain, ok := canonicalEnvelopeFromDomain(k.envFrom); ok {
			agg.envByVol[envelopeDomain] += b.messages
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate records: %w", err)
	}
	rows.Close()

	resp := &InsightsResponse{
		Domain:         domain,
		PeriodDays:     days,
		GeneratedAt:    generatedAt,
		WindowStart:    cutoff,
		WindowEnd:      generatedAt,
		LatestReportAt: latestReportAt,
		ReportCount:    reportCount,
		TopSources:     []SourceRow{},
		TopFailing:     []SourceRow{},
		Suggestions:    []Suggestion{},
		Series:         []DailyPoint{},
	}
	for _, agg := range byIP {
		// Pick the primary disposition (highest message count). Ties
		// are broken by preferring reject > quarantine > none > unknown
		// because the worst outcome is the one the operator needs to
		// see flagged.
		agg.row.Disposition = pickDisposition(agg.dispositionByVol)
		agg.row.EnvelopeFromDomain = pickByVolume(agg.envByVol)
		// The stored pass results are the parser's aligned policy-evaluated
		// results. DMARC passes when at least one aligned mechanism passes.
		aligned := agg.row.DKIMPass + agg.row.SPFPass - agg.row.BothPass
		if agg.row.Messages > 0 {
			agg.row.AlignedPct = float64(aligned) / float64(agg.row.Messages)
		}
		resp.TotalMessages += agg.row.Messages
		resp.Alignment.BothPass += agg.row.BothPass
		resp.Alignment.DKIMOnlyPass += agg.row.DKIMPass - agg.row.BothPass
		resp.Alignment.SPFOnlyPass += agg.row.SPFPass - agg.row.BothPass
		resp.Alignment.NeitherPass += agg.row.Messages - aligned
		for disposition, messages := range agg.dispositionByVol {
			switch disposition {
			case "none":
				resp.Disposition.None += messages
			case "quarantine":
				resp.Disposition.Quarantine += messages
			case "reject":
				resp.Disposition.Reject += messages
			default:
				resp.Disposition.Unknown += messages
			}
		}
	}
	if resp.TotalMessages > 0 {
		// AlignedPct is the same definition as the per-row one but
		// over the whole period.
		resp.Alignment.AlignedPct = float64(
			resp.Alignment.BothPass+resp.Alignment.DKIMOnlyPass+resp.Alignment.SPFOnlyPass,
		) / float64(resp.TotalMessages)
	}

	// TopSources: by observed message volume (descending). The response is
	// capped at 10 and carries SourceCount/SourceListTruncated as its receipt.
	all := make([]SourceRow, 0, len(byIP))
	for _, agg := range byIP {
		all = append(all, agg.row)
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].Messages == all[j].Messages {
			return all[i].SourceIP < all[j].SourceIP
		}
		return all[i].Messages > all[j].Messages
	})
	resp.TopSources = topN(all, 10)
	resp.SourceCount = len(all)
	resp.SourceListTruncated = len(all) > 10

	// TopFailing: the actionable list. Filter to sources that sent
	// at least 20 messages over the period (cuts noise from one-off
	// probes) AND whose alignment is below 80%. Order by absolute
	// volume of failing messages so a high-volume, mostly-aligned
	// source can still surface above a low-volume, fully-failing one.
	failingThreshold := 0.80
	const minMessagesToFlag = 20
	failing := make([]SourceRow, 0, len(byIP))
	for _, agg := range byIP {
		if agg.row.Messages < minMessagesToFlag {
			continue
		}
		if agg.row.AlignedPct >= failingThreshold {
			continue
		}
		failing = append(failing, agg.row)
	}
	sort.Slice(failing, func(i, j int) bool {
		fi := failing[i].Messages - alignedMessageCount(failing[i])
		fj := failing[j].Messages - alignedMessageCount(failing[j])
		if fi == fj {
			return failing[i].SourceIP < failing[j].SourceIP
		}
		return fi > fj
	})
	resp.TopFailing = topN(failing, 10)

	// Latest report-observed policy + per-day series.
	// Both come from extra queries against the same tenant-scoped tx
	// so a single ComputeInsights call returns everything the page
	// needs without N+1.
	if domain != "" {
		if err := loadLatestPolicy(ctx, tx, cutoff, generatedAt, domain, tenantID, resp); err != nil {
			return nil, err
		}
	}
	if err := loadSeries(ctx, tx, cutoff, generatedAt, domain, tenantID, resp); err != nil {
		return nil, err
	}
	resp.ReportingDays = len(resp.Series)

	resp.Suggestions = buildSuggestions(resp)
	return resp, tx.Commit(ctx)
}

// loadLatestPolicy exposes the policy observed in the newest report for the
// selected domain. It is historical evidence, not a live DNS lookup.
func loadLatestPolicy(ctx context.Context, tx pgx.Tx, cutoff, windowEnd time.Time, domain, tenantID string, resp *InsightsResponse) error {
	var p string
	err := tx.QueryRow(ctx, `
		SELECT COALESCE(policy_p, '')
		  FROM dmarc_aggregate_reports
		 WHERE tenant_id = $4::uuid
		   AND LOWER(domain) = $3
		   AND date_range_begin <= date_range_end
		   AND date_range_end >= $1
		   AND date_range_end <= $2
		 ORDER BY date_range_end DESC, id DESC
		 LIMIT 1
	`, cutoff, windowEnd, domain, tenantID).Scan(&p)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("latest policy query: %w", err)
	}
	switch strings.ToLower(strings.TrimSpace(p)) {
	case "none", "quarantine", "reject":
		resp.LatestPolicy = strings.ToLower(strings.TrimSpace(p))
	default:
		resp.LatestPolicy = "unknown"
	}
	return nil
}

// loadSeries aggregates per-day message volume + alignment for the
// period. Empty range = empty series; we never return null.
func loadSeries(ctx context.Context, tx pgx.Tx, cutoff, windowEnd time.Time, domain, tenantID string, resp *InsightsResponse) error {
	rows, err := tx.Query(ctx, `
		SELECT
		  to_char(date_trunc('day', rep.date_range_end AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
		  SUM(rec.count)::bigint AS messages,
		  COALESCE(SUM(rec.count) FILTER (
		    WHERE LOWER(TRIM(COALESCE(rec.dkim_result, ''))) = 'pass'
		       OR LOWER(TRIM(COALESCE(rec.spf_result, ''))) = 'pass'
		  ), 0)::bigint AS aligned
		FROM dmarc_aggregate_records rec
		JOIN dmarc_aggregate_reports rep ON rep.id = rec.report_id
		WHERE rep.tenant_id = $4::uuid
		  AND ($3 = '' OR LOWER(rep.domain) = $3)
		  AND rep.date_range_begin <= rep.date_range_end
		  AND rep.date_range_end >= $1
		  AND rep.date_range_end <= $2
		  AND rec.count > 0
		GROUP BY 1
		ORDER BY 1
	`, cutoff, windowEnd, domain, tenantID)
	if err != nil {
		return fmt.Errorf("series query: %w", err)
	}
	defer rows.Close()
	series := []DailyPoint{}
	for rows.Next() {
		var p DailyPoint
		if err := rows.Scan(&p.Date, &p.Messages, &p.Aligned); err != nil {
			return fmt.Errorf("scan series row: %w", err)
		}
		if p.Messages > 0 {
			p.AlignedPct = float64(p.Aligned) / float64(p.Messages)
		}
		series = append(series, p)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate series: %w", err)
	}
	resp.Series = series
	return nil
}

// buildSuggestions converts the aggregate stats into 0-N short actions.
// The rules are intentionally conservative — every rule is paired with
// a concrete numeric threshold, so a customer reading the suggestion
// can verify "yes that's what's happening." No vague "you might want
// to consider" copy.
//
// Each rule carries a stable Code. Rules only describe the observed aggregate
// evidence; they never synthesize a replacement DNS record or claim inbox
// placement from receiver policy-action data.
func buildSuggestions(r *InsightsResponse) []Suggestion {
	out := []Suggestion{}

	if r.ReportCount == 0 {
		out = append(out, Suggestion{
			Code:     "no_reports",
			Severity: "info",
			Action:   "Wait for the first DMARC report",
			Reason:   "No aggregate reports were ingested in this window. Report cadence is controlled by participating receivers, so this state does not prove that the domain is configured or that no mail was sent.",
		})
		return out
	}
	if r.TotalMessages == 0 {
		out = append(out, Suggestion{
			Code:     "no_observed_messages",
			Severity: "warning",
			Action:   "Review reports with no message records",
			Reason:   fmt.Sprintf("%d aggregate reports were ingested, but none contributed a positive message count. Treat alignment and disposition as unavailable until the ingestion evidence is reviewed.", r.ReportCount),
		})
		return out
	}

	// Alignment below 90% is a triage signal. The evidence does not identify
	// whether the traffic is authorised, forwarded, or malicious.
	if r.Alignment.AlignedPct < 0.90 {
		out = append(out, Suggestion{
			Code:     "alignment_low",
			Severity: "action",
			Action:   fmt.Sprintf("Investigate %d messages failing DMARC alignment", r.Alignment.NeitherPass),
			Reason: fmt.Sprintf(
				"Observed alignment is %.1f%% over %d days (%d of %d messages). Review the highest-volume failing sources and confirm whether each source is authorised before changing authentication.",
				r.Alignment.AlignedPct*100, r.PeriodDays, r.Alignment.NeitherPass, r.TotalMessages,
			),
		})
	}

	// Quarantine + Reject are receiver-reported DMARC policy actions. They are
	// not inbox-placement or final-delivery evidence.
	policyAction := r.Disposition.Quarantine + r.Disposition.Reject
	if policyAction > 0 {
		sev := "warning"
		code := "policy_action_volume_low"
		if policyAction > r.TotalMessages/10 { // >10% received an enforcement action
			sev = "action"
			code = "policy_action_volume_high"
		}
		out = append(out, Suggestion{
			Code:     code,
			Severity: sev,
			Action:   fmt.Sprintf("Review %d reported quarantine or reject actions", policyAction),
			Reason: fmt.Sprintf(
				"Participating receivers reported quarantine for %d messages and reject for %d. This evidence can include legitimate senders, forwarding and unauthorized traffic; investigate the source rows before changing authentication or policy.",
				r.Disposition.Quarantine, r.Disposition.Reject,
			),
		})
	}

	// Surface heavy reliance on SPF only after a meaningful observation sample.
	if r.Alignment.AlignedPct >= 0.95 && r.TotalMessages >= 1000 && r.ReportingDays >= 7 {
		dkimShare := safeRatio(r.Alignment.BothPass+r.Alignment.DKIMOnlyPass, r.TotalMessages)
		spfShare := safeRatio(r.Alignment.BothPass+r.Alignment.SPFOnlyPass, r.TotalMessages)
		if dkimShare < 0.50 && spfShare >= 0.90 {
			out = append(out, Suggestion{
				Code:     "spf_only_alignment",
				Severity: "info",
				Action:   "Review low DKIM-alignment coverage",
				Reason:   "Observed alignment is relying mainly on SPF. Forwarding can disrupt SPF, but aggregate evidence alone cannot identify the correct DNS change. Compare authorised sources and live DKIM configuration before acting.",
			})
		}
	}

	return out
}

func safeRatio(num, den int64) float64 {
	if den == 0 {
		return 0
	}
	return float64(num) / float64(den)
}

func alignedMessageCount(row SourceRow) int64 {
	aligned := row.DKIMPass + row.SPFPass - row.BothPass
	if aligned < 0 {
		return 0
	}
	if aligned > row.Messages {
		return row.Messages
	}
	return aligned
}

func pickDisposition(byVol map[string]int64) string {
	best := "none"
	var bestN int64
	priority := map[string]int{"reject": 4, "quarantine": 3, "none": 2, "unknown": 1}
	for k, n := range byVol {
		if _, known := priority[k]; !known {
			k = "unknown"
		}
		if n > bestN || (n == bestN && priority[k] > priority[best]) {
			best = k
			bestN = n
		}
	}
	return best
}

func pickByVolume(byVol map[string]int64) string {
	best := ""
	var bestN int64
	for k, n := range byVol {
		if n > bestN || (n == bestN && n > 0 && (best == "" || k < best)) {
			best = k
			bestN = n
		}
	}
	return best
}

func canonicalEnvelopeFromDomain(raw string) (string, bool) {
	candidate := strings.TrimSpace(raw)
	if at := strings.LastIndexByte(candidate, '@'); at >= 0 {
		candidate = candidate[at+1:]
	}
	candidate = strings.Trim(candidate, "<>. \t\r\n")
	return canonicalHostname(candidate)
}

func topN(rows []SourceRow, n int) []SourceRow {
	if len(rows) <= n {
		// Always return a non-nil slice so the JSON is `[]` not `null`.
		if rows == nil {
			return []SourceRow{}
		}
		return rows
	}
	return rows[:n]
}

// SourceDetailResponse is the wire shape for GET
// /api/v1/deliverability/dmarc-sources?ip=&days=&domain=. It contains a
// complete aggregate summary and at most 200 newest per-report rows.
type SourceDetailResponse struct {
	SourceIP    string            `json:"sourceIp"`
	PeriodDays  int               `json:"periodDays"`
	Domain      string            `json:"domain,omitempty"`
	GeneratedAt time.Time         `json:"generatedAt"`
	WindowStart time.Time         `json:"windowStart"`
	WindowEnd   time.Time         `json:"windowEnd"`
	HasMore     bool              `json:"hasMore"`
	Summary     SourceRow         `json:"summary"`
	PerReport   []SourcePerReport `json:"perReport"`
}

const sourceDetailReportLimit = 200

// SourcePerReport is one report's slice of this source IP's traffic.
// Ordered newest-first so the slideover lands on the most recent evidence.
type SourcePerReport struct {
	ReportID    string    `json:"reportId"`
	OrgName     string    `json:"orgName"`
	DateBegin   time.Time `json:"dateBegin"`
	DateEnd     time.Time `json:"dateEnd"`
	Messages    int64     `json:"messages"`
	DKIMPass    int64     `json:"dkimPass"`
	SPFPass     int64     `json:"spfPass"`
	BothPass    int64     `json:"bothPass"`
	AlignedPct  float64   `json:"alignedPct"`
	Disposition string    `json:"primaryDisposition"`
}

// SourceDetail GET /api/v1/deliverability/dmarc-sources?ip=&domain=&days=
func (d *Deps) SourceDetail(w http.ResponseWriter, r *http.Request) {
	setSensitiveResponseHeaders(w)
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", ""))
		return
	}
	q := r.URL.Query()
	if err := validateQueryParameters(q, "days", "domain", "ip"); err != nil {
		httperror.WriteValidation(w, err.code, err.message)
		return
	}
	ip := strings.TrimSpace(q.Get("ip"))
	parsedIP := net.ParseIP(ip)
	if parsedIP == nil {
		httperror.WriteValidation(w, "invalid_ip", "ip must be a valid IPv4 or IPv6 address")
		return
	}
	ip = parsedIP.String()
	domain := ""
	if raw := q.Get("domain"); raw != "" {
		var valid bool
		domain, valid = canonicalHostname(raw)
		if !valid {
			httperror.WriteValidation(w, "invalid_domain", "domain must be a canonical ASCII hostname")
			return
		}
	}
	days, err := parseDays(q.Get("days"))
	if err != nil {
		httperror.WriteValidation(w, "invalid_days", "days must be an integer between 1 and 365")
		return
	}
	resp, err := ComputeSourceDetail(r.Context(), d.Pool, t.ID, ip, domain, days)
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, httperror.WithTenantIDLog(r.Context(), t.ID))
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// ComputeSourceDetail walks every report record for one source IP
// over the period. Exported so tests can hit it without HTTP.
func ComputeSourceDetail(ctx context.Context, pool *db.Pool, tenantID, ip, domain string, days int) (*SourceDetailResponse, error) {
	if pool == nil {
		return nil, errors.New("dmarc source detail: nil pool")
	}
	if tenantID == "" {
		return nil, errors.New("dmarc source detail: empty tenant id")
	}
	parsedIP := net.ParseIP(strings.TrimSpace(ip))
	if parsedIP == nil {
		return nil, errors.New("dmarc source detail: invalid ip")
	}
	ip = parsedIP.String()
	if domain != "" {
		var valid bool
		domain, valid = canonicalHostname(domain)
		if !valid {
			return nil, errors.New("dmarc source detail: invalid domain")
		}
	}
	if days < 1 || days > 365 {
		return nil, errors.New("dmarc source detail: days must be between 1 and 365")
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
		return nil, fmt.Errorf("dmarc source detail: establish snapshot receipt: %w", err)
	}
	cutoff := generatedAt.Add(-time.Duration(days) * 24 * time.Hour)

	resp := &SourceDetailResponse{
		SourceIP:    ip,
		PeriodDays:  days,
		Domain:      domain,
		GeneratedAt: generatedAt,
		WindowStart: cutoff,
		WindowEnd:   generatedAt,
		Summary:     SourceRow{SourceIP: ip},
		PerReport:   []SourcePerReport{},
	}

	// The summary covers the complete scope even when the per-report receipt is
	// truncated. Normalising unknown receiver actions prevents values such as
	// "pass" from being mislabeled as `none` in primaryDisposition.
	summaryDisposition := map[string]int64{}
	summaryRows, err := tx.Query(ctx, `
		SELECT
		  CASE LOWER(TRIM(COALESCE(rec.disposition, '')))
		    WHEN 'none' THEN 'none'
		    WHEN 'quarantine' THEN 'quarantine'
		    WHEN 'reject' THEN 'reject'
		    ELSE 'unknown'
		  END AS disposition,
		  SUM(rec.count)::bigint AS messages,
		  COALESCE(SUM(rec.count) FILTER (WHERE LOWER(TRIM(COALESCE(rec.dkim_result, ''))) = 'pass'), 0)::bigint AS dkim_pass,
		  COALESCE(SUM(rec.count) FILTER (WHERE LOWER(TRIM(COALESCE(rec.spf_result, ''))) = 'pass'), 0)::bigint AS spf_pass,
		  COALESCE(SUM(rec.count) FILTER (
		    WHERE LOWER(TRIM(COALESCE(rec.dkim_result, ''))) = 'pass'
		      AND LOWER(TRIM(COALESCE(rec.spf_result, ''))) = 'pass'
		  ), 0)::bigint AS both_pass
		FROM dmarc_aggregate_records rec
		JOIN dmarc_aggregate_reports rep ON rep.id = rec.report_id
		WHERE rep.tenant_id = $5::uuid
		  AND rec.source_ip = $3::inet
		  AND ($4 = '' OR LOWER(rep.domain) = $4)
		  AND rep.date_range_begin <= rep.date_range_end
		  AND rep.date_range_end >= $1
		  AND rep.date_range_end <= $2
		  AND rec.count > 0
		GROUP BY 1
	`, cutoff, generatedAt, ip, domain, tenantID)
	if err != nil {
		return nil, fmt.Errorf("source summary query: %w", err)
	}
	for summaryRows.Next() {
		var disposition string
		var messages, dkim, spf, both int64
		if err := summaryRows.Scan(&disposition, &messages, &dkim, &spf, &both); err != nil {
			summaryRows.Close()
			return nil, fmt.Errorf("scan source summary: %w", err)
		}
		resp.Summary.Messages += messages
		resp.Summary.DKIMPass += dkim
		resp.Summary.SPFPass += spf
		resp.Summary.BothPass += both
		summaryDisposition[disposition] += messages
		switch disposition {
		case "quarantine":
			resp.Summary.Quarantined += messages
		case "reject":
			resp.Summary.Rejected += messages
		}
	}
	if err := summaryRows.Err(); err != nil {
		summaryRows.Close()
		return nil, fmt.Errorf("iterate source summary: %w", err)
	}
	summaryRows.Close()
	resp.Summary.Disposition = pickDisposition(summaryDisposition)
	if resp.Summary.Messages > 0 {
		resp.Summary.AlignedPct = float64(alignedMessageCount(resp.Summary)) / float64(resp.Summary.Messages)
	}

	// Select only the newest limit+1 matching report IDs before aggregating
	// their dispositions. This bounds memory/row work and provides an exact
	// truncation receipt without weakening the complete summary above.
	rows, err := tx.Query(ctx, `
		WITH matching_reports AS (
			SELECT
			  rep.id,
			  COALESCE(
			    NULLIF(LEFT(regexp_replace(LEFT(COALESCE(rep.org_name, ''), 1024), '[[:cntrl:]]', '', 'g'), 256), ''),
			    'Unknown reporter'
			  ) AS org_name,
			  rep.date_range_begin,
			  rep.date_range_end
			FROM dmarc_aggregate_reports rep
			WHERE rep.tenant_id = $5::uuid
			  AND ($4 = '' OR LOWER(rep.domain) = $4)
			  AND rep.date_range_begin <= rep.date_range_end
			  AND rep.date_range_end >= $1
			  AND rep.date_range_end <= $2
			  AND EXISTS (
			    SELECT 1
			      FROM dmarc_aggregate_records witness
			     WHERE witness.report_id = rep.id
			       AND witness.source_ip = $3::inet
			       AND witness.count > 0
			  )
			ORDER BY rep.date_range_end DESC, rep.id DESC
			LIMIT $6
		), scoped AS (
			SELECT
			  mr.id AS report_id,
			  mr.org_name,
			  mr.date_range_begin,
			  mr.date_range_end,
			  CASE LOWER(TRIM(COALESCE(rec.disposition, '')))
			    WHEN 'none' THEN 'none'
			    WHEN 'quarantine' THEN 'quarantine'
			    WHEN 'reject' THEN 'reject'
			    ELSE 'unknown'
			  END AS disposition,
			  rec.count::bigint AS messages,
			  LOWER(TRIM(COALESCE(rec.dkim_result, ''))) = 'pass' AS dkim_pass,
			  LOWER(TRIM(COALESCE(rec.spf_result, ''))) = 'pass' AS spf_pass
			FROM matching_reports mr
			JOIN dmarc_aggregate_records rec ON rec.report_id = mr.id
			WHERE rec.source_ip = $3::inet
			  AND rec.count > 0
		)
		SELECT report_id::text, org_name, date_range_begin, date_range_end, disposition,
		       SUM(messages)::bigint AS messages,
		       COALESCE(SUM(messages) FILTER (WHERE dkim_pass), 0)::bigint AS dkim_pass,
		       COALESCE(SUM(messages) FILTER (WHERE spf_pass), 0)::bigint AS spf_pass,
		       COALESCE(SUM(messages) FILTER (WHERE dkim_pass AND spf_pass), 0)::bigint AS both_pass
		  FROM scoped
		 GROUP BY report_id, org_name, date_range_begin, date_range_end, disposition
		 ORDER BY date_range_end DESC, report_id DESC
	`, cutoff, generatedAt, ip, domain, tenantID, sourceDetailReportLimit+1)
	if err != nil {
		return nil, fmt.Errorf("source detail query: %w", err)
	}

	type reportAgg struct {
		row       SourcePerReport
		dispByVol map[string]int64
	}
	byReport := map[string]*reportAgg{}
	for rows.Next() {
		var rid, org, disposition string
		var begin, end time.Time
		var messages, dkim, spf, both int64
		if err := rows.Scan(&rid, &org, &begin, &end, &disposition, &messages, &dkim, &spf, &both); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan source row: %w", err)
		}
		org = truncateUTF16(org, 256)
		if begin.After(end) {
			rows.Close()
			return nil, errors.New("dmarc source detail: stored report has an invalid date range")
		}
		agg := byReport[rid]
		if agg == nil {
			agg = &reportAgg{
				row: SourcePerReport{
					ReportID:  rid,
					OrgName:   org,
					DateBegin: begin,
					DateEnd:   end,
				},
				dispByVol: map[string]int64{},
			}
			byReport[rid] = agg
		}
		agg.row.Messages += messages
		agg.row.DKIMPass += dkim
		agg.row.SPFPass += spf
		agg.row.BothPass += both
		agg.dispByVol[disposition] += messages
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, fmt.Errorf("iterate source rows: %w", err)
	}
	rows.Close()

	for _, agg := range byReport {
		agg.row.Disposition = pickDisposition(agg.dispByVol)
		if agg.row.Messages > 0 {
			agg.row.AlignedPct = float64(alignedMessageCount(SourceRow{
				Messages: agg.row.Messages, DKIMPass: agg.row.DKIMPass,
				SPFPass: agg.row.SPFPass, BothPass: agg.row.BothPass,
			})) / float64(agg.row.Messages)
		}
		resp.PerReport = append(resp.PerReport, agg.row)
	}
	sort.Slice(resp.PerReport, func(i, j int) bool {
		if resp.PerReport[i].DateEnd.Equal(resp.PerReport[j].DateEnd) {
			return resp.PerReport[i].ReportID > resp.PerReport[j].ReportID
		}
		return resp.PerReport[i].DateEnd.After(resp.PerReport[j].DateEnd)
	})
	if len(resp.PerReport) > sourceDetailReportLimit {
		resp.HasMore = true
		resp.PerReport = resp.PerReport[:sourceDetailReportLimit]
	}
	return resp, tx.Commit(ctx)
}

func parseDays(raw string) (int, error) {
	if raw == "" {
		return 30, nil
	}
	days, ok := boundedDecimal(raw, 1, 365)
	if !ok {
		return 0, errors.New("invalid days")
	}
	return days, nil
}
