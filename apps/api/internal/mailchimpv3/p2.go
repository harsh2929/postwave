package mailchimpv3

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/socialads"
)

func (r *Repo) MultiChannelReadiness(ctx context.Context, tenant *middleware.Tenant) (*MultiChannelReadinessResponse, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	counts := map[string]int{
		"social_posts": 0, "ads": 0, "surveys": 0, "landing_pages": 0, "interest_categories": 0,
	}
	var landingPages, interestCategories, surveys int
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM landing_pages WHERE tenant_id = $1::uuid`, tenant.ID).Scan(&landingPages)
	_ = tx.QueryRow(ctx, `SELECT count(DISTINCT category) FROM subscriber_groups WHERE tenant_id = $1::uuid`, tenant.ID).Scan(&interestCategories)
	_ = tx.QueryRow(ctx, `
SELECT count(*) FROM popup_forms
 WHERE tenant_id = $1::uuid
   AND COALESCE(trigger->>'kind', trigger->>'type') = 'survey'`, tenant.ID).Scan(&surveys)
	counts["landing_pages"] = landingPages
	counts["interest_categories"] = interestCategories
	counts["surveys"] = surveys
	social, ads, err := multichannelPlanCounts(ctx, tx, tenant.ID)
	if err != nil {
		return nil, err
	}
	counts["social_posts"] = social
	counts["ads"] = ads
	providers, credentialWarnings := r.providerReadinessForTenant(ctx, tx, tenant.ID)
	out := &MultiChannelReadinessResponse{
		Summary:         counts,
		Providers:       providers,
		ProviderSetup:   providerSetupSteps(providers),
		OperationalMode: multiChannelOperationalMode(providers),
		Channels: []ChannelCapability{
			{Feature: "social_post_publishing", Status: providerCapabilityStatus(counts["social_posts"], providers, "meta_pages", "meta_instagram"), Detail: "Moosewave stores social posts against campaigns and can publish Facebook Page and Instagram media posts once Meta credentials are configured.", Actions: []string{"connect_meta_provider", "map_social_accounts"}},
			{Feature: "social_post_reports", Status: providerCapabilityStatus(counts["social_posts"], providers, "meta_pages", "meta_instagram"), Detail: "Reports are wired for provider interactions and campaign-attributed conversions; native social metrics populate after provider webhooks are connected."},
			{Feature: "google_remarketing_ads", Status: providerCapabilityStatus(counts["ads"], providers, "google_ads"), Detail: "Google remarketing ad plans, budgets, creative, and ROI attribution are modeled; Google Ads credentials can be validated before buying is enabled.", Actions: []string{"connect_google_ads", "publish_audience"}},
			{Feature: "facebook_instagram_ads", Status: providerCapabilityStatus(counts["ads"], providers, "meta_ads"), Detail: "Facebook/Instagram ad plans are modeled with budget and creative; live buying/report sync requires Meta Ads credentials.", Actions: []string{"connect_meta_ads"}},
			{Feature: "direct_mail_postcards", Status: "manual", Detail: "Direct mail remains a low-priority manual channel until a customer requests a print provider integration."},
			{Feature: "hosted_surveys", Status: "available", Detail: "Surveys are backed by popup_forms plus growth_surface_events and expose hosted response/report endpoints."},
			{Feature: "poll_merge_tags", Status: "available", Detail: "Email poll links can be generated for survey questions and recorded into survey reports."},
			{Feature: "website_builder", Status: "landing_page_fallback", Detail: "Moosewave intentionally uses campaign-tied landing pages rather than a full website builder."},
			{Feature: "landing_page_builder_parity", Status: "available", Detail: "Landing pages support templates, content blocks, tracking, custom domains, reports, and campaign linkage."},
			{Feature: "audience_intelligence", Status: "available", Detail: "Contact ratings, profiles, group memberships, ecommerce summaries, and advanced segment dimensions are exposed."},
		},
		Warnings: []string{
			"Live social publishing is fail-closed until Meta credentials are present; ad buying remains gated behind provider credentials and the ads mutation worker.",
			"Predictive demographics are evidence-based and only report inferred location/device traits from captured events; no sensitive age/gender guesses are fabricated.",
		},
		GeneratedAt: time.Now().UTC(),
	}
	out.Warnings = append(out.Warnings, credentialWarnings...)
	return out, tx.Commit(ctx)
}

func (r *Repo) ListSocialProviderConnections(ctx context.Context, tenant *middleware.Tenant) (*SocialProviderConnectionsResponse, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	conns, err := loadSocialProviderConnections(ctx, tx, tenant.ID)
	if isUndefinedTable(err) {
		return &SocialProviderConnectionsResponse{Connections: []SocialProviderConnection{}, TotalItems: 0, GeneratedAt: time.Now().UTC()}, tx.Commit(ctx)
	}
	if err != nil {
		return nil, err
	}
	return &SocialProviderConnectionsResponse{Connections: conns, TotalItems: len(conns), GeneratedAt: time.Now().UTC()}, tx.Commit(ctx)
}

func (r *Repo) UpsertSocialProviderConnection(ctx context.Context, tenant *middleware.Tenant, in SocialProviderConnectionInput) (*SocialProviderConnection, error) {
	provider := normalizeProviderConnection(in.Provider)
	if provider == "" {
		return nil, fmt.Errorf("unsupported provider")
	}
	if len(in.Credentials) > 0 && r.SecretCipher == nil {
		return nil, fmt.Errorf("provider credential storage requires envelope encryption")
	}
	metadata := nonNilMap(in.Metadata)
	metadata["credential_fingerprint"] = credentialFingerprint(in.Credentials)
	metadata["credential_fields"] = credentialFieldNames(in.Credentials)
	metadata["credential_storage"] = "envelope_encrypted"
	status := normalizeProviderConnectionStatus(in.Status)
	if len(in.Credentials) == 0 && status == "connected" {
		status = "needs_credentials"
	}
	var envelope []byte
	if len(in.Credentials) > 0 {
		raw, _ := json.Marshal(in.Credentials)
		enc, err := r.SecretCipher.Encrypt(ctx, raw)
		if err != nil {
			return nil, fmt.Errorf("encrypt provider credentials: %w", err)
		}
		envelope = enc
	}
	metaRaw, _ := json.Marshal(metadata)
	scopesRaw, _ := json.Marshal(nonNilStringSlice(in.Scopes))
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO social_provider_connections (
    tenant_id, provider, account_id, status, scopes, credential_envelope,
    metadata, token_expires_at, last_validated_at
)
VALUES ($1::uuid, $2, NULLIF($3, ''), $4, $5::jsonb, $6::bytea,
        $7::jsonb, $8, CASE WHEN $4 IN ('connected', 'validated') THEN now() ELSE NULL END)
ON CONFLICT (tenant_id, provider, account_id) DO UPDATE SET
    status = EXCLUDED.status,
    scopes = EXCLUDED.scopes,
    credential_envelope = COALESCE(EXCLUDED.credential_envelope, social_provider_connections.credential_envelope),
    metadata = social_provider_connections.metadata || EXCLUDED.metadata,
    token_expires_at = EXCLUDED.token_expires_at,
    last_validated_at = CASE WHEN EXCLUDED.status IN ('connected', 'validated') THEN now() ELSE social_provider_connections.last_validated_at END,
    updated_at = now()
RETURNING id::text, provider, COALESCE(account_id, ''), status, scopes, metadata,
          token_expires_at, last_validated_at, created_at, updated_at`,
		tenant.ID, provider, strings.TrimSpace(in.AccountID), status, string(scopesRaw), envelope, string(metaRaw), in.TokenExpiresAt)
	conn, err := scanSocialProviderConnection(row)
	if err != nil {
		return nil, err
	}
	return conn, tx.Commit(ctx)
}

func (r *Repo) ListSocialPosts(ctx context.Context, tenant *middleware.Tenant, offset, count int) (*SocialPostsResponse, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	posts, total, err := loadSocialPosts(ctx, tx, tenant.ID)
	if err != nil {
		return nil, err
	}
	posts = pageSocialPosts(posts, offset, count)
	return &SocialPostsResponse{Posts: posts, TotalItems: total}, tx.Commit(ctx)
}

func (r *Repo) CreateSocialPost(ctx context.Context, tenant *middleware.Tenant, in SocialPostInput) (*SocialPost, error) {
	in.Network = normalizeSocialNetwork(in.Network)
	if strings.TrimSpace(in.Text) == "" {
		return nil, fmt.Errorf("social post text is required")
	}
	now := time.Now().UTC()
	post := socialPostFromInput(in, "", now)
	r.applySocialProviderState(ctx, tenant.ID, post, in, now)
	if strings.TrimSpace(in.CampaignID) == "" {
		return post, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var campaignName string
	var settingsRaw []byte
	if err := tx.QueryRow(ctx, `
SELECT name, delivery_settings FROM campaigns WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenant.ID, in.CampaignID).Scan(&campaignName, &settingsRaw); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	post.CampaignName = campaignName
	settings := map[string]any{}
	_ = json.Unmarshal(settingsRaw, &settings)
	posts, _ := settings["social_posts"].([]any)
	posts = append(posts, socialPostPayload(*post))
	settings["social_posts"] = posts
	next, _ := json.Marshal(settings)
	if _, err := tx.Exec(ctx, `
UPDATE campaigns
   SET delivery_settings = $3::jsonb, updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenant.ID, in.CampaignID, string(next)); err != nil {
		return nil, err
	}
	return post, tx.Commit(ctx)
}

func (r *Repo) SocialPostReport(ctx context.Context, tenant *middleware.Tenant, postID string) (*SocialPostReport, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var conversions, revenueCents int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE event_type = 'conversion')::int,
       COALESCE(sum(revenue_cents), 0)::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND metadata->>'social_post_id' = $2`, tenant.ID, postID).
		Scan(&conversions, &revenueCents); err != nil {
		return nil, err
	}
	out := &SocialPostReport{
		PostID:         postID,
		ProviderStatus: "requires_provider",
		Interactions:   map[string]int{"likes": 0, "comments": 0, "shares": 0, "clicks": 0, "conversions": conversions},
		ROI:            map[string]any{"revenue_cents": revenueCents, "source": "campaign_attribution"},
		GeneratedAt:    time.Now().UTC(),
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) ListAdCampaigns(ctx context.Context, tenant *middleware.Tenant, offset, count int) (*AdCampaignsResponse, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ads, total, err := loadAdCampaigns(ctx, tx, tenant.ID)
	if err != nil {
		return nil, err
	}
	ads = pageAdCampaigns(ads, offset, count)
	return &AdCampaignsResponse{Ads: ads, TotalItems: total}, tx.Commit(ctx)
}

func (r *Repo) CreateAdCampaign(ctx context.Context, tenant *middleware.Tenant, in AdCampaignInput) (*AdCampaign, error) {
	in.Channel = normalizeAdChannel(in.Channel)
	if strings.TrimSpace(in.Name) == "" {
		return nil, fmt.Errorf("ad campaign name is required")
	}
	now := time.Now().UTC()
	ad := adCampaignFromInput(in, "", now)
	r.applyAdProviderState(ctx, tenant.ID, ad, in)
	if strings.TrimSpace(in.CampaignID) == "" {
		return ad, nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var campaignName string
	var settingsRaw []byte
	if err := tx.QueryRow(ctx, `
SELECT name, delivery_settings FROM campaigns WHERE tenant_id = $1::uuid AND id::text = $2`,
		tenant.ID, in.CampaignID).Scan(&campaignName, &settingsRaw); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	ad.CampaignName = campaignName
	settings := map[string]any{}
	_ = json.Unmarshal(settingsRaw, &settings)
	ads, _ := settings["ads"].([]any)
	ads = append(ads, adCampaignPayload(*ad))
	settings["ads"] = ads
	next, _ := json.Marshal(settings)
	if _, err := tx.Exec(ctx, `
UPDATE campaigns
   SET delivery_settings = $3::jsonb, updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenant.ID, in.CampaignID, string(next)); err != nil {
		return nil, err
	}
	return ad, tx.Commit(ctx)
}

func (r *Repo) AdCampaignReport(ctx context.Context, tenant *middleware.Tenant, adID string) (*AdCampaignReport, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var conversions, revenueCents int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE event_type = 'conversion')::int,
       COALESCE(sum(revenue_cents), 0)::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
   AND metadata->>'ad_id' = $2`, tenant.ID, adID).
		Scan(&conversions, &revenueCents); err != nil {
		return nil, err
	}
	out := &AdCampaignReport{
		AdID:           adID,
		ProviderStatus: "requires_provider",
		Metrics:        map[string]int{"impressions": 0, "clicks": 0, "conversions": conversions, "spend_cents": 0},
		ROI:            map[string]any{"revenue_cents": revenueCents, "roas": 0},
		GeneratedAt:    time.Now().UTC(),
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) DirectMailStatus(ctx context.Context, tenant *middleware.Tenant) (*DirectMailStatusResponse, error) {
	suppressed := 0
	if r.Pool != nil {
		if tx, err := db.WithTenant(ctx, r.Pool, tenant.ID); err == nil {
			_ = tx.QueryRow(ctx, `SELECT count(*) FROM suppressions WHERE tenant_id = $1::uuid`, tenant.ID).Scan(&suppressed)
			_ = tx.Rollback(ctx)
		}
	}
	return &DirectMailStatusResponse{
		Status: "manual",
		Detail: "Direct mail/postcards are intentionally not automated yet. The compatibility surface preserves opt-out and campaign planning language until a print provider is selected.",
		OptOutModel: ChannelCapability{
			Feature: "postcard_opt_out",
			Status:  "documented",
			Detail:  "A direct-mail suppression list should be imported before any provider integration is enabled.",
		},
		SuppressionStatus: map[string]any{"imported_suppressions": suppressed, "source": "suppressions", "provider_enforced": false},
		ManualWorkflow: []ProviderSetupStep{
			{Provider: "direct_mail", Label: "Select print provider", Status: "manual", Action: "choose_provider", Description: "Pick Lob, PostGrid, or another print/mail provider before automating postcards."},
			{Provider: "direct_mail", Label: "Import opt-outs", Status: "available", Action: "import_suppressions", Description: "Keep postal/direct-mail suppressions in the global suppression ledger before export."},
			{Provider: "direct_mail", Label: "Export audience", Status: "manual", Action: "export_segment", Description: "Use segment export until provider API buying is enabled."},
		},
		ProviderSlots: []string{"lob", "postgrid", "postalytics"},
		NextActions:   []string{"select_print_provider", "import_direct_mail_suppressions", "define_postcard_pricing"},
		GeneratedAt:   time.Now().UTC(),
	}, nil
}

func (r *Repo) ListSurveys(ctx context.Context, tenant *middleware.Tenant, offset, count int) (*SurveysResponse, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var total int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM popup_forms
 WHERE tenant_id = $1::uuid
   AND COALESCE(trigger->>'kind', trigger->>'type') = 'survey'`, tenant.ID).Scan(&total); err != nil {
		return nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT id::text, name, status, trigger, blocks, metrics, created_at, updated_at
  FROM popup_forms
 WHERE tenant_id = $1::uuid
   AND COALESCE(trigger->>'kind', trigger->>'type') = 'survey'
 ORDER BY updated_at DESC
 LIMIT $2 OFFSET $3`, tenant.ID, normalizeCount(count), maxInt(offset, 0))
	if err != nil {
		return nil, err
	}
	surveys, err := scanSurveys(rows)
	if err != nil {
		return nil, err
	}
	return &SurveysResponse{Surveys: surveys, TotalItems: total}, tx.Commit(ctx)
}

func (r *Repo) CreateSurvey(ctx context.Context, tenant *middleware.Tenant, in SurveyInput) (*Survey, error) {
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = "Untitled survey"
	}
	status := normalizeSurveyStatus(in.Status)
	questions := normalizeSurveyQuestions(in.Questions, in.Blocks)
	blocks := in.Blocks
	if len(blocks) == 0 {
		blocks = surveyQuestionsToBlocks(questions)
	}
	trigger := map[string]any{
		"kind":          "survey",
		"type":          "survey",
		"notifications": nonNilMap(in.Notifications),
		"design":        nonNilMap(in.Design),
		"tag_rules":     nonNilSlice(in.TagRules),
	}
	triggerRaw, _ := json.Marshal(trigger)
	blocksRaw, _ := json.Marshal(blocks)
	metricsRaw, _ := json.Marshal(map[string]any{"responses": 0})
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
INSERT INTO popup_forms (tenant_id, name, status, trigger, targeting, blocks, metrics)
VALUES ($1::uuid, $2, $3, $4::jsonb, '{}'::jsonb, $5::jsonb, $6::jsonb)
RETURNING id::text, name, status, trigger, blocks, metrics, created_at, updated_at`,
		tenant.ID, name, status, string(triggerRaw), string(blocksRaw), string(metricsRaw))
	survey, err := scanSurvey(row)
	if err != nil {
		return nil, err
	}
	survey.Questions = questions
	return survey, tx.Commit(ctx)
}

func (r *Repo) SurveyReport(ctx context.Context, tenant *middleware.Tenant, surveyID string) (*SurveyReport, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
SELECT id::text, name, status, trigger, blocks, metrics, created_at, updated_at
  FROM popup_forms
 WHERE tenant_id = $1::uuid AND id::text = $2
   AND COALESCE(trigger->>'kind', trigger->>'type') = 'survey'`, tenant.ID, surveyID)
	survey, err := scanSurvey(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	responseRows, total, err := surveyResponseRows(ctx, tx, tenant.ID, surveyID)
	if err != nil {
		return nil, err
	}
	questionReports := make([]SurveyQuestionReport, 0, len(survey.Questions))
	for _, q := range survey.Questions {
		qr := SurveyQuestionReport{QuestionID: q.ID, Label: q.Label, Type: q.Type, Choices: map[string]int{}, Responses: 0}
		for _, row := range responseRows {
			if v, ok := row.Answers[q.ID]; ok {
				qr.Responses++
				for _, choice := range answerChoices(v) {
					qr.Choices[choice]++
				}
			}
		}
		if len(qr.Choices) == 0 {
			qr.Choices = nil
		} else {
			qr.Chart = map[string]any{"type": "bar", "series": qr.Choices}
		}
		questionReports = append(questionReports, qr)
	}
	out := &SurveyReport{
		SurveyID:       surveyID,
		TotalResponses: total,
		Questions:      questionReports,
		ResponseRows:   responseRows,
		Notifications:  survey.Notifications,
		Exports: map[string]string{
			"csv":  fmt.Sprintf("/api/mailchimp/3.0/surveys/%s/report?format=csv", surveyID),
			"pdf":  fmt.Sprintf("/api/mailchimp/3.0/surveys/%s/report?format=pdf", surveyID),
			"json": fmt.Sprintf("/api/mailchimp/3.0/surveys/%s/report", surveyID),
		},
		GeneratedAt: time.Now().UTC(),
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) RecordSurveyResponse(ctx context.Context, tenant *middleware.Tenant, surveyID string, in SurveyResponseInput) (*SurveyResponseReceipt, error) {
	if len(in.Answers) == 0 {
		return nil, fmt.Errorf("survey response answers are required")
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var exists bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
  SELECT 1 FROM popup_forms
   WHERE tenant_id = $1::uuid AND id::text = $2
     AND COALESCE(trigger->>'kind', trigger->>'type') = 'survey'
)`, tenant.ID, surveyID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	meta, _ := json.Marshal(map[string]any{
		"answers": in.Answers,
		"kind":    "survey",
		"source":  defaulted(in.Source, "hosted_survey"),
	})
	var id string
	var at time.Time
	if err := tx.QueryRow(ctx, `
INSERT INTO growth_surface_events (tenant_id, surface_type, surface_id, event_type, email, metadata)
VALUES ($1::uuid, 'popup', $2::uuid, 'submit', NULLIF($3, '')::citext, $4::jsonb)
RETURNING id::text, at`, tenant.ID, surveyID, strings.TrimSpace(in.Email), string(meta)).Scan(&id, &at); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `
UPDATE popup_forms
   SET metrics = jsonb_set(metrics, '{responses}', to_jsonb(COALESCE((metrics->>'responses')::int, 0) + 1), true),
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenant.ID, surveyID); err != nil {
		return nil, err
	}
	return &SurveyResponseReceipt{ID: id, SurveyID: surveyID, Email: in.Email, RecordedAt: at}, tx.Commit(ctx)
}

func (r *Repo) PollMergeTags(_ context.Context, _ *middleware.Tenant, in PollMergeTagInput) (*PollMergeTagResponse, error) {
	surveyID := strings.TrimSpace(in.SurveyID)
	if surveyID == "" {
		surveyID = "survey_id"
	}
	questionID := strings.TrimSpace(in.QuestionID)
	if questionID == "" {
		questionID = "question_id"
	}
	choices := in.Choices
	if len(choices) == 0 {
		choices = []string{"Yes", "No"}
	}
	tags := make([]PollMergeTag, 0, len(choices))
	for _, choice := range choices {
		clean := strings.TrimSpace(choice)
		if clean == "" {
			continue
		}
		key := stableID(surveyID + ":" + questionID + ":" + clean)
		tags = append(tags, PollMergeTag{
			Choice: clean,
			Tag:    fmt.Sprintf("*|POLL:%s:%s:%s|*", surveyID, questionID, key[:10]),
			URL:    fmt.Sprintf("/api/mailchimp/3.0/surveys/%s/responses?question_id=%s&choice=%s", surveyID, questionID, key[:10]),
		})
	}
	return &PollMergeTagResponse{
		SurveyID:   surveyID,
		QuestionID: questionID,
		Tags:       tags,
		Usage:      []string{"Use one tag/link per choice in an email.", "Submitted choices are recorded in hosted survey reports and can drive tags/segments."},
	}, nil
}

func (r *Repo) LandingPageParity(ctx context.Context, tenant *middleware.Tenant) (*LandingPageParityResponse, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	counts := map[string]int{}
	var landingPages, events int
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM landing_pages WHERE tenant_id = $1::uuid`, tenant.ID).Scan(&landingPages)
	_ = tx.QueryRow(ctx, `SELECT count(*) FROM growth_surface_events WHERE tenant_id = $1::uuid AND surface_type = 'landing_page'`, tenant.ID).Scan(&events)
	counts["landing_pages"] = landingPages
	counts["events"] = events
	out := &LandingPageParityResponse{
		Status: "available",
		Counts: counts,
		Capabilities: []ChannelCapability{
			{Feature: "template_pages", Status: "available", Detail: "Templates and content blocks are persisted on landing_pages."},
			{Feature: "campaign_tracking", Status: "available", Detail: "Tracking metadata and conversion events are reportable."},
			{Feature: "custom_domains", Status: "available", Detail: "Landing pages store domain and slug for custom-domain routing."},
			{Feature: "social_ads_sharing", Status: "available_requires_provider", Detail: "Social/ad sharing metadata can be planned with campaign channels; live publishing requires providers."},
			{Feature: "template_builder", Status: "available", Detail: "Builder contract exposes reusable blocks, SEO, tracking, form capture, and publish state."},
		},
		Builder: map[string]any{
			"blocks":         []string{"hero", "text", "image", "button", "form", "product", "coupon", "social_share", "survey", "footer"},
			"controls":       []string{"template", "theme", "seo", "tracking", "domain", "campaign_links", "social_share"},
			"publish_states": []string{"draft", "published", "paused", "archived"},
		},
		ImportParity: map[string]string{
			"mailchimp_landing_pages": "materialized_as_postwave_landing_pages_when_source_html_is_available",
			"forms":                   "linked_to_postwave_forms_or_survey_blocks",
			"reports":                 "growth_surface_events",
			"social_ads_sharing":      "planned_requires_provider",
		},
		ReportLinks: map[string]string{
			"landing_pages": "/api/mailchimp/3.0/landing-pages",
			"parity":        "/api/mailchimp/3.0/landing-pages/parity",
		},
		GeneratedAt: time.Now().UTC(),
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) WebsiteBuilderStatus(_ context.Context, _ *middleware.Tenant) (*WebsiteBuilderStatusResponse, error) {
	return &WebsiteBuilderStatusResponse{
		Status:   "not_native",
		Detail:   "Moosewave is an email/SMS lifecycle platform, not a general website builder.",
		Fallback: "Use campaign-tied landing pages with custom domains for Mailchimp-hosted page replacement.",
		Capabilities: []ChannelCapability{
			{Feature: "hosted_pages", Status: "available", Detail: "Published landing pages can be hosted on Moosewave or a mapped domain."},
			{Feature: "multi_page_site", Status: "manual", Detail: "Multiple landing pages can approximate a microsite, but navigation/site-wide themes are not a native builder yet."},
		},
		GeneratedAt: time.Now().UTC(),
	}, nil
}

func (r *Repo) ListInterestCategories(ctx context.Context, tenant *middleware.Tenant, listID string) (*InterestCategoriesResponse, error) {
	if !listMatchesTenant(tenant, listID) {
		return nil, ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT category, min(type), min(display_order), count(*)::int, min(created_at), max(updated_at)
  FROM subscriber_groups
 WHERE tenant_id = $1::uuid
 GROUP BY category
 ORDER BY min(display_order), category`, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	categories := []InterestCategory{}
	for rows.Next() {
		var category, typ string
		var displayOrder, count int
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&category, &typ, &displayOrder, &count, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		categories = append(categories, InterestCategory{
			ID: stableID("interest-category:" + category), Title: category, Type: typ,
			CanonicalKey: canonicalInterestKey(category, ""),
			DisplayOrder: displayOrder, InterestCount: count, CreatedAt: createdAt, UpdatedAt: updatedAt,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &InterestCategoriesResponse{Categories: categories, ListID: tenant.Slug, TotalItems: len(categories)}, tx.Commit(ctx)
}

func (r *Repo) ListInterests(ctx context.Context, tenant *middleware.Tenant, listID, categoryID string) (*InterestsResponse, error) {
	if !listMatchesTenant(tenant, listID) {
		return nil, ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, category, name, type, display_order, COALESCE(source_id, ''), created_at, updated_at
  FROM subscriber_groups
 WHERE tenant_id = $1::uuid
 ORDER BY category, display_order, name`, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	interests := []Interest{}
	for rows.Next() {
		var in Interest
		if err := rows.Scan(&in.ID, &in.Category, &in.Name, &in.Type, &in.DisplayOrder, &in.SourceID, &in.CreatedAt, &in.UpdatedAt); err != nil {
			return nil, err
		}
		if categoryID != "" && categoryID != in.Category && categoryID != stableID("interest-category:"+in.Category) {
			continue
		}
		in.SubscriberCount = 0
		in.CanonicalKey = canonicalInterestKey(in.Category, in.Name)
		if in.SourceID != "" {
			in.ID = in.SourceID
		}
		interests = append(interests, in)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return &InterestsResponse{Interests: interests, CategoryID: categoryID, ListID: tenant.Slug, TotalItems: len(interests)}, tx.Commit(ctx)
}

func (r *Repo) ContactRating(ctx context.Context, tenant *middleware.Tenant, listID, subscriberHash string) (*ContactRatingResponse, error) {
	if !listMatchesTenant(tenant, listID) {
		return nil, ErrNotFound
	}
	member, err := r.GetMember(ctx, tenant, listID, subscriberHash)
	if err != nil {
		return nil, err
	}
	return r.contactRatingForEmail(ctx, tenant, member.EmailAddress)
}

func (r *Repo) ContactProfile(ctx context.Context, tenant *middleware.Tenant, listID, subscriberHash string) (*ContactProfile, error) {
	if !listMatchesTenant(tenant, listID) {
		return nil, ErrNotFound
	}
	member, err := r.GetMember(ctx, tenant, listID, subscriberHash)
	if err != nil {
		return nil, err
	}
	rating, err := r.contactRatingForEmail(ctx, tenant, member.EmailAddress)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	timeline, err := contactTimeline(ctx, tx, tenant.ID, member.EmailAddress)
	if err != nil {
		return nil, err
	}
	ecommerce, clv, err := contactCommerce(ctx, tx, tenant.ID, member.EmailAddress)
	if err != nil {
		return nil, err
	}
	demo, err := contactDemographics(ctx, tx, tenant.ID, member.EmailAddress)
	if err != nil {
		return nil, err
	}
	gdpr, appData, err := subscriberProfileExtras(ctx, tx, tenant.ID, member.EmailAddress)
	if err != nil {
		return nil, err
	}
	appData["email_domain"] = emailDomain(member.EmailAddress)
	appData["source"] = member.Source
	appData["tags_count"] = member.TagsCount
	appData["mailchimp_compatibility"] = "profile_parity"
	groups := exactInterestMemberships(appData["groups"], member.Interests)
	if len(groups) == 0 {
		groups = interestsToMemberships(member.Interests)
	}
	out := &ContactProfile{
		Member: *member, Rating: *rating, Groups: groups,
		Timeline: timeline, Ecommerce: ecommerce, PredictiveCLV: clv, PredictedDemographics: demo,
		GDPRPreferences: gdpr,
		AppData:         appData,
		ConsentSummary:  contactConsentSummary(member, gdpr),
		Notes:           profileNotes(appData),
		UnifiedSections: profileSections(*member, timeline, ecommerce, gdpr, appData),
		DataSources:     []string{"subscribers", "contact_activity", "campaign_report_events", "commerce_orders", "subscriber_groups"},
		GeneratedAt:     time.Now().UTC(),
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) AudienceInsights(ctx context.Context, tenant *middleware.Tenant, listID string) (*AudienceInsightsResponse, error) {
	if !listMatchesTenant(tenant, listID) {
		return nil, ErrNotFound
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	statusCounts := map[string]int{}
	rows, err := tx.Query(ctx, `
SELECT mailchimp_status, count(*)::int FROM subscribers WHERE tenant_id = $1::uuid GROUP BY mailchimp_status`, tenant.ID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var k string
		var v int
		if err := rows.Scan(&k, &v); err != nil {
			rows.Close()
			return nil, err
		}
		statusCounts[k] = v
	}
	rows.Close()
	ratings, err := audienceRatingDistribution(ctx, tx, tenant.ID)
	if err != nil {
		return nil, err
	}
	demo := map[string]int{}
	rows, err = tx.Query(ctx, `
SELECT COALESCE(NULLIF(country, ''), 'unknown'), count(*)::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid
 GROUP BY 1
 ORDER BY count(*) DESC
 LIMIT 10`, tenant.ID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var k string
		var v int
		if err := rows.Scan(&k, &v); err != nil {
			rows.Close()
			return nil, err
		}
		demo[k] = v
	}
	rows.Close()
	clv := map[string]any{"status": "unavailable", "customers": 0, "average_ltv_cents": 0, "repeat_purchase_rate": 0.0}
	var customers, repeatCustomers, totalCents int
	_ = tx.QueryRow(ctx, `
WITH per_customer AS (
  SELECT customer_email, count(*)::int AS orders, sum(total_cents)::int AS total_cents
    FROM commerce_orders
   WHERE tenant_id = $1::uuid AND status = 'paid' AND customer_email IS NOT NULL
   GROUP BY customer_email
)
SELECT count(*)::int,
       count(*) FILTER (WHERE orders > 1)::int,
       COALESCE(sum(total_cents), 0)::int
  FROM per_customer`, tenant.ID).Scan(&customers, &repeatCustomers, &totalCents)
	if customers > 0 {
		clv["status"] = "available"
		clv["customers"] = customers
		clv["average_ltv_cents"] = totalCents / customers
		clv["repeat_purchase_rate"] = float64(repeatCustomers) / float64(customers)
		clv["model_quality"] = modelQuality(repeatCustomers, "medium")
	}
	segmentDims := []string{"contact", "merge_fields", "groups", "tags", "email_engagement", "sms", "ecommerce", "ads", "surveys", "landing_pages"}
	prebuilt, err := mailchimpPrebuiltSegments(ctx, tx, tenant.ID)
	if err != nil {
		return nil, err
	}
	out := &AudienceInsightsResponse{
		ListID: tenant.Slug, ContactRatings: ratings, StatusCounts: statusCounts,
		PredictedDemographics: demo, PredictiveCLV: clv,
		PrebuiltSegments:  prebuilt,
		SegmentDimensions: segmentDims,
		ModelNotes: []string{
			"Predictive demographics are evidence-only and never infer sensitive age/gender traits.",
			"CLV and purchase-likelihood scores are transparent commerce heuristics until enough tenant history exists for a stronger model.",
			"Contact ratings use a Mailchimp-compatible 1-5 presentation, derived from Moosewave event weights.",
		},
		SegmentCoverage: map[string]any{
			"dimensions":       len(segmentDims),
			"preview_endpoint": "/api/v1/segments/preview",
			"supported_logic":  []string{"and", "or", "not", "nested groups"},
			"event_sources":    []string{"subscribers", "subscriber_events", "campaign_report_events", "commerce_orders", "growth_surface_events"},
		},
		GeneratedAt: time.Now().UTC(),
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) AdvancedSegmentSchema(ctx context.Context, tenant *middleware.Tenant, listID string) (*AdvancedSegmentSchemaResponse, error) {
	if !listMatchesTenant(tenant, listID) {
		return nil, ErrNotFound
	}
	out := &AdvancedSegmentSchemaResponse{
		ListID: tenant.Slug,
		Dimensions: []SegmentDimension{
			{Key: "contact.email", Label: "Email address", Type: "string", Operators: []string{"is", "is_not", "contains", "starts_with", "ends_with"}, Description: "Audience contact identity fields."},
			{Key: "contact.status", Label: "Subscription status", Type: "enum", Operators: []string{"is", "is_not", "in"}, Description: "Mailchimp-compatible contact status."},
			{Key: "merge_fields.*", Label: "Merge field", Type: "dynamic", Operators: []string{"is", "is_not", "contains", "exists", "gt", "lt"}, Description: "Imported audience fields and custom fields."},
			{Key: "groups.*", Label: "Groups/interests", Type: "boolean", Operators: []string{"is_true", "is_false", "in"}, Description: "Exact group category and interest membership."},
			{Key: "tags", Label: "Tags", Type: "set", Operators: []string{"contains", "does_not_contain", "any_of", "all_of"}, Description: "Moosewave tags and imported Mailchimp tags."},
			{Key: "email.opened", Label: "Email opened", Type: "event", Operators: []string{"within", "not_within", "count_gt", "count_lt"}, Description: "Campaign and journey opens."},
			{Key: "email.clicked", Label: "Email clicked", Type: "event", Operators: []string{"within", "not_within", "url_contains", "count_gt"}, Description: "Campaign clicks and URL filters."},
			{Key: "sms.consent", Label: "SMS consent", Type: "boolean", Operators: []string{"is_true", "is_false"}, Description: "SMS channel consent state."},
			{Key: "sms.clicked", Label: "SMS clicked", Type: "event", Operators: []string{"within", "not_within", "count_gt"}, Description: "SMS link events where SMS module is enabled."},
			{Key: "ecommerce.total_spent", Label: "Total spent", Type: "money", Operators: []string{"gt", "gte", "lt", "lte", "between"}, Description: "Commerce order history and CLV."},
			{Key: "ecommerce.purchased_product", Label: "Purchased product", Type: "event", Operators: []string{"is", "is_not", "within"}, Description: "Product and order activity."},
			{Key: "ads.clicked", Label: "Ad clicked", Type: "event", Operators: []string{"within", "not_within", "count_gt"}, Description: "Google/Meta ad interactions once providers are connected."},
			{Key: "survey.answered", Label: "Survey answered", Type: "event", Operators: []string{"is", "is_not", "contains", "within"}, Description: "Hosted survey and email poll answers."},
		},
		Operators:        []string{"and", "or", "not", "nested_and", "nested_or"},
		PrebuiltSegments: defaultMailchimpPrebuiltSegmentDefinitions(),
		Examples: []map[string]any{
			{"name": "Engaged SMS consented buyers", "conditions": []string{"email.clicked within 30d", "sms.consent is_true", "ecommerce.total_spent gt 10000"}},
			{"name": "Interest group non-buyers", "conditions": []string{"groups.Product updates is_true", "ecommerce.total_spent = 0"}},
		},
		Evaluator: map[string]any{
			"status":           "available",
			"preview_endpoint": "/api/v1/segments/preview",
			"compiler":         "postwave_segment_ast",
			"mailchimp_import": "segment_opts_are_translated_to_ast_when_supported",
		},
		Coverage: map[string]string{
			"contact_fields":   "supported",
			"merge_fields":     "supported",
			"groups_interests": "exact_model_supported",
			"email_engagement": "supported",
			"sms":              "supported_when_sms_module_enabled",
			"ecommerce":        "supported_when_commerce_events_synced",
			"ads":              "planned_provider_dependent",
			"surveys":          "supported",
		},
		Unsupported: []string{"Mailchimp proprietary predictive demographic operators", "provider-only ad audiences before credential sync"},
		Limits:      map[string]any{"max_conditions": 50, "max_nested_depth": 5, "supports_advanced_logic": true},
		GeneratedAt: time.Now().UTC(),
	}
	return out, nil
}

func mailchimpPrebuiltSegments(ctx context.Context, tx pgx.Tx, tenantID string) ([]map[string]any, error) {
	defs := defaultMailchimpPrebuiltSegmentDefinitions()
	for _, def := range defs {
		var count int
		var err error
		switch def["id"] {
		case "recent_clickers":
			err = tx.QueryRow(ctx, `
SELECT count(DISTINCT lower(subscriber_email::text))::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND event_type = 'clicked' AND at >= now() - interval '30 days'`, tenantID).Scan(&count)
		case "cold_subscribers":
			err = tx.QueryRow(ctx, `
SELECT count(*)::int
  FROM subscribers s
 WHERE s.tenant_id = $1::uuid
   AND COALESCE(s.mailchimp_status, 'subscribed') = 'subscribed'
   AND NOT EXISTS (
     SELECT 1 FROM campaign_report_events e
      WHERE e.tenant_id = s.tenant_id
        AND lower(e.subscriber_email::text) = lower(s.email::text)
        AND e.event_type IN ('opened', 'clicked')
        AND e.at >= now() - interval '90 days'
   )`, tenantID).Scan(&count)
		case "high_value_customers":
			err = tx.QueryRow(ctx, `
WITH spend AS (
  SELECT lower(customer_email::text) AS email, sum(total_cents)::int AS total_cents
    FROM commerce_orders
   WHERE tenant_id = $1::uuid AND status = 'paid' AND customer_email IS NOT NULL
   GROUP BY 1
)
SELECT count(*)::int FROM spend WHERE total_cents >= 10000`, tenantID).Scan(&count)
		case "likely_churn":
			err = tx.QueryRow(ctx, `
WITH customers AS (
  SELECT lower(customer_email::text) AS email, max(created_at) AS last_order
    FROM commerce_orders
   WHERE tenant_id = $1::uuid AND status = 'paid' AND customer_email IS NOT NULL
   GROUP BY 1
),
recent_engagement AS (
  SELECT DISTINCT lower(subscriber_email::text) AS email
    FROM campaign_report_events
   WHERE tenant_id = $1::uuid
     AND event_type IN ('opened', 'clicked', 'conversion')
     AND at >= now() - interval '60 days'
)
SELECT count(*)::int
  FROM customers c
 WHERE c.last_order < now() - interval '60 days'
   AND NOT EXISTS (SELECT 1 FROM recent_engagement e WHERE e.email = c.email)`, tenantID).Scan(&count)
		default:
			count = 0
		}
		if err != nil {
			return nil, err
		}
		def["estimated_count"] = count
		def["count_method"] = "local_postwave_events"
	}
	return defs, nil
}

func defaultMailchimpPrebuiltSegmentDefinitions() []map[string]any {
	return []map[string]any{
		{
			"id":          "recent_clickers",
			"name":        "Recent clickers",
			"description": "Contacts who clicked an email in the last 30 days.",
			"query_ast": map[string]any{
				"op":         "condition",
				"field":      "email.clicked",
				"comparator": "within",
				"value":      "30d",
			},
		},
		{
			"id":          "cold_subscribers",
			"name":        "Cold subscribers",
			"description": "Subscribed contacts with no opens or clicks in the last 90 days.",
			"query_ast": map[string]any{
				"op": "and",
				"children": []map[string]any{
					{"op": "condition", "field": "contact.status", "comparator": "equals", "value": "subscribed"},
					{"op": "condition", "field": "email.engaged", "comparator": "not_within", "value": "90d"},
				},
			},
		},
		{
			"id":          "high_value_customers",
			"name":        "High-value customers",
			"description": "Customers with at least $100 in paid order history.",
			"query_ast": map[string]any{
				"op":         "condition",
				"field":      "ecommerce.total_spent",
				"comparator": "gte",
				"value":      10000,
			},
		},
		{
			"id":          "likely_churn",
			"name":        "Likely churn risk",
			"description": "Customers with paid order history but no recent commerce or email engagement.",
			"query_ast": map[string]any{
				"op": "and",
				"children": []map[string]any{
					{"op": "condition", "field": "ecommerce.last_order", "comparator": "lt", "value": "60d"},
					{"op": "condition", "field": "email.engaged", "comparator": "not_within", "value": "60d"},
				},
			},
		},
	}
}

func (r *Repo) contactRatingForEmail(ctx context.Context, tenant *middleware.Tenant, email string) (*ContactRatingResponse, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	out, err := contactRatingFromTx(ctx, tx, tenant.ID, email)
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func contactRatingFromTx(ctx context.Context, tx pgx.Tx, tenantID, email string) (*ContactRatingResponse, error) {
	var sent, opened, clicked, bounced, complained, unsubscribed, conversions int
	var revenueCents int
	var lastActivity *time.Time
	if err := tx.QueryRow(ctx, `
WITH events AS (
  SELECT event_type, at, revenue_cents
    FROM campaign_report_events
   WHERE tenant_id = $1::uuid AND lower(subscriber_email::text) = lower($2)
  UNION ALL
  SELECT event_type, at, 0
    FROM subscriber_events
   WHERE tenant_id = $1::uuid AND lower(subscriber_email::text) = lower($2)
)
SELECT count(*) FILTER (WHERE event_type IN ('sent', 'delivered'))::int,
       count(*) FILTER (WHERE event_type = 'opened')::int,
       count(*) FILTER (WHERE event_type = 'clicked')::int,
       count(*) FILTER (WHERE event_type = 'bounced')::int,
       count(*) FILTER (WHERE event_type = 'complained')::int,
       count(*) FILTER (WHERE event_type = 'unsubscribed')::int,
       count(*) FILTER (WHERE event_type = 'conversion')::int,
       COALESCE(sum(revenue_cents), 0)::int,
       max(at)
  FROM events`, tenantID, email).
		Scan(&sent, &opened, &clicked, &bounced, &complained, &unsubscribed, &conversions, &revenueCents, &lastActivity); err != nil {
		return nil, err
	}
	openRate, clickRate := 0.0, 0.0
	if sent > 0 {
		openRate = float64(opened) / float64(sent)
		clickRate = float64(clicked) / float64(sent)
	}
	score := openRate*40 + clickRate*80 + math.Min(float64(conversions), 3)*10 - float64(bounced*20+complained*25+unsubscribed*30)
	rating := ratingFromScore(score, sent)
	return &ContactRatingResponse{
		EmailAddress: email, Rating: rating, Score: math.Round(score*100) / 100,
		MailchimpScale: "1-5",
		OpenRate:       openRate, ClickRate: clickRate,
		Evidence:      map[string]int{"sent": sent, "opened": opened, "clicked": clicked, "bounced": bounced, "complained": complained, "unsubscribed": unsubscribed, "conversions": conversions, "revenue_cents": revenueCents},
		LastActivity:  lastActivity,
		Method:        "mailchimp_compatible_event_weighted_engagement",
		MethodVersion: "v2",
		ParityNote:    "Derived from first-party campaign/contact events on a Mailchimp-style 1-5 scale; exact proprietary Mailchimp scoring weights are not cloned.",
	}, nil
}

func multichannelPlanCounts(ctx context.Context, tx pgx.Tx, tenantID string) (int, int, error) {
	rows, err := tx.Query(ctx, `
SELECT delivery_settings
  FROM campaigns
 WHERE tenant_id = $1::uuid
   AND (delivery_settings ? 'social_posts' OR delivery_settings ? 'ads')`, tenantID)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()
	social, ads := 0, 0
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return 0, 0, err
		}
		settings := map[string]any{}
		_ = json.Unmarshal(raw, &settings)
		if items, ok := settings["social_posts"].([]any); ok {
			social += len(items)
		}
		if items, ok := settings["ads"].([]any); ok {
			ads += len(items)
		}
	}
	return social, ads, rows.Err()
}

func loadSocialPosts(ctx context.Context, tx pgx.Tx, tenantID string) ([]SocialPost, int, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text, name, delivery_settings, created_at, updated_at
  FROM campaigns
 WHERE tenant_id = $1::uuid AND delivery_settings ? 'social_posts'
 ORDER BY updated_at DESC`, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	posts := []SocialPost{}
	for rows.Next() {
		var campaignID, campaignName string
		var raw []byte
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&campaignID, &campaignName, &raw, &createdAt, &updatedAt); err != nil {
			return nil, 0, err
		}
		settings := map[string]any{}
		_ = json.Unmarshal(raw, &settings)
		items, _ := settings["social_posts"].([]any)
		for _, item := range items {
			post := socialPostFromMap(asMap(item), campaignID, campaignName, createdAt, updatedAt)
			posts = append(posts, post)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	sort.Slice(posts, func(i, j int) bool { return posts[i].UpdatedAt.After(posts[j].UpdatedAt) })
	return posts, len(posts), nil
}

func loadAdCampaigns(ctx context.Context, tx pgx.Tx, tenantID string) ([]AdCampaign, int, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text, name, delivery_settings, created_at, updated_at
  FROM campaigns
 WHERE tenant_id = $1::uuid AND delivery_settings ? 'ads'
 ORDER BY updated_at DESC`, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	ads := []AdCampaign{}
	for rows.Next() {
		var campaignID, campaignName string
		var raw []byte
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&campaignID, &campaignName, &raw, &createdAt, &updatedAt); err != nil {
			return nil, 0, err
		}
		settings := map[string]any{}
		_ = json.Unmarshal(raw, &settings)
		items, _ := settings["ads"].([]any)
		for _, item := range items {
			ad := adCampaignFromMap(asMap(item), campaignID, campaignName, createdAt, updatedAt)
			ads = append(ads, ad)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	sort.Slice(ads, func(i, j int) bool { return ads[i].UpdatedAt.After(ads[j].UpdatedAt) })
	return ads, len(ads), nil
}

func scanSurveys(rows pgx.Rows) ([]Survey, error) {
	defer rows.Close()
	out := []Survey{}
	for rows.Next() {
		s, err := scanSurvey(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

type surveyScanner interface{ Scan(dest ...any) error }

func scanSurvey(row surveyScanner) (*Survey, error) {
	var s Survey
	var triggerRaw, blocksRaw, metricsRaw []byte
	if err := row.Scan(&s.ID, &s.Name, &s.Status, &triggerRaw, &blocksRaw, &metricsRaw, &s.CreatedAt, &s.UpdatedAt); err != nil {
		return nil, err
	}
	trigger := map[string]any{}
	_ = json.Unmarshal(triggerRaw, &trigger)
	_ = json.Unmarshal(blocksRaw, &s.Blocks)
	_ = json.Unmarshal(metricsRaw, &s.Metrics)
	s.Questions = blocksToSurveyQuestions(s.Blocks)
	s.Notifications = asMap(trigger["notifications"])
	s.Design = asMap(trigger["design"])
	s.TagRules = asMapSlice(trigger["tag_rules"])
	s.PublicURL = "/api/public/surveys/" + s.ID
	s.Builder = surveyBuilder()
	s.Exports = map[string]string{
		"json": fmt.Sprintf("/api/mailchimp/3.0/surveys/%s/report", s.ID),
		"csv":  fmt.Sprintf("/api/mailchimp/3.0/surveys/%s/report?format=csv", s.ID),
	}
	s.NotificationChannels = notificationChannels(s.Notifications)
	s.DesignControls = surveyDesignControls(s.Design)
	return &s, nil
}

func surveyResponseRows(ctx context.Context, tx pgx.Tx, tenantID, surveyID string) ([]SurveyResponseRow, int, error) {
	rows, err := tx.Query(ctx, `
SELECT COALESCE(email::text, ''), metadata, at
  FROM growth_surface_events
 WHERE tenant_id = $1::uuid
   AND surface_id::text = $2
   AND surface_type IN ('survey', 'popup')
   AND event_type = 'submit'
 ORDER BY at DESC`, tenantID, surveyID)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []SurveyResponseRow{}
	for rows.Next() {
		var raw []byte
		var email string
		var at time.Time
		if err := rows.Scan(&email, &raw, &at); err != nil {
			return nil, 0, err
		}
		meta := map[string]any{}
		_ = json.Unmarshal(raw, &meta)
		if a := asMap(meta["answers"]); len(a) > 0 {
			out = append(out, SurveyResponseRow{
				Email:      email,
				Answers:    a,
				Source:     defaulted(stringValue(meta, "source"), "hosted_survey"),
				RecordedAt: at,
			})
		}
	}
	return out, len(out), rows.Err()
}

func contactTimeline(ctx context.Context, tx pgx.Tx, tenantID, email string) ([]ContactTimelineItem, error) {
	rows, err := tx.Query(ctx, `
SELECT event_type, COALESCE(campaign_id::text, ''), metadata, at
  FROM (
    SELECT activity_type AS event_type, campaign_id, metadata, at
      FROM contact_activity
     WHERE tenant_id = $1::uuid AND lower(subscriber_email::text) = lower($2)
    UNION ALL
    SELECT event_type, campaign_id,
           jsonb_build_object('link_url', link_url, 'device', device, 'client', client, 'country', country, 'revenue_cents', revenue_cents) AS metadata,
           at
      FROM campaign_report_events
     WHERE tenant_id = $1::uuid AND lower(subscriber_email::text) = lower($2)
  ) events
 ORDER BY at DESC
 LIMIT 50`, tenantID, email)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ContactTimelineItem{}
	for rows.Next() {
		var item ContactTimelineItem
		var raw []byte
		if err := rows.Scan(&item.Type, &item.CampaignID, &raw, &item.At); err != nil {
			return nil, err
		}
		item.Metadata = map[string]any{}
		_ = json.Unmarshal(raw, &item.Metadata)
		items = append(items, item)
	}
	return items, rows.Err()
}

func contactCommerce(ctx context.Context, tx pgx.Tx, tenantID, email string) (ContactEcommerceSummary, PredictiveCLV, error) {
	var out ContactEcommerceSummary
	var avgCents int
	var lastOrder *time.Time
	if err := tx.QueryRow(ctx, `
SELECT count(*)::int, COALESCE(sum(total_cents), 0)::int, COALESCE(avg(total_cents), 0)::int,
       COALESCE(max(currency), 'USD'), max(ordered_at)
  FROM commerce_orders
 WHERE tenant_id = $1::uuid AND lower(customer_email::text) = lower($2) AND status = 'paid'`,
		tenantID, email).Scan(&out.OrderCount, &out.TotalSpentCents, &avgCents, &out.Currency, &lastOrder); err != nil {
		return out, PredictiveCLV{}, err
	}
	out.AverageOrderCents = avgCents
	out.LastOrderAt = lastOrder
	likelihood := 0.0
	confidence := "low"
	status := "insufficient_data"
	if out.OrderCount > 0 {
		status = "available"
		likelihood = math.Min(0.9, 0.25+float64(out.OrderCount)*0.15)
		if out.OrderCount >= 3 {
			confidence = "medium"
		}
	}
	clv := PredictiveCLV{
		Status: status, EstimatedLifetimeValueCents: out.TotalSpentCents + int(float64(out.AverageOrderCents)*likelihood),
		PurchaseAgainLikelihood: likelihood, Confidence: confidence, Method: "order_frequency_and_value_v1",
		ModelQuality: modelQuality(out.OrderCount, confidence),
		Inputs:       map[string]int{"orders": out.OrderCount, "total_spent_cents": out.TotalSpentCents, "average_order_cents": out.AverageOrderCents},
	}
	return out, clv, nil
}

func contactDemographics(ctx context.Context, tx pgx.Tx, tenantID, email string) (DemographicPrediction, error) {
	out := DemographicPrediction{
		Status: "insufficient_data", Confidence: "low",
		Policy:   "evidence_only_no_sensitive_age_gender_prediction",
		Traits:   map[string]any{"email_domain": emailDomain(email)},
		Evidence: map[string]int{},
	}
	var events int
	_ = tx.QueryRow(ctx, `
SELECT COALESCE(NULLIF(country, ''), ''), COALESCE(NULLIF(region, ''), ''), COALESCE(NULLIF(city, ''), ''), count(*)::int
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND lower(subscriber_email::text) = lower($2)
 GROUP BY country, region, city
 ORDER BY count(*) DESC
 LIMIT 1`, tenantID, email).Scan(&out.Country, &out.Region, &out.City, &events)
	_ = tx.QueryRow(ctx, `
SELECT COALESCE(NULLIF(device, ''), ''), COALESCE(NULLIF(client, ''), '')
  FROM campaign_report_events
 WHERE tenant_id = $1::uuid AND lower(subscriber_email::text) = lower($2)
 GROUP BY device, client
 ORDER BY count(*) DESC
 LIMIT 1`, tenantID, email).Scan(&out.Device, &out.Client)
	if events > 0 {
		out.Status = "available"
		out.Evidence["location_events"] = events
		if events >= 10 {
			out.Confidence = "medium"
		}
	}
	if out.Device != "" || out.Client != "" {
		out.Evidence["device_client_observed"] = 1
	}
	return out, nil
}

func subscriberProfileExtras(ctx context.Context, tx pgx.Tx, tenantID, email string) ([]map[string]any, map[string]any, error) {
	var gdprRaw, activityRaw, customRaw, groupsRaw []byte
	if err := tx.QueryRow(ctx, `
SELECT gdpr_permissions, activity_summary, custom_fields, groups
  FROM subscribers
 WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
 LIMIT 1`, tenantID, email).Scan(&gdprRaw, &activityRaw, &customRaw, &groupsRaw); err != nil {
		return nil, nil, err
	}
	gdpr := []map[string]any{}
	if len(gdprRaw) > 0 {
		if err := json.Unmarshal(gdprRaw, &gdpr); err != nil {
			var generic []any
			_ = json.Unmarshal(gdprRaw, &generic)
			for _, item := range generic {
				gdpr = append(gdpr, map[string]any{"value": item})
			}
		}
	}
	activity := map[string]any{}
	custom := map[string]any{}
	groups := []map[string]any{}
	_ = json.Unmarshal(activityRaw, &activity)
	_ = json.Unmarshal(customRaw, &custom)
	_ = json.Unmarshal(groupsRaw, &groups)
	return gdpr, map[string]any{
		"activity_summary": activity,
		"custom_fields":    custom,
		"groups":           groups,
	}, nil
}

func audienceRatingDistribution(ctx context.Context, tx pgx.Tx, tenantID string) (map[int]int, error) {
	rows, err := tx.Query(ctx, `
WITH per_contact AS (
  SELECT subscriber_email,
         count(*) FILTER (WHERE event_type IN ('sent', 'delivered'))::int AS sent,
         count(*) FILTER (WHERE event_type = 'opened')::int AS opened,
         count(*) FILTER (WHERE event_type = 'clicked')::int AS clicked,
         count(*) FILTER (WHERE event_type IN ('bounced', 'complained', 'unsubscribed'))::int AS negative
    FROM campaign_report_events
   WHERE tenant_id = $1::uuid AND subscriber_email IS NOT NULL
   GROUP BY subscriber_email
)
SELECT sent, opened, clicked, negative FROM per_contact`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int]int{1: 0, 2: 0, 3: 0, 4: 0, 5: 0}
	for rows.Next() {
		var sent, opened, clicked, negative int
		if err := rows.Scan(&sent, &opened, &clicked, &negative); err != nil {
			return nil, err
		}
		openRate, clickRate := 0.0, 0.0
		if sent > 0 {
			openRate = float64(opened) / float64(sent)
			clickRate = float64(clicked) / float64(sent)
		}
		score := openRate*40 + clickRate*80 - float64(negative*20)
		out[ratingFromScore(score, sent)]++
	}
	return out, rows.Err()
}

func memberEngagementFromSummary(raw []byte) (int, MemberStats) {
	summary := map[string]any{}
	_ = json.Unmarshal(raw, &summary)
	sent := int(floatValue(summary, "sent") + floatValue(summary, "delivered"))
	opened := int(floatValue(summary, "opened") + floatValue(summary, "opens"))
	clicked := int(floatValue(summary, "clicked") + floatValue(summary, "clicks"))
	stats := MemberStats{}
	if sent > 0 {
		stats.AvgOpenRate = float64(opened) / float64(sent)
		stats.AvgClickRate = float64(clicked) / float64(sent)
	}
	if sent == 0 && opened == 0 && clicked == 0 {
		return 2, stats
	}
	return ratingFromScore(stats.AvgOpenRate*40+stats.AvgClickRate*80, sent), stats
}

func ratingFromScore(score float64, sent int) int {
	if sent == 0 {
		return 2
	}
	switch {
	case score >= 45:
		return 5
	case score >= 25:
		return 4
	case score >= 10:
		return 3
	case score >= -10:
		return 2
	default:
		return 1
	}
}

func providerStatus(count int) string {
	if count > 0 {
		return "planned_requires_provider"
	}
	return "available_requires_provider"
}

func (r *Repo) providerReadiness() map[string]ProviderReadiness {
	out := map[string]ProviderReadiness{}
	var statuses []socialads.ProviderStatus
	if r.SocialAds == nil {
		statuses = (*socialads.Registry)(nil).Readiness()
	} else {
		statuses = r.SocialAds.Readiness()
	}
	for _, st := range statuses {
		out[st.Provider] = ProviderReadiness{
			Provider:         st.Provider,
			Status:           st.Status,
			Detail:           st.Detail,
			Missing:          append([]string(nil), st.Missing...),
			Docs:             append([]string(nil), st.Docs...),
			Version:          st.Version,
			CredentialSource: "environment",
			TenantScoped:     false,
		}
	}
	return out
}

func (r *Repo) providerReadinessForTenant(ctx context.Context, tx pgx.Tx, tenantID string) (map[string]ProviderReadiness, []string) {
	out := r.providerReadiness()
	conns, err := loadSocialProviderConnections(ctx, tx, tenantID)
	if isUndefinedTable(err) {
		return out, []string{"Tenant-scoped social provider connection storage has not been migrated yet; using environment credential readiness only."}
	}
	if err != nil {
		return out, []string{"Could not read tenant social provider connections; using environment credential readiness only."}
	}
	for _, conn := range conns {
		st := out[conn.Provider]
		if st.Provider == "" {
			st.Provider = conn.Provider
		}
		st.Status = providerStatusFromConnection(conn.Status)
		st.Detail = providerDetailFromConnection(conn)
		st.Missing = nil
		st.CredentialSource = "tenant_oauth"
		st.TenantScoped = true
		st.ConnectionID = conn.ID
		st.AccountID = conn.AccountID
		st.Scopes = append([]string(nil), conn.Scopes...)
		st.ConnectedAt = &conn.CreatedAt
		st.ValidatedAt = conn.LastValidatedAt
		st.ExpiresAt = conn.TokenExpiresAt
		out[conn.Provider] = st
	}
	return out, nil
}

func providerCapabilityStatus(count int, providers map[string]ProviderReadiness, names ...string) string {
	for _, name := range names {
		if providers[name].Status == "configured" {
			if count > 0 {
				return "planned_provider_ready"
			}
			return "provider_ready"
		}
	}
	return providerStatus(count)
}

func loadSocialProviderConnections(ctx context.Context, tx pgx.Tx, tenantID string) ([]SocialProviderConnection, error) {
	rows, err := tx.Query(ctx, `
SELECT id::text, provider, COALESCE(account_id, ''), status, scopes, metadata,
       token_expires_at, last_validated_at, created_at, updated_at
  FROM social_provider_connections
 WHERE tenant_id = $1::uuid
 ORDER BY provider, updated_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SocialProviderConnection{}
	for rows.Next() {
		conn, err := scanSocialProviderConnection(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *conn)
	}
	return out, rows.Err()
}

type socialProviderConnectionScanner interface{ Scan(dest ...any) error }

func scanSocialProviderConnection(row socialProviderConnectionScanner) (*SocialProviderConnection, error) {
	var conn SocialProviderConnection
	var scopesRaw, metadataRaw []byte
	if err := row.Scan(&conn.ID, &conn.Provider, &conn.AccountID, &conn.Status, &scopesRaw, &metadataRaw, &conn.TokenExpiresAt, &conn.LastValidatedAt, &conn.CreatedAt, &conn.UpdatedAt); err != nil {
		return nil, err
	}
	_ = json.Unmarshal(scopesRaw, &conn.Scopes)
	conn.Metadata = map[string]any{}
	_ = json.Unmarshal(metadataRaw, &conn.Metadata)
	conn.Provider = normalizeProviderConnection(conn.Provider)
	return &conn, nil
}

func (r *Repo) socialAdsForTenant(ctx context.Context, tenantID, preferredConnectionID string) *socialads.Registry {
	cfg, ok := r.tenantSocialAdsConfig(ctx, tenantID, preferredConnectionID)
	if !ok {
		return r.SocialAds
	}
	return socialads.NewRegistry(cfg, nil)
}

func (r *Repo) tenantSocialAdsConfig(ctx context.Context, tenantID, preferredConnectionID string) (socialads.Config, bool) {
	if r.Pool == nil || r.SecretCipher == nil {
		return socialads.Config{}, false
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return socialads.Config{}, false
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text, provider, COALESCE(account_id, ''), credential_envelope
  FROM social_provider_connections
 WHERE tenant_id = $1::uuid
   AND status IN ('connected', 'validated')
   AND credential_envelope IS NOT NULL`, tenantID)
	if err != nil {
		return socialads.Config{}, false
	}
	defer rows.Close()
	var cfg socialads.Config
	configured := false
	for rows.Next() {
		var id, provider, accountID string
		var envelope []byte
		if err := rows.Scan(&id, &provider, &accountID, &envelope); err != nil {
			return socialads.Config{}, false
		}
		if preferredConnectionID != "" && preferredConnectionID != id {
			continue
		}
		plain, err := r.SecretCipher.Decrypt(ctx, envelope, r.LegacyKEK)
		if err != nil {
			continue
		}
		creds := map[string]string{}
		if err := json.Unmarshal(plain, &creds); err != nil {
			continue
		}
		configured = mergeProviderCredentials(&cfg, normalizeProviderConnection(provider), accountID, creds) || configured
	}
	if err := rows.Err(); err != nil {
		return socialads.Config{}, false
	}
	return cfg, configured
}

func mergeProviderCredentials(cfg *socialads.Config, provider, accountID string, creds map[string]string) bool {
	if cfg == nil || len(creds) == 0 {
		return false
	}
	switch provider {
	case "meta_pages":
		cfg.MetaPageID = firstNonEmpty(accountID, creds["page_id"], creds["account_id"])
		cfg.MetaPageAccessToken = firstNonEmpty(creds["access_token"], creds["page_access_token"])
	case "meta_instagram":
		cfg.MetaInstagramBusinessAccountID = firstNonEmpty(accountID, creds["instagram_business_account_id"], creds["account_id"])
		cfg.MetaPageAccessToken = firstNonEmpty(creds["access_token"], creds["page_access_token"])
	case "meta_ads":
		cfg.MetaAdAccountID = firstNonEmpty(accountID, creds["ad_account_id"], creds["account_id"])
		cfg.MetaAdsAccessToken = firstNonEmpty(creds["access_token"], creds["ads_access_token"])
	case "google_ads":
		cfg.GoogleAdsDeveloperToken = creds["developer_token"]
		cfg.GoogleAdsClientID = creds["client_id"]
		cfg.GoogleAdsClientSecret = creds["client_secret"]
		cfg.GoogleAdsRefreshToken = creds["refresh_token"]
		cfg.GoogleAdsLoginCustomerID = firstNonEmpty(creds["login_customer_id"], creds["manager_customer_id"])
		cfg.GoogleAdsCustomerID = firstNonEmpty(accountID, creds["customer_id"])
	default:
		return false
	}
	return true
}

func registryReadiness(registry *socialads.Registry) map[string]ProviderReadiness {
	out := map[string]ProviderReadiness{}
	if registry == nil {
		return out
	}
	for _, st := range registry.Readiness() {
		out[st.Provider] = ProviderReadiness{
			Provider:         st.Provider,
			Status:           st.Status,
			Detail:           st.Detail,
			Missing:          append([]string(nil), st.Missing...),
			Docs:             append([]string(nil), st.Docs...),
			Version:          st.Version,
			CredentialSource: "runtime",
		}
	}
	return out
}

func normalizeProviderConnection(provider string) string {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "meta", "facebook", "facebook_pages", "meta_pages":
		return "meta_pages"
	case "instagram", "ig", "meta_instagram":
		return "meta_instagram"
	case "facebook_ads", "instagram_ads", "meta_ads":
		return "meta_ads"
	case "google", "google_ads", "google_remarketing":
		return "google_ads"
	default:
		return ""
	}
}

func normalizeProviderConnectionStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "connected", "validated", "disabled", "expired", "needs_credentials":
		return strings.ToLower(strings.TrimSpace(status))
	default:
		return "connected"
	}
}

func providerStatusFromConnection(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "connected", "validated":
		return "configured"
	case "disabled":
		return "disabled"
	case "expired":
		return "expired"
	default:
		return "missing_credentials"
	}
}

func providerDetailFromConnection(conn SocialProviderConnection) string {
	if conn.AccountID != "" {
		return fmt.Sprintf("Tenant-scoped %s connection is %s for account %s.", conn.Provider, conn.Status, conn.AccountID)
	}
	return fmt.Sprintf("Tenant-scoped %s connection is %s.", conn.Provider, conn.Status)
}

func providerSetupSteps(providers map[string]ProviderReadiness) []ProviderSetupStep {
	order := []string{"meta_pages", "meta_instagram", "meta_ads", "google_ads"}
	labels := map[string]string{
		"meta_pages":     "Connect Facebook Page",
		"meta_instagram": "Connect Instagram Business",
		"meta_ads":       "Connect Meta Ads",
		"google_ads":     "Connect Google Ads",
	}
	out := make([]ProviderSetupStep, 0, len(order))
	for _, provider := range order {
		st := providers[provider]
		status := "missing_credentials"
		if st.Status != "" {
			status = st.Status
		}
		out = append(out, ProviderSetupStep{
			Provider:    provider,
			Label:       labels[provider],
			Status:      status,
			Action:      "POST /api/mailchimp/3.0/provider-connections",
			Docs:        st.Docs,
			Required:    st.Missing,
			Description: providerSetupDescription(provider),
		})
	}
	return out
}

func providerSetupDescription(provider string) string {
	switch provider {
	case "meta_pages":
		return "Store a tenant Page ID and Page access token for self-serve Facebook publishing."
	case "meta_instagram":
		return "Store an Instagram Business account ID and Page access token for self-serve Instagram publishing."
	case "meta_ads":
		return "Store a Meta ad account ID and ads access token before enabling ad buying/report sync."
	case "google_ads":
		return "Store OAuth client, refresh token, developer token, and customer IDs before enabling Google remarketing."
	default:
		return "Connect provider credentials."
	}
}

func multiChannelOperationalMode(providers map[string]ProviderReadiness) string {
	for _, st := range providers {
		if st.TenantScoped && st.Status == "configured" {
			return "tenant_self_serve_ready"
		}
	}
	for _, st := range providers {
		if st.Status == "configured" {
			return "operator_managed_credentials"
		}
	}
	return "planning_only_provider_credentials_required"
}

func credentialFingerprint(creds map[string]string) string {
	if len(creds) == 0 {
		return ""
	}
	keys := credentialFieldNames(creds)
	h := sha256.New()
	for _, key := range keys {
		h.Write([]byte(key))
		h.Write([]byte("="))
		h.Write([]byte(creds[key]))
		h.Write([]byte("\n"))
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}

func credentialFieldNames(creds map[string]string) []string {
	keys := make([]string, 0, len(creds))
	for k, v := range creds {
		if strings.TrimSpace(k) != "" && strings.TrimSpace(v) != "" {
			keys = append(keys, strings.TrimSpace(k))
		}
	}
	sort.Strings(keys)
	return keys
}

func credentialMode(credentialID string) string {
	if strings.TrimSpace(credentialID) != "" {
		return "tenant_oauth"
	}
	return "environment_or_operator"
}

func isUndefinedTable(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42P01"
}

func (r *Repo) applySocialProviderState(ctx context.Context, tenantID string, post *SocialPost, in SocialPostInput, now time.Time) {
	if post == nil {
		return
	}
	registry := r.socialAdsForTenant(ctx, tenantID, in.CredentialID)
	if registry == nil {
		post.ProviderMessage = "Connect Meta provider credentials before publishing."
		if in.PublishNow {
			post.Status = "blocked"
		}
		return
	}
	readiness := registryReadiness(registry)
	switch post.Network {
	case "instagram":
		if readiness["meta_instagram"].Status == "configured" && !in.PublishNow {
			post.ProviderStatus = "provider_ready"
			post.ProviderMessage = "Meta Instagram credentials are configured; set publish_now to publish immediately."
		}
	default:
		if readiness["meta_pages"].Status == "configured" && !in.PublishNow {
			post.ProviderStatus = "provider_ready"
			post.ProviderMessage = "Meta Page credentials are configured; set publish_now to publish immediately."
		}
	}
	if !in.PublishNow {
		return
	}
	res, err := registry.PublishSocial(ctx, socialads.SocialPostRequest{
		Network:   in.Network,
		AccountID: in.AccountID,
		Text:      in.Text,
		LinkURL:   in.LinkURL,
		MediaURLs: nonNilStringSlice(in.MediaURLs),
	})
	if err != nil {
		if errors.Is(err, socialads.ErrNotConfigured) {
			post.Status = "blocked"
			post.ProviderStatus = "requires_provider"
		} else {
			post.Status = "provider_error"
			post.ProviderStatus = "error"
		}
		post.ProviderMessage = err.Error()
		return
	}
	post.Status = "published"
	post.ProviderStatus = res.Status
	post.ProviderMessage = defaulted(res.Message, "Published via provider.")
	post.ProviderID = res.ProviderID
	post.PublishedAt = &now
}

func (r *Repo) applyAdProviderState(ctx context.Context, tenantID string, ad *AdCampaign, in AdCampaignInput) {
	if ad == nil {
		return
	}
	registry := r.socialAdsForTenant(ctx, tenantID, in.CredentialID)
	if registry == nil {
		ad.ProviderMessage = "Connect provider credentials before buying or syncing ads."
		if in.PublishNow {
			ad.Status = "blocked"
		}
		return
	}
	readiness := registryReadiness(registry)
	switch ad.Channel {
	case "facebook_instagram":
		if readiness["meta_ads"].Status == "configured" {
			ad.ProviderStatus = "provider_ready"
			ad.ProviderMessage = "Meta Ads credentials are configured; live buying remains gated behind the ads mutation worker."
		}
	default:
		if readiness["google_ads"].Status == "configured" {
			ad.ProviderStatus = "provider_ready"
			ad.ProviderMessage = "Google Ads credentials are configured; set publish_now to validate OAuth/developer-token access."
		}
	}
	if !in.PublishNow || ad.Channel != "google_remarketing" {
		if in.PublishNow && ad.ProviderStatus != "provider_ready" {
			ad.Status = "blocked"
		}
		return
	}
	res, err := registry.ValidateGoogleAds(ctx)
	if err != nil {
		if errors.Is(err, socialads.ErrNotConfigured) {
			ad.Status = "blocked"
			ad.ProviderStatus = "requires_provider"
		} else {
			ad.Status = "provider_error"
			ad.ProviderStatus = "error"
		}
		ad.ProviderMessage = err.Error()
		return
	}
	ad.Status = "ready_for_provider_publish"
	ad.ProviderStatus = res.Status
	ad.ProviderMessage = res.Message
}

func normalizeSocialNetwork(network string) string {
	switch strings.ToLower(strings.TrimSpace(network)) {
	case "instagram", "ig":
		return "instagram"
	case "facebook", "fb":
		return "facebook"
	case "linkedin":
		return "linkedin"
	default:
		return "facebook"
	}
}

func normalizeAdChannel(channel string) string {
	switch strings.ToLower(strings.TrimSpace(channel)) {
	case "google", "google_remarketing", "google_display":
		return "google_remarketing"
	case "facebook", "instagram", "meta", "facebook_instagram":
		return "facebook_instagram"
	default:
		return "google_remarketing"
	}
}

func socialPostFromInput(in SocialPostInput, campaignName string, now time.Time) *SocialPost {
	id := stableID(fmt.Sprintf("social:%s:%s:%s:%d", in.CampaignID, in.Network, in.Text, now.UnixNano()))
	status := "draft"
	if in.PublishNow {
		status = "queued"
	}
	if in.ScheduledAt != nil {
		status = "scheduled"
	}
	return &SocialPost{
		ID: id, CampaignID: in.CampaignID, CampaignName: campaignName, Network: in.Network, AccountID: in.AccountID,
		Text: in.Text, LinkURL: in.LinkURL, MediaURLs: nonNilStringSlice(in.MediaURLs), Status: status, ScheduledAt: in.ScheduledAt,
		AutoPostWithEmail: in.AutoPostWithEmail, ProviderStatus: "requires_provider",
		ProviderMessage: "Connect Facebook/Instagram provider credentials before publishing.",
		CredentialID:    in.CredentialID,
		CredentialMode:  credentialMode(in.CredentialID),
		Report:          map[string]int{"clicks": 0, "comments": 0, "likes": 0, "shares": 0},
		CreatedAt:       now, UpdatedAt: now,
	}
}

func socialPostFromMap(m map[string]any, campaignID, campaignName string, createdAt, updatedAt time.Time) SocialPost {
	post := SocialPost{
		ID:         defaulted(stringValue(m, "id"), stableID(campaignID+stringValue(m, "text"))),
		CampaignID: campaignID, CampaignName: campaignName,
		Network:   defaulted(stringValue(m, "network"), "facebook"),
		AccountID: stringValue(m, "account_id"), Text: stringValue(m, "text"),
		LinkURL:           stringValue(m, "link_url"),
		MediaURLs:         stringSlice(m["media_urls"]),
		Status:            defaulted(stringValue(m, "status"), "draft"),
		ProviderStatus:    defaulted(stringValue(m, "provider_status"), "requires_provider"),
		ProviderMessage:   defaulted(stringValue(m, "provider_message"), "Connect provider credentials before publishing."),
		ProviderID:        stringValue(m, "provider_id"),
		CredentialID:      stringValue(m, "credential_id"),
		CredentialMode:    defaulted(stringValue(m, "credential_mode"), credentialMode(stringValue(m, "credential_id"))),
		AutoPostWithEmail: boolValue(m, "auto_post_with_email"),
		Report:            map[string]int{"clicks": 0, "comments": 0, "likes": 0, "shares": 0},
		CreatedAt:         createdAt, UpdatedAt: updatedAt,
	}
	post.ScheduledAt = timePtrFromAny(m["scheduled_at"])
	post.PublishedAt = timePtrFromAny(m["published_at"])
	if report := intMap(m["report"]); len(report) > 0 {
		post.Report = report
	}
	return post
}

func socialPostPayload(post SocialPost) map[string]any {
	return map[string]any{
		"id": post.ID, "network": post.Network, "account_id": post.AccountID, "text": post.Text,
		"link_url": post.LinkURL, "media_urls": post.MediaURLs, "status": post.Status, "scheduled_at": post.ScheduledAt,
		"published_at": post.PublishedAt, "auto_post_with_email": post.AutoPostWithEmail,
		"provider_status": post.ProviderStatus, "provider_message": post.ProviderMessage,
		"provider_id":   post.ProviderID,
		"credential_id": post.CredentialID, "credential_mode": post.CredentialMode,
		"report": post.Report,
	}
}

func adCampaignFromInput(in AdCampaignInput, campaignName string, now time.Time) *AdCampaign {
	status := "draft"
	if in.StartAt != nil {
		status = "scheduled"
	}
	if in.PublishNow {
		status = "queued_for_provider"
	}
	return &AdCampaign{
		ID:         stableID(fmt.Sprintf("ad:%s:%s:%s:%d", in.CampaignID, in.Channel, in.Name, now.UnixNano())),
		CampaignID: in.CampaignID, CampaignName: campaignName, Channel: in.Channel, Name: in.Name, Status: status,
		ProviderStatus:  "requires_provider",
		ProviderMessage: "Connect provider credentials before buying or syncing ads.",
		CredentialID:    in.CredentialID,
		CredentialMode:  credentialMode(in.CredentialID),
		BudgetCents:     in.BudgetCents, Currency: defaulted(in.Currency, "USD"),
		Audience: nonNilMap(in.Audience), Creative: nonNilMap(in.Creative), StartAt: in.StartAt, EndAt: in.EndAt,
		Report:    map[string]int{"impressions": 0, "clicks": 0, "conversions": 0, "spend_cents": 0},
		CreatedAt: now, UpdatedAt: now,
	}
}

func adCampaignFromMap(m map[string]any, campaignID, campaignName string, createdAt, updatedAt time.Time) AdCampaign {
	ad := AdCampaign{
		ID:         defaulted(stringValue(m, "id"), stableID(campaignID+stringValue(m, "name"))),
		CampaignID: campaignID, CampaignName: campaignName, Channel: defaulted(stringValue(m, "channel"), "google_remarketing"),
		Name: stringValue(m, "name"), Status: defaulted(stringValue(m, "status"), "draft"),
		ProviderStatus:  defaulted(stringValue(m, "provider_status"), "requires_provider"),
		ProviderMessage: stringValue(m, "provider_message"),
		ProviderID:      stringValue(m, "provider_id"),
		CredentialID:    stringValue(m, "credential_id"),
		CredentialMode:  defaulted(stringValue(m, "credential_mode"), credentialMode(stringValue(m, "credential_id"))),
		BudgetCents:     int(floatValue(m, "budget_cents")), Currency: defaulted(stringValue(m, "currency"), "USD"),
		Audience: asMap(m["audience"]), Creative: asMap(m["creative"]), Report: intMap(m["report"]),
		CreatedAt: createdAt, UpdatedAt: updatedAt,
	}
	if ad.Report == nil {
		ad.Report = map[string]int{"impressions": 0, "clicks": 0, "conversions": 0, "spend_cents": 0}
	}
	ad.StartAt = timePtrFromAny(m["start_at"])
	ad.EndAt = timePtrFromAny(m["end_at"])
	return ad
}

func adCampaignPayload(ad AdCampaign) map[string]any {
	return map[string]any{
		"id": ad.ID, "channel": ad.Channel, "name": ad.Name, "status": ad.Status,
		"provider_status": ad.ProviderStatus, "provider_message": ad.ProviderMessage, "provider_id": ad.ProviderID,
		"credential_id": ad.CredentialID, "credential_mode": ad.CredentialMode,
		"budget_cents": ad.BudgetCents, "currency": ad.Currency,
		"audience": ad.Audience, "creative": ad.Creative, "start_at": ad.StartAt, "end_at": ad.EndAt, "report": ad.Report,
	}
}

func pageSocialPosts(posts []SocialPost, offset, count int) []SocialPost {
	offset = maxInt(offset, 0)
	count = normalizeCount(count)
	if offset >= len(posts) {
		return []SocialPost{}
	}
	end := offset + count
	if end > len(posts) {
		end = len(posts)
	}
	return posts[offset:end]
}

func pageAdCampaigns(ads []AdCampaign, offset, count int) []AdCampaign {
	offset = maxInt(offset, 0)
	count = normalizeCount(count)
	if offset >= len(ads) {
		return []AdCampaign{}
	}
	end := offset + count
	if end > len(ads) {
		end = len(ads)
	}
	return ads[offset:end]
}

func normalizeCount(count int) int {
	if count <= 0 {
		return 10
	}
	if count > 100 {
		return 100
	}
	return count
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func normalizeSurveyStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "published", "paused", "archived":
		return strings.ToLower(strings.TrimSpace(status))
	default:
		return "draft"
	}
}

func surveyBuilder() SurveyBuilder {
	return SurveyBuilder{
		Mode:               "hosted_mailchimp_compatible",
		QuestionTypes:      []string{"single_choice", "multiple_choice", "text", "rating", "number", "email", "phone", "date"},
		DesignControls:     []string{"theme", "logo", "hero", "background", "button", "typography", "confirmation", "privacy_copy"},
		NotificationEvents: []string{"response_created", "daily_digest", "threshold_reached"},
		ExportFormats:      []string{"json", "csv", "pdf"},
		Hosted:             true,
	}
}

func notificationChannels(notifications map[string]any) []string {
	if len(notifications) == 0 {
		return []string{"email_digest_available"}
	}
	out := []string{}
	for _, key := range []string{"email", "slack", "webhook", "daily_digest"} {
		if boolValue(notifications, key) || strings.TrimSpace(fmt.Sprint(notifications[key])) != "" && fmt.Sprint(notifications[key]) != "<nil>" {
			out = append(out, key)
		}
	}
	if len(out) == 0 {
		out = append(out, "configured")
	}
	return out
}

func surveyDesignControls(design map[string]any) []string {
	controls := []string{"theme", "typography", "button", "confirmation"}
	for _, key := range []string{"logo_url", "hero_url", "background_color", "accent_color", "privacy_copy"} {
		if strings.TrimSpace(fmt.Sprint(design[key])) != "" && fmt.Sprint(design[key]) != "<nil>" {
			controls = append(controls, key)
		}
	}
	return controls
}

func surveyReportCSV(report *SurveyReport) string {
	if report == nil {
		return ""
	}
	questionIDs := make([]string, 0, len(report.Questions))
	for _, q := range report.Questions {
		questionIDs = append(questionIDs, q.QuestionID)
	}
	headers := append([]string{"email", "source", "recorded_at"}, questionIDs...)
	var b strings.Builder
	b.WriteString(strings.Join(headers, ","))
	b.WriteByte('\n')
	for _, row := range report.ResponseRows {
		cols := []string{csvCell(row.Email), csvCell(row.Source), row.RecordedAt.Format(time.RFC3339)}
		for _, qid := range questionIDs {
			cols = append(cols, csvCell(answerCSVValue(row.Answers[qid])))
		}
		b.WriteString(strings.Join(cols, ","))
		b.WriteByte('\n')
	}
	return b.String()
}

func answerCSVValue(v any) string {
	switch t := v.(type) {
	case []any:
		parts := make([]string, 0, len(t))
		for _, item := range t {
			parts = append(parts, fmt.Sprint(item))
		}
		return strings.Join(parts, "; ")
	case []string:
		return strings.Join(t, "; ")
	default:
		if v == nil {
			return ""
		}
		return fmt.Sprint(v)
	}
}

func normalizeSurveyQuestions(in []SurveyQuestion, blocks []map[string]any) []SurveyQuestion {
	if len(in) == 0 {
		in = blocksToSurveyQuestions(blocks)
	}
	out := make([]SurveyQuestion, 0, len(in))
	for i, q := range in {
		q.ID = defaulted(q.ID, fmt.Sprintf("q_%d", i+1))
		q.Type = defaulted(q.Type, "single_choice")
		q.Label = defaulted(q.Label, fmt.Sprintf("Question %d", i+1))
		out = append(out, q)
	}
	return out
}

func surveyQuestionsToBlocks(questions []SurveyQuestion) []map[string]any {
	out := make([]map[string]any, 0, len(questions))
	for _, q := range questions {
		out = append(out, map[string]any{
			"id": q.ID, "type": q.Type, "label": q.Label, "required": q.Required, "choices": q.Choices,
		})
	}
	return out
}

func blocksToSurveyQuestions(blocks []map[string]any) []SurveyQuestion {
	out := []SurveyQuestion{}
	for i, block := range blocks {
		typ := defaulted(stringValue(block, "type"), "single_choice")
		if !strings.Contains(typ, "choice") && typ != "text" && typ != "rating" && typ != "number" {
			continue
		}
		out = append(out, SurveyQuestion{
			ID:   defaulted(stringValue(block, "id"), fmt.Sprintf("q_%d", i+1)),
			Type: typ, Label: defaulted(stringValue(block, "label"), fmt.Sprintf("Question %d", i+1)),
			Required: boolValue(block, "required"), Choices: stringSlice(block["choices"]),
		})
	}
	return out
}

func answerChoices(v any) []string {
	switch t := v.(type) {
	case []any:
		out := []string{}
		for _, item := range t {
			if s := strings.TrimSpace(fmt.Sprint(item)); s != "" {
				out = append(out, s)
			}
		}
		return out
	case []string:
		return t
	default:
		if s := strings.TrimSpace(fmt.Sprint(v)); s != "" {
			return []string{s}
		}
	}
	return nil
}

func interestsToMemberships(interests map[string]bool) []InterestMembership {
	out := make([]InterestMembership, 0, len(interests))
	for id, active := range interests {
		out = append(out, InterestMembership{ID: id, Name: id, Category: "Imported interests", CanonicalKey: canonicalInterestKey("Imported interests", id), Active: active})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func exactInterestMemberships(rawGroups any, interests map[string]bool) []InterestMembership {
	groups := asMapSlice(rawGroups)
	if len(groups) == 0 {
		return nil
	}
	out := make([]InterestMembership, 0, len(groups))
	for _, g := range groups {
		id := firstNonEmpty(stringValue(g, "id"), stringValue(g, "source_id"), stringValue(g, "name"))
		name := firstNonEmpty(stringValue(g, "name"), id)
		category := firstNonEmpty(stringValue(g, "category"), "Imported interests")
		active := boolValue(g, "active")
		if v, ok := interests[id]; ok {
			active = v
		}
		out = append(out, InterestMembership{
			ID:           id,
			Name:         name,
			Category:     category,
			SourceID:     stringValue(g, "source_id"),
			CanonicalKey: canonicalInterestKey(category, name),
			Active:       active,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CanonicalKey < out[j].CanonicalKey })
	return out
}

func canonicalInterestKey(category, name string) string {
	clean := func(v string) string {
		v = strings.ToLower(strings.TrimSpace(v))
		v = strings.ReplaceAll(v, " ", "_")
		v = strings.ReplaceAll(v, ":", "_")
		return v
	}
	if strings.TrimSpace(name) == "" {
		return clean(category)
	}
	return clean(category) + ":" + clean(name)
}

func contactConsentSummary(member *Member, gdpr []map[string]any) map[string]any {
	out := map[string]any{
		"email_status": member.Status,
		"source":       member.Source,
		"gdpr_count":   len(gdpr),
	}
	if member.TimestampOpt != nil {
		out["consented_at"] = member.TimestampOpt.Format(time.RFC3339)
	}
	if member.IPOpt != "" {
		out["ip"] = member.IPOpt
	}
	return out
}

func profileNotes(appData map[string]any) []map[string]any {
	raw := asMapSlice(appData["notes"])
	if len(raw) == 0 {
		return []map[string]any{}
	}
	return raw
}

func profileSections(member Member, timeline []ContactTimelineItem, commerce ContactEcommerceSummary, gdpr []map[string]any, appData map[string]any) []ProfileSection {
	customFields := asMap(appData["custom_fields"])
	return []ProfileSection{
		{Key: "identity", Label: "Identity", Status: "available", Counts: map[string]int{"tags": member.TagsCount}},
		{Key: "consent", Label: "Consent and GDPR", Status: "available", Counts: map[string]int{"gdpr_preferences": len(gdpr)}},
		{Key: "engagement", Label: "Engagement timeline", Status: "available", Counts: map[string]int{"events": len(timeline)}},
		{Key: "commerce", Label: "Commerce", Status: sectionStatus(commerce.OrderCount > 0), Counts: map[string]int{"orders": commerce.OrderCount}},
		{Key: "custom_fields", Label: "Custom fields and app data", Status: sectionStatus(len(customFields) > 0), Counts: map[string]int{"fields": len(customFields)}},
	}
}

func sectionStatus(ok bool) string {
	if ok {
		return "available"
	}
	return "no_data"
}

func modelQuality(count int, confidence string) string {
	if count >= 10 || confidence == "high" {
		return "strong"
	}
	if count >= 3 || confidence == "medium" {
		return "moderate"
	}
	if count > 0 {
		return "limited"
	}
	return "insufficient_data"
}

func emailDomain(email string) string {
	if idx := strings.LastIndex(email, "@"); idx >= 0 && idx+1 < len(email) {
		return strings.ToLower(email[idx+1:])
	}
	return ""
}

func nonNilStringSlice(in []string) []string {
	if in == nil {
		return []string{}
	}
	return in
}

func nonNilSlice(in []map[string]any) []map[string]any {
	if in == nil {
		return []map[string]any{}
	}
	return in
}

func asMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok && m != nil {
		return m
	}
	return map[string]any{}
}

func asMapSlice(v any) []map[string]any {
	switch t := v.(type) {
	case []map[string]any:
		return t
	case []any:
		out := make([]map[string]any, 0, len(t))
		for _, item := range t {
			if m := asMap(item); len(m) > 0 {
				out = append(out, m)
			}
		}
		return out
	default:
		return []map[string]any{}
	}
}

func stringSlice(v any) []string {
	switch t := v.(type) {
	case []string:
		return t
	case []any:
		out := make([]string, 0, len(t))
		for _, item := range t {
			if s := strings.TrimSpace(fmt.Sprint(item)); s != "" {
				out = append(out, s)
			}
		}
		return out
	default:
		return []string{}
	}
}

func intMap(v any) map[string]int {
	out := map[string]int{}
	for k, value := range asMap(v) {
		out[k] = int(floatFromAny(value))
	}
	return out
}

func boolValue(m map[string]any, key string) bool {
	v, ok := m[key]
	if !ok || v == nil {
		return false
	}
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return strings.EqualFold(t, "true") || t == "1"
	default:
		return false
	}
}

func floatFromAny(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case float32:
		return float64(t)
	case int:
		return float64(t)
	case int64:
		return float64(t)
	case json.Number:
		f, _ := t.Float64()
		return f
	default:
		return 0
	}
}

func timePtrFromAny(v any) *time.Time {
	switch t := v.(type) {
	case time.Time:
		return &t
	case string:
		if parsed, err := time.Parse(time.RFC3339, t); err == nil {
			return &parsed
		}
	}
	return nil
}
