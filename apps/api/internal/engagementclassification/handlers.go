// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

const (
	defaultReportWindow           = 30 * 24 * time.Hour
	maxReportWindow               = 365 * 24 * time.Hour
	reachEvidenceSchema           = "postwave.human-engaged-reach-evidence.v1"
	reachEvidenceMediaType        = "application/vnd.postwave.human-engaged-reach-evidence+json"
	reachEvidenceCanonicalization = "postwave-fixed-schema-json-v1: compact UTF-8 JSON using Go encoding/json v1 field, omitempty, and string-escaping rules; struct schema order; UTC RFC3339Nano timestamps; base-10 integers; subtype rows sorted lexicographically by subtype; classifier coverage sorted unclassified-last, then by classifier/methodology/registry/configuration identity, shadow-mode false-first, and event-count ascending; no trailing newline"

	classificationSummaryMethodology = "Counts canonical opened, clicked, and replied interaction events in the source window after seed-mailbox exclusion. Each event is reported as human, machine, or unknown under its stored classifier provenance; unknown events are never allocated to another bucket."
)

// ReportReader is the read-only subset of Repo exposed by the reporting API.
// Keeping the interface narrow makes the handler contract independently
// testable and prevents an HTTP read surface from acquiring mutation authority.
type ReportReader interface {
	ClassificationSummaryFor(context.Context, SummaryQuery) (*ClassificationSummary, error)
	HumanEngagedReachFor(context.Context, ReachQuery) (*ReachReport, error)
	ReclassificationDeltaFor(context.Context, ReclassificationDeltaQuery) (*ReclassificationDeltaReport, error)
}

// PoweredIncrementalLiftReader is the narrow F02-to-F12 boundary. Its
// implementation owns holdout storage and must return only immutable,
// final, powered results. A nil result means there is no powered result whose
// measurement window is contained by the requested fixed report window.
type PoweredIncrementalLiftReader interface {
	PoweredIncrementalLiftFor(context.Context, PoweredIncrementalLiftQuery) (*PoweredIncrementalLift, error)
}

type PoweredIncrementalLiftQuery struct {
	TenantID   string
	CampaignID string
	Since      time.Time
	Until      time.Time
}

// IncrementalLiftEvidencePointer identifies the durable F02 result without
// inventing a public URL. The UUID is an internal immutable result identity;
// the digest lets an auditor detect changed evidence at that identity.
type IncrementalLiftEvidencePointer struct {
	ResultID       string `json:"result_id"`
	EvidenceSHA256 string `json:"evidence_sha256"`
}

// PoweredIncrementalLift is emitted only for a final F02 result that passed
// its power gate. Underpowered results are omitted rather than surfaced as a
// point estimate.
type PoweredIncrementalLift struct {
	EvidencePointer      IncrementalLiftEvidencePointer `json:"evidence_pointer"`
	Powered              bool                           `json:"powered"`
	ResultVersion        string                         `json:"result_version"`
	Metric               string                         `json:"metric"`
	WindowStart          time.Time                      `json:"window_start"`
	WindowEnd            time.Time                      `json:"window_end"`
	NTreatment           int64                          `json:"n_treatment"`
	NControl             int64                          `json:"n_control"`
	ConversionsTreatment int64                          `json:"conversions_treatment"`
	ConversionsControl   int64                          `json:"conversions_control"`
	RateTreatment        float64                        `json:"rate_treatment"`
	RateControl          float64                        `json:"rate_control"`
	AbsoluteLift         float64                        `json:"absolute_lift"`
	// RelativeLift is percentage lift, not a ratio: 10% -> 15% is 50.
	// It is nil only when the control rate is zero and the ratio is undefined.
	RelativeLift            *float64  `json:"relative_lift,omitempty"`
	IncrementalConversions  float64   `json:"incremental_conversions"`
	PValue                  float64   `json:"p_value"`
	CILow                   float64   `json:"ci_low"`
	CIHigh                  float64   `json:"ci_high"`
	MinimumDetectableEffect float64   `json:"minimum_detectable_effect"`
	MethodologyVersion      string    `json:"methodology_version"`
	MethodologyStatement    string    `json:"methodology_statement"`
	GeneratedAt             time.Time `json:"generated_at"`
}

// HandlerDeps wires the authenticated engagement-classification read surface.
type HandlerDeps struct {
	Store        ReportReader
	ReachRelease ReachReleaseGate
	PoweredLift  PoweredIncrementalLiftReader
	Logger       *slog.Logger
	Now          func() time.Time
}

// ClassificationSummaryResponse is an event-count summary with explicit
// tenant/campaign scope. It deliberately keeps human, machine, and unknown in
// one response: returning a human count without its unknown residue would make
// the result look more certain than the classifier can support.
type ClassificationSummaryResponse struct {
	TenantID   string `json:"tenant_id"`
	CampaignID string `json:"campaign_id,omitempty"`

	WindowStart time.Time `json:"window_start"`
	WindowEnd   time.Time `json:"window_end"`
	GeneratedAt time.Time `json:"generated_at"`

	Unit        string `json:"unit"`
	Methodology string `json:"methodology"`

	Human   int64 `json:"human"`
	Machine int64 `json:"machine"`
	Unknown int64 `json:"unknown"`
	Total   int64 `json:"total"`

	MachineBySubtype map[string]int64 `json:"machine_by_subtype"`

	ClassifierVersion         string                      `json:"classifier_version"`
	MethodologyVersion        string                      `json:"methodology_version"`
	RegistryVersion           string                      `json:"registry_version"`
	ConfigurationHash         string                      `json:"configuration_hash"`
	ClassifierVersionCoverage []ClassifierVersionCoverage `json:"classifier_version_coverage"`
	MixedClassifierVersions   bool                        `json:"mixed_classifier_versions"`
	ShadowMode                bool                        `json:"shadow_mode"`
}

// HumanEngagedReachResponse is the public F12 read contract. The response says
// exactly which population each count represents instead of collapsing
// provider acceptance and human engagement into a generic "reach" number.
type HumanEngagedReachResponse struct {
	TenantID   string `json:"tenant_id"`
	CampaignID string `json:"campaign_id,omitempty"`

	WindowStart time.Time `json:"window_start"`
	WindowEnd   time.Time `json:"window_end"`
	GeneratedAt time.Time `json:"generated_at"`

	Headline string `json:"headline"`

	ProviderAcceptedRecipients  int64            `json:"provider_accepted_recipients"`
	HumanEngagedReachFloor      int64            `json:"human_engaged_reach_floor"`
	UnknownBand                 int64            `json:"unknown_band"`
	HumanEngagedReachUpperBound int64            `json:"human_engaged_reach_upper_bound"`
	MachineOnlyRecipients       int64            `json:"machine_only_recipients"`
	NoInteractionRecipients     int64            `json:"no_interaction_recipients"`
	MachineBySubtype            map[string]int64 `json:"machine_by_subtype"`

	ClassifierVersion         string                      `json:"classifier_version"`
	MethodologyVersion        string                      `json:"methodology_version"`
	RegistryVersion           string                      `json:"registry_version"`
	ConfigurationHash         string                      `json:"configuration_hash"`
	ClassifierVersionCoverage []ClassifierVersionCoverage `json:"classifier_version_coverage"`
	MixedClassifierVersions   bool                        `json:"mixed_classifier_versions"`
	ShadowMode                bool                        `json:"shadow_mode"`
	Methodology               string                      `json:"methodology"`
	IncrementalLift           *PoweredIncrementalLift     `json:"incremental_lift,omitempty"`
}

// HumanEngagedReachEvidenceArtifact is the downloadable F12 evidence
// contract. It is intentionally self-describing: a recipient can verify the
// payload digest without mistaking that digest for a Moosewave signature, and
// can see which inputs were observed versus inferred by a classifier.
type HumanEngagedReachEvidenceArtifact struct {
	ArtifactSchemaVersion string                             `json:"artifact_schema_version"`
	ArtifactKind          string                             `json:"artifact_kind"`
	ArtifactID            string                             `json:"artifact_id"`
	GeneratedAt           time.Time                          `json:"generated_at"`
	Integrity             HumanEngagedReachEvidenceIntegrity `json:"integrity"`
	EvidencePayload       HumanEngagedReachEvidencePayload   `json:"evidence_payload"`
}

type HumanEngagedReachEvidenceIntegrity struct {
	Algorithm        string `json:"algorithm"`
	DigestSHA256     string `json:"digest_sha256"`
	Scope            string `json:"scope"`
	Canonicalization string `json:"canonicalization"`
	Authenticity     string `json:"authenticity"`
}

type HumanEngagedReachEvidencePayload struct {
	EvidenceSemantics HumanEngagedReachEvidenceSemantics `json:"evidence_semantics"`
	Report            HumanEngagedReachEvidenceReport    `json:"report"`
}

type HumanEngagedReachEvidenceSemantics struct {
	ObservedEvidence   []string `json:"observed_evidence"`
	InferredEvidence   []string `json:"inferred_evidence"`
	NotObserved        []string `json:"not_observed"`
	HumanReachClaim    string   `json:"human_reach_claim"`
	UnknownTreatment   string   `json:"unknown_treatment"`
	AcceptanceBoundary string   `json:"acceptance_boundary"`
}

// HumanEngagedReachEvidenceReport omits a request-time field on purpose. The
// required generation timestamp lives at the artifact envelope, outside the
// content-addressed evidence payload, so two regenerations keep one evidence
// identity while their standalone documents differ only by generated_at.
type HumanEngagedReachEvidenceReport struct {
	TenantID   string `json:"tenant_id"`
	CampaignID string `json:"campaign_id"`

	WindowStart time.Time `json:"window_start"`
	WindowEnd   time.Time `json:"window_end"`

	Headline string `json:"headline"`

	ProviderAcceptedRecipients  int64                             `json:"provider_accepted_recipients"`
	HumanEngagedReachFloor      int64                             `json:"human_engaged_reach_floor"`
	UnknownBand                 int64                             `json:"unknown_band"`
	HumanEngagedReachUpperBound int64                             `json:"human_engaged_reach_upper_bound"`
	MachineOnlyRecipients       int64                             `json:"machine_only_recipients"`
	NoInteractionRecipients     int64                             `json:"no_interaction_recipients"`
	MachineBySubtype            []HumanEngagedReachMachineSubtype `json:"machine_by_subtype"`

	ClassifierVersion         string                      `json:"classifier_version"`
	MethodologyVersion        string                      `json:"methodology_version"`
	RegistryVersion           string                      `json:"registry_version"`
	ConfigurationHash         string                      `json:"configuration_hash"`
	ClassifierVersionCoverage []ClassifierVersionCoverage `json:"classifier_version_coverage"`
	MixedClassifierVersions   bool                        `json:"mixed_classifier_versions"`
	ShadowMode                bool                        `json:"shadow_mode"`
	Methodology               string                      `json:"methodology"`
	IncrementalLift           *PoweredIncrementalLift     `json:"incremental_lift,omitempty"`
}

type HumanEngagedReachMachineSubtype struct {
	Subtype    string `json:"subtype"`
	Recipients int64  `json:"recipients"`
}

// HumanEngagedReachDeltaResponse is the read over the supersession lineage.
//
// It exists so a moving reach figure can be ATTRIBUTED. The reach response is
// one integer and a band; two different causes — the audience changed, or the
// classifier changed — move it identically, and a customer asked to explain the
// movement to their own stakeholders cannot do so from the figure alone. This
// response holds the population fixed and reports only what reclassification
// did, so the remainder is audience by subtraction.
type HumanEngagedReachDeltaResponse struct {
	TenantID   string `json:"tenant_id"`
	CampaignID string `json:"campaign_id,omitempty"`

	WindowStart time.Time `json:"window_start"`
	WindowEnd   time.Time `json:"window_end"`
	GeneratedAt time.Time `json:"generated_at"`

	Headline string `json:"headline"`

	EligibleEvents   int64 `json:"eligible_events"`
	ClassifiedEvents int64 `json:"classified_events"`

	SupersededEvents     int64 `json:"superseded_events"`
	ChangedEvents        int64 `json:"changed_events"`
	RestatedEvents       int64 `json:"restated_events"`
	MaxSupersessionDepth int   `json:"max_supersession_depth"`

	UnlinkedMultipleVerdictEvents int64 `json:"unlinked_multiple_verdict_events"`

	Transitions []ClassificationTransition `json:"transitions"`

	HumanEventDelta   int64 `json:"human_event_delta"`
	MachineEventDelta int64 `json:"machine_event_delta"`
	UnknownEventDelta int64 `json:"unknown_event_delta"`

	RecipientsConsidered int64 `json:"recipients_considered"`

	HumanEngagedReachFloorBefore int64 `json:"human_engaged_reach_floor_before"`
	HumanEngagedReachFloorAfter  int64 `json:"human_engaged_reach_floor_after"`
	HumanEngagedReachFloorDelta  int64 `json:"human_engaged_reach_floor_delta"`

	UnknownBandBefore int64 `json:"unknown_band_before"`
	UnknownBandAfter  int64 `json:"unknown_band_after"`
	UnknownBandDelta  int64 `json:"unknown_band_delta"`

	MachineOnlyRecipientsBefore int64 `json:"machine_only_recipients_before"`
	MachineOnlyRecipientsAfter  int64 `json:"machine_only_recipients_after"`
	MachineOnlyRecipientsDelta  int64 `json:"machine_only_recipients_delta"`

	ClassifierVersionCoverage []ClassifierVersionCoverage `json:"classifier_version_coverage"`
	MixedClassifierVersions   bool                        `json:"mixed_classifier_versions"`

	Methodology string `json:"methodology"`
}

// MountRoutes registers the F01/F12 reporting reads. The caller must mount it
// inside the authenticated tenant middleware group; read:reports remains an
// explicit route-local gate for API-key and session callers.
func (d *HandlerDeps) MountRoutes(r chi.Router) {
	if d == nil || d.Store == nil || r == nil {
		return
	}
	readReports := apikeys.RequireScope(apikeys.ScopeReadReports)
	r.With(readReports).Get("/api/v1/analytics/engagement-classification/summary", d.ClassificationSummary)
	r.With(readReports).Get("/api/v1/analytics/human-engaged-reach", d.HumanEngagedReach)
	r.With(readReports).Get("/api/v1/analytics/human-engaged-reach/export", d.HumanEngagedReachEvidenceExport)
	r.With(readReports).Get("/api/v1/analytics/human-engaged-reach/delta", d.HumanEngagedReachDelta)
	r.With(readReports).Get("/api/v1/analytics/human-engaged-reach/delta/export", d.HumanEngagedReachDeltaExport)
}

// HumanEngagedReachDelta serves GET
// /api/v1/analytics/human-engaged-reach/delta.
func (d *HandlerDeps) HumanEngagedReachDelta(w http.ResponseWriter, r *http.Request) {
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
		d.writeReadError(w, r, errors.New("reclassification delta reader returned nil"))
		return
	}
	if !release.AuthorizesCoverage(report.ClassifierVersionCoverage) {
		d.writeReachUnavailable(w, r, "report contains shadow, unclassified, or unapproved classifier provenance", nil)
		return
	}

	writeReportJSON(w, humanEngagedReachDeltaResponse(tenant.ID, query.CampaignID, report))
}

func humanEngagedReachDeltaResponse(
	tenantID, campaignID string,
	report *ReclassificationDeltaReport,
) HumanEngagedReachDeltaResponse {
	transitions := report.Transitions
	if transitions == nil {
		transitions = []ClassificationTransition{}
	}
	return HumanEngagedReachDeltaResponse{
		TenantID: tenantID, CampaignID: campaignID,
		WindowStart: report.WindowStart, WindowEnd: report.WindowEnd,
		GeneratedAt: report.GeneratedAt,
		Headline:    report.Headline(),

		EligibleEvents:   report.EligibleEvents,
		ClassifiedEvents: report.ClassifiedEvents,

		SupersededEvents:     report.SupersededEvents,
		ChangedEvents:        report.ChangedEvents,
		RestatedEvents:       report.RestatedEvents,
		MaxSupersessionDepth: report.MaxSupersessionDepth,

		UnlinkedMultipleVerdictEvents: report.UnlinkedMultipleVerdictEvents,

		Transitions: transitions,

		HumanEventDelta:   report.HumanEventDelta,
		MachineEventDelta: report.MachineEventDelta,
		UnknownEventDelta: report.UnknownEventDelta,

		RecipientsConsidered: report.RecipientsConsidered,

		HumanEngagedReachFloorBefore: report.ReachFloorBefore,
		HumanEngagedReachFloorAfter:  report.ReachFloorAfter,
		HumanEngagedReachFloorDelta:  report.ReachFloorDelta,

		UnknownBandBefore: report.UnknownBandBefore,
		UnknownBandAfter:  report.UnknownBandAfter,
		UnknownBandDelta:  report.UnknownBandDelta,

		MachineOnlyRecipientsBefore: report.MachineOnlyBefore,
		MachineOnlyRecipientsAfter:  report.MachineOnlyAfter,
		MachineOnlyRecipientsDelta:  report.MachineOnlyDelta,

		ClassifierVersionCoverage: nonNilCoverage(report.ClassifierVersionCoverage),
		MixedClassifierVersions:   report.MixedClassifierVersions,

		Methodology: report.Methodology,
	}
}

// ClassificationSummary serves GET
// /api/v1/analytics/engagement-classification/summary.
func (d *HandlerDeps) ClassificationSummary(w http.ResponseWriter, r *http.Request) {
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
	query.TenantID = tenant.ID

	summary, err := d.Store.ClassificationSummaryFor(r.Context(), query)
	if err != nil {
		d.writeReadError(w, r, err)
		return
	}
	if summary == nil {
		d.writeReadError(w, r, errors.New("engagement classification summary reader returned nil"))
		return
	}

	writeReportJSON(w, ClassificationSummaryResponse{
		TenantID: tenant.ID, CampaignID: query.CampaignID,
		WindowStart: summary.WindowStart, WindowEnd: summary.WindowEnd,
		GeneratedAt: generatedAt,
		Unit:        "interaction_events", Methodology: classificationSummaryMethodology,
		Human: summary.Human, Machine: summary.Machine, Unknown: summary.Unknown,
		Total: summary.Total, MachineBySubtype: nonNilCounts(summary.MachineBySubtype),
		ClassifierVersion:         summary.ClassifierVersion,
		MethodologyVersion:        summary.MethodologyVersion,
		RegistryVersion:           summary.RegistryVersion,
		ConfigurationHash:         summary.ConfigurationHash,
		ClassifierVersionCoverage: nonNilCoverage(summary.ClassifierVersionCoverage),
		MixedClassifierVersions:   summary.MixedClassifierVersions,
		ShadowMode:                summary.ShadowMode,
	})
}

// HumanEngagedReach serves GET /api/v1/analytics/human-engaged-reach.
func (d *HandlerDeps) HumanEngagedReach(w http.ResponseWriter, r *http.Request) {
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
	release, ok := d.requireReachRelease(w, r)
	if !ok {
		return
	}
	reachQuery := ReachQuery{
		TenantID: tenant.ID, CampaignID: query.CampaignID,
		Since: query.Since, Until: query.Until,
		Now: func() time.Time { return generatedAt },
	}

	report, err := d.Store.HumanEngagedReachFor(r.Context(), reachQuery)
	if err != nil {
		d.writeReadError(w, r, err)
		return
	}
	if report == nil {
		d.writeReadError(w, r, errors.New("human-engaged reach reader returned nil"))
		return
	}
	if report.ShadowMode || !release.AuthorizesCoverage(report.ClassifierVersionCoverage) {
		d.writeReachUnavailable(w, r, "report contains shadow, unclassified, or unapproved classifier provenance", nil)
		return
	}
	lift, err := d.poweredIncrementalLiftFor(r.Context(), PoweredIncrementalLiftQuery{
		TenantID: tenant.ID, CampaignID: query.CampaignID,
		Since: query.Since, Until: query.Until,
	})
	if err != nil {
		d.writeReadError(w, r, fmt.Errorf("read powered incremental lift: %w", err))
		return
	}

	writeReportJSON(w, humanEngagedReachResponse(tenant.ID, query.CampaignID, report, lift))
}

// HumanEngagedReachEvidenceExport serves GET
// /api/v1/analytics/human-engaged-reach/export. Unlike the interactive read,
// an evidence export requires all scope inputs explicitly so a saved artifact
// never relies on a moving server-time default.
func (d *HandlerDeps) HumanEngagedReachEvidenceExport(w http.ResponseWriter, r *http.Request) {
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
	if validation = validateEvidenceExportScope(r.URL, query); validation != nil {
		httperror.Write(w, http.StatusBadRequest, validation.Code, validation.Message)
		return
	}
	release, ok := d.requireReachRelease(w, r)
	if !ok {
		return
	}

	report, err := d.Store.HumanEngagedReachFor(r.Context(), ReachQuery{
		TenantID: tenant.ID, CampaignID: query.CampaignID,
		Since: query.Since, Until: query.Until,
		Now: func() time.Time { return generatedAt },
	})
	if err != nil {
		d.writeReadError(w, r, err)
		return
	}
	if report == nil {
		d.writeReadError(w, r, errors.New("human-engaged reach evidence reader returned nil"))
		return
	}
	if report.ShadowMode || !release.AuthorizesCoverage(report.ClassifierVersionCoverage) {
		d.writeReachUnavailable(w, r, "evidence contains shadow, unclassified, or unapproved classifier provenance", nil)
		return
	}
	lift, err := d.poweredIncrementalLiftFor(r.Context(), PoweredIncrementalLiftQuery{
		TenantID: tenant.ID, CampaignID: query.CampaignID,
		Since: query.Since, Until: query.Until,
	})
	if err != nil {
		d.writeReadError(w, r, fmt.Errorf("read powered incremental lift: %w", err))
		return
	}

	body, payloadDigest, err := marshalReachEvidenceArtifact(
		tenant.ID, query.CampaignID, query.Since, query.Until, generatedAt, report, lift,
	)
	if err != nil {
		d.writeReadError(w, r, fmt.Errorf("marshal human-engaged reach evidence: %w", err))
		return
	}
	bodyDigest := sha256.Sum256(body)
	filename := fmt.Sprintf("human-engaged-reach-%s-%s-%s-%s.json",
		query.CampaignID,
		query.Since.UTC().Format("20060102T150405Z"),
		query.Until.UTC().Format("20060102T150405Z"),
		payloadDigest[:12],
	)
	// The vendor +json media type is intentionally outside the global
	// compressor allowlist. RFC 9110 reserves `identity` for Accept-Encoding
	// and says it should not be emitted in Content-Encoding, so selecting an
	// uncompressed representation by media type keeps the exact-byte digest
	// valid without manufacturing an identity content coding.
	w.Header().Set("Content-Type", reachEvidenceMediaType+"; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", filename))
	w.Header().Set("Content-Digest", "sha-256=:"+base64.StdEncoding.EncodeToString(bodyDigest[:])+":")
	w.Header().Set("ETag", fmt.Sprintf("\"sha256-%x\"", bodyDigest))
	w.Header().Set("X-Postwave-Artifact-SHA256", payloadDigest)
	w.Header().Set("Cache-Control", "private, no-store, no-transform")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func humanEngagedReachResponse(
	tenantID, campaignID string,
	report *ReachReport,
	lift *PoweredIncrementalLift,
) HumanEngagedReachResponse {
	return HumanEngagedReachResponse{
		TenantID: tenantID, CampaignID: campaignID,
		WindowStart: report.WindowStart, WindowEnd: report.WindowEnd,
		GeneratedAt:                 report.GeneratedAt,
		Headline:                    report.Headline(),
		ProviderAcceptedRecipients:  report.Delivered,
		HumanEngagedReachFloor:      report.HumanEngagedReachFloor,
		UnknownBand:                 report.UnknownBand,
		HumanEngagedReachUpperBound: report.HumanEngagedReachFloor + report.UnknownBand,
		MachineOnlyRecipients:       report.MachineOnly,
		NoInteractionRecipients:     report.NoInteraction,
		MachineBySubtype:            nonNilCounts(report.MachineBySubtype),
		ClassifierVersion:           report.ClassifierVersion,
		MethodologyVersion:          report.MethodologyVersion,
		RegistryVersion:             report.RegistryVersion,
		ConfigurationHash:           report.ConfigurationHash,
		ClassifierVersionCoverage:   nonNilCoverage(report.ClassifierVersionCoverage),
		MixedClassifierVersions:     report.MixedClassifierVersions,
		ShadowMode:                  report.ShadowMode,
		Methodology:                 report.Methodology,
		IncrementalLift:             lift,
	}
}

func validateEvidenceExportScope(requestURL *url.URL, query SummaryQuery) *reportValidation {
	if requestURL == nil {
		return &reportValidation{Code: "invalid_query", Message: "query string is invalid"}
	}
	values, err := url.ParseQuery(requestURL.RawQuery)
	if err != nil {
		return &reportValidation{Code: "invalid_query", Message: "query string is invalid"}
	}
	if query.CampaignID == "" {
		return &reportValidation{Code: "campaign_scope_required", Message: "campaign_id is required for an evidence export"}
	}
	for _, key := range []string{"since", "until"} {
		if _, present := values[key]; !present {
			return &reportValidation{Code: "fixed_window_required", Message: "since and until are required for an evidence export"}
		}
	}
	return nil
}

func (d *HandlerDeps) poweredIncrementalLiftFor(
	ctx context.Context,
	query PoweredIncrementalLiftQuery,
) (*PoweredIncrementalLift, error) {
	if d == nil || d.PoweredLift == nil || strings.TrimSpace(query.CampaignID) == "" {
		return nil, nil
	}
	lift, err := d.PoweredLift.PoweredIncrementalLiftFor(ctx, query)
	if err != nil || lift == nil {
		return lift, err
	}
	if err := validatePoweredIncrementalLift(query, lift); err != nil {
		return nil, err
	}
	copy := *lift
	copy.WindowStart = copy.WindowStart.UTC()
	copy.WindowEnd = copy.WindowEnd.UTC()
	copy.GeneratedAt = copy.GeneratedAt.UTC()
	if copy.RelativeLift != nil {
		relative := *copy.RelativeLift
		copy.RelativeLift = &relative
	}
	return &copy, nil
}

func validatePoweredIncrementalLift(
	query PoweredIncrementalLiftQuery,
	lift *PoweredIncrementalLift,
) error {
	if lift == nil {
		return nil
	}
	resultID, err := uuid.Parse(strings.TrimSpace(lift.EvidencePointer.ResultID))
	if err != nil || resultID == uuid.Nil {
		return errors.New("powered incremental lift has an invalid evidence result id")
	}
	if !isLowerHexSHA256(lift.EvidencePointer.EvidenceSHA256) {
		return errors.New("powered incremental lift has an invalid evidence digest")
	}
	if !lift.Powered || !isTrimmedNonEmpty(lift.ResultVersion) || !isTrimmedNonEmpty(lift.Metric) ||
		!isTrimmedNonEmpty(lift.MethodologyVersion) || !isTrimmedNonEmpty(lift.MethodologyStatement) ||
		len(lift.MethodologyStatement) > 4000 || lift.GeneratedAt.IsZero() {
		return errors.New("powered incremental lift provenance is incomplete")
	}
	if lift.WindowStart.IsZero() || lift.WindowEnd.IsZero() || !lift.WindowStart.Before(lift.WindowEnd) ||
		lift.WindowStart.Before(query.Since) || lift.WindowEnd.After(query.Until) {
		return errors.New("powered incremental lift window is outside the fixed report window")
	}
	if lift.GeneratedAt.Before(lift.WindowEnd) {
		return errors.New("powered incremental lift was finalized before its measurement window closed")
	}
	if lift.NTreatment <= 0 || lift.NControl <= 0 ||
		lift.ConversionsTreatment < 0 || lift.ConversionsTreatment > lift.NTreatment ||
		lift.ConversionsControl < 0 || lift.ConversionsControl > lift.NControl {
		return errors.New("powered incremental lift populations are invalid")
	}
	values := []float64{
		lift.RateTreatment, lift.RateControl, lift.AbsoluteLift,
		lift.IncrementalConversions, lift.PValue, lift.CILow, lift.CIHigh,
		lift.MinimumDetectableEffect,
	}
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return errors.New("powered incremental lift contains a non-finite value")
		}
	}
	if lift.RelativeLift != nil && (math.IsNaN(*lift.RelativeLift) || math.IsInf(*lift.RelativeLift, 0)) {
		return errors.New("powered incremental lift contains a non-finite relative lift")
	}
	if lift.RateTreatment < 0 || lift.RateTreatment > 1 || lift.RateControl < 0 || lift.RateControl > 1 ||
		lift.PValue < 0 || lift.PValue > 1 || lift.MinimumDetectableEffect < 0 ||
		lift.CILow > lift.CIHigh || lift.AbsoluteLift < lift.CILow || lift.AbsoluteLift > lift.CIHigh {
		return errors.New("powered incremental lift statistics are invalid")
	}
	if !approximatelyEqual(lift.RateTreatment, float64(lift.ConversionsTreatment)/float64(lift.NTreatment)) ||
		!approximatelyEqual(lift.RateControl, float64(lift.ConversionsControl)/float64(lift.NControl)) ||
		!approximatelyEqual(lift.AbsoluteLift, lift.RateTreatment-lift.RateControl) ||
		!approximatelyEqual(lift.IncrementalConversions, lift.AbsoluteLift*float64(lift.NTreatment)) {
		return errors.New("powered incremental lift derived statistics do not reconcile")
	}
	if lift.RateControl == 0 {
		if lift.RelativeLift != nil {
			return errors.New("powered incremental lift has a relative lift with no control baseline")
		}
	} else if lift.RelativeLift == nil ||
		!approximatelyEqual(*lift.RelativeLift, lift.AbsoluteLift/lift.RateControl*100) {
		return errors.New("powered incremental lift relative percentage does not reconcile")
	}
	return nil
}

func isTrimmedNonEmpty(value string) bool {
	return value != "" && value == strings.TrimSpace(value)
}

func approximatelyEqual(left, right float64) bool {
	const tolerance = 1e-12
	scale := math.Max(1, math.Max(math.Abs(left), math.Abs(right)))
	return math.Abs(left-right) <= tolerance*scale
}

func isLowerHexSHA256(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

func marshalReachEvidenceArtifact(
	tenantID string,
	campaignID string,
	since time.Time,
	until time.Time,
	generatedAt time.Time,
	report *ReachReport,
	lift *PoweredIncrementalLift,
) ([]byte, string, error) {
	if err := validateReachEvidenceReport(report); err != nil {
		return nil, "", err
	}
	semantics := HumanEngagedReachEvidenceSemantics{
		ObservedEvidence: []string{
			"Provider-reported accepted delivery events for unique non-seed recipients in the fixed campaign window.",
			"Canonical opened, clicked, and replied interaction events associated with those delivered recipients.",
		},
		InferredEvidence: []string{
			"Human, machine, and unknown interaction labels are versioned rule-based classifier outputs; they are predictions from observed event evidence, not direct observations of a person reading a message.",
		},
		NotObserved: []string{
			"Inbox or folder placement in a recipient mailbox.",
			"A recipient's visual attention, comprehension, or decision to act.",
			"A mailbox provider's private AI summary or its interpretation of the message.",
		},
		HumanReachClaim:    "A lower bound: unique provider-accepted recipients with at least one interaction classified human.",
		UnknownTreatment:   "Recipients with unknown-only interaction evidence form a separate upper-bound band and are never allocated to human or machine.",
		AcceptanceBoundary: "Provider acceptance is a transport observation; it is not inbox placement, delivery to a visible folder, or human attention.",
	}
	if lift == nil {
		semantics.NotObserved = append(semantics.NotObserved,
			"No authoritative final powered F02 holdout result was available inside this fixed report window, so this document makes no incremental-lift claim.")
	} else {
		semantics.ObservedEvidence = append(semantics.ObservedEvidence,
			"An immutable final powered F02 holdout result, identified by result UUID and evidence SHA-256.")
	}
	payload := HumanEngagedReachEvidencePayload{
		EvidenceSemantics: semantics,
		Report: HumanEngagedReachEvidenceReport{
			TenantID: tenantID, CampaignID: campaignID,
			WindowStart: since.UTC(), WindowEnd: until.UTC(),
			Headline:                    report.Headline(),
			ProviderAcceptedRecipients:  report.Delivered,
			HumanEngagedReachFloor:      report.HumanEngagedReachFloor,
			UnknownBand:                 report.UnknownBand,
			HumanEngagedReachUpperBound: report.HumanEngagedReachFloor + report.UnknownBand,
			MachineOnlyRecipients:       report.MachineOnly,
			NoInteractionRecipients:     report.NoInteraction,
			MachineBySubtype:            sortedMachineSubtypeEvidence(report.MachineBySubtype),
			ClassifierVersion:           report.ClassifierVersion,
			MethodologyVersion:          report.MethodologyVersion,
			RegistryVersion:             report.RegistryVersion,
			ConfigurationHash:           report.ConfigurationHash,
			ClassifierVersionCoverage:   sortedCoverageEvidence(report.ClassifierVersionCoverage),
			MixedClassifierVersions:     report.MixedClassifierVersions,
			ShadowMode:                  report.ShadowMode,
			Methodology:                 report.Methodology,
			IncrementalLift:             lift,
		},
	}
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(payloadJSON)
	digestHex := fmt.Sprintf("%x", digest)
	artifact := HumanEngagedReachEvidenceArtifact{
		ArtifactSchemaVersion: reachEvidenceSchema,
		ArtifactKind:          "human_engaged_reach_evidence",
		ArtifactID:            "sha256:" + digestHex,
		GeneratedAt:           generatedAt.UTC(),
		Integrity: HumanEngagedReachEvidenceIntegrity{
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
	return append(body, '\n'), digestHex, nil
}

func validateReachEvidenceReport(report *ReachReport) error {
	if report == nil {
		return errors.New("reach report is nil")
	}
	if strings.TrimSpace(report.Methodology) == "" {
		return errors.New("reach report methodology is empty")
	}
	populations := []int64{
		report.HumanEngagedReachFloor,
		report.UnknownBand,
		report.MachineOnly,
		report.NoInteraction,
	}
	total, err := checkedNonNegativeSum(populations)
	if err != nil {
		return fmt.Errorf("reach report population invariant: %w", err)
	}
	if report.Delivered < 0 || total != report.Delivered {
		return fmt.Errorf("reach report populations total %d, provider-accepted recipients %d", total, report.Delivered)
	}

	subtypeCounts := make([]int64, 0, len(report.MachineBySubtype))
	for subtype, count := range report.MachineBySubtype {
		if strings.TrimSpace(subtype) == "" {
			return errors.New("reach report has an empty machine subtype")
		}
		subtypeCounts = append(subtypeCounts, count)
	}
	subtypeTotal, err := checkedNonNegativeSum(subtypeCounts)
	if err != nil {
		return fmt.Errorf("reach report machine subtype invariant: %w", err)
	}
	if subtypeTotal != report.MachineOnly {
		return fmt.Errorf("reach report machine subtypes total %d, machine-only recipients %d", subtypeTotal, report.MachineOnly)
	}
	for _, coverage := range report.ClassifierVersionCoverage {
		if coverage.EventCount < 0 {
			return errors.New("reach report classifier coverage contains a negative event count")
		}
	}
	return nil
}

func checkedNonNegativeSum(values []int64) (int64, error) {
	var total int64
	for _, value := range values {
		if value < 0 {
			return 0, errors.New("negative count")
		}
		if total > math.MaxInt64-value {
			return 0, errors.New("count overflow")
		}
		total += value
	}
	return total, nil
}

func sortedMachineSubtypeEvidence(input map[string]int64) []HumanEngagedReachMachineSubtype {
	keys := make([]string, 0, len(input))
	for key := range input {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([]HumanEngagedReachMachineSubtype, 0, len(keys))
	for _, key := range keys {
		out = append(out, HumanEngagedReachMachineSubtype{Subtype: key, Recipients: input[key]})
	}
	return out
}

func sortedCoverageEvidence(input []ClassifierVersionCoverage) []ClassifierVersionCoverage {
	out := append([]ClassifierVersionCoverage(nil), input...)
	sort.Slice(out, func(i, j int) bool {
		left, right := out[i], out[j]
		if left.Unclassified != right.Unclassified {
			return !left.Unclassified
		}
		if left.ClassifierVersion != right.ClassifierVersion {
			return left.ClassifierVersion < right.ClassifierVersion
		}
		if left.MethodologyVersion != right.MethodologyVersion {
			return left.MethodologyVersion < right.MethodologyVersion
		}
		if left.RegistryVersion != right.RegistryVersion {
			return left.RegistryVersion < right.RegistryVersion
		}
		if left.ConfigurationHash != right.ConfigurationHash {
			return left.ConfigurationHash < right.ConfigurationHash
		}
		if left.ShadowMode != right.ShadowMode {
			return !left.ShadowMode
		}
		return left.EventCount < right.EventCount
	})
	if out == nil {
		return []ClassifierVersionCoverage{}
	}
	return out
}

type reportValidation struct {
	Code    string
	Message string
}

func (d *HandlerDeps) reportQuery(requestURL *url.URL) (SummaryQuery, time.Time, *reportValidation) {
	now := time.Now().UTC()
	if d != nil && d.Now != nil {
		now = d.Now().UTC()
	}
	if requestURL == nil {
		return SummaryQuery{}, now, &reportValidation{Code: "invalid_query", Message: "query string is invalid"}
	}
	values, err := url.ParseQuery(requestURL.RawQuery)
	if err != nil {
		return SummaryQuery{}, now, &reportValidation{Code: "invalid_query", Message: "query string is invalid"}
	}
	allowed := map[string]bool{"campaign_id": true, "since": true, "until": true}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if !allowed[key] {
			return SummaryQuery{}, now, &reportValidation{Code: "unknown_query_parameter", Message: "query contains an unsupported parameter"}
		}
		if len(values[key]) != 1 {
			return SummaryQuery{}, now, &reportValidation{Code: "duplicate_query_parameter", Message: "query parameters must appear at most once"}
		}
	}

	query := SummaryQuery{Until: now}
	if raw, present := oneQueryValue(values, "until"); present {
		parsed, parseErr := time.Parse(time.RFC3339, raw)
		if parseErr != nil {
			return SummaryQuery{}, now, &reportValidation{Code: "invalid_until", Message: "until must be an RFC3339 timestamp"}
		}
		query.Until = parsed.UTC()
	}
	query.Since = query.Until.Add(-defaultReportWindow)
	if raw, present := oneQueryValue(values, "since"); present {
		parsed, parseErr := time.Parse(time.RFC3339, raw)
		if parseErr != nil {
			return SummaryQuery{}, now, &reportValidation{Code: "invalid_since", Message: "since must be an RFC3339 timestamp"}
		}
		query.Since = parsed.UTC()
	}
	if !query.Since.Before(query.Until) {
		return SummaryQuery{}, now, &reportValidation{Code: "invalid_window", Message: "since must precede until"}
	}
	if query.Until.Sub(query.Since) > maxReportWindow {
		return SummaryQuery{}, now, &reportValidation{Code: "window_too_large", Message: "report window must not exceed 365 days"}
	}

	if raw, present := oneQueryValue(values, "campaign_id"); present {
		parsed, parseErr := uuid.Parse(raw)
		if parseErr != nil || parsed == uuid.Nil {
			return SummaryQuery{}, now, &reportValidation{Code: "invalid_campaign_id", Message: "campaign_id must be a non-zero UUID"}
		}
		query.CampaignID = parsed.String()
	}
	return query, now, nil
}

func oneQueryValue(values url.Values, key string) (string, bool) {
	items, ok := values[key]
	if !ok || len(items) != 1 {
		return "", ok
	}
	return strings.TrimSpace(items[0]), true
}

func (d *HandlerDeps) writeReadError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, ErrCampaignNotFound) {
		httperror.Write(w, http.StatusNotFound, "campaign_not_found", "campaign not found")
		return
	}
	if errors.Is(err, ErrInvalidInput) {
		httperror.Write(w, http.StatusBadRequest, "invalid_report_query", "report query is invalid")
		return
	}
	httperror.WriteInternal(w, d.Logger, err, r.Context())
}

func (d *HandlerDeps) requireReachRelease(
	w http.ResponseWriter,
	r *http.Request,
) (ReachReleaseStatus, bool) {
	if d == nil || d.ReachRelease == nil {
		d.writeReachUnavailable(w, r, "release gate is not composed", nil)
		return ReachReleaseStatus{}, false
	}
	status, err := d.ReachRelease.HumanEngagedReachRelease(r.Context())
	if err != nil {
		d.writeReachUnavailable(w, r, "release evidence could not be evaluated", err)
		return ReachReleaseStatus{}, false
	}
	if !status.Available() {
		d.writeReachUnavailable(w, r, "no passing calibration and cutover approval pair exists", nil)
		return ReachReleaseStatus{}, false
	}
	return status, true
}

func (d *HandlerDeps) writeReachUnavailable(
	w http.ResponseWriter,
	r *http.Request,
	reason string,
	err error,
) {
	logger := slog.Default()
	if d != nil && d.Logger != nil {
		logger = d.Logger
	}
	attributes := []any{"reason", reason}
	if err != nil {
		attributes = append(attributes, "error", err.Error())
	}
	logger.WarnContext(r.Context(), "human-engaged reach release gate denied a read", attributes...)
	w.Header().Set("Cache-Control", "private, no-store")
	// This is a durable state conflict, not an infrastructure outage. A 5xx is
	// deliberately avoided: the shared error writer sanitizes all 5xx prose,
	// which would discard the server-owned explanation clients must render, and
	// automatic retries cannot create the missing evidence or approval.
	httperror.Write(w, http.StatusConflict, ReachUnavailableCode, ReachUnavailableMessage)
}

func writeReportJSON(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(body)
}

func nonNilCounts(input map[string]int64) map[string]int64 {
	if input == nil {
		return map[string]int64{}
	}
	return input
}

func nonNilCoverage(input []ClassifierVersionCoverage) []ClassifierVersionCoverage {
	if input == nil {
		return []ClassifierVersionCoverage{}
	}
	return input
}
