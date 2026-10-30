package billing

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPublicCheckout503WhenSecretMissing(t *testing.T) {
	t.Setenv("STRIPE_SECRET_KEY", "")
	t.Setenv("STRIPE_PRICE_LTD", "price_test_ltd")

	req := httptest.NewRequest(
		http.MethodPost,
		"/api/public/billing/checkout",
		strings.NewReader(`{"tier":"studio_ltd","customerEmail":"hi@example.com"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	(&Handlers{}).PublicCheckout(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "checkout_not_configured") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPublicCheckoutFailsClosedWithoutLaunchApprovalInProduction(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("POSTWAVE_BILLING_LAUNCH_APPROVAL", "")
	t.Setenv("STRIPE_SECRET_KEY", "sk_live_configured")
	t.Setenv("STRIPE_PRICE_LTD", "price_live_ltd")

	req := httptest.NewRequest(
		http.MethodPost,
		"/api/public/billing/checkout",
		strings.NewReader(`{"tier":"studio_ltd","customerEmail":"hi@example.com"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	(&Handlers{}).PublicCheckout(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "checkout_launch_blocked") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPublicCheckoutRequiresEmail(t *testing.T) {
	t.Setenv("STRIPE_SECRET_KEY", "sk_test_x")
	t.Setenv("STRIPE_PRICE_LTD", "price_test_ltd")

	req := httptest.NewRequest(
		http.MethodPost,
		"/api/public/billing/checkout",
		strings.NewReader(`{"tier":"studio_ltd"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	(&Handlers{}).PublicCheckout(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_email") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPublicCheckoutRequiresKnownTier(t *testing.T) {
	t.Setenv("STRIPE_SECRET_KEY", "sk_test_x")

	req := httptest.NewRequest(
		http.MethodPost,
		"/api/public/billing/checkout",
		strings.NewReader(`{"tier":"made_up","customerEmail":"hi@example.com"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	(&Handlers{}).PublicCheckout(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_price") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPublicCheckoutReportsMissingPriceAsServerConfiguration(t *testing.T) {
	t.Setenv("STRIPE_SECRET_KEY", "sk_test_x")
	t.Setenv("STRIPE_PRICE_LTD", "")
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/public/billing/checkout",
		strings.NewReader(`{"tier":"studio_ltd","customerEmail":"hi@example.com"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	(&Handlers{}).PublicCheckout(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "checkout_not_configured") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPublicCheckoutRejectsCallerSelectedTenant(t *testing.T) {
	t.Setenv("STRIPE_SECRET_KEY", "sk_test_x")
	t.Setenv("STRIPE_PRICE_LTD", "price_test_ltd")
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/public/billing/checkout",
		strings.NewReader(`{"tier":"studio_ltd","customerEmail":"hi@example.com","tenantSlug":"victim"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	(&Handlers{}).PublicCheckout(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
}

func TestPublicCheckoutRejectsCrossOriginReturnURL(t *testing.T) {
	t.Setenv("STRIPE_SECRET_KEY", "sk_test_x")
	t.Setenv("STRIPE_PRICE_LTD", "price_test_ltd")
	t.Setenv("PUBLIC_BASE_URL", "https://app.postwave.example")
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/public/billing/checkout",
		strings.NewReader(`{"tier":"studio_ltd","customerEmail":"hi@example.com","successUrl":"https://attacker.example/paid"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	(&Handlers{}).PublicCheckout(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "invalid_return_url") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestSessionModeFollowsResolvedPriceNotCallerTier(t *testing.T) {
	t.Setenv("STRIPE_PRICE_LTD", "price_ltd")
	t.Setenv("STRIPE_PRICE_PRO", "price_pro")
	if got := sessionModeFor("price_pro"); got != "subscription" {
		t.Fatalf("mode = %q, want subscription", got)
	}
	if got := sessionModeFor("price_ltd"); got != "payment" {
		t.Fatalf("mode = %q, want payment", got)
	}
}

func TestPublicCheckoutRejectsOversizedBody(t *testing.T) {
	req := httptest.NewRequest(
		http.MethodPost,
		"/api/public/billing/checkout",
		strings.NewReader(`{"tier":"studio_ltd","customerEmail":"`+strings.Repeat("x", int(publicCheckoutMaxBodyBytes))+`@example.com"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	(&Handlers{}).PublicCheckout(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payload_too_large") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPublicCheckoutSuccess(t *testing.T) {
	t.Setenv("STRIPE_SECRET_KEY", "sk_test_x")
	t.Setenv("STRIPE_PRICE_LTD", "price_test_ltd")
	t.Setenv("PUBLIC_BASE_URL", "https://postwave.example")

	// Stand up a fake Stripe API.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/checkout/sessions" {
			t.Errorf("unexpected stripe path %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk_test_x" {
			t.Errorf("auth header = %q", got)
		}
		if err := r.ParseForm(); err != nil {
			t.Errorf("parse form: %v", err)
		}
		// Verify the form-encoded fields the handler should set.
		if got := r.Form.Get("mode"); got != "payment" {
			t.Errorf("mode = %q, want payment (LTD is one-time)", got)
		}
		if got := r.Form.Get("line_items[0][price]"); got != "price_test_ltd" {
			t.Errorf("price = %q", got)
		}
		if got := r.Form.Get("customer_email"); got != "hi@example.com" {
			t.Errorf("email = %q", got)
		}
		if got := r.Form.Get("success_url"); !strings.Contains(got, "/pricing/success") {
			t.Errorf("success_url = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"cs_test_123","url":"https://checkout.stripe.com/c/pay/cs_test_123"}`))
	}))
	defer srv.Close()

	prevBase := stripeAPIBase
	stripeAPIBase = srv.URL
	defer func() { stripeAPIBase = prevBase }()

	req := httptest.NewRequest(
		http.MethodPost,
		"/api/public/billing/checkout",
		strings.NewReader(`{"tier":"studio_ltd","customerEmail":"hi@example.com"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	(&Handlers{}).PublicCheckout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	var out PublicCheckoutResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v; body=%s", err, rec.Body.String())
	}
	if out.SessionID != "cs_test_123" {
		t.Errorf("sessionId = %q", out.SessionID)
	}
	if !strings.Contains(out.URL, "checkout.stripe.com") {
		t.Errorf("url = %q", out.URL)
	}
}

func TestPublicCheckoutSubscriptionModeDoesNotForwardClosedAffiliateCookie(t *testing.T) {
	t.Setenv("STRIPE_SECRET_KEY", "sk_test_x")
	t.Setenv("STRIPE_PRICE_SENDING", "price_test_sending")
	t.Setenv("PUBLIC_BASE_URL", "https://postwave.example")

	gotMode := ""
	gotSessionRef := ""
	gotSubscriptionRef := ""
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotMode = r.Form.Get("mode")
		gotSessionRef = r.Form.Get("metadata[pw_ref_cookie_id]")
		gotSubscriptionRef = r.Form.Get("subscription_data[metadata][pw_ref_cookie_id]")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"cs_test_456","url":"https://stripe.test/x"}`))
	}))
	defer srv.Close()

	prevBase := stripeAPIBase
	stripeAPIBase = srv.URL
	defer func() { stripeAPIBase = prevBase }()

	req := httptest.NewRequest(
		http.MethodPost,
		"/api/public/billing/checkout",
		strings.NewReader(`{"tier":"studio_ltd_cloud","customerEmail":"hi@example.com"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{
		Name:  "pw_ref",
		Value: "0123456789abcdef0123456789abcdef",
	})
	rec := httptest.NewRecorder()
	(&Handlers{}).PublicCheckout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if gotMode != "subscription" {
		t.Errorf("mode = %q, want subscription", gotMode)
	}
	if gotSessionRef != "" || gotSubscriptionRef != "" {
		t.Errorf(
			"closed affiliate metadata must be absent; session=%q subscription=%q",
			gotSessionRef,
			gotSubscriptionRef,
		)
	}
}

func TestCreateStripeCheckoutSessionCapsSuccessResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("{", int(stripeCheckoutResponseMaxBytes)+1)))
	}))
	defer srv.Close()

	prevBase := stripeAPIBase
	stripeAPIBase = srv.URL
	defer func() { stripeAPIBase = prevBase }()

	_, err := createStripeCheckoutSession(context.Background(), "sk_test_x", stripeCheckoutCreate{
		PriceID:       "price_test",
		Mode:          "payment",
		CustomerEmail: "hi@example.com",
		SuccessURL:    "https://postwave.example/success",
		CancelURL:     "https://postwave.example/cancel",
	})
	if err == nil || !strings.Contains(err.Error(), "response body too large") {
		t.Fatalf("createStripeCheckoutSession err = %v, want response body too large", err)
	}
}
