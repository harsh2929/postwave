// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"net/http"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

// Keap live certification currently automates REST v2 Contacts read paths.
// OAuth refresh for OAuth credentials, scheduled retry, and local managed
// credential cleanup have local coverage but still need live evidence. REST
// Hooks are a follow-on.
func keapLiveObjects() []string { return []string{"contacts"} }

func keapLiveRequiredChecks() []string {
	checks := []string{}
	for _, object := range keapLiveObjects() {
		checks = append(checks, "backfill_"+object)
	}
	return append(checks, crmLiveManualChecks("manual_oauth_install", "manual_oauth_refresh", "manual_local_managed_credential_cleanup")...)
}

func TestKeapLiveCertificationEvidenceContract(t *testing.T) {
	assertCRMEvidenceContract(t, ProviderKeap, keapLiveRequiredChecks())
}

func TestKeapLiveCertificationBackfillReadPaths(t *testing.T) {
	requireCRMLiveCertification(t)
	token := livecert.Env("KEAP_ACCESS_TOKEN")
	if token == "" {
		t.Skip("KEAP_ACCESS_TOKEN (OAuth, PAT, or SAK) is required for live Keap read certification")
	}
	rec := crmLiveRecorder(ProviderKeap)
	backfiller := KeapRESTBackfiller{
		HTTPClient:  &http.Client{Timeout: 20 * time.Second},
		Credentials: fakeKeapCredentialResolver{creds: KeapCredentials{AccessToken: token, APIBaseURL: livecert.Env("KEAP_API_BASE_URL"), UserAgent: crmLiveUserAgent}},
		APIBaseURL:  livecert.Env("KEAP_API_BASE_URL"),
		UserAgent:   crmLiveUserAgent,
		PageSize:    1,
	}
	integration := crmLiveIntegration(ProviderKeap, map[string]any{"account_id": livecert.Env("KEAP_ACCOUNT_ID")})
	runCRMLiveBackfill(t, rec, backfiller, integration, keapLiveObjects(), func(object string) string {
		return encodeKeapCursor(keapCursorState{Object: object})
	})
}

func TestKeapLiveCertificationReportCompleteness(t *testing.T) {
	validateCRMLiveReport(t, ProviderKeap, keapLiveRequiredChecks())
}
