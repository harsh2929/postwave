// SPDX-License-Identifier: AGPL-3.0-only
package support_integrations

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

// Live-certification harness for the native support pullers, mirroring
// crm_livecert_test.go. Providers that still lack a puller certify via the
// support webhook-ingest subsystem (webhook-delivery evidence) instead.
// Credential-free evidence-contract subtests run in CI; read-path tests are
// env-gated and exercise each provider via its real SecretsCredentialResolver.
const (
	supportLiveCertificationEnv  = "SUPPORT_LIVE_CERTIFICATION"
	supportLiveReportEnv         = "SUPPORT_LIVE_CERTIFICATION_REPORT"
	supportLiveValidateReportEnv = "SUPPORT_LIVE_CERTIFICATION_VALIDATE_REPORT"
	supportLiveTenantID          = "support-live-certification"
	supportLiveCredentialRef     = "support-live-env"
)

type supportLiveEnvSecrets struct{ json string }

func (s supportLiveEnvSecrets) Get(_ context.Context, _ string) (string, error) { return s.json, nil }
func (s supportLiveEnvSecrets) GetJSON(_ context.Context, _ string, out any) error {
	if strings.TrimSpace(s.json) == "" {
		return errNotJSONSecret
	}
	return json.Unmarshal([]byte(s.json), out)
}

type supportLiveBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type supportLiveProvider struct {
	provider string
	envKey   string
	make     func(secrets SupportRuntimeSecretResolver) supportLiveBackfiller
}

func supportLiveProviders() []supportLiveProvider {
	return []supportLiveProvider{
		{ProviderZendesk, "SUPPORT_LIVE_ZENDESK", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return ZendeskRESTBackfiller{Credentials: ZendeskSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderIntercom, "SUPPORT_LIVE_INTERCOM", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return IntercomRESTBackfiller{Credentials: IntercomSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderGorgias, "SUPPORT_LIVE_GORGIAS", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return GorgiasRESTBackfiller{Credentials: GorgiasSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderFreshdesk, "SUPPORT_LIVE_FRESHDESK", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return FreshdeskRESTBackfiller{Credentials: FreshdeskSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderFreshchat, "SUPPORT_LIVE_FRESHCHAT", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return FreshchatRESTBackfiller{Credentials: FreshchatSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderTidio, "SUPPORT_LIVE_TIDIO", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return TidioRESTBackfiller{Credentials: TidioSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderAda, "SUPPORT_LIVE_ADA", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return AdaRESTBackfiller{Credentials: AdaSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderGladly, "SUPPORT_LIVE_GLADLY", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return GladlyRESTBackfiller{Credentials: GladlySecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderGroove, "SUPPORT_LIVE_GROOVE", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return GrooveRESTBackfiller{Credentials: GrooveSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderHelpCrunch, "SUPPORT_LIVE_HELPCRUNCH", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return HelpCrunchRESTBackfiller{Credentials: HelpCrunchSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderJiraServiceManagement, "SUPPORT_LIVE_JIRA_SERVICE_MANAGEMENT", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return JiraServiceManagementRESTBackfiller{Credentials: JiraServiceManagementSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderLinear, "SUPPORT_LIVE_LINEAR", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return LinearGraphQLBackfiller{Credentials: LinearSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderAsanaSupport, "SUPPORT_LIVE_ASANA_SUPPORT", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return AsanaSupportRESTBackfiller{Credentials: AsanaSupportSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderClickUpSupport, "SUPPORT_LIVE_CLICKUP_SUPPORT", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return ClickUpSupportRESTBackfiller{Credentials: ClickUpSupportSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderHelpScout, "SUPPORT_LIVE_HELPSCOUT", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return HelpScoutRESTBackfiller{Credentials: HelpScoutSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderReamaze, "SUPPORT_LIVE_REAMAZE", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return ReamazeRESTBackfiller{Credentials: ReamazeSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderFront, "SUPPORT_LIVE_FRONT", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return FrontRESTBackfiller{Credentials: FrontSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderCrisp, "SUPPORT_LIVE_CRISP", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return CrispRESTBackfiller{Credentials: CrispSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderKustomer, "SUPPORT_LIVE_KUSTOMER", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return KustomerRESTBackfiller{Credentials: KustomerSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderDrift, "SUPPORT_LIVE_DRIFT", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return DriftRESTBackfiller{Credentials: DriftSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderLiveChat, "SUPPORT_LIVE_LIVECHAT", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return LiveChatRESTBackfiller{Credentials: LiveChatSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderZohoDesk, "SUPPORT_LIVE_ZOHODESK", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return ZohoDeskRESTBackfiller{Credentials: ZohoDeskSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderOlark, "SUPPORT_LIVE_OLARK", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return OlarkRESTBackfiller{Credentials: OlarkSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderHubSpotServiceHub, "SUPPORT_LIVE_HUBSPOT_SERVICE_HUB", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return HubSpotServiceHubRESTBackfiller{Credentials: HubSpotServiceHubSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderSalesforceServiceCloud, "SUPPORT_LIVE_SALESFORCE_SERVICE_CLOUD", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return SalesforceServiceCloudRESTBackfiller{Credentials: SalesforceServiceCloudSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderKayako, "SUPPORT_LIVE_KAYAKO", func(s SupportRuntimeSecretResolver) supportLiveBackfiller {
			return KayakoRESTBackfiller{Credentials: KayakoSecretsCredentialResolver{Secrets: s}}
		}},
	}
}

func supportLiveRequiredChecks() []string {
	return []string{
		"backfill_tickets",
		"manual_disconnect_cleanup",
		"manual_reconnect_resume",
		"manual_rate_limit_retry_after",
		"manual_credential_rotation",
	}
}

func TestSupportLiveCertificationEvidenceContract(t *testing.T) {
	required := supportLiveRequiredChecks()
	for _, p := range supportLiveProviders() {
		p := p
		t.Run(p.provider, func(t *testing.T) {
			complete := make([]livecert.Evidence, 0, len(required))
			for _, check := range required {
				complete = append(complete, livecert.Evidence{Provider: p.provider, Check: check, Status: livecert.StatusPassed, RecordedAt: "2026-06-21T00:00:00Z"})
			}
			if err := livecert.ValidateCompleteness(p.provider, complete, required); err != nil {
				t.Fatalf("complete %s evidence should validate: %v", p.provider, err)
			}
			if err := livecert.ValidateCompleteness(p.provider, complete[:len(complete)-1], required); err == nil {
				t.Fatalf("incomplete %s evidence should fail completeness", p.provider)
			}
		})
	}
}

func TestSupportLiveCertificationReadPaths(t *testing.T) {
	if !livecert.Bool(supportLiveCertificationEnv) {
		t.Skip(supportLiveCertificationEnv + "=1 not set; skipping support live certification")
	}
	for _, p := range supportLiveProviders() {
		p := p
		t.Run(p.provider, func(t *testing.T) {
			credJSON := livecert.Env(p.envKey)
			if credJSON == "" {
				t.Skipf("%s not set; skipping %s live read certification", p.envKey, p.provider)
			}
			rec := &livecert.Recorder{Provider: p.provider, ReportPath: livecert.Env(supportLiveReportEnv)}
			integration := Integration{ID: p.provider + "-live", TenantID: supportLiveTenantID, Provider: p.provider, Status: "connected", CredentialsRef: supportLiveCredentialRef, Settings: map[string]any{}}
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			req, err := p.make(supportLiveEnvSecrets{json: credJSON}).BackfillPage(ctx, supportLiveTenantID, integration, "")
			if err != nil {
				t.Fatalf("live %s read page failed: %v", p.provider, err)
			}
			if err := rec.Record("backfill_tickets", map[string]any{
				"run_mode":       req.RunMode,
				"tickets":        len(req.Tickets),
				"cursor_present": strings.TrimSpace(req.Cursor) != "",
			}); err != nil {
				t.Fatalf("record %s evidence: %v", p.provider, err)
			}
			t.Logf("live %s read ok: tickets=%d cursor_present=%t", p.provider, len(req.Tickets), strings.TrimSpace(req.Cursor) != "")
		})
	}
}

func TestSupportLiveCertificationReportCompleteness(t *testing.T) {
	if !livecert.Bool(supportLiveValidateReportEnv) {
		t.Skip(supportLiveValidateReportEnv + "=1 not set; skipping support report completeness check")
	}
	reportPath := livecert.Env(supportLiveReportEnv)
	if reportPath == "" {
		t.Fatal(supportLiveReportEnv + " is required when validating support live certification evidence")
	}
	entries, err := livecert.ReadReport(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range supportLiveProviders() {
		if err := livecert.ValidateCompleteness(p.provider, entries, supportLiveRequiredChecks()); err != nil {
			t.Fatalf("%s report completeness: %v", p.provider, err)
		}
	}
}
