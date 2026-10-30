// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// The artifact must be digest-addressed, and the digest must actually cover the
// payload.
//
// A digest that does not change when the content changes is worse than no
// digest: it invites a reader to verify a file and conclude it is intact when
// it is not. The export exists so a figure can be attached to a dispute, and
// the whole value of that is the recomputation.
func TestTheDeltaArtifactDigestCoversItsPayload(t *testing.T) {
	report := &ReclassificationDeltaReport{
		WindowStart: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		WindowEnd:   time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC),
		GeneratedAt: time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC),

		EligibleEvents: 100, ClassifiedEvents: 90,
		SupersededEvents: 10, ChangedEvents: 4, RestatedEvents: 6,
		ReachFloorBefore: 40, ReachFloorAfter: 44, ReachFloorDelta: 4,
	}
	body, payloadDigest, err := MarshalReclassificationDeltaArtifact("t1", "c1", report)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var artifact ReclassificationDeltaEvidenceArtifact
	if err := json.Unmarshal(body, &artifact); err != nil {
		t.Fatalf("artifact is not decodable: %v", err)
	}
	if artifact.ArtifactID != "sha256:"+payloadDigest {
		t.Fatalf("artifact id %q does not name the payload digest %q",
			artifact.ArtifactID, payloadDigest)
	}

	// RECOMPUTE, exactly as a recipient of the file would.
	recomputed, err := json.Marshal(artifact.EvidencePayload)
	if err != nil {
		t.Fatalf("re-marshal payload: %v", err)
	}
	sum := fmt.Sprintf("%x", sha256.Sum256(recomputed))
	if sum != payloadDigest {
		t.Fatalf("recomputed digest %s != stated %s; a reader verifying this file "+
			"would conclude it had been modified", sum, payloadDigest)
	}

	// A changed report must change the digest. Without this the assertion above
	// would hold for a constant.
	report.ChangedEvents = 5
	_, secondDigest, err := MarshalReclassificationDeltaArtifact("t1", "c1", report)
	if err != nil {
		t.Fatalf("marshal (second): %v", err)
	}
	if secondDigest == payloadDigest {
		t.Fatal("changing the report did not change the digest")
	}
}

// The artifact must state what it does NOT observe.
//
// This is the whole difference between an export and a screenshot. The delta
// holds the recipient population fixed and varies only the classifier — that is
// what makes the movement classifier-attributable — and a reader who does not
// know that will read the file as a claim that their audience did not change.
func TestTheDeltaArtifactStatesWhatItDoesNotObserve(t *testing.T) {
	body, _, err := MarshalReclassificationDeltaArtifact("t1", "c1",
		&ReclassificationDeltaReport{})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var artifact ReclassificationDeltaEvidenceArtifact
	if err := json.Unmarshal(body, &artifact); err != nil {
		t.Fatalf("decode: %v", err)
	}
	semantics := artifact.EvidencePayload.EvidenceSemantics
	if len(semantics.NotObserved) == 0 {
		t.Fatal("the artifact claims no limits at all")
	}
	if semantics.AttributionClaim == "" {
		t.Fatal("the artifact does not state what its figures are attributable to")
	}
	if semantics.RestatementClaim == "" {
		t.Fatal("the artifact does not explain why restated verdicts are counted separately")
	}
	// The digest must not be sold as a signature. Saying "verified" about a
	// hash that proves only non-corruption is the misreading this field exists
	// to prevent.
	if artifact.Integrity.Authenticity != "not_signed" {
		t.Fatalf("authenticity = %q, want not_signed", artifact.Integrity.Authenticity)
	}
}
