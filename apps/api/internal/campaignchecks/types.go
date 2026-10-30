// SPDX-License-Identifier: AGPL-3.0-only

package campaignchecks

import (
	"encoding/json"

	"github.com/postwave/postwave/apps/api/internal/campaignartifact"
	"github.com/postwave/postwave/apps/api/internal/campaigncompiler"
)

const (
	DetectorVersion      = "postwave.campaign-checks.deterministic.v2"
	DefaultPolicyVersion = "postwave.campaign-assurance.gate-policy.v1"

	MaxHTMLBytes           = 8 << 20
	MaxTextBytes           = 2 << 20
	MaxMIMEBytes           = 32 << 20
	MaxStructuredDataBytes = 1 << 20
	MaxFactContractBytes   = 1 << 20
	MaxReceiptJSONBytes    = 1 << 20
	MaxReceiptEntries      = 100_000
	MaxMetadataStringBytes = 4 << 10
	MaxHTMLElementCount    = 100_000
	MaxHTMLDepth           = 256
	MaxCSSBytes            = 256 << 10
	MaxCSSRules            = 2_048
	MaxImages              = 2_048
	MaxImageEncodedBytes   = 64 << 20
	MaxImageDimension      = 100_000
	MaxImagePixels         = 100_000_000
	MaxOCRTextBytes        = 32 << 10
	MaxImageObjectRefBytes = 2 << 10
	MaxFindings            = 2_048
	MaxEvidencePerFinding  = 32
)

type Severity string

const (
	SeverityInfo     Severity = "info"
	SeverityWarning  Severity = "warning"
	SeverityError    Severity = "error"
	SeverityCritical Severity = "critical"
)

type Dimension string

const (
	DimensionInput          Dimension = "input"
	DimensionMIME           Dimension = "mime"
	DimensionParity         Dimension = "representation.parity"
	DimensionFactContract   Dimension = "fact_contract"
	DimensionPrimaryAction  Dimension = "primary_action"
	DimensionImageMeaning   Dimension = "image_meaning"
	DimensionAccessibility  Dimension = "accessibility"
	DimensionHiddenContent  Dimension = "hidden_content"
	DimensionStructuredData Dimension = "structured_data"
	// DimensionAgentComprehension is the only dimension whose findings can
	// depend on a model. Everything else in this package is a statement about
	// bytes; this one is a statement about what a summariser did with them, and
	// keeping it separately named stops a reader from assuming the whole report
	// is deterministic once one model-backed finding is merged into it.
	DimensionAgentComprehension Dimension = "agent_comprehension"
)

type Representation string

const (
	RepresentationRevision       Representation = "revision"
	RepresentationManifest       Representation = "representation_manifest"
	RepresentationMIME           Representation = "mime"
	RepresentationPlainText      Representation = "text_plain"
	RepresentationVisibleHTML    Representation = "visible_html"
	RepresentationHTMLSource     Representation = "html_source"
	RepresentationImageAlt       Representation = "image_alt"
	RepresentationImageMetadata  Representation = "image_metadata"
	RepresentationImageOCR       Representation = "image_ocr"
	RepresentationStructuredData Representation = "structured_data"
)

type CapabilityStatus string

const (
	CapabilityUnavailable CapabilityStatus = "unavailable"
	CapabilityProvided    CapabilityStatus = "provided"
)

// Capability makes negative claims explicit. In particular, a deterministic
// report can never be mistaken for OCR output or modeled inbox comprehension.
type Capability struct {
	ID      string           `json:"id"`
	Status  CapabilityStatus `json:"status"`
	Version string           `json:"version,omitempty"`
	Reason  string           `json:"reason,omitempty"`
}

type ImageInspectionStatus string
type ImageOCRStatus string

const (
	ImageInspectionUnavailable ImageInspectionStatus = "unavailable"
	ImageInspectionVerified    ImageInspectionStatus = "verified_metadata"
	ImageInspectionFailed      ImageInspectionStatus = "failed"

	ImageOCRComplete    ImageOCRStatus = "complete"
	ImageOCRFailed      ImageOCRStatus = "failed"
	ImageOCRUnavailable ImageOCRStatus = "unavailable"
)

// ImageMetadata is an optional, already-sandboxed receipt supplied by the
// image broker. Analyze never dereferences a URL or object reference. OCRText
// is bounded data whose digest, raster, frozen source, artifact, HTML, engine,
// and runtime identities are all required before it can be treated as OCR.
type ImageMetadata struct {
	NodeID             string                `json:"node_id,omitempty"`
	HTMLLocation       string                `json:"html_location,omitempty"`
	Status             ImageInspectionStatus `json:"status"`
	FailureCode        string                `json:"failure_code,omitempty"`
	FrozenSourceSHA256 string                `json:"frozen_source_sha256"`
	ArtifactSHA256     string                `json:"artifact_sha256"`
	HTMLSHA256         string                `json:"html_sha256"`
	SourceURLSHA256    string                `json:"source_url_sha256,omitempty"`
	AssetSHA256        string                `json:"asset_sha256,omitempty"`
	RasterSHA256       string                `json:"raster_sha256,omitempty"`
	RasterObjectRef    string                `json:"raster_object_ref,omitempty"`
	MediaType          string                `json:"media_type,omitempty"`
	EncodedBytes       int64                 `json:"encoded_bytes,omitempty"`
	PixelWidth         int                   `json:"pixel_width,omitempty"`
	PixelHeight        int                   `json:"pixel_height,omitempty"`
	FrameCount         int                   `json:"frame_count,omitempty"`
	SelectedFrame      int                   `json:"selected_frame,omitempty"`
	InspectorVersion   string                `json:"inspector_version,omitempty"`
	PolicyHash         string                `json:"policy_hash,omitempty"`
	OCRStatus          ImageOCRStatus        `json:"ocr_status"`
	OCRFailureCode     string                `json:"ocr_failure_code,omitempty"`
	OCRText            string                `json:"ocr_text,omitempty"`
	OCRTextSHA256      string                `json:"ocr_text_sha256,omitempty"`
	OCRLanguage        string                `json:"ocr_language,omitempty"`
	OCRConfidence      *float64              `json:"ocr_confidence,omitempty"`
	OCREngine          string                `json:"ocr_engine,omitempty"`
	OCREngineVersion   string                `json:"ocr_engine_version,omitempty"`
	OCRRuntimeVersion  string                `json:"ocr_runtime_version,omitempty"`
}

type Input struct {
	Revision      campaignartifact.Revision `json:"revision"`
	Compilation   campaigncompiler.Result   `json:"compilation"`
	PolicyVersion string                    `json:"policy_version,omitempty"`
	ImageMetadata []ImageMetadata           `json:"image_metadata,omitempty"`
	// CanonicalOffers is the F15 bridge, RESOLVED BY THE CALLER.
	//
	// Analyze is pure and deterministic; resolving a canonical offer is a
	// database read whose answer changes between two calls with the same input,
	// which is the entire point of the bridge. So the read happens in the caller
	// and arrives here already done, exactly as ImageMetadata does. Nil means
	// nobody resolved anything, which is reported as NOT ASSESSED rather than as
	// agreement — an unresolved bridge and a bridge that agrees are different
	// facts and must not share a silence.
	CanonicalOffers []CanonicalOfferBinding `json:"canonical_offers,omitempty"`
	// DeclaredSendSurface is the provider surface the SENDER SAYS this campaign
	// targets ("promotions" or "transactional"), used to check that any
	// structured markup is coherent with it.
	//
	// A declaration, never an observation. Gmail decides which tab a message
	// lands in and we learn that afterwards, from controlled-mailbox placement;
	// nothing here may be read as where the message went. Empty means the sender
	// declared nothing, which falls back to the cross-surface union rather than
	// guessing — guessing "promotional" would block a legitimate receipt, and
	// guessing the other way would approve markup that does nothing.
	DeclaredSendSurface string `json:"declared_send_surface,omitempty"`
}

// CanonicalOfferBinding is one in-email offer block resolved against the
// canonical entity.
//
// Declared here rather than imported from internal/offers on purpose: this
// package states facts about bytes and must not acquire a dependency on the
// package that owns offer storage. The caller maps its richer type into this
// one, the same shape the ImageMetadata boundary already uses.
type CanonicalOfferBinding struct {
	NodeID           string `json:"node_id"`
	CanonicalOfferID string `json:"canonical_offer_id"`
	// Missing means the message names an entity that does not exist for this
	// tenant. A first-class outcome: a message pointing at a deleted offer is a
	// real production state and must never read as "no problem found".
	Missing bool `json:"missing"`
	// Disagreements is where what the MESSAGE says differs from what the ENTITY
	// says. Empty when they agree.
	Disagreements []CanonicalOfferDisagreement `json:"disagreements,omitempty"`
}

// CanonicalOfferDisagreement is one concrete divergence between message and
// entity.
type CanonicalOfferDisagreement struct {
	Field     string `json:"field"`
	InMessage string `json:"in_message"`
	Canonical string `json:"canonical"`
	Detail    string `json:"detail"`
}

type BlockReference struct {
	BlockID  string `json:"block_id"`
	FactID   string `json:"fact_id,omitempty"`
	ActionID string `json:"action_id,omitempty"`
}

type EvidenceReference struct {
	Representation Representation `json:"representation"`
	Location       string         `json:"location,omitempty"`
	NodeID         string         `json:"node_id,omitempty"`
	SHA256         string         `json:"sha256,omitempty"`
	Detail         string         `json:"detail,omitempty"`
}

type RemediationKind string

const (
	RemediationRecompileMIME         RemediationKind = "recompile_mime"
	RemediationRegenerateProjection  RemediationKind = "regenerate_projection"
	RemediationAlignFact             RemediationKind = "align_fact_representations"
	RemediationRestoreLiveText       RemediationKind = "restore_live_text"
	RemediationFixPrimaryAction      RemediationKind = "fix_primary_action"
	RemediationAddInformativeAlt     RemediationKind = "add_informative_alt"
	RemediationMarkDecorativeImage   RemediationKind = "mark_decorative_image"
	RemediationMoveMeaningOutOfImage RemediationKind = "move_meaning_out_of_image"
	RemediationFixHeading            RemediationKind = "fix_heading_hierarchy"
	RemediationRemoveHiddenContent   RemediationKind = "remove_hidden_content"
	RemediationRemoveManipulation    RemediationKind = "remove_prompt_manipulation"
	RemediationRestorePreheader      RemediationKind = "restore_compiler_preheader"
	RemediationRemoveExecutableHTML  RemediationKind = "remove_executable_html"
	RemediationReviewImageBroker     RemediationKind = "review_image_broker"
	RemediationProvideFactContract   RemediationKind = "provide_fact_contract"
	// RemediationClarifyPrimaryMessage is the only remediation that cannot be
	// expressed as an exact edit: an unstable summary is a property of the whole
	// message, not of one node, so the instruction is to make the message say
	// one thing — never a Replacement, which this engine must not invent.
	RemediationClarifyPrimaryMessage RemediationKind = "clarify_primary_message"
	// RemediationRunSummaryStability is what a not-assessed result asks for:
	// run the measurement, not edit the campaign.
	RemediationRunSummaryStability RemediationKind = "run_summary_stability_assessment"
)

// Remediation is a closed, deterministic instruction. Replacement is present
// only when the expected value is already authoritative in the Fact Contract;
// this engine never invents marketing copy or alternate facts.
type Remediation struct {
	Kind           RemediationKind `json:"kind"`
	Representation Representation  `json:"representation,omitempty"`
	NodeID         string          `json:"node_id,omitempty"`
	Field          string          `json:"field,omitempty"`
	Replacement    string          `json:"replacement,omitempty"`
}

type PatchOperation string

const (
	PatchSetSemanticField   PatchOperation = "set_semantic_field"
	PatchRemoveSemanticNode PatchOperation = "remove_semantic_node"
)

// TypedPatchV1 is optional and is emitted only when an exact source mutation
// is unambiguous. Applying it must still create a new immutable revision.
type TypedPatchV1 struct {
	SchemaVersion int            `json:"schema_version"`
	Operation     PatchOperation `json:"operation"`
	NodeID        string         `json:"node_id"`
	Field         string         `json:"field,omitempty"`
	Value         string         `json:"value,omitempty"`
}

// Finding is persistence-neutral but intentionally shaped like
// campaignassurance.FindingInput. ExpectedValue and ObservedValue are canonical
// JSON values; references/remediation can be marshaled directly by an adapter.
type Finding struct {
	Fingerprint        string              `json:"fingerprint"`
	Code               string              `json:"code"`
	SourceClass        string              `json:"source_class"`
	Severity           Severity            `json:"severity"`
	Blocking           bool                `json:"blocking"`
	Overridable        bool                `json:"overridable"`
	Dimension          Dimension           `json:"dimension"`
	ScenarioID         string              `json:"scenario_id"`
	BlockReferences    []BlockReference    `json:"block_references"`
	EvidenceReferences []EvidenceReference `json:"evidence_references"`
	ExpectedValue      json.RawMessage     `json:"expected_value,omitempty"`
	ObservedValue      json.RawMessage     `json:"observed_value,omitempty"`
	Explanation        string              `json:"explanation"`
	Remediation        Remediation         `json:"remediation"`
	TypedPatch         *TypedPatchV1       `json:"typed_patch,omitempty"`
	DetectorVersion    string              `json:"detector_version"`
	PolicyVersion      string              `json:"policy_version"`
}

type Report struct {
	DetectorVersion string       `json:"detector_version"`
	PolicyVersion   string       `json:"policy_version"`
	ScenarioID      string       `json:"scenario_id"`
	Capabilities    []Capability `json:"capabilities"`
	Findings        []Finding    `json:"findings"`
}

// PersistenceFields contains the finding-owned portion of a durable finding
// insert. An orchestrator adds artifact/configuration/extraction identities and
// can copy these fields into campaignassurance.FindingInput without importing
// persistence into this deterministic package.
type PersistenceFields struct {
	Code                    string          `json:"code"`
	SourceClass             string          `json:"source_class"`
	Severity                string          `json:"severity"`
	Blocking                bool            `json:"blocking"`
	Overridable             bool            `json:"overridable"`
	Dimension               string          `json:"dimension"`
	BlockReferences         json.RawMessage `json:"block_references"`
	EvidenceReferences      json.RawMessage `json:"evidence_references"`
	ExpectedValue           json.RawMessage `json:"expected_value,omitempty"`
	ObservedValue           json.RawMessage `json:"observed_value,omitempty"`
	Explanation             string          `json:"explanation"`
	Remediation             json.RawMessage `json:"remediation"`
	TypedPatch              json.RawMessage `json:"typed_patch,omitempty"`
	TypedPatchSchemaVersion *int            `json:"typed_patch_schema_version,omitempty"`
	DetectorVersion         string          `json:"detector_version"`
	PolicyVersion           string          `json:"policy_version"`
}
