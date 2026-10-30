// SPDX-License-Identifier: AGPL-3.0-only
package review_integrations

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/integrations/livecert"
)

// Live-certification harness for the native review pullers (Judge.me, Yotpo,
// Okendo, Loox, Trustpilot, Stamped, REVIEWS.io, Bazaarvoice, PowerReviews).
// Mirrors crm_livecert_test.go: credential-free evidence-contract subtests run
// in CI; read-path tests are env-gated.
const (
	reviewLiveCertificationEnv  = "REVIEW_LIVE_CERTIFICATION"
	reviewLiveReportEnv         = "REVIEW_LIVE_CERTIFICATION_REPORT"
	reviewLiveValidateReportEnv = "REVIEW_LIVE_CERTIFICATION_VALIDATE_REPORT"
	reviewLiveTenantID          = "review-live-certification"
	reviewLiveCredentialRef     = "review-live-env"
)

type reviewLiveEnvSecrets struct{ json string }

func (s reviewLiveEnvSecrets) Get(_ context.Context, _ string) (string, error) { return s.json, nil }
func (s reviewLiveEnvSecrets) GetJSON(_ context.Context, _ string, out any) error {
	if strings.TrimSpace(s.json) == "" {
		return errNotJSONSecret
	}
	return json.Unmarshal([]byte(s.json), out)
}

type reviewLiveProvider struct {
	provider string
	envKey   string
	make     func(secrets ReviewRuntimeSecretResolver) ReviewBackfiller
}

func reviewLiveProviders() []reviewLiveProvider {
	return []reviewLiveProvider{
		{ProviderJudgeMe, "REVIEW_LIVE_JUDGEME", func(s ReviewRuntimeSecretResolver) ReviewBackfiller {
			return JudgeMeRESTBackfiller{Credentials: JudgeMeSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderYotpo, "REVIEW_LIVE_YOTPO", func(s ReviewRuntimeSecretResolver) ReviewBackfiller {
			return YotpoRESTBackfiller{Credentials: YotpoSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderOkendo, "REVIEW_LIVE_OKENDO", func(s ReviewRuntimeSecretResolver) ReviewBackfiller {
			return OkendoRESTBackfiller{Credentials: OkendoSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderLoox, "REVIEW_LIVE_LOOX", func(s ReviewRuntimeSecretResolver) ReviewBackfiller {
			return LooxRESTBackfiller{Credentials: LooxSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderTrustpilot, "REVIEW_LIVE_TRUSTPILOT", func(s ReviewRuntimeSecretResolver) ReviewBackfiller {
			return TrustpilotRESTBackfiller{Credentials: TrustpilotSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderStamped, "REVIEW_LIVE_STAMPED", func(s ReviewRuntimeSecretResolver) ReviewBackfiller {
			return StampedRESTBackfiller{Credentials: StampedSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderReviewsIO, "REVIEW_LIVE_REVIEWSIO", func(s ReviewRuntimeSecretResolver) ReviewBackfiller {
			return ReviewsIORESTBackfiller{Credentials: ReviewsIOSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderBazaarvoice, "REVIEW_LIVE_BAZAARVOICE", func(s ReviewRuntimeSecretResolver) ReviewBackfiller {
			return BazaarvoiceRESTBackfiller{Credentials: BazaarvoiceSecretsCredentialResolver{Secrets: s}}
		}},
		{ProviderPowerReviews, "REVIEW_LIVE_POWERREVIEWS", func(s ReviewRuntimeSecretResolver) ReviewBackfiller {
			return PowerReviewsRESTBackfiller{Credentials: PowerReviewsSecretsCredentialResolver{Secrets: s}}
		}},
	}
}

func reviewLiveRequiredChecks() []string {
	return []string{
		"backfill_reviews",
		"manual_disconnect_cleanup",
		"manual_reconnect_resume",
		"manual_rate_limit_retry_after",
		"manual_credential_rotation",
	}
}

func TestReviewLiveCertificationEvidenceContract(t *testing.T) {
	required := reviewLiveRequiredChecks()
	for _, p := range reviewLiveProviders() {
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

func TestReviewLiveCertificationReadPaths(t *testing.T) {
	if !livecert.Bool(reviewLiveCertificationEnv) {
		t.Skip(reviewLiveCertificationEnv + "=1 not set; skipping review live certification")
	}
	for _, p := range reviewLiveProviders() {
		p := p
		t.Run(p.provider, func(t *testing.T) {
			credJSON := livecert.Env(p.envKey)
			if credJSON == "" {
				t.Skipf("%s not set; skipping %s live read certification", p.envKey, p.provider)
			}
			rec := &livecert.Recorder{Provider: p.provider, ReportPath: livecert.Env(reviewLiveReportEnv)}
			integration := Integration{ID: p.provider + "-live", TenantID: reviewLiveTenantID, Provider: p.provider, Status: "connected", CredentialsRef: reviewLiveCredentialRef, Settings: map[string]any{}}
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			req, err := p.make(reviewLiveEnvSecrets{json: credJSON}).BackfillPage(ctx, reviewLiveTenantID, integration, "")
			if err != nil {
				t.Fatalf("live %s read page failed: %v", p.provider, err)
			}
			if err := rec.Record("backfill_reviews", map[string]any{
				"run_mode":       req.RunMode,
				"reviews":        len(req.Reviews),
				"cursor_present": strings.TrimSpace(req.Cursor) != "",
			}); err != nil {
				t.Fatalf("record %s evidence: %v", p.provider, err)
			}
			t.Logf("live %s read ok: reviews=%d cursor_present=%t", p.provider, len(req.Reviews), strings.TrimSpace(req.Cursor) != "")
		})
	}
}

func TestReviewLiveCertificationReportCompleteness(t *testing.T) {
	if !livecert.Bool(reviewLiveValidateReportEnv) {
		t.Skip(reviewLiveValidateReportEnv + "=1 not set; skipping review report completeness check")
	}
	reportPath := livecert.Env(reviewLiveReportEnv)
	if reportPath == "" {
		t.Fatal(reviewLiveReportEnv + " is required when validating review live certification evidence")
	}
	entries, err := livecert.ReadReport(reportPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range reviewLiveProviders() {
		if err := livecert.ValidateCompleteness(p.provider, entries, reviewLiveRequiredChecks()); err != nil {
			t.Fatalf("%s report completeness: %v", p.provider, err)
		}
	}
}
