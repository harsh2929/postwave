package listmonk

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestValidateIncrementalSubscriberEmailEvidenceRequiresSnapshotReconciliationForMove(t *testing.T) {
	active := func(email string) map[string]interface{} {
		return map[string]interface{}{
			"email":                            email,
			"postwave_source_snapshot_present": true,
			"postwave_source_identity_owned":   true,
		}
	}

	require.NoError(t, validateIncrementalSubscriberEmailEvidence("new@example.com", nil))
	require.NoError(t, validateIncrementalSubscriberEmailEvidence("NEW@example.com", []map[string]interface{}{active("new@example.com")}))

	historical := active("old@example.com")
	historical["postwave_source_snapshot_present"] = false
	require.NoError(t, validateIncrementalSubscriberEmailEvidence("new@example.com", []map[string]interface{}{historical, active("new@example.com")}))

	unowned := active("old@example.com")
	unowned["postwave_source_identity_owned"] = false
	require.NoError(t, validateIncrementalSubscriberEmailEvidence("new@example.com", []map[string]interface{}{unowned, active("new@example.com")}))

	err := validateIncrementalSubscriberEmailEvidence("new@example.com", []map[string]interface{}{active("old@example.com")})
	require.ErrorContains(t, err, "changed email")
	require.ErrorContains(t, err, "full source snapshot")

	err = validateIncrementalSubscriberEmailEvidence("new@example.com", []map[string]interface{}{active("new@example.com"), active("new@example.com")})
	require.ErrorContains(t, err, "multiple active destinations")

	err = validateIncrementalSubscriberEmailEvidence("new@example.com", []map[string]interface{}{{"postwave_source_snapshot_present": true}})
	require.ErrorContains(t, err, "incomplete destination evidence")
}

func TestValidateKlaviyoCrossJobSubscriberEvidenceRequiresOriginalLineage(t *testing.T) {
	active := func(jobID, email string) klaviyoCrossJobSubscriberIdentity {
		return klaviyoCrossJobSubscriberIdentity{
			JobID: jobID,
			Metadata: map[string]interface{}{
				"email":                            email,
				"postwave_source_snapshot_present": true,
				"postwave_source_identity_owned":   true,
			},
		}
	}

	historical := active("job_historical", "old@example.com")
	historical.Metadata["postwave_source_snapshot_present"] = false
	unowned := active("job_unowned", "old@example.com")
	unowned.Metadata["postwave_source_identity_owned"] = false
	require.NoError(t, validateKlaviyoCrossJobSubscriberEvidence("new@example.com", []klaviyoCrossJobSubscriberIdentity{historical, unowned}))

	err := validateKlaviyoCrossJobSubscriberEvidence("new@example.com", []klaviyoCrossJobSubscriberIdentity{active("job_original", "old@example.com")})
	require.ErrorContains(t, err, "different destination email")
	require.ErrorContains(t, err, "job_original")
	require.ErrorContains(t, err, "full-snapshot delta")

	err = validateKlaviyoCrossJobSubscriberEvidence("new@example.com", []klaviyoCrossJobSubscriberIdentity{active("job_original", "NEW@example.com")})
	require.ErrorContains(t, err, "already owned")
	require.ErrorContains(t, err, "job_original")

	err = validateKlaviyoCrossJobSubscriberEvidence("new@example.com", []klaviyoCrossJobSubscriberIdentity{{
		JobID: "job_incomplete", Metadata: map[string]interface{}{"postwave_source_snapshot_present": true},
	}})
	require.ErrorContains(t, err, "incomplete cross-job destination evidence")
}
