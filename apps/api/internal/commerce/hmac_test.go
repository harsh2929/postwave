package commerce

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestVerifyShopifyWebhookHMAC(t *testing.T) {
	secret := "shpss_test"
	body := []byte(`{"id":123}`)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	sig := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	if err := VerifyShopifyWebhookHMAC(secret, body, sig); err != nil {
		t.Fatalf("valid signature rejected: %v", err)
	}
	if err := VerifyShopifyWebhookHMAC(secret, body, base64.StdEncoding.EncodeToString([]byte("wrong"))); err == nil {
		t.Fatal("expected wrong signature to fail")
	}
	if err := VerifyShopifyWebhookHMAC("", body, sig); err == nil {
		t.Fatal("expected missing secret to fail")
	}
}

func TestVerifyWooCommerceWebhookSignature(t *testing.T) {
	secret := "wc-webhook-secret"
	body := []byte(`{"id":123,"status":"processing"}`)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	sig := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	if err := VerifyWooCommerceWebhookSignature(secret, body, sig); err != nil {
		t.Fatalf("valid WooCommerce signature rejected: %v", err)
	}
	if err := VerifyWooCommerceWebhookSignature(secret, append(body, '\n'), sig); err == nil {
		t.Fatal("expected signature over modified raw body to fail")
	}
	if err := VerifyWooCommerceWebhookSignature("", body, sig); err == nil {
		t.Fatal("expected missing secret to fail")
	}
}

func TestVerifyStripeWebhookSignature(t *testing.T) {
	secret := "whsec_test"
	now := time.Unix(1_700_000_000, 0)
	body := []byte(`{"id":"evt_123","type":"payment_intent.succeeded"}`)
	header := signStripeWebhookTest(secret, now.Unix(), body)

	if err := VerifyStripeWebhookSignature(secret, header, body, now, 0); err != nil {
		t.Fatalf("valid Stripe signature rejected: %v", err)
	}
	if err := VerifyStripeWebhookSignature(secret, header, append(body, '\n'), now, 0); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("modified body error = %v, want ErrInvalidSignature", err)
	}
	staleHeader := signStripeWebhookTest(secret, now.Add(-10*time.Minute).Unix(), body)
	if err := VerifyStripeWebhookSignature(secret, staleHeader, body, now, 0); !errors.Is(err, ErrExpiredState) {
		t.Fatalf("stale timestamp error = %v, want ErrExpiredState", err)
	}
	if err := VerifyStripeWebhookSignature("", header, body, now, 0); !errors.Is(err, ErrMissingSecret) {
		t.Fatalf("missing secret error = %v, want ErrMissingSecret", err)
	}
}

func TestVerifySquareWebhookSignature(t *testing.T) {
	signatureKey := "square-signature-key"
	notificationURL := "https://api.postwave.test/api/public/commerce/square/webhooks"
	body := []byte(`{"merchant_id":"ML123","type":"catalog.version.updated"}`)
	header := signSquareWebhookTest(signatureKey, notificationURL, body)

	if err := VerifySquareWebhookSignature(signatureKey, notificationURL, body, header); err != nil {
		t.Fatalf("valid Square signature rejected: %v", err)
	}
	if err := VerifySquareWebhookSignature(signatureKey, notificationURL+"?tampered=1", body, header); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("tampered notification URL error = %v, want ErrInvalidSignature", err)
	}
	if err := VerifySquareWebhookSignature(signatureKey, notificationURL, append(body, '\n'), header); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("tampered body error = %v, want ErrInvalidSignature", err)
	}
	if err := VerifySquareWebhookSignature("", notificationURL, body, header); !errors.Is(err, ErrMissingSecret) {
		t.Fatalf("missing signature key error = %v, want ErrMissingSecret", err)
	}
}

func TestVerifySquarespaceWebhookSignature(t *testing.T) {
	secretHex := hex.EncodeToString([]byte("squarespace-webhook-secret"))
	body := []byte(`{"topic":"order.create","data":{"id":"ord_123"}}`)
	header := signSquarespaceWebhookTest(secretHex, body)

	if err := VerifySquarespaceWebhookSignature(secretHex, body, header); err != nil {
		t.Fatalf("valid Squarespace signature rejected: %v", err)
	}
	if err := VerifySquarespaceWebhookSignature(secretHex, append(body, '\n'), header); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("tampered body error = %v, want ErrInvalidSignature", err)
	}
	if err := VerifySquarespaceWebhookSignature("not-hex", body, header); err == nil {
		t.Fatal("expected malformed hex secret to fail")
	}
	if err := VerifySquarespaceWebhookSignature("", body, header); !errors.Is(err, ErrMissingSecret) {
		t.Fatalf("missing secret error = %v, want ErrMissingSecret", err)
	}
}

func TestVerifyRazorpayWebhookSignature(t *testing.T) {
	secret := "razorpay-webhook-secret"
	body := []byte(`{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_123"}}}}`)
	header := signRazorpayWebhookTest(secret, body)

	if err := VerifyRazorpayWebhookSignature(secret, body, header); err != nil {
		t.Fatalf("valid Razorpay signature rejected: %v", err)
	}
	if err := VerifyRazorpayWebhookSignature(secret, append(body, '\n'), header); !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("tampered body error = %v, want ErrInvalidSignature", err)
	}
	if err := VerifyRazorpayWebhookSignature("", body, header); !errors.Is(err, ErrMissingSecret) {
		t.Fatalf("missing secret error = %v, want ErrMissingSecret", err)
	}
}

func TestVerifyShopifyOAuthHMAC(t *testing.T) {
	secret := "oauth_secret"
	values := url.Values{}
	values.Set("shop", "demo.myshopify.com")
	values.Set("timestamp", "1700000000")
	values.Set("code", "abc123")
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(shopifyOAuthMessage(values)))
	values.Set("hmac", hex.EncodeToString(mac.Sum(nil)))

	if err := VerifyShopifyOAuthHMAC(secret, values); err != nil {
		t.Fatalf("valid oauth hmac rejected: %v", err)
	}
	values.Set("code", "tampered")
	if err := VerifyShopifyOAuthHMAC(secret, values); err == nil {
		t.Fatal("expected tampered oauth query to fail")
	}
}

func TestOAuthStateRoundTrip(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	state, err := BuildOAuthState("state_secret", "tenant-1", "Demo.myshopify.com", "nonce-1", now)
	if err != nil {
		t.Fatalf("build state: %v", err)
	}
	tenantID, shop, err := ParseOAuthState("state_secret", state, now.Add(time.Minute), time.Hour)
	if err != nil {
		t.Fatalf("parse state: %v", err)
	}
	if tenantID != "tenant-1" || shop != "demo.myshopify.com" {
		t.Fatalf("state = %s/%s", tenantID, shop)
	}
	if _, _, err := ParseOAuthState("wrong", state, now, time.Hour); err == nil {
		t.Fatal("expected wrong state secret to fail")
	}
	if _, _, err := ParseOAuthState("state_secret", state, now.Add(2*time.Hour), time.Minute); err == nil {
		t.Fatal("expected expired state to fail")
	}
}

func TestBuildOAuthStateFailsClosedWithoutSecret(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	for _, secret := range []string{"", "   ", "\t\n"} {
		_, err := BuildOAuthState(secret, "tenant-1", "demo.myshopify.com", "nonce-1", now)
		if !errors.Is(err, ErrMissingSecret) {
			t.Errorf("BuildOAuthState(%q): got %v, want ErrMissingSecret", secret, err)
		}
	}
}

func TestParseOAuthStateFailsClosedWithoutSecret(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	// First mint a valid state with a real secret so we have non-empty input.
	state, err := BuildOAuthState("real_secret", "tenant-1", "demo.myshopify.com", "nonce-1", now)
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if _, _, err := ParseOAuthState("", state, now, time.Hour); !errors.Is(err, ErrMissingSecret) {
		t.Errorf("ParseOAuthState(empty secret): got %v, want ErrMissingSecret", err)
	}
}

func TestValidShopifyShopDomain(t *testing.T) {
	cases := []struct {
		shop string
		want bool
	}{
		{"demo", true},
		{"Demo.myshopify.com", true},
		{"https://demo.myshopify.com/", true},
		{"demo-store.myshopify.com", true},
		{"demo.myshopify.com.evil.example", false},
		{"-demo.myshopify.com", false},
		{"demo-.myshopify.com", false},
		{"demo..myshopify.com", false},
		{"demo.shopify.com", false},
		{"demo.myshopify.co", false},
		{"demo_myshopify.com", false},
	}
	for _, tc := range cases {
		if got := ValidShopifyShopDomain(tc.shop); got != tc.want {
			t.Errorf("ValidShopifyShopDomain(%q) = %v, want %v", tc.shop, got, tc.want)
		}
	}
}

func TestDefaultShopifyScopesAvoidSpecialAccessReadAllOrders(t *testing.T) {
	scopes := (Config{}).scopes()
	for _, scope := range scopes {
		if scope == "read_all_orders" {
			t.Fatalf("default Shopify scopes must not request special-access read_all_orders: %+v", scopes)
		}
	}
	for _, required := range []string{"read_customers", "read_products", "read_orders"} {
		found := false
		for _, scope := range scopes {
			if scope == required {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("default Shopify scopes missing %q: %+v", required, scopes)
		}
	}
}

func TestShopifyTokenRevocationEvidence(t *testing.T) {
	evidence := ShopifyTokenRevocation()
	if evidence.ExplicitRevokeEndpoint {
		t.Fatal("Shopify evidence should not claim an explicit token revocation endpoint")
	}
	if !strings.Contains(evidence.ProviderMechanism, "app/uninstalled") {
		t.Fatalf("provider mechanism should cite app/uninstalled, got %q", evidence.ProviderMechanism)
	}
	if len(evidence.Docs) < 2 {
		t.Fatalf("expected OAuth and webhook-topic docs, got %+v", evidence.Docs)
	}
}

func TestNoHardcodedFallbackSecret(t *testing.T) {
	// Defense in depth: a state minted with one secret must never validate
	// under any other secret — and especially not under the prior hardcoded
	// fallback "postwave-local-shopify-state".
	now := time.Unix(1_700_000_000, 0)
	state, err := BuildOAuthState("real_secret", "tenant-1", "demo.myshopify.com", "nonce-1", now)
	if err != nil {
		t.Fatalf("setup: %v", err)
	}
	if _, _, err := ParseOAuthState("postwave-local-shopify-state", state, now, time.Hour); err == nil {
		t.Fatal("legacy hardcoded fallback secret unexpectedly validated a state minted with a different secret")
	}
}

func TestShopifyPayloadMappers(t *testing.T) {
	customer, err := ShopifyCustomerInput([]byte(`{
		"id": 42,
		"email": "Buyer@Example.COM",
		"first_name": "Buyer",
		"last_name": "Person",
		"accepts_marketing": true,
		"tags": "VIP, newsletter, VIP"
	}`))
	if err != nil {
		t.Fatalf("customer: %v", err)
	}
	if customer.SourceID != "42" || customer.Email != "buyer@example.com" || len(customer.Tags) != 2 {
		t.Fatalf("bad customer mapping: %+v", customer)
	}

	product, err := ShopifyProductInput([]byte(`{
		"id": 99,
		"title": "Template Pack",
		"handle": "template-pack",
		"image": {"src": "https://cdn.example/img.png"},
		"variants": [{"price": "29.50"}]
	}`))
	if err != nil {
		t.Fatalf("product: %v", err)
	}
	if product.PriceCents != 2950 || product.URL != "/products/template-pack" {
		t.Fatalf("bad product mapping: %+v", product)
	}

	order, err := ShopifyOrderInput([]byte(`{
		"id": 1001,
		"email": "buyer@example.com",
		"financial_status": "paid",
		"subtotal_price": "29.50",
		"total_discounts": "4.50",
		"total_tax": "2.00",
		"total_price": "27.00",
		"currency": "usd",
		"processed_at": "2026-05-05T08:00:00Z",
		"discount_codes": [{"code": "WELCOME10", "amount": "4.50"}],
		"line_items": [{"id": 1, "product_id": 99, "title": "Template Pack", "quantity": 1, "price": "29.50"}]
	}`))
	if err != nil {
		t.Fatalf("order: %v", err)
	}
	if order.Status != "paid" || order.TotalCents != 2700 || order.Currency != "USD" || len(order.LineItems) != 1 {
		t.Fatalf("bad order mapping: %+v", order)
	}
	codes, _ := order.Attribution["discount_codes"].([]string)
	if len(codes) != 1 || codes[0] != "WELCOME10" {
		t.Fatalf("bad order discount attribution: %+v", order.Attribution)
	}

	cart, ok, err := ShopifyCartRecoveryLinkInput([]byte(`{
		"id": 2002,
		"token": "checkout_token_1",
		"cart_token": "cart_token_1",
		"email": "Buyer@Example.COM",
		"abandoned_checkout_url": "https://demo.myshopify.com/checkouts/recover/abc",
		"currency": "usd",
		"subtotal_price": "29.50",
		"total_discounts": "4.50",
		"total_price": "25.00",
		"discount_codes": [{"code": "WELCOME10", "amount": "4.50"}],
		"line_items": [{"id": 1, "product_id": 99, "title": "Template Pack", "quantity": 1, "price": "29.50"}]
	}`))
	if err != nil {
		t.Fatalf("cart recovery: %v", err)
	}
	if !ok || cart.SourceCartID != "cart_token_1" || cart.CustomerEmail != "buyer@example.com" || cart.Status != "active" {
		t.Fatalf("bad cart recovery mapping: ok=%v %+v", ok, cart)
	}
	cartCodes, _ := cart.Metadata["discount_codes"].([]string)
	if cart.RecoveryURL == "" || cart.Metadata["discount_cents"] != 450 || len(cartCodes) != 1 || cartCodes[0] != "WELCOME10" {
		t.Fatalf("bad cart recovery metadata: %+v", cart)
	}
}

func signShopifyTest(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func signOAuthTest(secret string, values url.Values) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(shopifyOAuthMessage(values)))
	return fmt.Sprintf("%x", mac.Sum(nil))
}

func signStripeWebhookTest(secret string, ts int64, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d.", ts)))
	mac.Write(body)
	return fmt.Sprintf("t=%d,v1=%x", ts, mac.Sum(nil))
}

func signSquareWebhookTest(signatureKey, notificationURL string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(signatureKey))
	mac.Write([]byte(notificationURL))
	mac.Write(body)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func signSquarespaceWebhookTest(secretHex string, body []byte) string {
	secret, _ := hex.DecodeString(secretHex)
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

func signRazorpayWebhookTest(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
