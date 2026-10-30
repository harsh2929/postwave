// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"net/http"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

// Zoho CRM live certification currently automates V8 Contacts+Leads read paths.
// OAuth refresh/revocation, scheduled retry, and disconnect cleanup have local
// coverage but still need live evidence. Notification API coverage is a
// follow-on.
func zohoLiveObjects() []string { return []string{"contacts", "leads"} }

func zohoLiveRequiredChecks() []string {
	// The Zoho Notification API (watch channels) is a follow-on, so there is no
	// webhook_signature_verify check here.
	checks := []string{}
	for _, object := range zohoLiveObjects() {
		checks = append(checks, "backfill_"+object)
	}
	return append(checks, crmLiveManualChecks("manual_oauth_install", "manual_oauth_refresh", "manual_disconnect_oauth_revocation")...)
}

func TestZohoLiveCertificationEvidenceContract(t *testing.T) {
	assertCRMEvidenceContract(t, ProviderZohoCRM, zohoLiveRequiredChecks())
}

func TestZohoLiveCertificationBackfillReadPaths(t *testing.T) {
	requireCRMLiveCertification(t)
	token := livecert.Env("ZOHO_ACCESS_TOKEN")
	apiBaseURL := livecert.Env("ZOHO_API_BASE_URL")
	dataCenter := livecert.Env("ZOHO_DATA_CENTER")
	if token == "" || (apiBaseURL == "" && dataCenter == "") {
		t.Skip("ZOHO_ACCESS_TOKEN and one of ZOHO_API_BASE_URL/ZOHO_DATA_CENTER are required for live Zoho CRM read certification")
	}
	rec := crmLiveRecorder(ProviderZohoCRM)
	backfiller := ZohoRESTBackfiller{
		HTTPClient:  &http.Client{Timeout: 20 * time.Second},
		Credentials: fakeZohoCredentialResolver{creds: ZohoCredentials{AccessToken: token, APIBaseURL: apiBaseURL, DataCenter: dataCenter, UserAgent: crmLiveUserAgent}},
		APIBaseURL:  apiBaseURL,
		APIVersion:  livecert.Env("ZOHO_API_VERSION"),
		UserAgent:   crmLiveUserAgent,
		PerPage:     1,
	}
	integration := crmLiveIntegration(ProviderZohoCRM, map[string]any{"organization_id": livecert.Env("ZOHO_ORGANIZATION_ID")})
	runCRMLiveBackfill(t, rec, backfiller, integration, zohoLiveObjects(), func(object string) string {
		return encodeZohoCursor(zohoCursorState{Object: object, Page: 1})
	})
}

func TestZohoLiveCertificationReportCompleteness(t *testing.T) {
	validateCRMLiveReport(t, ProviderZohoCRM, zohoLiveRequiredChecks())
}
