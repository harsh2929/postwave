// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

// Shared scaffolding for native CRM live certification harnesses (HubSpot,
// Salesforce, Zoho, Microsoft Dynamics 365, Keap). Pipedrive keeps its own,
// richer harness (pipedrive_live_test.go) because it additionally implements
// OAuth, managed webhooks, and a scheduled worker.
//
// IMPORTANT honesty boundary: this shared harness certifies the currently
// live-tested CRM read paths. Zoho, Microsoft Dynamics 365, and Keap also have
// local OAuth refresh/scheduled retry/manual retry/local cleanup coverage, but
// their live harnesses still automate only the first-page read paths plus manual
// evidence rows. Provider webhooks/object fanout/live cleanup proof remain
// promotion gates. See docs/integrations/crm-live-certification.md.
const (
	crmLiveCertificationEnv  = "CRM_LIVE_CERTIFICATION"
	crmLiveReportEnv         = "CRM_LIVE_CERTIFICATION_REPORT"
	crmLiveValidateReportEnv = "CRM_LIVE_CERTIFICATION_VALIDATE_REPORT"
	crmLiveTenantID          = "crm-live-certification"
	crmLiveCredentialRef     = "crm-live-env"
	crmLiveUserAgent         = "Moosewave CRM Live Certification"
)

func crmLiveRecorder(provider string) *livecert.Recorder {
	return &livecert.Recorder{Provider: provider, ReportPath: livecert.Env(crmLiveReportEnv)}
}

func requireCRMLiveCertification(t *testing.T) {
	t.Helper()
	if !livecert.Bool(crmLiveCertificationEnv) {
		t.Skip(crmLiveCertificationEnv + "=1 not set; skipping CRM live certification")
	}
}

func recordCRMEvidence(t *testing.T, rec *livecert.Recorder, check string, details map[string]any) {
	t.Helper()
	if err := rec.Record(check, details); err != nil {
		t.Fatalf("record %s live certification evidence: %v", rec.Provider, err)
	}
}

func crmLiveIntegration(provider string, settings map[string]any) Integration {
	if settings == nil {
		settings = map[string]any{}
	}
	settings["default_tags"] = []string{"crm-live-certification"}
	return Integration{
		ID:             provider + "-live-certification",
		TenantID:       crmLiveTenantID,
		Provider:       provider,
		Name:           provider + " live certification",
		Status:         "connected",
		CredentialsRef: crmLiveCredentialRef,
		Settings:       settings,
	}
}

// crmLiveManualChecks are evidence rows only a human operator can witness against
// a real CRM org. There is deliberately no manual_webhook_delivery row: these
// connectors do not implement provider webhooks yet.
func crmLiveManualChecks(extra ...string) []string {
	base := []string{
		"manual_disconnect_cleanup",
		"manual_reconnect_resume",
		"manual_rate_limit_retry_after",
		"manual_data_delete_behavior",
		"manual_credential_rotation",
	}
	return append(base, extra...)
}

// crmLiveReadPathRequiredChecks builds the read-path required-evidence list: one
// backfill_<object> row per pulled object plus the shared manual_* rows. It does
// NOT include a webhook check — these connectors are pull-only.
func crmLiveReadPathRequiredChecks(objects []string, manualExtra ...string) []string {
	checks := make([]string, 0, len(objects)+5+len(manualExtra))
	for _, object := range objects {
		checks = append(checks, "backfill_"+object)
	}
	return append(checks, crmLiveManualChecks(manualExtra...)...)
}

// crmLiveBackfiller is the uniform shape of the CRM REST/SOQL backfillers.
type crmLiveBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

// runCRMLiveBackfill exercises each object's first page against the live CRM org
// and records sanitized per-object evidence.
func runCRMLiveBackfill(t *testing.T, rec *livecert.Recorder, backfiller crmLiveBackfiller, integration Integration, objects []string, cursorFor func(object string) string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	for _, object := range objects {
		object := object
		t.Run(object, func(t *testing.T) {
			req, err := backfiller.BackfillPage(ctx, crmLiveTenantID, integration, cursorFor(object))
			if err != nil {
				t.Fatalf("live %s %s page failed: %v", rec.Provider, object, err)
			}
			recordCRMEvidence(t, rec, "backfill_"+object, map[string]any{
				"object":         object,
				"run_mode":       req.RunMode,
				"contacts":       len(req.Contacts),
				"events":         len(req.Events),
				"cursor_present": strings.TrimSpace(req.Cursor) != "",
			})
			t.Logf("live %s %s page ok: contacts=%d events=%d cursor_present=%t",
				rec.Provider, object, len(req.Contacts), len(req.Events), strings.TrimSpace(req.Cursor) != "")
		})
	}
}

// assertCRMEvidenceContract is the credential-free guarantee that the completeness
// validator accepts a full synthetic report and rejects one with any required
// check missing. Runs in normal CI with no provider traffic.
func assertCRMEvidenceContract(t *testing.T, provider string, required []string) {
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

// validateCRMLiveReport is the env-gated read-path certification gate.
func validateCRMLiveReport(t *testing.T, provider string, required []string) {
	t.Helper()
	if !livecert.Bool(crmLiveValidateReportEnv) {
		t.Skip(crmLiveValidateReportEnv + "=1 not set; skipping " + provider + " live certification report completeness check")
	}
	reportPath := livecert.Env(crmLiveReportEnv)
	if reportPath == "" {
		t.Fatal(crmLiveReportEnv + " is required when validating CRM live certification evidence")
	}
	entries, err := livecert.ReadReport(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := livecert.ValidateCompleteness(provider, entries, required); err != nil {
		t.Fatal(err)
	}
}
