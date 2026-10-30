package orchestrator

import (
	"testing"

	"github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
	"github.com/stretchr/testify/require"
)

func TestHubSpotUsesExactAuthoritativeSubscriberSnapshot(t *testing.T) {
	require.True(t, exactSubscriberSnapshotSource(canonical.SourceHubSpot))
	require.True(t, subscriberStatusAuthoritativeSource(canonical.SourceHubSpot))
	require.True(t, subscriberFieldsAndTagsAuthoritativeSource(canonical.SourceHubSpot))
	require.True(t, snapshotMembershipTagForSource(canonical.SourceHubSpot, "hubspot:list:42"))
	require.True(t, snapshotMembershipTagForSource(canonical.SourceHubSpot, "hubspot:subscription:0:77"))
	require.False(t, snapshotMembershipTagForSource(canonical.SourceHubSpot, "hubspot:segment:42"))
}

func TestHubSpotTraversalRequiresEveryEmailContactAndListMembership(t *testing.T) {
	verifier := NewVerifierInput()
	verifier.Discovery = adapter.DiscoveryReport{
		SubscribersTotal: 2,
		SnapshotMembershipCounts: map[string]int{
			"hubspot:list:42":           2,
			"hubspot:subscription:0:77": 1,
		},
	}
	verifier.SubscriberSourceIDs["contact-a"] = struct{}{}
	verifier.SubscriberSourceIDs["contact-b"] = struct{}{}
	verifier.SubscriberTagCounts["hubspot:list:42"] = 2
	verifier.SubscriberTagCounts["hubspot:subscription:0:77"] = 1
	require.NoError(t, validateSnapshotSubscriberTraversalEvidence(verifier, canonical.SourceHubSpot))

	verifier.SubscriberTagCounts["hubspot:list:42"] = 1
	err := validateSnapshotSubscriberTraversalEvidence(verifier, canonical.SourceHubSpot)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.ErrorContains(t, err, "applied 1 of 2 memberships")

	verifier.SubscriberTagCounts["hubspot:list:42"] = 2
	verifier.SubscriberTagCounts["hubspot:list:undiscovered"] = 1
	err = validateSnapshotSubscriberTraversalEvidence(verifier, canonical.SourceHubSpot)
	require.ErrorIs(t, err, adapter.ErrSourceUnavailable)
	require.ErrorContains(t, err, "undiscovered audience")
}

func TestHubSpotVerifierObservesListAndSubscriptionMemberships(t *testing.T) {
	verifier := NewVerifierInput()
	verifier.ObserveSubscriber(canonical.Subscriber{
		Email:          "member@example.com",
		Status:         canonical.StatusEnabled,
		SourceID:       "contact-member",
		SourcePlatform: canonical.SourceHubSpot,
		Tags: []string{
			"hubspot:list:42",
			"hubspot:subscription:0:77",
			"hubspot:lifecycle:customer",
		},
	})

	require.Equal(t, 1, verifier.SubscriberTagCounts["hubspot:list:42"])
	require.Equal(t, 1, verifier.SubscriberTagCounts["hubspot:subscription:0:77"])
	require.NotContains(t, verifier.SubscriberTagCounts, "hubspot:lifecycle:customer")
	require.Equal(t, 2, verifier.StaticSegmentMemberships)
}

func TestHubSpotFullSnapshotReconcilesDeletedAndPrimaryEmailMovedContacts(t *testing.T) {
	resources := []listmonkx.ImportedResource{
		{
			ID:              "present",
			DestinationType: listmonkx.DestinationListmonkSubscriber,
			DestinationID:   "11",
			SourcePlatform:  canonical.SourceHubSpot,
			SourceID:        "contact-present",
			DestinationMetadata: map[string]interface{}{
				"email": "present@example.com",
			},
		},
		{
			ID:              "deleted",
			DestinationType: listmonkx.DestinationListmonkSubscriber,
			DestinationID:   "12",
			SourcePlatform:  canonical.SourceHubSpot,
			SourceID:        "contact-deleted",
			DestinationMetadata: map[string]interface{}{
				"email":                          "deleted@example.com",
				"postwave_source_identity_owned": true,
			},
		},
		{
			ID:              "old-primary-email",
			DestinationType: listmonkx.DestinationListmonkSubscriber,
			DestinationID:   "13",
			SourcePlatform:  canonical.SourceHubSpot,
			SourceID:        "contact-moved",
			DestinationMetadata: map[string]interface{}{
				"email":                          "old@example.com",
				"postwave_source_identity_owned": true,
			},
		},
		{
			ID:              "new-primary-email",
			DestinationType: listmonkx.DestinationListmonkSubscriber,
			DestinationID:   "14",
			SourcePlatform:  canonical.SourceHubSpot,
			SourceID:        "contact-moved",
			DestinationMetadata: map[string]interface{}{
				"email":                          "new@example.com",
				"postwave_source_identity_owned": true,
			},
		},
	}

	missing, err := snapshotMissingSubscriberDisables(resources, map[string]string{
		"contact-present": "present@example.com",
		"contact-moved":   "new@example.com",
	}, canonical.SourceHubSpot, "HubSpot")
	require.NoError(t, err)
	require.Len(t, missing, 2)
	require.Equal(t, "contact-deleted", missing[0].Subscriber.SourceID)
	require.Equal(t, "deleted@example.com", missing[0].Subscriber.Email)
	require.Equal(t, canonical.StatusDisabled, missing[0].Subscriber.Status)
	require.Equal(t, "contact-moved", missing[1].Subscriber.SourceID)
	require.Equal(t, "old@example.com", missing[1].Subscriber.Email)
	require.Equal(t, canonical.StatusDisabled, missing[1].Subscriber.Status)
}

func TestHubSpotSegmentSnapshotRequiresUniqueStableListIdentities(t *testing.T) {
	segment := func(name, sourceID string) canonical.Segment {
		return canonical.Segment{
			Name:             name,
			SourceDefinition: `{"migration_mode":"static_membership_snapshot","source_id":"` + sourceID + `"}`,
		}
	}

	sourceIDs, err := hubSpotSegmentSourceIDs([]canonical.Segment{
		segment("Customers", "hubspot:list:42"),
		segment("Prospects", "hubspot:list:84"),
		segment("Product updates", "hubspot:subscription:0:77"),
	})
	require.NoError(t, err)
	require.Equal(t, map[string]struct{}{
		"hubspot:list:42":           {},
		"hubspot:list:84":           {},
		"hubspot:subscription:0:77": {},
	}, sourceIDs)

	_, err = hubSpotSegmentSourceIDs([]canonical.Segment{
		segment("First name", "hubspot:list:42"),
		segment("Renamed copy", "hubspot:list:42"),
	})
	require.ErrorContains(t, err, `duplicate source identity "hubspot:list:42"`)

	_, err = hubSpotSegmentSourceIDs([]canonical.Segment{{
		Name:             "Unstable",
		SourceDefinition: `{"listId":"42"}`,
	}})
	require.ErrorContains(t, err, "not a stable HubSpot list or subscription identity")
}
