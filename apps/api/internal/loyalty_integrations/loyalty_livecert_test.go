// SPDX-License-Identifier: AGPL-3.0-only
package loyalty_integrations

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

// Live-certification harness for the native loyalty pullers (Smile.io,
// LoyaltyLion, Rivo, ReferralCandy, Friendbuy). Push-only providers
// (Growave/Marsello) integrate via the webhook-ingest subsystem instead and are
// certified by webhook-delivery evidence. Mirrors crm_livecert_test.go.
const (
	loyaltyLiveCertificationEnv  = "LOYALTY_LIVE_CERTIFICATION"
	loyaltyLiveReportEnv         = "LOYALTY_LIVE_CERTIFICATION_REPORT"
	loyaltyLiveValidateReportEnv = "LOYALTY_LIVE_CERTIFICATION_VALIDATE_REPORT"
	loyaltyLiveTenantID          = "loyalty-live-certification"
	loyaltyLiveCredentialRef     = "loyalty-live-env"
)

type loyaltyLiveEnvSecrets struct{ json string }

func (s loyaltyLiveEnvSecrets) Get(_ context.Context, _ string) (string, error) { return s.json, nil }
func (s loyaltyLiveEnvSecrets) GetJSON(_ context.Context, _ string, out any) error {
	if strings.TrimSpace(s.json) == "" {
		return errNotJSONSecret
	}
	return json.Unmarshal([]byte(s.json), out)
}

type loyaltyLiveProvider struct {
	provider string
	envKey   string
	make     func(secrets LoyaltyRuntimeSecretResolver) LoyaltyBackfiller
}

func loyaltyLiveProviders() []loyaltyLiveProvider {
	return []loyaltyLiveProvider{
		{ProviderSmile, "LOYALTY_LIVE_SMILE", func(s LoyaltyRuntimeSecretResolver) LoyaltyBackfiller {
			return SmileRESTBackfiller{Credentials: SmileSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderLoyaltyLion, "LOYALTY_LIVE_LOYALTYLION", func(s LoyaltyRuntimeSecretResolver) LoyaltyBackfiller {
			return LoyaltyLionRESTBackfiller{Credentials: LoyaltyLionSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderRivo, "LOYALTY_LIVE_RIVO", func(s LoyaltyRuntimeSecretResolver) LoyaltyBackfiller {
			return RivoRESTBackfiller{Credentials: RivoSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderReferralCandy, "LOYALTY_LIVE_REFERRALCANDY", func(s LoyaltyRuntimeSecretResolver) LoyaltyBackfiller {
			return ReferralCandyRESTBackfiller{Credentials: ReferralCandySecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderFriendbuy, "LOYALTY_LIVE_FRIENDBUY", func(s LoyaltyRuntimeSecretResolver) LoyaltyBackfiller {
			return FriendbuyRESTBackfiller{Credentials: FriendbuySecretsCredentialResolver{Secrets: s}}
		}},
	}
}

func loyaltyLiveRequiredChecks() []string {
	return []string{
		"backfill_members",
		"manual_disconnect_cleanup",
		"manual_reconnect_resume",
		"manual_rate_limit_retry_after",
		"manual_credential_rotation",
	}
}

func TestLoyaltyLiveCertificationEvidenceContract(t *testing.T) {
	required := loyaltyLiveRequiredChecks()
	for _, p := range loyaltyLiveProviders() {
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

func TestLoyaltyLiveCertificationReadPaths(t *testing.T) {
	if !livecert.Bool(loyaltyLiveCertificationEnv) {
		t.Skip(loyaltyLiveCertificationEnv + "=1 not set; skipping loyalty live certification")
	}
	for _, p := range loyaltyLiveProviders() {
		p := p
		t.Run(p.provider, func(t *testing.T) {
			credJSON := livecert.Env(p.envKey)
			if credJSON == "" {
				t.Skipf("%s not set; skipping %s live read certification", p.envKey, p.provider)
			}
			rec := &livecert.Recorder{Provider: p.provider, ReportPath: livecert.Env(loyaltyLiveReportEnv)}
			integration := Integration{ID: p.provider + "-live", TenantID: loyaltyLiveTenantID, Provider: p.provider, Status: "connected", CredentialsRef: loyaltyLiveCredentialRef, Settings: map[string]any{}}
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			req, err := p.make(loyaltyLiveEnvSecrets{json: credJSON}).BackfillPage(ctx, loyaltyLiveTenantID, integration, "")
			if err != nil {
				t.Fatalf("live %s read page failed: %v", p.provider, err)
			}
			if err := rec.Record("backfill_members", map[string]any{
				"run_mode":       req.RunMode,
				"members":        len(req.Members),
				"events":         len(req.Events),
				"cursor_present": strings.TrimSpace(req.Cursor) != "",
			}); err != nil {
				t.Fatalf("record %s evidence: %v", p.provider, err)
			}
			t.Logf("live %s read ok: members=%d events=%d cursor_present=%t", p.provider, len(req.Members), len(req.Events), strings.TrimSpace(req.Cursor) != "")
		})
	}
}

func TestLoyaltyLiveCertificationReportCompleteness(t *testing.T) {
	if !livecert.Bool(loyaltyLiveValidateReportEnv) {
		t.Skip(loyaltyLiveValidateReportEnv + "=1 not set; skipping loyalty report completeness check")
	}
	reportPath := livecert.Env(loyaltyLiveReportEnv)
	if reportPath == "" {
		t.Fatal(loyaltyLiveReportEnv + " is required when validating loyalty live certification evidence")
	}
	entries, err := livecert.ReadReport(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range loyaltyLiveProviders() {
		if err := livecert.ValidateCompleteness(p.provider, entries, loyaltyLiveRequiredChecks()); err != nil {
			t.Fatalf("%s report completeness: %v", p.provider, err)
		}
	}
}
