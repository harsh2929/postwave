// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/verification"
)

func TestVerificationReleaseControlsAreExposedInEnvironmentTemplates(t *testing.T) {
	apiExample := readVerificationContractFile(t, ".env.example")
	production := readVerificationContractFile(t, "../../.env.production.template")

	for _, name := range []string{
		"POSTWAVE_DISABLE_VERIFICATION_BULK_JOBS",
		"POSTWAVE_DISABLE_VERIFICATION_JOB_RUNNER",
		"POSTWAVE_DISABLE_SUBSCRIBER_IMPORT_WORKER",
		"POSTWAVE_DISABLE_RECIPIENT_HEALTH_GATE",
	} {
		if !strings.Contains(apiExample, name+"=0") {
			t.Errorf("API environment example does not expose enabled default %s=0", name)
		}
		if !strings.Contains(production, "# "+name+"=1") {
			t.Errorf("production kill-switch section does not expose %s", name)
		}
	}
	for _, phrase := range []string{"enabled when the variable is omitted or set to 0", "canonical consent/suppression"} {
		if !strings.Contains(apiExample, phrase) {
			t.Errorf("API environment example does not document %q", phrase)
		}
	}
	for _, name := range []string{"RECAPTCHA_SECRET=", "RECAPTCHA_SITE_KEY="} {
		if !strings.Contains(apiExample, name) {
			t.Errorf("API environment example does not expose matching anti-abuse key %s", name)
		}
	}
	if !strings.Contains(apiExample, "local-only verification and spends no provider credits") {
		t.Error("API environment example does not document the no-captcha full-mode no-spend fallback")
	}
}

func TestVerificationAlertsArePresentInSourceAndDeployedRuleNamespace(t *testing.T) {
	source := readVerificationContractFile(t, "../../infra/grafana/alerts/release_core.yml")
	deployed := readVerificationContractFile(t, "../../infra/aws/observability-stack.yaml")

	rules := []struct {
		name   string
		metric string
	}{
		{name: "EmailVerificationAPI5xx", metric: "pw_http_requests_total"},
		{name: "RecipientHealthGateEvidenceFailure", metric: "postwave_sendloop_recipient_health_gate_total"},
		{name: "SignupVerificationFailOpen", metric: "postwave_forms_signup_verification_total"},
		{name: "EmailVerificationAmbiguousJob", metric: "postwave_email_verification_jobs_terminal_total"},
		{name: "EmailVerificationProviderFailure", metric: "postwave_email_verification_provider_batches_total"},
		{name: "EmailVerificationUsagePersistenceFailure", metric: "postwave_email_verification_usage_persistence_failures_total"},
		{name: "EmailHealthEvidenceUnavailable", metric: "postwave_email_health_evidence_unavailable_total"},
	}
	for _, rule := range rules {
		for label, document := range map[string]string{"source": source, "deployed AMP namespace": deployed} {
			if count := strings.Count(document, "- alert: "+rule.name); count != 1 {
				t.Errorf("%s contains %d %s rules, want exactly one", label, count, rule.name)
			}
			if !strings.Contains(document, rule.metric) {
				t.Errorf("%s does not reference documented metric %s", label, rule.metric)
			}
		}
	}
	for _, required := range []string{
		`route=~"/api/v1/verification/.*"`,
		`reason=~"error|incomplete"`,
		`outcome=~"degraded_allowed|error_allowed"`,
		`failure_code="verification_outcome_ambiguous"`,
		`outcome=~"no_credits|unauthorized|account_rejected|not_configured|unavailable|error|ambiguous"`,
		`postwave_email_verification_usage_persistence_failures_total{job="postwave-api"}`,
	} {
		if !strings.Contains(source, required) || !strings.Contains(deployed, required) {
			t.Errorf("source/deployed verification alerts are missing selector %s", required)
		}
	}
}

func TestVerificationSynchronousTimeoutFitsFiniteServerWriteWindow(t *testing.T) {
	if apiWriteTimeout > 2*time.Minute {
		t.Fatalf("API write timeout = %s, want a finite sub-two-minute envelope", apiWriteTimeout)
	}
	if margin := apiWriteTimeout - verification.SynchronousRequestTimeout; margin < 10*time.Second {
		t.Fatalf("write timeout margin = %s, want at least 10s for response/idempotency persistence", margin)
	}
	mainSource := readVerificationContractFile(t, "main.go")
	if !strings.Contains(mainSource, "WriteTimeout:      apiWriteTimeout") {
		t.Fatal("production http.Server is not bound to the reviewed verification-safe write timeout")
	}
}

func readVerificationContractFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(raw)
}
