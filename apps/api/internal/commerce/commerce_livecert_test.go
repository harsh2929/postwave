// SPDX-License-Identifier: AGPL-3.0-only
package commerce

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

// Shared scaffolding for native commerce/payments live certification harnesses.
//
// Each connector ships its own <provider>_live_test.go that supplies the
// provider-specific backfiller construction, webhook signature round-trip, and
// required-evidence list, while the cross-provider plumbing (evidence recorder,
// opt-in gate, REST read runner, completeness validation) lives here.
//
// Promotion gate: a connector may only be flipped from RuntimePartial to
// RuntimeAvailable (catalog.go RuntimeStatus + the
// isNativeRuntimeCompleteLiveCertificationPending allowlist in
// internal/integrations/contracts.go) once
// `<PROVIDER>` evidence passes the env-gated ReportCompleteness test below
// against a real merchant account, including the hand-appended manual_* rows.
const (
	commerceLiveCertificationEnv  = "COMMERCE_LIVE_CERTIFICATION"
	commerceLiveReportEnv         = "COMMERCE_LIVE_CERTIFICATION_REPORT"
	commerceLiveValidateReportEnv = "COMMERCE_LIVE_CERTIFICATION_VALIDATE_REPORT"
	commerceLiveTenantID          = "commerce-live-certification"
	commerceLiveCredentialRef     = "commerce-live-env"
)

func commerceLiveRecorder(provider string) *livecert.Recorder {
	return &livecert.Recorder{Provider: provider, ReportPath: livecert.Env(commerceLiveReportEnv)}
}

func requireCommerceLiveCertification(t *testing.T) {
	t.Helper()
	if !livecert.Bool(commerceLiveCertificationEnv) {
		t.Skip(commerceLiveCertificationEnv + "=1 not set; skipping commerce live certification")
	}
}

func recordCommerceEvidence(t *testing.T, rec *livecert.Recorder, check string, details map[string]any) {
	t.Helper()
	if err := rec.Record(check, details); err != nil {
		t.Fatalf("record %s live certification evidence: %v", rec.Provider, err)
	}
}

func commerceLiveIntegration(provider string, settings map[string]any) Integration {
	if settings == nil {
		settings = map[string]any{}
	}
	settings["default_tags"] = []string{"commerce-live-certification"}
	settings["limit"] = "1"
	settings["credential_ref"] = commerceLiveCredentialRef
	return Integration{
		ID:       provider + "-live-certification",
		TenantID: commerceLiveTenantID,
		Provider: provider,
		Status:   "connected",
		Settings: settings,
	}
}

// commerceLiveManualChecks are evidence rows that only a human operator can
// witness against a real account; the certification report is intentionally
// incomplete until these are appended (see docs/integrations/commerce-live-certification.md).
func commerceLiveManualChecks(extra ...string) []string {
	base := []string{
		"manual_webhook_delivery",
		"manual_disconnect_cleanup",
		"manual_reconnect_resume",
		"manual_rate_limit_retry_after",
		"manual_data_delete_behavior",
		"manual_credential_rotation",
	}
	return append(base, extra...)
}

// commerceLiveRequiredChecks builds the full required-evidence list: one
// backfill_<object> row per provider object, the automated webhook signature
// verification, and the shared manual_* rows plus any connector-specific extras.
func commerceLiveRequiredChecks(objects []string, manualExtra ...string) []string {
	checks := make([]string, 0, len(objects)+1+6+len(manualExtra))
	for _, object := range objects {
		checks = append(checks, "backfill_"+object)
	}
	checks = append(checks, "webhook_signature_verify")
	checks = append(checks, commerceLiveManualChecks(manualExtra...)...)
	return checks
}

// commerceLiveRESTBackfiller is the uniform shape of the REST commerce backfillers
// (Stripe, WooCommerce, BigCommerce, Square). Shopify uses a distinct bulk path.
type commerceLiveRESTBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

// runCommerceLiveBackfill exercises each object's first page against the live
// provider and records sanitized per-object evidence.
func runCommerceLiveBackfill(t *testing.T, rec *livecert.Recorder, backfiller commerceLiveRESTBackfiller, integration Integration, objects []string, cursorFor func(object string) string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	for _, object := range objects {
		object := object
		t.Run(object, func(t *testing.T) {
			req, err := backfiller.BackfillPage(ctx, commerceLiveTenantID, integration, cursorFor(object))
			if err != nil {
				t.Fatalf("live %s %s page failed: %v", rec.Provider, object, err)
			}
			recordCommerceEvidence(t, rec, "backfill_"+object, map[string]any{
				"object":         object,
				"customers":      len(req.Customers),
				"products":       len(req.Products),
				"orders":         len(req.Orders),
				"events":         len(req.ProviderEvents),
				"cursor_present": strings.TrimSpace(req.Cursor) != "",
			})
			t.Logf("live %s %s page ok: customers=%d products=%d orders=%d cursor_present=%t",
				rec.Provider, object, len(req.Customers), len(req.Products), len(req.Orders), strings.TrimSpace(req.Cursor) != "")
		})
	}
}

// assertCommerceEvidenceContract is the credential-free guarantee that the
// completeness validator accepts a full synthetic report and rejects one with
// any required check missing. Runs in normal CI with no provider traffic.
func assertCommerceEvidenceContract(t *testing.T, provider string, required []string) {
	t.Helper()
	complete := make([]livecert.Evidence, 0, len(required))
	for _, check := range required {
		complete = append(complete, livecert.Evidence{
			Provider:   provider,
			Check:      check,
			Status:     livecert.StatusPassed,
			RecordedAt: "2026-06-20T00:00:00Z",
		})
	}
	if err := livecert.ValidateCompleteness(provider, complete, required); err != nil {
		t.Fatalf("complete %s evidence should validate: %v", provider, err)
	}
	if len(required) > 0 {
		if err := livecert.ValidateCompleteness(provider, complete[:len(complete)-1], required); err == nil {
			t.Fatalf("incomplete %s evidence should fail completeness", provider)
		}
	}
}

// validateCommerceLiveReport is the env-gated promotion gate run after a live
// certification pass; it fails unless every required automated and manual row
// is present in the on-disk evidence report for the provider.
func validateCommerceLiveReport(t *testing.T, provider string, required []string) {
	t.Helper()
	if !livecert.Bool(commerceLiveValidateReportEnv) {
		t.Skip(commerceLiveValidateReportEnv + "=1 not set; skipping " + provider + " live certification report completeness check")
	}
	reportPath := livecert.Env(commerceLiveReportEnv)
	if reportPath == "" {
		t.Fatal(commerceLiveReportEnv + " is required when validating commerce live certification evidence")
	}
	entries, err := livecert.ReadReport(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := livecert.ValidateCompleteness(provider, entries, required); err != nil {
		t.Fatal(err)
	}
}

// signBase64HMACSHA256 reproduces Shopify/WooCommerce raw-body webhook signing
// for the credential-free verifier round-trip.
func signBase64HMACSHA256(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return base64.StdEncoding.EncodeToString(mac.Sum(nil))
}

// assertBase64HMACWebhookRoundTrip proves a raw-body base64 HMAC-SHA256 verifier
// accepts a correctly-signed payload and rejects a tampered one, then records
// the automated webhook_signature_verify evidence row.
func assertBase64HMACWebhookRoundTrip(t *testing.T, rec *livecert.Recorder, verify func(secret string, body []byte, header string) error) {
	t.Helper()
	secret := "whsec_livecert_" + rec.Provider
	body := []byte(`{"id":"livecert","provider":"` + rec.Provider + `"}`)
	if err := verify(secret, body, signBase64HMACSHA256(secret, body)); err != nil {
		t.Fatalf("%s webhook verifier rejected a valid signature: %v", rec.Provider, err)
	}
	if err := verify(secret, body, signBase64HMACSHA256(secret, append(append([]byte{}, body...), '!'))); err == nil {
		t.Fatalf("%s webhook verifier accepted a tampered signature", rec.Provider)
	}
	recordCommerceEvidence(t, rec, "webhook_signature_verify", map[string]any{"algorithm": "base64_hmac_sha256_raw_body"})
}
