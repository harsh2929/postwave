// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

func mergeGorgiasCommerceEvidence(props map[string]any, raws ...map[string]any) map[string]any {
	if props == nil {
		props = map[string]any{}
	}
	for _, raw := range raws {
		for key, value := range gorgiasCommerceEvidence(raw) {
			if _, exists := props[key]; !exists {
				props[key] = value
			}
		}
	}
	return props
}

func gorgiasCommerceEvidence(raw map[string]any) map[string]any {
	if len(raw) == 0 {
		return nil
	}
	out := map[string]any{}
	mergeGorgiasCommerceEvidenceMap(out, gorgiasCommerceEvidenceFromDirectPayload(raw, "payload"))
	for _, customer := range gorgiasCommerceCustomerMaps(raw) {
		mergeGorgiasCommerceEvidenceMap(out, gorgiasCommerceEvidenceFromCustomer(customer))
	}
	if len(out) == 0 {
		return nil
	}
	out["gorgias_commerce_context_present"] = true
	return out
}

func gorgiasCommerceCustomerMaps(raw map[string]any) []map[string]any {
	candidates := []map[string]any{}
	for _, path := range [][]string{
		{"customer"},
		{"ticket", "customer"},
		{"data", "customer"},
		{"data", "ticket", "customer"},
	} {
		if customer := gorgiasMapAt(raw, path...); len(customer) > 0 {
			candidates = append(candidates, customer)
		}
	}
	return candidates
}

func gorgiasCommerceEvidenceFromCustomer(customer map[string]any) map[string]any {
	integrations := gorgiasAnyAt(customer, "integrations")
	out := map[string]any{}
	switch typed := integrations.(type) {
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			provider := gorgiasNormalizeCommerceProvider(key)
			for _, integration := range gorgiasIntegrationMaps(typed[key]) {
				mergeGorgiasCommerceEvidenceMap(out, gorgiasCommerceEvidenceFromIntegration(provider, integration))
			}
		}
	case []any:
		for _, item := range typed {
			integration, ok := item.(map[string]any)
			if !ok {
				continue
			}
			provider := gorgiasNormalizeCommerceProvider(firstString(
				gorgiasStringValue(integration["provider"]),
				gorgiasStringValue(integration["type"]),
				gorgiasStringValue(integration["name"]),
			))
			mergeGorgiasCommerceEvidenceMap(out, gorgiasCommerceEvidenceFromIntegration(provider, integration))
		}
	}
	return out
}

func gorgiasIntegrationMaps(value any) []map[string]any {
	switch typed := value.(type) {
	case map[string]any:
		return []map[string]any{typed}
	case []any:
		out := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			if m, ok := item.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	default:
		return nil
	}
}

func gorgiasCommerceEvidenceFromIntegration(provider string, integration map[string]any) map[string]any {
	out := map[string]any{}
	provider = gorgiasNormalizeCommerceProvider(firstString(provider, gorgiasStringValue(integration["provider"]), gorgiasStringValue(integration["type"])))
	for _, order := range gorgiasCommerceOrderMaps(integration) {
		orderEvidence := gorgiasCommerceEvidenceFromOrder(provider, order, "customer.integrations")
		mergeGorgiasCommerceEvidenceMap(out, orderEvidence)
		if len(orderEvidence) > 0 {
			break
		}
	}
	mergeGorgiasCommerceEvidenceMap(out, gorgiasCommerceEvidenceFromCustomerObject(provider, gorgiasMapAt(integration, "customer")))
	mergeGorgiasCommerceEvidenceMap(out, gorgiasCommerceEvidenceFromSubscription(provider, integration))
	if len(out) > 0 && provider != "" {
		out["gorgias_commerce_provider"] = provider
	}
	return out
}

func gorgiasCommerceOrderMaps(root map[string]any) []map[string]any {
	candidates := []map[string]any{}
	for _, key := range []string{"order", "last_order", "latest_order", "shopify_order"} {
		if order := gorgiasMapAt(root, key); len(order) > 0 {
			candidates = append(candidates, order)
		}
	}
	for _, key := range []string{"orders", "recent_orders"} {
		switch typed := gorgiasAnyAt(root, key).(type) {
		case []any:
			for _, item := range typed {
				if order, ok := item.(map[string]any); ok {
					candidates = append(candidates, order)
				}
			}
		case map[string]any:
			candidates = append(candidates, typed)
		}
	}
	if len(candidates) == 0 && gorgiasLooksLikeOrder(root) {
		candidates = append(candidates, root)
	}
	return candidates
}

func gorgiasCommerceEvidenceFromDirectPayload(raw map[string]any, source string) map[string]any {
	out := map[string]any{}
	for _, path := range [][]string{
		{"order"},
		{"shopify_order"},
		{"ticket", "order"},
		{"ticket", "shopify_order"},
		{"data", "order"},
		{"data", "shopify_order"},
		{"data", "ticket", "order"},
		{"data", "ticket", "shopify_order"},
	} {
		node := raw
		if len(path) > 0 {
			node = gorgiasMapAt(raw, path...)
		}
		if len(node) == 0 {
			continue
		}
		provider := gorgiasNormalizeCommerceProvider(firstString(
			gorgiasStringValue(node["commerce_provider"]),
			gorgiasStringValue(node["provider"]),
			gorgiasStringValue(node["source"]),
		))
		mergeGorgiasCommerceEvidenceMap(out, gorgiasCommerceEvidenceFromOrder(provider, node, source))
	}
	for _, path := range [][]string{
		{},
		{"ticket"},
		{"data"},
		{"data", "ticket"},
	} {
		node := raw
		if len(path) > 0 {
			node = gorgiasMapAt(raw, path...)
		}
		if len(node) == 0 || !gorgiasLooksLikeOrder(node) {
			continue
		}
		provider := gorgiasNormalizeCommerceProvider(firstString(
			gorgiasStringValue(node["commerce_provider"]),
			gorgiasStringValue(node["provider"]),
			gorgiasStringValue(node["source"]),
		))
		mergeGorgiasCommerceEvidenceMap(out, gorgiasCommerceEvidenceFromOrder(provider, node, source))
	}
	return out
}

func gorgiasCommerceEvidenceFromOrder(provider string, order map[string]any, source string) map[string]any {
	if len(order) == 0 {
		return nil
	}
	provider = gorgiasNormalizeCommerceProvider(provider)
	orderID := firstString(
		gorgiasStringValue(order["shopify_order_id"]),
		gorgiasStringValue(order["external_order_id"]),
		gorgiasStringValue(order["order_id"]),
		gorgiasStringValue(order["admin_graphql_api_id"]),
		gorgiasStringValue(order["id"]),
	)
	orderNumber := firstString(
		gorgiasStringValue(order["order_number"]),
		gorgiasStringValue(order["number"]),
		gorgiasStringValue(order["name"]),
	)
	status := firstString(
		gorgiasStringValue(order["order_status"]),
		gorgiasStringValue(order["status"]),
		gorgiasStringValue(order["financial_status"]),
		gorgiasStringValue(order["fulfillment_status"]),
	)
	total := firstString(
		gorgiasStringValue(order["order_total"]),
		gorgiasStringValue(order["total_price"]),
		gorgiasStringValue(order["current_total_price"]),
		gorgiasStringValue(order["total"]),
		gorgiasStringValue(gorgiasAnyAt(order, "total_money", "amount")),
		gorgiasStringValue(gorgiasAnyAt(order, "total_price_set", "shop_money", "amount")),
	)
	currency := strings.ToUpper(firstString(
		gorgiasStringValue(order["order_currency"]),
		gorgiasStringValue(order["currency"]),
		gorgiasStringValue(order["currency_code"]),
		gorgiasStringValue(gorgiasAnyAt(order, "total_money", "currency")),
		gorgiasStringValue(gorgiasAnyAt(order, "total_price_set", "shop_money", "currency_code")),
	))
	if orderID == "" && orderNumber == "" && status == "" && total == "" && currency == "" {
		return nil
	}
	out := map[string]any{
		"gorgias_commerce_context_source": source,
	}
	if provider != "" {
		out["gorgias_commerce_provider"] = provider
	}
	setGorgiasEvidence(out, "external_order_id", orderID)
	if provider == "shopify" {
		setGorgiasEvidence(out, "shopify_order_id", orderID)
	}
	setGorgiasEvidence(out, "order_number", orderNumber)
	setGorgiasEvidence(out, "order_status", status)
	setGorgiasEvidence(out, "order_financial_status", gorgiasStringValue(order["financial_status"]))
	setGorgiasEvidence(out, "order_fulfillment_status", gorgiasStringValue(order["fulfillment_status"]))
	setGorgiasEvidence(out, "order_total", total)
	setGorgiasEvidence(out, "order_currency", currency)
	setGorgiasEvidence(out, "order_created_at", firstString(gorgiasStringValue(order["created_at"]), gorgiasStringValue(order["createdAt"])))
	mergeGorgiasCommerceEvidenceMap(out, gorgiasCommerceLineItemEvidence(order))
	return out
}

func gorgiasCommerceEvidenceFromCustomerObject(provider string, customer map[string]any) map[string]any {
	if len(customer) == 0 {
		return nil
	}
	customerID := firstString(
		gorgiasStringValue(customer["shopify_customer_id"]),
		gorgiasStringValue(customer["external_customer_id"]),
		gorgiasStringValue(customer["customer_id"]),
		gorgiasStringValue(customer["admin_graphql_api_id"]),
		gorgiasStringValue(customer["id"]),
	)
	if customerID == "" {
		return nil
	}
	out := map[string]any{"external_customer_id": customerID}
	if gorgiasNormalizeCommerceProvider(provider) == "shopify" {
		out["shopify_customer_id"] = customerID
	}
	return out
}

func gorgiasCommerceEvidenceFromSubscription(provider string, integration map[string]any) map[string]any {
	if gorgiasNormalizeCommerceProvider(provider) != "recharge" && gorgiasStringValue(integration["recharge_subscription_id"]) == "" {
		return nil
	}
	subscription := gorgiasMapAt(integration, "subscription")
	if len(subscription) == 0 {
		if items, ok := gorgiasAnyAt(integration, "subscriptions").([]any); ok && len(items) > 0 {
			subscription, _ = items[0].(map[string]any)
		}
	}
	subscriptionID := firstString(
		gorgiasStringValue(integration["recharge_subscription_id"]),
		gorgiasStringValue(subscription["id"]),
		gorgiasStringValue(subscription["subscription_id"]),
	)
	if subscriptionID == "" {
		return nil
	}
	out := map[string]any{"recharge_subscription_id": subscriptionID}
	setGorgiasEvidence(out, "recharge_subscription_status", firstString(gorgiasStringValue(subscription["status"]), gorgiasStringValue(integration["subscription_status"])))
	return out
}

func gorgiasCommerceLineItemEvidence(order map[string]any) map[string]any {
	out := map[string]any{}
	productCandidates := []string{}
	variantCandidates := []string{}
	skuCandidates := []string{}
	for _, item := range gorgiasCommerceLineItemMaps(order) {
		productCandidates = append(productCandidates, gorgiasOrderLineProductSourceCandidates(item)...)
		variantCandidates = append(variantCandidates, gorgiasOrderLineVariantSourceCandidates(item)...)
		skuCandidates = append(skuCandidates, gorgiasOrderLineSKUCandidates(item)...)
	}
	if productCandidates = uniqueGorgiasEvidenceStrings(productCandidates); len(productCandidates) > 0 {
		out["product_source_candidates"] = productCandidates
	}
	if variantCandidates = uniqueGorgiasEvidenceStrings(variantCandidates); len(variantCandidates) > 0 {
		out["variant_source_candidates"] = variantCandidates
	}
	if skuCandidates = uniqueGorgiasEvidenceStrings(skuCandidates); len(skuCandidates) > 0 {
		out["product_sku_candidates"] = skuCandidates
	}
	return out
}

func gorgiasCommerceLineItemMaps(order map[string]any) []map[string]any {
	out := []map[string]any{}
	for _, key := range []string{"line_items", "items", "order_items"} {
		switch typed := order[key].(type) {
		case []map[string]any:
			out = append(out, typed...)
		case []any:
			for _, item := range typed {
				if m, ok := item.(map[string]any); ok {
					out = append(out, m)
				}
			}
		case map[string]any:
			out = append(out, typed)
		}
	}
	return out
}

func uniqueGorgiasEvidenceStrings(values []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

func gorgiasLooksLikeOrder(raw map[string]any) bool {
	for _, key := range []string{"shopify_order_id", "external_order_id", "order_id", "order_number", "total_price", "current_total_price", "financial_status", "fulfillment_status"} {
		if gorgiasStringValue(raw[key]) != "" {
			return true
		}
	}
	return false
}

func mergeGorgiasCommerceEvidenceMap(dst, src map[string]any) {
	for key, value := range src {
		if _, exists := dst[key]; !exists && value != nil && fmt.Sprint(value) != "" {
			dst[key] = value
		}
	}
}

func setGorgiasEvidence(out map[string]any, key, value string) {
	if strings.TrimSpace(value) != "" {
		out[key] = strings.TrimSpace(value)
	}
}

func gorgiasNormalizeCommerceProvider(raw string) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	value = strings.ReplaceAll(value, " ", "_")
	switch {
	case strings.Contains(value, "shopify"):
		return "shopify"
	case strings.Contains(value, "recharge"):
		return "recharge"
	case strings.Contains(value, "woocommerce"):
		return "woocommerce"
	case strings.Contains(value, "bigcommerce"):
		return "bigcommerce"
	default:
		return strings.Trim(value, "_")
	}
}

func gorgiasMapAt(node map[string]any, path ...string) map[string]any {
	if len(path) == 0 {
		return node
	}
	if out, ok := gorgiasAnyAt(node, path...).(map[string]any); ok {
		return out
	}
	return nil
}

func gorgiasAnyAt(node map[string]any, path ...string) any {
	var cur any = node
	for _, key := range path {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[key]
	}
	return cur
}

func gorgiasStringValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return strings.TrimSpace(typed.String())
	case float64:
		return strings.TrimSpace(fmt.Sprintf("%v", typed))
	default:
		switch typed.(type) {
		case map[string]any, []any:
			return ""
		default:
			return strings.TrimSpace(fmt.Sprint(typed))
		}
	}
}
