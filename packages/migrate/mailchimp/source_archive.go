// SPDX-License-Identifier: MIT

package mailchimp

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

const sourceArchivePageSize = 100

const sourceArchiveCursorResource = "source_archive"

type mailchimpCapabilityGuidanceItem struct {
	Cursor              string
	SourceID            string
	ResourceType        string
	Name                string
	Detail              string
	RebuildTask         string
	FoundationArtifacts []string
}

var mailchimpCapabilityGuidance = []mailchimpCapabilityGuidanceItem{
	{
		Cursor:       "content",
		SourceID:     "mailchimp:content_studio",
		ResourceType: "mailchimp_content_studio",
		Name:         "Content Studio, file manager, AI, and template language",
		Detail:       "Archive Mailchimp asset-library, folder, block, template-language, video, and Creative Assistant context so reusable creative surfaces can be rebuilt against Moosewave content and editor foundations.",
		RebuildTask:  "Recreate high-value files/folders, reusable blocks, brand settings, template-language macros, AI prompts, and video embeds in Moosewave before final cutover.",
		FoundationArtifacts: []string{
			"apps/api/internal/mailchimpv3",
			"docs/mailchimp-content-ai-parity.md",
		},
	},
	{
		Cursor:       "surveys",
		SourceID:     "mailchimp:surveys_polls",
		ResourceType: "mailchimp_survey_poll",
		Name:         "Hosted surveys and email polls",
		Detail:       "Archive survey, poll, quiz, and response-intake expectations that are not always exposed with enough API detail for direct native reconstruction.",
		RebuildTask:  "Rebuild active surveys, email poll merge tags, response exports, and audience-property mappings in Moosewave growth surfaces.",
		FoundationArtifacts: []string{
			"infra/migrations/0195_mailchimp_multichannel_surveys.sql",
			"apps/api/internal/mailchimpv3",
		},
	},
	{
		Cursor:       "sms",
		SourceID:     "mailchimp:sms_program",
		ResourceType: "mailchimp_sms_program",
		Name:         "SMS and MMS program",
		Detail:       "Preserve SMS/MMS sender, consent, credit, quiet-hour, country, keyword, and campaign-planning context as an explicit provider-gated rebuild item.",
		RebuildTask:  "Reconnect SMS provider credentials, verify consent proof, map quiet hours/keywords, and rehearse MMS/SMS campaigns in Moosewave before enabling sends.",
		FoundationArtifacts: []string{
			"apps/api/internal/sms",
			"docs/mailchimp-sms-parity.md",
		},
	},
	{
		Cursor:       "connected_sites",
		SourceID:     "mailchimp:connected_sites",
		ResourceType: "mailchimp_connected_site",
		Name:         "Connected sites and onsite tracking",
		Detail:       "Archive connected-site script, ecommerce tracking, popup/embed, and domain association work that requires site-owner installation review.",
		RebuildTask:  "Install Moosewave tracking/embed scripts, verify site ownership, reconnect ecommerce events, and retest onsite forms/landing pages.",
		FoundationArtifacts: []string{
			"apps/api/internal/mailchimpv3",
			"apps/api/internal/track",
		},
	},
	{
		Cursor:       "domains",
		SourceID:     "mailchimp:verified_domains",
		ResourceType: "mailchimp_verified_domain",
		Name:         "Verified domains and deliverability setup",
		Detail:       "Preserve sending-domain, authentication, branded-link, and DNS review state so deliverability setup is not hidden inside a contact import.",
		RebuildTask:  "Recreate verified/sending domains, DKIM/SPF/DMARC records, branded links, SSL, and warmup checks in Moosewave deliverability controls.",
		FoundationArtifacts: []string{
			"apps/api/internal/mailchimpv3",
			"services/deliverability",
		},
	},
	{
		Cursor:       "ads",
		SourceID:     "mailchimp:ads_social_postcards",
		ResourceType: "mailchimp_social_ad",
		Name:         "Ads, social posts, and postcards",
		Detail:       "Archive social-post, Facebook/Instagram/Google ad, retargeting, audience sync, and postcard/direct-mail decisions as external-channel rebuild work.",
		RebuildTask:  "Reconnect provider accounts or export audiences, recreate active ad/social/direct-mail campaigns, and decide which channels stay outside Moosewave.",
		FoundationArtifacts: []string{
			"infra/migrations/0195_mailchimp_multichannel_surveys.sql",
			"apps/api/internal/mailchimpv3",
		},
	},
	{
		Cursor:       "developer",
		SourceID:     "mailchimp:developer_platform",
		ResourceType: "mailchimp_developer_platform",
		Name:         "Developer platform, batches, webhooks, and exports",
		Detail:       "Preserve webhook, batch, account-export, authorized-app, API-client, and integration expectations that need reauthorization or endpoint replacement.",
		RebuildTask:  "Recreate webhooks, async jobs, account exports, API credentials, authorized apps, and integration callbacks against Moosewave developer APIs.",
		FoundationArtifacts: []string{
			"apps/api/internal/mailchimpv3",
			"docs/mailchimp-developer-platform-parity.md",
		},
	},
	{
		Cursor:       "transactional",
		SourceID:     "mailchimp:transactional",
		ResourceType: "mailchimp_transactional",
		Name:         "Mailchimp Transactional",
		Detail:       "Archive Mandrill-style template, message, SMTP, webhook, inbound-route, rejection, and metadata expectations as a separate provider-gated system.",
		RebuildTask:  "Choose a transactional provider, migrate templates/merge vars, configure webhooks/inbound routes, and run policy review before sending transactional mail.",
		FoundationArtifacts: []string{
			"apps/api/internal/mailchimpv3",
			"apps/api/internal/providers",
		},
	},
	{
		Cursor:       "marketplace",
		SourceID:     "mailchimp:marketplace",
		ResourceType: "mailchimp_marketplace",
		Name:         "Marketplace, agency, and partner integrations",
		Detail:       "Archive integration marketplace, connected app, expert/agency, OAuth, and partner-program dependencies for explicit cutover ownership.",
		RebuildTask:  "Inventory every connected integration, reauthorize or replace required apps, assign owners, and validate agency/partner workflows after migration.",
		FoundationArtifacts: []string{
			"apps/api/internal/mailchimpv3",
			"packages/openapi",
		},
	},
}

// ListSourceArchive preserves Mailchimp surfaces that the supported Marketing
// API can actually read. Unsupported or non-inventoryable capabilities are
// emitted as warning-only guidance and are never counted as detected/imported
// account objects.
func (a *Adapter) ListSourceArchive(ctx context.Context, sess adapter.Session, cursor string) ([]canonical.SourceArchiveItem, string, error) {
	resource, offset, pageCursor, err := parseMailchimpArchivePageCursor(cursor)
	if err != nil {
		return nil, "", err
	}
	switch resource {
	case "audience":
		return a.listAudienceSchemaArchive(ctx, sess, offset)
	case "journeys":
		return a.listJourneyArchive(ctx, sess, offset)
	case "forms":
		return a.listFormArchive(ctx, sess, offset)
	case "landing":
		return a.listLandingPageArchive(ctx, sess, offset, pageCursor)
	case "ecommerce":
		return a.listEcommerceArchive(ctx, sess, offset, pageCursor)
	case "content", "surveys", "sms", "connected_sites", "domains", "ads", "developer", "transactional", "marketplace":
		return listMailchimpCapabilityGuidance(resource)
	default:
		return nil, "", fmt.Errorf("mailchimp: unknown source archive resource %q", resource)
	}
}

func (a *Adapter) listJourneyArchive(_ context.Context, _ adapter.Session, _ int) ([]canonical.SourceArchiveItem, string, error) {
	const detail = "Mailchimp's Marketing API exposes trigger actions for Customer Journeys (Automation Flows), but it does not expose a supported endpoint for listing/exporting complete Journey graphs. Customer Journeys were not imported; inventory and rebuild must be completed manually in Mailchimp and Moosewave."
	return []canonical.SourceArchiveItem{{
		SourceID:     "source_archive_warning:mailchimp_customer_journeys",
		ResourceType: "mailchimp_customer_journey",
		Name:         "Customer Journeys (Automation Flows)",
		Status:       "manual_review",
		Payload: map[string]interface{}{
			"detail":                detail,
			"detected":              false,
			"detection_available":   false,
			"export_available":      false,
			"supported_import_type": "classic_automations_only",
		},
		Warnings:       []string{detail},
		SourcePlatform: canonical.SourceMailchimp,
	}}, mailchimpArchiveCursor("forms", 0), nil
}

func (a *Adapter) listAudienceSchemaArchive(ctx context.Context, sess adapter.Session, offset int) ([]canonical.SourceArchiveItem, string, error) {
	listIDs, err := a.listAudienceIDs(ctx, sess)
	if err != nil {
		return nil, "", err
	}
	if offset >= len(listIDs) {
		return nil, mailchimpArchiveCursor("journeys", 0), nil
	}
	listID := listIDs[offset]
	payload := map[string]interface{}{
		"list_id":                 listID,
		"canonical_field_mapping": "mailchimp_merge_tags_to_postwave_custom_fields",
		"native_status":           "materialized",
	}
	warnings := []string{}
	mergeFields, err := a.fetchAllMapCollection(ctx, sess, "merge fields for audience "+listID, func(offset int) string {
		return fmt.Sprintf("/lists/%s/merge-fields?count=%d&offset=%d", listID, mailchimpMaxPageSize, offset)
	}, "merge_fields", "fields")
	if err == nil {
		payload["merge_fields"] = firstAny(mergeFields, "merge_fields", "fields")
	} else {
		payload["merge_fields_error"] = err.Error()
		warnings = append(warnings, err.Error())
	}
	segments, err := a.fetchAllMapCollection(ctx, sess, "segments for audience schema "+listID, func(offset int) string {
		return fmt.Sprintf("/lists/%s/segments?count=%d&offset=%d", listID, mailchimpMaxPageSize, offset)
	}, "segments")
	if err == nil {
		payload["segments"] = firstAny(segments, "segments")
	} else {
		payload["segments_error"] = err.Error()
		warnings = append(warnings, err.Error())
	}
	interests, err := a.fetchAllMapCollection(ctx, sess, "interest categories for audience "+listID, func(offset int) string {
		return fmt.Sprintf("/lists/%s/interest-categories?count=%d&offset=%d", listID, mailchimpMaxPageSize, offset)
	}, "categories", "interest_categories")
	if err == nil {
		payload["interest_categories"] = firstAny(interests, "categories", "interest_categories")
		byCategory, categoryErr := a.interestsByCategory(ctx, sess, listID, interests)
		payload["interests_by_category"] = byCategory
		if categoryErr != nil {
			payload["interests_error"] = categoryErr.Error()
			warnings = append(warnings, categoryErr.Error())
		}
	} else {
		payload["interest_categories_error"] = err.Error()
		warnings = append(warnings, err.Error())
	}
	status := "materialized"
	if len(warnings) > 0 {
		status = "manual_review"
	}
	item := canonical.SourceArchiveItem{
		SourceID:       "list:" + listID,
		ResourceType:   "mailchimp_audience_schema",
		Name:           "Audience schema for " + listID,
		Status:         status,
		Payload:        payload,
		Warnings:       warnings,
		SourcePlatform: canonical.SourceMailchimp,
	}
	next := ""
	if offset+1 < len(listIDs) {
		next = mailchimpArchiveCursor("audience", offset+1)
	} else {
		next = mailchimpArchiveCursor("journeys", 0)
	}
	return []canonical.SourceArchiveItem{item}, next, nil
}

func (a *Adapter) interestsByCategory(ctx context.Context, sess adapter.Session, listID string, categoriesPage map[string]interface{}) (map[string]interface{}, error) {
	items := firstAny(categoriesPage, "categories", "interest_categories")
	categories, _ := items.([]interface{})
	if len(categories) == 0 {
		return nil, nil
	}
	out := map[string]interface{}{}
	var fetchErrors []error
	for _, item := range categories {
		cat, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		categoryID := firstString(cat, "id", "category_id")
		if categoryID == "" {
			continue
		}
		page, err := a.fetchAllMapCollection(ctx, sess, "interests for audience "+listID+" category "+categoryID, func(offset int) string {
			return fmt.Sprintf("/lists/%s/interest-categories/%s/interests?count=%d&offset=%d", listID, categoryID, mailchimpMaxPageSize, offset)
		}, "interests")
		if err == nil && len(page) > 0 {
			out[categoryID] = page
		} else if err != nil {
			fetchErrors = append(fetchErrors, err)
		}
	}
	return out, errors.Join(fetchErrors...)
}

func (a *Adapter) listFormArchive(ctx context.Context, sess adapter.Session, offset int) ([]canonical.SourceArchiveItem, string, error) {
	listIDs, err := a.listAudienceIDs(ctx, sess)
	if err != nil {
		return nil, "", err
	}
	if offset >= len(listIDs) {
		return nil, mailchimpArchiveCursor("landing", 0), nil
	}
	listID := listIDs[offset]
	payload := map[string]interface{}{}
	if err := a.do(ctx, sess, http.MethodGet, fmt.Sprintf("/lists/%s/signup-forms", listID), nil, &payload); err != nil {
		item := parityGap("mailchimp:forms:"+listID, "mailchimp_form", "Signup forms for audience "+listID, "Mailchimp signup form configuration could not be fetched automatically; no form was materialized and the audience requires manual review.", err)
		item.Payload["list_id"] = listID
		next := mailchimpArchiveCursor("landing", 0)
		if offset+1 < len(listIDs) {
			next = mailchimpArchiveCursor("forms", offset+1)
		}
		return []canonical.SourceArchiveItem{item}, next, nil
	}
	if len(payload) == 0 {
		item := parityGap("mailchimp:forms:"+listID, "mailchimp_form", "Signup forms for audience "+listID, "Mailchimp returned an empty signup-form configuration; no form was materialized and the audience requires manual review.", nil)
		item.Payload["list_id"] = listID
		next := mailchimpArchiveCursor("landing", 0)
		if offset+1 < len(listIDs) {
			next = mailchimpArchiveCursor("forms", offset+1)
		}
		return []canonical.SourceArchiveItem{item}, next, nil
	}
	payload["list_id"] = listID
	item := canonical.SourceArchiveItem{
		SourceID:       "list:" + listID,
		ResourceType:   "mailchimp_form",
		Name:           "Signup forms for audience " + listID,
		Status:         "materialized",
		Payload:        payload,
		SourcePlatform: canonical.SourceMailchimp,
	}
	next := ""
	if offset+1 < len(listIDs) {
		next = mailchimpArchiveCursor("forms", offset+1)
	} else {
		next = mailchimpArchiveCursor("landing", 0)
	}
	return []canonical.SourceArchiveItem{item}, next, nil
}

func (a *Adapter) listLandingPageArchive(ctx context.Context, sess adapter.Session, offset int, pageCursor mailchimpPageCursor) ([]canonical.SourceArchiveItem, string, error) {
	selectedIDs := selectedAudienceIDs(sess)
	accountWideWarning := "Mailchimp landing pages are exposed only through an account-wide API and cannot be filtered to the selected audience(s); preserve this object for manual review rather than treating it as audience-scoped."
	var page struct {
		LandingPages []map[string]interface{} `json:"landing_pages"`
		TotalItems   int                      `json:"total_items"`
	}
	if err := a.do(ctx, sess, http.MethodGet, fmt.Sprintf("/landing-pages?count=%d&offset=%d", sourceArchivePageSize, offset), nil, &page); err != nil {
		item := parityGap("mailchimp:landing_pages", "mailchimp_landing_page", "Landing pages", "Landing page inventory could not be fetched automatically; recreate active landing pages in Moosewave.", err)
		markAccountWideSelection(&item, selectedIDs, accountWideWarning)
		return []canonical.SourceArchiveItem{item}, mailchimpArchiveCursor("ecommerce", 0), nil
	}
	if err := validatePageCursor("landing pages", pageCursor, page.LandingPages); err != nil {
		return nil, "", err
	}
	done, err := paginationFinished("landing pages", offset, len(page.LandingPages), page.TotalItems, sourceArchivePageSize)
	if err != nil {
		return nil, "", err
	}
	next := mailchimpArchiveCursor("ecommerce", 0)
	if !done {
		next = encodeMailchimpPageCursor(sourceArchiveCursorResource, "landing", offset+sourceArchivePageSize, page.LandingPages)
	}
	out := make([]canonical.SourceArchiveItem, 0, len(page.LandingPages))
	for i, lp := range page.LandingPages {
		id := stringFromMap(lp, "id")
		if id == "" {
			id = fmt.Sprintf("offset:%d", offset+i)
		}
		name := firstNonEmpty(stringFromMap(lp, "name"), stringFromMap(lp, "title"), "Mailchimp landing page "+id)
		warnings := []string{}
		status := "materialized"
		if err := a.enrichLandingPage(ctx, sess, id, lp); err != nil {
			warnings = append(warnings, err.Error())
			status = "manual_review"
		}
		if len(selectedIDs) > 0 {
			warnings = append(warnings, accountWideWarning)
			status = "manual_review"
			lp["postwave_scope"] = "account_wide"
			lp["selected_audience_ids"] = selectedIDs
		}
		out = append(out, canonical.SourceArchiveItem{
			SourceID:       id,
			ResourceType:   "mailchimp_landing_page",
			Name:           name,
			Status:         status,
			Payload:        lp,
			Warnings:       warnings,
			SourcePlatform: canonical.SourceMailchimp,
		})
	}
	return out, next, nil
}

func (a *Adapter) listEcommerceArchive(ctx context.Context, sess adapter.Session, offset int, pageCursor mailchimpPageCursor) ([]canonical.SourceArchiveItem, string, error) {
	selectedIDs := selectedAudienceIDs(sess)
	accountWideWarning := "Mailchimp ecommerce stores and their customer/product/order/cart records are exposed only through an account-wide API and cannot be filtered to the selected audience(s); preserve this object for manual review rather than treating it as audience-scoped."
	var page struct {
		Stores     []map[string]interface{} `json:"stores"`
		TotalItems int                      `json:"total_items"`
	}
	if err := a.do(ctx, sess, http.MethodGet, fmt.Sprintf("/ecommerce/stores?count=%d&offset=%d", sourceArchivePageSize, offset), nil, &page); err != nil {
		item := parityGap("mailchimp:ecommerce", "mailchimp_ecommerce_store", "Connected store and ecommerce", "Connected store metadata could not be fetched automatically; reconnect products, orders, carts, and revenue attribution through Moosewave commerce integrations.", err)
		markAccountWideSelection(&item, selectedIDs, accountWideWarning)
		return []canonical.SourceArchiveItem{item}, mailchimpArchiveCursor("content", 0), nil
	}
	if err := validatePageCursor("ecommerce stores", pageCursor, page.Stores); err != nil {
		return nil, "", err
	}
	done, err := paginationFinished("ecommerce stores", offset, len(page.Stores), page.TotalItems, sourceArchivePageSize)
	if err != nil {
		return nil, "", err
	}
	next := mailchimpArchiveCursor("content", 0)
	if !done {
		next = encodeMailchimpPageCursor(sourceArchiveCursorResource, "ecommerce", offset+sourceArchivePageSize, page.Stores)
	}
	out := make([]canonical.SourceArchiveItem, 0, len(page.Stores))
	for i, store := range page.Stores {
		id := stringFromMap(store, "id")
		if id == "" {
			id = fmt.Sprintf("offset:%d", offset+i)
		}
		name := firstNonEmpty(stringFromMap(store, "name"), "Mailchimp store "+id)
		warnings := []string{}
		status := "materialized"
		if err := a.enrichEcommerceStore(ctx, sess, id, store); err != nil {
			warnings = append(warnings, err.Error())
			status = "manual_review"
		}
		if len(selectedIDs) > 0 {
			warnings = append(warnings, accountWideWarning)
			status = "manual_review"
			store["postwave_scope"] = "account_wide"
			store["selected_audience_ids"] = selectedIDs
		}
		out = append(out, canonical.SourceArchiveItem{
			SourceID:       id,
			ResourceType:   "mailchimp_ecommerce_store",
			Name:           name,
			Status:         status,
			Payload:        store,
			Warnings:       warnings,
			SourcePlatform: canonical.SourceMailchimp,
		})
	}
	return out, next, nil
}

func markAccountWideSelection(item *canonical.SourceArchiveItem, selectedIDs []string, warning string) {
	if item == nil || len(selectedIDs) == 0 {
		return
	}
	if item.Payload == nil {
		item.Payload = map[string]interface{}{}
	}
	item.Status = "manual_review"
	item.Payload["postwave_scope"] = "account_wide"
	item.Payload["selected_audience_ids"] = selectedIDs
	item.Warnings = append(item.Warnings, warning)
}

func listMailchimpCapabilityGuidance(resource string) ([]canonical.SourceArchiveItem, string, error) {
	for i, task := range mailchimpCapabilityGuidance {
		if task.Cursor != resource {
			continue
		}
		next := ""
		if i+1 < len(mailchimpCapabilityGuidance) {
			next = mailchimpArchiveCursor(mailchimpCapabilityGuidance[i+1].Cursor, 0)
		}
		warning := "Mailchimp's supported Marketing API does not provide account-level inventory sufficient to determine whether this capability is configured. This is foundation guidance, not a detected or imported source object."
		payload := map[string]interface{}{
			"detail":               task.Detail,
			"foundation_guidance":  task.RebuildTask,
			"foundation_artifacts": task.FoundationArtifacts,
			"detected":             false,
			"detection_available":  false,
			"native_status":        "not_detected",
		}
		return []canonical.SourceArchiveItem{{
			SourceID:       "source_archive_warning:" + strings.TrimPrefix(task.SourceID, "mailchimp:"),
			ResourceType:   task.ResourceType,
			Name:           task.Name,
			Status:         "not_detected",
			Payload:        payload,
			Warnings:       []string{warning},
			SourcePlatform: canonical.SourceMailchimp,
		}}, next, nil
	}
	return nil, "", fmt.Errorf("mailchimp: unknown source archive resource %q", resource)
}

func (a *Adapter) enrichLandingPage(ctx context.Context, sess adapter.Session, id string, payload map[string]interface{}) error {
	if id == "" {
		return nil
	}
	var fetchErrors []error
	var detail map[string]interface{}
	if err := a.do(ctx, sess, http.MethodGet, fmt.Sprintf("/landing-pages/%s", id), nil, &detail); err == nil && len(detail) > 0 {
		payload["detail"] = detail
	} else if err != nil {
		fetchErrors = append(fetchErrors, fmt.Errorf("landing page %s detail fetch failed: %w", id, err))
	} else {
		fetchErrors = append(fetchErrors, fmt.Errorf("landing page %s detail response was empty", id))
	}
	var content map[string]interface{}
	if err := a.do(ctx, sess, http.MethodGet, fmt.Sprintf("/landing-pages/%s/content", id), nil, &content); err == nil && len(content) > 0 {
		payload["content"] = content
	} else if err != nil {
		fetchErrors = append(fetchErrors, fmt.Errorf("landing page %s content fetch failed: %w", id, err))
	} else {
		fetchErrors = append(fetchErrors, fmt.Errorf("landing page %s content response was empty", id))
	}
	return errors.Join(fetchErrors...)
}

func (a *Adapter) enrichEcommerceStore(ctx context.Context, sess adapter.Session, id string, payload map[string]interface{}) error {
	if id == "" {
		return nil
	}
	var fetchErrors []error
	for _, key := range []string{"customers", "products", "orders", "carts"} {
		page, err := a.fetchAllMapCollection(ctx, sess, "ecommerce store "+id+" "+key, func(offset int) string {
			return fmt.Sprintf("/ecommerce/stores/%s/%s?count=%d&offset=%d", id, key, mailchimpMaxPageSize, offset)
		}, key, singularCollectionKey(key))
		if err == nil && len(page) > 0 {
			payload[key] = firstAny(page, key, singularCollectionKey(key))
		} else if err != nil {
			fetchErrors = append(fetchErrors, err)
		}
	}
	return errors.Join(fetchErrors...)
}

func parityGap(id, resourceType, name, detail string, err error) canonical.SourceArchiveItem {
	payload := map[string]interface{}{"detail": detail}
	if err != nil {
		payload["error"] = err.Error()
	}
	if !strings.HasPrefix(id, "source_archive_warning:") {
		id = "source_archive_warning:" + strings.TrimPrefix(id, "mailchimp:")
	}
	return canonical.SourceArchiveItem{
		SourceID:       id,
		ResourceType:   resourceType,
		Name:           name,
		Status:         "manual_review",
		Payload:        payload,
		Warnings:       []string{detail},
		SourcePlatform: canonical.SourceMailchimp,
	}
}

func parseMailchimpArchiveCursor(raw string) (string, int, error) {
	resource, offset, _, err := parseMailchimpArchivePageCursor(raw)
	return resource, offset, err
}

func parseMailchimpArchivePageCursor(raw string) (string, int, mailchimpPageCursor, error) {
	if raw == "" {
		cursor := mailchimpPageCursor{Version: 1, Resource: sourceArchiveCursorResource, Scope: "audience"}
		return "audience", 0, cursor, nil
	}
	decoded, encoded, err := decodeMailchimpPageCursor(raw, sourceArchiveCursorResource)
	if err != nil {
		return "", 0, mailchimpPageCursor{}, err
	}
	if encoded {
		if strings.TrimSpace(decoded.Scope) == "" {
			return "", 0, mailchimpPageCursor{}, fmt.Errorf("mailchimp: bad source archive cursor %q", raw)
		}
		return decoded.Scope, decoded.Offset, decoded, nil
	}
	parts := strings.SplitN(raw, ":", 2)
	if len(parts) != 2 {
		return "", 0, mailchimpPageCursor{}, fmt.Errorf("mailchimp: bad source archive cursor %q", raw)
	}
	offset, err := strconv.Atoi(parts[1])
	if err != nil || offset < 0 {
		return "", 0, mailchimpPageCursor{}, fmt.Errorf("mailchimp: bad source archive cursor %q", raw)
	}
	cursor := mailchimpPageCursor{Version: 1, Resource: sourceArchiveCursorResource, Scope: parts[0], Offset: offset}
	return parts[0], offset, cursor, nil
}

func mailchimpArchiveCursor(resource string, offset int) string {
	return fmt.Sprintf("%s:%d", resource, offset)
}

func stringFromMap(m map[string]interface{}, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func singularCollectionKey(key string) string {
	switch key {
	case "customers":
		return "customer"
	case "products":
		return "product"
	case "orders":
		return "order"
	case "carts":
		return "cart"
	default:
		return key
	}
}
