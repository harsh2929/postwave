// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"os"
	"strings"
	"testing"
)

func TestEventBillingNotificationAdapterSplitOwnsCompleteCohort(t *testing.T) {
	t.Parallel()

	legacyBytes, err := os.ReadFile("composition_adapters.go")
	if err != nil {
		t.Fatalf("read composition_adapters.go: %v", err)
	}
	extractedBytes, err := os.ReadFile("event_billing_notification_adapters.go")
	if err != nil {
		t.Fatalf("read event_billing_notification_adapters.go: %v", err)
	}
	legacy := string(legacyBytes)
	extracted := string(extractedBytes)
	markers := []string{
		"type listmonkEventBusAdapter struct",
		"type listmonkEngagementSnapshotAdapter struct",
		"type approvalsEventBusAdapter struct",
		"type approvalsTransactionalWebhookFanoutAdapter struct",
		"type billingAuditLoggerAdapter struct",
		"type billingAutoTenantAdapter struct",
		"var magicLinkAutoProvisionTotal =",
		"func slugifyEmailLocal(",
		"func defaultTenantNameFromEmail(",
		"func randomSlugSuffix(",
		"func purposeConsentLookupFromEnv(",
		"type billingPaymentFailedAdapter struct",
		"type affiliateSignupMailerAdapter struct",
		"type scheduledReportMailerAdapter struct",
		"type stripeDLQMailerAdapter struct",
		"type opsAlertMailerAdapter struct",
		"type sendingMailerAdapter struct",
		"type sendingNotificationFeedAdapter struct",
		"type sendingTenantUserRepo struct",
		"type approvalsAdminListerAdapter struct",
		"type approvalsPushAdapter struct",
		"type deliverabilityQuotaAdapter struct",
	}
	last := -1
	for _, marker := range markers {
		if strings.Contains(legacy, marker) {
			t.Fatalf("composition_adapters.go retained extracted declaration %q", marker)
		}
		index := strings.Index(extracted, marker)
		if index < 0 {
			t.Fatalf("extracted adapter cohort is missing %q", marker)
		}
		if index <= last {
			t.Fatalf("extracted adapter declaration %q is out of order", marker)
		}
		last = index
	}
}

func TestPurposeConsentLookupIsAlwaysFailClosed(t *testing.T) {
	t.Setenv("POSTWAVE_PURPOSE_CONSENT_GATE", "")

	lookup := purposeConsentLookupFromEnv(nil)
	if lookup == nil {
		t.Fatal("send-time purpose consent lookup must always be configured")
	}
	allowed, err := lookup.Allowed(t.Context(), "tenant", "person@example.com", "email_marketing")
	if err == nil || allowed {
		t.Fatalf("unavailable consent evidence must deny: allowed=%v err=%v", allowed, err)
	}
}

func TestCompositionAdapterFilesStayInsideDefaultSourceBudget(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		path  string
		limit int
	}{
		{path: "composition_adapters.go", limit: 2000},
		{path: "event_billing_notification_adapters.go", limit: 1000},
		// The operator-alert adapters, split out when the file above reached
		// its budget. Bounded from birth so the same growth ends in another
		// split rather than in a raised ceiling.
		{path: "operator_notify_alerts.go", limit: 500},
	} {
		t.Run(test.path, func(t *testing.T) {
			source, err := os.ReadFile(test.path)
			if err != nil {
				t.Fatalf("read %s: %v", test.path, err)
			}
			lines := strings.Count(string(source), "\n")
			if len(source) != 0 && source[len(source)-1] != '\n' {
				lines++
			}
			if lines > test.limit {
				t.Fatalf("%s = %d lines, limit %d", test.path, lines, test.limit)
			}
		})
	}
}

func TestMovedAdapterPureHelpersRetainBehavior(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		input string
		want  string
	}{
		{input: "Acme.Team+Billing", want: "acme-team-billing"},
		{input: "---", want: "user"},
		{input: "a__b", want: "a-b"},
	} {
		if got := slugifyEmailLocal(test.input); got != test.want {
			t.Errorf("slugifyEmailLocal(%q) = %q, want %q", test.input, got, test.want)
		}
	}
	if got := defaultTenantNameFromEmail("owner@acme.example"); got != "acme.example" {
		t.Fatalf("defaultTenantNameFromEmail = %q, want acme.example", got)
	}
	if got := defaultTenantNameFromEmail("owner"); got != "owner" {
		t.Fatalf("defaultTenantNameFromEmail without domain = %q, want owner", got)
	}
}
