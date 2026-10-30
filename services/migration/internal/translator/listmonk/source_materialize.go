package listmonk

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/postwave/migrate/canonical"
)

var slugNonWord = regexp.MustCompile(`[^a-z0-9]+`)

func migrationScopeSuffix(jobID string) string {
	jobID = strings.ToLower(strings.TrimSpace(jobID))
	if len(jobID) > 8 {
		jobID = jobID[:8]
	}
	return slugify(jobID)
}

func migrationScopedSlug(slug, jobID, sourceID string) string {
	base := strings.Trim(slugify(slug), "-")
	if base == "" {
		base = "mailchimp"
	}
	jobSuffix := migrationScopeSuffix(jobID)
	sourceSuffix := migrationOwnershipFingerprint("source", sourceID)[:8]
	return base + "-migration-" + jobSuffix + "-source-" + sourceSuffix
}

func migrationScopedDomain(domain, jobID, sourceID string) string {
	jobSuffix := migrationScopeSuffix(jobID)
	sourceSuffix := migrationOwnershipFingerprint("source", sourceID)[:8]
	domain = strings.ToLower(strings.TrimSpace(domain))
	if domain == "" {
		domain = "invalid"
	}
	return "migration-" + jobSuffix + "-source-" + sourceSuffix + "." + domain
}

func materializeSourceArchiveItemTx(ctx context.Context, tx *sql.Tx, tenantID, jobID string, item canonical.SourceArchiveItem) error {
	if item.Status == "manual_review" {
		return nil
	}
	switch item.ResourceType {
	case "mailchimp_customer_journey":
		// The supported Mailchimp Marketing API does not expose a complete
		// Customer Journey graph. Retain only the generic, non-detected parity
		// warning; it is not inventory. Never synthesize a destination automation.
		return nil
	case "mailchimp_form":
		return materializeMailchimpFormTx(ctx, tx, tenantID, jobID, item)
	case "mailchimp_landing_page":
		return materializeMailchimpLandingPageTx(ctx, tx, tenantID, jobID, item)
	case "mailchimp_ecommerce_store":
		return materializeMailchimpCommerceTx(ctx, tx, tenantID, jobID, item)
	default:
		return nil
	}
}

func materializeMailchimpFormTx(ctx context.Context, tx *sql.Tx, tenantID, jobID string, item canonical.SourceArchiveItem) error {
	listID := firstSourceString(item.Payload, "list_id")
	sourceStatus := "draft"
	if formEnabled(item.Payload) {
		sourceStatus = "published"
	}
	status := "draft"
	triggerRaw, _ := json.Marshal(map[string]interface{}{
		"type":            "mailchimp_imported_signup_form",
		"source_platform": item.SourcePlatform,
		"source_id":       item.SourceID,
		"source_status":   sourceStatus,
		"embed_url":       firstSourceString(item.Payload, "embed_url"),
	})
	targetingRaw, _ := json.Marshal(map[string]interface{}{
		"audience_source_id": listID,
		"source_platform":    item.SourcePlatform,
		"source_status":      sourceStatus,
	})
	blocksRaw, _ := json.Marshal([]map[string]interface{}{
		{
			"type":         "signup_form",
			"title":        item.Name,
			"fields":       []string{"email", "first_name", "last_name"},
			"submit_label": "Subscribe",
			"source":       item.Payload,
		},
	})
	sourceName := firstNonEmptyLocal(item.Name, "Mailchimp signup form "+item.SourceID)
	name := migrationScopedSourceName(sourceName, jobID, item.SourceID)
	ownershipFingerprint := migrationResourceOwnershipFingerprint(tenantID, jobID, ResourcePopupForm, item.SourcePlatform, item.SourceID)
	id, exists, err := findOwnedMigrationDestinationTx(
		ctx, tx, tenantID, jobID, ResourcePopupForm, item.SourcePlatform, item.SourceID,
		DestinationPostwavePopupForm, ownershipFingerprint,
	)
	if err != nil {
		return err
	}
	if exists {
		var collisionID string
		collisionErr := tx.QueryRowContext(ctx, `
SELECT id::text FROM popup_forms
 WHERE tenant_id = $1::uuid AND name = $2 AND id <> $3::uuid
 LIMIT 1`, tenantID, name, id).Scan(&collisionID)
		switch collisionErr {
		case nil:
			return fmt.Errorf("update Mailchimp form %q: deterministic name %q is already used by unowned destination %s; refusing retry", item.SourceID, name, collisionID)
		case sql.ErrNoRows:
		default:
			return fmt.Errorf("check Mailchimp form retry collision %q: %w", item.SourceID, collisionErr)
		}
		var updatedID string
		if err := tx.QueryRowContext(ctx, `
UPDATE popup_forms
   SET name = $3,
       status = $4,
       trigger = $5::jsonb,
       targeting = $6::jsonb,
       blocks = $7::jsonb,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
RETURNING id::text`, tenantID, id, name, status, string(triggerRaw), string(targetingRaw), string(blocksRaw)).Scan(&updatedID); err != nil {
			if err == sql.ErrNoRows {
				return fmt.Errorf("tracked Mailchimp form %q points to missing destination %q", item.SourceID, id)
			}
			return fmt.Errorf("update tracked Mailchimp form %q: %w", item.SourceID, err)
		}
		id = updatedID
	} else {
		var collisionID string
		collisionErr := tx.QueryRowContext(ctx, `
SELECT id::text FROM popup_forms
 WHERE tenant_id = $1::uuid AND name = $2
 LIMIT 1`, tenantID, name).Scan(&collisionID)
		switch collisionErr {
		case nil:
			return fmt.Errorf("materialize Mailchimp form %q: deterministic name %q is already used by unowned destination %s; refusing adoption", item.SourceID, name, collisionID)
		case sql.ErrNoRows:
		default:
			return fmt.Errorf("check Mailchimp form collision %q: %w", item.SourceID, collisionErr)
		}
		if err := tx.QueryRowContext(ctx, `
INSERT INTO popup_forms (tenant_id, name, status, trigger, targeting, blocks, metrics)
VALUES ($1::uuid, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, '{}'::jsonb)
RETURNING id::text`, tenantID, name, status, string(triggerRaw), string(targetingRaw), string(blocksRaw)).Scan(&id); err != nil {
			return fmt.Errorf("materialize Mailchimp form %q: %w", item.SourceID, err)
		}
	}
	return recordImportedResourceTx(ctx, tx, ImportedResource{
		TenantID:        tenantID,
		JobID:           jobID,
		ResourceType:    ResourcePopupForm,
		SourcePlatform:  item.SourcePlatform,
		SourceID:        item.SourceID,
		DestinationType: DestinationPostwavePopupForm,
		DestinationID:   id,
		DestinationMetadata: map[string]interface{}{
			"operation":             "created",
			"name":                  name,
			"source_name":           sourceName,
			"list_id":               listID,
			"source_status":         sourceStatus,
			"import_status":         status,
			"ownership_fingerprint": ownershipFingerprint,
		},
	})
}

func materializeMailchimpLandingPageTx(ctx context.Context, tx *sql.Tx, tenantID, jobID string, item canonical.SourceArchiveItem) error {
	sourceStatus := normalizeLandingStatus(firstNonEmptyLocal(firstSourceString(item.Payload, "status"), firstSourceString(nestedMap(item.Payload, "detail"), "status")))
	status := importedLandingStatus(sourceStatus)
	slug := slugify(firstNonEmptyLocal(firstSourceString(item.Payload, "slug"), firstSourceString(item.Payload, "url"), item.Name, item.SourceID))
	if slug == "" {
		slug = "mailchimp-" + slugify(item.SourceID)
	}
	// Landing-page slugs are tenant-unique. Scope the imported draft to the
	// exact job/source identity, including when two source pages share a slug.
	slug = migrationScopedSlug(slug, jobID, item.SourceID)
	sourceName := firstNonEmptyLocal(item.Name, "Mailchimp landing page "+item.SourceID)
	name := migrationScopedSourceName(sourceName, jobID, item.SourceID)
	blocksRaw, _ := json.Marshal(landingBlocks(item))
	seoRaw, _ := json.Marshal(map[string]interface{}{
		"title":           firstNonEmptyLocal(firstSourceString(item.Payload, "title"), item.Name),
		"source_platform": item.SourcePlatform,
		"source_id":       item.SourceID,
		"source_status":   sourceStatus,
	})
	trackingRaw, _ := json.Marshal(map[string]interface{}{
		"source":          item.Payload,
		"source_platform": item.SourcePlatform,
		"source_status":   sourceStatus,
	})
	ownershipFingerprint := migrationResourceOwnershipFingerprint(tenantID, jobID, ResourceLandingPage, item.SourcePlatform, item.SourceID)
	id, exists, err := findOwnedMigrationDestinationTx(
		ctx, tx, tenantID, jobID, ResourceLandingPage, item.SourcePlatform, item.SourceID,
		DestinationPostwaveLandingPage, ownershipFingerprint,
	)
	if err != nil {
		return err
	}
	if exists {
		var updatedID string
		if err := tx.QueryRowContext(ctx, `
UPDATE landing_pages
   SET slug = $3,
       name = $4,
       status = $5,
       domain = NULLIF($6, ''),
       template = 'mailchimp_imported',
       blocks = $7::jsonb,
       seo = $8::jsonb,
       tracking = $9::jsonb,
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
RETURNING id::text`, tenantID, id, slug, name, status, landingDomain(item.Payload), string(blocksRaw), string(seoRaw), string(trackingRaw)).Scan(&updatedID); err != nil {
			if err == sql.ErrNoRows {
				return fmt.Errorf("tracked Mailchimp landing page %q points to missing destination %q", item.SourceID, id)
			}
			return fmt.Errorf("update tracked Mailchimp landing page %q: %w", item.SourceID, err)
		}
		id = updatedID
	} else {
		var collisionID string
		collisionErr := tx.QueryRowContext(ctx, `
SELECT id::text FROM landing_pages
 WHERE tenant_id = $1::uuid AND slug = $2
 LIMIT 1`, tenantID, slug).Scan(&collisionID)
		switch collisionErr {
		case nil:
			return fmt.Errorf("materialize Mailchimp landing page %q: deterministic slug %q is already used by unowned destination %s; refusing adoption", item.SourceID, slug, collisionID)
		case sql.ErrNoRows:
		default:
			return fmt.Errorf("check Mailchimp landing-page collision %q: %w", item.SourceID, collisionErr)
		}
		if err := tx.QueryRowContext(ctx, `
INSERT INTO landing_pages (tenant_id, slug, name, status, domain, template, blocks, seo, tracking)
VALUES ($1::uuid, $2, $3, $4, NULLIF($5, ''), 'mailchimp_imported', $6::jsonb, $7::jsonb, $8::jsonb)
RETURNING id::text`, tenantID, slug, name, status, landingDomain(item.Payload), string(blocksRaw), string(seoRaw), string(trackingRaw)).Scan(&id); err != nil {
			return fmt.Errorf("materialize Mailchimp landing page %q: refusing to adopt or overwrite a pre-existing slug: %w", item.SourceID, err)
		}
	}
	return recordImportedResourceTx(ctx, tx, ImportedResource{
		TenantID:        tenantID,
		JobID:           jobID,
		ResourceType:    ResourceLandingPage,
		SourcePlatform:  item.SourcePlatform,
		SourceID:        item.SourceID,
		DestinationType: DestinationPostwaveLandingPage,
		DestinationID:   id,
		DestinationMetadata: map[string]interface{}{
			"operation":             "created",
			"name":                  name,
			"source_name":           sourceName,
			"slug":                  slug,
			"source_status":         sourceStatus,
			"import_status":         status,
			"ownership_fingerprint": ownershipFingerprint,
		},
	})
}

func materializeMailchimpCommerceTx(ctx context.Context, tx *sql.Tx, tenantID, jobID string, item canonical.SourceArchiveItem) error {
	provider := normalizeCommerceProvider(firstNonEmptyLocal(firstSourceString(item.Payload, "platform"), firstSourceString(item.Payload, "store_type")))
	sourceShopDomain := firstNonEmptyLocal(firstSourceString(item.Payload, "domain"), firstSourceString(item.Payload, "list_id"), importedStoreDomain(item))
	// commerce_integrations is unique on provider/domain. Use a job-and-source-
	// scoped paused identity so duplicate source display/domain values remain
	// distinct and can never target a live integration.
	shopDomain := migrationScopedDomain(sourceShopDomain, jobID, item.SourceID)
	settingsRaw, _ := json.Marshal(map[string]interface{}{
		"source_platform": item.SourcePlatform,
		"source_id":       item.SourceID,
		"source_status":   firstNonEmptyLocal(firstSourceString(item.Payload, "status"), "connected"),
		"import_status":   "paused",
		"raw":             item.Payload,
	})
	ownershipFingerprint := migrationResourceOwnershipFingerprint(tenantID, jobID, ResourceCommerceIntegration, item.SourcePlatform, item.SourceID)
	integrationID, exists, err := findOwnedMigrationDestinationTx(
		ctx, tx, tenantID, jobID, ResourceCommerceIntegration, item.SourcePlatform, item.SourceID,
		DestinationPostwaveCommerceIntegration, ownershipFingerprint,
	)
	if err != nil {
		return err
	}
	if exists {
		var updatedID string
		if err := tx.QueryRowContext(ctx, `
UPDATE commerce_integrations
   SET provider = $3,
       shop_domain = $4,
       status = 'paused',
       scopes = ARRAY['mailchimp_import']::text[],
       settings = commerce_integrations.settings || $5::jsonb,
       last_sync_at = now(),
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid
RETURNING id::text`, tenantID, integrationID, provider, shopDomain, string(settingsRaw)).Scan(&updatedID); err != nil {
			if err == sql.ErrNoRows {
				return fmt.Errorf("tracked Mailchimp store %q points to missing destination %q", item.SourceID, integrationID)
			}
			return fmt.Errorf("update tracked Mailchimp store %q: %w", item.SourceID, err)
		}
		integrationID = updatedID
	} else {
		var collisionID string
		collisionErr := tx.QueryRowContext(ctx, `
SELECT id::text FROM commerce_integrations
 WHERE tenant_id = $1::uuid AND provider = $2 AND shop_domain = $3
 LIMIT 1`, tenantID, provider, shopDomain).Scan(&collisionID)
		switch collisionErr {
		case nil:
			return fmt.Errorf("materialize Mailchimp store %q: deterministic provider/domain %s/%s is already used by unowned destination %s; refusing adoption", item.SourceID, provider, shopDomain, collisionID)
		case sql.ErrNoRows:
		default:
			return fmt.Errorf("check Mailchimp store collision %q: %w", item.SourceID, collisionErr)
		}
		if err := tx.QueryRowContext(ctx, `
INSERT INTO commerce_integrations (tenant_id, provider, shop_domain, status, scopes, settings, last_sync_at)
VALUES ($1::uuid, $2, $3, 'paused', ARRAY['mailchimp_import']::text[], $4::jsonb, now())
RETURNING id::text`, tenantID, provider, shopDomain, string(settingsRaw)).Scan(&integrationID); err != nil {
			return fmt.Errorf("materialize Mailchimp store %q: refusing to adopt or overwrite a pre-existing integration: %w", item.SourceID, err)
		}
	}
	if err := recordImportedResourceTx(ctx, tx, ImportedResource{
		TenantID:        tenantID,
		JobID:           jobID,
		ResourceType:    ResourceCommerceIntegration,
		SourcePlatform:  item.SourcePlatform,
		SourceID:        item.SourceID,
		DestinationType: DestinationPostwaveCommerceIntegration,
		DestinationID:   integrationID,
		DestinationMetadata: map[string]interface{}{
			"operation":             "created",
			"name":                  item.Name,
			"provider":              provider,
			"shop_domain":           shopDomain,
			"source_shop_domain":    sourceShopDomain,
			"source_status":         firstNonEmptyLocal(firstSourceString(item.Payload, "status"), "connected"),
			"import_status":         "paused",
			"ownership_fingerprint": ownershipFingerprint,
		},
	}); err != nil {
		return err
	}
	if err := upsertMailchimpCustomersTx(ctx, tx, tenantID, integrationID, item.Payload); err != nil {
		return err
	}
	if err := upsertMailchimpProductsTx(ctx, tx, tenantID, integrationID, item.Payload); err != nil {
		return err
	}
	if err := upsertMailchimpOrdersTx(ctx, tx, tenantID, integrationID, item.Payload, "orders", "paid"); err != nil {
		return err
	}
	if err := upsertMailchimpOrdersTx(ctx, tx, tenantID, integrationID, item.Payload, "carts", "cart"); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO commerce_events (tenant_id, integration_id, event_type, metadata, provider_event_id, provider_topic)
VALUES ($1::uuid, $2::uuid, 'sync_completed', $3::jsonb, $4, 'mailchimp.import')
ON CONFLICT (tenant_id, integration_id, provider_event_id) WHERE provider_event_id IS NOT NULL DO NOTHING`,
		tenantID, integrationID, string(settingsRaw), "mailchimp-store-sync:"+item.SourceID); err != nil {
		return fmt.Errorf("materialize Mailchimp store %q sync event: %w", item.SourceID, err)
	}
	return nil
}

func upsertMailchimpCustomersTx(ctx context.Context, tx *sql.Tx, tenantID, integrationID string, payload map[string]interface{}) error {
	for _, item := range arrayFromPayload(payload, "customers") {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		sourceID := firstNonEmptyLocal(firstSourceString(m, "id", "customer_id"), firstSourceString(m, "email_address", "email"))
		if sourceID == "" {
			continue
		}
		raw, _ := json.Marshal(m)
		_, err := tx.ExecContext(ctx, `
INSERT INTO commerce_customers (tenant_id, integration_id, source_id, email, first_name, last_name, accepts_marketing, tags, raw)
VALUES ($1::uuid, $2::uuid, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7, '{}'::text[], $8::jsonb)
ON CONFLICT (tenant_id, integration_id, source_id) DO UPDATE SET
  email = EXCLUDED.email,
  first_name = EXCLUDED.first_name,
  last_name = EXCLUDED.last_name,
  accepts_marketing = EXCLUDED.accepts_marketing,
  raw = EXCLUDED.raw,
  updated_at = now()`,
			tenantID, integrationID, sourceID, firstSourceString(m, "email_address", "email"), firstSourceString(m, "first_name", "firstName"), firstSourceString(m, "last_name", "lastName"), boolFromAny(m["opt_in_status"]) || boolFromAny(m["accepts_marketing"]), string(raw))
		if err != nil {
			return fmt.Errorf("materialize Mailchimp ecommerce customer %q: %w", sourceID, err)
		}
	}
	return nil
}

func upsertMailchimpProductsTx(ctx context.Context, tx *sql.Tx, tenantID, integrationID string, payload map[string]interface{}) error {
	for _, item := range arrayFromPayload(payload, "products") {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		sourceID := firstNonEmptyLocal(firstSourceString(m, "id", "product_id"), firstSourceString(m, "handle", "title"))
		if sourceID == "" {
			continue
		}
		raw, _ := json.Marshal(m)
		_, err := tx.ExecContext(ctx, `
INSERT INTO commerce_products (tenant_id, integration_id, source_id, title, url, image_url, price_cents, currency, raw)
VALUES ($1::uuid, $2::uuid, $3, $4, NULLIF($5, ''), NULLIF($6, ''), $7, $8, $9::jsonb)
ON CONFLICT (tenant_id, integration_id, source_id) DO UPDATE SET
  title = EXCLUDED.title,
  url = EXCLUDED.url,
  image_url = EXCLUDED.image_url,
  price_cents = EXCLUDED.price_cents,
  currency = EXCLUDED.currency,
  raw = EXCLUDED.raw,
  updated_at = now()`,
			tenantID, integrationID, sourceID, firstNonEmptyLocal(firstSourceString(m, "title", "name"), sourceID), firstSourceString(m, "url", "handle"), firstSourceString(m, "image_url", "image_url_full"), centsFromAny(firstAnyLocal(m, "price", "price_cents")), firstNonEmptyLocal(firstSourceString(m, "currency_code", "currency"), "USD"), string(raw))
		if err != nil {
			return fmt.Errorf("materialize Mailchimp ecommerce product %q: %w", sourceID, err)
		}
	}
	return nil
}

func upsertMailchimpOrdersTx(ctx context.Context, tx *sql.Tx, tenantID, integrationID string, payload map[string]interface{}, key, fallbackStatus string) error {
	for _, item := range arrayFromPayload(payload, key) {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		sourceID := firstNonEmptyLocal(firstSourceString(m, "id", "order_id", "cart_id"), stableFromParts(firstSourceString(m, "email", "customer_email"), firstSourceString(m, "processed_at", "created_at")))
		if sourceID == "" {
			continue
		}
		status := normalizeOrderStatus(firstNonEmptyLocal(firstSourceString(m, "financial_status", "status"), fallbackStatus))
		total := centsFromAny(firstAnyLocal(m, "order_total", "total", "total_price", "checkout_total"))
		subtotal := centsFromAny(firstAnyLocal(m, "subtotal_price", "subtotal", "order_total", "total"))
		attribution, _ := json.Marshal(map[string]interface{}{
			"source":             "mailchimp_import",
			"campaign_source_id": firstSourceString(m, "campaign_id", "outreach_id"),
			"landing_site":       firstSourceString(m, "landing_site", "referring_site"),
			"raw":                m,
		})
		lines, _ := json.Marshal(firstAnyLocal(m, "lines", "line_items", "products"))
		raw, _ := json.Marshal(m)
		orderedAt := timeFromAny(firstAnyLocal(m, "processed_at_foreign", "processed_at", "created_at", "updated_at"))
		_, err := tx.ExecContext(ctx, `
INSERT INTO commerce_orders (
  tenant_id, integration_id, source_id, customer_email, status, subtotal_cents,
  discount_cents, shipping_cents, tax_cents, total_cents, currency, attribution,
  line_items, ordered_at, raw
)
VALUES ($1::uuid, $2::uuid, $3, NULLIF($4, ''), $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15::jsonb)
ON CONFLICT (tenant_id, integration_id, source_id) DO UPDATE SET
  customer_email = EXCLUDED.customer_email,
  status = EXCLUDED.status,
  subtotal_cents = EXCLUDED.subtotal_cents,
  discount_cents = EXCLUDED.discount_cents,
  shipping_cents = EXCLUDED.shipping_cents,
  tax_cents = EXCLUDED.tax_cents,
  total_cents = EXCLUDED.total_cents,
  currency = EXCLUDED.currency,
  attribution = EXCLUDED.attribution,
  line_items = EXCLUDED.line_items,
  ordered_at = EXCLUDED.ordered_at,
  raw = EXCLUDED.raw,
  updated_at = now()`,
			tenantID, integrationID, sourceID, firstSourceString(m, "email", "customer_email"), status, subtotal,
			centsFromAny(firstAnyLocal(m, "discount_total", "discount_cents")),
			centsFromAny(firstAnyLocal(m, "shipping_total", "shipping_cents")),
			centsFromAny(firstAnyLocal(m, "tax_total", "tax_cents")),
			total, firstNonEmptyLocal(firstSourceString(m, "currency_code", "currency"), "USD"), string(attribution), string(lines), orderedAt, string(raw))
		if err != nil {
			return fmt.Errorf("materialize Mailchimp ecommerce order/cart %q: %w", sourceID, err)
		}
	}
	return nil
}

func existingImportedDestinationTx(ctx context.Context, tx *sql.Tx, tenantID, jobID, resourceType, sourceID string) (string, error) {
	var id string
	err := tx.QueryRowContext(ctx, `
SELECT destination_id
  FROM migration_imported_resources
 WHERE tenant_id = $1::uuid
   AND job_id = $2::uuid
   AND resource_type = $3
   AND COALESCE(source_id, '') = $4
   AND rolled_back_at IS NULL
 LIMIT 1`, tenantID, jobID, resourceType, sourceID).Scan(&id)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return id, err
}

func formEnabled(payload map[string]interface{}) bool {
	for _, item := range arrayFromPayload(payload, "forms") {
		m, ok := item.(map[string]interface{})
		if ok && boolFromAny(m["enabled"]) {
			return true
		}
	}
	return firstSourceString(payload, "embed_url", "hosted_url") != ""
}

func landingBlocks(item canonical.SourceArchiveItem) []map[string]interface{} {
	content := nestedMap(item.Payload, "content")
	html := firstSourceString(content, "html", "body_html")
	if html == "" {
		html = firstSourceString(item.Payload, "html", "body_html")
	}
	return []map[string]interface{}{
		{"type": "hero", "heading": item.Name, "body": firstSourceString(item.Payload, "description", "title")},
		{"type": "html", "html": html, "source": "mailchimp"},
	}
}

func landingDomain(payload map[string]interface{}) string {
	rawURL := firstSourceString(payload, "url", "published_url")
	u, err := url.Parse(rawURL)
	if err == nil && u.Host != "" {
		return u.Host
	}
	return firstSourceString(payload, "domain")
}

func normalizeLandingStatus(status string) string {
	switch strings.ToLower(status) {
	case "published", "active":
		return "published"
	case "archived", "deleted":
		return "archived"
	default:
		return "draft"
	}
}

func importedLandingStatus(sourceStatus string) string {
	if sourceStatus == "archived" {
		return "archived"
	}
	return "draft"
}

func normalizeCommerceProvider(provider string) string {
	switch strings.ToLower(provider) {
	case "woocommerce", "stripe", "square", "shopify":
		return strings.ToLower(provider)
	default:
		return "shopify"
	}
}

func normalizeOrderStatus(status string) string {
	switch strings.ToLower(status) {
	case "cart":
		return "cart"
	case "refunded":
		return "refunded"
	case "cancelled", "canceled":
		return "cancelled"
	case "pending":
		return "pending"
	default:
		return "paid"
	}
}

func importedStoreDomain(item canonical.SourceArchiveItem) string {
	slug := slugify(firstNonEmptyLocal(item.Name, item.SourceID))
	if slug == "" {
		slug = "store"
	}
	return slug + ".mailchimp-import.local"
}

func slugify(in string) string {
	in = strings.ToLower(strings.TrimSpace(in))
	in = strings.TrimPrefix(in, "https://")
	in = strings.TrimPrefix(in, "http://")
	in = strings.Trim(in, "/")
	in = slugNonWord.ReplaceAllString(in, "-")
	in = strings.Trim(in, "-")
	if len(in) > 80 {
		in = strings.Trim(in[:80], "-")
	}
	return in
}

func arrayFromPayload(payload map[string]interface{}, key string) []interface{} {
	if raw, ok := payload[key].([]interface{}); ok {
		return raw
	}
	if page, ok := payload[key+"_page"].(map[string]interface{}); ok {
		if raw, ok := page[key].([]interface{}); ok {
			return raw
		}
	}
	return nil
}

func nestedMap(payload map[string]interface{}, key string) map[string]interface{} {
	if m, ok := payload[key].(map[string]interface{}); ok {
		return m
	}
	return nil
}

func firstSourceString(m map[string]interface{}, keys ...string) string {
	for _, key := range keys {
		switch v := m[key].(type) {
		case string:
			if strings.TrimSpace(v) != "" {
				return v
			}
		case float64:
			return fmt.Sprintf("%.0f", v)
		case int:
			return fmt.Sprintf("%d", v)
		case json.Number:
			return v.String()
		}
	}
	return ""
}

func firstAnyLocal(m map[string]interface{}, keys ...string) interface{} {
	for _, key := range keys {
		if v, ok := m[key]; ok {
			return v
		}
	}
	return nil
}

func firstNonEmptyLocal(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func boolFromAny(v interface{}) bool {
	switch b := v.(type) {
	case bool:
		return b
	case string:
		return strings.EqualFold(b, "true") || strings.EqualFold(b, "subscribed")
	default:
		return false
	}
}

func centsFromAny(v interface{}) int {
	switch n := v.(type) {
	case int:
		return n
	case int64:
		return int(n)
	case float64:
		if n > 100000 {
			return int(n)
		}
		return int(n * 100)
	case json.Number:
		f, _ := n.Float64()
		if f > 100000 {
			return int(f)
		}
		return int(f * 100)
	case string:
		var f float64
		_, _ = fmt.Sscanf(n, "%f", &f)
		if f > 100000 {
			return int(f)
		}
		return int(f * 100)
	default:
		return 0
	}
}

func timeFromAny(v interface{}) time.Time {
	switch t := v.(type) {
	case time.Time:
		return t
	case string:
		for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05"} {
			if parsed, err := time.Parse(layout, t); err == nil {
				return parsed
			}
		}
	}
	return time.Now().UTC()
}

func stableFromParts(parts ...string) string {
	return slugify(strings.Join(parts, "-"))
}
