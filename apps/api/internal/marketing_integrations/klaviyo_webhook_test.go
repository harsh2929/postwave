// SPDX-License-Identifier: AGPL-3.0-only
package marketing_integrations

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

type fakeKlaviyoWebhookStore struct {
	*fakeStore
	claimResult WebhookClaim
	claimErr    error
	claimedID   string
	processedID string
	failedID    string
}

func (f *fakeKlaviyoWebhookStore) FindKlaviyoIntegrationByWebhookToken(_ context.Context, token string) (*Integration, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, ErrNotFound
	}
	configured := firstString(
		settingString(f.integration.Settings, "klaviyo_webhook_token"),
		settingString(f.integration.Settings, "marketing_webhook_token"),
		settingString(f.integration.Settings, "webhook_token"),
	)
	if configured != token {
		return nil, ErrNotFound
	}
	return &f.integration, nil
}

func (f *fakeKlaviyoWebhookStore) ClaimMarketingWebhook(_ context.Context, _ string, _ string, _ string, webhookID, _ string, _ []byte) (WebhookClaim, error) {
	f.claimedID = webhookID
	if f.claimErr != nil {
		return "", f.claimErr
	}
	if f.claimResult != "" {
		return f.claimResult, nil
	}
	return WebhookClaimed, nil
}

func (f *fakeKlaviyoWebhookStore) MarkMarketingWebhookProcessed(_ context.Context, _ string, _ string, _ string, webhookID string) error {
	f.processedID = webhookID
	return nil
}

func (f *fakeKlaviyoWebhookStore) MarkMarketingWebhookFailed(_ context.Context, _ string, _ string, _ string, webhookID string, _ error) error {
	f.failedID = webhookID
	return nil
}

func TestVerifyKlaviyoWebhookSignature(t *testing.T) {
	body := []byte(`{"data":[]}`)
	timestamp := "Thu, 04 Jan 2024 18:05:25 GMT"
	now, err := http.ParseTime(timestamp)
	if err != nil {
		t.Fatal(err)
	}
	signature := signKlaviyoWebhookTest("secret", body, timestamp)
	if err := VerifyKlaviyoWebhookSignature("secret", body, timestamp, signature, now); err != nil {
		t.Fatalf("valid signature rejected: %v", err)
	}
	if err := VerifyKlaviyoWebhookSignature("secret", append(body, '!'), timestamp, signature, now); !errors.Is(err, ErrInvalidKlaviyoWebhookSignature) {
		t.Fatalf("tampered body err=%v", err)
	}
	if err := VerifyKlaviyoWebhookSignature("secret", body, timestamp, signature, now.Add(10*time.Minute)); !errors.Is(err, ErrStaleKlaviyoWebhookSignature) {
		t.Fatalf("stale timestamp err=%v", err)
	}
}

func TestKlaviyoWebhookRecordsSignedDelivery(t *testing.T) {
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	timestamp := now.Format(http.TimeFormat)
	body := []byte(`{
		"data":[{
			"external_id":"event_123",
			"payload":{
				"topic":"event:klaviyo.sent_sms",
				"data":{
					"type":"event",
					"id":"event_123",
					"relationships":{
						"profile":{"data":{"type":"profile","id":"profile_123"}},
						"metric":{"data":{"type":"metric","id":"metric_123"}}
					}
				}
			}
		}],
		"meta":{
			"klaviyo_webhook_id":"webhook_delivery_123",
			"klaviyo_account_id":"acct_123",
			"timestamp":"2026-06-30T12:00:00Z",
			"version":"2026-04-15"
		}
	}`)
	store := &fakeKlaviyoWebhookStore{fakeStore: newFakeStore()}
	store.integration.SyncCursor = encodeKlaviyoNativeCursor(klaviyoNativeCursor{Provider: ProviderKlaviyo, Phase: "source_events_checkpoint"})
	store.integration.Settings["klaviyo_webhook_token"] = "token_123"
	store.integration.Settings["klaviyo_webhook_secret_ref"] = "secret_ref"
	deps := &Deps{
		Repo:           store,
		WebhookSecrets: fakeKlaviyoSecretResolver{values: map[string]string{"secret_ref": "secret"}},
		Now:            func() time.Time { return now },
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	req := marketingReq(http.MethodPost, "/api/public/marketing-integrations/klaviyo/webhooks/token_123", string(body))
	req.Header.Set("Klaviyo-Timestamp", timestamp)
	req.Header.Set("Klaviyo-Signature", signKlaviyoWebhookTest("secret", body, timestamp))
	req.Header.Set("Klaviyo-Webhook-Id", "webhook_delivery_123")
	rec := httptestRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var out SyncSummary
	if err := json.NewDecoder(rec.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.RunID == "" || out.EventsSeen != 1 || out.ProfilesSeen != 1 || out.Metadata["native_klaviyo_webhook"] != true {
		t.Fatalf("summary=%+v", out)
	}
	if len(store.runs) != 1 || store.runs[0].RunMode != "webhook" || store.runs[0].Metadata["webhook_topic"] != "event:klaviyo.sent_sms" {
		t.Fatalf("runs=%+v", store.runs)
	}
	if store.claimedID != "webhook_delivery_123" || store.processedID != "webhook_delivery_123" || store.failedID != "" {
		t.Fatalf("claimed=%q processed=%q failed=%q", store.claimedID, store.processedID, store.failedID)
	}
	if !strings.HasPrefix(store.integration.SyncCursor, klaviyoNativeCursorPrefix) {
		t.Fatalf("webhook delivery should not clear polling cursor: %q", store.integration.SyncCursor)
	}
}

func TestKlaviyoWebhookRejectsMismatchedDeliveryID(t *testing.T) {
	now := time.Date(2026, 6, 30, 12, 0, 0, 0, time.UTC)
	timestamp := now.Format(http.TimeFormat)
	body := []byte(`{"data":[],"meta":{"klaviyo_webhook_id":"body_id","klaviyo_account_id":"acct_123"}}`)
	store := &fakeKlaviyoWebhookStore{fakeStore: newFakeStore()}
	store.integration.Settings["klaviyo_webhook_token"] = "token_123"
	store.integration.Settings["klaviyo_webhook_secret_ref"] = "secret_ref"
	deps := &Deps{
		Repo:           store,
		WebhookSecrets: fakeKlaviyoSecretResolver{values: map[string]string{"secret_ref": "secret"}},
		Now:            func() time.Time { return now },
	}
	router := chi.NewRouter()
	MountPublicRoutes(router, deps)
	req := marketingReq(http.MethodPost, "/api/public/marketing-integrations/klaviyo/webhooks/token_123", string(body))
	req.Header.Set("Klaviyo-Timestamp", timestamp)
	req.Header.Set("Klaviyo-Signature", signKlaviyoWebhookTest("secret", body, timestamp))
	req.Header.Set("Klaviyo-Webhook-Id", "header_id")
	rec := httptestRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest || store.claimedID != "" {
		t.Fatalf("status=%d body=%s claimed=%q", rec.Code, rec.Body.String(), store.claimedID)
	}
}

func signKlaviyoWebhookTest(secret string, body []byte, timestamp string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	_, _ = mac.Write([]byte(timestamp))
	return hex.EncodeToString(mac.Sum(nil))
}
