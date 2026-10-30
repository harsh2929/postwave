// webhook_smoke_test.go
//
// End-to-end "smoke" coverage for the riskiest untested billing path: a
// customer pays via Stripe Checkout, the webhook fires, and we ask
// whether the WebhookHandler actually invokes Provisioner.ProvisionTenant
// for the new public-checkout flow introduced in public_checkout.go.
//
// Why a separate file from webhook_test.go: the existing TestWebhookDispatch
// is parameterized over fake events but stubs the Repo to nil and asserts
// only on the stub Provisioner counter. This file walks an end-to-end
// payload shape — `checkout.session.completed` produced by the new
// /api/public/billing/checkout flow — and checks the SAME handler sees
// it the way Stripe will deliver it.
//
// Honest gap reporting: webhook.go's handleCheckoutCompleted intentionally
// does NOT call Provisioner for `mode=payment` sessions (studio LTD: BYO
// sender), and for `mode=subscription` it defers to the follow-up
// `customer.subscription.created` event. That's by design. The public-
// checkout-success path that operators worry about — "did the customer
// actually get provisioned?" — runs through subscription.created, NOT
// checkout.session.completed. The tests below assert the actual
// behaviour and t.Skipf when an integration the user might assume
// exists is genuinely absent.
//
// stripe-go SDK note: webhook.go deliberately does not import stripe-go.
// The signature verification is in-tree (HMAC-SHA256). We mirror that
// here — these tests build payloads + signatures with the standard
// library so they don't drag a transitive dep just for fakes.

package billing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/sending"
)

// ---------------------------------------------------------------------------
// Recording stubs.
// ---------------------------------------------------------------------------

// recordingProvisioner is a Provisioner double that captures every
// ProvisionTenant call so the smoke test can assert on tenant id.
type recordingProvisioner struct {
	mu          sync.Mutex
	provisioned []sending.Tenant
}

func (r *recordingProvisioner) ProvisionTenant(_ context.Context, t sending.Tenant) (*sending.State, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.provisioned = append(r.provisioned, t)
	return &sending.State{TenantID: t.ID, Tier: t.Tier}, nil
}

func (r *recordingProvisioner) DeprovisionTenant(_ context.Context, _ string) error {
	return nil
}

func (r *recordingProvisioner) calls() []sending.Tenant {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]sending.Tenant, len(r.provisioned))
	copy(out, r.provisioned)
	return out
}

// signWebhook computes a Stripe-Signature header for `body` at `ts` using
// `secret`. Mirrors the protocol documented at
// https://stripe.com/docs/webhooks/signatures.
func signWebhook(secret string, ts time.Time, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d", ts.Unix())))
	mac.Write([]byte("."))
	mac.Write(body)
	return fmt.Sprintf("t=%d,v1=%s", ts.Unix(), hex.EncodeToString(mac.Sum(nil)))
}

// fireEvent constructs an envelope, signs it, POSTs it through the handler,
// and returns the recorder for the caller to assert on.
func fireEvent(t *testing.T, h *WebhookHandler, secret, eventType string, object map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	objJSON, err := json.Marshal(object)
	if err != nil {
		t.Fatalf("marshal object: %v", err)
	}
	envelope := StripeEvent{
		ID:      "evt_smoke_" + eventType,
		Type:    eventType,
		Created: time.Now().Unix(),
		Data:    StripeEventData{Object: objJSON},
	}
	body, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	now := time.Now()
	req := httptest.NewRequest(http.MethodPost, "/api/public/stripe/webhook", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Stripe-Signature", signWebhook(secret, now, body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// ---------------------------------------------------------------------------
// Smoke test 1 — checkout.session.completed for the LTD (mode=payment) flow.
//
// What we want to know: does paying for Studio LTD via the new
// /api/public/billing/checkout endpoint result in Provisioner being
// invoked? Per webhook.go::handleCheckoutCompleted the answer is NO
// (LTD = BYO sender, no Postmark provisioning). This is by design.
// We assert exactly that and document the design intent for the next
// reader.
// ---------------------------------------------------------------------------
func TestWebhookSmoke_CheckoutSessionCompleted_LTD_DoesNotProvision(t *testing.T) {
	const secret = "whsec_smoke_test"
	prov := &recordingProvisioner{}
	h := &WebhookHandler{
		Secret:      secret,
		Provisioner: prov,
		Prices:      PriceMap{LTD: "price_studio_ltd"},
		Repo:        nil, // exercise the no-repo path; smoke is about Provisioner wiring
		Now:         time.Now,
	}

	// Mirrors the Stripe checkout.session.completed payload that the
	// public-checkout flow produces for `tier=studio_ltd`. The
	// Authenticated checkout sets client_reference_id to the tenant UUID;
	// unauthenticated public checkout uses the auto:<email> sentinel instead.
	rec := fireEvent(t, h, secret, "checkout.session.completed", map[string]any{
		"id":                  "cs_test_ltd_smoke",
		"customer":            "cus_test_ltd_smoke",
		"client_reference_id": "tenant-acme-smoke",
		"mode":                "payment",
		"metadata": map[string]string{
			"origin": "marketing_pricing_page",
		},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("LTD checkout completed: status %d, body=%s", rec.Code, rec.Body.String())
	}
	if got := len(prov.calls()); got != 0 {
		t.Fatalf(
			"LTD checkout fired ProvisionTenant %d times — handler should NOT "+
				"provision for mode=payment (Studio LTD = BYO sender). "+
				"See webhook.go::handleCheckoutCompleted.",
			got,
		)
	}
}

// ---------------------------------------------------------------------------
// Smoke test 2 — subscription.created for the sending tier flow.
//
// The cloud-sending tier (`tier=studio_ltd_cloud` / `sending`) produces a
// `mode=subscription` checkout session. Stripe fires
// checkout.session.completed FIRST (no provisioning side-effect by
// design) and customer.subscription.created IMMEDIATELY AFTER (which is
// where ProvisionTenant runs). This smoke test fires that second event
// and asserts the Provisioner sees the right tenant id + tier.
// ---------------------------------------------------------------------------
func TestWebhookSmoke_SubscriptionCreated_Sending_FiresProvisioner(t *testing.T) {
	const secret = "whsec_smoke_test"
	const tenantID = "00000000-0000-0000-0000-000000000042"

	prov := &recordingProvisioner{}
	h := &WebhookHandler{
		Secret:      secret,
		Provisioner: prov,
		Prices:      PriceMap{Sending: "price_sending_smoke"},
		Repo:        nil,
		Now:         time.Now,
	}

	rec := fireEvent(t, h, secret, "customer.subscription.created", map[string]any{
		"id":                 "sub_smoke_sending",
		"customer":           "cus_smoke_sending",
		"status":             "active",
		"current_period_end": time.Now().Add(30 * 24 * time.Hour).Unix(),
		"items": map[string]any{
			"data": []map[string]any{
				{"price": map[string]string{"id": "price_sending_smoke"}},
			},
		},
		"metadata": map[string]string{
			"tenant_id":   tenantID,
			"tenant_slug": "acme-smoke",
			"tenant_name": "Acme Smoke",
		},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("subscription created: status %d, body=%s", rec.Code, rec.Body.String())
	}
	calls := prov.calls()
	if len(calls) != 1 {
		t.Fatalf("expected 1 ProvisionTenant call, got %d", len(calls))
	}
	got := calls[0]
	if got.ID != tenantID {
		t.Fatalf("Provisioner.tenantID = %q, want %q", got.ID, tenantID)
	}
	if got.Tier != string(TierSending) {
		t.Fatalf("Provisioner.tier = %q, want %q", got.Tier, TierSending)
	}
	if got.Slug != "acme-smoke" {
		t.Fatalf("Provisioner.slug = %q, want %q", got.Slug, "acme-smoke")
	}
}

// ---------------------------------------------------------------------------
// Smoke test 3 — public-checkout auto-provision flow.
//
// Public checkout never trusts a caller-supplied tenant identifier. Its
// auto:<email> reference makes the webhook resolve an existing owner or create
// a tenant idempotently after payment. The test asserts that routing contract.
func TestWebhookSmoke_PublicCheckoutAutoProvision(t *testing.T) {
	const secret = "whsec_smoke_test"
	prov := &recordingProvisioner{}
	auto := &recordingAutoTenant{outID: "00000000-0000-0000-0000-0000000000aa"}
	h := &WebhookHandler{
		Secret:      secret,
		Provisioner: prov,
		Prices:      PriceMap{LTD: "price_studio_ltd"},
		Repo:        nil,
		AutoTenant:  auto,
		Now:         time.Now,
	}

	// What public_checkout.go::createStripeCheckoutSession produces for
	// brand-new marketing-site signups: client_reference_id is set to
	// `auto:<email>` so the webhook can route + dedupe deterministically.
	rec := fireEvent(t, h, secret, "checkout.session.completed", map[string]any{
		"id":                  "cs_public_no_slug",
		"customer":            "cus_public_no_slug",
		"client_reference_id": "auto:new-customer@example.com",
		"customer_email":      "new-customer@example.com",
		"mode":                "payment",
		"metadata": map[string]string{
			"origin": "marketing_pricing_page",
		},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("public-checkout auto-provision: status %d, body=%s", rec.Code, rec.Body.String())
	}
	if got := len(auto.calls); got != 1 {
		t.Fatalf("expected 1 EnsureTenantForEmail call, got %d", got)
	}
	if auto.calls[0].email != "new-customer@example.com" {
		t.Fatalf("EnsureTenantForEmail email = %q, want new-customer@example.com", auto.calls[0].email)
	}
	if auto.calls[0].customerID != "cus_public_no_slug" {
		t.Fatalf("EnsureTenantForEmail customer_id = %q, want cus_public_no_slug", auto.calls[0].customerID)
	}
}

// recordingAutoTenant is a TenantAutoProvisioner double — captures every
// EnsureTenantForEmail call so the smoke test can assert routing was
// invoked with the right (email, customer_id) pair.
type recordingAutoTenant struct {
	outID string
	calls []struct {
		email      string
		customerID string
	}
}

func (r *recordingAutoTenant) EnsureTenantForEmail(_ context.Context, email, customerID string) (string, bool, error) {
	r.calls = append(r.calls, struct {
		email      string
		customerID string
	}{email: email, customerID: customerID})
	return r.outID, true, nil
}
