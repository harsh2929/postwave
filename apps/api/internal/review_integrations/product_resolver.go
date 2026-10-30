// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type ReviewProductResolver interface {
	ResolveReviewProductID(ctx context.Context, tenantID string, integration Integration, review ReviewInput) (string, error)
}

type ReviewOrderResolver interface {
	ResolveReviewOrderID(ctx context.Context, tenantID string, integration Integration, review ReviewInput) (string, error)
}

type ReviewOrderLineProductResolver interface {
	ResolveReviewProductIDFromOrderLine(ctx context.Context, tenantID string, integration Integration, review ReviewInput) (string, error)
}

type ReviewCustomerResolver interface {
	ResolveReviewCustomerID(ctx context.Context, tenantID string, integration Integration, review ReviewInput) (string, error)
}

func (r *Repo) ResolveReviewProductID(ctx context.Context, tenantID string, integration Integration, review ReviewInput) (string, error) {
	if review.ProductID != "" {
		return "", nil
	}
	commerceIntegrationID := reviewCommerceIntegrationID(integration.Settings)
	if commerceIntegrationID == "" {
		return "", nil
	}
	candidates := reviewProductSourceCandidates(review)
	if len(candidates) == 0 {
		return "", nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text
  FROM commerce_products
 WHERE tenant_id = $1::uuid
   AND integration_id::text = $2
   AND (id::text = ANY($3::text[]) OR source_id = ANY($3::text[]))
ORDER BY array_position($3::text[], source_id) NULLS LAST,
          array_position($3::text[], id::text) NULLS LAST,
          updated_at DESC
 LIMIT 2`, tenantID, commerceIntegrationID, candidates)
	if err != nil {
		return "", err
	}
	productID, err := scanUniqueTextID(rows)
	if err != nil {
		return "", err
	}
	return productID, tx.Commit(ctx)
}

func (r *Repo) ResolveReviewProductIDFromOrderLine(ctx context.Context, tenantID string, integration Integration, review ReviewInput) (string, error) {
	if review.ProductID != "" || strings.TrimSpace(review.OrderID) == "" {
		return "", nil
	}
	commerceIntegrationID := reviewCommerceIntegrationID(integration.Settings)
	if commerceIntegrationID == "" {
		return "", nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var lineItemsRaw []byte
	err = tx.QueryRow(ctx, `
	SELECT COALESCE(line_items, '[]'::jsonb)
	  FROM commerce_orders
	 WHERE tenant_id = $1::uuid
	   AND integration_id::text = $2
	   AND (id::text = $3 OR source_id = $3)
	 LIMIT 1`, tenantID, commerceIntegrationID, strings.TrimSpace(review.OrderID)).Scan(&lineItemsRaw)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", tx.Commit(ctx)
	}
	if err != nil {
		return "", err
	}
	var lineItems []map[string]any
	if len(lineItemsRaw) > 0 {
		if err := json.Unmarshal(lineItemsRaw, &lineItems); err != nil {
			return "", err
		}
	}
	lineItem, ok := reviewOrderLineProductCandidate(review, lineItems)
	if !ok {
		return "", tx.Commit(ctx)
	}
	productRefs := reviewOrderLineProductSourceCandidates(lineItem)
	variantRefs := reviewOrderLineVariantSourceCandidates(lineItem)
	skus := reviewOrderLineSKUCandidates(lineItem)
	if len(productRefs) == 0 && len(variantRefs) == 0 && len(skus) == 0 {
		return "", tx.Commit(ctx)
	}
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
	productID, err := scanUniqueTextID(rows)
	if err != nil {
		return "", err
	}
	return productID, tx.Commit(ctx)
}

func (r *Repo) ResolveReviewOrderID(ctx context.Context, tenantID string, integration Integration, review ReviewInput) (string, error) {
	if review.OrderID != "" {
		return "", nil
	}
	commerceIntegrationID := reviewCommerceIntegrationID(integration.Settings)
	if commerceIntegrationID == "" {
		return "", nil
	}
	candidates := reviewOrderSourceCandidates(review)
	if len(candidates) == 0 {
		return "", nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT id::text
  FROM commerce_orders
 WHERE tenant_id = $1::uuid
   AND integration_id::text = $2
   AND (id::text = ANY($3::text[]) OR source_id = ANY($3::text[]))
ORDER BY array_position($3::text[], source_id) NULLS LAST,
          array_position($3::text[], id::text) NULLS LAST,
          updated_at DESC
 LIMIT 2`, tenantID, commerceIntegrationID, candidates)
	if err != nil {
		return "", err
	}
	orderID, err := scanUniqueTextID(rows)
	if err != nil {
		return "", err
	}
	return orderID, tx.Commit(ctx)
}

func (r *Repo) ResolveReviewCustomerID(ctx context.Context, tenantID string, integration Integration, review ReviewInput) (string, error) {
	if review.CustomerID != "" {
		return "", nil
	}
	commerceIntegrationID := reviewCommerceIntegrationID(integration.Settings)
	if commerceIntegrationID == "" {
		return "", nil
	}
	candidates := reviewCustomerSourceCandidates(review)
	email := strings.ToLower(strings.TrimSpace(review.ReviewerEmail))
	if len(candidates) == 0 && email == "" {
		return "", nil
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
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
	customerID, err := scanUniqueTextID(rows)
	if err != nil {
		return "", err
	}
	return customerID, tx.Commit(ctx)
}

func scanUniqueTextID(rows pgx.Rows) (string, error) {
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

func reviewCommerceIntegrationID(settings map[string]any) string {
	return strings.TrimSpace(firstString(
		settingString(settings, "commerce_integration_id"),
		settingString(settings, "product_source_integration_id"),
		settingString(settings, "catalog_integration_id"),
	))
}

func reviewProductSourceCandidates(review ReviewInput) []string {
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
	for _, key := range []string{
		"external_product_id",
		"provider_product_id",
		"source_product_id",
		"product_source_id",
		"product_id",
	} {
		add(reviewMetadataString(review.Metadata, key))
	}
	// Commerce product imports use provider-specific source_id forms. Yotpo often
	// sends bare external product ids, so try common product URI forms too.
	base := append([]string(nil), out...)
	for _, value := range base {
		if strings.Contains(value, "://") {
			continue
		}
		for _, prefix := range []string{
			"gid://shopify/Product/",
			"shopify://product/",
			"bigcommerce://product/",
			"woocommerce://product/",
			"square://product/",
			"adobe-commerce://product/",
			"wix://product/",
			"squarespace://product/",
		} {
			add(prefix + value)
		}
	}
	return out
}

func reviewOrderLineProductCandidate(review ReviewInput, lineItems []map[string]any) (map[string]any, bool) {
	if len(lineItems) == 0 {
		return nil, false
	}
	candidates := reviewCandidateSet(reviewProductSourceCandidates(review))
	if len(candidates) > 0 {
		matches := make([]map[string]any, 0, 1)
		for _, item := range lineItems {
			if reviewOrderLineMatchesProductCandidates(item, candidates) {
				matches = append(matches, item)
			}
		}
		if len(matches) == 1 {
			return matches[0], true
		}
		if len(matches) > 1 {
			return nil, false
		}
	}
	if len(lineItems) == 1 {
		return lineItems[0], true
	}
	return nil, false
}

func reviewOrderLineMatchesProductCandidates(lineItem map[string]any, candidates map[string]bool) bool {
	for _, value := range append(append(reviewOrderLineProductSourceCandidates(lineItem), reviewOrderLineVariantSourceCandidates(lineItem)...), reviewOrderLineSKUCandidates(lineItem)...) {
		if candidates[value] || candidates[strings.ToLower(value)] {
			return true
		}
	}
	return false
}

func reviewCandidateSet(values []string) map[string]bool {
	out := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		out[value] = true
		out[strings.ToLower(value)] = true
	}
	return out
}

func reviewOrderLineProductSourceCandidates(lineItem map[string]any) []string {
	return reviewCommerceLineSourceCandidates(lineItem, []string{
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

func reviewOrderLineVariantSourceCandidates(lineItem map[string]any) []string {
	return reviewCommerceLineSourceCandidates(lineItem, []string{
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

func reviewOrderLineSKUCandidates(lineItem map[string]any) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, key := range []string{"sku", "variant_sku", "product_sku", "item_sku"} {
		value := strings.ToLower(reviewMetadataString(lineItem, key))
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func reviewCommerceLineSourceCandidates(lineItem map[string]any, keys []string, prefixes []string) []string {
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
		add(reviewMetadataString(lineItem, key))
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

func reviewOrderSourceCandidates(review ReviewInput) []string {
	return reviewCommerceSourceCandidates(review.Metadata, []string{
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

func reviewCustomerSourceCandidates(review ReviewInput) []string {
	return reviewCommerceSourceCandidates(review.Metadata, []string{
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

func reviewCommerceSourceCandidates(metadata map[string]any, keys []string, prefixes []string) []string {
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
		add(reviewMetadataString(metadata, key))
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

func reviewMetadataString(metadata map[string]any, key string) string {
	if metadata == nil {
		return ""
	}
	v, ok := metadata[key]
	if !ok || v == nil {
		return ""
	}
	switch typed := v.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	case fmt.Stringer:
		return strings.TrimSpace(typed.String())
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}
