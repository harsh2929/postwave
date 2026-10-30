// SPDX-License-Identifier: AGPL-3.0-only
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// This file ports the analytics-breakdown read tools the native endpoint
// was missing (the audit flagged campaign_link_report / campaigns_compare
// / campaign_devices / campaign_geography as proxy-only). Each is a pure,
// tenant-scoped read over campaign_report_events — same proven pattern as
// the original native tools, so there is no double-governance and no risk
// of drifting from a second implementation. Names match the proxy so the
// canonical registry catalog is consistent across surfaces.

// ---------------------------------------------------------------------
// campaign_link_report
// ---------------------------------------------------------------------

type linkReportInput struct {
	CampaignID string `json:"campaign_id"`
	Limit      int    `json:"limit"`
}

func handleCampaignLinkReport(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	var in linkReportInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	in.CampaignID = strings.TrimSpace(in.CampaignID)
	if in.CampaignID == "" {
		return nil, errors.New("campaign_id is required")
	}
	if in.Limit <= 0 {
		in.Limit = 50
	}
	if in.Limit > 200 {
		in.Limit = 200
	}
	return withTenantTx(ctx, d, func(tx pgx.Tx, tenantID string) (any, error) {
		rows, err := tx.Query(ctx, `
SELECT link_url,
       count(*)::int                                   AS clicks,
       count(DISTINCT subscriber_email)::int           AS unique_clicks
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND campaign_id::text = $2
   AND event_type = 'clicked'
   AND COALESCE(link_url, '') <> ''
 GROUP BY link_url
 ORDER BY clicks DESC
 LIMIT `+fmt.Sprintf("%d", in.Limit), tenantID, in.CampaignID)
		if err != nil {
			return nil, fmt.Errorf("query link report: %w", err)
		}
		defer rows.Close()
		type linkRow struct {
			URL          string `json:"url"`
			Clicks       int    `json:"clicks"`
			UniqueClicks int    `json:"unique_clicks"`
		}
		out := make([]linkRow, 0, in.Limit)
		for rows.Next() {
			var r linkRow
			if err := rows.Scan(&r.URL, &r.Clicks, &r.UniqueClicks); err != nil {
				return nil, err
			}
			out = append(out, r)
		}
		return map[string]any{"campaign_id": in.CampaignID, "links": out, "count": len(out)}, nil
	})
}

// ---------------------------------------------------------------------
// campaigns_compare
// ---------------------------------------------------------------------

type compareInput struct {
	CampaignIDs []string `json:"campaign_ids"`
}

type campaignComparisonRow struct {
	CampaignID string  `json:"campaign_id"`
	Sent       int     `json:"sent"`
	Delivered  int     `json:"delivered"`
	Opens      int     `json:"unique_opens"`
	Clicks     int     `json:"unique_clicks"`
	Unsubs     int     `json:"unsubscribes"`
	OpenRate   float64 `json:"open_rate"`
	ClickRate  float64 `json:"click_rate"`
}

func scanCampaignComparisonRows(rows pgx.Rows) (map[string]campaignComparisonRow, error) {
	byID := map[string]campaignComparisonRow{}
	for rows.Next() {
		var r campaignComparisonRow
		if err := rows.Scan(&r.CampaignID, &r.Sent, &r.Delivered, &r.Opens, &r.Clicks, &r.Unsubs); err != nil {
			return nil, err
		}
		denom := r.Delivered
		if denom == 0 {
			denom = r.Sent
		}
		if denom > 0 {
			r.OpenRate = float64(r.Opens) / float64(denom)
			r.ClickRate = float64(r.Clicks) / float64(denom)
		}
		byID[r.CampaignID] = r
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate campaign comparison: %w", err)
	}
	return byID, nil
}

func canonicalUUID(raw, field string) (string, error) {
	parsed, err := uuid.Parse(raw)
	if err != nil || parsed.String() != raw {
		return "", fmt.Errorf("%s must be a canonical lowercase UUID", field)
	}
	return parsed.String(), nil
}

func handleCampaignsCompare(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	var in compareInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	ids := make([]string, 0, len(in.CampaignIDs))
	seen := make(map[string]struct{}, len(in.CampaignIDs))
	for index, id := range in.CampaignIDs {
		s, err := canonicalUUID(id, fmt.Sprintf("campaign_ids[%d]", index))
		if err != nil {
			return nil, err
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		ids = append(ids, s)
	}
	if len(ids) < 2 {
		return nil, errors.New("campaign_ids must contain at least 2 ids")
	}
	if len(ids) > 20 {
		return nil, errors.New("campaign_ids is capped at 20")
	}
	return withTenantTx(ctx, d, func(tx pgx.Tx, tenantID string) (any, error) {
		rows, err := tx.Query(ctx, `
SELECT campaign_id::text,
       count(*) FILTER (WHERE event_type = 'sent')::int                              AS sent,
       count(*) FILTER (WHERE event_type = 'delivered')::int                         AS delivered,
       count(DISTINCT subscriber_email) FILTER (WHERE event_type = 'opened')::int     AS opens,
       count(DISTINCT subscriber_email) FILTER (WHERE event_type = 'clicked')::int    AS clicks,
       count(*) FILTER (WHERE event_type = 'unsubscribed')::int                       AS unsubs
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND campaign_id::text = ANY($2)
 GROUP BY campaign_id`, tenantID, ids)
		if err != nil {
			return nil, fmt.Errorf("query compare: %w", err)
		}
		defer rows.Close()
		byID, err := scanCampaignComparisonRows(rows)
		if err != nil {
			return nil, err
		}
		// Preserve the caller's id order; include zero rows for ids with no events.
		out := make([]campaignComparisonRow, 0, len(ids))
		for _, id := range ids {
			if r, ok := byID[id]; ok {
				out = append(out, r)
			} else {
				out = append(out, campaignComparisonRow{CampaignID: id})
			}
		}
		return map[string]any{"campaigns": out, "count": len(out)}, nil
	})
}

// ---------------------------------------------------------------------
// campaign_devices / campaign_geography
// ---------------------------------------------------------------------

type breakdownInput struct {
	CampaignID string `json:"campaign_id"`
}

// breakdownByColumn aggregates engagement events for a campaign grouped by
// a single low-cardinality column (device or country). The column name is
// a fixed literal chosen by the caller — never user input — so there is no
// injection surface.
func breakdownByColumn(ctx context.Context, d *Deps, args json.RawMessage, column, label string) (any, error) {
	var in breakdownInput
	if err := json.Unmarshal(args, &in); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	in.CampaignID = strings.TrimSpace(in.CampaignID)
	if in.CampaignID == "" {
		return nil, errors.New("campaign_id is required")
	}
	return withTenantTx(ctx, d, func(tx pgx.Tx, tenantID string) (any, error) {
		q := fmt.Sprintf(`
SELECT COALESCE(NULLIF(%s, ''), 'unknown')              AS bucket,
       count(*)::int                                    AS events,
       count(DISTINCT subscriber_email)::int            AS unique_contacts
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND campaign_id::text = $2
   AND event_type IN ('opened', 'clicked')
 GROUP BY 1
 ORDER BY events DESC
 LIMIT 100`, column)
		rows, err := tx.Query(ctx, q, tenantID, in.CampaignID)
		if err != nil {
			return nil, fmt.Errorf("query %s breakdown: %w", label, err)
		}
		defer rows.Close()
		type bucketRow struct {
			Bucket         string `json:"bucket"`
			Events         int    `json:"events"`
			UniqueContacts int    `json:"unique_contacts"`
		}
		out := make([]bucketRow, 0, 16)
		for rows.Next() {
			var r bucketRow
			if err := rows.Scan(&r.Bucket, &r.Events, &r.UniqueContacts); err != nil {
				return nil, err
			}
			out = append(out, r)
		}
		return map[string]any{"campaign_id": in.CampaignID, label: out, "count": len(out)}, nil
	})
}

func handleCampaignDevices(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	return breakdownByColumn(ctx, d, args, "device", "devices")
}

func handleCampaignGeography(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	return breakdownByColumn(ctx, d, args, "country", "countries")
}
