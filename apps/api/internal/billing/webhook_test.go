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
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/sending"
)

// stubProvisioner records the calls webhook handlers make.
type stubProvisioner struct {
	provisioned   []sending.Tenant
	deprovisioned []string
	provisionErr  error
}

func (s *stubProvisioner) ProvisionTenant(_ context.Context, t sending.Tenant) (*sending.State, error) {
	if s.provisionErr != nil {
		return nil, s.provisionErr
	}
	s.provisioned = append(s.provisioned, t)
	return &sending.State{TenantID: t.ID, Tier: t.Tier}, nil
}

func (s *stubProvisioner) DeprovisionTenant(_ context.Context, id string) error {
	s.deprovisioned = append(s.deprovisioned, id)
	return nil
}

// stubAffiliate records reversal calls.
type stubAffiliate struct {
	calls []string
}

func (s *stubAffiliate) ReverseConversion(_ context.Context, custID, chargeID string) error {
	s.calls = append(s.calls, custID+":"+chargeID)
	return nil
}

func sign(secret string, ts int64, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(fmt.Sprintf("%d.", ts)))
	mac.Write(body)
	return fmt.Sprintf("t=%d,v1=%s", ts, hex.EncodeToString(mac.Sum(nil)))
}

func TestVerifySignature(t *testing.T) {
	secret := "whsec_test"
	body := []byte(`{"id":"evt_123","type":"customer.subscription.created"}`)
	now := time.Now()

	t.Run("valid", func(t *testing.T) {
		header := sign(secret, now.Unix(), body)
		if err := VerifySignature(secret, header, body, now, time.Minute); err != nil {
			t.Fatalf("expected valid signature, got %v", err)
		}
	})
	t.Run("missing header", func(t *testing.T) {
		if err := VerifySignature(secret, "", body, now, time.Minute); err == nil {
			t.Fatal("expected error for missing header")
		}
	})
	t.Run("wrong secret", func(t *testing.T) {
		header := sign("other", now.Unix(), body)
		if err := VerifySignature(secret, header, body, now, time.Minute); err == nil {
			t.Fatal("expected mismatch error")
		}
	})
	t.Run("stale timestamp", func(t *testing.T) {
		stale := now.Add(-10 * time.Minute).Unix()
		header := sign(secret, stale, body)
		if err := VerifySignature(secret, header, body, now, 5*time.Minute); err == nil {
			t.Fatal("expected tolerance error")
		}
	})
	t.Run("malformed", func(t *testing.T) {
		if err := VerifySignature(secret, "garbage", body, now, time.Minute); err == nil {
			t.Fatal("expected malformed error")
		}
	})
}

func TestPriceMapDoesNotMapEmptyIDs(t *testing.T) {
	var prices PriceMap
	if got := prices.TierFor(""); got != "" {
		t.Fatalf("empty price id mapped to %q", got)
	}
	if got := prices.TierFor("price_unknown"); got != "" {
		t.Fatalf("unknown price id mapped to %q", got)
	}

	prices = PriceMap{Sending: "price_sending"}
	if got := prices.TierFor("price_sending"); got != TierSending {
		t.Fatalf("mapped tier = %q, want %q", got, TierSending)
	}
}

// dispatchTest fires a single event and asserts on the stub provisioner.
type dispatchTest struct {
	name        string
	eventType   string
	objectJSON  string
	wantProv    int
	wantDeprov  int
	wantStatus  int
	wantRefund  int
	prices      PriceMap
	provisioner *stubProvisioner
	affiliates  *stubAffiliate
}

func TestWebhookDispatch(t *testing.T) {
	prices := PriceMap{Sending: "price_sending", Pro: "price_pro", LTD: "price_ltd"}

	cases := []dispatchTest{
		{
			name:      "checkout completed (LTD)",
			eventType: "checkout.session.completed",
			objectJSON: `{
				"id":"cs_1","customer":"cus_1","client_reference_id":"00000000-0000-0000-0000-000000000001",
				"mode":"payment"
			}`,
			wantProv: 0, wantStatus: http.StatusOK,
		},
		{
			name:      "subscription created (sending)",
			eventType: "customer.subscription.created",
			objectJSON: `{
				"id":"sub_1","customer":"cus_1","status":"active",
				"current_period_end":1735689600,
				"items":{"data":[{"price":{"id":"price_sending"}}]},
				"metadata":{"tenant_id":"00000000-0000-0000-0000-000000000001","tenant_slug":"acme"}
			}`,
			wantProv: 1, wantStatus: http.StatusOK,
		},
		{
			name:      "subscription deleted",
			eventType: "customer.subscription.deleted",
			objectJSON: `{
				"id":"sub_1","customer":"cus_1","status":"canceled",
				"current_period_end":1735689600,
				"items":{"data":[{"price":{"id":"price_sending"}}]},
				"metadata":{"tenant_id":"00000000-0000-0000-0000-000000000001"}
			}`,
			wantDeprov: 1, wantStatus: http.StatusOK,
		},
		{
			name:      "charge refunded full",
			eventType: "charge.refunded",
			objectJSON: `{
				"id":"ch_1","customer":"cus_1","amount":1000,"amount_refunded":1000,"refunded":true
			}`,
			wantRefund: 1, wantStatus: http.StatusOK,
		},
		{
			name:       "unknown event acks",
			eventType:  "tax.settings.updated",
			objectJSON: `{}`,
			wantStatus: http.StatusOK,
		},
	}
	secret := "whsec_test"
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			prov := &stubProvisioner{}
			aff := &stubAffiliate{}
			body := []byte(fmt.Sprintf(
				`{"id":"evt_%s","type":"%s","created":%d,"data":{"object":%s}}`,
				strings.ReplaceAll(tc.name, " ", "_"), tc.eventType,
				time.Now().Unix(), tc.objectJSON,
			))
			h := &WebhookHandler{
				Secret:      secret,
				Provisioner: prov,
				Affiliates:  aff,
				Prices:      prices,
				Repo:        nil, // exercise the no-repo path
				Now:         time.Now,
			}
			req := httptest.NewRequest(http.MethodPost, "/api/public/stripe/webhook",
				strings.NewReader(string(body)))
			req.Header.Set("Stripe-Signature", sign(secret, time.Now().Unix(), body))
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("status: got %d want %d (body=%s)", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if got := len(prov.provisioned); got != tc.wantProv {
				t.Fatalf("provisioned: got %d want %d", got, tc.wantProv)
			}
			if got := len(prov.deprovisioned); got != tc.wantDeprov {
				t.Fatalf("deprovisioned: got %d want %d", got, tc.wantDeprov)
			}
			if got := len(aff.calls); got != tc.wantRefund {
				t.Fatalf("refund-reversals: got %d want %d", got, tc.wantRefund)
			}
		})
	}
}

func assertWebhookError(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, wantCode string) {
	t.Helper()
	if rec.Code != wantStatus {
		t.Fatalf("status: got %d want %d (body=%s)", rec.Code, wantStatus, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("content-type: got %q, want application/json", got)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode error envelope: %v (body=%s)", err, rec.Body.String())
	}
	if body.Error.Code != wantCode {
		t.Fatalf("error code: got %q want %q (body=%s)", body.Error.Code, wantCode, rec.Body.String())
	}
}

func TestWebhookRejectsNonPostWithJSON(t *testing.T) {
	h := &WebhookHandler{Secret: "whsec_test", Now: time.Now}
	req := httptest.NewRequest(http.MethodGet, "/api/public/stripe/webhook", nil)
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	if rec.Header().Get("Allow") != http.MethodPost {
		t.Fatalf("allow header: got %q want %q", rec.Header().Get("Allow"), http.MethodPost)
	}
	assertWebhookError(t, rec, http.StatusMethodNotAllowed, "method_not_allowed")
}

func TestWebhookRejectsBadSignature(t *testing.T) {
	h := &WebhookHandler{Secret: "whsec_test", Now: time.Now}
	body, _ := json.Marshal(StripeEvent{ID: "evt_x", Type: "noop"})
	req := httptest.NewRequest(http.MethodPost, "/api/public/stripe/webhook", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Stripe-Signature", "t=0,v1=deadbeef")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	assertWebhookError(t, rec, http.StatusBadRequest, "invalid_signature")
}

func TestWebhookRejectsOversizedBody(t *testing.T) {
	h := &WebhookHandler{Secret: "whsec_test", Now: time.Now}
	req := httptest.NewRequest(http.MethodPost, "/api/public/stripe/webhook",
		strings.NewReader(strings.Repeat("x", int(stripeWebhookMaxBodyBytes)+1)))
	rec := httptest.NewRecorder()

	h.ServeHTTP(rec, req)

	assertWebhookError(t, rec, http.StatusRequestEntityTooLarge, "payload_too_large")
}

func TestWebhookRejectsMalformedEventEnvelope(t *testing.T) {
	secret := "whsec_test"
	body := []byte(`{"data":{"object":{}}}`)
	h := &WebhookHandler{Secret: secret, Now: time.Now}
	req := httptest.NewRequest(http.MethodPost, "/api/public/stripe/webhook", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Stripe-Signature", sign(secret, time.Now().Unix(), body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	assertWebhookError(t, rec, http.StatusBadRequest, "malformed_event")
}
