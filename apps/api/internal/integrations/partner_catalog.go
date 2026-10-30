// SPDX-License-Identifier: AGPL-3.0-only
package integrations

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type partnerCatalogInput struct {
	AppID                string
	AppType              string
	Distribution         string
	AppStatus            string
	AppScopes            []string
	WebhookTopics        []string
	Description          string
	Slug                 string
	Name                 string
	Category             string
	Summary              string
	DocsURL              string
	SupportURL           string
	PartnerLevel         string
	PartnerProfileStatus string
	Tags                 []string
	Metadata             map[string]any
}

func (h *handler) catalogItemsForRequest(rctx context.Context, tenantID string) []CatalogItem {
	items := CatalogItems()
	if h == nil || h.pool == nil || strings.TrimSpace(tenantID) == "" {
		return items
	}
	partnerItems, err := h.partnerCatalogItems(rctx, tenantID)
	if err != nil {
		if h.logger != nil {
			h.logger.Debug("integrations partner catalog overlay failed", "err", err)
		}
		return items
	}
	return mergeCatalogItems(items, partnerItems)
}

func (h *handler) catalogItemsForHTTPRequest(rctx context.Context) []CatalogItem {
	tenant, ok := middleware.TenantFromContext(rctx)
	if !ok || tenant.ID == "" {
		return CatalogItems()
	}
	return h.catalogItemsForRequest(rctx, tenant.ID)
}

func (h *handler) catalogItemBySlugForRequest(rctx context.Context, slug string) (CatalogItem, bool) {
	slug = strings.TrimSpace(slug)
	if item, ok := CatalogItemBySlug(slug); ok {
		return item, true
	}
	for _, item := range h.catalogItemsForHTTPRequest(rctx) {
		if item.Slug == slug {
			return item, true
		}
	}
	return CatalogItem{}, false
}

func (h *handler) partnerCatalogItems(ctx context.Context, tenantID string) ([]CatalogItem, error) {
	tx, err := db.WithTenant(ctx, h.pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
SELECT a.id::text, a.app_type, a.distribution, a.status, a.scopes,
       a.webhook_topics, a.description, l.slug::text, l.name, l.category,
       l.summary, l.docs_url, l.support_url,
       COALESCE(NULLIF(l.partner_level, ''), p.certification_level),
       p.status, l.tags, l.metadata
  FROM app_listings l
  JOIN developer_apps a ON a.id = l.app_id
  JOIN partner_program_profiles p ON p.tenant_id = a.tenant_id
   AND p.status = 'certified'
 WHERE l.status = 'published'
   AND l.review_state = 'approved'
   AND a.distribution IN ('marketplace', 'partner_catalog')
   AND a.status IN ('approved', 'active')
 ORDER BY l.updated_at DESC
 LIMIT 500`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []CatalogItem{}
	for rows.Next() {
		var in partnerCatalogInput
		var meta []byte
		if err := rows.Scan(
			&in.AppID,
			&in.AppType,
			&in.Distribution,
			&in.AppStatus,
			&in.AppScopes,
			&in.WebhookTopics,
			&in.Description,
			&in.Slug,
			&in.Name,
			&in.Category,
			&in.Summary,
			&in.DocsURL,
			&in.SupportURL,
			&in.PartnerLevel,
			&in.PartnerProfileStatus,
			&in.Tags,
			&meta,
		); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(meta, &in.Metadata)
		if item, ok := catalogItemFromPartnerListing(in); ok {
			out = append(out, item)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func catalogItemFromPartnerListing(in partnerCatalogInput) (CatalogItem, bool) {
	if !partnerListingIsPublic(in) {
		return CatalogItem{}, false
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		return CatalogItem{}, false
	}
	slug := slugify(defaultString(in.Slug, name))
	if slug == "" {
		return CatalogItem{}, false
	}
	caps := partnerCapabilities(in)
	if len(caps) == 0 {
		caps = []Capability{CapabilityProfiles, CapabilityEvents}
	}
	sources := []string{"developer_marketplace", "partner_catalog", "app_listing"}
	if strings.TrimSpace(in.AppType) == "public" {
		sources = append(sources, "oauth_app")
	}
	if len(cleanPartnerStrings(in.WebhookTopics)) > 0 {
		sources = append(sources, "app_webhooks")
	}
	item := CatalogItem{
		Slug:          slug,
		Name:          name,
		Category:      partnerCategory(in.Category),
		Badge:         BadgePartner,
		RuntimeStatus: RuntimeDelegated,
		Summary:       partnerSummary(in),
		Capabilities:  caps,
		DocsURL:       firstNonEmpty(in.DocsURL, in.SupportURL),
		Native:        false,
		Featured:      false,
		Phase:         "partner",
		Sources:       uniqueStrings(sources),
	}
	decorateCatalogItem(&item)
	return item, true
}

func partnerListingIsPublic(in partnerCatalogInput) bool {
	if strings.TrimSpace(in.AppStatus) != "approved" && strings.TrimSpace(in.AppStatus) != "active" {
		return false
	}
	if strings.TrimSpace(in.PartnerProfileStatus) != "certified" {
		return false
	}
	distribution := strings.TrimSpace(in.Distribution)
	return distribution == "marketplace" || distribution == "partner_catalog"
}

func mergeCatalogItems(base, extra []CatalogItem) []CatalogItem {
	out := append([]CatalogItem(nil), base...)
	seen := map[string]struct{}{}
	for _, item := range out {
		seen[item.Slug] = struct{}{}
	}
	for _, item := range extra {
		item.Slug = strings.TrimSpace(item.Slug)
		if item.Slug == "" {
			continue
		}
		if _, exists := seen[item.Slug]; exists {
			continue
		}
		seen[item.Slug] = struct{}{}
		out = append(out, item)
	}
	return out
}

func partnerCapabilities(in partnerCatalogInput) []Capability {
	out := []Capability{}
	out = append(out, capabilitiesFromMetadata(in.Metadata)...)
	for _, value := range in.Tags {
		out = append(out, capabilityFromPartnerText(value)...)
	}
	for _, value := range in.AppScopes {
		out = append(out, capabilityFromPartnerText(value)...)
	}
	for _, value := range in.WebhookTopics {
		out = append(out, capabilityFromPartnerText(value)...)
	}
	return uniqueCapabilities(out)
}

func capabilitiesFromMetadata(meta map[string]any) []Capability {
	if meta == nil {
		return nil
	}
	raw, ok := meta["capabilities"]
	if !ok {
		return nil
	}
	values := []string{}
	switch v := raw.(type) {
	case []any:
		for _, item := range v {
			values = append(values, fmt.Sprint(item))
		}
	case []string:
		values = append(values, v...)
	case string:
		values = strings.FieldsFunc(v, func(r rune) bool {
			return r == ',' || r == ' ' || r == ';'
		})
	}
	out := []Capability{}
	for _, value := range values {
		out = append(out, capabilityFromPartnerText(value)...)
	}
	return out
}

func capabilityFromPartnerText(value string) []Capability {
	key := strings.ReplaceAll(slugify(value), "-", "_")
	switch {
	case strings.Contains(key, "subscriber") || strings.Contains(key, "profile") || strings.Contains(key, "contact") || strings.Contains(key, "customer"):
		return []Capability{CapabilityProfiles}
	case strings.Contains(key, "list"):
		return []Capability{CapabilityLists}
	case strings.Contains(key, "segment"):
		return []Capability{CapabilitySegments}
	case strings.Contains(key, "event") || strings.Contains(key, "track") || strings.Contains(key, "campaign"):
		return []Capability{CapabilityEvents}
	case strings.Contains(key, "automation") || strings.Contains(key, "trigger") || strings.Contains(key, "form"):
		return []Capability{CapabilityAutomationTriggers}
	case strings.Contains(key, "order"):
		return []Capability{CapabilityOrders}
	case strings.Contains(key, "product"):
		return []Capability{CapabilityProducts}
	case strings.Contains(key, "commerce") || strings.Contains(key, "cart") || strings.Contains(key, "checkout"):
		return []Capability{CapabilityCommerce}
	case strings.Contains(key, "review"):
		return []Capability{CapabilityReviews}
	case strings.Contains(key, "subscription") || strings.Contains(key, "shipment") || strings.Contains(key, "shipping"):
		return []Capability{CapabilitySubscriptions}
	case strings.Contains(key, "support") || strings.Contains(key, "ticket") || strings.Contains(key, "conversation") || strings.Contains(key, "helpdesk"):
		return []Capability{CapabilitySupport}
	case strings.Contains(key, "audience") || strings.Contains(key, "ads"):
		return []Capability{CapabilityAdsAudiences}
	case strings.Contains(key, "warehouse") || strings.Contains(key, "export"):
		return []Capability{CapabilityWarehouseExport}
	case strings.Contains(key, "import"):
		return []Capability{CapabilityWarehouseImport}
	default:
		return nil
	}
}

func partnerCategory(raw string) string {
	key := strings.ReplaceAll(slugify(raw), "-", "_")
	aliases := map[string]string{
		"e_commerce":       "ecommerce",
		"customer_support": "customer_service",
		"support":          "customer_service",
		"helpdesk":         "customer_service",
		"developer":        "developer_tools",
		"developers":       "developer_tools",
		"api":              "developer_tools",
		"email":            "sending",
		"email_sending":    "sending",
	}
	if alias, ok := aliases[key]; ok {
		key = alias
	}
	for _, category := range Categories() {
		if category.Key == key {
			return key
		}
	}
	return "developer_tools"
}

// partnerSummary is the sentence a prospect reads on a partner listing.
//
// The partner writes it; Moosewave serves it, under Moosewave's catalog, styled
// identically to the connectors Moosewave built and certified. A reader has no
// way to tell the authorship apart, so the honesty rule that applies to our own
// claims has to apply here too — and it applies MORE, because this is the text
// we control least.
//
// An overclaiming summary is REPLACED, not rejected. Dropping the listing would
// hide a real integration over a wording problem, punishing the customer for
// the partner's marketing; the neutral fallback keeps the integration
// discoverable and simply declines to repeat the claim.
func partnerSummary(in partnerCatalogInput) string {
	for _, candidate := range []string{in.Summary, in.Description} {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" {
			continue
		}
		// Partner listings are served as RuntimeDelegated: Moosewave routes to
		// this integration rather than running it, so a completeness claim is a
		// claim about somebody else's software that we cannot stand behind.
		if !ClaimIsHonest(RuntimeDelegated, candidate) {
			continue
		}
		return candidate
	}
	return neutralPartnerSummary(in.Name)
}

func neutralPartnerSummary(name string) string {
	return "Partner marketplace integration for " + strings.TrimSpace(name) + "."
}

func uniqueCapabilities(values []Capability) []Capability {
	seen := map[Capability]struct{}{}
	out := []Capability{}
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func cleanPartnerStrings(values []string) []string {
	out := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			out = append(out, value)
		}
	}
	return out
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}
