// SPDX-License-Identifier: AGPL-3.0-only
//
// untracked_reports.go persists per-campaign untracked-link scan results. The
// send pipeline calls RecordUntrackedLinks at body-fetch time (via a nil-safe
// sink on the send Guard); operators read them back over the API.
package deliverability_control

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httperror"
)

// UntrackedReport is one persisted scan of a campaign's links.
type UntrackedReport struct {
	ID             string        `json:"id"`
	CampaignID     string        `json:"campaign_id,omitempty"`
	ScannedAt      time.Time     `json:"scanned_at"`
	TotalLinks     int           `json:"total_links"`
	TrackedLinks   int           `json:"tracked_links"`
	UntrackedLinks int           `json:"untracked_links"`
	Findings       []LinkFinding `json:"findings"`
}

// RecordUntrackedLinks scans html and persists one report per (tenant,
// campaign). Record-once: ON CONFLICT DO NOTHING, since a campaign's body is
// immutable for a send run, so re-invoking across send batches is a cheap no-op
// at the database. This method's signature is the sending.UntrackedLinkSink
// contract, so the deliverability Repo satisfies it directly.
func (r *Repo) RecordUntrackedLinks(ctx context.Context, tenantID, campaignID, html string) error {
	report := ScanUntrackedLinks(html)
	findings, err := json.Marshal(report.Links)
	if err != nil {
		return err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO click_tracking_untracked_reports
    (tenant_id, campaign_id, total_links, tracked_links, untracked_links, findings)
VALUES ($1::uuid, NULLIF($2,'')::uuid, $3, $4, $5, $6::jsonb)
ON CONFLICT (tenant_id, campaign_id) DO NOTHING`,
		tenantID, campaignID, report.TotalLinks, report.TrackedLinks, report.UntrackedLinks, string(findings)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ListUntrackedReports returns persisted reports for a tenant, newest first.
// A non-empty campaignID filters to that campaign.
func (r *Repo) ListUntrackedReports(ctx context.Context, tenantID, campaignID string) ([]UntrackedReport, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, COALESCE(campaign_id::text,''), scanned_at, total_links,
       tracked_links, untracked_links, findings
FROM click_tracking_untracked_reports
WHERE tenant_id = $1::uuid AND ($2 = '' OR campaign_id = NULLIF($2,'')::uuid)
ORDER BY scanned_at DESC
LIMIT 200`, tenantID, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []UntrackedReport{}
	for rows.Next() {
		var rep UntrackedReport
		var findings []byte
		if err := rows.Scan(&rep.ID, &rep.CampaignID, &rep.ScannedAt, &rep.TotalLinks,
			&rep.TrackedLinks, &rep.UntrackedLinks, &findings); err != nil {
			return nil, err
		}
		rep.Findings = []LinkFinding{}
		if len(findings) > 0 {
			_ = json.Unmarshal(findings, &rep.Findings)
		}
		out = append(out, rep)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

// ListUntrackedReports is the read endpoint: GET
// /api/v1/deliverability-control/click-tracking/untracked-reports[?campaign_id=].
func (d *Deps) ListUntrackedReports(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantID(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, errEnv("no_tenant", "tenant required"))
		return
	}
	out, err := d.Repo.ListUntrackedReports(r.Context(), tenantID, r.URL.Query().Get("campaign_id"))
	if err != nil {
		httperror.WriteInternal(w, d.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}
