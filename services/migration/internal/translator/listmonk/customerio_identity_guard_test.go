package listmonk

import (
	"testing"

	"github.com/postwave/migrate/canonical"
	"github.com/stretchr/testify/require"
)

func TestCustomerIOCrossJobSubscriberEvidenceFailsClosedForActiveCIOID(t *testing.T) {
	tests := []struct {
		name     string
		evidence customerIOCrossJobSubscriberIdentity
		contains string
	}{
		{
			name:     "same email already owned",
			evidence: customerIOCrossJobSubscriberIdentity{JobID: "job-old", Metadata: map[string]interface{}{"email": "reader@example.com"}},
			contains: "already owned",
		},
		{
			name:     "email moved in other lineage",
			evidence: customerIOCrossJobSubscriberIdentity{JobID: "job-old", Metadata: map[string]interface{}{"email": "old@example.com"}},
			contains: "different destination email",
		},
		{
			name:     "incomplete ledger evidence",
			evidence: customerIOCrossJobSubscriberIdentity{JobID: "job-old", Metadata: map[string]interface{}{}},
			contains: "incomplete cross-job destination evidence",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateCustomerIOCrossJobSubscriberEvidence("reader@example.com", []customerIOCrossJobSubscriberIdentity{test.evidence})
			require.ErrorContains(t, err, test.contains)
			require.NotContains(t, err.Error(), "cio-secret")
		})
	}
}

func TestCustomerIOCrossJobSubscriberEvidenceIgnoresReleasedOwnership(t *testing.T) {
	evidence := []customerIOCrossJobSubscriberIdentity{
		{JobID: "snapshot-removed", Metadata: map[string]interface{}{
			"email":                            "old@example.com",
			"postwave_source_snapshot_present": false,
		}},
		{JobID: "ownership-transferred", Metadata: map[string]interface{}{
			"email":                          "old@example.com",
			"postwave_source_identity_owned": false,
		}},
	}
	require.NoError(t, validateCustomerIOCrossJobSubscriberEvidence("reader@example.com", evidence))
}

func TestCustomerIODuplicateEmailRetainsBothSourceProjectionsAndStrictestStatus(t *testing.T) {
	first := canonical.Subscriber{
		Email: "shared@example.com", Status: canonical.StatusEnabled,
		SourcePlatform: canonical.SourceCustomerIO, SourceID: "cio-a",
		Tags:         []string{"customerio:segment:7"},
		CustomFields: map[string]interface{}{"first_name": "Ada", "customerio_source": map[string]interface{}{"cio_id": "cio-a"}},
	}
	second := canonical.Subscriber{
		Email: first.Email, Status: canonical.StatusDisabled,
		SourcePlatform: canonical.SourceCustomerIO, SourceID: "cio-b",
		Tags:         []string{"customerio:topic:product"},
		CustomFields: map[string]interface{}{"first_name": "Grace", "customerio_source": map[string]interface{}{"cio_id": "cio-b"}},
	}
	projectionA, err := newSubscriberSourceProjection(first, nil)
	require.NoError(t, err)
	projectionB, err := newSubscriberSourceProjection(second, nil)
	require.NoError(t, err)
	mergedMetadata := mergeSubscriberTrackingMetadata(
		subscriberProjectionMetadata(projectionA),
		subscriberProjectionMetadata(projectionB),
	)
	projections, err := subscriberProjectionsFromMetadata(mergedMetadata)
	require.NoError(t, err)
	require.Len(t, projections, 2)
	require.Equal(t, "Ada", projections["customerio:cio-a"].Subscriber.CustomFields["first_name"])
	require.Equal(t, canonical.StatusEnabled, projections["customerio:cio-a"].Subscriber.Status)
	require.Equal(t, "Grace", projections["customerio:cio-b"].Subscriber.CustomFields["first_name"])
	require.Equal(t, canonical.StatusDisabled, projections["customerio:cio-b"].Subscriber.Status)

	existing := SubscriberResponse{
		Email: first.Email, Status: "enabled", Tags: append([]string(nil), first.Tags...),
		Attribs: map[string]interface{}{
			"postwave_source_id":            first.SourceID,
			"postwave_source_ids":           []string{first.SourceID},
			"postwave_source_platform":      string(first.SourcePlatform),
			"postwave_source_identity_keys": []string{"customerio:cio-a"},
		},
	}
	incoming := SubscriberPayload{
		Email: second.Email, Status: "disabled", Tags: append([]string(nil), second.Tags...),
		Attribs: map[string]interface{}{
			"postwave_source_id":            second.SourceID,
			"postwave_source_ids":           []string{second.SourceID},
			"postwave_source_platform":      string(second.SourcePlatform),
			"postwave_source_identity_keys": []string{"customerio:cio-b"},
		},
		AuthoritativeStatus: true,
		AuthoritativeTags:   true,
		AuthoritativeFields: true,
	}
	mergedPayload := mergeSubscriberPayload(existing, incoming)
	require.Equal(t, "disabled", mergedPayload.Status)
	require.ElementsMatch(t, []string{"customerio:segment:7", "customerio:topic:product"}, mergedPayload.Tags)
	require.ElementsMatch(t, []string{"cio-a", "cio-b"}, stringListFromAttrib(mergedPayload.Attribs["postwave_source_ids"]))
	require.ElementsMatch(t, []string{"customerio:cio-a", "customerio:cio-b"}, stringListFromAttrib(mergedPayload.Attribs["postwave_source_identity_keys"]))
}
