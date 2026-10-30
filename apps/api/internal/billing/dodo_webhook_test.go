package billing

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func signDodo(secret, messageID string, timestamp int64, body []byte) string {
	key, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(secret, "whsec_"))
	mac := hmac.New(sha256.New, key)
	_, _ = fmt.Fprintf(mac, "%s.%d.", messageID, timestamp)
	_, _ = mac.Write(body)
	return "v1," + base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

func TestVerifyDodoSignature(t *testing.T) {
	secret := "whsec_" + base64.StdEncoding.EncodeToString([]byte("webhook-secret"))
	now := time.Unix(1_800_000_000, 0)
	body := []byte(`{"type":"payment.succeeded"}`)
	signature := signDodo(secret, "msg_123", now.Unix(), body)
	if err := VerifyDodoSignature(secret, "msg_123", fmt.Sprint(now.Unix()), signature, body, now, 5*time.Minute); err != nil {
		t.Fatalf("valid signature failed: %v", err)
	}
	if err := VerifyDodoSignature(secret, "msg_123", fmt.Sprint(now.Unix()), signature, []byte(`{}`), now, 5*time.Minute); err == nil {
		t.Fatal("signature accepted a different body")
	}
	if err := VerifyDodoSignature(secret, "msg_123", fmt.Sprint(now.Add(-10*time.Minute).Unix()), signature, body, now, 5*time.Minute); err == nil {
		t.Fatal("stale signature was accepted")
	}
}

type dodoAutoTenantStub struct {
	provider Provider
	email    string
	customer string
}

func (s *dodoAutoTenantStub) EnsureTenantForEmail(context.Context, string, string) (string, bool, error) {
	return "legacy-tenant", false, nil
}

func (s *dodoAutoTenantStub) EnsureTenantForProviderEmail(_ context.Context, provider Provider, email, customerID string) (string, bool, error) {
	s.provider, s.email, s.customer = provider, email, customerID
	return "tenant-123", true, nil
}

func TestDodoSubscriptionWebhookActivatesTierWithoutProviderSideEffects(t *testing.T) {
	t.Setenv("DODO_PAYMENTS_PRODUCT_ID_LAUNCH_MONTHLY", "pdt_launch")
	t.Setenv("DODO_PAYMENTS_PRODUCT_ID_GROWTH_MONTHLY", "pdt_growth")
	t.Setenv("DODO_PAYMENTS_PRODUCT_ID_SCALE_MONTHLY", "pdt_scale")
	secret := "whsec_" + base64.StdEncoding.EncodeToString([]byte("webhook-secret"))
	now := time.Unix(1_800_000_000, 0)
	body := []byte(`{
  "business_id":"bus_123",
  "type":"subscription.active",
  "timestamp":"2027-01-15T08:00:00Z",
  "data":{
    "subscription_id":"sub_123",
    "product_id":"pdt_growth",
    "status":"active",
    "next_billing_date":"2027-02-15T08:00:00Z",
    "customer":{"customer_id":"cus_123","email":"owner@example.com"},
    "metadata":{}
  }
}`)
	provisioner := &stubProvisioner{}
	autoTenant := &dodoAutoTenantStub{}
	handler := &DodoWebhookHandler{
		Secret: secret,
		Now:    func() time.Time { return now },
		Core: &WebhookHandler{
			Provisioner: provisioner,
			AutoTenant:  autoTenant,
		},
	}
	req := httptest.NewRequest(http.MethodPost, "/api/public/dodo/webhook", strings.NewReader(string(body)))
	req.Header.Set("webhook-id", "msg_123")
	req.Header.Set("webhook-timestamp", fmt.Sprint(now.Unix()))
	req.Header.Set("webhook-signature", signDodo(secret, "msg_123", now.Unix(), body))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if autoTenant.provider != ProviderDodo || autoTenant.email != "owner@example.com" || autoTenant.customer != "cus_123" {
		t.Fatalf("auto tenant call = provider:%q email:%q customer:%q", autoTenant.provider, autoTenant.email, autoTenant.customer)
	}
	if len(provisioner.provisioned) != 0 {
		t.Fatalf("payment webhook created provider resources: %+v", provisioner.provisioned)
	}
}

func TestDodoWebhookRejectsInvalidSignature(t *testing.T) {
	handler := &DodoWebhookHandler{Secret: "whsec_" + base64.StdEncoding.EncodeToString([]byte("right")), Core: &WebhookHandler{}}
	req := httptest.NewRequest(http.MethodPost, "/api/public/dodo/webhook", strings.NewReader(`{"type":"payment.succeeded","data":{}}`))
	req.Header.Set("webhook-id", "msg_bad")
	req.Header.Set("webhook-timestamp", fmt.Sprint(time.Now().Unix()))
	req.Header.Set("webhook-signature", "v1,invalid")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	assertWebhookError(t, rec, http.StatusBadRequest, "invalid_signature")
}
