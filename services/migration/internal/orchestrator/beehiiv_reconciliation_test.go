package orchestrator

import (
	"encoding/json"
	"testing"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
	"github.com/stretchr/testify/require"
)

func TestTraversalCursorGuardRejectsMultiHopCycle(t *testing.T) {
	seen := newTraversalCursorSet()
	require.NoError(t, recordTraversalCursor(seen, "", "cursor-a", "subscriber"))
	require.NoError(t, recordTraversalCursor(seen, "cursor-a", "cursor-b", "subscriber"))
	err := recordTraversalCursor(seen, "cursor-b", "cursor-a", "subscriber")
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.ErrorContains(t, err, "cursor cycle")
}

func TestBeehiivDeletionReconciliationRequiresDiscoveryBoundInventory(t *testing.T) {
	current := map[string]string{"sub-one": "one@example.com"}
	require.NoError(t, validateBeehiivSubscriberInventory(current, 1))
	err := validateBeehiivSubscriberInventory(current, 2)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.ErrorContains(t, err, "refusing destructive deletion reconciliation")
}

func TestBeehiivMissingSubscriberDisablesUsesStableSourceIdentity(t *testing.T) {
	resources := []listmonkx.ImportedResource{
		{
			ID: "ledger-present", DestinationType: listmonkx.DestinationListmonkSubscriber, DestinationID: "1",
			SourcePlatform: canonical.SourceBeehiiv,
			SourceID:       "sub-present",
			DestinationMetadata: map[string]interface{}{
				"email": "present@example.com",
			},
		},
		{
			ID: "ledger-deleted", DestinationType: listmonkx.DestinationListmonkSubscriber, DestinationID: "2",
			SourcePlatform: canonical.SourceBeehiiv,
			SourceID:       "sub-deleted",
			DestinationMetadata: map[string]interface{}{
				"email": "deleted@example.com",
			},
		},
		{
			ID: "ledger-old-email", DestinationType: listmonkx.DestinationListmonkSubscriber, DestinationID: "3",
			SourcePlatform: canonical.SourceBeehiiv,
			SourceID:       "sub-renamed",
			DestinationMetadata: map[string]interface{}{
				"email": "old-address@example.com",
			},
		},
		{
			ID: "ledger-current-email", DestinationType: listmonkx.DestinationListmonkSubscriber, DestinationID: "4",
			SourcePlatform: canonical.SourceBeehiiv,
			SourceID:       "sub-renamed",
			DestinationMetadata: map[string]interface{}{
				"email": "new-address@example.com",
			},
		},
		{
			ID:             "ledger-other-source",
			SourcePlatform: canonical.SourceMailchimp,
			SourceID:       "mc-member",
			DestinationMetadata: map[string]interface{}{
				"email": "mailchimp@example.com",
			},
		},
	}

	missing, err := beehiivMissingSubscriberDisables(resources, map[string]string{
		"sub-present": "PRESENT@example.com",
		"sub-renamed": "new-address@example.com",
	})
	require.NoError(t, err)
	require.Equal(t, []listmonkx.SourceSnapshotDeletionCandidate{
		{Subscriber: canonical.Subscriber{
			Email:          "deleted@example.com",
			Status:         canonical.StatusDisabled,
			ConsentSource:  canonical.ConsentUnknown,
			CustomFields:   map[string]interface{}{},
			SourceID:       "sub-deleted",
			SourcePlatform: canonical.SourceBeehiiv,
		}, DestinationType: listmonkx.DestinationListmonkSubscriber, DestinationID: "2"},
		{Subscriber: canonical.Subscriber{
			Email:          "old-address@example.com",
			Status:         canonical.StatusDisabled,
			ConsentSource:  canonical.ConsentUnknown,
			CustomFields:   map[string]interface{}{},
			SourceID:       "sub-renamed",
			SourcePlatform: canonical.SourceBeehiiv,
		}, DestinationType: listmonkx.DestinationListmonkSubscriber, DestinationID: "3"},
	}, missing)
}

func TestKlaviyoSameJobFullSnapshotEmailMoveDisablesOnlyPriorDestination(t *testing.T) {
	resources := []listmonkx.ImportedResource{
		{
			ID: "klaviyo-old-email", DestinationType: listmonkx.DestinationListmonkSubscriber, DestinationID: "81",
			SourcePlatform: canonical.SourceKlaviyo, SourceID: "profile-stable",
			DestinationMetadata: map[string]interface{}{
				"email": "old-address@example.com", "postwave_source_identity_owned": true,
			},
		},
		{
			ID: "klaviyo-current-email", DestinationType: listmonkx.DestinationListmonkSubscriber, DestinationID: "82",
			SourcePlatform: canonical.SourceKlaviyo, SourceID: "profile-stable",
			DestinationMetadata: map[string]interface{}{
				"email": "new-address@example.com", "postwave_source_identity_owned": true,
			},
		},
	}

	missing, err := snapshotMissingSubscriberDisables(resources, map[string]string{
		"profile-stable": "new-address@example.com",
	}, canonical.SourceKlaviyo, "Klaviyo")
	require.NoError(t, err)
	require.Equal(t, []listmonkx.SourceSnapshotDeletionCandidate{{
		Subscriber: canonical.Subscriber{
			Email: "old-address@example.com", Status: canonical.StatusDisabled,
			ConsentSource: canonical.ConsentUnknown, CustomFields: map[string]interface{}{},
			SourceID: "profile-stable", SourcePlatform: canonical.SourceKlaviyo,
		},
		DestinationType: listmonkx.DestinationListmonkSubscriber,
		DestinationID:   "81",
	}}, missing)
}

func TestBeehiivCurrentSubscriberIdentitiesIncludesMergedIDsAndRejectsReuse(t *testing.T) {
	verifier := NewVerifierInput()
	verifier.SubscriberFirstSeen["shared@example.com"] = canonical.Subscriber{
		Email:    "shared@example.com",
		SourceID: "sub-one",
	}
	verifier.SubscriberMergeConflicts["shared@example.com"] = canonical.SubscriberMergeConflict{
		Email:     "shared@example.com",
		SourceIDs: []string{"sub-one", "sub-two"},
	}
	current, err := beehiivCurrentSubscriberIdentities(verifier)
	require.NoError(t, err)
	require.Equal(t, map[string]string{
		"sub-one": "shared@example.com",
		"sub-two": "shared@example.com",
	}, current)

	verifier.SubscriberFirstSeen["other@example.com"] = canonical.Subscriber{
		Email:    "other@example.com",
		SourceID: "sub-one",
	}
	_, err = beehiivCurrentSubscriberIdentities(verifier)
	require.ErrorContains(t, err, "multiple emails")
}

func TestBeehiivMissingSubscriberDisablesKeepsMergedEmailWhileAnySourceIDRemains(t *testing.T) {
	merged := listmonkx.ImportedResource{
		ID: "ledger-merged", DestinationType: listmonkx.DestinationListmonkSubscriber, DestinationID: "9",
		SourcePlatform: canonical.SourceBeehiiv,
		SourceID:       "sub-b",
		DestinationMetadata: map[string]interface{}{
			"email":                          "shared@example.com",
			"source_ids":                     []interface{}{"sub-a", "sub-b"},
			"postwave_source_identity_owned": true,
			"postwave_after": map[string]interface{}{
				"subscriber": map[string]interface{}{
					"source_platform": "beehiiv",
					"source_id":       "sub-a",
				},
			},
		},
	}

	missing, err := beehiivMissingSubscriberDisables([]listmonkx.ImportedResource{merged}, map[string]string{
		"sub-a": "shared@example.com",
	})
	require.NoError(t, err)
	require.Empty(t, missing, "the destination remains valid for the surviving merged source ID")

	missing, err = beehiivMissingSubscriberDisables([]listmonkx.ImportedResource{merged}, map[string]string{})
	require.NoError(t, err)
	require.Len(t, missing, 1)
	require.Equal(t, "sub-a", missing[0].Subscriber.SourceID, "disable must target the destination-owned identity, not the ledger's last writer")
}

func TestBeehiivSubscriberOwnershipTransfersToRemainingMergedIdentity(t *testing.T) {
	merged := listmonkx.ImportedResource{
		ID: "ledger-merged", DestinationID: "destination-one",
		SourcePlatform: canonical.SourceBeehiiv,
		SourceID:       "sub-b",
		DestinationMetadata: map[string]interface{}{
			"email":                          "shared@example.com",
			"source_ids":                     []interface{}{"sub-a", "sub-b"},
			"postwave_source_identity_owned": true,
			"postwave_after": map[string]interface{}{
				"subscriber": map[string]interface{}{
					"source_platform": "beehiiv",
					"source_id":       "sub-a",
				},
			},
		},
	}

	verifier := NewVerifierInput()
	verifier.SubscriberFirstSeen["shared@example.com"] = canonical.Subscriber{
		Email: "shared@example.com", Status: canonical.StatusDisabled,
		SourceID: "sub-b", SourcePlatform: canonical.SourceBeehiiv,
		Tags: []string{"beehiiv:segment:seg-current"}, CustomFields: map[string]interface{}{"plan": "current"},
	}

	transfers, err := beehiivSubscriberOwnershipTransfers([]listmonkx.ImportedResource{merged}, map[string]string{
		"sub-a": "shared@example.com",
	}, verifier)
	require.NoError(t, err)
	require.Empty(t, transfers, "A+B to A keeps the existing destination owner")

	transfers, err = beehiivSubscriberOwnershipTransfers([]listmonkx.ImportedResource{merged}, map[string]string{
		"sub-b": "shared@example.com",
	}, verifier)
	require.NoError(t, err)
	require.Equal(t, []beehiivSubscriberOwnershipTransfer{{
		FromSourceID: "sub-a",
		Subscriber:   verifier.SubscriberFirstSeen["shared@example.com"],
	}}, transfers, "A+B to B must transfer authority so B can remove stale A-owned status, tags, and fields")

	transfers, err = beehiivSubscriberOwnershipTransfers([]listmonkx.ImportedResource{merged}, map[string]string{}, verifier)
	require.NoError(t, err)
	require.Empty(t, transfers, "A+B to none is handled by the authoritative disable path")
}

func TestBeehiivMissingSubscriberDisablesProtectsUnownedDestination(t *testing.T) {
	resource := listmonkx.ImportedResource{
		DestinationType: listmonkx.DestinationListmonkSubscriber,
		DestinationID:   "10",
		SourcePlatform:  canonical.SourceBeehiiv,
		SourceID:        "sub-merged-into-local",
		DestinationMetadata: map[string]interface{}{
			"email":                          "local@example.com",
			"source_ids":                     []interface{}{"sub-merged-into-local"},
			"postwave_source_identity_owned": false,
		},
	}
	missing, err := beehiivMissingSubscriberDisables([]listmonkx.ImportedResource{resource}, nil)
	require.NoError(t, err)
	require.Empty(t, missing)
}

func TestSameSubscriberVerifierObservationRejectsMidTraversalIdentityDrift(t *testing.T) {
	first, err := json.Marshal(canonical.Subscriber{
		Email:          "old@example.com",
		SourceID:       "sub-stable",
		SourcePlatform: canonical.SourceBeehiiv,
	})
	require.NoError(t, err)
	retry, err := json.Marshal(canonical.Subscriber{
		Email:          "old@example.com",
		SourceID:       "sub-stable",
		SourcePlatform: canonical.SourceBeehiiv,
	})
	require.NoError(t, err)
	changed, err := json.Marshal(canonical.Subscriber{
		Email:          "new@example.com",
		SourceID:       "sub-stable",
		SourcePlatform: canonical.SourceBeehiiv,
	})
	require.NoError(t, err)
	require.True(t, sameSubscriberVerifierObservation(first, retry))
	require.False(t, sameSubscriberVerifierObservation(first, changed))
}

func TestBeehiivMissingSubscriberDisablesFailsClosedOnIncompleteLedger(t *testing.T) {
	tests := []struct {
		name     string
		resource listmonkx.ImportedResource
		want     string
	}{
		{
			name: "missing source identity",
			resource: listmonkx.ImportedResource{
				ID:                  "ledger-without-source",
				SourcePlatform:      canonical.SourceBeehiiv,
				DestinationMetadata: map[string]interface{}{"email": "member@example.com"},
			},
			want: "no source identity",
		},
		{
			name: "missing destination email",
			resource: listmonkx.ImportedResource{
				ID:                  "ledger-without-email",
				SourcePlatform:      canonical.SourceBeehiiv,
				SourceID:            "sub-1",
				DestinationMetadata: map[string]interface{}{},
			},
			want: "no destination email",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := beehiivMissingSubscriberDisables([]listmonkx.ImportedResource{test.resource}, nil)
			require.ErrorContains(t, err, test.want)
		})
	}
}
