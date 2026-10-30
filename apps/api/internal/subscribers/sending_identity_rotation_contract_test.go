// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"os"
	"strings"
	"testing"
)

func TestSendingIdentityFenceLockOrderContract(t *testing.T) {
	read := func(path string) string {
		t.Helper()
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		return string(raw)
	}
	assertOrder := func(name, source string, fragments ...string) {
		t.Helper()
		cursor := 0
		for _, fragment := range fragments {
			offset := strings.Index(source[cursor:], fragment)
			if offset < 0 {
				t.Fatalf("%s lost ordered fence fragment %q", name, fragment)
			}
			cursor += offset + len(fragment)
		}
	}

	// Every writer takes canonical identity before any per-recipient frequency
	// or subscriber row lock. Admission uses the shared side, while every
	// operation that can move/erase identity uses the exclusive side.
	assertOrder("frequency admission", read("../frequency/admission.go"),
		"subscriberidentitylock.Shared(ctx, tx, tenantID)",
		"lockAdmissionSubscribers(ctx, tx, tenantID, ordered)",
		"FROM subscriber_send_log",
	)
	assertOrder("subscriber update", read("repo_update.go"),
		"subscriberidentitylock.Tenant(ctx, tx, tenantID)",
		"getInTxForUpdate(ctx, tx, tenantID, id)",
	)
	assertOrder("subscriber identify", read("identify.go"),
		"subscriberidentitylock.Tenant(ctx, tx, tenantID)",
		"rejectErasedAddress(ctx, tx, tenantID, in.Email)",
		"loadIdentifyRow(ctx, tx, tenantID",
	)
	assertOrder("canonical merge", read("merge_canonical.go"),
		"subscriberidentitylock.Tenant(ctx, tx, tenantID)",
		"pushauthoritylock.Exclusive(ctx, tx, tenantID)",
		"loadMergeSubscribersForUpdate(ctx, tx, tenantID",
	)
	assertOrder("mailchimp rotation", read("../mailchimpv3/repo.go"),
		"subscriberidentitylock.Tenant(ctx, tx, tenant.ID)",
		"row := tx.QueryRow(ctx, memberSelectSQL",
		"FOR UPDATE",
	)
	assertOrder("subject erasure", read("../privacy/erasure.go"),
		"hashtextextended($1, 2029)",
		"subscriberidentitylock.Tenant(ctx, tx, tenantID)",
		"UPDATE subscribers AS subscriber",
	)

	retrySource := read("../intelligent_retry/intelligent_retry.go")
	assertOrder("retry enqueue", retrySource,
		"subscriberidentitylock.Shared(ctx, tx, tenantID)",
		"resolveCanonicalRetryEmails(ctx, tx, tenantID, emails)",
		"INSERT INTO intelligent_retry_events",
	)
	for _, fragment := range []string{
		"FROM subscriber_suppressions AS suppression",
		"suppression.email_sha256 IN",
		"digest(resolved.requested_email::text, 'sha256')",
		"digest(resolved.canonical_email::text, 'sha256')",
		"'dsar_deletion', 'gdpr_erasure'",
	} {
		if !strings.Contains(retrySource, fragment) {
			t.Errorf("retry tombstone rejection lost %q", fragment)
		}
	}
}
