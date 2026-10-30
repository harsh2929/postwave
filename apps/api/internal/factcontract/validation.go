// SPDX-License-Identifier: AGPL-3.0-only

package factcontract

import (
	"fmt"
	"math/big"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/currency"
	"golang.org/x/text/language"
)

// ValidationCode is a stable machine-readable failure code. Paths carry field
// specificity, so callers can localize messages without parsing English text.
type ValidationCode string

const (
	CodeRequired                 ValidationCode = "required"
	CodeUnsupportedSchemaVersion ValidationCode = "schema_version_unsupported"
	CodeInvalidEnum              ValidationCode = "invalid_enum"
	CodeInvalidLanguage          ValidationCode = "invalid_language"
	CodeInvalidStableReference   ValidationCode = "invalid_stable_reference"
	CodeDuplicate                ValidationCode = "duplicate"
	CodeLimitExceeded            ValidationCode = "limit_exceeded"
	CodeTextTooLong              ValidationCode = "text_too_long"
	CodeInvalidText              ValidationCode = "invalid_text"
	CodeInvalidURL               ValidationCode = "invalid_url"
	CodeURLCredentialsForbidden  ValidationCode = "url_credentials_forbidden"
	CodeURLFragmentForbidden     ValidationCode = "url_fragment_forbidden"
	CodeActionURLRequired        ValidationCode = "action_url_required"
	CodeActionURLForbidden       ValidationCode = "action_url_forbidden"
	CodeFactValueCardinality     ValidationCode = "fact_value_cardinality"
	CodeFactValueTypeMismatch    ValidationCode = "fact_value_type_mismatch"
	CodeInvalidDateTime          ValidationCode = "datetime_invalid_rfc3339"
	CodeTimezoneUnknown          ValidationCode = "timezone_unknown"
	CodeTimezoneOffsetMismatch   ValidationCode = "timezone_offset_mismatch"
	CodeInvalidDecimal           ValidationCode = "decimal_invalid"
	CodeDecimalPrecisionExceeded ValidationCode = "decimal_precision_exceeded"
	CodeNumberOutOfRange         ValidationCode = "number_out_of_range"
	CodeUnitRequired             ValidationCode = "unit_required"
	CodeInvalidUnit              ValidationCode = "invalid_unit"
	CodeInvalidCurrency          ValidationCode = "currency_invalid_iso4217"
)

const (
	maxIntentRunes          = 1000
	maxAudienceRunes        = 1000
	maxClaimRunes           = 2000
	maxActionLabelRunes     = 256
	maxDisplayValueRunes    = 1000
	maxFactTextRunes        = 2000
	maxUnitRunes            = 64
	maxURLBytes             = 4096
	maxLanguageTagBytes     = 255
	maxTimezoneBytes        = 255
	maxReferenceBytes       = 128
	maxRequiredFacts        = 128
	maxForbiddenClaims      = 64
	maxSourceBlockIDs       = 64
	maxSecondaryActionRoles = 16
	maxDecimalDigits        = 38
	maxDecimalScale         = 9
)

var stableReferencePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var languageTagSyntax = regexp.MustCompile(`^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$`)

var validIntentKinds = map[IntentKind]struct{}{
	IntentInform: {}, IntentInvite: {}, IntentPromote: {}, IntentRequestAction: {},
	IntentRemind: {}, IntentSurvey: {}, IntentTransact: {}, IntentOnboard: {},
	IntentRetain: {}, IntentOther: {},
}

var validPrimaryActionRoles = map[PrimaryActionRole]struct{}{
	PrimaryActionNavigate: {}, PrimaryActionRegister: {}, PrimaryActionPurchase: {},
	PrimaryActionRSVP: {}, PrimaryActionConfirm: {}, PrimaryActionDownload: {},
	PrimaryActionSurvey: {}, PrimaryActionReply: {}, PrimaryActionTrack: {},
}

var validSecondaryActionRoles = map[SecondaryActionRole]struct{}{
	SecondaryActionUnsubscribe: {}, SecondaryActionPreferences: {},
	SecondaryActionViewInBrowser: {}, SecondaryActionSocial: {}, SecondaryActionLegal: {},
	SecondaryActionShare: {}, SecondaryActionContact: {}, SecondaryActionReply: {},
}

var validCriticalities = map[Criticality]struct{}{
	CriticalityCritical: {}, CriticalityImportant: {}, CriticalitySupporting: {},
}

var validFactTypes = map[FactType]struct{}{
	FactTypeText: {}, FactTypeDateTime: {}, FactTypeMoney: {}, FactTypeLocation: {},
	FactTypeCode: {}, FactTypePercentage: {}, FactTypeQuantity: {}, FactTypeURL: {},
}

// ValidationError identifies one deterministic contract violation using an
// RFC 6901 JSON Pointer. Message is safe for operator-facing responses.
type ValidationError struct {
	Path    string         `json:"path"`
	Code    ValidationCode `json:"code"`
	Message string         `json:"message"`
}

// ValidationErrors aggregates every bounded validation failure in stable
// document order so one authoring response can annotate all affected fields.
type ValidationErrors []ValidationError

func (v ValidationErrors) Error() string {
	parts := make([]string, 0, len(v))
	for _, item := range v {
		parts = append(parts, fmt.Sprintf("%s [%s]: %s", item.Path, item.Code, item.Message))
	}
	return strings.Join(parts, "; ")
}

// HasErrors reports whether validation failed.
func (v ValidationErrors) HasErrors() bool { return len(v) != 0 }

// HasCode reports whether any failure has code.
func (v ValidationErrors) HasCode(code ValidationCode) bool {
	for _, item := range v {
		if item.Code == code {
			return true
		}
	}
	return false
}

func validateNormalizedV1(contract ContractV1) ValidationErrors {
	errs := ValidationErrors{}
	if contract.SchemaVersion != SchemaVersionV1 {
		errs.add("/schema_version", CodeUnsupportedSchemaVersion, "schema_version must be 1")
	}

	if _, ok := validIntentKinds[contract.PrimaryIntent.Kind]; !ok {
		errs.add("/primary_intent/kind", CodeInvalidEnum, "kind is not supported by Fact Contract v1")
	}
	errs.validateRequiredText("/primary_intent/statement", contract.PrimaryIntent.Statement, maxIntentRunes)
	errs.validateRequiredText("/audience_context/description", contract.AudienceContext.Description, maxAudienceRunes)
	if contract.AudienceContext.TargetingReference != "" {
		errs.validateReference("/audience_context/targeting_reference", contract.AudienceContext.TargetingReference)
	}

	errs.validateRequiredText("/core_claim/statement", contract.CoreClaim.Statement, maxClaimRunes)
	errs.validateBlockIDs("/core_claim/source_block_ids", contract.CoreClaim.SourceBlockIDs, false)
	errs.validatePrimaryAction(contract.PrimaryAction)
	errs.validateRequiredFacts(contract.RequiredFacts)
	errs.validateForbiddenClaims(contract.ForbiddenClaims)
	errs.validateSecondaryActions(contract.AllowedSecondaryActions)
	errs.validateLanguage(contract.Language)
	return errs
}

func (v *ValidationErrors) validatePrimaryAction(action PrimaryAction) {
	v.validateReference("/primary_action/action_id", string(action.ActionID))
	v.validateReference("/primary_action/block_id", string(action.BlockID))
	if _, ok := validPrimaryActionRoles[action.Role]; !ok {
		v.add("/primary_action/role", CodeInvalidEnum, "role is not supported by Fact Contract v1")
	}
	v.validateRequiredText("/primary_action/label", action.Label, maxActionLabelRunes)
	if action.Role == PrimaryActionReply {
		if action.CanonicalURL != "" {
			v.add("/primary_action/canonical_url", CodeActionURLForbidden, "reply actions must not declare a canonical URL")
		}
		return
	}
	if action.CanonicalURL == "" {
		v.add("/primary_action/canonical_url", CodeActionURLRequired, "link-backed primary actions require a canonical URL")
		return
	}
	v.validateHTTPURL("/primary_action/canonical_url", action.CanonicalURL)
}

func (v *ValidationErrors) validateRequiredFacts(facts []RequiredFact) {
	if len(facts) > maxRequiredFacts {
		v.add("/required_facts", CodeLimitExceeded, fmt.Sprintf("at most %d required facts are permitted", maxRequiredFacts))
	}
	seenIDs := make(map[FactID]int, len(facts))
	for i, fact := range facts {
		base := fmt.Sprintf("/required_facts/%d", i)
		v.validateReference(base+"/id", string(fact.ID))
		if first, exists := seenIDs[fact.ID]; fact.ID != "" && exists {
			v.add(base+"/id", CodeDuplicate, fmt.Sprintf("fact id duplicates /required_facts/%d/id", first))
		} else if fact.ID != "" {
			seenIDs[fact.ID] = i
		}
		_, typeValid := validFactTypes[fact.Type]
		if !typeValid {
			v.add(base+"/type", CodeInvalidEnum, "type is not supported by Fact Contract v1")
		}
		v.validateRequiredText(base+"/display_value", fact.DisplayValue, maxDisplayValueRunes)
		if _, ok := validCriticalities[fact.Criticality]; !ok {
			v.add(base+"/criticality", CodeInvalidEnum, "criticality is not supported by Fact Contract v1")
		}
		v.validateBlockIDs(base+"/source_block_ids", fact.SourceBlockIDs, true)
		v.validateFactValue(base, fact, typeValid)
	}
}

func (v *ValidationErrors) validateFactValue(base string, fact RequiredFact, typeValid bool) {
	provided := 0
	if fact.TextValue != nil {
		provided++
	}
	if fact.DateTimeValue != nil {
		provided++
	}
	if fact.MoneyValue != nil {
		provided++
	}
	if fact.NumberValue != nil {
		provided++
	}
	if fact.URLValue != nil {
		provided++
	}
	if provided != 1 {
		v.add(base+"/value", CodeFactValueCardinality, "exactly one typed fact value must be present")
	}
	if !typeValid {
		return
	}

	var expectedPresent bool
	switch fact.Type {
	case FactTypeText, FactTypeLocation, FactTypeCode:
		expectedPresent = fact.TextValue != nil
		if fact.TextValue != nil {
			v.validateRequiredText(base+"/text_value", *fact.TextValue, maxFactTextRunes)
		}
	case FactTypeDateTime:
		expectedPresent = fact.DateTimeValue != nil
		if fact.DateTimeValue != nil {
			v.validateDateTime(base+"/datetime_value", *fact.DateTimeValue)
		}
	case FactTypeMoney:
		expectedPresent = fact.MoneyValue != nil
		if fact.MoneyValue != nil {
			v.validateMoney(base+"/money_value", *fact.MoneyValue)
		}
	case FactTypePercentage, FactTypeQuantity:
		expectedPresent = fact.NumberValue != nil
		if fact.NumberValue != nil {
			v.validateNumber(base+"/number_value", fact.Type, *fact.NumberValue)
		}
	case FactTypeURL:
		expectedPresent = fact.URLValue != nil
		if fact.URLValue != nil {
			v.validateHTTPURL(base+"/url_value", *fact.URLValue)
		}
	}
	if provided == 1 && !expectedPresent {
		v.add(base+"/value", CodeFactValueTypeMismatch, "typed value does not match fact type")
	}
}

func (v *ValidationErrors) validateDateTime(path string, value DateTimeValue) {
	if value.RFC3339 == "" {
		v.add(path+"/rfc3339", CodeRequired, "rfc3339 is required")
	}
	parsed, parseErr := time.Parse(time.RFC3339Nano, value.RFC3339)
	if value.RFC3339 != "" && parseErr != nil {
		v.add(path+"/rfc3339", CodeInvalidDateTime, "rfc3339 must be a timestamp with an explicit numeric offset")
	}
	if value.Timezone == "" {
		v.add(path+"/timezone", CodeRequired, "timezone is required")
		return
	}
	if value.Timezone == "Local" {
		v.add(path+"/timezone", CodeTimezoneUnknown, "timezone must be an environment-independent IANA zone")
		return
	}
	if len(value.Timezone) > maxTimezoneBytes {
		v.add(path+"/timezone", CodeTimezoneUnknown, "timezone is not a recognized IANA zone")
		return
	}
	location, locationErr := time.LoadLocation(value.Timezone)
	if locationErr != nil {
		v.add(path+"/timezone", CodeTimezoneUnknown, "timezone is not a recognized IANA zone")
		return
	}
	if parseErr == nil {
		_, encodedOffset := parsed.Zone()
		_, zoneOffset := parsed.In(location).Zone()
		if encodedOffset != zoneOffset {
			v.add(path+"/rfc3339", CodeTimezoneOffsetMismatch, "timestamp offset does not match timezone at that instant")
		}
	}
}

func (v *ValidationErrors) validateMoney(path string, value MoneyValue) {
	v.validateDecimal(path+"/amount", value.Amount)
	code := string(value.Currency)
	if code == "" {
		v.add(path+"/currency", CodeRequired, "currency is required")
		return
	}
	unit, err := currency.ParseISO(code)
	if err != nil || unit.String() != code || code == "XXX" || code == "XTS" {
		v.add(path+"/currency", CodeInvalidCurrency, "currency must be a canonical uppercase ISO 4217 designator")
	}
}

func (v *ValidationErrors) validateNumber(path string, factType FactType, value NumberValue) {
	valid := v.validateDecimal(path+"/value", value.Value)
	if factType == FactTypePercentage {
		if value.Unit != "%" {
			v.add(path+"/unit", CodeInvalidUnit, "percentage unit must normalize to %")
		}
		if valid {
			number, _ := new(big.Rat).SetString(value.Value)
			if number.Sign() < 0 || number.Cmp(big.NewRat(100, 1)) > 0 {
				v.add(path+"/value", CodeNumberOutOfRange, "percentage must be between 0 and 100 inclusive")
			}
		}
		return
	}
	if value.Unit == "" {
		v.add(path+"/unit", CodeUnitRequired, "quantity unit is required")
	} else {
		v.validateText(path+"/unit", value.Unit, maxUnitRunes)
	}
	if valid {
		number, _ := new(big.Rat).SetString(value.Value)
		if number.Sign() < 0 {
			v.add(path+"/value", CodeNumberOutOfRange, "quantity must be zero or greater")
		}
	}
}

func (v *ValidationErrors) validateDecimal(path, value string) bool {
	if value == "" {
		v.add(path, CodeRequired, "decimal value is required")
		return false
	}
	canonical, ok := normalizeDecimal(value)
	if !ok || canonical != value {
		v.add(path, CodeInvalidDecimal, "value must be a canonical base-10 decimal without exponent notation")
		return false
	}
	raw := strings.TrimPrefix(value, "-")
	parts := strings.SplitN(raw, ".", 2)
	digits := len(parts[0])
	scale := 0
	if len(parts) == 2 {
		digits += len(parts[1])
		scale = len(parts[1])
	}
	if digits > maxDecimalDigits || scale > maxDecimalScale {
		v.add(path, CodeDecimalPrecisionExceeded, fmt.Sprintf("decimal permits at most %d digits and %d fractional digits", maxDecimalDigits, maxDecimalScale))
		return false
	}
	return true
}

func (v *ValidationErrors) validateForbiddenClaims(claims []ForbiddenClaim) {
	if len(claims) > maxForbiddenClaims {
		v.add("/forbidden_claims", CodeLimitExceeded, fmt.Sprintf("at most %d forbidden claims are permitted", maxForbiddenClaims))
	}
	seen := make(map[ForbiddenClaimID]int, len(claims))
	for i, claim := range claims {
		base := fmt.Sprintf("/forbidden_claims/%d", i)
		v.validateReference(base+"/id", string(claim.ID))
		if first, exists := seen[claim.ID]; claim.ID != "" && exists {
			v.add(base+"/id", CodeDuplicate, fmt.Sprintf("claim id duplicates /forbidden_claims/%d/id", first))
		} else if claim.ID != "" {
			seen[claim.ID] = i
		}
		v.validateRequiredText(base+"/statement", claim.Statement, maxClaimRunes)
	}
}

func (v *ValidationErrors) validateSecondaryActions(roles []SecondaryActionRole) {
	if len(roles) > maxSecondaryActionRoles {
		v.add("/allowed_secondary_actions", CodeLimitExceeded, fmt.Sprintf("at most %d secondary action roles are permitted", maxSecondaryActionRoles))
	}
	seen := make(map[SecondaryActionRole]int, len(roles))
	for i, role := range roles {
		path := fmt.Sprintf("/allowed_secondary_actions/%d", i)
		if _, ok := validSecondaryActionRoles[role]; !ok {
			v.add(path, CodeInvalidEnum, "secondary action role is not supported by Fact Contract v1")
		}
		if first, exists := seen[role]; role != "" && exists {
			v.add(path, CodeDuplicate, fmt.Sprintf("role duplicates /allowed_secondary_actions/%d", first))
		} else if role != "" {
			seen[role] = i
		}
	}
}

func (v *ValidationErrors) validateLanguage(tag LanguageTag) {
	path := "/language"
	if tag == "" {
		v.add(path, CodeRequired, "language is required")
		return
	}
	parsed, err := language.Parse(string(tag))
	if len(tag) > maxLanguageTagBytes || !languageTagSyntax.MatchString(string(tag)) || err != nil || languageBaseIsUnd(parsed) || parsed.String() != string(tag) {
		v.add(path, CodeInvalidLanguage, "language must be a canonical, specific BCP 47 tag")
	}
}

func languageBaseIsUnd(tag language.Tag) bool {
	base, _, _ := tag.Raw()
	return base.String() == "und"
}

func (v *ValidationErrors) validateBlockIDs(path string, ids []BlockID, required bool) {
	if required && len(ids) == 0 {
		v.add(path, CodeRequired, "at least one source block id is required")
		return
	}
	if len(ids) > maxSourceBlockIDs {
		v.add(path, CodeLimitExceeded, fmt.Sprintf("at most %d source block ids are permitted", maxSourceBlockIDs))
	}
	seen := make(map[BlockID]int, len(ids))
	for i, id := range ids {
		itemPath := fmt.Sprintf("%s/%d", path, i)
		v.validateReference(itemPath, string(id))
		if first, exists := seen[id]; id != "" && exists {
			v.add(itemPath, CodeDuplicate, fmt.Sprintf("block id duplicates %s/%d", path, first))
		} else if id != "" {
			seen[id] = i
		}
	}
}

func (v *ValidationErrors) validateReference(path, value string) {
	if value == "" {
		v.add(path, CodeRequired, "stable reference is required")
		return
	}
	if len(value) > maxReferenceBytes || !stableReferencePattern.MatchString(value) {
		v.add(path, CodeInvalidStableReference, "stable reference must be 1-128 ASCII letters, digits, dot, underscore, colon, or hyphen")
	}
}

func (v *ValidationErrors) validateRequiredText(path, value string, maxRunes int) {
	if value == "" {
		v.add(path, CodeRequired, "value is required")
		return
	}
	v.validateText(path, value, maxRunes)
}

func (v *ValidationErrors) validateText(path, value string, maxRunes int) {
	if !utf8.ValidString(value) {
		v.add(path, CodeInvalidText, "value must be valid UTF-8")
		return
	}
	if utf8.RuneCountInString(value) > maxRunes {
		v.add(path, CodeTextTooLong, fmt.Sprintf("value must contain at most %d Unicode characters", maxRunes))
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			v.add(path, CodeInvalidText, "value must not contain control characters")
			return
		}
	}
}

func (v *ValidationErrors) validateHTTPURL(path, value string) {
	if value == "" {
		v.add(path, CodeRequired, "URL is required")
		return
	}
	if !utf8.ValidString(value) || len(value) > maxURLBytes {
		v.add(path, CodeInvalidURL, "URL must be valid UTF-8 and at most 4096 bytes")
		return
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			v.add(path, CodeInvalidURL, "URL must not contain control characters")
			return
		}
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Opaque != "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Hostname() == "" {
		v.add(path, CodeInvalidURL, "URL must be an absolute http or https URL with a host")
		return
	}
	if parsed.User != nil {
		v.add(path, CodeURLCredentialsForbidden, "URL must not contain user credentials")
	}
	if parsed.Fragment != "" {
		v.add(path, CodeURLFragmentForbidden, "canonical URL must not contain a fragment")
	}
}

func (v *ValidationErrors) add(path string, code ValidationCode, message string) {
	*v = append(*v, ValidationError{Path: path, Code: code, Message: message})
}
