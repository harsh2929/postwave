// SPDX-License-Identifier: AGPL-3.0-only

// Package engagementclassification implements Track B F01's versioned,
// explainable human/machine/unknown classifier over canonical subscriber
// engagement events. It deliberately keeps raw observations separate from
// derived decisions so a new methodology never rewrites source evidence.
package engagementclassification

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	ObservationSchemaV1      = "postwave.subscriber-event-observation.v1"
	ClassifierV2             = "postwave.engagement-classifier.v2"
	MethodologyV2            = "postwave.engagement-methodology.v2"
	RegistrySnapshotSchemaV1 = "postwave.machine-source-registry-snapshot.v1"
	HistoricalRegistryV1     = "postwave.machine-source-registry.v1"
	// DefaultRegistryV1 is retained as a deprecated source-compatible alias for
	// ledger inspection only. V1 is provenance-ambiguous and cannot be loaded
	// for replay, new classification, calibration, or release authorization.
	DefaultRegistryV1 = HistoricalRegistryV1
	CurrentRegistryV2 = "postwave.machine-source-registry.v2"

	ReasonNoConfidentSignal   = "R_NO_CONFIDENT_SIGNAL"
	ReasonConflictingEvidence = "R_CONFLICTING_EVIDENCE"
	ReasonNotYetClassified    = "R_NOT_YET_CLASSIFIED"
)

var (
	ErrInvalidInput           = errors.New("engagementclassification: invalid input")
	ErrCampaignNotFound       = errors.New("engagementclassification: campaign not found")
	ErrIdempotencyConflict    = errors.New("engagementclassification: idempotency conflict")
	ErrNoObservation          = errors.New("engagementclassification: no observation")
	ErrRunInProgress          = errors.New("engagementclassification: reclassification run in progress")
	ErrLeaseLost              = errors.New("engagementclassification: reclassification lease lost")
	ErrRunTerminal            = errors.New("engagementclassification: reclassification run is terminal")
	ErrObjectDeletionRequired = errors.New("engagementclassification: exact external-object deletion is required")

	versionPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,95}$`)
	rulePattern    = regexp.MustCompile(`^R_[A-Z0-9_]{2,94}$`)
	hashPattern    = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// Classification is deliberately closed. Unknown is evidence, not a fallback
// alias for human.
type Classification string

const (
	Human   Classification = "human"
	Machine Classification = "machine"
	Unknown Classification = "unknown"
)

func (c Classification) Valid() bool {
	return c == Human || c == Machine || c == Unknown
}

// MachineSubtype is the explainable machine family selected from the
// strongest machine evidence. All matching evidence remains in Rules even
// when more than one subtype fires.
type MachineSubtype string

const (
	SubtypeAppleMPP         MachineSubtype = "apple_mpp"
	SubtypeGmailProxy       MachineSubtype = "gmail_proxy"
	SubtypeOutlookSafeLinks MachineSubtype = "outlook_safelinks"
	SubtypeSEGScanner       MachineSubtype = "seg_scanner"
	SubtypePrefetcher       MachineSubtype = "prefetcher"
	SubtypeSeedAutomation   MachineSubtype = "seed_automation"
	SubtypeLinkChecker      MachineSubtype = "link_checker"
	SubtypeAISummarizer     MachineSubtype = "ai_summarizer"
	SubtypeUnknownBot       MachineSubtype = "unknown_bot"
)

func (s MachineSubtype) Valid() bool {
	switch s {
	case SubtypeAppleMPP, SubtypeGmailProxy, SubtypeOutlookSafeLinks,
		SubtypeSEGScanner, SubtypePrefetcher, SubtypeSeedAutomation,
		SubtypeLinkChecker, SubtypeAISummarizer, SubtypeUnknownBot:
		return true
	default:
		return false
	}
}

type EvidenceDirection string

const (
	DirectionHuman   EvidenceDirection = "human"
	DirectionMachine EvidenceDirection = "machine"
	DirectionNeutral EvidenceDirection = "neutral"
)

// Header preserves wire order. Values are optional because some edge
// adapters may retain ordered names while redacting values before ingestion.
type Header struct {
	Name  string `json:"name"`
	Value string `json:"value,omitempty"`
}

// EventRef identifies one row in the partitioned canonical subscriber_events
// ledger. At is part of that table's primary key and must never be guessed.
type EventRef struct {
	ID int64
	At time.Time
}

// ObservationInput is the bounded raw/provenance envelope. Recipient identity
// is tenant-scoped HMAC only; raw email is intentionally absent.
type ObservationInput struct {
	EventRef
	Source                 string
	SourceEventID          string
	IdempotencyKey         string
	EventSchemaVersion     string
	EventType              string
	OccurredAt             time.Time
	IngestedAt             time.Time
	DeliveredAt            *time.Time
	CampaignID             string
	RecipientIdentityHMAC  string
	RecipientKeyID         string
	MessageIdentityHash    string
	LinkIdentityHash       string
	IsSeed                 bool
	SeedTestID             string
	ProviderMessageID      string
	ProviderRequestID      string
	OrderedHeaders         []Header
	OrderedHeadersComplete bool
	UserAgent              string
	IP                     string
	NetworkASN             *uint32
	// NetworkASNSource records HOW NetworkASN was learned, so a reader can tell
	// a measured value from an absent one. It is NOT optional decoration: the
	// machine-source registry matches on ASN, and a NULL ASN whose cause is
	// unknown is indistinguishable from a deployment where the signal is
	// switched off entirely. See network_asn.go. Leave empty only with a nil
	// ASN; it normalises to NetworkASNUnmeasured.
	NetworkASNSource   NetworkASNSource
	NetworkRegion      string
	ReverseDNS         string
	TLSJA4             string
	ProviderSignals    map[string]any
	DwellMilliseconds  *int64
	MessageLinkCount   *int
	BodyHash           string
	RawObjectRef       string
	RawObjectVersionID string
	PrivacyExpiryAt    time.Time
}

// Observation is the persisted identity and exact source fingerprint.
type Observation struct {
	ObservationInput
	ID          string
	TenantID    string
	Fingerprint string
}

// MessageAggregate carries behavior that cannot be inferred from one event.
// Producers compute it over a single immutable message identity. Zero values
// mean "not observed", never a negative fact.
type MessageAggregate struct {
	Complete             bool
	DeliveredAt          *time.Time
	DistinctLinksFetched int
	TotalLinks           int
	EventCount           int
	BurstWindow          time.Duration
	HasPrecedingOpen     bool
	OpenUserAgents       []string
	ClickUserAgents      []string

	// OpenCount and MinOpenGap describe repeat opens of one message.
	// MinOpenGap is the SMALLEST interval between consecutive opens; a human
	// cannot open the same message twice inside a second, so a tiny gap is a
	// fetcher retrying or a proxy fanning out. Zero MinOpenGap with OpenCount
	// below two means "no pair to measure", never "zero milliseconds apart".
	OpenCount  int
	MinOpenGap time.Duration

	// FirstOpenAt is the earliest open for this message, so a click can be
	// compared against it. A click timestamped BEFORE any open is physically
	// impossible for a human and is the signature of a scanner that fetches
	// links before images.
	FirstOpenAt *time.Time

	// DistinctOpenRegions and RegionSpan describe where the opens came from.
	// Two regions minutes apart are not one traveller. Kept as a COUNT and a
	// SPAN rather than coordinates: the classifier records rule identity, not
	// raw location, and a region name in evidence would be recipient data.
	DistinctOpenRegions int
	RegionSpan          time.Duration
}

// EvidenceRule is safe durable provenance: it records rule identity and
// calibrated contribution, not raw IP/header values.
type EvidenceRule struct {
	ID               string            `json:"id"`
	Direction        EvidenceDirection `json:"direction"`
	Weight           float64           `json:"weight"`
	SignalConfidence float64           `json:"signal_confidence"`
	Source           string            `json:"source"`
	MachineSubtype   MachineSubtype    `json:"machine_subtype,omitempty"`
}

// EvidenceConflict preserves contradictory or multi-family evidence instead
// of allowing a hidden first-match-wins cascade.
type EvidenceConflict struct {
	Code    string   `json:"code"`
	RuleIDs []string `json:"rule_ids"`
}

type ClassificationResult struct {
	Classification     Classification
	MachineSubtype     MachineSubtype
	HumanConfidence    float64
	CalibrationBand    string
	StableReason       string
	Rules              []EvidenceRule
	Conflicts          []EvidenceConflict
	ClassifierVersion  string
	MethodologyVersion string
	RegistryVersion    string
	ConfigurationHash  string
	ShadowMode         bool
}

// Config is the complete deterministic methodology input. Thresholds and
// weights are persisted and hashed; changing one creates a new configuration
// identity even if a caller mistakenly keeps the same display version.
type Config struct {
	ClassifierVersion  string `json:"classifier_version"`
	MethodologyVersion string `json:"methodology_version"`
	RegistryVersion    string `json:"registry_version"`
	ShadowMode         bool   `json:"shadow_mode"`

	HumanThreshold   float64 `json:"human_threshold"`
	MachineThreshold float64 `json:"machine_threshold"`
	BaseHumanScore   float64 `json:"base_human_score"`

	RegistryWeightScale   float64 `json:"registry_weight_scale"`
	PrefetchLatencyWeight float64 `json:"prefetch_latency_weight"`
	AllLinksWeight        float64 `json:"all_links_weight"`
	// Weights for the impossibility rules. Heavier than the statistical tells
	// because these describe things a human physically cannot do, rather than
	// things a human is unlikely to do.
	RapidRepeatOpenWeight  float64 `json:"rapid_repeat_open_weight"`
	ClickBeforeOpenWeight  float64 `json:"click_before_open_weight"`
	GeoImpossibleWeight    float64 `json:"geo_impossible_weight"`
	ClickWithoutOpenWeight float64 `json:"click_without_open_weight"`
	BurstWeight            float64 `json:"burst_weight"`
	UAMismatchWeight       float64 `json:"ua_mismatch_weight"`
	NoAcceptLanguageWeight float64 `json:"no_accept_language_weight"`
	HumanLatencyWeight     float64 `json:"human_latency_weight"`
	EngagementDepthWeight  float64 `json:"engagement_depth_weight"`
	TrustedReplyWeight     float64 `json:"trusted_reply_weight"`

	PrefetchLatencyMax time.Duration `json:"prefetch_latency_max"`
	HumanLatencyMin    time.Duration `json:"human_latency_min"`
	AllLinksWindowMax  time.Duration `json:"all_links_window_max"`
	BurstEventMinimum  int           `json:"burst_event_minimum"`
	BurstWindowMax     time.Duration `json:"burst_window_max"`
	// RapidRepeatOpenMax is the largest gap between two opens of the same
	// message still treated as impossible for a human. Sub-second by default:
	// a person re-reading a message takes seconds at minimum, and anything
	// tighter is a fetcher retrying.
	RapidRepeatOpenMax time.Duration `json:"rapid_repeat_open_max"`
	// GeoImpossibleSpanMax is the largest elapsed time across two distinct
	// regions still treated as impossible travel. Generous on purpose: a real
	// traveller, a VPN, or a phone changing networks must not be flagged, so
	// this catches only spans no journey could cover.
	GeoImpossibleSpanMax time.Duration `json:"geo_impossible_span_max"`
	HumanDwellMinimum    time.Duration `json:"human_dwell_minimum"`
}

func DefaultConfig() Config {
	return Config{
		ClassifierVersion:      ClassifierV2,
		MethodologyVersion:     MethodologyV2,
		RegistryVersion:        CurrentRegistryV2,
		ShadowMode:             true,
		HumanThreshold:         0.80,
		MachineThreshold:       0.20,
		BaseHumanScore:         0.50,
		RegistryWeightScale:    0.55,
		PrefetchLatencyWeight:  -0.36,
		AllLinksWeight:         -0.46,
		RapidRepeatOpenWeight:  -0.55,
		ClickBeforeOpenWeight:  -0.60,
		GeoImpossibleWeight:    -0.55,
		ClickWithoutOpenWeight: -0.16,
		BurstWeight:            -0.16,
		UAMismatchWeight:       -0.15,
		NoAcceptLanguageWeight: -0.08,
		HumanLatencyWeight:     0.13,
		EngagementDepthWeight:  0.32,
		TrustedReplyWeight:     0.40,
		PrefetchLatencyMax:     5 * time.Second,
		HumanLatencyMin:        30 * time.Second,
		AllLinksWindowMax:      120 * time.Second,
		BurstEventMinimum:      8,
		BurstWindowMax:         10 * time.Second,
		RapidRepeatOpenMax:     900 * time.Millisecond,
		GeoImpossibleSpanMax:   15 * time.Minute,
		HumanDwellMinimum:      20 * time.Second,
	}
}

func (c Config) Validate() error {
	for name, value := range map[string]string{
		"classifier_version":  c.ClassifierVersion,
		"methodology_version": c.MethodologyVersion,
		"registry_version":    c.RegistryVersion,
	} {
		if !versionPattern.MatchString(value) {
			return fmt.Errorf("%w: %s is invalid", ErrInvalidInput, name)
		}
	}
	if !c.ShadowMode {
		return fmt.Errorf("%w: classifier v2 is shadow-only until calibrated cutover", ErrInvalidInput)
	}
	if c.MachineThreshold < 0 || c.HumanThreshold > 1 ||
		c.MachineThreshold >= c.HumanThreshold ||
		c.BaseHumanScore < 0 || c.BaseHumanScore > 1 {
		return fmt.Errorf("%w: invalid score thresholds", ErrInvalidInput)
	}
	for name, value := range map[string]float64{
		"registry_weight_scale":     c.RegistryWeightScale,
		"prefetch_latency_weight":   c.PrefetchLatencyWeight,
		"all_links_weight":          c.AllLinksWeight,
		"click_without_open_weight": c.ClickWithoutOpenWeight,
		"burst_weight":              c.BurstWeight,
		"ua_mismatch_weight":        c.UAMismatchWeight,
		"no_accept_language_weight": c.NoAcceptLanguageWeight,
		"human_latency_weight":      c.HumanLatencyWeight,
		"engagement_depth_weight":   c.EngagementDepthWeight,
		"trusted_reply_weight":      c.TrustedReplyWeight,
	} {
		if value < -1 || value > 1 {
			return fmt.Errorf("%w: %s must be within [-1,1]", ErrInvalidInput, name)
		}
	}
	if c.RegistryWeightScale <= 0 || c.PrefetchLatencyMax <= 0 ||
		c.HumanLatencyMin <= 0 || c.AllLinksWindowMax <= 0 ||
		c.BurstEventMinimum < 2 || c.BurstWindowMax <= 0 ||
		c.HumanDwellMinimum <= 0 || c.TrustedReplyWeight <= 0 ||
		c.BaseHumanScore+c.TrustedReplyWeight < c.HumanThreshold {
		return fmt.Errorf("%w: invalid behavioral bounds", ErrInvalidInput)
	}
	return nil
}

func (c Config) Hash() (string, error) {
	if err := c.Validate(); err != nil {
		return "", err
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return "", fmt.Errorf("marshal classifier configuration: %w", err)
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

func normalizeObservation(in ObservationInput, now time.Time) (ObservationInput, error) {
	in.Source = strings.ToLower(strings.TrimSpace(in.Source))
	in.EventType = strings.ToLower(strings.TrimSpace(in.EventType))
	in.EventSchemaVersion = strings.ToLower(strings.TrimSpace(in.EventSchemaVersion))
	in.SourceEventID = strings.TrimSpace(in.SourceEventID)
	in.IdempotencyKey = strings.TrimSpace(in.IdempotencyKey)
	in.CampaignID = strings.TrimSpace(in.CampaignID)
	in.RecipientIdentityHMAC = strings.ToLower(strings.TrimSpace(in.RecipientIdentityHMAC))
	in.RecipientKeyID = strings.TrimSpace(in.RecipientKeyID)
	in.MessageIdentityHash = strings.ToLower(strings.TrimSpace(in.MessageIdentityHash))
	in.LinkIdentityHash = strings.ToLower(strings.TrimSpace(in.LinkIdentityHash))
	in.SeedTestID = strings.TrimSpace(in.SeedTestID)
	in.ProviderMessageID = strings.TrimSpace(in.ProviderMessageID)
	in.ProviderRequestID = strings.TrimSpace(in.ProviderRequestID)
	in.UserAgent = strings.TrimSpace(in.UserAgent)
	in.IP = strings.TrimSpace(in.IP)
	in.NetworkRegion = strings.TrimSpace(in.NetworkRegion)
	in.ReverseDNS = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(in.ReverseDNS), "."))
	in.TLSJA4 = strings.TrimSpace(in.TLSJA4)
	in.BodyHash = strings.ToLower(strings.TrimSpace(in.BodyHash))
	in.RawObjectRef = strings.TrimSpace(in.RawObjectRef)
	in.RawObjectVersionID = strings.TrimSpace(in.RawObjectVersionID)
	if in.EventSchemaVersion == "" {
		in.EventSchemaVersion = ObservationSchemaV1
	}
	if in.IngestedAt.IsZero() {
		in.IngestedAt = now.UTC()
	} else {
		in.IngestedAt = in.IngestedAt.UTC()
	}
	if in.PrivacyExpiryAt.IsZero() {
		in.PrivacyExpiryAt = in.IngestedAt.Add(90 * 24 * time.Hour)
	} else {
		in.PrivacyExpiryAt = in.PrivacyExpiryAt.UTC()
	}
	in.At = in.At.UTC()
	in.OccurredAt = in.OccurredAt.UTC()
	if in.DeliveredAt != nil {
		value := in.DeliveredAt.UTC()
		in.DeliveredAt = &value
	}
	if in.ProviderSignals == nil {
		in.ProviderSignals = map[string]any{}
	}
	if in.OrderedHeaders == nil {
		in.OrderedHeaders = []Header{}
	}
	// Resolved before validate() so the persisted provenance is the normalised
	// one and an unstated source can never reach the INSERT as an empty string.
	source, err := normalizeNetworkASNSource(in)
	if err != nil {
		return ObservationInput{}, err
	}
	if !writableNetworkASNSource(source) {
		// legacy_unattributed exists only as migration 1968's backfill for rows
		// written before provenance was recorded. A NEW row claiming it would be
		// asserting that its own origin is unknowable, which is never true at
		// write time — the writer either measured it or did not.
		return ObservationInput{}, fmt.Errorf(
			"%w: network ASN source %q is read-only and cannot be written by an ingest path",
			ErrInvalidInput, source)
	}
	in.NetworkASNSource = source
	if err := in.validate(); err != nil {
		return ObservationInput{}, err
	}
	return in, nil
}

func (in ObservationInput) validate() error {
	if in.ID <= 0 || in.At.IsZero() || in.OccurredAt.IsZero() {
		return fmt.Errorf("%w: canonical event identity and occurred_at are required", ErrInvalidInput)
	}
	if !versionPattern.MatchString(in.Source) ||
		!versionPattern.MatchString(in.EventSchemaVersion) ||
		!versionPattern.MatchString(in.EventType) {
		return fmt.Errorf("%w: source, schema version, or event type is invalid", ErrInvalidInput)
	}
	if in.IdempotencyKey == "" || len(in.IdempotencyKey) > 500 ||
		strings.ContainsAny(in.IdempotencyKey, "\x00\r\n") {
		return fmt.Errorf("%w: idempotency key is invalid", ErrInvalidInput)
	}
	if len(in.SourceEventID) > 500 || len(in.ProviderMessageID) > 500 ||
		len(in.ProviderRequestID) > 500 || len(in.UserAgent) > 4096 ||
		len(in.NetworkRegion) > 160 || len(in.ReverseDNS) > 253 ||
		len(in.RawObjectRef) > 2000 || len(in.RawObjectVersionID) > 1000 {
		return fmt.Errorf("%w: observation field exceeds bound", ErrInvalidInput)
	}
	if len(in.OrderedHeaders) > 128 {
		return fmt.Errorf("%w: ordered headers exceed 128", ErrInvalidInput)
	}
	for _, header := range in.OrderedHeaders {
		if strings.TrimSpace(header.Name) == "" || len(header.Name) > 200 ||
			len(header.Value) > 4000 || strings.ContainsAny(header.Name, "\x00\r\n") {
			return fmt.Errorf("%w: ordered header is invalid", ErrInvalidInput)
		}
	}
	for name, value := range map[string]string{
		"recipient_identity_hmac": in.RecipientIdentityHMAC,
		"message_identity_hash":   in.MessageIdentityHash,
		"link_identity_hash":      in.LinkIdentityHash,
		"body_hash":               in.BodyHash,
	} {
		if value != "" && !hashPattern.MatchString(value) {
			return fmt.Errorf("%w: %s must be lowercase sha256", ErrInvalidInput, name)
		}
	}
	if (in.RecipientIdentityHMAC == "") != (in.RecipientKeyID == "") {
		return fmt.Errorf("%w: recipient hmac and key id must appear together", ErrInvalidInput)
	}
	if in.IP != "" && net.ParseIP(in.IP) == nil {
		return fmt.Errorf("%w: IP is invalid", ErrInvalidInput)
	}
	if in.DwellMilliseconds != nil && (*in.DwellMilliseconds < 0 || *in.DwellMilliseconds > 86400000) {
		return fmt.Errorf("%w: dwell milliseconds are invalid", ErrInvalidInput)
	}
	if in.MessageLinkCount != nil && (*in.MessageLinkCount < 0 || *in.MessageLinkCount > 10000) {
		return fmt.Errorf("%w: message link count is invalid", ErrInvalidInput)
	}
	// The ASN/provenance pair is checked here as well as in the database.
	// validate() runs on corpus examples and reclassification read-backs that
	// never touch an INSERT, and a corpus row carrying an ASN with no stated
	// provenance would train a calibration report on evidence nobody can audit.
	if _, err := normalizeNetworkASNSource(in); err != nil {
		return err
	}
	if in.PrivacyExpiryAt.Before(in.IngestedAt) {
		return fmt.Errorf("%w: privacy expiry precedes ingestion", ErrInvalidInput)
	}
	rawHeaders, _ := json.Marshal(in.OrderedHeaders)
	rawSignals, err := json.Marshal(in.ProviderSignals)
	if err != nil || len(rawHeaders) > 32768 || len(rawSignals) > 16384 {
		return fmt.Errorf("%w: evidence JSON exceeds bound or is invalid", ErrInvalidInput)
	}
	return nil
}

// observationFingerprint omits server receipt/expiry times. A provider retry
// of the exact same source event therefore remains idempotent even though it
// arrives later; every evidence-bearing source field is included.
func observationFingerprint(in ObservationInput) (string, error) {
	type fingerprintInput struct {
		EventRef
		Source, SourceEventID, IdempotencyKey, EventSchemaVersion, EventType string
		OccurredAt, DeliveredAt                                              string
		CampaignID, RecipientIdentityHMAC, RecipientKeyID                    string
		MessageIdentityHash, LinkIdentityHash                                string
		IsSeed                                                               bool
		SeedTestID, ProviderMessageID, ProviderRequestID                     string
		OrderedHeaders                                                       []Header
		OrderedHeadersComplete                                               bool
		UserAgent, IP                                                        string
		NetworkASN                                                           *uint32
		NetworkRegion, ReverseDNS, TLSJA4                                    string
		ProviderSignals                                                      map[string]any
		DwellMilliseconds                                                    *int64
		MessageLinkCount                                                     *int
		BodyHash, RawObjectRef, RawObjectVersionID                           string
	}
	delivered := ""
	if in.DeliveredAt != nil {
		delivered = in.DeliveredAt.UTC().Format(time.RFC3339Nano)
	}
	payload := fingerprintInput{
		EventRef: in.EventRef, Source: in.Source, SourceEventID: in.SourceEventID,
		IdempotencyKey: in.IdempotencyKey, EventSchemaVersion: in.EventSchemaVersion,
		EventType: in.EventType, OccurredAt: in.OccurredAt.UTC().Format(time.RFC3339Nano),
		DeliveredAt: delivered, CampaignID: in.CampaignID,
		RecipientIdentityHMAC: in.RecipientIdentityHMAC, RecipientKeyID: in.RecipientKeyID,
		MessageIdentityHash: in.MessageIdentityHash, LinkIdentityHash: in.LinkIdentityHash,
		IsSeed: in.IsSeed, SeedTestID: in.SeedTestID,
		ProviderMessageID: in.ProviderMessageID, ProviderRequestID: in.ProviderRequestID,
		OrderedHeaders: in.OrderedHeaders, OrderedHeadersComplete: in.OrderedHeadersComplete,
		UserAgent: in.UserAgent, IP: in.IP,
		NetworkASN: in.NetworkASN, NetworkRegion: in.NetworkRegion,
		ReverseDNS: in.ReverseDNS, TLSJA4: in.TLSJA4,
		ProviderSignals: in.ProviderSignals, DwellMilliseconds: in.DwellMilliseconds,
		MessageLinkCount: in.MessageLinkCount, BodyHash: in.BodyHash,
		RawObjectRef: in.RawObjectRef, RawObjectVersionID: in.RawObjectVersionID,
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("fingerprint observation: %w", err)
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

func ruleIDs(rules []EvidenceRule) []string {
	ids := make([]string, 0, len(rules))
	seen := make(map[string]struct{}, len(rules))
	for _, rule := range rules {
		if _, exists := seen[rule.ID]; exists {
			continue
		}
		seen[rule.ID] = struct{}{}
		ids = append(ids, rule.ID)
	}
	sort.Strings(ids)
	return ids
}
