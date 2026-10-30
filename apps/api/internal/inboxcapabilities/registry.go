// SPDX-License-Identifier: AGPL-3.0-only

package inboxcapabilities

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"golang.org/x/text/language"
)

const (
	SchemaVersion     = "postwave.inbox-capability-registry.v1"
	MaxRegistryBytes  = 1 << 20
	MaxProfiles       = 512
	MaxSources        = 512
	MaxCapabilities   = 64
	MaxSettings       = 64
	MaxStringBytes    = 8 << 10
	MaxCandidateCount = 32
)

type CapabilityID string

const (
	CapabilityMessageHeaders           CapabilityID = "message_headers_acquisition"
	CapabilityRawMIME                  CapabilityID = "raw_mime_acquisition"
	CapabilityMIMEBodyParts            CapabilityID = "mime_body_parts_acquisition"
	CapabilityPlacement                CapabilityID = "folder_or_category_placement"
	CapabilityDocumentedSummarySurface CapabilityID = "documented_summary_surface"
	CapabilityControlledSummaryCapture CapabilityID = "controlled_summary_observation"
	CapabilitySummaryViaStandardIMAP   CapabilityID = "summary_via_standard_imap"
	CapabilitySummaryViaGmailAPI       CapabilityID = "summary_via_gmail_api"
	CapabilityStructuredMarkupSummary  CapabilityID = "structured_markup_summary_effect"
)

var requiredCapabilities = []CapabilityID{
	CapabilityMessageHeaders,
	CapabilityRawMIME,
	CapabilityMIMEBodyParts,
	CapabilityPlacement,
	CapabilityDocumentedSummarySurface,
	CapabilityControlledSummaryCapture,
	CapabilitySummaryViaStandardIMAP,
	CapabilitySummaryViaGmailAPI,
	CapabilityStructuredMarkupSummary,
}

type State string

const (
	StateAvailable   State = "available"
	StateUnavailable State = "unavailable"
	StateUnknown     State = "unknown"
)

type EvidenceClass string

const (
	EvidencePublishedDocumentation EvidenceClass = "published_documentation"
	EvidenceControlledObservation  EvidenceClass = "controlled_observation"
	EvidenceModeledPrediction      EvidenceClass = "modeled_prediction"
	EvidenceProtocolBoundary       EvidenceClass = "protocol_boundary"
	EvidenceResearchGap            EvidenceClass = "research_gap"
)

type SourceKind string

const (
	SourceFirstPartyDocumentation SourceKind = "first_party_documentation"
	SourceStandard                SourceKind = "standard"
	SourceInternalDecision        SourceKind = "internal_decision"
	SourceVendorClaim             SourceKind = "vendor_claim"
)

type SettingState string

const (
	SettingEnabled  SettingState = "enabled"
	SettingDisabled SettingState = "disabled"
	SettingUnknown  SettingState = "unknown"
)

type SelectionStatus string

const (
	SelectionNotSelected SelectionStatus = "not_selected"
	SelectionSelected    SelectionStatus = "selected"
)

type VendorEvaluationStatus string

const (
	VendorUnevaluated VendorEvaluationStatus = "unevaluated"
	VendorQualified   VendorEvaluationStatus = "qualified"
	VendorRejected    VendorEvaluationStatus = "rejected"
)

type Source struct {
	ID          string     `json:"id"`
	Kind        SourceKind `json:"kind"`
	Publisher   string     `json:"publisher"`
	Title       string     `json:"title"`
	Locator     string     `json:"locator"`
	PublishedAt string     `json:"published_at,omitempty"`
	RetrievedAt string     `json:"retrieved_at"`
}

type Setting struct {
	Name  string       `json:"name"`
	State SettingState `json:"state"`
}

// ProfileKey names one provider/client/environment/surface snapshot. Provider
// and ClientApp are intentionally separate: a Gmail mailbox read in Apple Mail
// is not evidence about the Gmail client.
type ProfileKey struct {
	MailboxProvider string    `json:"mailbox_provider"`
	ClientApp       string    `json:"client_app"`
	OSFamily        string    `json:"os_family"`
	DeviceClass     string    `json:"device_class"`
	AccountTier     string    `json:"account_tier"`
	Locale          string    `json:"locale"`
	Settings        []Setting `json:"smart_feature_settings"`
	Surface         string    `json:"surface"`
}

type ModelReceipt struct {
	ModelSnapshot string `json:"model_snapshot"`
	PromptVersion string `json:"prompt_version"`
	ConfigSHA256  string `json:"config_sha256"`
}

type Statement struct {
	Capability           CapabilityID  `json:"capability"`
	State                State         `json:"state"`
	EvidenceClass        EvidenceClass `json:"evidence_class"`
	SourceIDs            []string      `json:"source_ids,omitempty"`
	AssessedAt           string        `json:"assessed_at"`
	Note                 string        `json:"note"`
	Constraints          []string      `json:"constraints,omitempty"`
	ObservedAt           string        `json:"observed_at,omitempty"`
	CaptureMethod        string        `json:"capture_method,omitempty"`
	EvidenceObjectSHA256 string        `json:"evidence_object_sha256,omitempty"`
	ModelReceipt         *ModelReceipt `json:"model_receipt,omitempty"`
}

type Profile struct {
	ID           string      `json:"id"`
	Revision     int         `json:"revision"`
	Key          ProfileKey  `json:"key"`
	Capabilities []Statement `json:"capabilities"`
}

type VendorCandidate struct {
	ID                       string                 `json:"id"`
	Name                     string                 `json:"name"`
	SourceIDs                []string               `json:"source_ids"`
	Status                   VendorEvaluationStatus `json:"status"`
	Note                     string                 `json:"note"`
	EvaluatedAt              string                 `json:"evaluated_at,omitempty"`
	EvaluationEvidenceSHA256 string                 `json:"evaluation_evidence_sha256,omitempty"`
}

// LaunchDecision keeps an unmade vendor decision explicit. A vendor claim can
// make a product a candidate, but cannot make it selected or certified.
type LaunchDecision struct {
	Status             SelectionStatus `json:"status"`
	Strategy           string          `json:"strategy"`
	SelectedVendorID   string          `json:"selected_vendor_id,omitempty"`
	CandidateVendorIDs []string        `json:"candidate_vendor_ids"`
	ReviewedAt         string          `json:"reviewed_at"`
	DecisionEvidence   []string        `json:"decision_evidence_source_ids"`
}

type Registry struct {
	SchemaVersion   string            `json:"schema_version"`
	RegistryVersion string            `json:"registry_version"`
	PublishedAt     string            `json:"published_at"`
	Sources         []Source          `json:"sources"`
	Vendors         []VendorCandidate `json:"vendor_candidates"`
	LaunchDecision  LaunchDecision    `json:"launch_observation_decision"`
	Profiles        []Profile         `json:"profiles"`
}

type Loaded struct {
	Registry Registry
	SHA256   string
}

// ProfileReceipt is the compact identity stored beside an observation. The
// full profile remains resolvable from the immutable registry version, while
// both registry and exact profile bytes are independently tamper-evident.
type ProfileReceipt struct {
	RegistryVersion string `json:"registry_version"`
	RegistrySHA256  string `json:"registry_sha256"`
	ProfileID       string `json:"profile_id"`
	ProfileRevision int    `json:"profile_revision"`
	ProfileSHA256   string `json:"profile_sha256"`
}

var (
	ErrRegistryTooLarge = errors.New("capability registry exceeds bounded size")
	identifierPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,127}$`)
	versionPattern      = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}\.\d+$`)
	hexSHA256Pattern    = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

//go:embed registry.v1.json
var embeddedRegistry embed.FS

func LoadEmbedded() (Loaded, error) {
	raw, err := embeddedRegistry.ReadFile("registry.v1.json")
	if err != nil {
		return Loaded{}, fmt.Errorf("read embedded capability registry: %w", err)
	}
	return Decode(bytes.NewReader(raw))
}

// Decode performs bounded, strict JSON decoding and complete schema-level
// validation. Unknown JSON fields and trailing values fail closed.
func Decode(reader io.Reader) (Loaded, error) {
	if reader == nil {
		return Loaded{}, errors.New("capability registry reader is required")
	}
	raw, err := io.ReadAll(io.LimitReader(reader, MaxRegistryBytes+1))
	if err != nil {
		return Loaded{}, fmt.Errorf("read capability registry: %w", err)
	}
	if len(raw) > MaxRegistryBytes {
		return Loaded{}, ErrRegistryTooLarge
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var registry Registry
	if err := decoder.Decode(&registry); err != nil {
		return Loaded{}, fmt.Errorf("decode capability registry: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return Loaded{}, errors.New("decode capability registry: trailing JSON value")
		}
		return Loaded{}, fmt.Errorf("decode capability registry trailing value: %w", err)
	}
	if err := registry.Validate(); err != nil {
		return Loaded{}, err
	}
	canonical, err := json.Marshal(registry)
	if err != nil {
		return Loaded{}, fmt.Errorf("canonicalize capability registry: %w", err)
	}
	digest := sha256.Sum256(canonical)
	return Loaded{Registry: registry, SHA256: hex.EncodeToString(digest[:])}, nil
}

func (registry Registry) Validate() error {
	if registry.SchemaVersion != SchemaVersion {
		return fmt.Errorf("schema_version must be %q", SchemaVersion)
	}
	if !versionPattern.MatchString(registry.RegistryVersion) {
		return errors.New("registry_version must be YYYY-MM-DD.N")
	}
	registryPublishedAt, err := parseTimestamp("published_at", registry.PublishedAt)
	if err != nil {
		return err
	}
	if len(registry.Sources) == 0 || len(registry.Sources) > MaxSources {
		return fmt.Errorf("sources count must be between 1 and %d", MaxSources)
	}
	if len(registry.Profiles) == 0 || len(registry.Profiles) > MaxProfiles {
		return fmt.Errorf("profiles count must be between 1 and %d", MaxProfiles)
	}

	sources := make(map[string]Source, len(registry.Sources))
	for index, source := range registry.Sources {
		if err := validateSource(source); err != nil {
			return fmt.Errorf("sources[%d]: %w", index, err)
		}
		if _, exists := sources[source.ID]; exists {
			return fmt.Errorf("duplicate source id %q", source.ID)
		}
		retrievedAt, _ := time.Parse(time.RFC3339, source.RetrievedAt)
		if retrievedAt.After(registryPublishedAt) {
			return fmt.Errorf("sources[%d]: retrieved_at is after registry published_at", index)
		}
		sources[source.ID] = source
	}

	vendors := make(map[string]VendorCandidate, len(registry.Vendors))
	for index, vendor := range registry.Vendors {
		if err := validateVendor(vendor, sources); err != nil {
			return fmt.Errorf("vendor_candidates[%d]: %w", index, err)
		}
		if _, exists := vendors[vendor.ID]; exists {
			return fmt.Errorf("duplicate vendor id %q", vendor.ID)
		}
		vendors[vendor.ID] = vendor
	}
	if err := validateLaunchDecision(registry.LaunchDecision, vendors, sources); err != nil {
		return fmt.Errorf("launch_observation_decision: %w", err)
	}
	decisionReviewedAt, _ := time.Parse(time.RFC3339, registry.LaunchDecision.ReviewedAt)
	if decisionReviewedAt.After(registryPublishedAt) {
		return errors.New("launch_observation_decision: reviewed_at is after registry published_at")
	}

	profileIDs := make(map[string]struct{}, len(registry.Profiles))
	keys := make(map[string]string, len(registry.Profiles))
	for index, profile := range registry.Profiles {
		if err := validateProfile(profile, sources); err != nil {
			return fmt.Errorf("profiles[%d]: %w", index, err)
		}
		if _, exists := profileIDs[profile.ID]; exists {
			return fmt.Errorf("duplicate profile id %q", profile.ID)
		}
		profileIDs[profile.ID] = struct{}{}
		canonical := profile.Key.Canonical()
		if prior, exists := keys[canonical]; exists {
			return fmt.Errorf("profiles %q and %q have duplicate exact capability keys", prior, profile.ID)
		}
		keys[canonical] = profile.ID
		for _, statement := range profile.Capabilities {
			assessedAt, _ := time.Parse(time.RFC3339, statement.AssessedAt)
			if assessedAt.After(registryPublishedAt) {
				return fmt.Errorf("profiles[%d]: capability %q assessed_at is after registry published_at", index, statement.Capability)
			}
		}
	}
	return nil
}

func (key ProfileKey) Canonical() string {
	settings := make([]string, 0, len(key.Settings))
	for _, setting := range key.Settings {
		settings = append(settings, setting.Name+"="+string(setting.State))
	}
	return strings.Join([]string{
		key.MailboxProvider,
		key.ClientApp,
		key.OSFamily,
		key.DeviceClass,
		key.AccountTier,
		key.Locale,
		strings.Join(settings, ","),
		key.Surface,
	}, "|")
}

func (registry Registry) ProfileByID(id string) (Profile, bool) {
	for _, profile := range registry.Profiles {
		if profile.ID == id {
			return cloneProfile(profile), true
		}
	}
	return Profile{}, false
}

func (loaded Loaded) ReceiptForProfile(id string) (ProfileReceipt, error) {
	if !hexSHA256Pattern.MatchString(loaded.SHA256) {
		return ProfileReceipt{}, errors.New("loaded registry SHA-256 is invalid")
	}
	if err := loaded.Registry.Validate(); err != nil {
		return ProfileReceipt{}, fmt.Errorf("loaded registry is invalid: %w", err)
	}
	canonicalRegistry, err := json.Marshal(loaded.Registry)
	if err != nil {
		return ProfileReceipt{}, fmt.Errorf("marshal capability registry receipt: %w", err)
	}
	registryDigest := sha256.Sum256(canonicalRegistry)
	if hex.EncodeToString(registryDigest[:]) != loaded.SHA256 {
		return ProfileReceipt{}, errors.New("loaded registry content does not match its SHA-256")
	}
	profile, ok := loaded.Registry.ProfileByID(id)
	if !ok {
		return ProfileReceipt{}, fmt.Errorf("unknown capability profile %q", id)
	}
	raw, err := json.Marshal(profile)
	if err != nil {
		return ProfileReceipt{}, fmt.Errorf("marshal capability profile receipt: %w", err)
	}
	digest := sha256.Sum256(raw)
	return ProfileReceipt{
		RegistryVersion: loaded.Registry.RegistryVersion,
		RegistrySHA256:  loaded.SHA256,
		ProfileID:       profile.ID,
		ProfileRevision: profile.Revision,
		ProfileSHA256:   hex.EncodeToString(digest[:]),
	}, nil
}

func (registry Registry) FindExact(key ProfileKey) (Profile, bool) {
	wanted := key.Canonical()
	for _, profile := range registry.Profiles {
		if profile.Key.Canonical() == wanted {
			return cloneProfile(profile), true
		}
	}
	return Profile{}, false
}

func (profile Profile) Capability(id CapabilityID) (Statement, bool) {
	for _, statement := range profile.Capabilities {
		if statement.Capability == id {
			return cloneStatement(statement), true
		}
	}
	return Statement{}, false
}

func validateSource(source Source) error {
	if !identifierPattern.MatchString(source.ID) {
		return errors.New("invalid source id")
	}
	if !oneOfSourceKind(source.Kind) {
		return errors.New("invalid source kind")
	}
	if err := validateText("publisher", source.Publisher, true); err != nil {
		return err
	}
	if err := validateText("title", source.Title, true); err != nil {
		return err
	}
	if err := validateLocator(source); err != nil {
		return err
	}
	retrieved, err := parseTimestamp("retrieved_at", source.RetrievedAt)
	if err != nil {
		return err
	}
	if source.PublishedAt != "" {
		published, err := parseTimestamp("published_at", source.PublishedAt)
		if err != nil {
			return err
		}
		if retrieved.Before(published) {
			return errors.New("retrieved_at precedes published_at")
		}
	}
	return nil
}

func validateLocator(source Source) error {
	if err := validateText("locator", source.Locator, true); err != nil {
		return err
	}
	if source.Kind == SourceInternalDecision {
		if strings.HasPrefix(source.Locator, "docs/") || strings.HasPrefix(source.Locator, "repo:") {
			return nil
		}
		return errors.New("internal source locator must be a docs/ path or repo: reference")
	}
	parsed, err := url.Parse(source.Locator)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil {
		return errors.New("external source locator must be an absolute HTTPS URL without userinfo")
	}
	return nil
}

func validateVendor(vendor VendorCandidate, sources map[string]Source) error {
	if !identifierPattern.MatchString(vendor.ID) {
		return errors.New("invalid vendor id")
	}
	if err := validateText("name", vendor.Name, true); err != nil {
		return err
	}
	if vendor.Status != VendorUnevaluated && vendor.Status != VendorQualified && vendor.Status != VendorRejected {
		return errors.New("invalid vendor evaluation status")
	}
	if err := validateText("note", vendor.Note, true); err != nil {
		return err
	}
	if len(vendor.SourceIDs) == 0 {
		return errors.New("vendor candidate requires source_ids")
	}
	if err := validateSourceIDs(vendor.SourceIDs, sources); err != nil {
		return err
	}
	if vendor.Status == VendorUnevaluated {
		if vendor.EvaluatedAt != "" || vendor.EvaluationEvidenceSHA256 != "" {
			return errors.New("unevaluated vendor cannot carry controlled evaluation evidence")
		}
		return nil
	}
	if _, err := parseTimestamp("evaluated_at", vendor.EvaluatedAt); err != nil {
		return err
	}
	evaluatedAt, _ := time.Parse(time.RFC3339, vendor.EvaluatedAt)
	for _, sourceID := range vendor.SourceIDs {
		retrievedAt, _ := time.Parse(time.RFC3339, sources[sourceID].RetrievedAt)
		if evaluatedAt.Before(retrievedAt) {
			return fmt.Errorf("evaluated_at precedes retrieval of source %q", sourceID)
		}
	}
	if !hexSHA256Pattern.MatchString(vendor.EvaluationEvidenceSHA256) {
		return errors.New("qualified/rejected vendor requires evaluation evidence SHA-256")
	}
	return nil
}

func validateLaunchDecision(decision LaunchDecision, vendors map[string]VendorCandidate, sources map[string]Source) error {
	if decision.Status != SelectionNotSelected && decision.Status != SelectionSelected {
		return errors.New("invalid selection status")
	}
	if err := validateText("strategy", decision.Strategy, true); err != nil {
		return err
	}
	reviewedAt, err := parseTimestamp("reviewed_at", decision.ReviewedAt)
	if err != nil {
		return err
	}
	if len(decision.CandidateVendorIDs) > MaxCandidateCount {
		return errors.New("too many candidate vendors")
	}
	seen := make(map[string]struct{}, len(decision.CandidateVendorIDs))
	for _, id := range decision.CandidateVendorIDs {
		if _, ok := vendors[id]; !ok {
			return fmt.Errorf("unknown candidate vendor %q", id)
		}
		if _, duplicate := seen[id]; duplicate {
			return fmt.Errorf("duplicate candidate vendor %q", id)
		}
		seen[id] = struct{}{}
	}
	if decision.Status == SelectionSelected {
		vendor, ok := vendors[decision.SelectedVendorID]
		if !ok {
			return errors.New("selected status requires a known selected_vendor_id")
		}
		if vendor.Status != VendorQualified {
			return errors.New("selected vendor must have qualified controlled-evaluation status")
		}
	} else if decision.SelectedVendorID != "" {
		return errors.New("not_selected status cannot name a selected_vendor_id")
	}
	if err := validateSourceIDs(decision.DecisionEvidence, sources); err != nil {
		return err
	}
	for _, sourceID := range decision.DecisionEvidence {
		retrievedAt, _ := time.Parse(time.RFC3339, sources[sourceID].RetrievedAt)
		if reviewedAt.Before(retrievedAt) {
			return fmt.Errorf("reviewed_at precedes retrieval of source %q", sourceID)
		}
	}
	return nil
}

func validateProfile(profile Profile, sources map[string]Source) error {
	if !identifierPattern.MatchString(profile.ID) {
		return errors.New("invalid profile id")
	}
	if profile.Revision < 1 {
		return errors.New("revision must be positive")
	}
	if err := validateProfileKey(profile.Key); err != nil {
		return fmt.Errorf("key: %w", err)
	}
	if len(profile.Capabilities) != len(requiredCapabilities) || len(profile.Capabilities) > MaxCapabilities {
		return fmt.Errorf("capabilities must contain exactly the %d required capability ids", len(requiredCapabilities))
	}
	wanted := make(map[CapabilityID]struct{}, len(requiredCapabilities))
	for _, id := range requiredCapabilities {
		wanted[id] = struct{}{}
	}
	seen := make(map[CapabilityID]struct{}, len(profile.Capabilities))
	for index, statement := range profile.Capabilities {
		if statement.Capability != requiredCapabilities[index] {
			return fmt.Errorf("capabilities[%d] must be %q", index, requiredCapabilities[index])
		}
		if _, ok := wanted[statement.Capability]; !ok {
			return fmt.Errorf("capabilities[%d]: unsupported capability %q", index, statement.Capability)
		}
		if _, duplicate := seen[statement.Capability]; duplicate {
			return fmt.Errorf("capabilities[%d]: duplicate capability %q", index, statement.Capability)
		}
		seen[statement.Capability] = struct{}{}
		if err := validateStatement(statement, sources); err != nil {
			return fmt.Errorf("capabilities[%d] %q: %w", index, statement.Capability, err)
		}
	}
	return nil
}

func validateProfileKey(key ProfileKey) error {
	for name, value := range map[string]string{
		"mailbox_provider": key.MailboxProvider,
		"client_app":       key.ClientApp,
		"os_family":        key.OSFamily,
		"device_class":     key.DeviceClass,
		"account_tier":     key.AccountTier,
		"surface":          key.Surface,
	} {
		if !identifierPattern.MatchString(value) {
			return fmt.Errorf("%s is invalid", name)
		}
	}
	parsed, err := language.Parse(key.Locale)
	if err != nil || parsed.String() != key.Locale {
		return errors.New("locale must be a canonical BCP 47 tag")
	}
	if len(key.Settings) > MaxSettings {
		return errors.New("too many smart feature settings")
	}
	prior := ""
	for _, setting := range key.Settings {
		if !identifierPattern.MatchString(setting.Name) {
			return errors.New("invalid smart feature setting name")
		}
		if setting.State != SettingEnabled && setting.State != SettingDisabled && setting.State != SettingUnknown {
			return fmt.Errorf("invalid state for smart feature setting %q", setting.Name)
		}
		if setting.Name <= prior {
			return errors.New("smart feature settings must be unique and sorted by name")
		}
		prior = setting.Name
	}
	return nil
}

func validateStatement(statement Statement, sources map[string]Source) error {
	if statement.State != StateAvailable && statement.State != StateUnavailable && statement.State != StateUnknown {
		return errors.New("invalid capability state")
	}
	if !oneOfEvidenceClass(statement.EvidenceClass) {
		return errors.New("invalid evidence class")
	}
	assessed, err := parseTimestamp("assessed_at", statement.AssessedAt)
	if err != nil {
		return err
	}
	if err := validateText("note", statement.Note, true); err != nil {
		return err
	}
	if len(statement.Constraints) > MaxSettings {
		return errors.New("too many constraints")
	}
	for _, constraint := range statement.Constraints {
		if err := validateText("constraint", constraint, true); err != nil {
			return err
		}
	}
	if err := validateSourceIDs(statement.SourceIDs, sources); err != nil {
		return err
	}
	for _, sourceID := range statement.SourceIDs {
		retrieved, err := time.Parse(time.RFC3339, sources[sourceID].RetrievedAt)
		if err != nil {
			return fmt.Errorf("source %q has invalid retrieved_at", sourceID)
		}
		if assessed.Before(retrieved) {
			return fmt.Errorf("assessed_at precedes retrieval of source %q", sourceID)
		}
	}
	if statement.Capability == CapabilityControlledSummaryCapture && statement.State == StateAvailable && statement.EvidenceClass != EvidenceControlledObservation {
		return errors.New("available controlled summary capture requires controlled-observation evidence")
	}

	switch statement.EvidenceClass {
	case EvidencePublishedDocumentation, EvidenceProtocolBoundary:
		if len(statement.SourceIDs) == 0 {
			return errors.New("documented/protocol evidence requires source_ids")
		}
		if statement.ObservedAt != "" || statement.CaptureMethod != "" || statement.EvidenceObjectSHA256 != "" || statement.ModelReceipt != nil {
			return errors.New("documented/protocol evidence cannot carry observation or model fields")
		}
		if statement.EvidenceClass == EvidencePublishedDocumentation {
			authoritative := false
			for _, sourceID := range statement.SourceIDs {
				kind := sources[sourceID].Kind
				if kind == SourceFirstPartyDocumentation || kind == SourceStandard {
					authoritative = true
				}
			}
			if !authoritative {
				return errors.New("published_documentation evidence requires a first-party or standards source")
			}
		}
	case EvidenceResearchGap:
		if statement.State != StateUnknown {
			return errors.New("research_gap evidence must use unknown state")
		}
		if statement.ObservedAt != "" || statement.CaptureMethod != "" || statement.EvidenceObjectSHA256 != "" || statement.ModelReceipt != nil {
			return errors.New("research_gap evidence cannot carry observation or model fields")
		}
	case EvidenceControlledObservation:
		observed, err := parseTimestamp("observed_at", statement.ObservedAt)
		if err != nil {
			return err
		}
		if observed.After(assessed) {
			return errors.New("observed_at cannot be after assessed_at")
		}
		if !identifierPattern.MatchString(statement.CaptureMethod) {
			return errors.New("controlled observation requires a versioned capture_method")
		}
		if !hexSHA256Pattern.MatchString(statement.EvidenceObjectSHA256) {
			return errors.New("controlled observation requires an evidence object SHA-256")
		}
		if statement.ModelReceipt != nil {
			return errors.New("controlled observation cannot carry a model receipt")
		}
	case EvidenceModeledPrediction:
		if statement.State != StateUnknown {
			return errors.New("modeled prediction cannot establish available or unavailable capability state")
		}
		if statement.ModelReceipt == nil || !identifierPattern.MatchString(statement.ModelReceipt.ModelSnapshot) ||
			!identifierPattern.MatchString(statement.ModelReceipt.PromptVersion) ||
			!hexSHA256Pattern.MatchString(statement.ModelReceipt.ConfigSHA256) {
			return errors.New("modeled prediction requires a complete versioned model receipt")
		}
		if statement.ObservedAt != "" || statement.CaptureMethod != "" || statement.EvidenceObjectSHA256 != "" {
			return errors.New("modeled prediction cannot carry controlled-observation fields")
		}
	}
	return nil
}

func validateSourceIDs(ids []string, sources map[string]Source) error {
	if len(ids) > MaxSources {
		return errors.New("too many source ids")
	}
	seen := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if _, ok := sources[id]; !ok {
			return fmt.Errorf("unknown source id %q", id)
		}
		if _, duplicate := seen[id]; duplicate {
			return fmt.Errorf("duplicate source id %q", id)
		}
		seen[id] = struct{}{}
	}
	return nil
}

func parseTimestamp(name, value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("%s must be RFC3339", name)
	}
	if parsed.Format(time.RFC3339) != value {
		return time.Time{}, fmt.Errorf("%s must be canonical UTC/offset RFC3339", name)
	}
	return parsed, nil
}

func validateText(name, value string, required bool) error {
	trimmed := strings.TrimSpace(value)
	if required && trimmed == "" {
		return fmt.Errorf("%s is required", name)
	}
	if value != trimmed {
		return fmt.Errorf("%s must not have surrounding whitespace", name)
	}
	if len(value) > MaxStringBytes {
		return fmt.Errorf("%s exceeds byte limit", name)
	}
	if strings.ContainsAny(value, "\x00\r\n") {
		return fmt.Errorf("%s contains a forbidden control character", name)
	}
	return nil
}

func oneOfSourceKind(kind SourceKind) bool {
	return kind == SourceFirstPartyDocumentation || kind == SourceStandard ||
		kind == SourceInternalDecision || kind == SourceVendorClaim
}

func oneOfEvidenceClass(class EvidenceClass) bool {
	return class == EvidencePublishedDocumentation || class == EvidenceControlledObservation ||
		class == EvidenceModeledPrediction || class == EvidenceProtocolBoundary || class == EvidenceResearchGap
}

func cloneProfile(profile Profile) Profile {
	profile.Key.Settings = append([]Setting(nil), profile.Key.Settings...)
	profile.Capabilities = append([]Statement(nil), profile.Capabilities...)
	for index := range profile.Capabilities {
		profile.Capabilities[index] = cloneStatement(profile.Capabilities[index])
	}
	return profile
}

func cloneStatement(statement Statement) Statement {
	statement.SourceIDs = append([]string(nil), statement.SourceIDs...)
	statement.Constraints = append([]string(nil), statement.Constraints...)
	if statement.ModelReceipt != nil {
		copyReceipt := *statement.ModelReceipt
		statement.ModelReceipt = &copyReceipt
	}
	return statement
}

// RequiredCapabilityIDs returns the immutable completeness contract in stable
// order. Profiles must state unknown rather than omitting one of these fields.
func RequiredCapabilityIDs() []CapabilityID {
	return append([]CapabilityID(nil), requiredCapabilities...)
}

// SortedProfileIDs is useful for versioned receipts without exposing mutable
// registry internals.
func (registry Registry) SortedProfileIDs() []string {
	ids := make([]string, 0, len(registry.Profiles))
	for _, profile := range registry.Profiles {
		ids = append(ids, profile.ID)
	}
	sort.Strings(ids)
	return ids
}
