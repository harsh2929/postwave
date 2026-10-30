package billing

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func authenticatedCheckoutRequest(body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/billing/checkout", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: "00000000-0000-0000-0000-000000000042", Slug: "acme",
	})
	ctx = middleware.WithUser(ctx, &middleware.User{Email: "admin@acme.test", Role: "admin"})
	return req.WithContext(ctx)
}

func authenticatedPortalRequest() *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/billing/portal", nil)
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{
		ID: "00000000-0000-0000-0000-000000000042", Slug: "acme",
	})
	return req.WithContext(ctx)
}

func TestCheckoutCreatesTenantBoundStripeSession(t *testing.T) {
	t.Setenv("STRIPE_SECRET_KEY", "sk_test_dashboard")
	t.Setenv("STRIPE_PRICE_PRO", "price_pro")
	var form url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		form, _ = url.ParseQuery(string(body))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"cs_dashboard","url":"https://checkout.stripe.com/c/pay/cs_dashboard"}`))
	}))
	defer srv.Close()
	prevBase := stripeAPIBase
	stripeAPIBase = srv.URL
	defer func() { stripeAPIBase = prevBase }()

	req := authenticatedCheckoutRequest(`{"tier":"studio_ltd_plus"}`)
	rec := httptest.NewRecorder()
	(&Handlers{stateLoader: func(context.Context, string) (*BillingState, error) {
		return &BillingState{StripeCustomerID: "cus_existing"}, nil
	}}).Checkout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "https://checkout.stripe.com/c/pay/cs_dashboard") {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if got := form.Get("client_reference_id"); got != "00000000-0000-0000-0000-000000000042" {
		t.Fatalf("client_reference_id=%q", got)
	}
	if got := form.Get("metadata[tenant_id]"); got != "00000000-0000-0000-0000-000000000042" {
		t.Fatalf("metadata tenant_id=%q", got)
	}
	if got := form.Get("subscription_data[metadata][tenant_id]"); got != "00000000-0000-0000-0000-000000000042" {
		t.Fatalf("subscription metadata tenant_id=%q", got)
	}
	if got := form.Get("customer"); got != "cus_existing" {
		t.Fatalf("customer=%q", got)
	}
	if got := form.Get("customer_email"); got != "" {
		t.Fatalf("customer_email=%q, must be omitted when reusing a Stripe customer", got)
	}
}

func TestCheckoutFallsBackToLocalURLOutsideProduction(t *testing.T) {
	t.Setenv("PUBLIC_BASE_URL", "http://localhost:3333")
	t.Setenv("STRIPE_SECRET_KEY", "")

	req := authenticatedCheckoutRequest(`{"tier":"studio_ltd_plus"}`)
	rec := httptest.NewRecorder()
	(&Handlers{}).Checkout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "http://localhost:3333/app/billing/upgrade?checkout=scale") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestCheckoutRequiresStripeSecretInProduction(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("POSTWAVE_BILLING_LAUNCH_APPROVAL", "approved:LAUNCH-TEST")
	t.Setenv("STRIPE_SECRET_KEY", "")

	req := authenticatedCheckoutRequest(`{"tier":"studio_ltd"}`)
	rec := httptest.NewRecorder()
	(&Handlers{}).Checkout(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
}

func TestCheckoutFailsClosedWithoutBillingLaunchApproval(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("POSTWAVE_BILLING_LAUNCH_APPROVAL", "")
	t.Setenv("STRIPE_SECRET_KEY", "sk_live_configured")

	rec := httptest.NewRecorder()
	(&Handlers{}).Checkout(rec, authenticatedCheckoutRequest(`{"tier":"studio_ltd"}`))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "checkout_launch_blocked") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestProtectedBillingRuntimeRecognizesEnvironmentAliases(t *testing.T) {
	environmentKeys := []string{"POSTWAVE_ENV", "APP_ENV", "GO_ENV", "ENVIRONMENT", "NODE_ENV"}
	for _, environmentKey := range environmentKeys {
		t.Run(environmentKey, func(t *testing.T) {
			for _, key := range environmentKeys {
				t.Setenv(key, "")
			}
			t.Setenv(environmentKey, "staging")
			if !isProtectedBillingRuntime() {
				t.Fatalf("protected environment alias %q was ignored", environmentKey)
			}
		})
	}
}

func TestPortalFallsBackToLocalURLOutsideProduction(t *testing.T) {
	t.Setenv("PUBLIC_BASE_URL", "http://localhost:3333/")
	t.Setenv("STRIPE_SECRET_KEY", "")

	req := authenticatedPortalRequest()
	rec := httptest.NewRecorder()
	(&Handlers{}).Portal(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "http://localhost:3333/app/billing?portal=local") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPortalCreatesTenantBoundStripeSession(t *testing.T) {
	t.Setenv("STRIPE_SECRET_KEY", "sk_test_portal")
	t.Setenv("PUBLIC_BASE_URL", "https://app.postwave.example")
	var form url.Values
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.URL.Path; got != "/v1/billing_portal/sessions" {
			t.Errorf("path = %q", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk_test_portal" {
			t.Errorf("Authorization = %q", got)
		}
		body, _ := io.ReadAll(r.Body)
		form, _ = url.ParseQuery(string(body))
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"bps_123","url":"https://billing.stripe.com/p/session/test"}`))
	}))
	defer srv.Close()
	previousBase := stripeAPIBase
	stripeAPIBase = srv.URL
	defer func() { stripeAPIBase = previousBase }()

	handlers := &Handlers{stateLoader: func(_ context.Context, tenantID string) (*BillingState, error) {
		if tenantID != "00000000-0000-0000-0000-000000000042" {
			t.Fatalf("tenantID = %q", tenantID)
		}
		return &BillingState{StripeCustomerID: "cus_123"}, nil
	}}
	rec := httptest.NewRecorder()
	handlers.Portal(rec, authenticatedPortalRequest())

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if got := form.Get("customer"); got != "cus_123" {
		t.Errorf("customer = %q", got)
	}
	if got := form.Get("return_url"); got != "https://app.postwave.example/app/billing" {
		t.Errorf("return_url = %q", got)
	}
	if !strings.Contains(rec.Body.String(), `"sessionId":"bps_123"`) {
		t.Errorf("body = %s", rec.Body.String())
	}
}

func TestPortalRequiresTenant(t *testing.T) {
	rec := httptest.NewRecorder()
	(&Handlers{}).Portal(rec, httptest.NewRequest(http.MethodPost, "/api/v1/billing/portal", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body=%s", rec.Code, rec.Body.String())
	}
}

func TestPortalRequiresProjectedStripeCustomer(t *testing.T) {
	t.Setenv("STRIPE_SECRET_KEY", "sk_test_portal")
	rec := httptest.NewRecorder()
	(&Handlers{stateLoader: func(context.Context, string) (*BillingState, error) {
		return &BillingState{}, nil
	}}).Portal(rec, authenticatedPortalRequest())
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "billing_customer_missing") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestPortalRejectsStaticURLInProductionWithoutStripeSecret(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("STRIPE_SECRET_KEY", "")
	t.Setenv("STRIPE_CUSTOMER_PORTAL_URL", "https://attacker.invalid/static")
	rec := httptest.NewRecorder()
	(&Handlers{}).Portal(rec, authenticatedPortalRequest())
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503; body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "attacker.invalid") {
		t.Fatalf("static URL leaked into response: %s", rec.Body.String())
	}
}

func TestPortalHidesStripeFailureDetails(t *testing.T) {
	t.Setenv("STRIPE_SECRET_KEY", "sk_test_portal")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"secret upstream customer detail"}}`))
	}))
	defer srv.Close()
	previousBase := stripeAPIBase
	stripeAPIBase = srv.URL
	defer func() { stripeAPIBase = previousBase }()

	rec := httptest.NewRecorder()
	(&Handlers{stateLoader: func(context.Context, string) (*BillingState, error) {
		return &BillingState{StripeCustomerID: "cus_missing"}, nil
	}}).Portal(rec, authenticatedPortalRequest())
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502; body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "secret upstream customer detail") || strings.Contains(rec.Body.String(), "cus_missing") {
		t.Fatalf("Stripe detail leaked to caller: %s", rec.Body.String())
	}
}

func TestDashboardSendingUsageUsesTheContractedAllowance(t *testing.T) {
	// The displayed cap MUST equal the enforced cap (limits.MonthlySendCap):
	// Historical sending resolves to Launch (25k) and pro resolves to Scale
	// (500k), matching the one canonical allowance table.
	cloud := toDashboardState(&BillingState{Tier: TierSending}, "", 51_250)
	if cloud.SendingAddon == nil || cloud.SendingAddon.MonthlyCap != 25_000 || cloud.SendingAddon.Used != 51_250 || cloud.SendingAddon.OverageEnabled {
		t.Fatalf("cloud sending addon = %+v", cloud.SendingAddon)
	}
	if cloud.SendingAddon.OverageUnits != 26_250 {
		t.Fatalf("legacy sending excess units = %d, want 26250 (51250-25000)", cloud.SendingAddon.OverageUnits)
	}
	pro := toDashboardState(&BillingState{Tier: TierPro}, "", 260_000)
	if pro.SendingAddon == nil || pro.SendingAddon.MonthlyCap != 500_000 || pro.SendingAddon.OverageEnabled {
		t.Fatalf("pro sending addon = %+v", pro.SendingAddon)
	}
	if pro.SendingAddon.OverageUnits != 0 {
		t.Fatalf("pro overage units = %d, want 0 (260000 < 500000)", pro.SendingAddon.OverageUnits)
	}

	// Stored historical overage preferences are inert under the hard-cap catalog.
	on := toDashboardState(&BillingState{Tier: TierSending, OverageEnabled: true}, "", 60_000)
	if on.SendingAddon == nil || on.SendingAddon.OverageEnabled || on.SendingAddon.OverageUnits != 35_000 {
		t.Fatalf("overage-on addon = %+v", on.SendingAddon)
	}
	if on.SendingAddon.OverageChargeable {
		t.Fatal("OverageChargeable must be false when Stripe is not configured")
	}
}
