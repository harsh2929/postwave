// SPDX-License-Identifier: AGPL-3.0-only

package factcontract

import (
	"net/url"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

// NormalizeAndValidateV1 is the canonical entry point for untrusted authoring
// input. Callers must persist or freeze the returned contract, not input. The
// returned errors are ordered deterministically by document field and array
// position.
func NormalizeAndValidateV1(input ContractV1) (ContractV1, ValidationErrors) {
	normalized := NormalizeV1(input)
	return normalized, validateNormalizedV1(normalized)
}

// ValidateV1 reports whether input can become a valid v1 contract after the
// documented semantic normalizations. Use NormalizeAndValidateV1 when the
// normalized value will be stored or hashed.
func ValidateV1(input ContractV1) ValidationErrors {
	_, errs := NormalizeAndValidateV1(input)
	return errs
}

// NormalizeV1 returns a deep, canonically normalized copy of input. It never
// drops an element or repairs semantically invalid input; validation remains a
// separate, explicit decision.
func NormalizeV1(input ContractV1) ContractV1 {
	out := ContractV1{
		SchemaVersion: input.SchemaVersion,
		PrimaryIntent: Intent{
			Kind:      IntentKind(normalizeEnum(string(input.PrimaryIntent.Kind))),
			Statement: normalizeNaturalText(input.PrimaryIntent.Statement),
		},
		AudienceContext: Audience{
			Description:        normalizeNaturalText(input.AudienceContext.Description),
			TargetingReference: normalizeReference(input.AudienceContext.TargetingReference),
		},
		CoreClaim: Claim{
			Statement:      normalizeNaturalText(input.CoreClaim.Statement),
			SourceBlockIDs: normalizeBlockIDs(input.CoreClaim.SourceBlockIDs),
		},
		PrimaryAction: PrimaryAction{
			ActionID:     ActionID(normalizeReference(string(input.PrimaryAction.ActionID))),
			BlockID:      BlockID(normalizeReference(string(input.PrimaryAction.BlockID))),
			Role:         PrimaryActionRole(normalizeEnum(string(input.PrimaryAction.Role))),
			Label:        normalizeNaturalText(input.PrimaryAction.Label),
			CanonicalURL: normalizeURL(input.PrimaryAction.CanonicalURL),
		},
		RequiredFacts:           normalizeRequiredFacts(input.RequiredFacts),
		ForbiddenClaims:         normalizeForbiddenClaims(input.ForbiddenClaims),
		AllowedSecondaryActions: normalizeSecondaryActions(input.AllowedSecondaryActions),
		Language:                normalizeLanguage(input.Language),
	}
	return out
}

func normalizeRequiredFacts(in []RequiredFact) []RequiredFact {
	if in == nil {
		return nil
	}
	out := make([]RequiredFact, len(in))
	for i, fact := range in {
		out[i] = RequiredFact{
			ID:             FactID(normalizeReference(string(fact.ID))),
			Type:           FactType(normalizeEnum(string(fact.Type))),
			DisplayValue:   normalizeNaturalText(fact.DisplayValue),
			Criticality:    Criticality(normalizeEnum(string(fact.Criticality))),
			SourceBlockIDs: normalizeBlockIDs(fact.SourceBlockIDs),
			TextValue:      normalizeOptionalNaturalText(fact.TextValue),
			DateTimeValue:  normalizeDateTimeValue(fact.DateTimeValue),
			MoneyValue:     normalizeMoneyValue(fact.MoneyValue),
			NumberValue:    normalizeNumberValue(fact.Type, fact.NumberValue),
			URLValue:       normalizeOptionalURL(fact.URLValue),
		}
	}
	return out
}

func normalizeForbiddenClaims(in []ForbiddenClaim) []ForbiddenClaim {
	if in == nil {
		return nil
	}
	out := make([]ForbiddenClaim, len(in))
	for i, claim := range in {
		out[i] = ForbiddenClaim{
			ID:        ForbiddenClaimID(normalizeReference(string(claim.ID))),
			Statement: normalizeNaturalText(claim.Statement),
		}
	}
	return out
}

func normalizeSecondaryActions(in []SecondaryActionRole) []SecondaryActionRole {
	if in == nil {
		return nil
	}
	out := make([]SecondaryActionRole, len(in))
	for i, role := range in {
		out[i] = SecondaryActionRole(normalizeEnum(string(role)))
	}
	return out
}

func normalizeBlockIDs(in []BlockID) []BlockID {
	if in == nil {
		return nil
	}
	out := make([]BlockID, len(in))
	for i, id := range in {
		out[i] = BlockID(normalizeReference(string(id)))
	}
	return out
}

func normalizeOptionalNaturalText(in *string) *string {
	if in == nil {
		return nil
	}
	v := normalizeNaturalText(*in)
	return &v
}

func normalizeOptionalURL(in *string) *string {
	if in == nil {
		return nil
	}
	v := normalizeURL(*in)
	return &v
}

func normalizeDateTimeValue(in *DateTimeValue) *DateTimeValue {
	if in == nil {
		return nil
	}
	out := &DateTimeValue{
		RFC3339:  strings.TrimSpace(in.RFC3339),
		Timezone: strings.TrimSpace(in.Timezone),
	}
	if parsed, err := time.Parse(time.RFC3339Nano, out.RFC3339); err == nil {
		out.RFC3339 = parsed.Format(time.RFC3339Nano)
	}
	return out
}

func normalizeMoneyValue(in *MoneyValue) *MoneyValue {
	if in == nil {
		return nil
	}
	amount := strings.TrimSpace(in.Amount)
	if canonical, ok := normalizeDecimal(amount); ok {
		amount = canonical
	}
	return &MoneyValue{
		Amount:   amount,
		Currency: CurrencyCode(strings.ToUpper(strings.TrimSpace(string(in.Currency)))),
	}
}

func normalizeNumberValue(factType FactType, in *NumberValue) *NumberValue {
	if in == nil {
		return nil
	}
	value := strings.TrimSpace(in.Value)
	if canonical, ok := normalizeDecimal(value); ok {
		value = canonical
	}
	unit := normalizeNaturalText(in.Unit)
	if FactType(normalizeEnum(string(factType))) == FactTypePercentage {
		switch strings.ToLower(unit) {
		case "", "%", "percent", "percentage":
			unit = "%"
		}
	}
	return &NumberValue{Value: value, Unit: unit}
}

func normalizeLanguage(in LanguageTag) LanguageTag {
	raw := strings.TrimSpace(string(in))
	if raw == "" {
		return ""
	}
	// language.Parse intentionally accepts a few common non-BCP-47 forms
	// (including underscores). Do not silently repair those into a different
	// wire contract; only case-canonicalize syntactically hyphenated tags.
	if len(raw) > maxLanguageTagBytes || !languageTagSyntax.MatchString(raw) {
		return LanguageTag(raw)
	}
	tag, err := language.Parse(raw)
	if err != nil || languageBaseIsUnd(tag) {
		return LanguageTag(raw)
	}
	return LanguageTag(tag.String())
}

func normalizeEnum(in string) string {
	return strings.ToLower(strings.TrimSpace(in))
}

func normalizeReference(in string) string {
	return strings.TrimSpace(in)
}

func normalizeNaturalText(in string) string {
	if !utf8.ValidString(in) {
		return in
	}
	normalized := norm.NFKC.String(in)
	return strings.Join(strings.FieldsFunc(normalized, unicode.IsSpace), " ")
}

func normalizeURL(in string) string {
	raw := strings.TrimSpace(in)
	if len(raw) > maxURLBytes {
		return raw
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return raw
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	return parsed.String()
}

// normalizeDecimal canonicalizes a plain base-10 decimal without using binary
// floating point. Validation applies digit and scale bounds separately.
func normalizeDecimal(raw string) (string, bool) {
	if raw == "" {
		return "", false
	}
	negative := false
	if raw[0] == '-' {
		negative = true
		raw = raw[1:]
	}
	if raw == "" || raw[0] == '+' {
		return "", false
	}
	if strings.Count(raw, ".") > 1 {
		return "", false
	}
	parts := strings.SplitN(raw, ".", 2)
	if parts[0] == "" || !allASCIIDigits(parts[0]) {
		return "", false
	}
	fraction := ""
	if len(parts) == 2 {
		if parts[1] == "" || !allASCIIDigits(parts[1]) {
			return "", false
		}
		fraction = strings.TrimRight(parts[1], "0")
	}
	integer := strings.TrimLeft(parts[0], "0")
	if integer == "" {
		integer = "0"
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

func allASCIIDigits(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] < '0' || value[i] > '9' {
			return false
		}
	}
	return true
}
