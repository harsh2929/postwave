package orchestrator

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/postwave/migrate/canonical"
	listmonkx "github.com/postwave/postwave/services/migration/internal/translator/listmonk"
)

func TestCustomerIOFullSnapshotEmailMoveDisablesOnlyPriorDestination(t *testing.T) {
	resources := []listmonkx.ImportedResource{
		{
			ID: "customerio-old-email", DestinationType: listmonkx.DestinationListmonkSubscriber, DestinationID: "81",
			SourcePlatform: canonical.SourceCustomerIO, SourceID: "cio-stable",
			DestinationMetadata: map[string]interface{}{
				"email": "old-address@example.com", "postwave_source_identity_owned": true,
			},
		},
		{
			ID: "customerio-current-email", DestinationType: listmonkx.DestinationListmonkSubscriber, DestinationID: "82",
			SourcePlatform: canonical.SourceCustomerIO, SourceID: "cio-stable",
			DestinationMetadata: map[string]interface{}{
				"email": "new-address@example.com", "postwave_source_identity_owned": true,
			},
		},
	}

	missing, err := snapshotMissingSubscriberDisables(resources, map[string]string{
		"cio-stable": "new-address@example.com",
	}, canonical.SourceCustomerIO, "Customer.io")
	require.NoError(t, err)
	require.Equal(t, []listmonkx.SourceSnapshotDeletionCandidate{{
		Subscriber: canonical.Subscriber{
			Email: "old-address@example.com", Status: canonical.StatusDisabled,
			ConsentSource: canonical.ConsentUnknown, CustomFields: map[string]interface{}{},
			SourceID: "cio-stable", SourcePlatform: canonical.SourceCustomerIO,
		},
		DestinationType: listmonkx.DestinationListmonkSubscriber,
		DestinationID:   "81",
	}}, missing)
}

func TestCustomerIOSharedEmailTransfersOwnershipToSurvivingCIOID(t *testing.T) {
	merged := listmonkx.ImportedResource{
		ID: "ledger-customerio-merged", DestinationID: "destination-one",
		SourcePlatform: canonical.SourceCustomerIO,
		SourceID:       "cio-b",
		DestinationMetadata: map[string]interface{}{
			"email":                          "shared@example.com",
			"source_ids":                     []interface{}{"cio-a", "cio-b"},
			"postwave_source_identity_owned": true,
			"postwave_after": map[string]interface{}{
				"subscriber": map[string]interface{}{
					"source_platform": "customerio",
					"source_id":       "cio-a",
				},
			},
		},
	}
	verifier := NewVerifierInput()
	verifier.SubscriberFirstSeen["shared@example.com"] = canonical.Subscriber{
		Email: "shared@example.com", Status: canonical.StatusDisabled,
		SourceID: "cio-b", SourcePlatform: canonical.SourceCustomerIO,
		Tags: []string{"customerio:topic:weekly"}, CustomFields: map[string]interface{}{"plan": "current"},
	}

	transfers, err := snapshotSubscriberOwnershipTransfers(
		[]listmonkx.ImportedResource{merged},
		map[string]string{"cio-b": "shared@example.com"},
		verifier,
		canonical.SourceCustomerIO,
		"Customer.io",
	)
	require.NoError(t, err)
	require.Equal(t, []beehiivSubscriberOwnershipTransfer{{
		FromSourceID: "cio-a",
		Subscriber:   verifier.SubscriberFirstSeen["shared@example.com"],
	}}, transfers)

	missing, err := snapshotMissingSubscriberDisables(
		[]listmonkx.ImportedResource{merged},
		map[string]string{"cio-b": "shared@example.com"},
		canonical.SourceCustomerIO,
		"Customer.io",
	)
	require.NoError(t, err)
	require.Empty(t, missing, "a surviving cio_id keeps the shared destination active")
}

func TestCustomerIOCurrentSnapshotRejectsCIOIDReusedAcrossEmails(t *testing.T) {
	verifier := NewVerifierInput()
	verifier.SubscriberFirstSeen["first@example.com"] = canonical.Subscriber{Email: "first@example.com", SourceID: "cio-stable"}
	verifier.SubscriberFirstSeen["second@example.com"] = canonical.Subscriber{Email: "second@example.com", SourceID: "cio-stable"}
	_, err := snapshotCurrentSubscriberIdentities(verifier, "Customer.io")
	require.ErrorContains(t, err, "reused one source identity for multiple emails")
}
