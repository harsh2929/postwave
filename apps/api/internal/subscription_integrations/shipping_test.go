// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func verifyBase64HMACSHA256TestSig(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

type fakeShippingSecretResolver struct{ json string }

func (f fakeShippingSecretResolver) Get(_ context.Context, _ string) (string, error) {
	return f.json, nil
}
func (f fakeShippingSecretResolver) GetJSON(_ context.Context, _ string, out any) error {
	switch dst := out.(type) {
	case *afterShipCredentialPayload:
		return json.Unmarshal([]byte(f.json), dst)
	case *shipStationCredentialPayload:
		return json.Unmarshal([]byte(f.json), dst)
	}
	return errNotJSONSecret
}

func TestAfterShipBackfillMapsTrackings(t *testing.T) {
	var gotPath, gotKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotKey = r.Header.Get("aftership-api-key")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]any{
				"page": 1, "limit": 100,
				"trackings": []map[string]any{
					{"id": "t1", "tracking_number": "1Z999", "slug": "ups", "tag": "OutForDelivery", "emails": []string{"Ship@Example.com"}, "updated_at": "2026-06-20T10:00:00+00:00"},
				},
			},
		})
	}))
	defer srv.Close()

	backfiller := AfterShipRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: AfterShipSecretsCredentialResolver{Secrets: fakeShippingSecretResolver{json: `{"api_key":"as_key"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderAfterShip, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/trackings") || gotKey != "as_key" {
		t.Fatalf("path=%q key=%q", gotPath, gotKey)
	}
	if len(req.Shipments) != 1 {
		t.Fatalf("shipments = %d", len(req.Shipments))
	}
	s := req.Shipments[0]
	if s.Email != "ship@example.com" || s.TrackingNumber != "1Z999" || s.Carrier != "ups" || s.Status != "OutForDelivery" {
		t.Fatalf("mapped shipment = %+v", s)
	}
	if s.SourceID != "aftership://tracking/t1" {
		t.Fatalf("source id = %q", s.SourceID)
	}
}

func TestShipStationBackfillMapsOrders(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"orders": []map[string]any{
				{"orderNumber": "SO-1", "orderStatus": "shipped", "customerEmail": "Buyer@Example.com", "modifyDate": "2026-06-20T10:00:00", "advancedOptions": map[string]any{"carrierCode": "fedex"}},
			},
			"total": 1, "page": 1, "pages": 1,
		})
	}))
	defer srv.Close()

	backfiller := ShipStationRESTBackfiller{
		HTTPClient:  srv.Client(),
		Credentials: ShipStationSecretsCredentialResolver{Secrets: fakeShippingSecretResolver{json: `{"api_key":"k","api_secret":"s"}`}},
		APIBaseURL:  srv.URL,
	}
	req, err := backfiller.BackfillPage(context.Background(), "tenant-1", Integration{Provider: ProviderShipStation, CredentialsRef: "c"}, "")
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if !strings.Contains(gotPath, "/orders") {
		t.Fatalf("path = %q", gotPath)
	}
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("k:s"))
	if gotAuth != wantAuth {
		t.Fatalf("auth = %q, want %q", gotAuth, wantAuth)
	}
	if len(req.Shipments) != 1 {
		t.Fatalf("shipments = %d", len(req.Shipments))
	}
	s := req.Shipments[0]
	if s.Email != "buyer@example.com" || s.OrderID != "SO-1" || s.Status != "shipped" || s.Carrier != "fedex" {
		t.Fatalf("mapped shipment = %+v", s)
	}
}

func TestVerifyAfterShipWebhookRoundTrip(t *testing.T) {
	secret := "as_webhook_secret"
	body := []byte(`{"msg":{"tracking_number":"1Z"}}`)
	header := verifyBase64HMACSHA256TestSig(secret, body)
	if err := VerifyAfterShipTrackingWebhookSignature(secret, body, header); err != nil {
		t.Fatalf("valid signature rejected: %v", err)
	}
	if err := VerifyAfterShipTrackingWebhookSignature(secret, append(body, '!'), header); err == nil {
		t.Fatal("tampered body accepted")
	}
}
