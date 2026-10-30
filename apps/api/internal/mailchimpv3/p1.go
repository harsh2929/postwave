package mailchimpv3

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/replies"
	"github.com/postwave/postwave/packages/runtime/campaigndispatch"
)

var ErrConflict = errors.New("mailchimp compatibility state conflict")

func (r *Repo) CampaignPlanner(ctx context.Context, tenant *middleware.Tenant, q PlannerQuery) (*CampaignPlannerResponse, error) {
	start, end := plannerWindow(q)
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	out := &CampaignPlannerResponse{
		Window: map[string]string{
			"start": start.Format(time.RFC3339),
			"end":   end.Format(time.RFC3339),
		},
		Goals:       []CampaignGoal{},
		Touchpoints: []CampaignTouchpoint{},
		Tasks:       []CampaignTask{},
		Channels:    []PlannerChannel{},
		Capabilities: []PlannerCapability{
			{Feature: "email_calendar", Status: "available", Detail: "Email campaigns are shown by scheduled, sent, or created date."},
			{Feature: "sms_calendar", Status: "available", Detail: "SMS campaigns are shown when the SMS module is enabled."},
			{Feature: "task_planning", Status: "available", Detail: "Operational tasks are generated from campaign lifecycle state and grouped into planner phases."},
			{Feature: "social_scheduling", Status: "available_requires_provider", Detail: "Social posts can be attached to campaigns and show on the planner; live publishing remains gated by Facebook/Instagram provider credentials."},
			{Feature: "ads_planning", Status: "available_requires_provider", Detail: "Google and Meta ad plans are shown alongside email/SMS touchpoints with ROI attribution when events arrive."},
			{Feature: "survey_landing_pages", Status: "available", Detail: "Surveys and landing pages are part of the campaign calendar when they have campaign links or recent activity."},
			{Feature: "reporting_rollup", Status: "available", Detail: "Email, SMS, social, ads, survey, and landing-page reporting rollups are normalized into planner cards."},
		},
		Summary: map[string]int{},
		Reports: []PlannerReportRollup{},
	}
	channelSummary := map[string]*PlannerChannel{}

	rows, err := tx.Query(ctx, `
SELECT c.id::text, c.name, c.status, c.campaign_type, c.scheduled_at, c.sent_at,
       c.created_at, c.delivery_settings,
       count(*) FILTER (WHERE e.event_type IN ('sent','delivered'))::int,
       count(DISTINCT e.subscriber_email) FILTER (WHERE e.event_type = 'opened')::int,
       count(DISTINCT e.subscriber_email) FILTER (WHERE e.event_type = 'clicked')::int
  FROM campaigns c
  LEFT JOIN campaign_report_events e
    ON e.tenant_id = c.tenant_id AND e.campaign_id = c.id
 WHERE c.tenant_id = $1::uuid
   AND COALESCE(c.scheduled_at, c.sent_at, c.created_at) >= $2
   AND COALESCE(c.scheduled_at, c.sent_at, c.created_at) < $3
 GROUP BY c.id
 ORDER BY COALESCE(c.scheduled_at, c.sent_at, c.created_at) ASC`, tenant.ID, start, end)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, name, status, typ string
		var scheduledAt, sentAt *time.Time
		var createdAt time.Time
		var deliveryRaw []byte
		var sent, opened, clicked int
		if err := rows.Scan(&id, &name, &status, &typ, &scheduledAt, &sentAt, &createdAt, &deliveryRaw, &sent, &opened, &clicked); err != nil {
			return nil, err
		}
		when := createdAt
		if scheduledAt != nil {
			when = *scheduledAt
		} else if sentAt != nil {
			when = *sentAt
		}
		out.Summary["email"]++
		out.Summary[status]++
		bumpPlannerChannel(channelSummary, "email", status)
		report := map[string]any{"sent": sent, "opened": opened, "clicked": clicked}
		out.Touchpoints = append(out.Touchpoints, CampaignTouchpoint{
			ID: id, Channel: "email", Kind: defaulted(typ, "regular"), Name: name,
			Status: status, ScheduledAt: scheduledAt, SentAt: sentAt, CampaignID: id,
			ItemType: "campaign", Links: plannerCampaignLinks(id), Report: report,
		})
		denom := sent
		openRate, clickRate := 0.0, 0.0
		if denom > 0 {
			openRate = float64(opened) / float64(denom)
			clickRate = float64(clicked) / float64(denom)
		}
		out.Reports = append(out.Reports, PlannerReportRollup{
			CampaignID: id, Name: name, Channel: "email", Sent: sent, Opened: opened, Clicked: clicked,
			OpenRate: openRate, ClickRate: clickRate,
		})
		out.Goals = append(out.Goals, plannerGoals(id, name, when, deliveryRaw, openRate, clickRate)...)
		out.Tasks = append(out.Tasks, plannerTasks(id, name, status, scheduledAt, sentAt)...)
		out.Touchpoints = append(out.Touchpoints, plannerAttachedTouchpoints(id, name, deliveryRaw, channelSummary, out.Summary)...)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if ok, err := relationExists(ctx, tx, "sms_campaigns"); err != nil {
		return nil, err
	} else if ok {
		smsRows, err := tx.Query(ctx, `
SELECT id::text, name, status, scheduled_at, sent_at, stats
  FROM sms_campaigns
 WHERE tenant_id = $1::uuid
   AND COALESCE(scheduled_at, sent_at, created_at) >= $2
   AND COALESCE(scheduled_at, sent_at, created_at) < $3
 ORDER BY COALESCE(scheduled_at, sent_at, created_at) ASC`, tenant.ID, start, end)
		if err != nil {
			return nil, err
		}
		defer smsRows.Close()
		for smsRows.Next() {
			var id, name, status string
			var scheduledAt, sentAt *time.Time
			var statsRaw []byte
			if err := smsRows.Scan(&id, &name, &status, &scheduledAt, &sentAt, &statsRaw); err != nil {
				return nil, err
			}
			stats := map[string]any{}
			_ = json.Unmarshal(statsRaw, &stats)
			out.Summary["sms"]++
			out.Summary["sms_"+status]++
			bumpPlannerChannel(channelSummary, "sms", status)
			out.Touchpoints = append(out.Touchpoints, CampaignTouchpoint{
				ID: id, Channel: "sms", Kind: "broadcast", Name: name, Status: status,
				ScheduledAt: scheduledAt, SentAt: sentAt, CampaignID: id, ItemType: "campaign",
				Links: map[string]string{"report": "/api/mailchimp/3.0/growth/channels"}, Report: stats,
			})
		}
		if err := smsRows.Err(); err != nil {
			return nil, err
		}
	}
	sort.Slice(out.Touchpoints, func(i, j int) bool {
		return touchpointTime(out.Touchpoints[i]).Before(touchpointTime(out.Touchpoints[j]))
	})
	if err := appendGrowthPlannerTouchpoints(ctx, tx, tenant.ID, start, end, out, channelSummary); err != nil {
		return nil, err
	}
	sort.Slice(out.Touchpoints, func(i, j int) bool {
		return touchpointTime(out.Touchpoints[i]).Before(touchpointTime(out.Touchpoints[j]))
	})
	out.Channels = plannerChannels(channelSummary)
	out.Workflow = buildPlannerWorkflow(*out)
	return out, tx.Commit(ctx)
}

func (r *Repo) GetMultivariateTest(ctx context.Context, tenant *middleware.Tenant, campaignID string) (*MultivariateTest, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureCampaign(ctx, tx, tenant.ID, campaignID); err != nil {
		return nil, err
	}
	out := &MultivariateTest{
		CampaignID:            campaignID,
		WinnerMetric:          "open_rate",
		EvaluationWindowHours: 24,
		SamplePct:             100,
		WinnerRecipientsPct:   100,
		Variations:            []MultivariateVariation{},
		Dimensions:            []string{},
		Limits:                map[string]any{"max_variations": 8, "dimensions": []string{"subject", "from_name", "content", "send_time"}},
		Report:                []MultivariateReportRow{},
	}
	var winningID *string
	var campaignStatus string
	if err := tx.QueryRow(ctx, `
SELECT status FROM campaigns WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenant.ID, campaignID).Scan(&campaignStatus); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	err = tx.QueryRow(ctx, `
SELECT COALESCE(winner_metric, 'open_rate'), evaluation_window_hours,
       winner_recipients_pct::float8, winner_decided_at,
       winning_variant_id::text, sample_pct::float8
  FROM campaign_ab_settings
 WHERE tenant_id = $1::uuid AND campaign_id::text = $2`, tenant.ID, campaignID).
		Scan(&out.WinnerMetric, &out.EvaluationWindowHours, &out.WinnerRecipientsPct, &out.WinnerDecidedAt, &winningID, &out.SamplePct)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	if winningID != nil {
		out.WinningVariantID = *winningID
	}
	rawResults := []multivariateRawResult{}
	rows, err := tx.Query(ctx, `
SELECT v.id::text, v.variant_label, COALESCE(v.subject, ''), COALESCE(v.from_name, ''),
       COALESCE(v.from_email, ''), COALESCE(v.body_html, ''), COALESCE(v.body_mjml, ''),
       v.send_time_offset_minutes, v.weight::float8,
       COALESCE(r.recipients_count, 0), COALESCE(r.delivered, 0), COALESCE(r.opens, 0),
       COALESCE(r.clicks, 0), COALESCE(r.unsubscribes, 0), COALESCE(r.complaints, 0),
       COALESCE(r.winner, false)
  FROM campaign_variants v
  LEFT JOIN campaign_variant_results r ON r.tenant_id = v.tenant_id AND r.variant_id = v.id
 WHERE v.tenant_id = $1::uuid AND v.campaign_id::text = $2
 ORDER BY v.variant_label`, tenant.ID, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	dims := map[string]bool{}
	for rows.Next() {
		var v MultivariateVariation
		var recipients, delivered, opens, clicks, unsubscribes, complaints int
		var winner bool
		if err := rows.Scan(&v.ID, &v.Label, &v.SubjectLine, &v.FromName, &v.FromEmail, &v.HTML, &v.MJML,
			&v.SendTimeOffsetMinutes, &v.Weight, &recipients, &delivered, &opens, &clicks, &unsubscribes, &complaints, &winner); err != nil {
			return nil, err
		}
		if v.SubjectLine != "" {
			dims["subject"] = true
		}
		if v.FromName != "" || v.FromEmail != "" {
			dims["from_name"] = true
		}
		if v.HTML != "" || v.MJML != "" {
			dims["content"] = true
		}
		if v.SendTimeOffsetMinutes != 0 {
			dims["send_time"] = true
		}
		v.Results = map[string]any{
			"recipients_count": recipients, "delivered": delivered, "opens": opens, "clicks": clicks,
			"unsubscribes": unsubscribes, "complaints": complaints, "winner": winner,
		}
		out.Variations = append(out.Variations, v)
		rawResults = append(rawResults, multivariateRawResult{variation: v, recipients: recipients, delivered: delivered, opens: opens, clicks: clicks, unsubscribes: unsubscribes, complaints: complaints, winner: winner})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out.Enabled = len(out.Variations) > 0
	for _, dim := range []string{"subject", "from_name", "content", "send_time"} {
		if dims[dim] {
			out.Dimensions = append(out.Dimensions, dim)
		}
	}
	out.Report = multivariateReportRows(rawResults, out.WinnerMetric)
	out.Execution = multivariateExecution(campaignStatus, out)
	return out, tx.Commit(ctx)
}

func (r *Repo) UpsertMultivariateTest(ctx context.Context, tenant *middleware.Tenant, campaignID string, in MultivariateTestInput) (*MultivariateTest, error) {
	if len(in.Variations) < 2 || len(in.Variations) > 8 {
		return nil, ErrConflict
	}
	metric := normalizeWinnerMetric(in.WinnerMetric)
	window := in.EvaluationWindowHours
	if window <= 0 {
		window = 24
	}
	samplePct := boundedPct(in.SamplePct, 100)
	winnerPct := boundedPct(in.WinnerRecipientsPct, 100)

	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureCampaign(ctx, tx, tenant.ID, campaignID); err != nil {
		return nil, err
	}
	// Same rule as the canonical variant writer: campaign_variants is read per
	// batch by the send loop, and this method deletes the arms the client
	// omitted. It also writes campaigns.campaign_type, which is frozen content.
	if err := campaigndispatch.RequireEditable(ctx, tx, tenant.ID, campaignID); err != nil {
		if errors.Is(err, campaigndispatch.ErrContentFrozen) {
			return nil, ErrCampaignDispatching
		}
		return nil, err
	}
	labels := make([]string, 0, len(in.Variations))
	seen := map[string]bool{}
	for i, raw := range in.Variations {
		label := strings.ToUpper(strings.TrimSpace(raw.Label))
		if label == "" {
			label = string(rune('A' + i))
		}
		if seen[label] {
			return nil, ErrConflict
		}
		seen[label] = true
		labels = append(labels, label)
		weight := raw.Weight
		if weight <= 0 {
			weight = 100 / float64(len(in.Variations))
		}
		_, err := tx.Exec(ctx, `
INSERT INTO campaign_variants (
  campaign_id, tenant_id, variant_label, subject, from_name, from_email,
  body_html, body_mjml, send_time_offset_minutes, weight
)
VALUES ($1::uuid, $2::uuid, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''),
        NULLIF($7, ''), NULLIF($8, ''), $9, $10)
ON CONFLICT (campaign_id, variant_label) DO UPDATE SET
  subject = EXCLUDED.subject,
  from_name = EXCLUDED.from_name,
  from_email = EXCLUDED.from_email,
  body_html = EXCLUDED.body_html,
  body_mjml = EXCLUDED.body_mjml,
  send_time_offset_minutes = EXCLUDED.send_time_offset_minutes,
  weight = EXCLUDED.weight`,
			campaignID, tenant.ID, label, raw.SubjectLine, raw.FromName, raw.FromEmail,
			raw.HTML, raw.MJML, raw.SendTimeOffsetMinutes, weight)
		if err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `
DELETE FROM campaign_variants
 WHERE tenant_id = $1::uuid AND campaign_id::text = $2 AND NOT (variant_label = ANY($3::text[]))`,
		tenant.ID, campaignID, labels); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_ab_settings (
  campaign_id, tenant_id, winner_metric, evaluation_window_hours,
  winner_recipients_pct, sample_pct
)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)
ON CONFLICT (campaign_id) DO UPDATE SET
  tenant_id = EXCLUDED.tenant_id,
  winner_metric = EXCLUDED.winner_metric,
  evaluation_window_hours = EXCLUDED.evaluation_window_hours,
  winner_recipients_pct = EXCLUDED.winner_recipients_pct,
  sample_pct = EXCLUDED.sample_pct`,
		campaignID, tenant.ID, metric, window, winnerPct, samplePct); err != nil {
		return nil, err
	}
	meta, _ := json.Marshal(map[string]any{
		"enabled":                 true,
		"source":                  "mailchimp_v3_multivariate",
		"variant_count":           len(in.Variations),
		"dimensions":              multivariateInputDimensions(in.Variations),
		"sample_pct":              samplePct,
		"winner_recipients_pct":   winnerPct,
		"evaluation_window_hours": window,
		"updated_at":              time.Now().UTC().Format(time.RFC3339),
	})
	if _, err := tx.Exec(ctx, `
UPDATE campaigns
   SET campaign_type = CASE WHEN COALESCE(campaign_type, '') = '' THEN 'multivariate' ELSE campaign_type END,
       delivery_settings = delivery_settings || jsonb_build_object('multivariate_test', $3::jsonb),
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenant.ID, campaignID, string(meta)); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return r.GetMultivariateTest(ctx, tenant, campaignID)
}

func (r *Repo) SendTimeOptimization(ctx context.Context, tenant *middleware.Tenant, campaignID string) (*SendTimeOptimizationResponse, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureCampaign(ctx, tx, tenant.ID, campaignID); err != nil {
		return nil, err
	}
	since := time.Now().UTC().AddDate(-2, 0, 0)
	type bucket struct{ delivered, opens, clicks int }
	hours := map[int]bucket{}
	var points int
	rows, err := tx.Query(ctx, `
SELECT EXTRACT(HOUR FROM at)::int,
       count(*) FILTER (WHERE event_type IN ('sent','delivered'))::int,
       count(*) FILTER (WHERE event_type = 'opened')::int,
       count(*) FILTER (WHERE event_type = 'clicked')::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND at >= $2
   AND event_type IN ('sent','delivered','opened','clicked')
 GROUP BY 1`, tenant.ID, since)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var h, delivered, opens, clicks int
		if err := rows.Scan(&h, &delivered, &opens, &clicks); err != nil {
			rows.Close()
			return nil, err
		}
		hours[h] = bucket{delivered: delivered, opens: opens, clicks: clicks}
		points += delivered + opens + clicks
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	candidates := []OptimizationCandidate{}
	for i := 1; i <= 24; i++ {
		when := now.Add(time.Duration(i) * time.Hour).Truncate(time.Hour)
		h := when.Hour()
		b := hours[h]
		score := smoothedEngagementScore(b.delivered, b.opens, b.clicks, points)
		if points == 0 {
			score = fallbackHourScore(when)
		}
		candidates = append(candidates, OptimizationCandidate{
			Label: hourLabel(h), SendAt: when, Score: round2(score), Opens: b.opens, Clicks: b.clicks,
			Delivered: b.delivered, EngagementRate: engagementRate(b.delivered, b.opens, b.clicks),
			Confidence: confidence(points), Grade: optimizationGrade(score, points),
		})
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].Score == candidates[j].Score {
			return candidates[i].SendAt.Before(candidates[j].SendAt)
		}
		return candidates[i].Score > candidates[j].Score
	})
	rec := OptimizationRecommendation{
		Label: candidates[0].Label, SendAt: candidates[0].SendAt, Score: candidates[0].Score,
		Confidence: candidates[0].Confidence, Grade: candidates[0].Grade,
		Reason:     "Ranked from a smoothed tenant-level engagement model over the last two years; clicks carry double weight and low-sample buckets are shrunk toward the tenant baseline.",
		MethodNote: "Bayesian-smoothed hour-of-day engagement, not a cross-tenant black-box model.",
	}
	method := "tenant_engagement"
	if points == 0 {
		method = "cold_start_prior"
		rec.Reason = "No recent tenant engagement was available, so Moosewave used a conservative weekday-business-hour prior."
		rec.MethodNote = "Cold-start prior only; connect/import historical events for predictive ranking."
	}
	return &SendTimeOptimizationResponse{
		CampaignID: campaignID, Recommendation: rec, Candidates: candidates[:minInt(len(candidates), 24)],
		HistoricalWindow: map[string]string{"start": since.Format(time.RFC3339), "end": now.Format(time.RFC3339)},
		DataPoints:       points, Method: method,
	}, tx.Commit(ctx)
}

func (r *Repo) SendDayOptimization(ctx context.Context, tenant *middleware.Tenant, campaignID string) (*SendDayOptimizationResponse, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureCampaign(ctx, tx, tenant.ID, campaignID); err != nil {
		return nil, err
	}
	since := time.Now().UTC().AddDate(-2, 0, 0)
	type bucket struct{ delivered, opens, clicks int }
	days := map[int]bucket{}
	points := 0
	rows, err := tx.Query(ctx, `
SELECT EXTRACT(DOW FROM at)::int,
       count(*) FILTER (WHERE event_type IN ('sent','delivered'))::int,
       count(*) FILTER (WHERE event_type = 'opened')::int,
       count(*) FILTER (WHERE event_type = 'clicked')::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND at >= $2
   AND event_type IN ('sent','delivered','opened','clicked')
 GROUP BY 1`, tenant.ID, since)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var d, delivered, opens, clicks int
		if err := rows.Scan(&d, &delivered, &opens, &clicks); err != nil {
			rows.Close()
			return nil, err
		}
		days[d] = bucket{delivered: delivered, opens: opens, clicks: clicks}
		points += delivered + opens + clicks
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	candidates := []OptimizationCandidate{}
	for d := 0; d < 7; d++ {
		b := days[d]
		score := smoothedEngagementScore(b.delivered, b.opens, b.clicks, points)
		if points == 0 {
			score = fallbackDayScore(d)
		}
		candidates = append(candidates, OptimizationCandidate{
			Label: weekdayLabel(d), SendAt: nextWeekday(now, d), Score: round2(score),
			Opens: b.opens, Clicks: b.clicks, Delivered: b.delivered,
			EngagementRate: engagementRate(b.delivered, b.opens, b.clicks),
			Confidence:     confidence(points), Grade: optimizationGrade(score, points),
		})
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].Score == candidates[j].Score {
			return candidates[i].SendAt.Before(candidates[j].SendAt)
		}
		return candidates[i].Score > candidates[j].Score
	})
	rec := OptimizationRecommendation{
		Label: candidates[0].Label, SendAt: candidates[0].SendAt, Score: candidates[0].Score,
		Confidence: candidates[0].Confidence, Grade: candidates[0].Grade,
		Reason:     "Ranked from smoothed tenant-level click and open trends by day of week during the last two years.",
		MethodNote: "Bayesian-smoothed day-of-week engagement, with best/better/good grades derived from the campaign candidate set.",
	}
	method := "tenant_engagement"
	if points == 0 {
		method = "cold_start_prior"
		rec.Reason = "No recent tenant engagement was available, so Moosewave used a conservative Tuesday-through-Thursday prior."
		rec.MethodNote = "Cold-start prior only; connect/import historical events for predictive ranking."
	}
	return &SendDayOptimizationResponse{
		CampaignID: campaignID, Recommendation: rec, Days: candidates,
		HistoricalWindow: map[string]string{"start": since.Format(time.RFC3339), "end": now.Format(time.RFC3339)},
		DataPoints:       points, Method: method,
	}, tx.Commit(ctx)
}

func (r *Repo) ClickMap(ctx context.Context, tenant *middleware.Tenant, campaignID string) (*ClickMapResponse, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var html string
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(body_html, '')
  FROM campaigns
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenant.ID, campaignID).Scan(&html); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	type agg struct {
		link ClickMapLink
	}
	links := map[string]*agg{}
	for _, href := range extractHrefs(html) {
		links[href] = &agg{link: ClickMapLink{LinkID: stableID(href), URL: href, Devices: map[string]int{}}}
	}
	rows, err := tx.Query(ctx, `
SELECT COALESCE(link_url, ''), COALESCE(device, 'unknown'),
       COALESCE(metadata->>'selector', ''),
       count(*)::int, count(DISTINCT subscriber_email)::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND campaign_id::text = $2
   AND event_type = 'clicked'
   AND COALESCE(link_url, '') <> ''
 GROUP BY 1, 2, 3
 ORDER BY count(*) DESC`, tenant.ID, campaignID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	total := 0
	deviceTotals := map[string]int{}
	for rows.Next() {
		var url, device, selector string
		var clicks, unique int
		if err := rows.Scan(&url, &device, &selector, &clicks, &unique); err != nil {
			return nil, err
		}
		if links[url] == nil {
			links[url] = &agg{link: ClickMapLink{LinkID: stableID(url), URL: url, Devices: map[string]int{}}}
		}
		l := &links[url].link
		l.Clicks += clicks
		l.UniqueClicks += unique
		if l.Selector == "" {
			l.Selector = selector
		}
		l.Devices[device] += clicks
		deviceTotals[device] += clicks
		total += clicks
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	outLinks := make([]ClickMapLink, 0, len(links))
	orderedHrefs := extractHrefs(html)
	order := map[string]int{}
	for i, href := range orderedHrefs {
		order[href] = i
	}
	for _, a := range links {
		if total > 0 {
			a.link.Share = float64(a.link.Clicks) / float64(total)
		}
		a.link.Coordinates = clickMapCoordinates(order[a.link.URL], len(orderedHrefs), a.link.Share)
		outLinks = append(outLinks, a.link)
	}
	sort.Slice(outLinks, func(i, j int) bool {
		if outLinks[i].Clicks == outLinks[j].Clicks {
			return outLinks[i].URL < outLinks[j].URL
		}
		return outLinks[i].Clicks > outLinks[j].Clicks
	})
	deviceViews := []ClickMapDevice{}
	for device, count := range deviceTotals {
		deviceLinks := []ClickMapLink{}
		for _, link := range outLinks {
			if link.Devices[device] > 0 {
				copy := link
				copy.Clicks = link.Devices[device]
				copy.Share = float64(copy.Clicks) / float64(count)
				deviceLinks = append(deviceLinks, copy)
			}
		}
		deviceViews = append(deviceViews, ClickMapDevice{Device: device, TotalClicks: count, Links: deviceLinks})
	}
	sort.Slice(deviceViews, func(i, j int) bool { return deviceViews[i].TotalClicks > deviceViews[j].TotalClicks })
	return &ClickMapResponse{
		CampaignID: campaignID, TotalClicks: total, Links: outLinks, DeviceViews: deviceViews,
		Overlay: ClickMapOverlay{
			HTML: html, RenderHint: "Render the campaign HTML in a 640px email viewport and place each marker at link.coordinates.x/y percentages.",
			Width: 640, Height: maxInt(640, 180+len(orderedHrefs)*96),
			Legend: map[string]any{"scale": "share_of_total_clicks", "devices": len(deviceViews), "links": len(outLinks)},
		},
		GeneratedAt: time.Now().UTC(),
	}, tx.Commit(ctx)
}

func (r *Repo) CustomReport(ctx context.Context, tenant *middleware.Tenant, in CustomReportInput) (*CustomReportResponse, error) {
	start, end := reportWindow(in.StartDate, in.EndDate)
	metrics := normalizeMetrics(in.Metrics)
	groupBy := normalizeGroupBy(in.GroupBy)
	view := defaulted(in.View, "table")
	filters := nonNilStringMap(in.Filters)

	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	args := []any{tenant.ID, start, end}
	where := ` WHERE e.tenant_id = $1::uuid AND e.at >= $2 AND e.at < $3`
	if cid := strings.TrimSpace(filters["campaign_id"]); cid != "" {
		args = append(args, cid)
		where += fmt.Sprintf(` AND e.campaign_id::text = $%d`, len(args))
	}
	if typ := strings.TrimSpace(filters["event_type"]); typ != "" {
		args = append(args, typ)
		where += fmt.Sprintf(` AND e.event_type = $%d`, len(args))
	}
	for _, filter := range []string{"device", "country", "client", "source", "channel"} {
		if v := strings.TrimSpace(filters[filter]); v != "" {
			args = append(args, v)
			where += fmt.Sprintf(` AND %s = $%d`, customReportFilterSQL(filter), len(args))
		}
	}

	dims := make([]string, 0, len(groupBy))
	for i, dim := range groupBy {
		dims = append(dims, customReportDimensionSQL(dim)+fmt.Sprintf(" AS d%d", i))
	}
	metricSQL := make([]string, 0, len(metrics))
	for i, metric := range metrics {
		metricSQL = append(metricSQL, customReportMetricSQL(metric)+fmt.Sprintf(" AS m%d", i))
	}
	groupClause := ""
	if len(dims) > 0 {
		ords := make([]string, len(dims))
		for i := range dims {
			ords[i] = fmt.Sprint(i + 1)
		}
		groupClause = " GROUP BY " + strings.Join(ords, ", ")
	}
	query := `SELECT ` + strings.Join(append(dims, metricSQL...), ", ") + `
  FROM campaign_report_events e
  LEFT JOIN campaigns c ON c.tenant_id = e.tenant_id AND c.id = e.campaign_id` + where + groupClause + ` ORDER BY 1 LIMIT 500`
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	outRows := []CustomReportRow{}
	for rows.Next() {
		dimVals := make([]string, len(groupBy))
		metricVals := make([]float64, len(metrics))
		dest := make([]any, 0, len(groupBy)+len(metrics))
		for i := range dimVals {
			dest = append(dest, &dimVals[i])
		}
		for i := range metricVals {
			dest = append(dest, &metricVals[i])
		}
		if err := rows.Scan(dest...); err != nil {
			rows.Close()
			return nil, err
		}
		row := CustomReportRow{Dimensions: map[string]string{}, Metrics: map[string]float64{}}
		for i, dim := range groupBy {
			row.Dimensions[dim] = dimVals[i]
		}
		for i, metric := range metrics {
			row.Metrics[metric] = metricVals[i]
		}
		outRows = append(outRows, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	graph, err := customReportGraph(ctx, tx, tenant.ID, start, end, filters, metrics)
	if err != nil {
		return nil, err
	}
	out := &CustomReportResponse{
		ID:   stableID(strings.Join(append(metrics, groupBy...), "|") + start.String() + end.String()),
		View: view, Metrics: metrics, GroupBy: groupBy, Filters: filters,
		Window: map[string]string{"start": start.Format(time.RFC3339), "end": end.Format(time.RFC3339)},
		Rows:   outRows, Graph: graph,
		Export:           map[string]string{"format": defaulted(in.Format, "csv"), "filename": "postwave-custom-report.csv"},
		Exports:          customReportExports(in),
		Retention:        map[string]any{"window_days": int(end.Sub(start).Hours() / 24), "max_retention": "2y", "source": "campaign_report_events"},
		AvailableMetrics: allowedCustomMetrics(),
		AvailableGroupBy: allowedCustomGroupBys(),
		GeneratedAt:      time.Now().UTC(),
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) DeliveryInsights(ctx context.Context, tenant *middleware.Tenant, campaignID string) (*DeliveryInsightsResponse, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := deliveryInsightsInTx(ctx, tx, tenant.ID, campaignID)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CancelDelivery(ctx context.Context, tenant *middleware.Tenant, campaignID string) (*DeliveryInsightsResponse, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	cancelledAt := time.Now().UTC()
	payload, _ := json.Marshal(map[string]any{
		"cancelled_at":              cancelledAt.Format(time.RFC3339),
		"cancelled_by":              "mailchimp_v3_facade",
		"provider_cancel_requested": true,
		"queue_contract":            "pending_and_sending_rows_cancelled_before_next_worker_claim",
	})
	tag, err := tx.Exec(ctx, `
UPDATE campaigns
   SET status = 'cancelled',
       delivery_settings = delivery_settings || $3::jsonb,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id::text = $2
   AND status IN ('draft', 'scheduled', 'sending', 'paused')
`, tenant.ID, campaignID, string(payload))
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		if err := ensureCampaign(ctx, tx, tenant.ID, campaignID); err != nil {
			return nil, err
		}
		return nil, ErrConflict
	}
	if _, err := tx.Exec(ctx, `
UPDATE campaign_recipients
   SET status = 'cancelled',
       error = COALESCE(error, 'campaign cancelled by Mailchimp-compatible delivery insights')
 WHERE tenant_id = $1::uuid
   AND campaign_id::text = $2
   AND status IN ('pending', 'sending')`, tenant.ID, campaignID); err != nil {
		return nil, err
	}
	out, err := deliveryInsightsInTx(ctx, tx, tenant.ID, campaignID)
	if err != nil {
		return nil, err
	}
	out.Cancelled = true
	out.QueueStoppedAt = &cancelledAt
	out.CancellationGuarantee = "local_queue_stopped"
	out.ProviderCancellation = map[string]any{
		"requested": true,
		"guarantee": "Moosewave prevents any unsent local queue rows from being claimed after cancellation; messages already handed to the ESP/provider may need provider-side suppression or support intervention.",
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) CampaignInbox(ctx context.Context, tenant *middleware.Tenant, campaignID string, offset, count int) (*CampaignInboxResponse, error) {
	offset, count = normalizeOffsetCount(offset, count)
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureCampaign(ctx, tx, tenant.ID, campaignID); err != nil {
		return nil, err
	}
	out := &CampaignInboxResponse{
		CampaignID: campaignID, Replies: []CampaignReply{}, Threads: []InboxThread{},
		CampaignSummary: map[string]any{}, ReportLinks: map[string]string{
			"campaign":      "/api/mailchimp/3.0/campaigns/" + campaignID,
			"report":        "/api/mailchimp/3.0/reports/" + campaignID,
			"custom_report": "/api/mailchimp/3.0/reports/custom?campaign_id=" + campaignID,
		},
	}
	var campaignName, campaignStatus string
	var sentAt *time.Time
	_ = tx.QueryRow(ctx, `
SELECT name, status, sent_at FROM campaigns WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenant.ID, campaignID).Scan(&campaignName, &campaignStatus, &sentAt)
	out.CampaignSummary["name"] = campaignName
	out.CampaignSummary["status"] = campaignStatus
	if sentAt != nil {
		out.CampaignSummary["sent_at"] = sentAt.Format(time.RFC3339)
	}
	var uniqueRecipients int
	if err := tx.QueryRow(ctx, `
SELECT count(DISTINCT subscriber_email)::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND campaign_id::text = $2
   AND event_type IN ('sent','delivered')
   AND subscriber_email IS NOT NULL`, tenant.ID, campaignID).Scan(&uniqueRecipients); err != nil {
		return nil, err
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*)::int, count(DISTINCT recipient_email)::int
  FROM campaign_replies
 WHERE tenant_id = $1::uuid AND campaign_id::text = $2`, tenant.ID, campaignID).
		Scan(&out.TotalItems, &out.DistinctReplyers); err != nil {
		return nil, err
	}
	_ = tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE metadata->>'resolved_at' IS NULL)::int, max(received_at)
  FROM campaign_replies
 WHERE tenant_id = $1::uuid AND campaign_id::text = $2`, tenant.ID, campaignID).
		Scan(&out.FollowUpOpen, &out.LastReplyAt)
	// REPLY RATE COUNTS HUMANS ONLY, unlike the inbox counts above.
	//
	// `TotalItems` and `DistinctReplyers` describe what the inbox CONTAINS, and
	// an operator legitimately wants an out-of-office to appear there. A
	// reply RATE is an engagement metric, and counting auto-responders into it
	// inflates the number that people judge a campaign by — a vacation
	// autoresponder is not somebody replying.
	//
	// Uses replies.HumanEngagementPredicate rather than an inlined
	// `classification = 'human_reply'`: the shared constant is what
	// TestEveryEngagementReaderUsesTheSharedPredicate enforces, and an inlined
	// copy would pass a text search while being free to drift.
	var humanReplyers int
	if err := tx.QueryRow(ctx, `
SELECT count(DISTINCT recipient_email)::int
  FROM campaign_replies
 WHERE tenant_id = $1::uuid AND campaign_id::text = $2`+
		replies.HumanEngagementPredicate, tenant.ID, campaignID).Scan(&humanReplyers); err != nil {
		return nil, err
	}
	if uniqueRecipients > 0 {
		out.ReplyRate = float64(humanReplyers) / float64(uniqueRecipients)
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, recipient_email::text, COALESCE(subject, ''),
       COALESCE(body_snippet, ''), source, received_at, metadata->>'resolved_at'
  FROM campaign_replies
 WHERE tenant_id = $1::uuid AND campaign_id::text = $2
 ORDER BY received_at DESC
 LIMIT $3 OFFSET $4`, tenant.ID, campaignID, count, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	threads := map[string]*InboxThread{}
	for rows.Next() {
		var reply CampaignReply
		var resolvedAt *string
		if err := rows.Scan(&reply.ID, &reply.EmailAddress, &reply.Subject, &reply.Snippet, &reply.Source, &reply.ReceivedAt, &resolvedAt); err != nil {
			return nil, err
		}
		reply.NeedsFollowUp = resolvedAt == nil || strings.TrimSpace(*resolvedAt) == ""
		out.Replies = append(out.Replies, reply)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	threadRows, err := tx.Query(ctx, `
SELECT recipient_email::text, count(*)::int, max(received_at)
  FROM campaign_replies
 WHERE tenant_id = $1::uuid AND campaign_id::text = $2
 GROUP BY recipient_email
 ORDER BY max(received_at) DESC
 LIMIT 100`, tenant.ID, campaignID)
	if err != nil {
		return nil, err
	}
	defer threadRows.Close()
	for threadRows.Next() {
		var email string
		var replies int
		var lastAt time.Time
		if err := threadRows.Scan(&email, &replies, &lastAt); err != nil {
			return nil, err
		}
		threads[strings.ToLower(email)] = &InboxThread{EmailAddress: email, Replies: replies, LastAt: lastAt}
	}
	if err := threadRows.Err(); err != nil {
		return nil, err
	}
	for i := range out.Replies {
		reply := out.Replies[i]
		key := strings.ToLower(reply.EmailAddress)
		if threads[key] == nil {
			threads[key] = &InboxThread{EmailAddress: reply.EmailAddress, LastAt: reply.ReceivedAt, LastSubject: reply.Subject, LastSnippet: reply.Snippet}
		}
		if threads[key].LastSubject == "" {
			threads[key].LastSubject = reply.Subject
			threads[key].LastSnippet = reply.Snippet
		}
	}
	for _, th := range threads {
		out.Threads = append(out.Threads, *th)
	}
	sort.Slice(out.Threads, func(i, j int) bool { return out.Threads[i].LastAt.After(out.Threads[j].LastAt) })
	return out, tx.Commit(ctx)
}

func plannerCampaignLinks(campaignID string) map[string]string {
	return map[string]string{
		"campaign": "/api/mailchimp/3.0/campaigns/" + campaignID,
		"report":   "/api/mailchimp/3.0/reports/" + campaignID,
		"inbox":    "/api/mailchimp/3.0/campaigns/" + campaignID + "/inbox",
	}
}

func bumpPlannerChannel(channels map[string]*PlannerChannel, channel, status string) {
	if channel == "" {
		channel = "unknown"
	}
	if channels[channel] == nil {
		channels[channel] = &PlannerChannel{Channel: channel}
	}
	switch status {
	case "draft":
		channels[channel].Draft++
	case "scheduled":
		channels[channel].Scheduled++
	case "sending":
		channels[channel].Sending++
	case "sent":
		channels[channel].Sent++
	case "cancelled":
		channels[channel].Cancelled++
	case "failed":
		channels[channel].Failed++
	default:
		channels[channel].Planned++
	}
}

func plannerChannels(in map[string]*PlannerChannel) []PlannerChannel {
	out := make([]PlannerChannel, 0, len(in))
	for _, channel := range in {
		out = append(out, *channel)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Channel < out[j].Channel })
	return out
}

func plannerAttachedTouchpoints(campaignID, campaignName string, raw []byte, channels map[string]*PlannerChannel, summary map[string]int) []CampaignTouchpoint {
	settings := map[string]any{}
	_ = json.Unmarshal(raw, &settings)
	out := []CampaignTouchpoint{}
	for _, item := range asMapSlice(settings["social_posts"]) {
		id := firstNonEmpty(stringValue(item, "id"), stableID(campaignID+"social"+stringValue(item, "network")+stringValue(item, "text")))
		status := firstNonEmpty(stringValue(item, "status"), "planned")
		network := firstNonEmpty(stringValue(item, "network"), "social")
		when := plannerItemTime(item)
		out = append(out, CampaignTouchpoint{
			ID: id, Channel: "social", Kind: network, Name: firstNonEmpty(stringValue(item, "name"), campaignName+" social post"),
			Status: status, ScheduledAt: when, CampaignID: campaignID, ParentCampaignID: campaignID,
			ItemType: "social_post", Links: map[string]string{"report": "/api/mailchimp/3.0/social-posts/" + id + "/report"},
			Report: map[string]any{"network": network, "provider_status": stringValue(item, "provider_status")},
		})
		bumpPlannerChannel(channels, "social", status)
		summary["social"]++
	}
	for _, item := range asMapSlice(settings["ads"]) {
		id := firstNonEmpty(stringValue(item, "id"), stableID(campaignID+"ad"+stringValue(item, "channel")+stringValue(item, "name")))
		status := firstNonEmpty(stringValue(item, "status"), "planned")
		channel := firstNonEmpty(stringValue(item, "channel"), "ads")
		when := plannerItemTime(item)
		out = append(out, CampaignTouchpoint{
			ID: id, Channel: "ads", Kind: channel, Name: firstNonEmpty(stringValue(item, "name"), campaignName+" ad"),
			Status: status, ScheduledAt: when, CampaignID: campaignID, ParentCampaignID: campaignID,
			ItemType: "ad_campaign", Links: map[string]string{"report": "/api/mailchimp/3.0/ads/" + id + "/report"},
			Report: map[string]any{"budget_cents": item["budget_cents"], "provider_status": stringValue(item, "provider_status")},
		})
		bumpPlannerChannel(channels, "ads", status)
		summary["ads"]++
	}
	return out
}

func plannerItemTime(item map[string]any) *time.Time {
	for _, key := range []string{"scheduled_at", "send_at", "starts_at", "publish_at"} {
		if raw := strings.TrimSpace(stringValue(item, key)); raw != "" {
			if t, err := time.Parse(time.RFC3339, raw); err == nil {
				u := t.UTC()
				return &u
			}
		}
	}
	return nil
}

func appendGrowthPlannerTouchpoints(ctx context.Context, tx pgx.Tx, tenantID string, start, end time.Time, out *CampaignPlannerResponse, channels map[string]*PlannerChannel) error {
	if ok, err := relationExists(ctx, tx, "landing_pages"); err != nil {
		return err
	} else if ok {
		rows, err := tx.Query(ctx, `
SELECT id::text, name, slug, status, updated_at, tracking
  FROM landing_pages
 WHERE tenant_id = $1::uuid AND updated_at >= $2 AND updated_at < $3
 ORDER BY updated_at ASC`, tenantID, start, end)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id, name, slug, status string
			var updated time.Time
			var trackingRaw []byte
			if err := rows.Scan(&id, &name, &slug, &status, &updated, &trackingRaw); err != nil {
				rows.Close()
				return err
			}
			tracking := map[string]any{}
			_ = json.Unmarshal(trackingRaw, &tracking)
			u := updated
			out.Touchpoints = append(out.Touchpoints, CampaignTouchpoint{
				ID: id, Channel: "landing_page", Kind: "page", Name: name, Status: status,
				ScheduledAt: &u, ItemType: "landing_page",
				Links:  map[string]string{"page": "/api/mailchimp/3.0/landing-pages/" + id, "content": "/api/mailchimp/3.0/landing-pages/" + id + "/content"},
				Report: map[string]any{"slug": slug, "campaign_id": stringValue(tracking, "campaign_id")},
			})
			bumpPlannerChannel(channels, "landing_page", status)
			out.Summary["landing_page"]++
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
	}
	if ok, err := relationExists(ctx, tx, "popup_forms"); err != nil {
		return err
	} else if ok {
		rows, err := tx.Query(ctx, `
SELECT id::text, name, status, updated_at, metrics
  FROM popup_forms
 WHERE tenant_id = $1::uuid
   AND COALESCE(trigger->>'kind', trigger->>'type') = 'survey'
   AND updated_at >= $2 AND updated_at < $3
 ORDER BY updated_at ASC`, tenantID, start, end)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id, name, status string
			var updated time.Time
			var metricsRaw []byte
			if err := rows.Scan(&id, &name, &status, &updated, &metricsRaw); err != nil {
				rows.Close()
				return err
			}
			metrics := map[string]any{}
			_ = json.Unmarshal(metricsRaw, &metrics)
			u := updated
			out.Touchpoints = append(out.Touchpoints, CampaignTouchpoint{
				ID: id, Channel: "survey", Kind: "hosted_survey", Name: name, Status: status,
				ScheduledAt: &u, ItemType: "survey",
				Links:  map[string]string{"survey": "/api/mailchimp/3.0/surveys/" + id, "report": "/api/mailchimp/3.0/surveys/" + id + "/report"},
				Report: metrics,
			})
			bumpPlannerChannel(channels, "survey", status)
			out.Summary["survey"]++
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
	}
	return nil
}

func buildPlannerWorkflow(in CampaignPlannerResponse) PlannerWorkflow {
	// Touchpoints and Tasks are initialised rather than left to `append`. Both
	// fields carry no `omitempty`, and appending to a nil slice leaves it nil --
	// so a phase that nothing maps to serialised as null, and a workspace with an
	// empty planner (every phase empty) handed the client five nulls where it
	// types arrays.
	phases := []PlannerPhase{
		{ID: "plan", Name: "Plan", Status: "complete", Touchpoints: []string{}, Tasks: []string{}},
		{ID: "build", Name: "Build", Status: "complete", Touchpoints: []string{}, Tasks: []string{}},
		{ID: "schedule", Name: "Schedule", Status: "complete", Touchpoints: []string{}, Tasks: []string{}},
		{ID: "deliver", Name: "Deliver", Status: "complete", Touchpoints: []string{}, Tasks: []string{}},
		{ID: "report", Name: "Report", Status: "complete", Touchpoints: []string{}, Tasks: []string{}},
	}
	for _, t := range in.Touchpoints {
		phase := "plan"
		switch t.Status {
		case "draft":
			phase = "build"
		case "scheduled", "planned":
			phase = "schedule"
		case "sending":
			phase = "deliver"
		case "sent":
			phase = "report"
		}
		for i := range phases {
			if phases[i].ID == phase {
				phases[i].Touchpoints = append(phases[i].Touchpoints, t.ID)
				if t.Status == "draft" || t.Status == "sending" || t.Status == "scheduled" {
					phases[i].Status = "active"
				}
			}
		}
	}
	for _, task := range in.Tasks {
		phase := "build"
		if strings.Contains(strings.ToLower(task.Title), "report") || strings.Contains(strings.ToLower(task.Title), "reply") {
			phase = "report"
		} else if strings.Contains(strings.ToLower(task.Title), "monitor") {
			phase = "deliver"
		} else if strings.Contains(strings.ToLower(task.Title), "schedule") || strings.Contains(strings.ToLower(task.Title), "review") {
			phase = "schedule"
		}
		for i := range phases {
			if phases[i].ID == phase {
				phases[i].Tasks = append(phases[i].Tasks, task.ID)
				if task.Status == "open" {
					phases[i].Status = "active"
				}
			}
		}
	}
	return PlannerWorkflow{
		Phases: phases,
		Reporting: []map[string]string{
			{"label": "custom_report", "href": "/api/mailchimp/3.0/reports/custom"},
			{"label": "campaign_manager", "href": "/api/mailchimp/3.0/campaign-manager/insights"},
		},
		GeneratedAt: time.Now().UTC(),
		Completeness: map[string]any{
			"touchpoints": len(in.Touchpoints),
			"tasks":       len(in.Tasks),
			"reports":     len(in.Reports),
			"channels":    len(in.Channels),
		},
	}
}

func multivariateInputDimensions(vars []MultivariateVariationInput) []string {
	dims := map[string]bool{}
	for _, v := range vars {
		if strings.TrimSpace(v.SubjectLine) != "" {
			dims["subject"] = true
		}
		if strings.TrimSpace(v.FromName) != "" || strings.TrimSpace(v.FromEmail) != "" {
			dims["from_name"] = true
		}
		if strings.TrimSpace(v.HTML) != "" || strings.TrimSpace(v.MJML) != "" {
			dims["content"] = true
		}
		if v.SendTimeOffsetMinutes != 0 {
			dims["send_time"] = true
		}
	}
	out := []string{}
	for _, dim := range []string{"subject", "from_name", "content", "send_time"} {
		if dims[dim] {
			out = append(out, dim)
		}
	}
	return out
}

func multivariateExecution(status string, test *MultivariateTest) MultivariateExecution {
	warnings := []string{}
	if len(test.Variations) < 2 {
		warnings = append(warnings, "At least two variations are required before execution.")
	}
	if len(test.Variations) > 8 {
		warnings = append(warnings, "Mailchimp-compatible multivariate tests are capped at eight variations.")
	}
	if len(test.Dimensions) == 0 && len(test.Variations) > 0 {
		warnings = append(warnings, "No varying dimension was detected; variants may be identical.")
	}
	ready := len(warnings) == 0
	next := "configure_variations"
	switch {
	case !ready:
		next = "fix_warnings"
	case status == "draft":
		next = "schedule_or_send"
	case status == "scheduled":
		next = "wait_for_send"
	case status == "sending":
		next = "monitor_sample"
	case status == "sent" && test.WinningVariantID == "":
		next = "evaluate_winner"
	case test.WinningVariantID != "":
		next = "review_report"
	}
	holdout := 0.0
	if test.SamplePct < 100 {
		holdout = 100 - test.SamplePct
	}
	return MultivariateExecution{
		Status: status, Ready: ready, VariantCount: len(test.Variations), SamplePct: test.SamplePct,
		HoldoutPct: holdout, WinnerRolloutPct: test.WinnerRecipientsPct,
		Dimensions: test.Dimensions, Warnings: warnings,
		ProviderContract: "Moosewave stores variant copy, sender, content, and send-time offsets; queue cancellation and winner rollout are handled by the Moosewave campaign pipeline.",
		NextAction:       next,
	}
}

type multivariateRawResult struct {
	variation                                                      MultivariateVariation
	recipients, delivered, opens, clicks, unsubscribes, complaints int
	winner                                                         bool
}

func multivariateReportRows(rows []multivariateRawResult, metric string) []MultivariateReportRow {
	if len(rows) == 0 {
		return []MultivariateReportRow{}
	}
	control := rows[0]
	out := make([]MultivariateReportRow, 0, len(rows))
	for _, row := range rows {
		openRate := safeRate(row.opens, row.recipients)
		clickRate := safeRate(row.clicks, row.recipients)
		replyRate := 0.0
		lift := map[string]float64{
			"open_rate":  lift(openRate, safeRate(control.opens, control.recipients)),
			"click_rate": lift(clickRate, safeRate(control.clicks, control.recipients)),
		}
		conf := 0.0
		switch metric {
		case "click_rate":
			conf = twoProportionConfidence(row.clicks, row.recipients, control.clicks, control.recipients)
		default:
			conf = twoProportionConfidence(row.opens, row.recipients, control.opens, control.recipients)
		}
		out = append(out, MultivariateReportRow{
			VariantID: row.variation.ID, Label: row.variation.Label,
			Recipients: row.recipients, Delivered: row.delivered,
			OpenRate: openRate, ClickRate: clickRate, ReplyRate: replyRate,
			LiftVsControl: lift, ConfidenceVsControl: conf, Winner: row.winner,
		})
	}
	return out
}

func smoothedEngagementScore(delivered, opens, clicks, totalPoints int) float64 {
	// Beta-like smoothing: with tiny samples, buckets stay close to a
	// conservative prior instead of letting one click dominate.
	priorDelivered := 50.0
	priorEngaged := 2.5
	if totalPoints >= 500 {
		priorDelivered = 20
		priorEngaged = 1
	}
	return ((float64(opens) + 2*float64(clicks) + priorEngaged) / (float64(maxInt(delivered, 0)) + priorDelivered)) * 100
}

func engagementRate(delivered, opens, clicks int) float64 {
	if delivered <= 0 {
		return 0
	}
	return round2((float64(opens) + 2*float64(clicks)) / float64(delivered) * 100)
}

func optimizationGrade(score float64, points int) string {
	if points == 0 {
		if score >= 1 {
			return "good"
		}
		return "fair"
	}
	switch {
	case score >= 12:
		return "best"
	case score >= 6:
		return "better"
	case score >= 2:
		return "good"
	default:
		return "fair"
	}
}

func clickMapCoordinates(index, total int, share float64) map[string]float64 {
	if total <= 0 {
		total = 1
	}
	if index < 0 {
		index = 0
	}
	row := float64(index + 1)
	y := 8 + (row * (84 / float64(total+1)))
	var x float64
	if index%2 == 0 {
		x = 38
	} else {
		x = 62
	}
	radius := 8 + math.Min(24, share*40)
	return map[string]float64{"x": round2(x), "y": round2(y), "radius": round2(radius)}
}

func customReportFilterSQL(filter string) string {
	switch filter {
	case "device":
		return "COALESCE(e.device, 'unknown')"
	case "country":
		return "COALESCE(e.country, 'unknown')"
	case "client":
		return "COALESCE(e.client, 'unknown')"
	case "source":
		return "COALESCE(e.source, 'manual')"
	case "channel":
		return "COALESCE(e.metadata->>'channel', 'email')"
	default:
		return "''"
	}
}

func allowedCustomMetrics() []string {
	return []string{"sent", "delivered", "opened", "clicked", "bounced", "complained", "unsubscribed", "conversions", "revenue_cents", "unique_recipients"}
}

func allowedCustomGroupBys() []string {
	return []string{"campaign", "campaign_id", "event_type", "device", "client", "country", "link_url", "day", "hour", "email_domain", "source", "channel"}
}

func customReportExports(in CustomReportInput) map[string]string {
	base := "/api/mailchimp/3.0/reports/custom"
	query := "?metrics=" + strings.Join(normalizeMetrics(in.Metrics), ",") + "&group_by=" + strings.Join(normalizeGroupBy(in.GroupBy), ",")
	return map[string]string{
		"json": base + query + "&format=json",
		"csv":  base + query + "&format=csv",
	}
}

func customReportCSV(report *CustomReportResponse) string {
	if report == nil {
		return ""
	}
	headers := append([]string{}, report.GroupBy...)
	headers = append(headers, report.Metrics...)
	var b strings.Builder
	b.WriteString(strings.Join(headers, ","))
	b.WriteByte('\n')
	for _, row := range report.Rows {
		cols := make([]string, 0, len(headers))
		for _, dim := range report.GroupBy {
			cols = append(cols, csvCell(row.Dimensions[dim]))
		}
		for _, metric := range report.Metrics {
			cols = append(cols, fmt.Sprintf("%.4f", row.Metrics[metric]))
		}
		b.WriteString(strings.Join(cols, ","))
		b.WriteByte('\n')
	}
	return b.String()
}

func csvCell(s string) string {
	if strings.ContainsAny(s, "\",\n\r") {
		return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
	}
	return s
}

func safeRate(num, den int) float64 {
	if den <= 0 {
		return 0
	}
	return float64(num) / float64(den)
}

func lift(v, base float64) float64 {
	if base == 0 {
		if v == 0 {
			return 0
		}
		return 1
	}
	return round2((v - base) / base)
}

func twoProportionConfidence(x1, n1, x2, n2 int) float64 {
	if n1 <= 0 || n2 <= 0 {
		return 0
	}
	p1 := float64(x1) / float64(n1)
	p2 := float64(x2) / float64(n2)
	pooled := float64(x1+x2) / float64(n1+n2)
	se := math.Sqrt(pooled * (1 - pooled) * (1/float64(n1) + 1/float64(n2)))
	if se == 0 {
		return 0
	}
	z := math.Abs((p1 - p2) / se)
	return round2(math.Erf(z / math.Sqrt2))
}

func ensureCampaign(ctx context.Context, tx pgx.Tx, tenantID, campaignID string) error {
	var exists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (SELECT 1 FROM campaigns WHERE tenant_id = $1::uuid AND id::text = $2)`,
		tenantID, campaignID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrNotFound
	}
	return nil
}

func relationExists(ctx context.Context, tx pgx.Tx, name string) (bool, error) {
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT to_regclass('public.`+name+`') IS NOT NULL`).Scan(&exists); err != nil {
		return false, err
	}
	return exists, nil
}

func plannerWindow(q PlannerQuery) (time.Time, time.Time) {
	now := time.Now().UTC()
	start := q.Start
	if start.IsZero() {
		start = now.AddDate(0, -1, 0)
	}
	end := q.End
	if end.IsZero() || !end.After(start) {
		end = now.AddDate(0, 3, 0)
	}
	return start.UTC(), end.UTC()
}

func plannerGoals(campaignID, name string, due time.Time, raw []byte, openRate, clickRate float64) []CampaignGoal {
	settings := map[string]any{}
	_ = json.Unmarshal(raw, &settings)
	goalRaw, _ := settings["goal"].(map[string]any)
	if len(goalRaw) == 0 {
		return []CampaignGoal{}
	}
	metric := defaulted(stringValue(goalRaw, "metric"), "click_rate")
	target := floatValue(goalRaw, "target")
	actual := clickRate
	if metric == "open_rate" {
		actual = openRate
	}
	status := "at_risk"
	if target <= 0 || actual >= target {
		status = "on_track"
	}
	return []CampaignGoal{{
		ID: stableID(campaignID + metric), CampaignID: campaignID, Name: firstNonEmpty(stringValue(goalRaw, "name"), name+" goal"),
		Metric: metric, Target: target, Actual: actual, Status: status, DueAt: due,
	}}
}

func plannerTasks(campaignID, name, status string, scheduledAt, sentAt *time.Time) []CampaignTask {
	now := time.Now().UTC()
	switch status {
	case "draft":
		due := now.Add(24 * time.Hour)
		return []CampaignTask{{ID: stableID(campaignID + "schedule"), CampaignID: campaignID, Title: "Schedule " + name, Status: "open", Priority: "high", DueAt: &due, GeneratedBy: "planner"}}
	case "scheduled":
		due := now.Add(6 * time.Hour)
		if scheduledAt != nil {
			due = scheduledAt.Add(-2 * time.Hour)
		}
		return []CampaignTask{{ID: stableID(campaignID + "review"), CampaignID: campaignID, Title: "Review audience and suppression gates", Status: "open", Priority: "medium", DueAt: &due, GeneratedBy: "planner"}}
	case "sending":
		due := now.Add(30 * time.Minute)
		return []CampaignTask{{ID: stableID(campaignID + "monitor"), CampaignID: campaignID, Title: "Monitor delivery progress", Status: "open", Priority: "high", DueAt: &due, GeneratedBy: "planner"}}
	case "sent":
		if sentAt != nil {
			due := sentAt.Add(24 * time.Hour)
			return []CampaignTask{{ID: stableID(campaignID + "report"), CampaignID: campaignID, Title: "Review report and reply inbox", Status: "open", Priority: "medium", DueAt: &due, GeneratedBy: "planner"}}
		}
	}
	return []CampaignTask{}
}

func touchpointTime(t CampaignTouchpoint) time.Time {
	if t.ScheduledAt != nil {
		return *t.ScheduledAt
	}
	if t.SentAt != nil {
		return *t.SentAt
	}
	return time.Time{}
}

func normalizeWinnerMetric(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "click_rate", "reply_rate":
		return strings.ToLower(strings.TrimSpace(raw))
	default:
		return "open_rate"
	}
}

func boundedPct(v, fallback float64) float64 {
	if v <= 0 {
		v = fallback
	}
	if v < 1 {
		return 1
	}
	if v > 100 {
		return 100
	}
	return v
}

func hourLabel(h int) string {
	return fmt.Sprintf("%02d:00 UTC", h)
}

func confidence(points int) string {
	switch {
	case points >= 500:
		return "high"
	case points >= 100:
		return "medium"
	default:
		return "low"
	}
}

func fallbackHourScore(t time.Time) float64 {
	if t.Weekday() == time.Saturday || t.Weekday() == time.Sunday {
		return 0.4
	}
	if t.Hour() >= 9 && t.Hour() <= 11 {
		return 1.0
	}
	if t.Hour() >= 13 && t.Hour() <= 15 {
		return 0.8
	}
	return 0.3
}

func fallbackDayScore(day int) float64 {
	switch time.Weekday(day) {
	case time.Tuesday, time.Wednesday, time.Thursday:
		return 1.0
	case time.Monday:
		return 0.8
	case time.Friday:
		return 0.6
	default:
		return 0.3
	}
}

func weekdayLabel(day int) string {
	if day < 0 || day > 6 {
		day = 0
	}
	return time.Weekday(day).String()
}

func nextWeekday(now time.Time, day int) time.Time {
	target := time.Weekday(day)
	delta := int(target - now.Weekday())
	if delta <= 0 {
		delta += 7
	}
	next := now.AddDate(0, 0, delta)
	return time.Date(next.Year(), next.Month(), next.Day(), 10, 0, 0, 0, time.UTC)
}

func round2(v float64) float64 {
	return math.Round(v*100) / 100
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

var hrefRE = regexp.MustCompile(`(?i)href=["']([^"']+)["']`)

func extractHrefs(html string) []string {
	matches := hrefRE.FindAllStringSubmatch(html, -1)
	seen := map[string]bool{}
	out := []string{}
	for _, m := range matches {
		if len(m) < 2 {
			continue
		}
		href := strings.TrimSpace(m[1])
		if href == "" || seen[href] {
			continue
		}
		seen[href] = true
		out = append(out, href)
	}
	return out
}

func reportWindow(startRaw, endRaw string) (time.Time, time.Time) {
	now := time.Now().UTC()
	start := now.AddDate(-2, 0, 0)
	end := now
	if t, ok := parseReportDate(startRaw); ok {
		start = t
	}
	if t, ok := parseReportDate(endRaw); ok && t.After(start) {
		end = t
	}
	return start, end
}

func parseReportDate(raw string) (time.Time, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{time.RFC3339, "2006-01-02"} {
		if t, err := time.Parse(layout, raw); err == nil {
			return t.UTC(), true
		}
	}
	return time.Time{}, false
}

func normalizeMetrics(in []string) []string {
	allowed := map[string]bool{}
	for _, metric := range allowedCustomMetrics() {
		allowed[metric] = true
	}
	out := []string{}
	for _, raw := range in {
		m := strings.ToLower(strings.TrimSpace(raw))
		if allowed[m] {
			out = append(out, m)
		}
	}
	if len(out) == 0 {
		out = []string{"sent", "opened", "clicked", "unsubscribed", "revenue_cents"}
	}
	return out
}

func normalizeGroupBy(in []string) []string {
	allowed := map[string]bool{}
	for _, dim := range allowedCustomGroupBys() {
		allowed[dim] = true
	}
	out := []string{}
	for _, raw := range in {
		g := strings.ToLower(strings.TrimSpace(raw))
		if allowed[g] {
			out = append(out, g)
		}
	}
	if len(out) == 0 {
		out = []string{"campaign"}
	}
	return out
}

func customReportDimensionSQL(dim string) string {
	switch dim {
	case "campaign_id":
		return "e.campaign_id::text"
	case "event_type":
		return "e.event_type"
	case "device":
		return "COALESCE(e.device, 'unknown')"
	case "client":
		return "COALESCE(e.client, 'unknown')"
	case "country":
		return "COALESCE(e.country, 'unknown')"
	case "link_url":
		return "COALESCE(e.link_url, '')"
	case "source":
		return "COALESCE(e.source, 'postwave')"
	case "channel":
		return "COALESCE(e.metadata->>'channel', 'email')"
	case "day":
		return "to_char(date_trunc('day', e.at), 'YYYY-MM-DD')"
	case "hour":
		return "to_char(date_trunc('hour', e.at), 'YYYY-MM-DD HH24:00')"
	case "email_domain":
		return "COALESCE(NULLIF(split_part(e.subscriber_email::text, '@', 2), ''), 'unknown')"
	default:
		return "COALESCE(c.name, e.campaign_id::text)"
	}
}

func customReportMetricSQL(metric string) string {
	switch metric {
	case "delivered":
		return "count(*) FILTER (WHERE e.event_type = 'delivered')::float8"
	case "opened":
		return "count(DISTINCT e.subscriber_email) FILTER (WHERE e.event_type = 'opened')::float8"
	case "clicked":
		return "count(DISTINCT e.subscriber_email) FILTER (WHERE e.event_type = 'clicked')::float8"
	case "bounced":
		return "count(*) FILTER (WHERE e.event_type = 'bounced')::float8"
	case "complained":
		return "count(*) FILTER (WHERE e.event_type = 'complained')::float8"
	case "unsubscribed":
		return "count(*) FILTER (WHERE e.event_type = 'unsubscribed')::float8"
	case "conversions":
		return "count(*) FILTER (WHERE e.event_type = 'conversion')::float8"
	case "revenue_cents":
		return "COALESCE(sum(e.revenue_cents), 0)::float8"
	case "unique_recipients":
		return "count(DISTINCT e.subscriber_email)::float8"
	default:
		return "count(*) FILTER (WHERE e.event_type IN ('sent','delivered'))::float8"
	}
}

func customReportGraph(ctx context.Context, tx pgx.Tx, tenantID string, start, end time.Time, filters map[string]string, metrics []string) ([]CustomReportPoint, error) {
	args := []any{tenantID, start, end}
	where := ` WHERE e.tenant_id = $1::uuid AND e.at >= $2 AND e.at < $3`
	if cid := strings.TrimSpace(filters["campaign_id"]); cid != "" {
		args = append(args, cid)
		where += fmt.Sprintf(` AND e.campaign_id::text = $%d`, len(args))
	}
	if typ := strings.TrimSpace(filters["event_type"]); typ != "" {
		args = append(args, typ)
		where += fmt.Sprintf(` AND e.event_type = $%d`, len(args))
	}
	for _, filter := range []string{"device", "country", "client", "source", "channel"} {
		if v := strings.TrimSpace(filters[filter]); v != "" {
			args = append(args, v)
			where += fmt.Sprintf(` AND %s = $%d`, customReportFilterSQL(filter), len(args))
		}
	}
	selects := []string{"to_char(date_trunc('day', e.at), 'YYYY-MM-DD') AS day"}
	for i, metric := range metrics {
		selects = append(selects, customReportMetricSQL(metric)+fmt.Sprintf(" AS m%d", i))
	}
	rows, err := tx.Query(ctx, `SELECT `+strings.Join(selects, ", ")+`
  FROM campaign_report_events e`+where+`
 GROUP BY 1
 ORDER BY 1`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CustomReportPoint{}
	for rows.Next() {
		var day string
		values := make([]float64, len(metrics))
		dest := []any{&day}
		for i := range values {
			dest = append(dest, &values[i])
		}
		if err := rows.Scan(dest...); err != nil {
			return nil, err
		}
		point := CustomReportPoint{Date: day, Metrics: map[string]float64{}}
		for i, metric := range metrics {
			point.Metrics[metric] = values[i]
		}
		out = append(out, point)
	}
	return out, rows.Err()
}

func nonNilStringMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

func deliveryInsightsInTx(ctx context.Context, tx pgx.Tx, tenantID, campaignID string) (*DeliveryInsightsResponse, error) {
	var status string
	var scheduledAt, sentAt, lastEventAt *time.Time
	var updatedAt time.Time
	if err := tx.QueryRow(ctx, `
SELECT status, scheduled_at, sent_at, updated_at,
       (SELECT max(at) FROM campaign_report_events e WHERE e.tenant_id = c.tenant_id AND e.campaign_id = c.id)
  FROM campaigns c
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, campaignID).Scan(&status, &scheduledAt, &sentAt, &updatedAt, &lastEventAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	progress := map[string]int{}
	var total, pending, sending, sent, failed, cancelled, skipped int
	_ = tx.QueryRow(ctx, `
SELECT count(*)::int,
       count(*) FILTER (WHERE status = 'pending')::int,
       count(*) FILTER (WHERE status = 'sending')::int,
       count(*) FILTER (WHERE status = 'sent')::int,
       count(*) FILTER (WHERE status = 'failed')::int,
       count(*) FILTER (WHERE status = 'cancelled')::int,
       count(*) FILTER (WHERE status = 'skipped')::int
  FROM campaign_recipients
 WHERE tenant_id = $1::uuid AND campaign_id::text = $2`, tenantID, campaignID).
		Scan(&total, &pending, &sending, &sent, &failed, &cancelled, &skipped)
	progress["total"] = total
	progress["pending"] = pending
	progress["sending"] = sending
	progress["sent"] = sent
	progress["failed"] = failed
	progress["cancelled"] = cancelled
	progress["skipped"] = skipped
	var deliveredEvents int
	_ = tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE event_type = 'delivered')::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND campaign_id::text = $2`, tenantID, campaignID).Scan(&deliveredEvents)
	progress["delivered"] = deliveredEvents
	if progress["total"] == 0 {
		progress["total"] = deliveredEvents
	}
	state := "pending"
	switch status {
	case "cancelled":
		state = "cancelled"
	case "sent":
		state = "complete"
	case "sending":
		state = "in_progress"
	case "paused":
		state = "paused"
	case "failed":
		state = "failed"
	}
	canCancel := status == "draft" || status == "scheduled" || status == "sending" || status == "paused"
	warnings := []string{}
	if status == "sending" && progress["failed"] > 0 {
		warnings = append(warnings, "Some recipients have failed during delivery.")
	}
	if status == "cancelled" && sending > 0 {
		warnings = append(warnings, "Cancellation was requested while provider handoff may have been in progress; verify ESP/provider delivery logs for rows already handed off.")
	}
	if status == "scheduled" && scheduledAt == nil {
		warnings = append(warnings, "Campaign status is scheduled but scheduled_at is empty.")
	}
	cancelGuarantee := "not_cancelled"
	if canCancel {
		cancelGuarantee = "local_queue_cancellable"
	}
	if status == "cancelled" {
		cancelGuarantee = "local_queue_stopped"
	}
	providerCancel := map[string]any{
		"available": false,
		"status":    "not_configured",
		"detail":    "The Mailchimp-compatible API cancels Moosewave queue rows. Provider-level cancellation is only guaranteed for messages not yet handed to the ESP.",
	}
	return &DeliveryInsightsResponse{
		CampaignID: campaignID, Status: mailchimpCampaignStatus(status), CanCancel: canCancel,
		Cancelled: status == "cancelled", Progress: progress, DeliveryStatus: state,
		EstimatedFinish: sentAt, LastEventAt: lastEventAt, Warnings: warnings,
		CancellationGuarantee: cancelGuarantee, ProviderCancellation: providerCancel,
		UpdatedAt: updatedAt,
	}, nil
}
