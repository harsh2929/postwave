// SPDX-License-Identifier: AGPL-3.0-only
package crm_integrations

import (
	"net/http"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

// Salesforce live read-path certification still uses static-token SOQL for
// Contacts+Leads. Managed OAuth exists, but OAuth install/refresh/revocation
// and CDC require separate live-org certification.
func salesforceLiveObjects() []string { return []string{"contacts", "leads"} }

func salesforceLiveRequiredChecks() []string {
	// Salesforce Wave 2 adds managed OAuth install/refresh/revocation + a
	// scheduled worker. CDC/Platform-Events streaming (replay IDs) is a deliberate
	// follow-on, so there is no webhook_signature_verify check here.
	checks := []string{}
	for _, object := range salesforceLiveObjects() {
		checks = append(checks, "backfill_"+object)
	}
	return append(checks, crmLiveManualChecks("manual_oauth_install", "manual_oauth_refresh")...)
}

func TestSalesforceLiveCertificationEvidenceContract(t *testing.T) {
	assertCRMEvidenceContract(t, ProviderSalesforce, salesforceLiveRequiredChecks())
}

func TestSalesforceLiveCertificationBackfillReadPaths(t *testing.T) {
	requireCRMLiveCertification(t)
	token := livecert.Env("SALESFORCE_ACCESS_TOKEN")
	instanceURL := livecert.Env("SALESFORCE_INSTANCE_URL")
	if token == "" || instanceURL == "" {
		t.Skip("SALESFORCE_ACCESS_TOKEN and SALESFORCE_INSTANCE_URL are required for live Salesforce read certification")
	}
	rec := crmLiveRecorder(ProviderSalesforce)
	backfiller := SalesforceRESTBackfiller{
		HTTPClient:  &http.Client{Timeout: 20 * time.Second},
		Credentials: fakeSalesforceCredentialResolver{creds: SalesforceCredentials{AccessToken: token, InstanceURL: instanceURL, APIVersion: livecert.Env("SALESFORCE_API_VERSION"), UserAgent: crmLiveUserAgent}},
		APIVersion:  livecert.Env("SALESFORCE_API_VERSION"),
		UserAgent:   crmLiveUserAgent,
		BatchSize:   1,
	}
	integration := crmLiveIntegration(ProviderSalesforce, map[string]any{"org_id": livecert.Env("SALESFORCE_ORG_ID")})
	runCRMLiveBackfill(t, rec, backfiller, integration, salesforceLiveObjects(), func(object string) string {
		return encodeSalesforceCursor(salesforceCursorState{Object: object})
	})
}

func TestSalesforceLiveCertificationReportCompleteness(t *testing.T) {
	validateCRMLiveReport(t, ProviderSalesforce, salesforceLiveRequiredChecks())
}
