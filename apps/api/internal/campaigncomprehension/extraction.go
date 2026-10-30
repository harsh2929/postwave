// SPDX-License-Identifier: AGPL-3.0-only

package campaigncomprehension

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/currency"
	"golang.org/x/text/unicode/norm"

	"github.com/postwave/postwave/apps/api/internal/factcontract"
)

const (
	MaxExtractionBytes   = 128 << 10
	maxSummaryRunes      = 2000
	maxStatementRunes    = 4000
	maxActionLabelRunes  = 512
	maxFactValueRunes    = 4000
	maxDescriptionRunes  = 4000
	maxURLBytes          = 4096
	maxReferenceBytes    = 128
	maxFacts             = 128
	maxUnsupportedClaims = 64
	maxAmbiguities       = 64
	maxEvidencePerItem   = 64
	maxTotalEvidence     = 1024
	maxDecimalDigits     = 38
	maxDecimalScale      = 9
)

var (
	stableReferencePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	publicCodePattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,95}$`)
	hashPattern            = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

var validIntentKinds = map[factcontract.IntentKind]struct{}{
	factcontract.IntentInform: {}, factcontract.IntentInvite: {}, factcontract.IntentPromote: {},
	factcontract.IntentRequestAction: {}, factcontract.IntentRemind: {}, factcontract.IntentSurvey: {},
	factcontract.IntentTransact: {}, factcontract.IntentOnboard: {}, factcontract.IntentRetain: {},
	factcontract.IntentOther: {},
}

var validActionRoles = map[factcontract.PrimaryActionRole]struct{}{
	factcontract.PrimaryActionNavigate: {}, factcontract.PrimaryActionRegister: {},
	factcontract.PrimaryActionPurchase: {}, factcontract.PrimaryActionRSVP: {},
	factcontract.PrimaryActionConfirm: {}, factcontract.PrimaryActionDownload: {},
	factcontract.PrimaryActionSurvey: {}, factcontract.PrimaryActionReply: {},
	factcontract.PrimaryActionTrack: {},
}

var validFactTypes = map[factcontract.FactType]struct{}{
	factcontract.FactTypeText: {}, factcontract.FactTypeDateTime: {},
	factcontract.FactTypeMoney: {}, factcontract.FactTypeLocation: {},
	factcontract.FactTypeCode: {}, factcontract.FactTypePercentage: {},
	factcontract.FactTypeQuantity: {}, factcontract.FactTypeURL: {},
}

var trackingQueryKeys = map[string]struct{}{
	"gclid": {}, "dclid": {}, "fbclid": {}, "msclkid": {}, "yclid": {},
	"mc_cid": {}, "mc_eid": {}, "_hsenc": {}, "_hsmi": {}, "vero_conv": {},
	"vero_id": {}, "oly_anon_id": {}, "oly_enc_id": {}, "rb_clickid": {},
	"s_cid": {}, "wickedid": {},
}

// DecodeAndNormalizeV1 rejects any output outside the closed schema, validates
// every evidence reference against the caller's exact allowlist, returns a
// stable canonical ordering, and hashes a versioned receipt preimage.
func DecodeAndNormalizeV1(raw []byte, allowedEvidenceIDs []string) (ExtractionReceiptV1, ValidationErrors) {
	var zero ExtractionReceiptV1
	if len(raw) == 0 {
		return zero, ValidationErrors{{Path: "", Code: CodeRequired, Message: "extraction JSON is required"}}
	}
	if len(raw) > MaxExtractionBytes {
		return zero, ValidationErrors{{Path: "", Code: CodeInputTooLarge, Message: fmt.Sprintf("extraction JSON must not exceed %d bytes", MaxExtractionBytes)}}
	}
	if !utf8.Valid(raw) {
		return zero, ValidationErrors{{Path: "", Code: CodeInvalidText, Message: "extraction JSON must be valid UTF-8"}}
	}
	if err := rejectDuplicateKeys(raw); err != nil {
		return zero, ValidationErrors{{Path: err.path, Code: err.code, Message: err.message}}
	}

	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var extraction ExtractionV1
	if err := decoder.Decode(&extraction); err != nil {
		code := CodeInvalidJSON
		if strings.Contains(err.Error(), "unknown field") {
			code = CodeUnknownField
		}
		return zero, ValidationErrors{{Path: "", Code: code, Message: publicJSONError(err, code)}}
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return zero, ValidationErrors{{Path: "", Code: CodeTrailingJSON, Message: "exactly one JSON object is required"}}
	}

	allowlist, errs := normalizeEvidenceAllowlist(allowedEvidenceIDs)
	errs = append(errs, validateRawExtractionBounds(extraction)...)
	normalized := normalizeExtraction(extraction)
	errs = append(errs, validateNormalizedExtraction(normalized, allowlist)...)
	if len(errs) != 0 {
		return zero, errs
	}

	canonical, err := json.Marshal(normalized)
	if err != nil {
		return zero, ValidationErrors{{Path: "", Code: CodeInvalidJSON, Message: "normalized extraction could not be encoded"}}
	}
	if len(canonical) > MaxExtractionBytes {
		return zero, ValidationErrors{{Path: "", Code: CodeInputTooLarge, Message: fmt.Sprintf("normalized extraction must not exceed %d bytes", MaxExtractionBytes)}}
	}
	preimage := extractionReceiptPreimage{
		SchemaVersion:        ExtractionSchemaVersionV1,
		NormalizationVersion: ExtractionNormalizationVersionV1,
		Extraction:           normalized,
	}
	encoded, err := json.Marshal(preimage)
	if err != nil {
		return zero, ValidationErrors{{Path: "", Code: CodeInvalidJSON, Message: "extraction receipt could not be encoded"}}
	}
	sum := sha256.Sum256(encoded)
	return ExtractionReceiptV1{
		SchemaVersion:        ExtractionSchemaVersionV1,
		NormalizationVersion: ExtractionNormalizationVersionV1,
		Extraction:           normalized,
		CanonicalExtraction:  canonical,
		ReceiptHash:          hex.EncodeToString(sum[:]),
	}, nil
}

func validateRawExtractionBounds(value ExtractionV1) ValidationErrors {
	errs := ValidationErrors{}
	errs.validateRawStringBound("/summary", value.Summary, maxSummaryRunes)
	errs.validateRawStringBound("/primary_intent/value", value.PrimaryIntent.Value, maxStatementRunes)
	errs.validateRawReferences("/primary_intent/evidence_ids", value.PrimaryIntent.EvidenceIDs)
	errs.validateRawStringBound("/core_claim/value", value.CoreClaim.Value, maxStatementRunes)
	errs.validateRawReferences("/core_claim/evidence_ids", value.CoreClaim.EvidenceIDs)
	errs.validateRawStringBound("/primary_action/action_id", string(value.PrimaryAction.ActionID), maxReferenceBytes)
	errs.validateRawStringBound("/primary_action/block_id", string(value.PrimaryAction.BlockID), maxReferenceBytes)
	errs.validateRawStringBound("/primary_action/label", value.PrimaryAction.Label, maxActionLabelRunes)
	if len(value.PrimaryAction.CanonicalURL) > maxURLBytes {
		errs.add("/primary_action/canonical_url", CodeTextTooLong, fmt.Sprintf("URL must contain at most %d bytes before normalization", maxURLBytes))
	}
	errs.validateRawReferences("/primary_action/evidence_ids", value.PrimaryAction.EvidenceIDs)
	for index, fact := range value.Facts {
		base := fmt.Sprintf("/facts/%d", index)
		errs.validateRawStringBound(base+"/fact_id", string(fact.FactID), maxReferenceBytes)
		errs.validateRawStringBound(base+"/raw", fact.Raw, maxFactValueRunes)
		errs.validateRawStringBound(base+"/normalized", fact.Normalized, maxFactValueRunes)
		errs.validateRawStringBound(base+"/timezone", fact.Timezone, 255)
		errs.validateRawStringBound(base+"/currency", fact.Currency, 16)
		errs.validateRawStringBound(base+"/unit", fact.Unit, 64)
		errs.validateRawReferences(base+"/evidence_ids", fact.EvidenceIDs)
	}
	for index, claim := range value.UnsupportedClaims {
		base := fmt.Sprintf("/unsupported_claims/%d", index)
		errs.validateRawStringBound(base+"/statement", claim.Statement, maxStatementRunes)
		errs.validateRawReferences(base+"/evidence_ids", claim.EvidenceIDs)
	}
	for index, ambiguity := range value.Ambiguities {
		base := fmt.Sprintf("/ambiguities/%d", index)
		errs.validateRawStringBound(base+"/field", ambiguity.Field, maxReferenceBytes)
		errs.validateRawStringBound(base+"/description", ambiguity.Description, maxDescriptionRunes)
		errs.validateRawReferences(base+"/evidence_ids", ambiguity.EvidenceIDs)
	}
	return errs
}

func (e *ValidationErrors) validateRawStringBound(path, value string, maxRunes int) {
	if utf8.RuneCountInString(value) > maxRunes {
		e.add(path, CodeTextTooLong, fmt.Sprintf("value must contain at most %d Unicode characters before normalization", maxRunes))
	}
}

func (e *ValidationErrors) validateRawReferences(path string, values []string) {
	for index, value := range values {
		e.validateRawStringBound(fmt.Sprintf("%s/%d", path, index), value, maxReferenceBytes)
	}
}

// VerifyExtractionReceiptV1 rejects a constructed or corrupted receipt. It is
// used by the scorer so only the parser's normalized domain reaches scoring.
func VerifyExtractionReceiptV1(receipt ExtractionReceiptV1) ValidationErrors {
	if receipt.SchemaVersion != ExtractionSchemaVersionV1 || receipt.NormalizationVersion != ExtractionNormalizationVersionV1 {
		return ValidationErrors{{Path: "", Code: CodeInvalidSchema, Message: "unsupported extraction receipt version"}}
	}
	// Receipt verification cannot reconstruct the original evidence allowlist;
	// schema validation still proves that all references are stable and unique.
	errs := validateNormalizedExtraction(receipt.Extraction, nil)
	if len(errs) != 0 {
		return errs
	}
	canonical, err := json.Marshal(receipt.Extraction)
	if err != nil || len(canonical) > MaxExtractionBytes || !bytes.Equal(canonical, receipt.CanonicalExtraction) {
		return ValidationErrors{{Path: "/canonical_extraction", Code: CodeReceiptHashMismatch, Message: "canonical extraction does not match receipt extraction"}}
	}
	encoded, err := json.Marshal(extractionReceiptPreimage{
		SchemaVersion:        receipt.SchemaVersion,
		NormalizationVersion: receipt.NormalizationVersion,
		Extraction:           receipt.Extraction,
	})
	if err != nil {
		return ValidationErrors{{Path: "", Code: CodeReceiptHashMismatch, Message: "receipt hash could not be verified"}}
	}
	sum := sha256.Sum256(encoded)
	if !hashPattern.MatchString(receipt.ReceiptHash) || receipt.ReceiptHash != hex.EncodeToString(sum[:]) {
		return ValidationErrors{{Path: "/receipt_hash", Code: CodeReceiptHashMismatch, Message: "receipt hash does not match its canonical preimage"}}
	}
	return nil
}

// VerifyExtractionReceiptV1AgainstEvidence additionally replays the caller's
// evidence allowlist check. Use it when a durable receipt is reloaded alongside
// the frozen scenario evidence manifest; the base receipt hash is deliberately
// not a substitute for that scenario binding.
func VerifyExtractionReceiptV1AgainstEvidence(receipt ExtractionReceiptV1, allowedEvidenceIDs []string) ValidationErrors {
	if errs := VerifyExtractionReceiptV1(receipt); len(errs) != 0 {
		return errs
	}
	allowlist, errs := normalizeEvidenceAllowlist(allowedEvidenceIDs)
	errs = append(errs, validateNormalizedExtraction(receipt.Extraction, allowlist)...)
	return errs
}

type extractionReceiptPreimage struct {
	SchemaVersion        int          `json:"schema_version"`
	NormalizationVersion string       `json:"normalization_version"`
	Extraction           ExtractionV1 `json:"extraction"`
}

func normalizeExtraction(in ExtractionV1) ExtractionV1 {
	out := ExtractionV1{
		SchemaVersion: in.SchemaVersion,
		Summary:       normalizeText(in.Summary),
		PrimaryIntent: ExtractedIntent{
			Kind:        factcontract.IntentKind(strings.ToLower(strings.TrimSpace(string(in.PrimaryIntent.Kind)))),
			Value:       normalizeText(in.PrimaryIntent.Value),
			EvidenceIDs: normalizeReferences(in.PrimaryIntent.EvidenceIDs),
		},
		CoreClaim: ExtractedStatement{
			Value:       normalizeText(in.CoreClaim.Value),
			EvidenceIDs: normalizeReferences(in.CoreClaim.EvidenceIDs),
		},
		PrimaryAction: ExtractedAction{
			ActionID:     factcontract.ActionID(strings.TrimSpace(string(in.PrimaryAction.ActionID))),
			BlockID:      factcontract.BlockID(strings.TrimSpace(string(in.PrimaryAction.BlockID))),
			Role:         factcontract.PrimaryActionRole(strings.ToLower(strings.TrimSpace(string(in.PrimaryAction.Role)))),
			Label:        normalizeText(in.PrimaryAction.Label),
			CanonicalURL: strings.TrimSpace(in.PrimaryAction.CanonicalURL),
			EvidenceIDs:  normalizeReferences(in.PrimaryAction.EvidenceIDs),
		},
		// Carried through by pointer so the three states survive canonicalisation:
		// surfaced, not surfaced, and NOT ANSWERED. Normalisation rebuilds this
		// struct field by field — a field omitted here is silently dropped from
		// the canonical form and from the receipt hash, which is how a new field
		// can be added to the schema, the type and the scorer and still arrive
		// nil at the thing that reads it.
		WouldSurfaceInDigest: in.WouldSurfaceInDigest,
	}
	if in.Facts != nil {
		out.Facts = make([]ExtractedFact, len(in.Facts))
	}
	if in.UnsupportedClaims != nil {
		out.UnsupportedClaims = make([]UnsupportedClaim, len(in.UnsupportedClaims))
	}
	if in.Ambiguities != nil {
		out.Ambiguities = make([]Ambiguity, len(in.Ambiguities))
	}
	if canonical, _, ok := canonicalizeHTTPURL(out.PrimaryAction.CanonicalURL); ok {
		out.PrimaryAction.CanonicalURL = canonical
	}
	for i, fact := range in.Facts {
		out.Facts[i] = ExtractedFact{
			FactID: factcontract.FactID(strings.TrimSpace(string(fact.FactID))),
			Type:   factcontract.FactType(strings.ToLower(strings.TrimSpace(string(fact.Type)))),
			Raw:    normalizeText(fact.Raw), Normalized: normalizeText(fact.Normalized),
			Timezone: strings.TrimSpace(fact.Timezone),
			Currency: strings.ToUpper(strings.TrimSpace(fact.Currency)),
			Unit:     normalizeText(fact.Unit), EvidenceIDs: normalizeReferences(fact.EvidenceIDs),
		}
		if decimal, ok := canonicalDecimal(out.Facts[i].Normalized); ok &&
			(out.Facts[i].Type == factcontract.FactTypeMoney || out.Facts[i].Type == factcontract.FactTypePercentage || out.Facts[i].Type == factcontract.FactTypeQuantity) {
			out.Facts[i].Normalized = decimal
		}
		if out.Facts[i].Type == factcontract.FactTypePercentage {
			switch strings.ToLower(out.Facts[i].Unit) {
			case "", "%", "percent", "percentage":
				out.Facts[i].Unit = "%"
			}
		}
		if out.Facts[i].Type == factcontract.FactTypeDateTime {
			if instant, err := time.Parse(time.RFC3339Nano, out.Facts[i].Normalized); err == nil {
				out.Facts[i].Normalized = instant.Format(time.RFC3339Nano)
			}
		}
		if out.Facts[i].Type == factcontract.FactTypeURL {
			if canonical, _, ok := canonicalizeHTTPURL(out.Facts[i].Normalized); ok {
				out.Facts[i].Normalized = canonical
			}
		}
	}
	for i, claim := range in.UnsupportedClaims {
		out.UnsupportedClaims[i] = UnsupportedClaim{Statement: normalizeText(claim.Statement), EvidenceIDs: normalizeReferences(claim.EvidenceIDs)}
	}
	for i, ambiguity := range in.Ambiguities {
		out.Ambiguities[i] = Ambiguity{Field: strings.TrimSpace(ambiguity.Field), Description: normalizeText(ambiguity.Description), EvidenceIDs: normalizeReferences(ambiguity.EvidenceIDs)}
	}
	sort.Slice(out.Facts, func(i, j int) bool { return out.Facts[i].FactID < out.Facts[j].FactID })
	sort.Slice(out.UnsupportedClaims, func(i, j int) bool {
		if out.UnsupportedClaims[i].Statement != out.UnsupportedClaims[j].Statement {
			return out.UnsupportedClaims[i].Statement < out.UnsupportedClaims[j].Statement
		}
		return strings.Join(out.UnsupportedClaims[i].EvidenceIDs, "\x00") < strings.Join(out.UnsupportedClaims[j].EvidenceIDs, "\x00")
	})
	sort.Slice(out.Ambiguities, func(i, j int) bool {
		if out.Ambiguities[i].Field != out.Ambiguities[j].Field {
			return out.Ambiguities[i].Field < out.Ambiguities[j].Field
		}
		return out.Ambiguities[i].Description < out.Ambiguities[j].Description
	})
	return out
}

func normalizeText(value string) string {
	if !utf8.ValidString(value) {
		return value
	}
	return strings.Join(strings.FieldsFunc(norm.NFKC.String(value), unicode.IsSpace), " ")
}

func normalizeReferences(values []string) []string {
	if values == nil {
		return nil
	}
	out := append([]string(nil), values...)
	for i := range out {
		out[i] = strings.TrimSpace(out[i])
	}
	sort.Strings(out)
	return out
}

func normalizeEvidenceAllowlist(values []string) (map[string]struct{}, ValidationErrors) {
	limit := len(values)
	if limit > maxTotalEvidence {
		limit = maxTotalEvidence
	}
	result := make(map[string]struct{}, limit)
	errs := ValidationErrors{}
	if len(values) > maxTotalEvidence {
		errs.add("/allowed_evidence_ids", CodeLimitExceeded, fmt.Sprintf("at most %d evidence ids are permitted", maxTotalEvidence))
	}
	for index, raw := range values[:limit] {
		value := strings.TrimSpace(raw)
		path := fmt.Sprintf("/allowed_evidence_ids/%d", index)
		if !validReference(value) {
			errs.add(path, CodeInvalidReference, "evidence id must be a stable 1-128 byte ASCII reference")
			continue
		}
		if _, duplicate := result[value]; duplicate {
			errs.add(path, CodeDuplicate, "evidence id is duplicated in the allowlist")
			continue
		}
		result[value] = struct{}{}
	}
	return result, errs
}

func validateNormalizedExtraction(value ExtractionV1, allowlist map[string]struct{}) ValidationErrors {
	errs := ValidationErrors{}
	totalEvidence := len(value.PrimaryIntent.EvidenceIDs) + len(value.CoreClaim.EvidenceIDs) + len(value.PrimaryAction.EvidenceIDs)
	if value.SchemaVersion != ExtractionSchemaVersionV1 {
		errs.add("/schema_version", CodeInvalidSchema, "schema_version must be 1")
	}
	errs.validateText("/summary", value.Summary, maxSummaryRunes, true)
	if _, ok := validIntentKinds[value.PrimaryIntent.Kind]; !ok {
		errs.add("/primary_intent/kind", CodeInvalidEnum, "intent kind is not supported by Extraction v1")
	}
	errs.validateText("/primary_intent/value", value.PrimaryIntent.Value, maxStatementRunes, true)
	errs.validateEvidence("/primary_intent/evidence_ids", value.PrimaryIntent.EvidenceIDs, allowlist)
	errs.validateText("/core_claim/value", value.CoreClaim.Value, maxStatementRunes, true)
	errs.validateEvidence("/core_claim/evidence_ids", value.CoreClaim.EvidenceIDs, allowlist)
	errs.validateReference("/primary_action/action_id", string(value.PrimaryAction.ActionID))
	errs.validateReference("/primary_action/block_id", string(value.PrimaryAction.BlockID))
	if _, ok := validActionRoles[value.PrimaryAction.Role]; !ok {
		errs.add("/primary_action/role", CodeInvalidEnum, "primary action role is not supported by Extraction v1")
	}
	errs.validateText("/primary_action/label", value.PrimaryAction.Label, maxActionLabelRunes, true)
	if value.PrimaryAction.Role == factcontract.PrimaryActionReply {
		if value.PrimaryAction.CanonicalURL != "" {
			errs.add("/primary_action/canonical_url", CodeValueTypeMismatch, "reply action must not declare a URL")
		}
	} else {
		errs.validateCanonicalURL("/primary_action/canonical_url", value.PrimaryAction.CanonicalURL)
	}
	errs.validateEvidence("/primary_action/evidence_ids", value.PrimaryAction.EvidenceIDs, allowlist)

	if value.Facts == nil {
		errs.add("/facts", CodeRequired, "facts must be a JSON array; use [] when empty")
	}
	if len(value.Facts) > maxFacts {
		errs.add("/facts", CodeLimitExceeded, fmt.Sprintf("at most %d facts are permitted", maxFacts))
	}
	seenFacts := make(map[factcontract.FactID]int, len(value.Facts))
	for index, fact := range value.Facts {
		totalEvidence += len(fact.EvidenceIDs)
		base := fmt.Sprintf("/facts/%d", index)
		errs.validateReference(base+"/fact_id", string(fact.FactID))
		if first, duplicate := seenFacts[fact.FactID]; fact.FactID != "" && duplicate {
			errs.add(base+"/fact_id", CodeDuplicate, fmt.Sprintf("fact id duplicates /facts/%d/fact_id", first))
		} else if fact.FactID != "" {
			seenFacts[fact.FactID] = index
		}
		if _, ok := validFactTypes[fact.Type]; !ok {
			errs.add(base+"/type", CodeInvalidEnum, "fact type is not supported by Extraction v1")
		}
		errs.validateText(base+"/raw", fact.Raw, maxFactValueRunes, true)
		errs.validateText(base+"/normalized", fact.Normalized, maxFactValueRunes, true)
		errs.validateFactValue(base, fact)
		errs.validateEvidence(base+"/evidence_ids", fact.EvidenceIDs, allowlist)
	}

	if value.UnsupportedClaims == nil {
		errs.add("/unsupported_claims", CodeRequired, "unsupported_claims must be a JSON array; use [] when empty")
	}
	if len(value.UnsupportedClaims) > maxUnsupportedClaims {
		errs.add("/unsupported_claims", CodeLimitExceeded, fmt.Sprintf("at most %d unsupported claims are permitted", maxUnsupportedClaims))
	}
	seenClaims := map[string]int{}
	for index, claim := range value.UnsupportedClaims {
		totalEvidence += len(claim.EvidenceIDs)
		base := fmt.Sprintf("/unsupported_claims/%d", index)
		errs.validateText(base+"/statement", claim.Statement, maxStatementRunes, true)
		key := comparisonKey(claim.Statement)
		if first, duplicate := seenClaims[key]; key != "" && duplicate {
			errs.add(base+"/statement", CodeDuplicate, fmt.Sprintf("claim duplicates /unsupported_claims/%d/statement", first))
		} else if key != "" {
			seenClaims[key] = index
		}
		errs.validateEvidence(base+"/evidence_ids", claim.EvidenceIDs, allowlist)
	}

	if value.Ambiguities == nil {
		errs.add("/ambiguities", CodeRequired, "ambiguities must be a JSON array; use [] when empty")
	}
	if len(value.Ambiguities) > maxAmbiguities {
		errs.add("/ambiguities", CodeLimitExceeded, fmt.Sprintf("at most %d ambiguities are permitted", maxAmbiguities))
	}
	seenAmbiguities := map[string]int{}
	for index, ambiguity := range value.Ambiguities {
		totalEvidence += len(ambiguity.EvidenceIDs)
		base := fmt.Sprintf("/ambiguities/%d", index)
		errs.validateReference(base+"/field", ambiguity.Field)
		errs.validateText(base+"/description", ambiguity.Description, maxDescriptionRunes, true)
		key := ambiguity.Field + "\x00" + comparisonKey(ambiguity.Description)
		if first, duplicate := seenAmbiguities[key]; duplicate {
			errs.add(base, CodeDuplicate, fmt.Sprintf("ambiguity duplicates /ambiguities/%d", first))
		} else {
			seenAmbiguities[key] = index
		}
		errs.validateEvidence(base+"/evidence_ids", ambiguity.EvidenceIDs, allowlist)
	}
	if totalEvidence > maxTotalEvidence {
		errs.add("/", CodeLimitExceeded, fmt.Sprintf("at most %d total evidence references are permitted", maxTotalEvidence))
	}
	return errs
}

func (e *ValidationErrors) validateFactValue(path string, fact ExtractedFact) {
	emptyCompanions := func(allowTimezone, allowCurrency, allowUnit bool) {
		if !allowTimezone && fact.Timezone != "" {
			e.add(path+"/timezone", CodeValueTypeMismatch, "timezone is not valid for this fact type")
		}
		if !allowCurrency && fact.Currency != "" {
			e.add(path+"/currency", CodeValueTypeMismatch, "currency is not valid for this fact type")
		}
		if !allowUnit && fact.Unit != "" {
			e.add(path+"/unit", CodeValueTypeMismatch, "unit is not valid for this fact type")
		}
	}
	switch fact.Type {
	case factcontract.FactTypeText, factcontract.FactTypeLocation, factcontract.FactTypeCode:
		emptyCompanions(false, false, false)
	case factcontract.FactTypeDateTime:
		emptyCompanions(true, false, false)
		instant, err := time.Parse(time.RFC3339Nano, fact.Normalized)
		if err != nil {
			e.add(path+"/normalized", CodeInvalidDateTime, "datetime must be RFC3339 with an explicit numeric offset")
		}
		if fact.Timezone == "" || len(fact.Timezone) > 255 || fact.Timezone == "Local" {
			e.add(path+"/timezone", CodeTimezoneUnknown, "datetime requires an environment-independent IANA timezone")
			break
		}
		location, zoneErr := time.LoadLocation(fact.Timezone)
		if zoneErr != nil {
			e.add(path+"/timezone", CodeTimezoneUnknown, "timezone is not a recognized IANA zone")
		} else if err == nil {
			_, encodedOffset := instant.Zone()
			_, zoneOffset := instant.In(location).Zone()
			if encodedOffset != zoneOffset {
				e.add(path+"/normalized", CodeTimezoneOffset, "timestamp offset does not match timezone at that instant")
			}
		}
	case factcontract.FactTypeMoney:
		emptyCompanions(false, true, false)
		e.validateDecimal(path+"/normalized", fact.Normalized, false, false)
		unit, err := currency.ParseISO(fact.Currency)
		if fact.Currency == "" || err != nil || unit.String() != fact.Currency || fact.Currency == "XXX" || fact.Currency == "XTS" {
			e.add(path+"/currency", CodeInvalidCurrency, "currency must be a canonical uppercase ISO 4217 designator")
		}
	case factcontract.FactTypePercentage:
		emptyCompanions(false, false, true)
		if e.validateDecimal(path+"/normalized", fact.Normalized, false, true) && fact.Unit != "%" {
			e.add(path+"/unit", CodeValueTypeMismatch, "percentage unit must normalize to %")
		}
	case factcontract.FactTypeQuantity:
		emptyCompanions(false, false, true)
		e.validateDecimal(path+"/normalized", fact.Normalized, true, false)
		e.validateText(path+"/unit", fact.Unit, 64, true)
	case factcontract.FactTypeURL:
		emptyCompanions(false, false, false)
		e.validateCanonicalURL(path+"/normalized", fact.Normalized)
	}
}

func (e *ValidationErrors) validateDecimal(path, value string, nonnegative, percentage bool) bool {
	canonical, ok := canonicalDecimal(value)
	if !ok || canonical != value {
		e.add(path, CodeInvalidDecimal, "value must normalize to a base-10 decimal without exponent notation")
		return false
	}
	raw := strings.TrimPrefix(value, "-")
	parts := strings.SplitN(raw, ".", 2)
	digits, scale := len(parts[0]), 0
	if len(parts) == 2 {
		digits += len(parts[1])
		scale = len(parts[1])
	}
	if digits > maxDecimalDigits || scale > maxDecimalScale {
		e.add(path, CodeDecimalLimit, fmt.Sprintf("decimal permits at most %d digits and %d fractional digits", maxDecimalDigits, maxDecimalScale))
		return false
	}
	number, _ := new(big.Rat).SetString(value)
	if nonnegative && number.Sign() < 0 {
		e.add(path, CodeNumberOutOfRange, "quantity must be zero or greater")
	}
	if percentage && (number.Sign() < 0 || number.Cmp(big.NewRat(100, 1)) > 0) {
		e.add(path, CodeNumberOutOfRange, "percentage must be between 0 and 100 inclusive")
	}
	return true
}

func (e *ValidationErrors) validateCanonicalURL(path, value string) {
	canonical, code, ok := canonicalizeHTTPURL(value)
	if !ok {
		e.add(path, code, urlErrorMessage(code))
		return
	}
	if canonical != value {
		e.add(path, CodeInvalidURL, "URL must be in canonical tracking-stripped form")
	}
}

func (e *ValidationErrors) validateEvidence(path string, values []string, allowlist map[string]struct{}) {
	if len(values) == 0 {
		e.add(path, CodeRequired, "at least one evidence id is required")
		return
	}
	if len(values) > maxEvidencePerItem {
		e.add(path, CodeLimitExceeded, fmt.Sprintf("at most %d evidence ids are permitted", maxEvidencePerItem))
	}
	seen := make(map[string]int, len(values))
	for index, value := range values {
		itemPath := fmt.Sprintf("%s/%d", path, index)
		e.validateReference(itemPath, value)
		if first, duplicate := seen[value]; value != "" && duplicate {
			e.add(itemPath, CodeDuplicate, fmt.Sprintf("evidence id duplicates %s/%d", path, first))
		} else if value != "" {
			seen[value] = index
		}
		if allowlist != nil {
			if _, allowed := allowlist[value]; !allowed {
				e.add(itemPath, CodeEvidenceNotAllowed, "evidence id is outside the caller-provided allowlist")
			}
		}
	}
}

func (e *ValidationErrors) validateReference(path, value string) {
	if !validReference(value) {
		e.add(path, CodeInvalidReference, "stable reference must be 1-128 ASCII letters, digits, dot, underscore, colon, or hyphen")
	}
}

func validReference(value string) bool {
	return len(value) <= maxReferenceBytes && stableReferencePattern.MatchString(value)
}

func (e *ValidationErrors) validateText(path, value string, limit int, required bool) {
	if value == "" {
		if required {
			e.add(path, CodeRequired, "value is required")
		}
		return
	}
	if !utf8.ValidString(value) {
		e.add(path, CodeInvalidText, "value must be valid UTF-8")
		return
	}
	if utf8.RuneCountInString(value) > limit {
		e.add(path, CodeTextTooLong, fmt.Sprintf("value must contain at most %d Unicode characters", limit))
	}
	for _, current := range value {
		if unicode.IsControl(current) || current == unicode.ReplacementChar {
			e.add(path, CodeInvalidText, "value must not contain control or replacement characters")
			break
		}
	}
}

func canonicalDecimal(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.HasPrefix(raw, "+") || strings.ContainsAny(raw, "eE") {
		return "", false
	}
	negative := strings.HasPrefix(raw, "-")
	if negative {
		raw = raw[1:]
	}
	parts := strings.Split(raw, ".")
	if len(parts) > 2 || parts[0] == "" || !asciiDigits(parts[0]) || (len(parts) == 2 && (parts[1] == "" || !asciiDigits(parts[1]))) {
		return "", false
	}
	integer := strings.TrimLeft(parts[0], "0")
	if integer == "" {
		integer = "0"
	}
	fraction := ""
	if len(parts) == 2 {
		fraction = strings.TrimRight(parts[1], "0")
	}
	result := integer
	if fraction != "" {
		result += "." + fraction
	}
	if negative && result != "0" {
		result = "-" + result
	}
	return result, true
}

func asciiDigits(value string) bool {
	for index := range len(value) {
		if value[index] < '0' || value[index] > '9' {
			return false
		}
	}
	return true
}

func canonicalizeHTTPURL(value string) (string, ValidationCode, bool) {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > maxURLBytes || !utf8.ValidString(value) {
		return "", CodeInvalidURL, false
	}
	for _, current := range value {
		if unicode.IsControl(current) || current == unicode.ReplacementChar {
			return "", CodeInvalidURL, false
		}
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed == nil {
		return "", CodeInvalidURL, false
	}
	scheme := strings.ToLower(parsed.Scheme)
	if parsed.Opaque != "" || (scheme != "http" && scheme != "https") || parsed.Hostname() == "" {
		return "", CodeInvalidURL, false
	}
	if parsed.User != nil {
		return "", CodeURLCredentials, false
	}
	if parsed.Fragment != "" {
		return "", CodeURLFragment, false
	}
	if invalidStringToken(parsed.Path) {
		return "", CodeInvalidURL, false
	}
	parsed.Scheme = scheme
	hostname := strings.ToLower(parsed.Hostname())
	port := parsed.Port()
	if (parsed.Scheme == "https" && port == "443") || (parsed.Scheme == "http" && port == "80") {
		port = ""
	}
	if strings.Contains(hostname, ":") {
		hostname = "[" + hostname + "]"
	}
	parsed.Host = hostname
	if port != "" {
		parsed.Host = net.JoinHostPort(strings.Trim(hostname, "[]"), port)
	}
	query, queryErr := url.ParseQuery(parsed.RawQuery)
	if queryErr != nil {
		return "", CodeInvalidURL, false
	}
	for key := range query {
		if invalidStringToken(key) {
			return "", CodeInvalidURL, false
		}
		for _, item := range query[key] {
			if invalidStringToken(item) {
				return "", CodeInvalidURL, false
			}
		}
		lower := strings.ToLower(key)
		if strings.HasPrefix(lower, "utm_") {
			query.Del(key)
			continue
		}
		if _, tracking := trackingQueryKeys[lower]; tracking {
			query.Del(key)
		}
	}
	parsed.RawQuery = query.Encode()
	parsed.ForceQuery = false
	return parsed.String(), "", true
}

func urlErrorMessage(code ValidationCode) string {
	switch code {
	case CodeURLCredentials:
		return "URL must not contain user credentials"
	case CodeURLFragment:
		return "canonical URL must not contain a fragment"
	default:
		return "URL must be an absolute canonical http or https URL with a host"
	}
}

type duplicateKeyError struct {
	path    string
	code    ValidationCode
	message string
}

func rejectDuplicateKeys(raw []byte) *duplicateKeyError {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := scanJSONValue(decoder, "", 0); err != nil {
		return err
	}
	if token, err := decoder.Token(); err != io.EOF {
		if err == nil {
			_ = token
		}
		return &duplicateKeyError{path: "", code: CodeTrailingJSON, message: "exactly one JSON object is required"}
	}
	return nil
}

func scanJSONValue(decoder *json.Decoder, path string, depth int) *duplicateKeyError {
	if depth > 64 {
		return &duplicateKeyError{path: path, code: CodeLimitExceeded, message: "JSON nesting must not exceed 64 levels"}
	}
	token, err := decoder.Token()
	if err != nil {
		return &duplicateKeyError{path: path, code: CodeInvalidJSON, message: "extraction must be valid JSON"}
	}
	delim, composite := token.(json.Delim)
	if !composite {
		if value, ok := token.(string); ok && invalidStringToken(value) {
			return &duplicateKeyError{path: path, code: CodeInvalidText, message: "JSON strings must not contain control or replacement characters"}
		}
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return &duplicateKeyError{path: path, code: CodeInvalidJSON, message: "extraction must be valid JSON"}
			}
			key, ok := keyToken.(string)
			if !ok {
				return &duplicateKeyError{path: path, code: CodeInvalidJSON, message: "JSON object key must be a string"}
			}
			if invalidStringToken(key) {
				return &duplicateKeyError{path: path, code: CodeInvalidText, message: "JSON object keys must not contain control or replacement characters"}
			}
			keyPath := path + "/" + escapeJSONPointer(key)
			if _, duplicate := seen[key]; duplicate {
				return &duplicateKeyError{path: keyPath, code: CodeDuplicateKey, message: "duplicate JSON object key is not permitted"}
			}
			seen[key] = struct{}{}
			if nested := scanJSONValue(decoder, keyPath, depth+1); nested != nil {
				return nested
			}
		}
		if closeToken, err := decoder.Token(); err != nil || closeToken != json.Delim('}') {
			return &duplicateKeyError{path: path, code: CodeInvalidJSON, message: "extraction must be valid JSON"}
		}
	case '[':
		index := 0
		for decoder.More() {
			if nested := scanJSONValue(decoder, fmt.Sprintf("%s/%d", path, index), depth+1); nested != nil {
				return nested
			}
			index++
		}
		if closeToken, err := decoder.Token(); err != nil || closeToken != json.Delim(']') {
			return &duplicateKeyError{path: path, code: CodeInvalidJSON, message: "extraction must be valid JSON"}
		}
	default:
		return &duplicateKeyError{path: path, code: CodeInvalidJSON, message: "extraction must be valid JSON"}
	}
	return nil
}

func invalidStringToken(value string) bool {
	if !utf8.ValidString(value) {
		return true
	}
	for _, current := range value {
		if unicode.IsControl(current) || current == unicode.ReplacementChar {
			return true
		}
	}
	return false
}

func escapeJSONPointer(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "~", "~0"), "/", "~1")
}

func publicJSONError(err error, code ValidationCode) string {
	if code == CodeUnknownField {
		return "extraction contains a field outside the closed v1 schema"
	}
	return "extraction must be one valid JSON object"
}

func comparisonKey(value string) string {
	value = strings.ToLower(normalizeText(value))
	var builder strings.Builder
	space := false
	for _, current := range value {
		if unicode.IsLetter(current) || unicode.IsNumber(current) {
			if space && builder.Len() != 0 {
				builder.WriteByte(' ')
			}
			space = false
			builder.WriteRune(current)
		} else {
			space = true
		}
	}
	return strings.TrimSpace(builder.String())
}
