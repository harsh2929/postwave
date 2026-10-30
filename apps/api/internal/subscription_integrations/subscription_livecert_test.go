// SPDX-License-Identifier: AGPL-3.0-only
package subscription_integrations

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

// Live-certification harness for the native subscription pullers (Recharge,
// AfterShip, ShipStation, Skio, Chargebee, Loop, Seal, Appstle, Bold), mirroring
// crm_livecert_test.go.
//
// HONESTY BOUNDARY: these are read-path pullers (no managed OAuth refresh /
// provider webhooks / scheduled worker beyond the shared backfill loop). Passing
// the completeness gate certifies the implemented READ-PATH slice — a
// prerequisite for, not a substitute for, flipping RuntimeStatus to available.
// Credential-free evidence-contract tests run in normal CI; the read-path tests
// are env-gated and skip without per-provider sandbox credentials.
const (
	subLiveCertificationEnv  = "SUBSCRIPTION_LIVE_CERTIFICATION"
	subLiveReportEnv         = "SUBSCRIPTION_LIVE_CERTIFICATION_REPORT"
	subLiveValidateReportEnv = "SUBSCRIPTION_LIVE_CERTIFICATION_VALIDATE_REPORT"
	subLiveTenantID          = "subscription-live-certification"
	subLiveCredentialRef     = "subscription-live-env"
)

// subLiveEnvSecrets is the env-backed secret resolver: per-provider credential
// JSON is supplied via an env var and fed through the provider's real
// SecretsCredentialResolver, so the live path exercises production wiring.
type subLiveEnvSecrets struct{ json string }

func (s subLiveEnvSecrets) Get(_ context.Context, _ string) (string, error) { return s.json, nil }
func (s subLiveEnvSecrets) GetJSON(_ context.Context, _ string, out any) error {
	if strings.TrimSpace(s.json) == "" {
		return errNotJSONSecret
	}
	return json.Unmarshal([]byte(s.json), out)
}

type subLiveProvider struct {
	provider string
	object   string
	envKey   string // env var holding the credential JSON
	settings map[string]any
	make     func(secrets SubscriptionRuntimeSecretResolver) interface {
		BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
	}
}

func subLiveProviders() []subLiveProvider {
	return []subLiveProvider{
		{ProviderRecharge, "subscriptions", "SUBSCRIPTION_LIVE_RECHARGE", nil, func(s SubscriptionRuntimeSecretResolver) interface {
			BackfillPage(context.Context, string, Integration, string) (SyncRequest, error)
		} {
			return RechargeRESTBackfiller{Credentials: RechargeSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderAfterShip, "trackings", "SUBSCRIPTION_LIVE_AFTERSHIP", nil, func(s SubscriptionRuntimeSecretResolver) interface {
			BackfillPage(context.Context, string, Integration, string) (SyncRequest, error)
		} {
			return AfterShipRESTBackfiller{Credentials: AfterShipSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderShipStation, "orders", "SUBSCRIPTION_LIVE_SHIPSTATION", nil, func(s SubscriptionRuntimeSecretResolver) interface {
			BackfillPage(context.Context, string, Integration, string) (SyncRequest, error)
		} {
			return ShipStationRESTBackfiller{Credentials: ShipStationSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderSkio, "subscriptions", "SUBSCRIPTION_LIVE_SKIO", nil, func(s SubscriptionRuntimeSecretResolver) interface {
			BackfillPage(context.Context, string, Integration, string) (SyncRequest, error)
		} {
			return SkioGraphQLBackfiller{Credentials: SkioSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderChargebee, "subscriptions", "SUBSCRIPTION_LIVE_CHARGEBEE", nil, func(s SubscriptionRuntimeSecretResolver) interface {
			BackfillPage(context.Context, string, Integration, string) (SyncRequest, error)
		} {
			return ChargebeeRESTBackfiller{Credentials: ChargebeeSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderLoopSubscriptions, "subscriptions", "SUBSCRIPTION_LIVE_LOOP", nil, func(s SubscriptionRuntimeSecretResolver) interface {
			BackfillPage(context.Context, string, Integration, string) (SyncRequest, error)
		} {
			return LoopSubscriptionsRESTBackfiller{Credentials: LoopSubscriptionsSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderSealSubscriptions, "subscriptions", "SUBSCRIPTION_LIVE_SEAL", nil, func(s SubscriptionRuntimeSecretResolver) interface {
			BackfillPage(context.Context, string, Integration, string) (SyncRequest, error)
		} {
			return SealRESTBackfiller{Credentials: SealSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderAppstle, "subscriptions", "SUBSCRIPTION_LIVE_APPSTLE", nil, func(s SubscriptionRuntimeSecretResolver) interface {
			BackfillPage(context.Context, string, Integration, string) (SyncRequest, error)
		} {
			return AppstleRESTBackfiller{Credentials: AppstleSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderBoldSubscriptions, "subscriptions", "SUBSCRIPTION_LIVE_BOLD", nil, func(s SubscriptionRuntimeSecretResolver) interface {
			BackfillPage(context.Context, string, Integration, string) (SyncRequest, error)
		} {
			return BoldRESTBackfiller{Credentials: BoldSecretsCredentialResolver{Secrets: s}}
		}},
	}
}

func subLiveManualChecks() []string {
	return []string{
		"manual_disconnect_cleanup",
		"manual_reconnect_resume",
		"manual_rate_limit_retry_after",
		"manual_credential_rotation",
	}
}

func subLiveRequiredChecks(object string) []string {
	return append([]string{"backfill_" + object}, subLiveManualChecks()...)
}

// TestSubscriptionLiveCertificationEvidenceContract is the credential-free
// guarantee (runs in normal CI) that the completeness validator accepts a full
// synthetic report per provider and rejects one missing any required check.
func TestSubscriptionLiveCertificationEvidenceContract(t *testing.T) {
	for _, p := range subLiveProviders() {
		p := p
		t.Run(p.provider, func(t *testing.T) {
			required := subLiveRequiredChecks(p.object)
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

// TestSubscriptionLiveCertificationReadPaths exercises each provider's first
// page against the live API and records sanitized evidence. Env-gated: skips
// unless SUBSCRIPTION_LIVE_CERTIFICATION=1 and a per-provider credential JSON
// env var is set.
func TestSubscriptionLiveCertificationReadPaths(t *testing.T) {
	if !livecert.Bool(subLiveCertificationEnv) {
		t.Skip(subLiveCertificationEnv + "=1 not set; skipping subscription live certification")
	}
	for _, p := range subLiveProviders() {
		p := p
		t.Run(p.provider, func(t *testing.T) {
			credJSON := livecert.Env(p.envKey)
			if credJSON == "" {
				t.Skipf("%s not set; skipping %s live read certification", p.envKey, p.provider)
			}
			rec := &livecert.Recorder{Provider: p.provider, ReportPath: livecert.Env(subLiveReportEnv)}
			backfiller := p.make(subLiveEnvSecrets{json: credJSON})
			settings := map[string]any{}
			for k, v := range p.settings {
				settings[k] = v
			}
			integration := Integration{ID: p.provider + "-live", TenantID: subLiveTenantID, Provider: p.provider, Status: "connected", CredentialsRef: subLiveCredentialRef, Settings: settings}
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			req, err := backfiller.BackfillPage(ctx, subLiveTenantID, integration, "")
			if err != nil {
				t.Fatalf("live %s read page failed: %v", p.provider, err)
			}
			if err := rec.Record("backfill_"+p.object, map[string]any{
				"object":         p.object,
				"run_mode":       req.RunMode,
				"subscriptions":  len(req.Subscriptions),
				"shipments":      len(req.Shipments),
				"events":         len(req.Events),
				"cursor_present": strings.TrimSpace(req.Cursor) != "",
			}); err != nil {
				t.Fatalf("record %s evidence: %v", p.provider, err)
			}
			t.Logf("live %s read ok: subs=%d shipments=%d events=%d cursor_present=%t",
				p.provider, len(req.Subscriptions), len(req.Shipments), len(req.Events), strings.TrimSpace(req.Cursor) != "")
		})
	}
}

// TestSubscriptionLiveCertificationReportCompleteness is the env-gated gate that
// a recorded evidence report covers every required check per provider.
func TestSubscriptionLiveCertificationReportCompleteness(t *testing.T) {
	if !livecert.Bool(subLiveValidateReportEnv) {
		t.Skip(subLiveValidateReportEnv + "=1 not set; skipping subscription report completeness check")
	}
	reportPath := livecert.Env(subLiveReportEnv)
	if reportPath == "" {
		t.Fatal(subLiveReportEnv + " is required when validating subscription live certification evidence")
	}
	entries, err := livecert.ReadReport(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range subLiveProviders() {
		if err := livecert.ValidateCompleteness(p.provider, entries, subLiveRequiredChecks(p.object)); err != nil {
			t.Fatalf("%s report completeness: %v", p.provider, err)
		}
	}
}
