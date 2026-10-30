package mailchimpv3

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func (r *Repo) UpdateFileManagerFile(ctx context.Context, tenant *middleware.Tenant, fileID string, in FileManagerFileUpdate) (*FileManagerFile, error) {
	existing, err := r.GetFileManagerFile(ctx, tenant, fileID)
	if err != nil {
		return nil, err
	}
	meta := copyMap(existing.Metadata)
	for k, v := range in.Metadata {
		meta[k] = v
	}
	if strings.TrimSpace(in.FolderID) != "" {
		meta["folder_id"] = strings.TrimSpace(in.FolderID)
	}
	if strings.TrimSpace(in.ThumbnailURL) != "" {
		meta["thumbnail_url"] = strings.TrimSpace(in.ThumbnailURL)
	}
	if in.Size > 0 {
		meta["size"] = in.Size
	}
	if len(in.Tags) > 0 {
		meta["tags"] = normalizeStringSlice(in.Tags)
	}
	meta["mailchimp_v3"] = true
	metadata, _ := json.Marshal(meta)

	name := firstNonEmpty(in.Name, existing.Name)
	typ := firstNonEmpty(strings.ToLower(strings.TrimSpace(in.Type)), existing.Type)
	fileURL := firstNonEmpty(in.FullSizeURL, in.URL, existing.FullSizeURL)
	altText := existing.AltText
	if strings.TrimSpace(in.AltText) != "" {
		altText = strings.TrimSpace(in.AltText)
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx, `
UPDATE campaign_assets
   SET name = $3,
       asset_type = $4,
       url = $5,
       alt_text = NULLIF($6, ''),
       metadata = $7::jsonb,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND id::text = $2 AND asset_type <> 'folder'
RETURNING `+fileColumns, tenant.ID, fileID, name, typ, fileURL, altText, string(metadata))
	out, err := scanFile(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return out, tx.Commit(ctx)
}

func (r *Repo) FileManagerFileUsage(ctx context.Context, tenant *middleware.Tenant, fileID string) (*FileManagerFileUsageResponse, error) {
	file, err := r.GetFileManagerFile(ctx, tenant, fileID)
	if err != nil {
		return nil, err
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenant.ID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	usage, err := collectContentStudioUsage(ctx, tx, tenant.ID, file.FullSizeURL)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &FileManagerFileUsageResponse{
		FileID:      file.ID,
		URL:         file.FullSizeURL,
		TotalUses:   len(usage),
		Usage:       usage,
		GeneratedAt: time.Now().UTC(),
	}, nil
}

func (r *Repo) ContentStudio(ctx context.Context, tenant *middleware.Tenant) (*ContentStudioResponse, error) {
	files, err := r.ListFileManagerFiles(ctx, tenant, 0, 100)
	if err != nil {
		return nil, err
	}
	folders, err := r.ListFileManagerFolders(ctx, tenant, 0, 100)
	if err != nil {
		return nil, err
	}
	summary := map[string]int{
		"files":   files.TotalItems,
		"folders": folders.TotalItems,
	}
	for _, f := range files.Files {
		summary["type_"+strings.ToLower(defaulted(f.Type, "file"))]++
		summary["bytes"] += f.Size
		if len(f.Tags) > 0 {
			summary["tagged_files"]++
		}
		if strings.TrimSpace(f.AltText) != "" {
			summary["files_with_alt_text"]++
		}
	}
	return &ContentStudioResponse{
		Status:  "available",
		Files:   files.Files,
		Folders: folders.Folders,
		Summary: summary,
		Capabilities: []ChannelCapability{
			{Feature: "file_manager", Status: "available", Detail: "Images, documents, folders, tags, alt text, and metadata are exposed through the Mailchimp compatibility API."},
			{Feature: "cross_campaign_usage", Status: "available", Detail: "Usage lookup scans campaigns, templates, landing pages, forms, and reusable sections."},
			{Feature: "email_safe_video", Status: "available", Detail: "Video URLs can be converted to linked thumbnail HTML and Mailchimp-style merge tags."},
		},
		Lifecycle: map[string]any{
			"upload":         "url_or_existing_asset",
			"organize":       []string{"folders", "tags", "alt_text", "metadata"},
			"reuse":          []string{"campaigns", "templates", "landing_pages", "forms", "sections"},
			"usage_tracking": "content_reference_scan",
			"delete_policy":  "blocked_when_referenced_by_operator_policy",
			"asset_lineage":  "metadata.source_id/source_provider preserved when imported",
			"review_surface": "content_studio_usage_endpoint",
		},
		Policies: map[string]any{
			"allowed_file_types": []string{"image", "document", "video_thumbnail", "generic_file"},
			"access":             "tenant_isolated",
			"required_metadata":  []string{"name", "url_or_file_data"},
			"recommended":        []string{"alt_text", "tags", "folder"},
		},
		Parity: map[string]string{
			"file_manager_api":        "operational",
			"cross_campaign_reuse":    "operational",
			"pixel_perfect_studio_ui": "not_claimed",
			"upload_transcoding":      "not_available",
		},
		Limitations: []string{
			"Uploaded video transcoding is not part of the Content Studio pipeline; video blocks use linked thumbnails.",
			"Generated marketplace-style assets are tracked as files/metadata, not a Mailchimp-owned CDN clone.",
		},
		GeneratedAt: time.Now().UTC(),
	}, nil
}

func (r *Repo) CreativeAssistant(_ context.Context, _ *middleware.Tenant, in CreativeAssistantInput) (*CreativeAssistantResponse, error) {
	return creativeAssistantResponse(in), nil
}

func (r *Repo) InlineAI(_ context.Context, _ *middleware.Tenant, in InlineAIInput) (*InlineAIResponse, error) {
	return inlineAIResponse(in), nil
}

func (r *Repo) ConvertVideo(_ context.Context, _ *middleware.Tenant, in VideoConvertInput) (*VideoConvertResponse, error) {
	out := convertVideoForEmail(in)
	return &out, nil
}

func (r *Repo) ContentBlockCatalog(context.Context, *middleware.Tenant) (*MailchimpBlockCatalogResponse, error) {
	blocks := mailchimpBlockCatalog()
	return &MailchimpBlockCatalogResponse{
		Blocks:     blocks,
		TotalItems: len(blocks),
		EditorContract: map[string]string{
			"storage":        "content_blocks_json",
			"asset_binding":  "content_studio_file_url_or_id",
			"validation":     "block_fields_and_send_time_requirements",
			"migration_keys": "mailchimp_key preserved for imported blocks",
		},
		SendTimeContract: map[string]string{
			"static_blocks":     "render_at_save_or_preview",
			"dynamic_blocks":    "resolve_at_send_with_merge_context",
			"commerce_blocks":   "resolve_from_store/catalog data with fallback",
			"compliance_blocks": "footer/unsubscribe enforced by send pipeline",
		},
		Coverage: map[string]string{
			"basic":      "full",
			"media":      "linked_thumbnail",
			"commerce":   "operational_with_store_data",
			"engagement": "hosted_surveys_and_poll_links",
			"dynamic":    "mailchimp_condition_subset",
		},
		Limitations: []string{
			"Exact Mailchimp drag handles and style panels are not cloned; the block contract is compatible.",
			"RSS, commerce, and conditional blocks are send-time blocks and require live data to fully render.",
		},
		GeneratedAt: time.Now().UTC(),
	}, nil
}

func (r *Repo) PreviewMailchimpTemplate(_ context.Context, _ *middleware.Tenant, in TemplateLanguagePreviewInput) (*TemplateLanguagePreviewResponse, error) {
	htmlOut, foundHTML, unsupportedHTML, footerHTML := renderMailchimpTemplate(in.HTML, in.Variables)
	textOut, foundText, unsupportedText, footerText := renderMailchimpTemplate(in.Text, in.Variables)
	found := sortedUnion(foundHTML, foundText)
	unsupported := sortedUnion(unsupportedHTML, unsupportedText)
	warnings := []string{}
	if len(unsupported) > 0 {
		warnings = append(warnings, "Some Mailchimp merge tags are not available in the supplied preview variables.")
	}
	if !footerHTML && !footerText {
		warnings = append(warnings, "No unsubscribe/archive footer merge tag was detected; production sends should include compliance footer links.")
	}
	return &TemplateLanguagePreviewResponse{
		HTML:                  htmlOut,
		Text:                  textOut,
		FoundTags:             found,
		UnsupportedTags:       unsupported,
		Warnings:              warnings,
		RequiredFooterPresent: footerHTML || footerText,
		Parser:                "postwave-mailchimp-template-v2",
		SupportedSyntax: []string{
			"standard merge tags",
			"IF/IFNOT/ELSEIF/ELSE conditionals",
			"numeric and string comparisons",
			"INTERESTED:group:interest and interest collection checks",
			"POLL and VIDEO compatibility tags",
		},
		UnsupportedSyntax: []string{
			"arbitrary nested parser extensions outside documented Mailchimp-style condition chains",
			"template-side API calls",
		},
	}, nil
}

func collectContentStudioUsage(ctx context.Context, tx pgx.Tx, tenantID, assetURL string) ([]ContentStudioUsage, error) {
	needle := "%" + assetURL + "%"
	queries := []struct {
		kind string
		sql  string
	}{
		{"campaign", `SELECT id::text, name, status, updated_at FROM campaigns WHERE tenant_id = $1::uuid AND (COALESCE(body_html,'') ILIKE $2 OR COALESCE(body_mjml,'') ILIKE $2 OR content_blocks::text ILIKE $2)`},
		{"template", `SELECT id::text, name, COALESCE(category, 'template') AS status, updated_at FROM campaign_templates WHERE tenant_id = $1::uuid AND (COALESCE(body_html,'') ILIKE $2 OR COALESCE(body_mjml,'') ILIKE $2 OR variables::text ILIKE $2)`},
		{"landing_page", `SELECT id::text, name, status, updated_at FROM landing_pages WHERE tenant_id = $1::uuid AND (blocks::text ILIKE $2 OR seo::text ILIKE $2 OR tracking::text ILIKE $2)`},
		{"form", `SELECT id::text, name, status, updated_at FROM forms WHERE tenant_id = $1::uuid AND (structure::text ILIKE $2 OR settings::text ILIKE $2)`},
		{"section", `SELECT id::text, name, category AS status, updated_at FROM campaign_sections WHERE tenant_id = $1::uuid AND (blocks::text ILIKE $2 OR COALESCE(html,'') ILIKE $2 OR COALESCE(mjml,'') ILIKE $2)`},
	}
	var out []ContentStudioUsage
	for _, q := range queries {
		rows, err := tx.Query(ctx, q.sql, tenantID, needle)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var u ContentStudioUsage
			u.Kind = q.kind
			if err := rows.Scan(&u.ID, &u.Name, &u.Status, &u.UpdatedAt); err != nil {
				rows.Close()
				return nil, err
			}
			out = append(out, u)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	return out, nil
}

func creativeAssistantResponse(in CreativeAssistantInput) *CreativeAssistantResponse {
	goal := defaulted(in.Goal, "campaign")
	channel := strings.ToLower(defaulted(in.Channel, "email"))
	audience := defaulted(in.Audience, "your audience")
	tone := defaulted(in.Tone, firstNonEmpty(in.BrandVoice, "clear"))
	offer := defaulted(in.Offer, "the offer")
	id := "creative_" + stableID(goal + "|" + channel + "|" + audience + "|" + offer)[:12]
	out := &CreativeAssistantResponse{
		ID:             id,
		Goal:           goal,
		Channel:        channel,
		ProviderMode:   "deterministic_with_provider_slot",
		ProviderStatus: "available_without_external_ai",
		Checklist:      []string{"Confirm audience consent and suppressions", "Add one primary call to action", "Preview desktop and mobile rendering", "Send a seed/test message before launch"},
		Capabilities: []ChannelCapability{
			{Feature: "campaign_copy", Status: "available", Detail: "Subject, preview, headline, body, and SMS draft generation."},
			{Feature: "automation_ideas", Status: "available", Detail: "Goal-specific automation templates for email/SMS journeys."},
			{Feature: "provider_llm", Status: "optional", Detail: "The contract is provider-ready; deterministic fallback remains safe for local/offline operation."},
		},
		Limits: map[string]any{
			"subject_lines":           3,
			"body_drafts":             2,
			"sms_drafts":              2,
			"automation_templates":    2,
			"mailchimp_intuit_parity": "functional_contract_not_pixel_clone",
		},
		GeneratedAt: time.Now().UTC(),
	}
	headline := titleish(goal)
	out.Headlines = []string{
		fmt.Sprintf("%s for %s", headline, audience),
		fmt.Sprintf("A %s update on %s", tone, offer),
		fmt.Sprintf("Your next step: %s", offer),
	}
	if channel == "sms" {
		out.SMSDrafts = []string{
			truncateSMS(fmt.Sprintf("%s: %s is ready. Reply STOP to opt out.", headline, offer)),
			truncateSMS(fmt.Sprintf("%s for %s. Tap to learn more. STOP to opt out.", offer, audience)),
		}
	} else {
		out.SubjectLines = []string{
			fmt.Sprintf("%s: %s", headline, offer),
			fmt.Sprintf("%s, built for %s", offer, audience),
			fmt.Sprintf("A %s note about %s", tone, offer),
		}
		out.PreviewTexts = []string{
			fmt.Sprintf("A short, %s campaign draft for %s.", tone, audience),
			fmt.Sprintf("Everything they need to act on %s.", offer),
		}
		out.BodyDrafts = []string{
			fmt.Sprintf("Hi *|FNAME|*,\n\nWe put together %s for %s. The main idea is simple: %s.\n\nTake a look when you have a minute.", offer, audience, goal),
			fmt.Sprintf("*|FNAME|*, here is the %s version: %s. Keep this message focused on one promise and one next step.", tone, offer),
		}
	}
	out.AutomationTemplates = []CreativeAutomationTemplate{
		{
			Name:    "Welcome and nurture",
			Goal:    "turn new subscribers into qualified customers",
			Channel: "email_sms",
			Steps: []map[string]string{
				{"type": "trigger", "label": "Subscriber joins selected audience"},
				{"type": "email", "label": "Send welcome email"},
				{"type": "wait", "label": "Wait 2 days"},
				{"type": "branch", "label": "If email clicked, send SMS reminder when consent exists"},
			},
		},
		{
			Name:    "Re-engagement",
			Goal:    "recover inactive contacts",
			Channel: channel,
			Steps: []map[string]string{
				{"type": "trigger", "label": "No opens or clicks in 60 days"},
				{"type": "email", "label": "Send value-first reactivation message"},
				{"type": "branch", "label": "Suppress or downgrade contacts that stay inactive"},
			},
		},
	}
	return out
}

func inlineAIResponse(in InlineAIInput) *InlineAIResponse {
	mode := strings.ToLower(defaulted(in.Mode, "rewrite"))
	channel := strings.ToLower(defaulted(in.Channel, "email"))
	source := strings.TrimSpace(firstNonEmpty(in.Text, in.Prompt, "Write a concise campaign message."))
	tone := strings.ToLower(defaulted(in.Tone, "clear"))
	var variants []string
	switch mode {
	case "shorten":
		variants = []string{shortenText(source, 160), shortenText(source, 90)}
	case "lengthen":
		variants = []string{source + "\n\nAdd proof, a clear next step, and one reason to act today."}
	case "subject":
		variants = []string{titleish(source), "A quick update for *|FNAME|*", "Worth a look this week"}
	case "sms":
		channel = "sms"
		variants = []string{truncateSMS(source), truncateSMS(source + " Reply STOP to opt out.")}
	case "tone":
		variants = []string{fmt.Sprintf("%s\n\nTone: %s, direct, and useful.", source, tone)}
	default:
		variants = []string{
			fmt.Sprintf("%s\n\nMake the value clear, keep one call to action, and personalize with *|FNAME|*.", source),
			shortenText(source, 220),
		}
	}
	warnings := []string{}
	meta := map[string]any{"tone": tone, "character_count": len([]rune(variants[0]))}
	if channel == "sms" {
		chars := len([]rune(variants[0]))
		meta["sms_segments"] = smsSegments(chars)
		if !strings.Contains(strings.ToUpper(variants[0]), "STOP") {
			warnings = append(warnings, "SMS copy should include opt-out language when required by the sending context.")
		}
	}
	return &InlineAIResponse{
		Mode:           mode,
		Channel:        channel,
		ProviderMode:   "deterministic_with_provider_slot",
		ProviderStatus: "available_without_external_ai",
		Text:           variants[0],
		Variants:       variants,
		Actions:        []string{"rewrite", "shorten", "lengthen", "tone", "subject", "sms"},
		Metadata:       meta,
		Capabilities: []ChannelCapability{
			{Feature: "inline_builder_ai", Status: "available", Detail: "Email and SMS builders can request rewrite, shorten, lengthen, subject, tone, and SMS variants."},
			{Feature: "compliance_hints", Status: "available", Detail: "SMS drafts warn when required opt-out language is absent."},
		},
		Warnings:    warnings,
		GeneratedAt: time.Now().UTC(),
	}
}

func convertVideoForEmail(in VideoConvertInput) VideoConvertResponse {
	rawURL := strings.TrimSpace(in.URL)
	provider, videoID, thumbnail := detectVideo(rawURL)
	if strings.TrimSpace(in.ThumbnailURL) != "" {
		thumbnail = strings.TrimSpace(in.ThumbnailURL)
	}
	if thumbnail == "" {
		thumbnail = "https://placehold.co/960x540?text=Video"
	}
	title := defaulted(in.Title, "Watch video")
	cta := defaulted(in.CTA, "Watch now")
	alt := defaulted(in.AltText, title)
	mergeTag := fmt.Sprintf("*|VIDEO:%s|*", firstNonEmpty(videoID, stableID(rawURL)[:12]))
	htmlOut := fmt.Sprintf(`<a href="%s" style="display:block;text-decoration:none"><img src="%s" alt="%s" style="width:100%%;max-width:640px;border:0;display:block"><span style="display:inline-block;margin-top:12px">%s</span></a>`,
		html.EscapeString(rawURL), html.EscapeString(thumbnail), html.EscapeString(alt), html.EscapeString(cta))
	warnings := []string{}
	if provider == "generic" {
		warnings = append(warnings, "A custom thumbnail is recommended for generic video URLs.")
	}
	warnings = append(warnings, "Upload/transcode is not enabled; this conversion creates an email-safe linked thumbnail.")
	return VideoConvertResponse{
		Provider:        provider,
		VideoID:         videoID,
		URL:             rawURL,
		ThumbnailURL:    thumbnail,
		MergeTag:        mergeTag,
		EmailHTML:       htmlOut,
		PlainText:       fmt.Sprintf("%s: %s", title, rawURL),
		Pipeline:        "linked_thumbnail",
		TranscodeStatus: "not_required_for_linked_thumbnail",
		UploadSupported: false,
		SupportedSources: []string{
			"youtube",
			"vimeo",
			"generic_url_with_custom_thumbnail",
		},
		AssetLifecycle: map[string]string{
			"source":        "external_video_url",
			"thumbnail":     "detected_or_user_supplied",
			"send_time":     "render_linked_image",
			"transcoding":   "not_available",
			"accessibility": "alt_text_required",
		},
		Warnings: warnings,
	}
}

func detectVideo(raw string) (provider, videoID, thumbnail string) {
	u, err := url.Parse(raw)
	if err != nil {
		return "generic", "", ""
	}
	host := strings.ToLower(u.Host)
	switch {
	case strings.Contains(host, "youtu.be"):
		videoID = strings.Trim(strings.TrimPrefix(u.Path, "/"), "/")
		provider = "youtube"
	case strings.Contains(host, "youtube.com"):
		videoID = u.Query().Get("v")
		if videoID == "" && strings.Contains(u.Path, "/shorts/") {
			videoID = strings.TrimPrefix(u.Path, "/shorts/")
		}
		provider = "youtube"
	case strings.Contains(host, "vimeo.com"):
		videoID = strings.Trim(strings.TrimPrefix(u.Path, "/"), "/")
		provider = "vimeo"
	default:
		provider = "generic"
	}
	if provider == "youtube" && videoID != "" {
		thumbnail = "https://img.youtube.com/vi/" + videoID + "/hqdefault.jpg"
	}
	return provider, videoID, thumbnail
}

func mailchimpBlockCatalog() []MailchimpBlockDefinition {
	return []MailchimpBlockDefinition{
		{ID: "text", Name: "Text", Category: "basic", Description: "Rich text content.", Fields: []string{"content"}, DefaultData: map[string]any{"content": "Write your message."}, MailchimpKey: "text", EditorParity: "full", RenderPhase: "edit_time", SendTimeBehavior: "static_html"},
		{ID: "image", Name: "Image", Category: "basic", Description: "Responsive campaign image.", Fields: []string{"url", "alt"}, DefaultData: map[string]any{"url": "", "alt": ""}, MailchimpKey: "image", EditorParity: "full", RenderPhase: "edit_time", SendTimeBehavior: "asset_url_render"},
		{ID: "button", Name: "Button", Category: "basic", Description: "Primary call-to-action button.", Fields: []string{"label", "url"}, DefaultData: map[string]any{"label": "Learn more", "url": ""}, MailchimpKey: "button", EditorParity: "full", RenderPhase: "edit_time", SendTimeBehavior: "link_tracking_rewrite"},
		{ID: "product_recommendations", Name: "Product recommendations", Category: "commerce", Description: "Product recommendation grid sourced from ecommerce data.", Fields: []string{"title", "products", "recommendation_source"}, DefaultData: map[string]any{"title": "Recommended for you", "recommendation_source": "latest_products"}, MailchimpKey: "productRec", EditorParity: "partial", RenderPhase: "send_time", SendTimeBehavior: "commerce_products_resolved_per_audience", Limitations: []string{"Predictive ranking requires store history; fallback is latest/popular products."}},
		{ID: "discount_code", Name: "Discount code", Category: "commerce", Description: "Promo code callout block.", Fields: []string{"code", "description", "url"}, DefaultData: map[string]any{"code": "SAVE10", "description": "Use this at checkout."}, MailchimpKey: "promoCode", EditorParity: "partial", RenderPhase: "send_time", SendTimeBehavior: "postwave_or_store_discount_code_insert"},
		{ID: "survey", Name: "Survey", Category: "engagement", Description: "Hosted survey or poll question.", Fields: []string{"question", "choices", "survey_id"}, DefaultData: map[string]any{"question": "What did you think?", "choices": []string{"Great", "Okay"}}, MailchimpKey: "survey", EditorParity: "partial", RenderPhase: "send_time", SendTimeBehavior: "hosted_survey_or_poll_links"},
		{ID: "social_follow", Name: "Social follow", Category: "social", Description: "Social profile follow links.", Fields: []string{"facebook_url", "instagram_url", "linkedin_url", "x_url"}, DefaultData: map[string]any{}, MailchimpKey: "socialFollow", EditorParity: "full", RenderPhase: "edit_time", SendTimeBehavior: "static_links"},
		{ID: "social_share", Name: "Social share", Category: "social", Description: "Share this campaign on social networks.", Fields: []string{"share_url", "text"}, DefaultData: map[string]any{"text": "Share this"}, MailchimpKey: "socialShare", EditorParity: "partial", RenderPhase: "send_time", SendTimeBehavior: "campaign_archive_share_links"},
		{ID: "rss", Name: "RSS", Category: "dynamic", Description: "RSS feed content placeholder.", Fields: []string{"feed_url", "count"}, DefaultData: map[string]any{"count": 3}, MailchimpKey: "rss", EditorParity: "partial", RenderPhase: "send_time", SendTimeBehavior: "feed_fetch_with_cached_fallback", Limitations: []string{"RSS expansion depends on feed availability at render/send time."}},
		{ID: "video", Name: "Video", Category: "media", Description: "Email-friendly linked video thumbnail.", Fields: []string{"video_url", "thumbnail_url", "title"}, DefaultData: map[string]any{"title": "Watch video"}, MailchimpKey: "video", EditorParity: "partial", RenderPhase: "edit_time", SendTimeBehavior: "linked_thumbnail", Limitations: []string{"No upload/transcode pipeline."}},
		{ID: "dynamic_content", Name: "Dynamic content", Category: "dynamic", Description: "Render content from merge data conditions.", Fields: []string{"condition", "content", "fallback"}, DefaultData: map[string]any{"condition": "VIP", "content": "VIP offer", "fallback": "General offer"}, MailchimpKey: "conditionalContent", EditorParity: "partial", RenderPhase: "send_time", SendTimeBehavior: "merge_data_condition"},
		{ID: "conditional_content", Name: "Conditional content", Category: "dynamic", Description: "Mailchimp-style conditional merge-tag content.", Fields: []string{"condition", "content", "fallback"}, DefaultData: map[string]any{"condition": "FNAME", "content": "Hello *|FNAME|*", "fallback": "Hello"}, MailchimpKey: "mcConditional", EditorParity: "partial", RenderPhase: "send_time", SendTimeBehavior: "mailchimp_condition_parser"},
	}
}

var (
	mailchimpIfBlockRe      = regexp.MustCompile(`(?s)\*\|IF:([^|]+)\|\*(.*?)\*\|END:IF\|\*`)
	mailchimpIfNotRe        = regexp.MustCompile(`(?s)\*\|IFNOT:([^|]+)\|\*(.*?)\*\|END:IF\|\*`)
	mailchimpElseIfMarkerRe = regexp.MustCompile(`\*\|ELSEIF:([^|]+)\|\*`)
	mailchimpTagRe          = regexp.MustCompile(`\*\|([A-Za-z0-9_:. -]+)\|\*`)
)

func renderMailchimpTemplate(input string, variables map[string]any) (string, []string, []string, bool) {
	vars := normalizeVariables(variables)
	original := input
	out := input
	out = mailchimpIfNotRe.ReplaceAllStringFunc(out, func(match string) string {
		parts := mailchimpIfNotRe.FindStringSubmatch(match)
		if len(parts) != 3 {
			return match
		}
		if !evalMailchimpCondition(parts[1], vars) {
			return parts[2]
		}
		return ""
	})
	out = mailchimpIfBlockRe.ReplaceAllStringFunc(out, func(match string) string {
		parts := mailchimpIfBlockRe.FindStringSubmatch(match)
		if len(parts) != 3 {
			return match
		}
		return renderMailchimpConditionalChain(parts[1], parts[2], vars)
	})
	foundSet := map[string]bool{}
	unsupportedSet := map[string]bool{}
	out = mailchimpTagRe.ReplaceAllStringFunc(out, func(match string) string {
		tag := strings.TrimSpace(mailchimpTagRe.FindStringSubmatch(match)[1])
		upper := strings.ToUpper(tag)
		foundSet[upper] = true
		if v, ok := vars[upper]; ok {
			return fmt.Sprint(v)
		}
		if value, ok := knownMailchimpTag(upper); ok {
			return value
		}
		unsupportedSet[upper] = true
		return match
	})
	footer := strings.Contains(strings.ToUpper(original), "*|UNSUB|*") ||
		strings.Contains(strings.ToUpper(original), "*|UNSUBSCRIBE|*") ||
		strings.Contains(strings.ToLower(original), "unsubscribe")
	return out, sortedKeys(foundSet), sortedKeys(unsupportedSet), footer
}

func renderMailchimpConditionalChain(firstCond, inner string, vars map[string]any) string {
	elseBody := ""
	if idx := strings.Index(inner, "*|ELSE:|*"); idx >= 0 {
		elseBody = inner[idx+len("*|ELSE:|*"):]
		inner = inner[:idx]
	}
	type branch struct {
		cond string
		body string
	}
	branches := []branch{}
	matches := mailchimpElseIfMarkerRe.FindAllStringSubmatchIndex(inner, -1)
	if len(matches) == 0 {
		branches = append(branches, branch{cond: firstCond, body: inner})
	} else {
		branches = append(branches, branch{cond: firstCond, body: inner[:matches[0][0]]})
		for i, match := range matches {
			condStart, condEnd := match[2], match[3]
			bodyStart := match[1]
			bodyEnd := len(inner)
			if i+1 < len(matches) {
				bodyEnd = matches[i+1][0]
			}
			branches = append(branches, branch{
				cond: inner[condStart:condEnd],
				body: inner[bodyStart:bodyEnd],
			})
		}
	}
	for _, b := range branches {
		if evalMailchimpCondition(b.cond, vars) {
			return b.body
		}
	}
	return elseBody
}

func normalizeVariables(in map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range in {
		out[strings.ToUpper(strings.TrimSpace(k))] = v
	}
	return out
}

func evalMailchimpCondition(cond string, vars map[string]any) bool {
	cond = strings.TrimSpace(cond)
	if ok, handled := evalMailchimpInterestCondition(cond, vars); handled {
		return ok
	}
	for _, op := range []string{">=", "<=", "!=", "=", ">", "<"} {
		if strings.Contains(cond, op) {
			parts := strings.SplitN(cond, op, 2)
			key := strings.ToUpper(strings.Trim(strings.TrimSpace(parts[0]), `"'`))
			want := strings.Trim(strings.TrimSpace(parts[1]), `"'`)
			got := strings.TrimSpace(fmt.Sprint(vars[key]))
			gotNum, gotNumOK := parseFloat(got)
			wantNum, wantNumOK := parseFloat(want)
			if gotNumOK && wantNumOK {
				switch op {
				case ">=":
					return gotNum >= wantNum
				case "<=":
					return gotNum <= wantNum
				case ">":
					return gotNum > wantNum
				case "<":
					return gotNum < wantNum
				case "!=":
					return gotNum != wantNum
				default:
					return gotNum == wantNum
				}
			}
			if op == "!=" {
				return !strings.EqualFold(got, want)
			}
			return strings.EqualFold(got, want)
		}
	}
	value, ok := vars[strings.ToUpper(cond)]
	if !ok || value == nil {
		return false
	}
	switch v := value.(type) {
	case bool:
		return v
	case string:
		return strings.TrimSpace(v) != "" && !strings.EqualFold(v, "false") && v != "0"
	case int:
		return v != 0
	case int64:
		return v != 0
	case float64:
		return v != 0
	default:
		return true
	}
}

func evalMailchimpInterestCondition(cond string, vars map[string]any) (bool, bool) {
	upper := strings.ToUpper(strings.TrimSpace(cond))
	prefixes := []string{"INTERESTED:", "GROUP:", "GROUPINGS:"}
	handled := false
	for _, prefix := range prefixes {
		if strings.HasPrefix(upper, prefix) {
			handled = true
			break
		}
	}
	if !handled {
		return false, false
	}
	if truthyAny(vars[upper]) {
		return true, true
	}
	parts := strings.Split(upper, ":")
	candidates := []string{upper}
	if len(parts) > 1 {
		candidates = append(candidates, parts[len(parts)-1])
	}
	if len(parts) > 2 {
		candidates = append(candidates, parts[len(parts)-2]+":"+parts[len(parts)-1])
	}
	for _, key := range []string{"INTERESTS", "GROUPS", "GROUPINGS", "INTERESTED"} {
		if collectionContainsAny(vars[key], candidates) {
			return true, true
		}
	}
	return false, true
}

func truthyAny(value any) bool {
	if value == nil {
		return false
	}
	switch v := value.(type) {
	case bool:
		return v
	case string:
		return strings.TrimSpace(v) != "" && !strings.EqualFold(v, "false") && v != "0"
	case int:
		return v != 0
	case int64:
		return v != 0
	case float64:
		return v != 0
	case []string:
		return len(v) > 0
	case []any:
		return len(v) > 0
	case map[string]any:
		return len(v) > 0
	default:
		return true
	}
}

func collectionContainsAny(value any, candidates []string) bool {
	set := map[string]bool{}
	for _, c := range candidates {
		c = strings.ToUpper(strings.TrimSpace(c))
		if c != "" {
			set[c] = true
		}
	}
	if len(set) == 0 || value == nil {
		return false
	}
	switch v := value.(type) {
	case []string:
		for _, item := range v {
			if set[strings.ToUpper(strings.TrimSpace(item))] {
				return true
			}
		}
	case []any:
		for _, item := range v {
			if set[strings.ToUpper(strings.TrimSpace(fmt.Sprint(item)))] {
				return true
			}
		}
	case map[string]any:
		for k, raw := range v {
			key := strings.ToUpper(strings.TrimSpace(k))
			if set[key] && truthyAny(raw) {
				return true
			}
			for candidate := range set {
				if strings.Contains(key, candidate) && truthyAny(raw) {
					return true
				}
			}
		}
	case map[string]bool:
		for k, ok := range v {
			if ok && set[strings.ToUpper(strings.TrimSpace(k))] {
				return true
			}
		}
	case string:
		for _, item := range strings.Split(v, ",") {
			if set[strings.ToUpper(strings.TrimSpace(item))] {
				return true
			}
		}
	}
	return false
}

func parseFloat(s string) (float64, bool) {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil {
		return 0, false
	}
	return f, true
}

func knownMailchimpTag(tag string) (string, bool) {
	switch {
	case tag == "CURRENT_YEAR":
		return fmt.Sprint(time.Now().UTC().Year()), true
	case tag == "UNSUB" || tag == "UNSUBSCRIBE":
		return "https://example.postwave.local/unsubscribe", true
	case tag == "ARCHIVE":
		return "https://example.postwave.local/archive", true
	case tag == "UPDATE_PROFILE":
		return "https://example.postwave.local/profile", true
	case tag == "FORWARD":
		return "https://example.postwave.local/forward", true
	case tag == "LIST:ADDRESS":
		return "Sender address", true
	case tag == "LIST:COMPANY":
		return "Moosewave", true
	case strings.HasPrefix(tag, "POLL:"):
		return "[poll: " + strings.TrimPrefix(tag, "POLL:") + "]", true
	case strings.HasPrefix(tag, "VIDEO:"):
		return "[video: " + strings.TrimPrefix(tag, "VIDEO:") + "]", true
	case tag == "REWARDS":
		return "", true
	default:
		return "", false
	}
}

func copyMap(in map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range in {
		out[k] = v
	}
	return out
}

func normalizeStringSlice(in []string) []string {
	set := map[string]bool{}
	out := []string{}
	for _, raw := range in {
		v := strings.TrimSpace(raw)
		if v == "" {
			continue
		}
		key := strings.ToLower(v)
		if set[key] {
			continue
		}
		set[key] = true
		out = append(out, v)
	}
	return out
}

func stringsFromAny(v any) []string {
	switch t := v.(type) {
	case []string:
		return normalizeStringSlice(t)
	case []any:
		out := make([]string, 0, len(t))
		for _, item := range t {
			out = append(out, fmt.Sprint(item))
		}
		return normalizeStringSlice(out)
	case string:
		if strings.TrimSpace(t) == "" {
			return []string{}
		}
		return normalizeStringSlice(strings.Split(t, ","))
	default:
		return []string{}
	}
}

func sortedUnion(groups ...[]string) []string {
	set := map[string]bool{}
	for _, group := range groups {
		for _, item := range group {
			if strings.TrimSpace(item) != "" {
				set[item] = true
			}
		}
	}
	return sortedKeys(set)
}

func sortedKeys(set map[string]bool) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func titleish(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "Campaign"
	}
	words := strings.Fields(strings.ReplaceAll(s, "_", " "))
	for i, word := range words {
		if len(word) == 0 {
			continue
		}
		words[i] = strings.ToUpper(word[:1]) + strings.ToLower(word[1:])
	}
	return strings.Join(words, " ")
}

func shortenText(s string, limit int) string {
	runes := []rune(strings.TrimSpace(s))
	if len(runes) <= limit {
		return string(runes)
	}
	if limit <= 1 {
		return string(runes[:limit])
	}
	return strings.TrimSpace(string(runes[:limit-1])) + "..."
}

func truncateSMS(s string) string {
	s = strings.TrimSpace(s)
	if !strings.Contains(strings.ToUpper(s), "STOP") {
		s += " Reply STOP to opt out."
	}
	return shortenText(s, 300)
}

func smsSegments(chars int) int {
	if chars <= 160 {
		return 1
	}
	return (chars + 152) / 153
}
