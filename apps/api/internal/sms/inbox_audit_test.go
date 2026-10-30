// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"strings"
	"testing"
)

func TestSMSInboxAuditSubjectFingerprintIsTenantSeparatedAndMinimized(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	phone := "+14155551212"
	one, err := smsInboxAuditSubjectFingerprint(key, "11111111-1111-4111-8111-111111111111", phone)
	if err != nil {
		t.Fatal(err)
	}
	again, err := smsInboxAuditSubjectFingerprint(key, "11111111-1111-4111-8111-111111111111", phone)
	if err != nil {
		t.Fatal(err)
	}
	otherTenant, err := smsInboxAuditSubjectFingerprint(key, "22222222-2222-4222-8222-222222222222", phone)
	if err != nil {
		t.Fatal(err)
	}
	if one != again || one == otherTenant {
		t.Fatalf("fingerprint stability/separation failed: one=%q again=%q other=%q", one, again, otherTenant)
	}
	if strings.Contains(one, phone) || len(one) != len("hmac-sha256-v1:")+64 {
		t.Fatalf("fingerprint leaked subject or had wrong shape: %q", one)
	}
	if _, err := smsInboxAuditSubjectFingerprint([]byte("short"), "tenant", phone); err == nil {
		t.Fatal("short fingerprint key must fail closed")
	}
}

func TestSMSPrivateReadAuditSemanticsStayRegistrySpecific(t *testing.T) {
	tests := []struct {
		action, reason, resource string
	}{
		{"sms.suppressions.query", "operator_sms_suppression_registry_read", "sms_suppression_registry"},
		{"sms.quiet_hours.list", "operator_sms_quiet_hours_policy_read", "sms_quiet_hours_policy"},
		{"sms.keyword_responses.list", "operator_sms_keyword_response_policy_read", "sms_keyword_response_policy"},
		{"sms.inbox.list", "operator_sms_inbox_read", "sms_inbox"},
	}
	for _, tc := range tests {
		reason, resource := smsPrivateReadAuditSemantics(tc.action)
		if reason != tc.reason || resource != tc.resource {
			t.Fatalf("%s semantics = (%q,%q), want (%q,%q)", tc.action, reason, resource, tc.reason, tc.resource)
		}
		if strings.Contains(reason, "+14155551212") || strings.Contains(resource, "+14155551212") {
			t.Fatalf("%s semantics leaked an E.164 subject", tc.action)
		}
	}
}
