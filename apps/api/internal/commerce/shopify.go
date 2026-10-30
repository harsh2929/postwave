package commerce

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

var defaultShopifyScopes = []string{
	"read_customers",
	"read_products",
	"read_orders",
}

const (
	shopifyOAuthGrantDocsURL      = "https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant"
	shopifyWebhookTopicsDocsURL   = "https://shopify.dev/docs/api/admin-graphql/latest/enums/WebhookSubscriptionTopic"
	shopifyDisconnectEvidenceText = "Shopify's current authorization-code grant docs document token issuance and expiry variants but no explicit OAuth token revocation endpoint; provider-side token invalidation is represented by merchant app uninstall and the app/uninstalled webhook."
)

func ShopifyTokenRevocation() ShopifyTokenRevocationEvidence {
	return ShopifyTokenRevocationEvidence{
		ExplicitRevokeEndpoint: false,
		ProviderMechanism:      shopifyDisconnectEvidenceText,
		PostwaveDisconnect:     "Moosewave deletes owned Shopify webhook subscriptions before deleting the local integration row and encrypted install token.",
		Docs: []string{
			shopifyOAuthGrantDocsURL,
			shopifyWebhookTopicsDocsURL,
		},
	}
}

func NormalizeShopDomain(shop string) string {
	shop = strings.ToLower(strings.TrimSpace(shop))
	shop = strings.TrimPrefix(shop, "https://")
	shop = strings.TrimPrefix(shop, "http://")
	shop = strings.Trim(shop, "/")
	if shop == "" {
		return ""
	}
	if !strings.Contains(shop, ".") {
		shop += ".myshopify.com"
	}
	return shop
}

func ValidShopifyShopDomain(shop string) bool {
	shop = NormalizeShopDomain(shop)
	if shop == "" || len(shop) > 255 || !strings.HasSuffix(shop, ".myshopify.com") {
		return false
	}
	parts := strings.Split(shop, ".")
	if len(parts) != 3 || parts[1] != "myshopify" || parts[2] != "com" {
		return false
	}
	for _, part := range parts {
		if part == "" {
			return false
		}
		if part[0] == '-' || part[len(part)-1] == '-' {
			return false
		}
		for _, r := range part {
			ok := (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-'
			if !ok {
				return false
			}
		}
	}
	return true
}

func (c Config) scopes() []string {
	if len(c.ShopifyScopes) == 0 {
		return append([]string(nil), defaultShopifyScopes...)
	}
	out := make([]string, 0, len(c.ShopifyScopes))
	for _, s := range c.ShopifyScopes {
		s = strings.TrimSpace(s)
		if s != "" {
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}

func buildShopifyAuthorizeURL(cfg Config, shop, state string) (string, bool) {
	shop = NormalizeShopDomain(shop)
	if strings.TrimSpace(cfg.ShopifyClientID) == "" || strings.TrimSpace(cfg.ShopifyClientSecret) == "" {
		q := url.Values{}
		q.Set("shop", shop)
		q.Set("code", "local-dev")
		q.Set("state", state)
		return "/api/public/commerce/shopify/oauth/callback?" + q.Encode(), true
	}
	q := url.Values{}
	q.Set("client_id", cfg.ShopifyClientID)
	q.Set("scope", strings.Join(cfg.scopes(), ","))
	q.Set("redirect_uri", cfg.ShopifyOAuthRedirectURL)
	q.Set("state", state)
	return "https://" + shop + "/admin/oauth/authorize?" + q.Encode(), false
}

func newNonce() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(b[:])
}

func ShopifyCustomerInput(body []byte) (CustomerInput, error) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return CustomerInput{}, err
	}
	return customerFromMap(raw), nil
}

func ShopifyProductInput(body []byte) (ProductInput, error) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return ProductInput{}, err
	}
	return productFromMap(raw), nil
}

func ShopifyOrderInput(body []byte) (OrderInput, error) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return OrderInput{}, err
	}
	return orderFromMap(raw), nil
}

func ShopifyCartRecoveryLinkInput(body []byte) (CartRecoveryLinkInput, bool, error) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return CartRecoveryLinkInput{}, false, err
	}
	out := cartRecoveryLinkFromMap(raw)
	if out.SourceCartID == "" || out.RecoveryURL == "" {
		return out, false, nil
	}
	return out, true, nil
}

func customerFromMap(raw map[string]any) CustomerInput {
	return CustomerInput{
		SourceID:         sourceID(raw),
		Email:            strings.ToLower(strings.TrimSpace(stringField(raw, "email"))),
		FirstName:        stringField(raw, "first_name"),
		LastName:         stringField(raw, "last_name"),
		AcceptsMarketing: boolField(raw, "accepts_marketing"),
		Tags:             parseTags(stringField(raw, "tags")),
		Raw:              nonNilMap(raw),
	}
}

func productFromMap(raw map[string]any) ProductInput {
	imageURL := ""
	if image, _ := raw["image"].(map[string]any); image != nil {
		imageURL = stringField(image, "src")
	}
	priceCents := 0
	if variants, _ := raw["variants"].([]any); len(variants) > 0 {
		if v, _ := variants[0].(map[string]any); v != nil {
			priceCents = cents(v["price"])
		}
	}
	handle := strings.TrimSpace(stringField(raw, "handle"))
	out := ProductInput{
		SourceID:   sourceID(raw),
		Title:      stringField(raw, "title"),
		URL:        stringField(raw, "online_store_url"),
		ImageURL:   imageURL,
		PriceCents: priceCents,
		Currency:   "USD",
		Raw:        nonNilMap(raw),
	}
	if out.URL == "" && handle != "" {
		out.URL = "/products/" + handle
	}
	return out
}

func orderFromMap(raw map[string]any) OrderInput {
	customerEmail := strings.TrimSpace(stringField(raw, "email"))
	if customerEmail == "" {
		customerEmail = strings.TrimSpace(stringField(raw, "contact_email"))
	}
	if customerEmail == "" {
		if customer, _ := raw["customer"].(map[string]any); customer != nil {
			customerEmail = strings.TrimSpace(stringField(customer, "email"))
		}
	}
	orderedAt := parseTimeAny(firstNonNil(raw["processed_at"], raw["created_at"], raw["updated_at"]))
	lineItems := normalizeLineItems(raw["line_items"])
	return OrderInput{
		SourceID:      sourceID(raw),
		CustomerEmail: strings.ToLower(customerEmail),
		Status:        shopifyOrderStatus(raw),
		SubtotalCents: cents(raw["subtotal_price"]),
		DiscountCents: cents(raw["total_discounts"]),
		ShippingCents: shippingCents(raw),
		TaxCents:      cents(raw["total_tax"]),
		TotalCents:    cents(raw["total_price"]),
		Currency:      defaulted(strings.ToUpper(stringField(raw, "currency")), "USD"),
		Attribution: map[string]any{
			"source":                "shopify",
			"source_name":           stringField(raw, "source_name"),
			"landing_site":          stringField(raw, "landing_site"),
			"referring_site":        stringField(raw, "referring_site"),
			"discount_codes":        shopifyDiscountCodes(raw),
			"discount_applications": rawArray(raw["discount_applications"]),
		},
		LineItems: lineItems,
		OrderedAt: orderedAt,
		Raw:       nonNilMap(raw),
	}
}

func cartRecoveryLinkFromMap(raw map[string]any) CartRecoveryLinkInput {
	email := strings.TrimSpace(stringField(raw, "email"))
	if email == "" {
		email = strings.TrimSpace(stringField(raw, "contact_email"))
	}
	if email == "" {
		if customer, _ := raw["customer"].(map[string]any); customer != nil {
			email = strings.TrimSpace(stringField(customer, "email"))
		}
	}
	expiresAt := parseTimeAny(firstNonNil(raw["expires_at"], raw["updated_at"]))
	completedAt := parseTimeAny(firstNonNil(raw["completed_at"], raw["closed_at"]))
	status := "active"
	if completedAt != nil || stringField(raw, "order_id") != "" || stringField(raw, "order") != "" {
		status = "converted"
	} else if expiresAt != nil && expiresAt.Before(time.Now().UTC()) {
		status = "expired"
	}
	sourceCartID := strings.TrimSpace(fmt.Sprint(firstNonNil(
		raw["cart_token"],
		raw["token"],
		raw["admin_graphql_api_id"],
		raw["id"],
	)))
	recoveryURL := strings.TrimSpace(firstNonEmpty(
		stringField(raw, "abandoned_checkout_url"),
		stringField(raw, "checkout_url"),
		stringField(raw, "web_url"),
		stringField(raw, "url"),
	))
	lineItems := normalizeLineItems(raw["line_items"])
	return CartRecoveryLinkInput{
		SourceCartID:  sourceCartID,
		CustomerEmail: strings.ToLower(email),
		RecoveryURL:   recoveryURL,
		Status:        status,
		ExpiresAt:     expiresAt,
		Metadata: map[string]any{
			"source":                "shopify",
			"checkout_id":           sourceID(raw),
			"cart_token":            stringField(raw, "cart_token"),
			"token":                 stringField(raw, "token"),
			"currency":              defaulted(strings.ToUpper(stringField(raw, "currency")), "USD"),
			"subtotal_cents":        cents(firstNonNil(raw["subtotal_price"], raw["subtotal"])),
			"discount_cents":        cents(firstNonNil(raw["total_discounts"], raw["total_discount"])),
			"total_cents":           cents(firstNonNil(raw["total_price"], raw["total"])),
			"line_items":            lineItems,
			"discount_codes":        shopifyDiscountCodes(raw),
			"discount_applications": rawArray(raw["discount_applications"]),
			"completed_at":          timeString(completedAt),
		},
	}
}

func shopifyOrderStatus(raw map[string]any) string {
	if stringField(raw, "cancelled_at") != "" || stringField(raw, "cancel_reason") != "" {
		return "cancelled"
	}
	financial := strings.ToLower(strings.TrimSpace(stringField(raw, "financial_status")))
	switch financial {
	case "paid", "authorized", "partially_paid":
		return "paid"
	case "refunded", "partially_refunded":
		return "refunded"
	case "voided":
		return "cancelled"
	default:
		return "pending"
	}
}

func shippingCents(raw map[string]any) int {
	if set, _ := raw["total_shipping_price_set"].(map[string]any); set != nil {
		if money, _ := set["shop_money"].(map[string]any); money != nil {
			return cents(money["amount"])
		}
	}
	return cents(raw["total_shipping_price"])
}

func normalizeLineItems(v any) []map[string]any {
	items, _ := v.([]any)
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		out = append(out, map[string]any{
			"source_id":   sourceID(m),
			"product_id":  fmt.Sprint(firstNonNil(m["product_id"], "")),
			"variant_id":  fmt.Sprint(firstNonNil(m["variant_id"], "")),
			"title":       stringField(m, "title"),
			"quantity":    intField(m, "quantity"),
			"price_cents": cents(m["price"]),
		})
	}
	if out == nil {
		return []map[string]any{}
	}
	return out
}

func shopifyDiscountCodes(raw map[string]any) []string {
	items := rawArray(raw["discount_codes"])
	out := make([]string, 0, len(items))
	seen := map[string]bool{}
	for _, item := range items {
		code := ""
		if m, ok := item.(map[string]any); ok {
			code = stringField(m, "code")
		} else {
			code = strings.TrimSpace(fmt.Sprint(item))
		}
		if code == "" {
			continue
		}
		key := strings.ToLower(code)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, code)
	}
	return out
}

func rawArray(v any) []any {
	items, _ := v.([]any)
	if items == nil {
		return []any{}
	}
	return items
}

func timeString(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func sourceID(raw map[string]any) string {
	return strings.TrimSpace(fmt.Sprint(firstNonNil(raw["admin_graphql_api_id"], raw["source_id"], raw["id"])))
}

func stringField(m map[string]any, key string) string {
	v, ok := m[key]
	if !ok || v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t)
	case json.Number:
		return t.String()
	default:
		return strings.TrimSpace(fmt.Sprint(t))
	}
}

func boolField(m map[string]any, key string) bool {
	v, ok := m[key]
	if !ok {
		return false
	}
	switch t := v.(type) {
	case bool:
		return t
	case string:
		return strings.EqualFold(t, "true") || t == "1"
	default:
		return fmt.Sprint(t) == "1"
	}
}

func intField(m map[string]any, key string) int {
	v, ok := m[key]
	if !ok {
		return 0
	}
	switch t := v.(type) {
	case float64:
		return int(t)
	case json.Number:
		i, _ := t.Int64()
		return int(i)
	case string:
		i, _ := strconv.Atoi(strings.TrimSpace(t))
		return i
	default:
		return 0
	}
}

func cents(v any) int {
	switch t := v.(type) {
	case nil:
		return 0
	case float64:
		return int(math.Round(t * 100))
	case json.Number:
		f, _ := t.Float64()
		return int(math.Round(f * 100))
	case string:
		f, _ := strconv.ParseFloat(strings.TrimSpace(t), 64)
		return int(math.Round(f * 100))
	default:
		f, _ := strconv.ParseFloat(fmt.Sprint(t), 64)
		return int(math.Round(f * 100))
	}
}

func parseTags(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return []string{}
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	seen := map[string]bool{}
	for _, part := range parts {
		tag := strings.TrimSpace(part)
		if tag == "" || seen[strings.ToLower(tag)] {
			continue
		}
		seen[strings.ToLower(tag)] = true
		out = append(out, tag)
	}
	return out
}

func parseTimeAny(v any) *time.Time {
	raw := strings.TrimSpace(fmt.Sprint(v))
	if raw == "" || raw == "<nil>" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05-0700"} {
		if parsed, err := time.Parse(layout, raw); err == nil {
			utc := parsed.UTC()
			return &utc
		}
	}
	return nil
}

func firstNonNil(values ...any) any {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}

func defaulted(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func nonNilMap(m map[string]any) map[string]any {
	if m == nil {
		return map[string]any{}
	}
	return m
}
