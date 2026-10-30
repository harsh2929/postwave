// SPDX-License-Identifier: AGPL-3.0-only

package engagementclassification

import (
	"fmt"
	"math"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
)

type MatcherType string

const (
	MatchASN              MatcherType = "asn"
	MatchCIDR             MatcherType = "cidr"
	MatchUASubstring      MatcherType = "ua_substring"
	MatchUARegex          MatcherType = "ua_regex"
	MatchReverseDNSSuffix MatcherType = "reverse_dns_suffix"
	MatchProviderFlag     MatcherType = "provider_flag"
	MatchSource           MatcherType = "source"
	// MatchJA4 matches the TLS fingerprint of the client that fetched the
	// pixel or link. Valuable because it survives the two things an operator
	// can trivially change — the User-Agent string and the source IP — so an
	// automation that rotates both still presents the same TLS stack.
	//
	// Matched EXACTLY rather than by prefix: a JA4 is already a digest, and a
	// prefix match would silently widen to every client sharing a TLS library
	// version, which includes ordinary browsers.
	MatchJA4 MatcherType = "ja4"
)

// RegistryEntry is one immutable row from the data-backed machine-source
// registry. EntryID is also the explainable rule ID shown in evidence.
type RegistryEntry struct {
	RegistryVersion string
	EntryID         string
	MatcherType     MatcherType
	MatcherValue    string
	MachineSubtype  MachineSubtype
	Confidence      float64
	SourceNote      string
	LastVerified    time.Time
	Fingerprint     string

	compiledRegex *regexp.Regexp
	cidr          *net.IPNet
	asn           uint32
}

func (entry RegistryEntry) validated(expectedRegistry string) (RegistryEntry, error) {
	entry.RegistryVersion = strings.ToLower(strings.TrimSpace(entry.RegistryVersion))
	entry.EntryID = strings.ToUpper(strings.TrimSpace(entry.EntryID))
	// SQL btrim() removes ASCII space, not the broader Unicode White_Space
	// class. Match that exact canonicalization so a direct governed publication
	// cannot seal bytes that the loader later rewrites before fingerprinting.
	entry.MatcherValue = strings.Trim(entry.MatcherValue, " ")
	entry.SourceNote = strings.Trim(entry.SourceNote, " ")
	canonicalConfidence := math.Round(entry.Confidence*10_000) / 10_000
	if entry.RegistryVersion != expectedRegistry || !versionPattern.MatchString(entry.RegistryVersion) {
		return RegistryEntry{}, fmt.Errorf("%w: registry entry version mismatch", ErrInvalidInput)
	}
	if !rulePattern.MatchString(entry.EntryID) || len(entry.MatcherValue) == 0 ||
		len(entry.MatcherValue) > 1000 || !entry.MachineSubtype.Valid() ||
		math.IsNaN(entry.Confidence) || math.IsInf(entry.Confidence, 0) ||
		entry.Confidence < 0 || entry.Confidence > 1 ||
		math.Abs(entry.Confidence-canonicalConfidence) > 1e-12 ||
		entry.SourceNote == "" || len(entry.SourceNote) > 2000 ||
		strings.IndexFunc(entry.MatcherValue, unicode.IsControl) >= 0 ||
		strings.IndexFunc(entry.SourceNote, unicode.IsControl) >= 0 ||
		entry.LastVerified.IsZero() {
		return RegistryEntry{}, fmt.Errorf("%w: invalid registry entry %q", ErrInvalidInput, entry.EntryID)
	}
	entry.Confidence = canonicalConfidence
	switch entry.MatcherType {
	case MatchASN:
		parsed, err := strconv.ParseUint(entry.MatcherValue, 10, 32)
		if err != nil || parsed == 0 {
			return RegistryEntry{}, fmt.Errorf("%w: invalid ASN matcher %q", ErrInvalidInput, entry.EntryID)
		}
		entry.asn = uint32(parsed)
	case MatchCIDR:
		_, network, err := net.ParseCIDR(entry.MatcherValue)
		if err != nil {
			return RegistryEntry{}, fmt.Errorf("%w: invalid CIDR matcher %q", ErrInvalidInput, entry.EntryID)
		}
		entry.cidr = network
	case MatchUARegex:
		compiled, err := regexp.Compile(entry.MatcherValue)
		if err != nil {
			return RegistryEntry{}, fmt.Errorf("%w: invalid UA regex matcher %q", ErrInvalidInput, entry.EntryID)
		}
		entry.compiledRegex = compiled
	case MatchUASubstring, MatchReverseDNSSuffix, MatchProviderFlag, MatchSource, MatchJA4:
		// Validated during matching without additional compiled state.
	default:
		return RegistryEntry{}, fmt.Errorf("%w: unsupported registry matcher %q", ErrInvalidInput, entry.MatcherType)
	}
	if entry.Fingerprint != "" {
		expected, err := registryFingerprint(entry)
		if err != nil || !hashPattern.MatchString(entry.Fingerprint) || entry.Fingerprint != expected {
			return RegistryEntry{}, fmt.Errorf("%w: registry entry fingerprint mismatch %q", ErrInvalidInput, entry.EntryID)
		}
	}
	return entry, nil
}

// Classifier is immutable and safe for concurrent use after construction.
type Classifier struct {
	config     Config
	configHash string
	registry   []RegistryEntry
}

func NewClassifier(config Config, registry []RegistryEntry) (*Classifier, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	hash, err := config.Hash()
	if err != nil {
		return nil, err
	}
	validated := make([]RegistryEntry, 0, len(registry))
	seen := make(map[string]struct{}, len(registry))
	for _, input := range registry {
		entry, err := input.validated(config.RegistryVersion)
		if err != nil {
			return nil, err
		}
		if _, duplicate := seen[entry.EntryID]; duplicate {
			return nil, fmt.Errorf("%w: duplicate registry entry %q", ErrInvalidInput, entry.EntryID)
		}
		seen[entry.EntryID] = struct{}{}
		validated = append(validated, entry)
	}
	sort.Slice(validated, func(i, j int) bool {
		return validated[i].EntryID < validated[j].EntryID
	})
	return &Classifier{config: config, configHash: hash, registry: validated}, nil
}

func (classifier *Classifier) Config() Config {
	if classifier == nil {
		return Config{}
	}
	return classifier.config
}

func (classifier *Classifier) ConfigurationHash() string {
	if classifier == nil {
		return ""
	}
	return classifier.configHash
}

// Classify evaluates all evidence. Deterministic seed identity is an absolute
// machine decision, but even then contradictory human evidence is retained in
// Conflicts rather than discarded.
func (classifier *Classifier) Classify(observation ObservationInput, aggregate MessageAggregate) (ClassificationResult, error) {
	if classifier == nil {
		return ClassificationResult{}, fmt.Errorf("%w: nil classifier", ErrInvalidInput)
	}
	normalized, err := normalizeObservation(observation, time.Now().UTC())
	if err != nil {
		return ClassificationResult{}, err
	}
	config := classifier.config
	rules := make([]EvidenceRule, 0, 12)

	seedAbsolute := normalized.IsSeed
	if seedAbsolute {
		rules = append(rules, EvidenceRule{
			ID: "R_SEED_ORIGIN", Direction: DirectionMachine, Weight: -1,
			SignalConfidence: 1, Source: "controlled_seed_registry",
			MachineSubtype: SubtypeSeedAutomation,
		})
	}

	for _, entry := range classifier.registry {
		if !entry.matches(normalized) {
			continue
		}
		rules = append(rules, EvidenceRule{
			ID: entry.EntryID, Direction: DirectionMachine,
			Weight:           -math.Abs(config.RegistryWeightScale * entry.Confidence),
			SignalConfidence: entry.Confidence, Source: "machine_source_registry",
			MachineSubtype: entry.MachineSubtype,
		})
	}

	// The reply pipeline admits a canonical replied event only after exact
	// outbound Message-ID or cryptographic VERP correlation and its versioned,
	// header-first exclusion classifier. Consume that content-free receipt only
	// when every closed field agrees. Bare replied events, sender fallback,
	// partial receipts, and unknown future reply methods remain unknown.
	if trustedHumanReplyReceipt(normalized) {
		rules = append(rules, humanRule(
			"R_TRUSTED_HUMAN_REPLY", config.TrustedReplyWeight,
			"reply_classifier_receipt",
		))
	}

	deliveredAt := normalized.DeliveredAt
	if deliveredAt == nil {
		deliveredAt = aggregate.DeliveredAt
	}
	if deliveredAt != nil && !normalized.OccurredAt.Before(*deliveredAt) {
		latency := normalized.OccurredAt.Sub(*deliveredAt)
		if normalized.EventType == "opened" && latency < config.PrefetchLatencyMax {
			rules = append(rules, machineRule("R_PREFETCH_LATENCY", config.PrefetchLatencyWeight, SubtypePrefetcher, "message_aggregate"))
		}
		if normalized.EventType == "opened" && latency >= config.HumanLatencyMin {
			rules = append(rules, humanRule("R_HUMAN_LATENCY", config.HumanLatencyWeight, "message_aggregate"))
		}
	}

	if normalized.EventType == "clicked" && aggregate.Complete && aggregate.TotalLinks > 1 &&
		aggregate.DistinctLinksFetched >= aggregate.TotalLinks &&
		aggregate.BurstWindow > 0 && aggregate.BurstWindow <= config.AllLinksWindowMax {
		rules = append(rules, machineRule("R_ALL_LINKS_FETCHED", config.AllLinksWeight, SubtypeSEGScanner, "message_aggregate"))
	}
	if normalized.EventType == "clicked" && aggregate.Complete && !aggregate.HasPrecedingOpen {
		rules = append(rules, machineRule("R_CLICK_WITHOUT_OPEN", config.ClickWithoutOpenWeight, SubtypeLinkChecker, "message_aggregate"))
	}
	if aggregate.EventCount >= config.BurstEventMinimum && aggregate.BurstWindow > 0 &&
		aggregate.BurstWindow <= config.BurstWindowMax {
		rules = append(rules, machineRule("R_BURST", config.BurstWeight, SubtypeUnknownBot, "message_aggregate"))
	}
	if userAgentFamiliesConflict(aggregate.OpenUserAgents, aggregate.ClickUserAgents) {
		rules = append(rules, machineRule("R_UA_MISMATCH", config.UAMismatchWeight, SubtypeUnknownBot, "message_aggregate"))
	}
	if (normalized.EventType == "opened" || normalized.EventType == "clicked") &&
		normalized.OrderedHeadersComplete &&
		!hasHeader(normalized.OrderedHeaders, "accept-language") {
		rules = append(rules, machineRule("R_NO_ACCEPT_LANGUAGE", config.NoAcceptLanguageWeight, SubtypeLinkChecker, "ordered_headers"))
	}
	// Impossibility rules. These describe things a human physically cannot do,
	// so they are separated from the statistical tells above — and every one is
	// gated on aggregate.Complete, because judging fan-out or ordering from a
	// partial view of a message's events is guessing, not measuring.
	if aggregate.Complete && aggregate.OpenCount >= 2 &&
		aggregate.MinOpenGap > 0 && aggregate.MinOpenGap <= config.RapidRepeatOpenMax {
		// OpenCount >= 2 is load-bearing: with one open there is no pair to
		// measure, and a zero gap would otherwise read as "0ms apart".
		rules = append(rules, machineRule("R_RAPID_REPEAT_OPEN", config.RapidRepeatOpenWeight, SubtypeUnknownBot, "message_aggregate"))
	}
	if aggregate.Complete && normalized.EventType == "clicked" &&
		aggregate.FirstOpenAt != nil && normalized.OccurredAt.Before(*aggregate.FirstOpenAt) {
		// Nobody clicks a link in a message they have not rendered. This is the
		// signature of a scanner that fetches links before images.
		rules = append(rules, machineRule("R_CLICK_BEFORE_OPEN", config.ClickBeforeOpenWeight, SubtypeSEGScanner, "message_aggregate"))
	}
	if aggregate.Complete && aggregate.DistinctOpenRegions >= 2 &&
		aggregate.RegionSpan > 0 && aggregate.RegionSpan <= config.GeoImpossibleSpanMax {
		// Distinct from R_BURST: these opens can be minutes apart and still
		// describe a journey no traveller could make.
		rules = append(rules, machineRule("R_GEO_IMPOSSIBLE", config.GeoImpossibleWeight, SubtypeUnknownBot, "message_aggregate"))
	}
	if normalized.DwellMilliseconds != nil &&
		time.Duration(*normalized.DwellMilliseconds)*time.Millisecond >= config.HumanDwellMinimum {
		rules = append(rules, humanRule("R_ENGAGEMENT_DEPTH", config.EngagementDepthWeight, "engagement_beacon"))
	}

	result := classifier.aggregate(rules, seedAbsolute)
	return result, nil
}

func trustedHumanReplyReceipt(observation ObservationInput) bool {
	if observation.EventType != "replied" ||
		!strings.HasPrefix(observation.Source, "reply.") {
		return false
	}
	signals := observation.ProviderSignals
	if signals == nil || signalString(signals, "reply_classification") != "human_reply" ||
		signalString(signals, "reply_classifier_version") != "postwave.reply-classifier.v1" ||
		signalString(signals, "reply_classifier_reason") != "R_REPLY_HUMAN_AFTER_EXCLUSIONS" ||
		signalString(signals, "reply_correlation_strength") != "strong" {
		return false
	}
	method := signalString(signals, "reply_correlation_method")
	if method != "in_reply_to" && method != "verp" {
		return false
	}
	return signalStringSliceContains(
		signals["reply_classifier_evidence"], "R_REPLY_HUMAN_AFTER_EXCLUSIONS",
	)
}

func signalString(signals map[string]any, key string) string {
	value, ok := signals[key].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(value)
}

func signalStringSliceContains(value any, wanted string) bool {
	switch values := value.(type) {
	case []string:
		for _, candidate := range values {
			if candidate == wanted {
				return true
			}
		}
	case []any:
		for _, raw := range values {
			if candidate, ok := raw.(string); ok && candidate == wanted {
				return true
			}
		}
	}
	return false
}

func (classifier *Classifier) aggregate(rules []EvidenceRule, seedAbsolute bool) ClassificationResult {
	config := classifier.config
	score := config.BaseHumanScore
	hasHuman := false
	hasMachine := false
	strongestSubtype := MachineSubtype("")
	strongestSubtypeWeight := -1.0
	subtypeRules := make(map[MachineSubtype][]string)
	for _, rule := range rules {
		score += rule.Weight
		switch rule.Direction {
		case DirectionHuman:
			hasHuman = true
		case DirectionMachine:
			hasMachine = true
			if rule.MachineSubtype.Valid() {
				subtypeRules[rule.MachineSubtype] = append(subtypeRules[rule.MachineSubtype], rule.ID)
				weight := math.Abs(rule.Weight)
				// Specificity beats weight. SubtypeUnknownBot is an admission
				// of ignorance rather than a classification, so a heavy generic
				// signal — a provider's machine_open flag, say — must not
				// overwrite "gmail_proxy" with "some bot". Doing so would make
				// adding a high-confidence flag DEGRADE every verdict it
				// touches, reporting less than we already knew.
				currentIsGeneric := strongestSubtype == SubtypeUnknownBot
				candidateIsGeneric := rule.MachineSubtype == SubtypeUnknownBot
				better := false
				switch {
				case strongestSubtype == "":
					better = true
				case currentIsGeneric && !candidateIsGeneric:
					better = true
				case !currentIsGeneric && candidateIsGeneric:
					better = false
				case weight > strongestSubtypeWeight:
					better = true
				case weight == strongestSubtypeWeight && rule.MachineSubtype < strongestSubtype:
					better = true
				}
				if better {
					strongestSubtypeWeight = weight
					strongestSubtype = rule.MachineSubtype
				}
			}
		}
	}
	score = clamp01(score)
	classification := Unknown
	if seedAbsolute {
		classification = Machine
		score = 0
	} else if score <= config.MachineThreshold {
		classification = Machine
	} else if score >= config.HumanThreshold {
		classification = Human
	}

	conflicts := make([]EvidenceConflict, 0, 2)
	if hasHuman && hasMachine {
		conflicts = append(conflicts, EvidenceConflict{
			Code: "C_HUMAN_MACHINE_EVIDENCE", RuleIDs: ruleIDs(rules),
		})
	}
	if len(subtypeRules) > 1 {
		ids := make([]string, 0)
		for _, subtypeRuleIDs := range subtypeRules {
			ids = append(ids, subtypeRuleIDs...)
		}
		sort.Strings(ids)
		conflicts = append(conflicts, EvidenceConflict{
			Code: "C_MULTIPLE_MACHINE_FAMILIES", RuleIDs: ids,
		})
	}

	stableReason := strongestRuleID(rules, classification)
	if classification == Unknown {
		stableReason = ReasonNoConfidentSignal
		if len(conflicts) > 0 {
			stableReason = ReasonConflictingEvidence
		}
		rules = append(rules, EvidenceRule{
			ID: stableReason, Direction: DirectionNeutral, Weight: 0,
			SignalConfidence: 1, Source: "classifier_aggregation",
		})
	}
	if len(rules) == 0 {
		stableReason = ReasonNoConfidentSignal
		rules = append(rules, EvidenceRule{
			ID: stableReason, Direction: DirectionNeutral, Weight: 0,
			SignalConfidence: 1, Source: "classifier_aggregation",
		})
	}
	if classification == Machine && !strongestSubtype.Valid() {
		strongestSubtype = SubtypeUnknownBot
	}
	if classification != Machine {
		strongestSubtype = ""
	}
	sort.SliceStable(rules, func(i, j int) bool { return rules[i].ID < rules[j].ID })
	sort.SliceStable(conflicts, func(i, j int) bool { return conflicts[i].Code < conflicts[j].Code })
	return ClassificationResult{
		Classification: classification, MachineSubtype: strongestSubtype,
		HumanConfidence: score, CalibrationBand: calibrationBand(classification, score, seedAbsolute),
		StableReason: stableReason, Rules: rules, Conflicts: conflicts,
		ClassifierVersion:  config.ClassifierVersion,
		MethodologyVersion: config.MethodologyVersion,
		RegistryVersion:    config.RegistryVersion,
		ConfigurationHash:  classifier.configHash, ShadowMode: config.ShadowMode,
	}
}

func (entry RegistryEntry) matches(observation ObservationInput) bool {
	switch entry.MatcherType {
	case MatchASN:
		return observation.NetworkASN != nil && *observation.NetworkASN == entry.asn
	case MatchCIDR:
		return observation.IP != "" && entry.cidr.Contains(net.ParseIP(observation.IP))
	case MatchUASubstring:
		return strings.Contains(strings.ToLower(observation.UserAgent), strings.ToLower(entry.MatcherValue))
	case MatchUARegex:
		return entry.compiledRegex.MatchString(observation.UserAgent)
	case MatchReverseDNSSuffix:
		suffix := strings.ToLower(strings.TrimPrefix(entry.MatcherValue, "."))
		name := strings.ToLower(strings.TrimSuffix(observation.ReverseDNS, "."))
		return name == suffix || strings.HasSuffix(name, "."+suffix)
	case MatchJA4:
		return observation.TLSJA4 != "" &&
			strings.EqualFold(observation.TLSJA4, entry.MatcherValue)
	case MatchProviderFlag:
		key, expected, hasExpected := strings.Cut(entry.MatcherValue, "=")
		value, exists := lookupSignal(observation.ProviderSignals, strings.TrimSpace(key))
		if !exists {
			return false
		}
		if !hasExpected {
			return truthySignal(value)
		}
		return strings.EqualFold(strings.TrimSpace(fmt.Sprint(value)), strings.TrimSpace(expected))
	case MatchSource:
		return strings.EqualFold(observation.Source, entry.MatcherValue)
	default:
		return false
	}
}

func lookupSignal(signals map[string]any, wanted string) (any, bool) {
	for key, value := range signals {
		if strings.EqualFold(strings.TrimSpace(key), wanted) {
			return value, true
		}
	}
	return nil, false
}

func truthySignal(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		switch strings.ToLower(strings.TrimSpace(typed)) {
		case "1", "true", "yes", "machine":
			return true
		}
	case float64:
		return typed != 0
	case int:
		return typed != 0
	case int64:
		return typed != 0
	}
	return false
}

func machineRule(id string, weight float64, subtype MachineSubtype, source string) EvidenceRule {
	return EvidenceRule{ID: id, Direction: DirectionMachine, Weight: -math.Abs(weight), SignalConfidence: math.Abs(weight), Source: source, MachineSubtype: subtype}
}

func humanRule(id string, weight float64, source string) EvidenceRule {
	return EvidenceRule{ID: id, Direction: DirectionHuman, Weight: math.Abs(weight), SignalConfidence: math.Abs(weight), Source: source}
}

func hasHeader(headers []Header, wanted string) bool {
	for _, header := range headers {
		if strings.EqualFold(strings.TrimSpace(header.Name), wanted) {
			return true
		}
	}
	return false
}

func userAgentFamiliesConflict(openUAs, clickUAs []string) bool {
	openFamilies := make(map[string]struct{})
	for _, ua := range openUAs {
		if family := userAgentFamily(ua); family != "" {
			openFamilies[family] = struct{}{}
		}
	}
	if len(openFamilies) == 0 {
		return false
	}
	for _, ua := range clickUAs {
		family := userAgentFamily(ua)
		if family == "" {
			continue
		}
		if _, compatible := openFamilies[family]; compatible {
			return false
		}
	}
	return len(clickUAs) > 0
}

func userAgentFamily(userAgent string) string {
	lower := strings.ToLower(userAgent)
	switch {
	case strings.Contains(lower, "googleimageproxy"):
		return "gmail_proxy"
	case strings.Contains(lower, "applewebkit") && (strings.Contains(lower, "safari") || strings.Contains(lower, "mobile")):
		return "webkit"
	case strings.Contains(lower, "firefox"):
		return "firefox"
	case strings.Contains(lower, "edg/"):
		return "edge"
	case strings.Contains(lower, "chrome") || strings.Contains(lower, "chromium"):
		return "chromium"
	case strings.Contains(lower, "outlook"):
		return "outlook"
	default:
		return ""
	}
}

func strongestRuleID(rules []EvidenceRule, classification Classification) string {
	wanted := DirectionHuman
	if classification == Machine {
		wanted = DirectionMachine
	}
	bestID := ""
	bestWeight := -1.0
	for _, rule := range rules {
		if rule.Direction != wanted {
			continue
		}
		weight := math.Abs(rule.Weight)
		if weight > bestWeight || (weight == bestWeight && rule.ID < bestID) {
			bestWeight = weight
			bestID = rule.ID
		}
	}
	if bestID == "" {
		return ReasonNoConfidentSignal
	}
	return bestID
}

func calibrationBand(classification Classification, score float64, absoluteMachine bool) string {
	if absoluteMachine {
		return "deterministic_machine"
	}
	switch classification {
	case Machine:
		return "likely_machine"
	case Human:
		if score >= 0.95 {
			return "calibrated_human"
		}
		return "likely_human"
	default:
		return "ambiguous"
	}
}

func clamp01(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return math.Round(value*10000) / 10000
}
