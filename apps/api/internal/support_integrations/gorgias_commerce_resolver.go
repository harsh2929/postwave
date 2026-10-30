// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func (r *Repo) ResolveGorgiasCommerceContext(ctx context.Context, tenantID string, integration Integration, email string, properties map[string]any) (map[string]any, error) {
	props := cloneGorgiasProperties(properties)
	if integration.Provider != ProviderGorgias {
		return props, nil
	}
	commerceIntegrationID := gorgiasCommerceIntegrationID(integration.Settings)
	if commerceIntegrationID == "" || !gorgiasHasCommerceLookupEvidence(props, email) {
		return props, nil
	}
	props["commerce_resolution_target_integration_id"] = commerceIntegrationID
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return props, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	orderCandidates := gorgiasOrderSourceCandidates(props)
	orderID, lineItems, err := resolveGorgiasOrder(ctx, tx, tenantID, commerceIntegrationID, orderCandidates)
	if err != nil {
		return props, err
	}
	if orderID != "" {
		props["resolved_order_id"] = orderID
		props["order_resolution"] = "commerce_orders"
	} else if len(orderCandidates) > 0 {
		props["order_resolution"] = "commerce_orders_lookup_miss"
		props["order_refresh_required"] = true
		props["order_refresh_owner"] = "commerce_integration"
		props["order_refresh_reason"] = "commerce_order_lookup_miss"
		props["order_refresh_candidates"] = orderCandidates
	}

	customerCandidates := gorgiasCustomerSourceCandidates(props)
	customerID, err := resolveGorgiasCustomer(ctx, tx, tenantID, commerceIntegrationID, customerCandidates, email)
	if err != nil {
		return props, err
	}
	if customerID != "" {
		props["resolved_customer_id"] = customerID
		props["customer_resolution"] = "commerce_customers"
	} else if len(customerCandidates) > 0 || (gorgiasCommerceContextPresent(props) && strings.TrimSpace(email) != "") {
		props["customer_resolution"] = "commerce_customers_lookup_miss"
		props["customer_refresh_required"] = true
		props["customer_refresh_owner"] = "commerce_integration"
		props["customer_refresh_reason"] = "commerce_customer_lookup_miss"
		props["customer_refresh_candidates"] = customerCandidates
	}

	productID, productResolution, productCandidates, err := resolveGorgiasProduct(ctx, tx, tenantID, commerceIntegrationID, props, lineItems)
	if err != nil {
		return props, err
	}
	if productID != "" {
		props["resolved_product_id"] = productID
		props["product_resolution"] = productResolution
	} else if len(productCandidates) > 0 {
		props["product_resolution"] = "commerce_products_lookup_miss"
		props["product_refresh_required"] = true
		props["product_refresh_owner"] = "commerce_integration"
		props["product_refresh_reason"] = "commerce_product_lookup_miss"
		props["product_refresh_candidates"] = productCandidates
	}

	return props, tx.Commit(ctx)
}

func resolveGorgiasOrder(ctx context.Context, tx pgx.Tx, tenantID, commerceIntegrationID string, candidates []string) (string, []map[string]any, error) {
	if len(candidates) == 0 {
		return "", nil, nil
	}
	rows, err := tx.Query(ctx, `
	SELECT id::text, COALESCE(line_items, '[]'::jsonb)
	  FROM commerce_orders
	 WHERE tenant_id = $1::uuid
	   AND integration_id::text = $2
	   AND (id::text = ANY($3::text[]) OR source_id = ANY($3::text[]))
	 ORDER BY array_position($3::text[], source_id) NULLS LAST,
	          array_position($3::text[], id::text) NULLS LAST,
	          updated_at DESC
	 LIMIT 2`, tenantID, commerceIntegrationID, candidates)
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()
	orderID := ""
	var lineItems []map[string]any
	seen := map[string]bool{}
	for rows.Next() {
		var id string
		var raw []byte
		if err := rows.Scan(&id, &raw); err != nil {
			return "", nil, err
		}
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		if orderID != "" {
			return "", nil, nil
		}
		orderID = id
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &lineItems)
		}
	}
	if err := rows.Err(); err != nil {
		return "", nil, err
	}
	return orderID, lineItems, nil
}

func resolveGorgiasCustomer(ctx context.Context, tx pgx.Tx, tenantID, commerceIntegrationID string, candidates []string, email string) (string, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if len(candidates) == 0 && email == "" {
		return "", nil
	}
	rows, err := tx.Query(ctx, `
	SELECT id::text
	  FROM commerce_customers
	 WHERE tenant_id = $1::uuid
	   AND integration_id::text = $2
	   AND (
	       id::text = ANY($3::text[])
	       OR source_id = ANY($3::text[])
	       OR ($4 <> '' AND lower(email::text) = $4)
	   )
	 ORDER BY CASE WHEN id::text = ANY($3::text[]) OR source_id = ANY($3::text[]) THEN 0 ELSE 1 END,
	          array_position($3::text[], source_id) NULLS LAST,
	          array_position($3::text[], id::text) NULLS LAST,
	          updated_at DESC
	 LIMIT 2`, tenantID, commerceIntegrationID, candidates, email)
	if err != nil {
		return "", err
	}
	return scanUniqueGorgiasTextID(rows)
}

func resolveGorgiasProduct(ctx context.Context, tx pgx.Tx, tenantID, commerceIntegrationID string, props map[string]any, lineItems []map[string]any) (string, string, []string, error) {
	productRefs := gorgiasProductSourceCandidates(props)
	variantRefs := gorgiasVariantSourceCandidates(props)
	skus := gorgiasProductSKUCandidates(props)
	if len(productRefs) > 0 || len(variantRefs) > 0 || len(skus) > 0 {
		productID, err := resolveGorgiasProductByRefs(ctx, tx, tenantID, commerceIntegrationID, productRefs, variantRefs, skus)
		return productID, "commerce_products", append(append(append([]string{}, productRefs...), variantRefs...), skus...), err
	}
	lineItem, ok := gorgiasOrderLineProductCandidate(lineItems)
	if !ok {
		return "", "", nil, nil
	}
	productRefs = gorgiasOrderLineProductSourceCandidates(lineItem)
	variantRefs = gorgiasOrderLineVariantSourceCandidates(lineItem)
	skus = gorgiasOrderLineSKUCandidates(lineItem)
	if len(productRefs) == 0 && len(variantRefs) == 0 && len(skus) == 0 {
		return "", "", nil, nil
	}
	productID, err := resolveGorgiasProductByRefs(ctx, tx, tenantID, commerceIntegrationID, productRefs, variantRefs, skus)
	return productID, "commerce_order_line_items", append(append(append([]string{}, productRefs...), variantRefs...), skus...), err
}

func resolveGorgiasProductByRefs(ctx context.Context, tx pgx.Tx, tenantID, commerceIntegrationID string, productRefs, variantRefs, skus []string) (string, error) {
	rows, err := tx.Query(ctx, `
	SELECT p.id::text
	  FROM commerce_products p
	  LEFT JOIN commerce_product_variants v
	    ON v.tenant_id = p.tenant_id
	   AND v.integration_id = p.integration_id
	   AND v.product_id = p.id
	 WHERE p.tenant_id = $1::uuid
	   AND p.integration_id::text = $2
	   AND (
	       p.id::text = ANY($3::text[])
	       OR p.source_id = ANY($3::text[])
	       OR v.id::text = ANY($4::text[])
	       OR v.source_id = ANY($4::text[])
	       OR lower(COALESCE(v.sku, '')) = ANY($5::text[])
	   )
	 ORDER BY CASE
	          WHEN p.id::text = ANY($3::text[]) OR p.source_id = ANY($3::text[]) THEN 0
	          WHEN v.id::text = ANY($4::text[]) OR v.source_id = ANY($4::text[]) THEN 1
	          WHEN lower(COALESCE(v.sku, '')) = ANY($5::text[]) THEN 2
	          ELSE 3
	      END,
	      array_position($3::text[], p.source_id) NULLS LAST,
	      array_position($3::text[], p.id::text) NULLS LAST,
	      array_position($4::text[], v.source_id) NULLS LAST,
	      array_position($4::text[], v.id::text) NULLS LAST,
	      p.updated_at DESC
	 LIMIT 20`, tenantID, commerceIntegrationID, productRefs, variantRefs, skus)
	if err != nil {
		return "", err
	}
	return scanUniqueGorgiasTextID(rows)
}

func scanUniqueGorgiasTextID(rows pgx.Rows) (string, error) {
	defer rows.Close()
	seen := map[string]bool{}
	out := ""
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return "", err
		}
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		if out != "" {
			return "", nil
		}
		out = id
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return out, nil
}

func gorgiasCommerceIntegrationID(settings map[string]any) string {
	return strings.TrimSpace(firstString(
		settingString(settings, "commerce_integration_id"),
		settingString(settings, "product_source_integration_id"),
		settingString(settings, "catalog_integration_id"),
		settingString(settings, "shopify_commerce_integration_id"),
	))
}

func gorgiasHasCommerceLookupEvidence(props map[string]any, email string) bool {
	if len(props) == 0 {
		return false
	}
	if gorgiasCommerceContextPresent(props) {
		return true
	}
	return len(gorgiasOrderSourceCandidates(props)) > 0 ||
		len(gorgiasCustomerSourceCandidates(props)) > 0 ||
		len(gorgiasProductSourceCandidates(props)) > 0 ||
		len(gorgiasVariantSourceCandidates(props)) > 0 ||
		len(gorgiasProductSKUCandidates(props)) > 0
}

func gorgiasCommerceContextPresent(props map[string]any) bool {
	return props["gorgias_commerce_context_present"] == true
}

func cloneGorgiasProperties(props map[string]any) map[string]any {
	if props == nil {
		return map[string]any{}
	}
	out := make(map[string]any, len(props)+4)
	for k, v := range props {
		out[k] = v
	}
	return out
}

func gorgiasOrderSourceCandidates(props map[string]any) []string {
	return gorgiasCommerceSourceCandidates(props, []string{
		"shopify_order_id",
		"external_order_id",
		"provider_order_id",
		"source_order_id",
		"order_source_id",
		"order_id",
	}, []string{
		"gid://shopify/Order/",
		"shopify://order/",
		"bigcommerce://order/",
		"woocommerce://order/",
		"square://order/",
		"adobe-commerce://order/",
		"wix://order/",
		"squarespace://order/",
	})
}

func gorgiasCustomerSourceCandidates(props map[string]any) []string {
	return gorgiasCommerceSourceCandidates(props, []string{
		"shopify_customer_id",
		"external_customer_id",
		"provider_customer_id",
		"source_customer_id",
		"customer_source_id",
		"customer_id",
	}, []string{
		"gid://shopify/Customer/",
		"shopify://customer/",
		"bigcommerce://customer/",
		"woocommerce://customer/",
		"square://customer/",
		"adobe-commerce://customer/",
		"wix://customer/",
		"squarespace://customer/",
	})
}

func gorgiasProductSourceCandidates(props map[string]any) []string {
	return gorgiasCommerceSourceCandidates(props, []string{
		"shopify_product_id",
		"external_product_id",
		"provider_product_id",
		"source_product_id",
		"product_source_id",
		"product_id",
		"product_source_candidates",
	}, []string{
		"gid://shopify/Product/",
		"shopify://product/",
		"bigcommerce://product/",
		"woocommerce://product/",
		"square://product/",
		"adobe-commerce://product/",
		"wix://product/",
		"squarespace://product/",
	})
}

func gorgiasVariantSourceCandidates(props map[string]any) []string {
	return gorgiasCommerceSourceCandidates(props, []string{
		"shopify_variant_id",
		"external_variant_id",
		"provider_variant_id",
		"source_variant_id",
		"variant_source_id",
		"variant_id",
		"variation_id",
		"variant_source_candidates",
	}, []string{
		"gid://shopify/ProductVariant/",
		"shopify://variant/",
		"shopify://product_variant/",
		"bigcommerce://product_variant/",
		"woocommerce://variation/",
		"woocommerce://product_variant/",
		"square://variant/",
		"adobe-commerce://variant/",
		"wix://variant/",
		"squarespace://variant/",
	})
}

func gorgiasProductSKUCandidates(props map[string]any) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range gorgiasPropertyValues(props, "sku", "variant_sku", "product_sku", "item_sku", "product_sku_candidates") {
		value = strings.ToLower(strings.TrimSpace(value))
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func gorgiasCommerceSourceCandidates(props map[string]any, keys []string, prefixes []string) []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			return
		}
		seen[value] = true
		out = append(out, value)
	}
	for _, key := range keys {
		for _, value := range gorgiasPropertyValues(props, key) {
			add(value)
		}
	}
	base := append([]string(nil), out...)
	for _, value := range base {
		if strings.Contains(value, "://") {
			continue
		}
		for _, prefix := range prefixes {
			add(prefix + value)
		}
	}
	return out
}

func gorgiasPropertyValues(props map[string]any, keys ...string) []string {
	out := []string{}
	for _, key := range keys {
		value, ok := props[key]
		if !ok || value == nil {
			continue
		}
		switch typed := value.(type) {
		case []string:
			out = append(out, typed...)
		case []any:
			for _, item := range typed {
				if text := gorgiasStringValue(item); text != "" {
					out = append(out, text)
				}
			}
		default:
			if text := gorgiasStringValue(typed); text != "" {
				out = append(out, text)
			}
		}
	}
	return out
}

func gorgiasOrderLineProductCandidate(lineItems []map[string]any) (map[string]any, bool) {
	if len(lineItems) == 1 {
		return lineItems[0], true
	}
	return nil, false
}

func gorgiasOrderLineProductSourceCandidates(lineItem map[string]any) []string {
	return gorgiasCommerceLineSourceCandidates(lineItem, []string{
		"product_id",
		"product_source_id",
		"source_product_id",
		"external_product_id",
		"provider_product_id",
		"catalog_product_id",
		"parent_product_id",
	}, []string{
		"gid://shopify/Product/",
		"shopify://product/",
		"bigcommerce://product/",
		"woocommerce://product/",
		"square://product/",
		"adobe-commerce://product/",
		"wix://product/",
		"squarespace://product/",
	})
}

func gorgiasOrderLineVariantSourceCandidates(lineItem map[string]any) []string {
	return gorgiasCommerceLineSourceCandidates(lineItem, []string{
		"variant_id",
		"variation_id",
		"variant_source_id",
		"source_variant_id",
		"external_variant_id",
		"provider_variant_id",
	}, []string{
		"gid://shopify/ProductVariant/",
		"shopify://variant/",
		"shopify://product_variant/",
		"bigcommerce://product_variant/",
		"woocommerce://variation/",
		"woocommerce://product_variant/",
		"square://variant/",
		"adobe-commerce://variant/",
		"wix://variant/",
		"squarespace://variant/",
	})
}

func gorgiasOrderLineSKUCandidates(lineItem map[string]any) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, key := range []string{"sku", "variant_sku", "product_sku", "item_sku"} {
		value := strings.ToLower(gorgiasLineString(lineItem, key))
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func gorgiasCommerceLineSourceCandidates(lineItem map[string]any, keys []string, prefixes []string) []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			return
		}
		seen[value] = true
		out = append(out, value)
	}
	for _, key := range keys {
		add(gorgiasLineString(lineItem, key))
	}
	base := append([]string(nil), out...)
	for _, value := range base {
		if strings.Contains(value, "://") {
			continue
		}
		for _, prefix := range prefixes {
			add(prefix + value)
		}
	}
	return out
}

func gorgiasLineString(lineItem map[string]any, key string) string {
	if lineItem == nil {
		return ""
	}
	return gorgiasStringValue(lineItem[key])
}

var _ GorgiasCommerceResolver = (*Repo)(nil)
