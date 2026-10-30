// SPDX-License-Identifier: AGPL-3.0-only

package deliverability_hub

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/outbound_webhooks"
)

func TestQualifiedDownwardCrossingContract(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name              string
		previousFound     bool
		previousQualified bool
		previousScore     int
		currentQualified  bool
		currentScore      int
		want              bool
	}{
		{"qualified boundary crossing", true, true, 60, true, 59, true},
		{"qualified larger crossing", true, true, 90, true, 20, true},
		{"no previous snapshot", false, true, 90, true, 20, false},
		{"previous sample unqualified", true, false, 90, true, 20, false},
		{"current sample unqualified", true, true, 90, false, 20, false},
		{"already degraded", true, true, 59, true, 20, false},
		{"still healthy", true, true, 90, true, 60, false},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got := isQualifiedDownwardCrossing(
				test.previousFound,
				test.previousQualified,
				test.previousScore,
				test.currentQualified,
				test.currentScore,
			)
			if got != test.want {
				t.Fatalf("crossing=%v, want %v", got, test.want)
			}
		})
	}
}

func TestDegradationSnapshotBucketOwnsOneCadence(t *testing.T) {
	t.Parallel()
	w := &Worker{Deps: &Deps{HubInterval: time.Hour}}
	first := time.Date(2026, 8, 2, 9, 1, 0, 0, time.UTC)
	secondReplica := first.Add(47 * time.Minute)
	laterObservation := first.Add(time.Hour)
	if got, want := w.degradationSnapshotBucket(first), w.degradationSnapshotBucket(secondReplica); got != want {
		t.Fatalf("same cadence buckets differ: %v vs %v", got, want)
	}
	if got, prior := w.degradationSnapshotBucket(laterObservation), w.degradationSnapshotBucket(first); got == prior {
		t.Fatalf("later cadence reused %v", got)
	}
}

func TestThrottleSnapshotValidationUsesCanonicalPersistedEvidence(t *testing.T) {
	t.Parallel()
	sampledAt := time.Date(2026, 8, 2, 9, 10, 0, 0, time.UTC)
	canonical := degradationTransitionClaim{
		ToSnapshotID:              42,
		ToSnapshotScore:           95,
		ToSnapshotModelVersion:    DeliverabilityScoreModelVersion,
		ToSnapshotSampleQualified: true,
		ToSnapshotSampleSize:      MinimumRateSampleSends,
		ToSnapshotSampledAt:       sampledAt,
	}
	if err := canonical.validateThrottleSnapshot(DeliverabilityScoreModelVersion); err != nil {
		t.Fatalf("canonical snapshot was rejected: %v", err)
	}

	wrongModel := canonical
	wrongModel.ToSnapshotModelVersion = "another-model"
	if err := wrongModel.validateThrottleSnapshot(DeliverabilityScoreModelVersion); err == nil {
		t.Fatal("a snapshot from another score model was accepted for throttle policy")
	}

	wrongQualification := canonical
	wrongQualification.ToSnapshotSampleSize = MinimumRateSampleSends - 1
	if err := wrongQualification.validateThrottleSnapshot(DeliverabilityScoreModelVersion); err == nil {
		t.Fatal("qualification inconsistent with the persisted sample was accepted")
	}
}

func TestDegradationDeliveryBackoffIsBounded(t *testing.T) {
	t.Parallel()
	if got := degradationDeliveryBackoff(1); got != time.Minute {
		t.Fatalf("attempt 1 backoff=%v", got)
	}
	if got := degradationDeliveryBackoff(99); got != degradationDeliveryMaxBackoff {
		t.Fatalf("large-attempt backoff=%v, want %v", got, degradationDeliveryMaxBackoff)
	}
}

func TestDegradationWebhookIsCanonicalAndTransactionallyOwned(t *testing.T) {
	t.Parallel()
	if !outbound_webhooks.IsAllowedEvent(EventListHealthDegraded) {
		t.Fatalf("%q is absent from the canonical webhook catalog", EventListHealthDegraded)
	}
}

func TestMigration1849PinsDurabilityDiscoveryAndPrivileges(t *testing.T) {
	t.Parallel()
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source")
	}
	path := filepath.Clean(filepath.Join(
		filepath.Dir(currentFile),
		"../../../../infra/migrations/1849_deliverability_degradation_claims.sql",
	))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read migration 1849: %v", err)
	}
	sql := string(raw)
	required := []string{
		"rollback-strategy:",
		"rollback-details:",
		"deliverability_hub_snapshots_cadence_uidx",
		"observation_bucket_at",
		"deliverability_hub_snapshots_claim_evidence_uidx",
		"previous_score >= 60 AND current_score < 60",
		"previous_sample_qualified",
		"current_sample_qualified",
		"webhook_enqueued_at",
		"operator_lease_token",
		"operator_notified_at",
		"ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED",
		"REVOKE DELETE ON public.deliverability_hub_snapshots",
		"REVOKE ALL ON public.deliverability_degradation_claims",
		"UPDATE (cleared_at, cleared_by)",
		"campaign_recipients",
		"subscriber_events",
		"sending_identities",
		"blocklist_observations",
		"deliverability_throttle_state",
		"deliverability_repair_overrides",
		"current_setting('app.outbox_worker', true) IS DISTINCT FROM 'true'",
		"SECURITY DEFINER",
		"p_minimum_campaign_sends < 1000",
	}
	for _, fragment := range required {
		if !strings.Contains(sql, fragment) {
			t.Errorf("migration 1849 lacks %q", fragment)
		}
	}
	if strings.Contains(sql, "GRANT SELECT, INSERT, DELETE ON public.deliverability_degradation_claims") {
		t.Fatal("ordinary app role can delete immutable degradation claims")
	}
}

func TestWorkerInventoryQueryUsesTheBoundedDiscoveryFunction(t *testing.T) {
	t.Parallel()
	if !strings.Contains(workerTenantInventorySQL, "deliverability_hub_worker_tenants($1, $2)") {
		t.Fatalf("inventory query bypasses bounded discovery function: %s", workerTenantInventorySQL)
	}
	if deliverabilityModelWindow != 30*24*time.Hour {
		t.Fatalf("inventory window=%v, want 30 days", deliverabilityModelWindow)
	}
	if MinimumRateSampleSends != 1000 {
		t.Fatalf("minimum campaign cohort=%d, want 1000", MinimumRateSampleSends)
	}
}
