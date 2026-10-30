// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// The reclassification delta as a downloadable, digest-addressed artifact
// (PRD F12).
//
// The JSON read at /delta answers "what changed" inside the product. This
// answers the question that gets asked afterwards, usually by someone who was
// not in the room: "you told me my reach moved and that it was your classifier,
// not my audience — show me." A number in a dashboard cannot be attached to a
// procurement review or a dispute; a digest-addressed file can.
//
// It deliberately mirrors the reach evidence export rather than inventing a
// second shape: same integrity block, same canonicalisation contract, same
// not_signed honesty about what the digest does and does not prove. A reader who
// has learned to verify one has learned to verify both.
const (
	deltaEvidenceSchema    = "postwave.reclassification-delta-evidence.v1"
	deltaEvidenceMediaType = "application/vnd.postwave.reclassification-delta-evidence+json"
)

// ReclassificationDeltaEvidenceSemantics states what a delta claims, and — more
// importantly — what it does not.
type ReclassificationDeltaEvidenceSemantics struct {
	ObservedEvidence   []string `json:"observed_evidence"`
	InferredEvidence   []string `json:"inferred_evidence"`
	NotObserved        []string `json:"not_observed"`
	AttributionClaim   string   `json:"attribution_claim"`
	RestatementClaim   string   `json:"restatement_claim"`
	UnlinkedTreatment  string   `json:"unlinked_treatment"`
	AcceptanceBoundary string   `json:"acceptance_boundary"`
}

type ReclassificationDeltaEvidencePayload struct {
	EvidenceSemantics ReclassificationDeltaEvidenceSemantics `json:"evidence_semantics"`
	Report            HumanEngagedReachDeltaResponse         `json:"report"`
}

type ReclassificationDeltaEvidenceIntegrity struct {
	Algorithm        string `json:"algorithm"`
	DigestSHA256     string `json:"digest_sha256"`
	Scope            string `json:"scope"`
	Canonicalization string `json:"canonicalization"`
	Authenticity     string `json:"authenticity"`
}

type ReclassificationDeltaEvidenceArtifact struct {
	ArtifactSchemaVersion string                                 `json:"artifact_schema_version"`
	ArtifactKind          string                                 `json:"artifact_kind"`
	ArtifactID            string                                 `json:"artifact_id"`
	Integrity             ReclassificationDeltaEvidenceIntegrity `json:"integrity"`
	EvidencePayload       ReclassificationDeltaEvidencePayload   `json:"evidence_payload"`
}

func deltaEvidenceSemantics() ReclassificationDeltaEvidenceSemantics {
	return ReclassificationDeltaEvidenceSemantics{
		ObservedEvidence: []string{
			"Canonical interaction events in the fixed campaign window, after seed-mailbox exclusion.",
			"The stored supersedes_id lineage linking each superseding verdict to the verdict it replaced.",
		},
		InferredEvidence: []string{
			"Every classification in this report — the origin verdict and the current one alike — is a versioned rule-based classifier output. A delta between two predictions is itself a prediction, not an observation of behaviour that changed.",
		},
		NotObserved: []string{
			"Whether the audience's behaviour changed. This report holds the population fixed and varies only the classifier, which is what makes the movement it reports classifier-attributable; movement beyond it is audience movement and is not measured here.",
			"Why a classifier changed its verdict. The lineage records that it did and under which classifier identity, never the reasoning.",
		},
		AttributionClaim:   "Each in-window event's ORIGIN verdict (the root of its supersedes_id chain) is compared with its CURRENT verdict under the same latest-classified rule the reach report uses, over an identical recipient population. Every figure here is therefore classifier-attributable by construction.",
		RestatementClaim:   "restated_events counts verdicts a newer classifier re-confirmed. It is reported separately from changed_events because a reclassification that agreed with itself is evidence of stability, and folding the two together would make an unchanged verdict look like churn.",
		UnlinkedTreatment:  "unlinked_multiple_verdict_events counts events carrying more than one verdict with no lineage link between them. They are reported rather than ordered: inferring which came first would invent the very history this artifact exists to record.",
		AcceptanceBoundary: "The digest covers the exact evidence payload and detects accidental modification. It is not a Moosewave signature and does not prove authenticity or origin.",
	}
}

// MarshalReclassificationDeltaArtifact builds the digest-addressed artifact.
//
// Exported for the same reason the reach sibling's tests reach for it: a caller
// verifying a downloaded file must be able to recompute the digest with the
// exact code that produced it, rather than reimplementing the canonicalisation
// and discovering a disagreement only when a dispute is already underway.
func MarshalReclassificationDeltaArtifact(
	tenantID, campaignID string, report *ReclassificationDeltaReport,
) ([]byte, string, error) {
	if report == nil {
		return nil, "", errors.New("engagementclassification: nil reclassification delta report")
	}
	payload := ReclassificationDeltaEvidencePayload{
		EvidenceSemantics: deltaEvidenceSemantics(),
		Report:            humanEngagedReachDeltaResponse(tenantID, campaignID, report),
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(payloadJSON)
	digestHex := fmt.Sprintf("%x", digest)
	artifact := ReclassificationDeltaEvidenceArtifact{
		ArtifactSchemaVersion: deltaEvidenceSchema,
		ArtifactKind:          "reclassification_delta_evidence",
		ArtifactID:            "sha256:" + digestHex,
		Integrity: ReclassificationDeltaEvidenceIntegrity{
			Algorithm:        "sha-256",
			DigestSHA256:     digestHex,
			Scope:            "evidence_payload",
			Canonicalization: reachEvidenceCanonicalization,
			Authenticity:     "not_signed",
		},
		EvidencePayload: payload,
	}
	body, err := json.Marshal(artifact)
	if err != nil {
		return nil, "", err
	}
	return body, digestHex, nil
}

// HumanEngagedReachDeltaExport serves
// GET /api/v1/analytics/human-engaged-reach/delta/export.
func (d *HandlerDeps) HumanEngagedReachDeltaExport(w http.ResponseWriter, r *http.Request) {
	tenant, ok := middleware.TenantFromContext(r.Context())
	if !ok || tenant == nil || strings.TrimSpace(tenant.ID) == "" {
		httperror.Write(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	query, generatedAt, validation := d.reportQuery(r.URL)
	if validation != nil {
		httperror.Write(w, http.StatusBadRequest, validation.Code, validation.Message)
		return
	}
	// The same explicit-window requirement the reach export enforces. An export
	// whose window defaulted would produce a file whose digest depended on when
	// it was downloaded, which defeats the point of addressing it by digest.
	if scope := validateEvidenceExportScope(r.URL, query); scope != nil {
		httperror.Write(w, http.StatusBadRequest, scope.Code, scope.Message)
		return
	}
	release, ok := d.requireReachRelease(w, r)
	if !ok {
		return
	}

	report, err := d.Store.ReclassificationDeltaFor(r.Context(), ReclassificationDeltaQuery{
		TenantID: tenant.ID, CampaignID: query.CampaignID,
		Since: query.Since, Until: query.Until,
		Now: func() time.Time { return generatedAt },
	})
	if err != nil {
		d.writeReadError(w, r, err)
		return
	}
	if report == nil {
		d.writeReadError(w, r, errors.New("reclassification delta evidence reader returned nil"))
		return
	}
	if !release.AuthorizesCoverage(report.ClassifierVersionCoverage) {
		d.writeReachUnavailable(w, r, "delta evidence contains shadow, unclassified, or unapproved classifier provenance", nil)
		return
	}
	body, payloadDigest, err := MarshalReclassificationDeltaArtifact(tenant.ID, query.CampaignID, report)
	if err != nil {
		d.writeReadError(w, r, fmt.Errorf("marshal reclassification delta evidence: %w", err))
		return
	}
	bodyDigest := sha256.Sum256(body)
	filename := fmt.Sprintf("reclassification-delta-%s-%s-%s-%s.json",
		query.CampaignID,
		query.Since.UTC().Format("20060102T150405Z"),
		query.Until.UTC().Format("20060102T150405Z"),
		payloadDigest[:12],
	)
	w.Header().Set("Content-Type", deltaEvidenceMediaType+"; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.Header().Set("Content-Digest", "sha-256=:"+base64.StdEncoding.EncodeToString(bodyDigest[:])+":")
	w.Header().Set("ETag", fmt.Sprintf("%q", "sha256-"+fmt.Sprintf("%x", bodyDigest)))
	w.Header().Set("X-Postwave-Artifact-SHA256", payloadDigest)
	w.Header().Set("Cache-Control", "private, no-store, no-transform")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}
