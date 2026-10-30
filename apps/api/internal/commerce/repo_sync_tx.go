// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/conversions"
)

// Transaction-scoped write helpers behind Sync, Upsert* and Delete*: customer,
// product, variant, inventory, price history, order and provider event rows.

func upsertCustomer(ctx context.Context, tx pgx.Tx, tenantID, integrationID string, in CustomerInput) error {
	raw, _ := json.Marshal(nonNilMap(in.Raw))
	_, err := tx.Exec(ctx, `
	INSERT INTO commerce_customers (
	    tenant_id, integration_id, source_id, email, first_name, last_name,
	    accepts_marketing, tags, raw
	)
	VALUES ($1::uuid, $2::uuid, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7, $8, $9::jsonb)
	ON CONFLICT (tenant_id, integration_id, source_id) DO UPDATE SET
	  email = EXCLUDED.email,
	  first_name = EXCLUDED.first_name,
	  last_name = EXCLUDED.last_name,
	  accepts_marketing = EXCLUDED.accepts_marketing,
	  tags = EXCLUDED.tags,
	  raw = EXCLUDED.raw,
	  updated_at = now()`,
		tenantID, integrationID, in.SourceID, in.Email, in.FirstName, in.LastName,
		in.AcceptsMarketing, in.Tags, string(raw))
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
	INSERT INTO commerce_events (tenant_id, integration_id, event_type, customer_email, metadata, provider_event_id)
	VALUES ($1::uuid, $2::uuid, 'customer_created', NULLIF($3, ''), $4::jsonb, NULLIF($5, ''))
	ON CONFLICT (tenant_id, integration_id, provider_event_id)
	WHERE provider_event_id IS NOT NULL
	DO NOTHING`,
		tenantID, integrationID, in.Email, string(raw), "customer:"+in.SourceID)
	return err
}

func upsertProduct(ctx context.Context, tx pgx.Tx, tenantID, integrationID string, in ProductInput) (string, error) {
	raw, _ := json.Marshal(nonNilMap(in.Raw))
	var productID string
	err := tx.QueryRow(ctx, `
	INSERT INTO commerce_products (
	    tenant_id, integration_id, source_id, title, url, image_url, price_cents, currency, raw
	)
	VALUES ($1::uuid, $2::uuid, $3, $4, NULLIF($5, ''), NULLIF($6, ''), $7, $8, $9::jsonb)
	ON CONFLICT (tenant_id, integration_id, source_id) DO UPDATE SET
	  title = EXCLUDED.title,
	  url = EXCLUDED.url,
	  image_url = EXCLUDED.image_url,
	  price_cents = EXCLUDED.price_cents,
	  currency = EXCLUDED.currency,
	  raw = EXCLUDED.raw,
	  updated_at = now()
	RETURNING id::text`,
		tenantID, integrationID, in.SourceID, in.Title, in.URL, in.ImageURL,
		in.PriceCents, defaulted(in.Currency, "USD"), string(raw)).Scan(&productID)
	if err != nil {
		return "", err
	}
	if err := materializeProductLifecycle(ctx, tx, tenantID, integrationID, productID, in); err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `
	INSERT INTO commerce_events (tenant_id, integration_id, event_type, metadata, provider_event_id)
	VALUES ($1::uuid, $2::uuid, 'product_created', $3::jsonb, NULLIF($4, ''))
	ON CONFLICT (tenant_id, integration_id, provider_event_id)
	WHERE provider_event_id IS NOT NULL
	DO NOTHING`,
		tenantID, integrationID, string(raw), "product:"+in.SourceID)
	if err != nil {
		return "", err
	}
	return productID, nil
}

func materializeProductLifecycle(ctx context.Context, tx pgx.Tx, tenantID, integrationID, productID string, in ProductInput) error {
	variantMaps := productVariantMaps(in)
	for _, variant := range variantMaps {
		variantID, err := upsertProductVariant(ctx, tx, tenantID, integrationID, productID, in, variant)
		if err != nil {
			return err
		}
		if err := insertPriceHistory(ctx, tx, tenantID, integrationID, productID, variantID, in, variant); err != nil {
			return err
		}
		if err := insertInventorySnapshot(ctx, tx, tenantID, integrationID, productID, variantID, variant); err != nil {
			return err
		}
	}
	return nil
}

func productVariantMaps(in ProductInput) []map[string]any {
	variants, _ := in.Raw["variants"].([]any)
	out := make([]map[string]any, 0, len(variants))
	for _, item := range variants {
		variant, _ := item.(map[string]any)
		if variant != nil {
			out = append(out, variant)
		}
	}
	if len(out) > 0 {
		return out
	}
	return []map[string]any{{
		"id":                 in.SourceID,
		"title":              in.Title,
		"price":              float64(in.PriceCents) / 100,
		"inventory_policy":   "unknown",
		"inventory_quantity": nil,
	}}
}

func upsertProductVariant(ctx context.Context, tx pgx.Tx, tenantID, integrationID, productID string, in ProductInput, variant map[string]any) (string, error) {
	sourceID := sourceID(variant)
	if sourceID == "" {
		sourceID = in.SourceID
	}
	priceCents := cents(firstNonNil(variant["price"], float64(in.PriceCents)/100))
	compareAt := nullableCents(variant["compare_at_price"])
	inventoryQuantity := nullableInt(variant["inventory_quantity"])
	inventoryPolicy := normalizeInventoryPolicy(stringField(variant, "inventory_policy"))
	available := variantAvailable(inventoryQuantity, inventoryPolicy)
	imageURL := firstNonEmpty(stringField(variant, "image_url"), stringField(mapField(variant, "image"), "src"), in.ImageURL)
	variantURL := firstNonEmpty(stringField(variant, "url"), stringField(variant, "permalink"), in.URL)
	optionValues, _ := json.Marshal(variantOptionValues(variant))
	raw, _ := json.Marshal(nonNilMap(variant))
	var variantID string
	err := tx.QueryRow(ctx, `
INSERT INTO commerce_product_variants (
    tenant_id, integration_id, product_id, source_id, sku, title, option_values,
    price_cents, compare_at_price_cents, currency, inventory_quantity,
    inventory_policy, available, image_url, url, raw
)
VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, NULLIF($5, ''), NULLIF($6, ''), $7::jsonb,
    $8, $9, $10, $11, $12, $13, NULLIF($14, ''), NULLIF($15, ''), $16::jsonb
)
ON CONFLICT (tenant_id, integration_id, source_id) DO UPDATE SET
  product_id = EXCLUDED.product_id,
  sku = EXCLUDED.sku,
  title = EXCLUDED.title,
  option_values = EXCLUDED.option_values,
  price_cents = EXCLUDED.price_cents,
  compare_at_price_cents = EXCLUDED.compare_at_price_cents,
  currency = EXCLUDED.currency,
  inventory_quantity = EXCLUDED.inventory_quantity,
  inventory_policy = EXCLUDED.inventory_policy,
  available = EXCLUDED.available,
  image_url = EXCLUDED.image_url,
  url = EXCLUDED.url,
  raw = EXCLUDED.raw,
  updated_at = now()
RETURNING id::text`,
		tenantID, integrationID, productID, sourceID, stringField(variant, "sku"),
		defaulted(stringField(variant, "title"), in.Title), string(optionValues),
		priceCents, compareAt, defaulted(in.Currency, "USD"), inventoryQuantity,
		inventoryPolicy, available, imageURL, variantURL, string(raw)).Scan(&variantID)
	return variantID, err
}

func insertPriceHistory(ctx context.Context, tx pgx.Tx, tenantID, integrationID, productID, variantID string, in ProductInput, variant map[string]any) error {
	priceCents := cents(firstNonNil(variant["price"], float64(in.PriceCents)/100))
	compareAt := nullableCents(variant["compare_at_price"])
	raw, _ := json.Marshal(map[string]any{
		"source":     "product_sync",
		"source_id":  sourceID(variant),
		"product_id": in.SourceID,
	})
	_, err := tx.Exec(ctx, `
INSERT INTO commerce_price_history (
    tenant_id, integration_id, product_id, variant_id, price_cents,
    compare_at_price_cents, currency, metadata
)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::jsonb)`,
		tenantID, integrationID, productID, variantID, priceCents, compareAt,
		defaulted(in.Currency, "USD"), string(raw))
	return err
}

func insertInventorySnapshot(ctx context.Context, tx pgx.Tx, tenantID, integrationID, productID, variantID string, variant map[string]any) error {
	inventoryQuantity := nullableInt(variant["inventory_quantity"])
	inventoryPolicy := normalizeInventoryPolicy(stringField(variant, "inventory_policy"))
	available := variantAvailable(inventoryQuantity, inventoryPolicy)
	raw, _ := json.Marshal(map[string]any{
		"source":    "product_sync",
		"source_id": sourceID(variant),
	})
	_, err := tx.Exec(ctx, `
INSERT INTO commerce_inventory_snapshots (
    tenant_id, integration_id, product_id, variant_id, quantity,
    available, inventory_policy, metadata
)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8::jsonb)`,
		tenantID, integrationID, productID, variantID, inventoryQuantity,
		available, inventoryPolicy, string(raw))
	return err
}

func variantOptionValues(variant map[string]any) map[string]any {
	out := map[string]any{}
	for _, key := range []string{"option1", "option2", "option3"} {
		if value := strings.TrimSpace(fmt.Sprint(variant[key])); value != "" && value != "<nil>" {
			out[key] = value
		}
	}
	for _, item := range rawArray(variant["attributes"]) {
		attribute, _ := item.(map[string]any)
		if attribute == nil {
			continue
		}
		name := firstNonEmpty(stringField(attribute, "name"), stringField(attribute, "slug"))
		option := stringField(attribute, "option")
		if name != "" && option != "" {
			out[name] = option
		}
	}
	return out
}

func nullableCents(v any) any {
	if v == nil {
		return nil
	}
	raw := strings.TrimSpace(fmt.Sprint(v))
	if raw == "" || raw == "<nil>" {
		return nil
	}
	return cents(v)
}

func nullableInt(v any) any {
	if v == nil {
		return nil
	}
	raw := strings.TrimSpace(fmt.Sprint(v))
	if raw == "" || raw == "<nil>" {
		return nil
	}
	return intField(map[string]any{"v": v}, "v")
}

func normalizeInventoryPolicy(policy string) string {
	switch strings.ToLower(strings.TrimSpace(policy)) {
	case "deny":
		return "deny"
	case "continue":
		return "continue"
	default:
		return "unknown"
	}
}

func variantAvailable(quantity any, policy string) bool {
	if policy == "continue" {
		return true
	}
	if quantity == nil {
		return true
	}
	n, ok := quantity.(int)
	return ok && n > 0
}

func upsertOrder(ctx context.Context, tx pgx.Tx, tenantID, integrationID string, in OrderInput) error {
	at := in.OrderedAt
	if at == nil {
		now := time.Now().UTC()
		at = &now
	}
	attribution, _ := json.Marshal(nonNilMap(in.Attribution))
	lineItems, _ := json.Marshal(nonNilSliceMap(in.LineItems))
	raw, _ := json.Marshal(nonNilMap(in.Raw))
	_, err := tx.Exec(ctx, `
	INSERT INTO commerce_orders (
	    tenant_id, integration_id, source_id, customer_email, status,
	    subtotal_cents, discount_cents, shipping_cents, tax_cents, total_cents,
	    currency, campaign_id, attribution, line_items, ordered_at, raw
	)
	VALUES (
	    $1::uuid, $2::uuid, $3, NULLIF($4, ''), $5,
	    $6, $7, $8, $9, $10, $11, NULLIF($12, '')::uuid, $13::jsonb, $14::jsonb, $15, $16::jsonb
	)
	ON CONFLICT (tenant_id, integration_id, source_id) DO UPDATE SET
	  customer_email = EXCLUDED.customer_email,
	  status = EXCLUDED.status,
	  subtotal_cents = EXCLUDED.subtotal_cents,
	  discount_cents = EXCLUDED.discount_cents,
	  shipping_cents = EXCLUDED.shipping_cents,
	  tax_cents = EXCLUDED.tax_cents,
	  total_cents = EXCLUDED.total_cents,
	  currency = EXCLUDED.currency,
	  campaign_id = EXCLUDED.campaign_id,
	  attribution = EXCLUDED.attribution,
	  line_items = EXCLUDED.line_items,
	  ordered_at = EXCLUDED.ordered_at,
	  raw = EXCLUDED.raw,
	  updated_at = now()`,
		tenantID, integrationID, in.SourceID, in.CustomerEmail, defaulted(in.Status, "paid"),
		in.SubtotalCents, in.DiscountCents, in.ShippingCents, in.TaxCents,
		in.TotalCents, defaulted(in.Currency, "USD"), in.CampaignID, string(attribution),
		string(lineItems), at, string(raw))
	if err != nil {
		return err
	}
	status := defaulted(in.Status, "paid")

	// Revenue. This is the seam that connects commerce to the conversion
	// ledger, and its absence is why a refund and the conversion it reverses
	// shared no identifier for as long as both existed.
	//
	// Inside THIS tx on purpose: an order that committed while its revenue did
	// not would be money that silently never happened, and they are one fact.
	if status == "paid" || status == "refunded" {
		var orderUUID string
		if err := tx.QueryRow(ctx, `
SELECT id::text FROM commerce_orders
 WHERE tenant_id = $1::uuid AND integration_id = $2::uuid AND source_id = $3`,
			tenantID, integrationID, in.SourceID).Scan(&orderUUID); err != nil {
			return err
		}
		if err := conversions.RecordCommerceOrder(ctx, tx, tenantID, conversions.CommerceOrderConversion{
			OrderID:     orderUUID,
			Email:       in.CustomerEmail,
			AmountCents: int64(in.TotalCents),
			Currency:    defaulted(in.Currency, "USD"),
			OccurredAt:  *at,
			CampaignID:  in.CampaignID,
		}); err != nil {
			return err
		}
		if status == "refunded" {
			// A status of 'refunded' says the money went back; it does not say
			// how much or under which provider refund id. Providers that send a
			// discrete refund event carry both and reverse precisely — this is
			// the coarse path for the ones that only flip a status, so the
			// reversal is recorded for the full total and keyed on the order,
			// which keeps a re-synced order from reversing twice.
			if _, err := conversions.RecordReversal(ctx, tx, tenantID, conversions.Reversal{
				OrderID:     orderUUID,
				Kind:        "refund",
				AmountCents: int64(in.TotalCents),
				Currency:    defaulted(in.Currency, "USD"),
				OccurredAt:  *at,
			}); err != nil {
				return err
			}
		}
	}

	eventType := "order_created"
	if status == "refunded" {
		eventType = "order_refunded"
	}
	if status == "pending" {
		eventType = "cart_abandoned"
	}
	_, err = tx.Exec(ctx, `
	INSERT INTO commerce_events (tenant_id, integration_id, event_type, customer_email, metadata, provider_event_id, provider_topic)
	VALUES ($1::uuid, $2::uuid, $3, NULLIF($4, ''), $5::jsonb, NULLIF($6, ''), NULLIF($7, ''))
	ON CONFLICT (tenant_id, integration_id, provider_event_id)
	WHERE provider_event_id IS NOT NULL
	DO NOTHING`,
		tenantID, integrationID, eventType, in.CustomerEmail, string(raw), "order:"+in.SourceID, fmt.Sprint(in.Attribution["source"]))
	return err
}

func deleteCustomer(ctx context.Context, tx pgx.Tx, tenantID, integrationID string, in ProviderDeletion) error {
	if strings.TrimSpace(in.SourceID) == "" {
		return fmt.Errorf("commerce customer delete requires source_id")
	}
	var email string
	err := tx.QueryRow(ctx, `
DELETE FROM commerce_customers
 WHERE tenant_id = $1::uuid
   AND integration_id::text = $2
   AND source_id = $3
 RETURNING COALESCE(email::text, '')`, tenantID, integrationID, in.SourceID).Scan(&email)
	deleted := true
	if errors.Is(err, pgx.ErrNoRows) {
		deleted = false
		err = nil
	}
	if err != nil {
		return err
	}
	return insertProviderDeletionEvent(ctx, tx, tenantID, integrationID, "customer_deleted", email, "customer", in, deleted)
}

func deleteProduct(ctx context.Context, tx pgx.Tx, tenantID, integrationID string, in ProviderDeletion) error {
	if strings.TrimSpace(in.SourceID) == "" {
		return fmt.Errorf("commerce product delete requires source_id")
	}
	var title string
	err := tx.QueryRow(ctx, `
DELETE FROM commerce_products
 WHERE tenant_id = $1::uuid
   AND integration_id::text = $2
   AND source_id = $3
 RETURNING title`, tenantID, integrationID, in.SourceID).Scan(&title)
	deleted := true
	if errors.Is(err, pgx.ErrNoRows) {
		deleted = false
		err = nil
	}
	if err != nil {
		return err
	}
	raw := nonNilMap(in.Raw)
	if strings.TrimSpace(title) != "" {
		raw["deleted_title"] = title
	}
	in.Raw = raw
	return insertProviderDeletionEvent(ctx, tx, tenantID, integrationID, "product_deleted", "", "product", in, deleted)
}

func deleteOrder(ctx context.Context, tx pgx.Tx, tenantID, integrationID string, in ProviderDeletion) error {
	if strings.TrimSpace(in.SourceID) == "" {
		return fmt.Errorf("commerce order delete requires source_id")
	}
	var email string
	err := tx.QueryRow(ctx, `
DELETE FROM commerce_orders
 WHERE tenant_id = $1::uuid
   AND integration_id::text = $2
   AND source_id = $3
 RETURNING COALESCE(customer_email::text, '')`, tenantID, integrationID, in.SourceID).Scan(&email)
	deleted := true
	if errors.Is(err, pgx.ErrNoRows) {
		deleted = false
		err = nil
	}
	if err != nil {
		return err
	}
	return insertProviderDeletionEvent(ctx, tx, tenantID, integrationID, "order_deleted", email, "order", in, deleted)
}

func recordProviderEvent(ctx context.Context, tx pgx.Tx, tenantID, integrationID string, in ProviderEventInput) error {
	if strings.TrimSpace(in.EventType) == "" {
		return fmt.Errorf("commerce provider event requires event_type")
	}
	metadata := nonNilMap(in.Metadata)
	if strings.TrimSpace(in.Provider) != "" {
		metadata["source"] = strings.TrimSpace(in.Provider)
	}
	if strings.TrimSpace(in.Topic) != "" {
		metadata["topic"] = strings.TrimSpace(in.Topic)
	}
	if strings.TrimSpace(in.SourceID) != "" {
		metadata["source_id"] = strings.TrimSpace(in.SourceID)
	}
	raw, err := json.Marshal(metadata)
	if err != nil {
		return err
	}
	providerEventID := strings.TrimSpace(in.ProviderEventID)
	if providerEventID == "" && strings.TrimSpace(in.SourceID) != "" {
		providerEventID = strings.TrimSpace(in.EventType) + ":" + strings.TrimSpace(in.SourceID)
	}
	_, err = tx.Exec(ctx, `
INSERT INTO commerce_events (tenant_id, integration_id, event_type, customer_email, metadata, provider_event_id, provider_topic)
VALUES ($1::uuid, $2::uuid, $3, NULLIF($4, ''), $5::jsonb, NULLIF($6, ''), NULLIF($7, ''))
ON CONFLICT (tenant_id, integration_id, provider_event_id)
WHERE provider_event_id IS NOT NULL
DO NOTHING`,
		tenantID, integrationID, strings.TrimSpace(in.EventType), strings.TrimSpace(in.CustomerEmail), string(raw), providerEventID, strings.TrimSpace(in.Topic))
	if err != nil {
		return err
	}
	// Refunds and disputes reverse the revenue they belong to. Recorded in the
	// same tx as the event, so an event that lands without its reversal is not
	// a state this table can reach.
	return resolveReversal(ctx, tx, tenantID, integrationID, in)
}

func insertProviderDeletionEvent(ctx context.Context, tx pgx.Tx, tenantID, integrationID, eventType, customerEmail, object string, in ProviderDeletion, deleted bool) error {
	metadata, err := json.Marshal(map[string]any{
		"source":       firstNonEmpty(in.Provider, "commerce_provider"),
		"topic":        in.Topic,
		"object":       object,
		"source_id":    in.SourceID,
		"row_deleted":  deleted,
		"provider_raw": nonNilMap(in.Raw),
	})
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
INSERT INTO commerce_events (tenant_id, integration_id, event_type, customer_email, metadata, provider_event_id, provider_topic)
VALUES ($1::uuid, $2::uuid, $3, NULLIF($4, ''), $5::jsonb, NULLIF($6, ''), NULLIF($7, ''))
ON CONFLICT (tenant_id, integration_id, provider_event_id)
WHERE provider_event_id IS NOT NULL
DO NOTHING`,
		tenantID, integrationID, eventType, customerEmail, string(metadata), object+"_deleted:"+in.SourceID, in.Topic)
	return err
}
