// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

// HubSpot's managed OAuth slice includes install/refresh/revocation, scheduled
// backfill, and OAuth-install app webhooks. Private-app credentials are
// polling-only. Certification covers reads, signature verification, and manual
// appId+portalId delivery/settings evidence.
func hubSpotLiveObjects() []string { return []string{"contacts"} }

func hubSpotLiveRequiredChecks() []string {
	checks := []string{"backfill_contacts", "webhook_signature_verify"}
	return append(checks, crmLiveManualChecks(
		"manual_oauth_install",
		"manual_oauth_refresh",
		"manual_webhook_settings_and_property_subscriptions",
		"manual_webhook_delivery",
	)...)
}

func TestHubSpotLiveCertificationEvidenceContract(t *testing.T) {
	assertCRMEvidenceContract(t, ProviderHubSpot, hubSpotLiveRequiredChecks())
}

// TestHubSpotLiveCertificationWebhookSignature is a credential-free round-trip of
// the real v3 verifier crypto, recording the automated webhook evidence row.
func TestHubSpotLiveCertificationWebhookSignature(t *testing.T) {
	rec := crmLiveRecorder(ProviderHubSpot)
	now := time.Date(2026, 6, 20, 12, 0, 0, 0, time.UTC)
	secret := "whsec_livecert_hubspot"
	method := http.MethodPost
	uri := "https://app.postwave.test/api/public/crm-integrations/hubspot/webhooks"
	body := []byte(`[{"eventId":1,"subscriptionType":"contact.creation","appId":1,"portalId":1,"objectId":1}]`)
	ts := strconv.FormatInt(now.UnixMilli(), 10)
	sig := hubSpotV3Signature(secret, method, uri, body, ts)

	if err := VerifyHubSpotWebhookV3(secret, method, uri, body, sig, ts, now, 5*time.Minute); err != nil {
		t.Fatalf("hubspot webhook verifier rejected a valid signature: %v", err)
	}
	if err := VerifyHubSpotWebhookV3(secret, method, uri, append(append([]byte{}, body...), '!'), sig, ts, now, 5*time.Minute); err == nil {
		t.Fatal("hubspot webhook verifier accepted a tampered body")
	}
	recordCRMEvidence(t, rec, "webhook_signature_verify", map[string]any{"algorithm": "hubspot_v3_hmac_sha256"})
}

func TestHubSpotLiveCertificationBackfillReadPaths(t *testing.T) {
	requireCRMLiveCertification(t)
	token := livecert.Env("HUBSPOT_ACCESS_TOKEN")
	if token == "" {
		t.Skip("HUBSPOT_ACCESS_TOKEN (private app or OAuth token) is required for live HubSpot read certification")
	}
	rec := crmLiveRecorder(ProviderHubSpot)
	backfiller := HubSpotRESTBackfiller{
		HTTPClient:  &http.Client{Timeout: 20 * time.Second},
		Credentials: fakeHubSpotCredentialResolver{creds: HubSpotCredentials{AccessToken: token, APIBaseURL: livecert.Env("HUBSPOT_API_BASE_URL"), UserAgent: crmLiveUserAgent}},
		APIBaseURL:  livecert.Env("HUBSPOT_API_BASE_URL"),
		APIVersion:  livecert.Env("HUBSPOT_API_VERSION"),
		UserAgent:   crmLiveUserAgent,
		PageSize:    1,
	}
	integration := crmLiveIntegration(ProviderHubSpot, map[string]any{"portal_id": livecert.Env("HUBSPOT_PORTAL_ID")})
	runCRMLiveBackfill(t, rec, backfiller, integration, hubSpotLiveObjects(), func(object string) string {
		return encodeHubSpotCursor(hubSpotCursorState{Object: object})
	})
}

func TestHubSpotLiveCertificationReportCompleteness(t *testing.T) {
	validateCRMLiveReport(t, ProviderHubSpot, hubSpotLiveRequiredChecks())
}
