// SPDX-License-Identifier: AGPL-3.0-only

package intelligent_retry

import (
	"os"
	"strings"
	"testing"
)

func TestFrequencyRetryPromotionPreservesCompleteAssuranceBinding(t *testing.T) {
	source, err := os.ReadFile("intelligent_retry.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(source)
	for _, required := range []string{
		"binding AS (",
		"content_revision_id, send_plan_id, assurance_run_id",
		"assurance_attempt_count, assurance_artifact_set_hash",
		"assurance_source_hash, assurance_plan_hash",
		"assurance_gate_decision, assurance_override_ids",
		"assurance_bound_at",
		"ORDER BY (cr.assurance_run_id IS NULL), cr.id",
		"frequency.AdmitAndReserveTx(",
		"frequency.ReleaseReservationsTx(",
		"FROM inserted",
		"preferenceAdmitted, err := q.subscriberPreferenceAdmits(ctx, ev)",
		"subscriber_state AS MATERIALIZED (",
		"frequency_preference = 'paused'",
		"paused_until IS NULL OR paused_until > now()",
		"FOR NO KEY UPDATE",
		"JOIN subscriber_state AS preference",
		"ON preference.preference_allows",
		"WHERE NOT preference_allows",
		"THEN 'pending'",
		"THEN now() + interval '1 hour'",
		"status IN ('pending', 'ready') AND retry_after <= $2",
		"status = 'retrying' AND updated_at <= $3",
		"ORDER BY (status = 'retrying') DESC",
		"(status = 'ready') DESC",
		"FOR UPDATE SKIP LOCKED",
		"const RetryClaimLeaseDuration = 30 * time.Minute",
		"SELECT clock_timestamp()",
		"lease AS MATERIALIZED (",
		"AND status = 'retrying'",
		"AND updated_at = $5",
		"JOIN lease",
		"THEN LEAST(retry_after, now())",
		"FOR UPDATE`, tenantID, strings.TrimSpace(id)",
		"GREATEST(clock_timestamp(), updated_at + interval '1 microsecond')",
		"ErrRetryRevisionConflict",
		"parseRetryExpectedUpdatedAt",
		"retryMutationJSONMaxBodyBytes",
		"admin := apikeys.RequireExactTenantAdmin",
		"r.With(ProtectResponses, admin).Get(\"/api/v1/intelligent-retry/events\"",
		"validRetryListStatus(status)",
		"q.auditStatusMutation(ctx, tx, auditMeta",
	} {
		if !strings.Contains(text, required) {
			t.Errorf("retry promotion lost exact assurance fragment %q", required)
		}
	}
	promoteAt := strings.Index(text, "func (q *Queue) promoteEvent")
	if promoteAt < 0 {
		t.Fatal("retry promotion entrypoint is missing")
	}
	preferenceAt := strings.Index(text[promoteAt:], "preferenceAdmitted, err := q.subscriberPreferenceAdmits(ctx, ev)")
	insertTxAt := strings.Index(text[promoteAt:], "tx, err := db.WithTenant(ctx, q.Pool, ev.TenantID)")
	if preferenceAt < 0 || insertTxAt < 0 || preferenceAt >= insertTxAt {
		t.Fatalf("subscriber preference recheck must precede promotion transaction: promote=%d preference=%d transaction=%d", promoteAt, preferenceAt, insertTxAt)
	}
}
