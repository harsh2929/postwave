package listmonk

import (
	"testing"

	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func TestSubscriberDeletionHasActiveCrossJobSourceSurvivor(t *testing.T) {
	candidate := canonical.Subscriber{
		Email:          "shared@example.com",
		Status:         canonical.StatusDisabled,
		SourceID:       "sub-a",
		SourcePlatform: canonical.SourceBeehiiv,
	}
	own := subscriberSourceLedgerState{
		JobID: "job-a", SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-a",
		Metadata: map[string]interface{}{
			"email":                            candidate.Email,
			"source_ids":                       []interface{}{"sub-a"},
			"postwave_source_snapshot_present": false,
		},
	}

	tests := []struct {
		name     string
		other    subscriberSourceLedgerState
		survivor bool
	}{
		{
			name: "other Beehiiv publication identity",
			other: subscriberSourceLedgerState{
				JobID: "job-b", SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-b",
				Metadata: map[string]interface{}{"email": candidate.Email, "source_ids": []interface{}{"sub-b"}, "postwave_source_snapshot_present": true},
			},
			survivor: true,
		},
		{
			name: "other provider identity",
			other: subscriberSourceLedgerState{
				JobID: "job-mailchimp", SourcePlatform: canonical.SourceMailchimp, SourceID: "member-a",
				Metadata: map[string]interface{}{"email": candidate.Email, "source_ids": []interface{}{"member-a"}, "postwave_source_snapshot_present": true},
			},
			survivor: true,
		},
		{
			name: "legacy active ledger defaults present",
			other: subscriberSourceLedgerState{
				JobID: "job-legacy", SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-legacy",
				Metadata: map[string]interface{}{"email": candidate.Email, "source_ids": []interface{}{"sub-legacy"}},
			},
			survivor: true,
		},
		{
			name: "explicitly absent other identity",
			other: subscriberSourceLedgerState{
				JobID: "job-b", SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-b",
				Metadata: map[string]interface{}{"email": candidate.Email, "source_ids": []interface{}{"sub-b"}, "postwave_source_snapshot_present": false},
			},
		},
		{
			name: "same source identity in another job",
			other: subscriberSourceLedgerState{
				JobID: "job-reimport", SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-a",
				Metadata: map[string]interface{}{"email": candidate.Email, "source_ids": []interface{}{"sub-a"}, "postwave_source_snapshot_present": true},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := subscriberDeletionHasActiveSourceSurvivor(candidate, []subscriberSourceLedgerState{own, test.other})
			require.NoError(t, err)
			require.Equal(t, test.survivor, got)
		})
	}
}

func TestSubscriberDeletionSurvivorGuardFailsClosedOnAmbiguousLedger(t *testing.T) {
	candidate := canonical.Subscriber{
		Email:          "shared@example.com",
		Status:         canonical.StatusDisabled,
		SourceID:       "sub-a",
		SourcePlatform: canonical.SourceBeehiiv,
	}
	_, err := subscriberDeletionHasActiveSourceSurvivor(candidate, []subscriberSourceLedgerState{{
		JobID: "ambiguous", SourcePlatform: canonical.SourceBeehiiv,
		Metadata: map[string]interface{}{"email": candidate.Email, "postwave_source_snapshot_present": true},
	}})
	require.ErrorContains(t, err, "no source identity")

	_, err = subscriberDeletionHasActiveSourceSurvivor(candidate, []subscriberSourceLedgerState{{
		JobID: "wrong-email", SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-b",
		Metadata: map[string]interface{}{"email": "other@example.com", "postwave_source_snapshot_present": true},
	}})
	require.ErrorContains(t, err, "email does not match")
}

func TestMergeSubscriberTrackingMetadataRefreshesSnapshotPresence(t *testing.T) {
	previous := map[string]interface{}{"postwave_source_snapshot_present": false, "source_ids": []string{"sub-a"}}
	incoming := map[string]interface{}{"postwave_source_snapshot_present": true, "source_ids": []string{"sub-a"}}
	merged := mergeSubscriberTrackingMetadata(previous, incoming)
	require.Equal(t, true, merged["postwave_source_snapshot_present"])
}
