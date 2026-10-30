package listmonk

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func TestPreserveSubscriberProjectionAudiencesKeepsSnapshotMembershipOnly(t *testing.T) {
	const audienceID = "klaviyo:list:list-a"
	audiences := map[string]AudienceMapping{
		audienceID: {
			SourceID: audienceID, Name: "List A", ListmonkID: 17,
			PostwaveID: "11111111-1111-1111-1111-111111111111",
		},
	}
	previous, err := newSubscriberSourceProjection(canonical.Subscriber{
		Email: "profile@example.test", Status: canonical.StatusDisabled,
		SourcePlatform: canonical.SourceKlaviyo, SourceID: "profile-a",
		Tags:         []string{audienceID, "old-non-audience-tag"},
		CustomFields: map[string]interface{}{"first_name": "Old"},
	}, audiences)
	require.NoError(t, err)
	incoming, err := newSubscriberSourceProjection(canonical.Subscriber{
		Email: "profile@example.test", Status: canonical.StatusEnabled,
		SourcePlatform: canonical.SourceKlaviyo, SourceID: "profile-a",
		CustomFields: map[string]interface{}{"first_name": "New"},
	}, nil)
	require.NoError(t, err)

	got, err := preserveSubscriberProjectionAudiences(previous, incoming)
	require.NoError(t, err)
	require.Equal(t, canonical.StatusEnabled, got.Subscriber.Status)
	require.Equal(t, "New", got.Subscriber.CustomFields["first_name"])
	require.Equal(t, []string{audienceID}, got.Subscriber.Tags)
	require.Equal(t, previous.Audiences, got.Audiences)
}

func TestBuildSubscriberProjectionReconciliationRemovesRetiringOnlyState(t *testing.T) {
	a := canonical.Subscriber{
		Email: "shared@example.test", Status: canonical.StatusEnabled,
		SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-a",
		Tags:         []string{"beehiiv:segment:seg-a", "shared"},
		CustomFields: map[string]interface{}{"plan_a": "a", "beehiiv": map[string]interface{}{"publication_id": "pub-a"}},
	}
	b := canonical.Subscriber{
		Email: a.Email, Status: canonical.StatusDisabled,
		SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-b",
		Tags:         []string{"beehiiv:segment:seg-b", "shared"},
		CustomFields: map[string]interface{}{"plan_b": "b", "beehiiv": map[string]interface{}{"publication_id": "pub-b"}},
	}
	projectionA, err := newSubscriberSourceProjection(a, nil)
	require.NoError(t, err)
	projectionB, err := newSubscriberSourceProjection(b, nil)
	require.NoError(t, err)
	metadataA := subscriberProjectionMetadata(projectionA)
	metadataA["email"] = a.Email
	metadataA["source_ids"] = []string{a.SourceID}
	metadataA["postwave_source_snapshot_present"] = false
	metadataA["postwave_source_identity_owned"] = true
	metadataA["postwave_operation"] = "created"
	metadataB := subscriberProjectionMetadata(projectionB)
	metadataB["email"] = b.Email
	metadataB["source_ids"] = []string{b.SourceID}
	metadataB["postwave_source_snapshot_present"] = true

	plan, err := buildSubscriberProjectionReconciliation(SourceSnapshotDeletionCandidate{
		Subscriber:      canonical.Subscriber{Email: a.Email, Status: canonical.StatusDisabled, SourcePlatform: a.SourcePlatform, SourceID: a.SourceID},
		DestinationType: DestinationListmonkSubscriber, DestinationID: "42",
	}, "job-a", []subscriberSourceLedgerState{
		{JobID: "job-a", SourcePlatform: a.SourcePlatform, SourceID: a.SourceID, Metadata: metadataA},
		{JobID: "job-b", SourcePlatform: b.SourcePlatform, SourceID: b.SourceID, Metadata: metadataB},
	})
	require.NoError(t, err)
	require.NotNil(t, plan)
	require.Equal(t, "job-b", plan.PrimaryJobID)
	require.Equal(t, b.SourceID, plan.AggregateSubscriber.SourceID)
	require.Equal(t, canonical.StatusDisabled, plan.AggregateSubscriber.Status)
	require.ElementsMatch(t, b.Tags, plan.AggregateSubscriber.Tags)
	require.NotContains(t, plan.AggregateSubscriber.Tags, "beehiiv:segment:seg-a")
	require.NotContains(t, plan.AggregateSubscriber.CustomFields, "plan_a")
	require.Equal(t, "b", plan.AggregateSubscriber.CustomFields["plan_b"])
	require.Equal(t, b.CustomFields["beehiiv"], plan.AggregateSubscriber.CustomFields["beehiiv"], "provider provenance must transfer to the primary survivor")
}

func TestBuildSubscriberProjectionReconciliationFailsClosedForLegacyOrConflictingSurvivor(t *testing.T) {
	candidate := SourceSnapshotDeletionCandidate{Subscriber: canonical.Subscriber{
		Email: "shared@example.test", Status: canonical.StatusDisabled,
		SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-a",
	}}
	projectionA, err := newSubscriberSourceProjection(canonical.Subscriber{
		Email: candidate.Subscriber.Email, Status: canonical.StatusEnabled,
		SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-a", CustomFields: map[string]interface{}{"plan": "a"},
	}, nil)
	require.NoError(t, err)
	metadataA := subscriberProjectionMetadata(projectionA)
	metadataA["email"] = candidate.Subscriber.Email
	metadataA["postwave_source_snapshot_present"] = false

	_, err = buildSubscriberProjectionReconciliation(candidate, "job-a", []subscriberSourceLedgerState{
		{JobID: "job-a", SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-a", Metadata: metadataA},
		{JobID: "job-legacy", SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-b", Metadata: map[string]interface{}{
			"email": candidate.Subscriber.Email, "postwave_source_snapshot_present": true,
		}},
	})
	require.ErrorContains(t, err, "lacks bounded per-source projection")

	projectionB, err := newSubscriberSourceProjection(canonical.Subscriber{
		Email: candidate.Subscriber.Email, Status: canonical.StatusEnabled,
		SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-b", CustomFields: map[string]interface{}{"plan": "b"},
	}, nil)
	require.NoError(t, err)
	projectionC, err := newSubscriberSourceProjection(canonical.Subscriber{
		Email: candidate.Subscriber.Email, Status: canonical.StatusBlocklisted,
		SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-c", CustomFields: map[string]interface{}{"plan": "c"},
	}, nil)
	require.NoError(t, err)
	metadataB := subscriberProjectionMetadata(projectionB)
	metadataB["email"] = candidate.Subscriber.Email
	metadataB["postwave_source_snapshot_present"] = true
	metadataC := subscriberProjectionMetadata(projectionC)
	metadataC["email"] = candidate.Subscriber.Email
	metadataC["postwave_source_snapshot_present"] = true
	_, err = buildSubscriberProjectionReconciliation(candidate, "job-a", []subscriberSourceLedgerState{
		{JobID: "job-a", SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-a", Metadata: metadataA},
		{JobID: "job-b", SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-b", Metadata: metadataB},
		{JobID: "job-c", SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-c", Metadata: metadataC},
	})
	require.ErrorContains(t, err, "disagree on field")
}

func TestMergeSubscriberPayloadProjectionReconciliationPreservesLocalAndActiveState(t *testing.T) {
	projectionB := subscriberSourceProjection{Version: subscriberSourceProjectionVersion, Subscriber: canonical.Subscriber{
		Email: "shared@example.test", SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-b",
	}}
	plan := &subscriberProjectionReconciliation{
		PrimaryProjection:  projectionB,
		ActiveIdentityKeys: []string{"beehiiv:sub-b"},
		ActiveSourceIDs:    []string{"sub-b"},
	}
	existing := SubscriberResponse{
		ID: 42, Email: projectionB.Subscriber.Email, Status: "enabled", Name: "Local name",
		Tags: []string{"local", "seg-a", "seg-b", "shared"}, Lists: []int{7, 10, 20},
		Attribs: map[string]interface{}{
			"local_field": "keep", "a_field": "remove", "b_field": "old",
			"postwave_source_id": "sub-a", "postwave_source_ids": []interface{}{"sub-a", "sub-b"},
			"postwave_source_platform": "beehiiv", "postwave_source_identity_keys": []interface{}{"beehiiv:sub-a", "beehiiv:sub-b"},
			"postwave_tags":              []interface{}{"seg-a", "seg-b", "shared"},
			"postwave_source_field_keys": []interface{}{"a_field", "b_field"},
			"postwave_source_list_ids":   []interface{}{10.0, 20.0},
		},
	}
	incoming := SubscriberPayload{
		Email: existing.Email, Status: "disabled", Tags: []string{"seg-b", "shared"}, Lists: []int{20},
		Attribs: map[string]interface{}{
			"b_field": "new", "postwave_source_id": "sub-b", "postwave_source_ids": []string{"sub-b"},
			"postwave_source_platform": "beehiiv", "postwave_source_identity_keys": []string{"beehiiv:sub-b"},
			"postwave_tags": []string{"seg-b", "shared"}, "postwave_source_field_keys": []string{"b_field"},
			"postwave_source_list_ids": []int{20},
		},
		AuthoritativeStatus: true, AuthoritativeTags: true, AuthoritativeFields: true,
		TransferSourceFrom: "sub-a", ProjectionReconciliation: plan,
	}
	require.True(t, validatedSubscriberSourceIdentityTransfer(existing, incoming))
	merged := mergeSubscriberPayload(existing, incoming)
	require.Equal(t, "disabled", merged.Status)
	require.ElementsMatch(t, []string{"local", "seg-b", "shared"}, merged.Tags)
	require.ElementsMatch(t, []int{7, 20}, merged.Lists)
	require.Equal(t, "keep", merged.Attribs["local_field"])
	require.NotContains(t, merged.Attribs, "a_field")
	require.Equal(t, "new", merged.Attribs["b_field"])
	require.Equal(t, []string{"beehiiv:sub-b"}, merged.Attribs["postwave_source_identity_keys"])
	require.Equal(t, []string{"sub-b"}, merged.Attribs["postwave_source_ids"])
}

func TestMergeSubscriberAttribsUnionsSourceIdentityControlMetadata(t *testing.T) {
	merged := mergeSubscriberAttribs(
		map[string]interface{}{
			"postwave_source_id": "sub-a", "postwave_source_ids": []string{"sub-a"},
			"postwave_source_identity_keys": []string{"beehiiv:sub-a"}, "postwave_source_list_ids": []int{10},
		},
		map[string]interface{}{
			"postwave_source_id": "sub-b", "postwave_source_ids": []string{"sub-b"},
			"postwave_source_identity_keys": []string{"beehiiv:sub-b"}, "postwave_source_list_ids": []int{20},
		}, nil,
	)
	require.ElementsMatch(t, []string{"beehiiv:sub-a", "beehiiv:sub-b"}, stringListFromAttrib(merged["postwave_source_identity_keys"]))
	require.ElementsMatch(t, []int{10, 20}, intListFromAttrib(merged["postwave_source_list_ids"]))
}

func TestSharedSourceReconciliationRollbackFailsClosed(t *testing.T) {
	resource := ImportedResource{ID: "ledger-b", DestinationMetadata: map[string]interface{}{
		"postwave_shared_source_reconciliation": true,
	}}
	err := ValidateSubscriberMirrorUnchanged(context.Background(), nil, "", resource)
	require.ErrorIs(t, err, ErrRollbackConflict)
	require.ErrorContains(t, err, "prevent reintroducing retired source targeting")
	err = RestoreSubscriberMirrorAndMark(context.Background(), nil, "", resource)
	require.ErrorIs(t, err, ErrRollbackConflict)
}

func TestValidateSubscriberProjectionMergeFailsBeforeUnboundedOrAmbiguousMerge(t *testing.T) {
	const email = "bounded@example.test"
	projectionFor := func(sourceID string, valueSize int) subscriberSourceProjection {
		fields := map[string]interface{}{}
		if valueSize > 0 {
			fields["value"] = strings.Repeat("x", valueSize)
		}
		projection, err := newSubscriberSourceProjection(canonical.Subscriber{
			Email: email, Status: canonical.StatusEnabled, SourcePlatform: canonical.SourceBeehiiv,
			SourceID: sourceID, CustomFields: fields,
		}, nil)
		require.NoError(t, err)
		return projection
	}

	projections := map[string]interface{}{}
	sourceIDs := []string{}
	for i := 0; i < maxSubscriberProjectionIdentities; i++ {
		projection := projectionFor(fmt.Sprintf("sub-%02d", i), 0)
		key := subscriberSourceIdentityKey(projection.Subscriber.SourcePlatform, projection.Subscriber.SourceID)
		projections[key] = subscriberProjectionMetadata(projection)[subscriberSourceProjectionsMetadataKey].(map[string]interface{})[key]
		sourceIDs = append(sourceIDs, projection.Subscriber.SourceID)
	}
	err := validateSubscriberProjectionMerge(canonical.SourceBeehiiv, sourceIDs[0], map[string]interface{}{
		"email": email, "source_ids": sourceIDs, subscriberSourceProjectionsMetadataKey: projections,
	}, projectionFor("sub-33", 0))
	require.ErrorContains(t, err, "limit is 32")

	largeProjections := map[string]interface{}{}
	largeIDs := []string{}
	for i := 0; i < 8; i++ {
		projection := projectionFor(fmt.Sprintf("large-%02d", i), 230<<10)
		key := subscriberSourceIdentityKey(projection.Subscriber.SourcePlatform, projection.Subscriber.SourceID)
		largeProjections[key] = subscriberProjectionMetadata(projection)[subscriberSourceProjectionsMetadataKey].(map[string]interface{})[key]
		largeIDs = append(largeIDs, projection.Subscriber.SourceID)
	}
	err = validateSubscriberProjectionMerge(canonical.SourceBeehiiv, largeIDs[0], map[string]interface{}{
		"email": email, "source_ids": largeIDs, subscriberSourceProjectionsMetadataKey: largeProjections,
	}, projectionFor("large-09", 230<<10))
	require.ErrorContains(t, err, "limit is 2097152")

	incoming := projectionFor("legacy-a", 0)
	require.NoError(t, validateSubscriberProjectionMerge(canonical.SourceBeehiiv, "legacy-a", map[string]interface{}{
		"email": email, "source_ids": []string{"legacy-a"},
	}, incoming), "one exact legacy identity may be backfilled from its current snapshot")
	err = validateSubscriberProjectionMerge(canonical.SourceBeehiiv, "legacy-a", map[string]interface{}{
		"email": email, "source_ids": []string{"legacy-a", "legacy-b"},
	}, incoming)
	require.ErrorContains(t, err, "ambiguous legacy ledger")
}

func TestBuildSubscriberProjectionReconciliationCarriesExplicitNoLocalStatusBaseline(t *testing.T) {
	projection := func(sourceID string, status canonical.SubscriberStatus) subscriberSourceProjection {
		value, err := newSubscriberSourceProjection(canonical.Subscriber{
			Email: "chain@example.test", Status: status, SourcePlatform: canonical.SourceBeehiiv, SourceID: sourceID,
		}, nil)
		require.NoError(t, err)
		return value
	}
	metadata := func(value subscriberSourceProjection, present bool) map[string]interface{} {
		out := subscriberProjectionMetadata(value)
		out["email"] = value.Subscriber.Email
		out["source_ids"] = []string{value.Subscriber.SourceID}
		out["postwave_source_snapshot_present"] = present
		out["postwave_source_identity_owned"] = true
		return out
	}
	a := projection("sub-a", canonical.StatusDisabled)
	b := projection("sub-b", canonical.StatusEnabled)
	c := projection("sub-c", canonical.StatusEnabled)
	metadataA := metadata(a, false)
	metadataA["postwave_operation"] = "created"
	planAB, err := buildSubscriberProjectionReconciliation(SourceSnapshotDeletionCandidate{
		Subscriber: canonical.Subscriber{Email: a.Subscriber.Email, Status: canonical.StatusDisabled, SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-a"},
	}, "job-a", []subscriberSourceLedgerState{
		{JobID: "job-a", SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-a", Metadata: metadataA},
		{JobID: "job-b", SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-b", Metadata: metadata(b, true)},
	})
	require.NoError(t, err)
	require.False(t, planAB.BaselineStatusPresent)
	require.Equal(t, canonical.StatusEnabled, planAB.AggregateSubscriber.Status)

	metadataB := metadata(b, false)
	metadataB["postwave_operation"] = "updated"
	metadataB["postwave_before"] = map[string]interface{}{"status": string(canonical.StatusDisabled)}
	metadataB["postwave_shared_source_reconciliation"] = true
	metadataB[subscriberSharedBaselinePresentMetadataKey] = false
	planBC, err := buildSubscriberProjectionReconciliation(SourceSnapshotDeletionCandidate{
		Subscriber: canonical.Subscriber{Email: b.Subscriber.Email, Status: canonical.StatusDisabled, SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-b"},
	}, "job-b", []subscriberSourceLedgerState{
		{JobID: "job-b", SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-b", Metadata: metadataB},
		{JobID: "job-c", SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-c", Metadata: metadata(c, true)},
	})
	require.NoError(t, err)
	require.False(t, planBC.BaselineStatusPresent)
	require.Equal(t, canonical.StatusEnabled, planBC.AggregateSubscriber.Status, "A's retired disabled before-image must not become a fake local baseline")
}

func TestProjectionReconciliationRejectsChangedListmonkAfterFingerprint(t *testing.T) {
	existing := SubscriberResponse{
		ID: 77, Email: "changed@example.test", Status: "enabled", Tags: []string{"a"},
		Attribs: map[string]interface{}{
			"postwave_migration_job_id": "job-c", migrationOperationAttrib: string(UpsertUpdated),
			"postwave_source_id": "sub-a", "postwave_source_ids": []string{"sub-a", "sub-b"},
			"postwave_source_platform": "beehiiv", "postwave_source_identity_keys": []string{"beehiiv:sub-a", "beehiiv:sub-b"},
		},
	}
	stampTestSubscriberAfter(&existing)
	existing.Status = "blocklisted" // Simulate a local edit after the durable fingerprint.
	var puts atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost:
			w.WriteHeader(http.StatusConflict)
		case http.MethodGet:
			require.NoError(t, json.NewEncoder(w).Encode(map[string]interface{}{"data": wireSubscriberResults(t, existing)}))
		case http.MethodPut:
			puts.Add(1)
			w.WriteHeader(http.StatusOK)
		}
	}))
	t.Cleanup(server.Close)
	client := &Client{BaseURL: server.URL, AdminUser: "u", AdminPass: "p", HTTPClient: server.Client()}
	projectionB, err := newSubscriberSourceProjection(canonical.Subscriber{
		Email: existing.Email, Status: canonical.StatusEnabled, SourcePlatform: canonical.SourceBeehiiv, SourceID: "sub-b",
	}, nil)
	require.NoError(t, err)
	_, err = client.UpsertSubscriberWithSnapshot(context.Background(), SubscriberPayload{
		Email: existing.Email, Status: "enabled", Tags: []string{"b"},
		Attribs: map[string]interface{}{
			"postwave_migration_job_id": "job-b", "postwave_source_id": "sub-b",
			"postwave_source_platform": "beehiiv", "postwave_source_identity_keys": []string{"beehiiv:sub-b"},
		},
		AuthoritativeStatus: true, AuthoritativeTags: true, AuthoritativeFields: true, TransferSourceFrom: "sub-a",
		ProjectionReconciliation: &subscriberProjectionReconciliation{
			Candidate:         SourceSnapshotDeletionCandidate{DestinationID: "77"},
			PrimaryProjection: projectionB, ActiveIdentityKeys: []string{"beehiiv:sub-b"}, ActiveSourceIDs: []string{"sub-b"},
		},
	})
	require.ErrorContains(t, err, "destination changed after its recorded migration write")
	require.Zero(t, puts.Load())
}

func TestProjectionReconciliationPreservesExistingConsentWithoutDefensibleSurvivorProof(t *testing.T) {
	existing := SubscriberResponse{Email: "consent@example.test", Status: "enabled", Attribs: map[string]interface{}{
		"postwave_source_id": "sub-a", "postwave_source_ids": []string{"sub-a", "sub-b"},
		"postwave_source_platform": "beehiiv", "postwave_source_identity_keys": []string{"beehiiv:sub-a", "beehiiv:sub-b"},
		"postwave_consent_at": "2026-01-01T00:00:00Z", "postwave_consent_source": "single_opt_in",
	}}
	incoming := SubscriberPayload{Email: existing.Email, Status: "enabled", Attribs: map[string]interface{}{
		"postwave_source_id": "sub-b", "postwave_source_platform": "beehiiv",
		"postwave_source_identity_keys": []string{"beehiiv:sub-b"}, "postwave_consent_source": "unknown",
	}, AuthoritativeStatus: true, AuthoritativeTags: true, AuthoritativeFields: true, TransferSourceFrom: "sub-a", PreserveExistingConsent: true,
		ProjectionReconciliation: &subscriberProjectionReconciliation{ActiveIdentityKeys: []string{"beehiiv:sub-b"}, ActiveSourceIDs: []string{"sub-b"}, PrimaryProjection: subscriberSourceProjection{Subscriber: canonical.Subscriber{SourceID: "sub-b", SourcePlatform: canonical.SourceBeehiiv}}},
	}
	merged := mergeSubscriberPayload(existing, incoming)
	require.Equal(t, "2026-01-01T00:00:00Z", merged.Attribs["postwave_consent_at"])
	require.Equal(t, "single_opt_in", merged.Attribs["postwave_consent_source"])
}
