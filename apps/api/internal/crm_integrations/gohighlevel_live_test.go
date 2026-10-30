// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"net/http"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

// GoHighLevel Wave 2 adds managed LeadConnect (HighLevel) OAuth install/refresh +
// a scheduled contacts worker. The read-path certification pulls the Contacts
// API for the connected location.
func highLevelLiveObjects() []string { return []string{"contacts"} }

func highLevelLiveRequiredChecks() []string {
	checks := []string{}
	for _, object := range highLevelLiveObjects() {
		checks = append(checks, "backfill_"+object)
	}
	return append(checks, crmLiveManualChecks("manual_oauth_install", "manual_oauth_refresh")...)
}

func TestHighLevelLiveCertificationEvidenceContract(t *testing.T) {
	assertCRMEvidenceContract(t, ProviderHighLevel, highLevelLiveRequiredChecks())
}

func TestHighLevelLiveCertificationBackfillReadPaths(t *testing.T) {
	requireCRMLiveCertification(t)
	token := livecert.Env("GOHIGHLEVEL_ACCESS_TOKEN")
	if token == "" {
		t.Skip("GOHIGHLEVEL_ACCESS_TOKEN (OAuth access token) is required for live GoHighLevel read certification")
	}
	rec := crmLiveRecorder(ProviderHighLevel)
	backfiller := HighLevelRESTBackfiller{
		HTTPClient:  &http.Client{Timeout: 20 * time.Second},
		Credentials: fakeHighLevelCredentialResolver{creds: HighLevelCredentials{AccessToken: token, LocationID: livecert.Env("GOHIGHLEVEL_LOCATION_ID"), APIBaseURL: livecert.Env("GOHIGHLEVEL_API_BASE_URL"), UserAgent: crmLiveUserAgent}},
		APIBaseURL:  livecert.Env("GOHIGHLEVEL_API_BASE_URL"),
		UserAgent:   crmLiveUserAgent,
		PageSize:    1,
	}
	integration := crmLiveIntegration(ProviderHighLevel, map[string]any{"location_id": livecert.Env("GOHIGHLEVEL_LOCATION_ID")})
	runCRMLiveBackfill(t, rec, backfiller, integration, highLevelLiveObjects(), func(object string) string {
		return encodeHighLevelCursor(highLevelCursorState{Object: object})
	})
}

func TestHighLevelLiveCertificationReportCompleteness(t *testing.T) {
	validateCRMLiveReport(t, ProviderHighLevel, highLevelLiveRequiredChecks())
}
