// SPDX-License-Identifier: AGPL-3.0-only

package factcontract

import (
	"reflect"
	"testing"
)

func TestNormalizeAndValidateV1CanonicalizesSemantically(t *testing.T) {
	input := validContractV1()
	input.PrimaryIntent.Kind = " INVITE "
	input.PrimaryIntent.Statement = "  Invite\tPro\ncustomers  to the Ｗebinar "
	input.AudienceContext.Description = "  Existing   Pro customers  "
	input.AudienceContext.TargetingReference = " segment:pro-india "
	input.CoreClaim.SourceBlockIDs = []BlockID{" blk_claim "}
	input.PrimaryAction.ActionID = " act_register "
	input.PrimaryAction.BlockID = " blk_cta "
	input.PrimaryAction.Role = " REGISTER "
	input.PrimaryAction.Label = "  Reserve   my seat "
	input.PrimaryAction.CanonicalURL = " HTTPS://EXAMPLE.TEST/events/launch "
	input.Language = "EN-in"
	input.AllowedSecondaryActions = []SecondaryActionRole{" PREFERENCES ", "unsubscribe"}
	input.RequiredFacts[0].Type = " DATETIME "
	input.RequiredFacts[0].Criticality = " CRITICAL "
	input.RequiredFacts[0].DateTimeValue.RFC3339 = " 2026-08-14T16:00:00.000+05:30 "
	input.RequiredFacts[1].MoneyValue.Amount = " 001499.5000 "
	input.RequiredFacts[1].MoneyValue.Currency = " inr "
	input.RequiredFacts[4].NumberValue.Value = "050.000"
	input.RequiredFacts[4].NumberValue.Unit = "percent"

	normalized, errs := NormalizeAndValidateV1(input)
	if errs.HasErrors() {
		t.Fatalf("NormalizeAndValidateV1() errors = %v", errs)
	}

	if got, want := normalized.PrimaryIntent.Statement, "Invite Pro customers to the Webinar"; got != want {
		t.Errorf("primary intent statement = %q, want %q", got, want)
	}
	if got, want := normalized.AudienceContext.Description, "Existing Pro customers"; got != want {
		t.Errorf("audience description = %q, want %q", got, want)
	}
	if got, want := normalized.AudienceContext.TargetingReference, "segment:pro-india"; got != want {
		t.Errorf("targeting reference = %q, want %q", got, want)
	}
	if normalized.PrimaryIntent.Kind != IntentInvite || normalized.PrimaryAction.Role != PrimaryActionRegister {
		t.Errorf("enums not normalized: intent=%q role=%q", normalized.PrimaryIntent.Kind, normalized.PrimaryAction.Role)
	}
	if got, want := normalized.PrimaryAction.CanonicalURL, "https://example.test/events/launch"; got != want {
		t.Errorf("canonical URL = %q, want %q", got, want)
	}
	if got, want := normalized.Language, LanguageTag("en-IN"); got != want {
		t.Errorf("language = %q, want %q", got, want)
	}
	if got, want := normalized.RequiredFacts[0].DateTimeValue.RFC3339, "2026-08-14T16:00:00+05:30"; got != want {
		t.Errorf("datetime = %q, want %q", got, want)
	}
	if got, want := normalized.RequiredFacts[1].MoneyValue.Amount, "1499.5"; got != want {
		t.Errorf("money amount = %q, want %q", got, want)
	}
	if got, want := normalized.RequiredFacts[1].MoneyValue.Currency, CurrencyCode("INR"); got != want {
		t.Errorf("currency = %q, want %q", got, want)
	}
	if got, want := *normalized.RequiredFacts[4].NumberValue, (NumberValue{Value: "50", Unit: "%"}); got != want {
		t.Errorf("percentage = %#v, want %#v", got, want)
	}
}

func TestNormalizeV1DoesNotMutateOrAliasInput(t *testing.T) {
	input := validContractV1()
	original := cloneContractForTest(input)
	normalized := NormalizeV1(input)

	if !reflect.DeepEqual(input, original) {
		t.Fatal("NormalizeV1 mutated its input")
	}

	normalized.CoreClaim.SourceBlockIDs[0] = "changed"
	normalized.RequiredFacts[0].SourceBlockIDs[0] = "changed"
	*normalized.RequiredFacts[2].TextValue = "changed"
	normalized.ForbiddenClaims[0].Statement = "changed"
	normalized.AllowedSecondaryActions[0] = SecondaryActionSocial

	if !reflect.DeepEqual(input, original) {
		t.Fatal("normalized output aliases mutable input data")
	}
}

func TestNormalizeDecimal(t *testing.T) {
	tests := []struct {
		input string
		want  string
		ok    bool
	}{
		{input: "0", want: "0", ok: true},
		{input: "000", want: "0", ok: true},
		{input: "-0.000", want: "0", ok: true},
		{input: "0012.3400", want: "12.34", ok: true},
		{input: "-0012.3400", want: "-12.34", ok: true},
		{input: ".5", ok: false},
		{input: "5.", ok: false},
		{input: "+5", ok: false},
		{input: "1e3", ok: false},
		{input: "1,000", ok: false},
		{input: "１２", ok: false},
		{input: "", ok: false},
	}
	for _, test := range tests {
		t.Run(test.input, func(t *testing.T) {
			got, ok := normalizeDecimal(test.input)
			if ok != test.ok || got != test.want {
				t.Fatalf("normalizeDecimal(%q) = (%q, %v), want (%q, %v)", test.input, got, ok, test.want, test.ok)
			}
		})
	}
}

func cloneContractForTest(input ContractV1) ContractV1 {
	clone := input
	clone.CoreClaim.SourceBlockIDs = append([]BlockID(nil), input.CoreClaim.SourceBlockIDs...)
	clone.RequiredFacts = make([]RequiredFact, len(input.RequiredFacts))
	for i, fact := range input.RequiredFacts {
		clone.RequiredFacts[i] = fact
		clone.RequiredFacts[i].SourceBlockIDs = append([]BlockID(nil), fact.SourceBlockIDs...)
		if fact.TextValue != nil {
			value := *fact.TextValue
			clone.RequiredFacts[i].TextValue = &value
		}
		if fact.DateTimeValue != nil {
			value := *fact.DateTimeValue
			clone.RequiredFacts[i].DateTimeValue = &value
		}
		if fact.MoneyValue != nil {
			value := *fact.MoneyValue
			clone.RequiredFacts[i].MoneyValue = &value
		}
		if fact.NumberValue != nil {
			value := *fact.NumberValue
			clone.RequiredFacts[i].NumberValue = &value
		}
		if fact.URLValue != nil {
			value := *fact.URLValue
			clone.RequiredFacts[i].URLValue = &value
		}
	}
	clone.ForbiddenClaims = append([]ForbiddenClaim(nil), input.ForbiddenClaims...)
	clone.AllowedSecondaryActions = append([]SecondaryActionRole(nil), input.AllowedSecondaryActions...)
	return clone
}
