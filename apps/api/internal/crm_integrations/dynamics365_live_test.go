// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"net/http"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

// Microsoft Dynamics 365 live certification currently automates Dataverse
// Contacts+Leads read paths. OAuth refresh, scheduled retry, and local managed
// credential cleanup have local coverage but still need live evidence. Change
// tracking/service-endpoint webhooks are a follow-on.
func dynamics365LiveObjects() []string { return []string{"contacts", "leads"} }

func dynamics365LiveRequiredChecks() []string {
	checks := []string{}
	for _, object := range dynamics365LiveObjects() {
		checks = append(checks, "backfill_"+object)
	}
	return append(checks, crmLiveManualChecks("manual_oauth_install", "manual_oauth_refresh", "manual_local_managed_credential_cleanup")...)
}

func TestDynamics365LiveCertificationEvidenceContract(t *testing.T) {
	assertCRMEvidenceContract(t, ProviderDynamics365, dynamics365LiveRequiredChecks())
}

func TestDynamics365LiveCertificationBackfillReadPaths(t *testing.T) {
	requireCRMLiveCertification(t)
	token := livecert.Env("DYNAMICS365_ACCESS_TOKEN")
	environmentURL := livecert.Env("DYNAMICS365_ENVIRONMENT_URL")
	if token == "" || environmentURL == "" {
		t.Skip("DYNAMICS365_ACCESS_TOKEN and DYNAMICS365_ENVIRONMENT_URL are required for live Microsoft Dynamics 365 read certification")
	}
	rec := crmLiveRecorder(ProviderDynamics365)
	backfiller := Dynamics365RESTBackfiller{
		HTTPClient:  &http.Client{Timeout: 20 * time.Second},
		Credentials: fakeDynamics365CredentialResolver{creds: Dynamics365Credentials{AccessToken: token, EnvironmentURL: environmentURL, APIVersion: livecert.Env("DYNAMICS365_API_VERSION"), UserAgent: crmLiveUserAgent}},
		APIVersion:  livecert.Env("DYNAMICS365_API_VERSION"),
		UserAgent:   crmLiveUserAgent,
		PageSize:    1,
	}
	integration := crmLiveIntegration(ProviderDynamics365, map[string]any{"environment_url": environmentURL})
	runCRMLiveBackfill(t, rec, backfiller, integration, dynamics365LiveObjects(), func(object string) string {
		return encodeDynamics365Cursor(dynamics365CursorState{Object: object})
	})
}

func TestDynamics365LiveCertificationReportCompleteness(t *testing.T) {
	validateCRMLiveReport(t, ProviderDynamics365, dynamics365LiveRequiredChecks())
}
