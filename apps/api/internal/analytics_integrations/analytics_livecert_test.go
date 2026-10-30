// SPDX-License-Identifier: AGPL-3.0-only
package analytics_integrations

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

// Live-certification harness for the native OUTBOUND analytics pullers (PostHog,
// Triple Whale, Mixpanel, Amplitude). Segment/RudderStack are inbound CDP ingest
// and are exercised separately. Mirrors crm_livecert_test.go on the shared
// internal/integrations/livecert package: credential-free evidence-contract
// subtests run in CI; read-path tests are env-gated.
const (
	analyticsLiveCertificationEnv  = "ANALYTICS_LIVE_CERTIFICATION"
	analyticsLiveReportEnv         = "ANALYTICS_LIVE_CERTIFICATION_REPORT"
	analyticsLiveValidateReportEnv = "ANALYTICS_LIVE_CERTIFICATION_VALIDATE_REPORT"
	analyticsLiveTenantID          = "analytics-live-certification"
	analyticsLiveCredentialRef     = "analytics-live-env"
)

type analyticsLiveEnvSecrets struct{ json string }

func (s analyticsLiveEnvSecrets) Get(_ context.Context, _ string) (string, error) { return s.json, nil }
func (s analyticsLiveEnvSecrets) GetJSON(_ context.Context, _ string, out any) error {
	if strings.TrimSpace(s.json) == "" {
		return errAnalyticsNotJSONSecret
	}
	return json.Unmarshal([]byte(s.json), out)
}

type analyticsLiveBackfiller interface {
	BackfillPage(ctx context.Context, tenantID string, integration Integration, cursor string) (SyncRequest, error)
}

type analyticsLiveProvider struct {
	provider    string
	object      string
	envKey      string
	settingsKey string // optional setting (e.g. project_id / cohort_id) sourced from envKey+"_SETTING"
	make        func(secrets AnalyticsPullerSecretResolver) analyticsLiveBackfiller
}

func analyticsLiveProviders() []analyticsLiveProvider {
	return []analyticsLiveProvider{
		{ProviderPostHog, "persons", "ANALYTICS_LIVE_POSTHOG", "project_id", func(s AnalyticsPullerSecretResolver) analyticsLiveBackfiller {
			return PostHogRESTBackfiller{Credentials: PostHogSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderTripleWhale, "customers", "ANALYTICS_LIVE_TRIPLEWHALE", "", func(s AnalyticsPullerSecretResolver) analyticsLiveBackfiller {
			return TripleWhaleRESTBackfiller{Credentials: TripleWhaleSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderMixpanel, "profiles", "ANALYTICS_LIVE_MIXPANEL", "project_id", func(s AnalyticsPullerSecretResolver) analyticsLiveBackfiller {
			return MixpanelRESTBackfiller{Credentials: MixpanelSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderAmplitude, "cohort_users", "ANALYTICS_LIVE_AMPLITUDE", "cohort_id", func(s AnalyticsPullerSecretResolver) analyticsLiveBackfiller {
			return AmplitudeRESTBackfiller{Credentials: AmplitudeSecretsCredentialResolver{Secrets: s}}
		}},
	}
}

func analyticsLiveRequiredChecks(object string) []string {
	return []string{
		"backfill_" + object,
		"manual_disconnect_cleanup",
		"manual_reconnect_resume",
		"manual_rate_limit_retry_after",
		"manual_credential_rotation",
	}
}

func TestAnalyticsLiveCertificationEvidenceContract(t *testing.T) {
	for _, p := range analyticsLiveProviders() {
		p := p
		t.Run(p.provider, func(t *testing.T) {
			required := analyticsLiveRequiredChecks(p.object)
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

func TestAnalyticsLiveCertificationReadPaths(t *testing.T) {
	if !livecert.Bool(analyticsLiveCertificationEnv) {
		t.Skip(analyticsLiveCertificationEnv + "=1 not set; skipping analytics live certification")
	}
	for _, p := range analyticsLiveProviders() {
		p := p
		t.Run(p.provider, func(t *testing.T) {
			credJSON := livecert.Env(p.envKey)
			if credJSON == "" {
				t.Skipf("%s not set; skipping %s live read certification", p.envKey, p.provider)
			}
			rec := &livecert.Recorder{Provider: p.provider, ReportPath: livecert.Env(analyticsLiveReportEnv)}
			settings := map[string]any{}
			if p.settingsKey != "" {
				if v := livecert.Env(p.envKey + "_SETTING"); v != "" {
					settings[p.settingsKey] = v
				}
			}
			integration := Integration{ID: p.provider + "-live", TenantID: analyticsLiveTenantID, Provider: p.provider, Status: "connected", CredentialsRef: analyticsLiveCredentialRef, Settings: settings}
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			backfiller := p.make(analyticsLiveEnvSecrets{json: credJSON})
			req, err := backfiller.BackfillPage(ctx, analyticsLiveTenantID, integration, "")
			if err != nil {
				t.Fatalf("live %s read page failed: %v", p.provider, err)
			}
			// Amplitude's first response only starts an asynchronous export. A
			// successful request does not certify the poll/download/parser path.
			if p.provider == ProviderAmplitude {
				for req.Cursor != amplitudeCursorComplete {
					if !strings.HasPrefix(req.Cursor, amplitudeCursorPollPrefix) {
						t.Fatalf("live amplitude export returned an unexpected cursor")
					}
					timer := time.NewTimer(10 * time.Second)
					select {
					case <-ctx.Done():
						timer.Stop()
						t.Fatalf("live amplitude export did not complete: %v", ctx.Err())
					case <-timer.C:
					}
					req, err = backfiller.BackfillPage(ctx, analyticsLiveTenantID, integration, req.Cursor)
					if err != nil {
						t.Fatalf("live amplitude export read failed: %v", err)
					}
				}
			}
			if err := rec.Record("backfill_"+p.object, map[string]any{
				"object":         p.object,
				"run_mode":       req.RunMode,
				"profiles":       len(req.Profiles),
				"events":         len(req.Events),
				"cursor_present": strings.TrimSpace(req.Cursor) != "",
			}); err != nil {
				t.Fatalf("record %s evidence: %v", p.provider, err)
			}
			t.Logf("live %s read ok: profiles=%d events=%d cursor_present=%t", p.provider, len(req.Profiles), len(req.Events), strings.TrimSpace(req.Cursor) != "")
		})
	}
}

func TestAnalyticsLiveCertificationReportCompleteness(t *testing.T) {
	if !livecert.Bool(analyticsLiveValidateReportEnv) {
		t.Skip(analyticsLiveValidateReportEnv + "=1 not set; skipping analytics report completeness check")
	}
	reportPath := livecert.Env(analyticsLiveReportEnv)
	if reportPath == "" {
		t.Fatal(analyticsLiveReportEnv + " is required when validating analytics live certification evidence")
	}
	entries, err := livecert.ReadReport(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range analyticsLiveProviders() {
		t.Run(p.provider, func(t *testing.T) {
			if err := livecert.ValidateCompleteness(p.provider, entries, analyticsLiveRequiredChecks(p.object)); err != nil {
				t.Fatalf("%s report completeness: %v", p.provider, err)
			}
		})
	}
}
