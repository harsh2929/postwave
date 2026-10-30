// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Provider webhook claims and provider compliance callbacks: webhook dedupe
// claims, uninstall handling and Shopify GDPR redaction and data-request
// bundles.

func (r *Repo) ClaimWebhook(ctx context.Context, tenantID, integrationID, provider, webhookID, topic string, body []byte) (WebhookClaim, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sum := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(sum[:])
	tag, err := tx.Exec(ctx, `
	INSERT INTO commerce_webhook_events (
	    tenant_id, integration_id, provider, webhook_id, topic, body_sha256, status, attempts
	)
	VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 'in_progress', 1)
	ON CONFLICT (provider, webhook_id) DO NOTHING`,
		tenantID, integrationID, provider, webhookID, topic, bodyHash)
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() == 1 {
		return WebhookClaimed, tx.Commit(ctx)
	}
	var status string
	if err := tx.QueryRow(ctx, `
	SELECT status
	  FROM commerce_webhook_events
	 WHERE provider = $1 AND webhook_id = $2`, provider, webhookID).Scan(&status); err != nil {
		return "", err
	}
	if status == "processed" {
		return WebhookProcessed, tx.Commit(ctx)
	}
	if status == "failed" {
		if _, err := tx.Exec(ctx, `
		UPDATE commerce_webhook_events
		   SET status = 'in_progress',
		       topic = $3,
		       body_sha256 = $4,
		       attempts = attempts + 1,
		       last_error = NULL,
		       updated_at = now()
		 WHERE provider = $1 AND webhook_id = $2`, provider, webhookID, topic, bodyHash); err != nil {
			return "", err
		}
		return WebhookClaimed, tx.Commit(ctx)
	}
	return WebhookInProgress, tx.Commit(ctx)
}

func (r *Repo) MarkWebhookProcessed(ctx context.Context, tenantID, provider, webhookID string) error {
	return r.markWebhook(ctx, tenantID, provider, webhookID, "processed", "")
}

func (r *Repo) MarkWebhookFailed(ctx context.Context, tenantID, provider, webhookID string, err error) error {
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	return r.markWebhook(ctx, tenantID, provider, webhookID, "failed", msg)
}

func (r *Repo) markWebhook(ctx context.Context, tenantID, provider, webhookID, status, msg string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
	UPDATE commerce_webhook_events
	   SET status = $3,
	       last_error = NULLIF($4, ''),
	       processed_at = CASE WHEN $3 = 'processed' THEN now() ELSE processed_at END,
	       updated_at = now()
	 WHERE provider = $1 AND webhook_id = $2`, provider, webhookID, status, msg)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) MarkShopifyUninstalled(ctx context.Context, tenantID, integrationID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
	UPDATE commerce_integrations
	   SET status = 'needs_auth',
	       error_message = 'shopify app uninstalled',
	       updated_at = now()
	 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, integrationID)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) MarkWixStoresUninstalled(ctx context.Context, tenantID, integrationID string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
	UPDATE commerce_integrations
	   SET status = 'needs_auth',
	       settings = settings || jsonb_build_object(
	           'wix_app_instance_status', 'removed',
	           'wix_app_instance_removed_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
	       ),
	       error_message = 'wix app removed',
	       updated_at = now()
	 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, integrationID)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) RedactShopifyCustomer(ctx context.Context, tenantID, integrationID string, redaction ShopifyCustomerRedaction) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureIntegration(ctx, tx, tenantID, integrationID); err != nil {
		return err
	}
	customerIDs := compactStrings(redaction.CustomerSourceIDs)
	emails := compactStrings(redaction.Emails)
	orderIDs := compactStrings(redaction.OrderSourceIDs)
	if len(customerIDs) == 0 && len(emails) == 0 && len(orderIDs) == 0 {
		return tx.Commit(ctx)
	}
	customerTag, err := tx.Exec(ctx, `
DELETE FROM commerce_customers
 WHERE tenant_id = $1::uuid
   AND integration_id::text = $2
   AND (
        source_id = ANY($3::text[])
        OR lower(email::text) = ANY($4::text[])
   )`, tenantID, integrationID, customerIDs, emails)
	if err != nil {
		return err
	}
	orderTag, err := tx.Exec(ctx, `
UPDATE commerce_orders
   SET customer_email = NULL,
       raw = raw - 'email' - 'customer' - 'billing_address' - 'shipping_address',
       updated_at = now()
 WHERE tenant_id = $1::uuid
   AND integration_id::text = $2
   AND (
        source_id = ANY($3::text[])
        OR lower(customer_email::text) = ANY($4::text[])
   )`, tenantID, integrationID, orderIDs, emails)
	if err != nil {
		return err
	}
	meta, _ := json.Marshal(map[string]any{
		"source":              "shopify_privacy_webhook",
		"reason":              defaulted(redaction.Reason, "shopify_customers_redact"),
		"customers_redacted":  customerTag.RowsAffected(),
		"orders_redacted":     orderTag.RowsAffected(),
		"customer_id_matches": len(customerIDs),
		"order_id_matches":    len(orderIDs),
	})
	if _, err := tx.Exec(ctx, `
INSERT INTO commerce_events (tenant_id, integration_id, event_type, metadata, provider_event_id, provider_topic)
VALUES ($1::uuid, $2::uuid, 'shopify_customer_redacted', $3::jsonb, NULLIF($4, ''), 'customers/redact')
ON CONFLICT (tenant_id, integration_id, provider_event_id)
WHERE provider_event_id IS NOT NULL
DO NOTHING`,
		tenantID, integrationID, string(meta), "shopify-redact:"+strings.Join(customerIDs, ",")); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (r *Repo) CollectShopifyCustomerDataRequest(ctx context.Context, tenantID, integrationID string, request ShopifyCustomerDataRequest, generatedAt time.Time) (*ShopifyCustomerDataRequestBundle, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := ensureIntegration(ctx, tx, tenantID, integrationID); err != nil {
		return nil, err
	}
	customerIDs := compactStrings(request.CustomerSourceIDs)
	emails := compactStrings(request.Emails)
	orderIDs := compactStrings(request.OrderSourceIDs)
	if generatedAt.IsZero() {
		generatedAt = time.Now().UTC()
	}
	var shopDomain string
	if err := tx.QueryRow(ctx, `
SELECT COALESCE(shop_domain, '')
  FROM commerce_integrations
 WHERE tenant_id = $1::uuid AND id::text = $2`, tenantID, integrationID).Scan(&shopDomain); err != nil {
		return nil, err
	}
	customerRows, err := tx.Query(ctx, `
SELECT id::text, source_id, COALESCE(email::text, ''), COALESCE(first_name, ''),
       COALESCE(last_name, ''), accepts_marketing, tags, raw, created_at, updated_at
  FROM commerce_customers
 WHERE tenant_id = $1::uuid
   AND integration_id::text = $2
   AND (
        source_id = ANY($3::text[])
        OR lower(email::text) = ANY($4::text[])
   )
 ORDER BY updated_at DESC`, tenantID, integrationID, customerIDs, emails)
	if err != nil {
		return nil, err
	}
	customers, err := scanCustomers(customerRows)
	if err != nil {
		return nil, err
	}
	orderRows, err := tx.Query(ctx, `
SELECT id::text, source_id, COALESCE(customer_email::text, ''), status,
       subtotal_cents, discount_cents, shipping_cents, tax_cents, total_cents,
       currency, COALESCE(campaign_id::text, ''), attribution, line_items, ordered_at,
       raw, created_at, updated_at
  FROM commerce_orders
 WHERE tenant_id = $1::uuid
   AND integration_id::text = $2
   AND (
        source_id = ANY($3::text[])
        OR lower(customer_email::text) = ANY($4::text[])
   )
 ORDER BY ordered_at DESC`, tenantID, integrationID, orderIDs, emails)
	if err != nil {
		return nil, err
	}
	orders, err := scanOrders(orderRows)
	if err != nil {
		return nil, err
	}
	bundle := &ShopifyCustomerDataRequestBundle{
		RequestID:         strings.TrimSpace(request.RequestID),
		IntegrationID:     integrationID,
		ShopDomain:        shopDomain,
		CustomerSourceIDs: customerIDs,
		Emails:            emails,
		OrderSourceIDs:    orderIDs,
		Customers:         customers,
		Orders:            orders,
		GeneratedAt:       generatedAt.UTC(),
	}
	meta, _ := json.Marshal(map[string]any{
		"source":              "shopify_privacy_webhook",
		"reason":              defaulted(request.Reason, "shopify_customers_data_request"),
		"request_id":          bundle.RequestID,
		"customers_matched":   len(customers),
		"orders_matched":      len(orders),
		"customer_id_matches": len(customerIDs),
		"order_id_matches":    len(orderIDs),
		"email_matches":       len(emails),
		"generated_at":        bundle.GeneratedAt.Format(time.RFC3339),
	})
	providerEventID := ""
	if bundle.RequestID != "" {
		providerEventID = "shopify-data-request:" + bundle.RequestID
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO commerce_events (tenant_id, integration_id, event_type, customer_email, metadata, provider_event_id, provider_topic)
VALUES ($1::uuid, $2::uuid, 'shopify_customer_data_requested', NULLIF($3, ''), $4::jsonb, NULLIF($5, ''), 'customers/data_request')
ON CONFLICT (tenant_id, integration_id, provider_event_id)
WHERE provider_event_id IS NOT NULL
DO NOTHING`,
		tenantID, integrationID, firstString(emails...), string(meta), providerEventID); err != nil {
		return nil, err
	}
	return bundle, tx.Commit(ctx)
}
