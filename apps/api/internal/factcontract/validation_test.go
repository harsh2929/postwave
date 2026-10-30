// SPDX-License-Identifier: AGPL-3.0-only

package factcontract

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestContractV1ValidCompleteContract(t *testing.T) {
	contract := validContractV1()
	normalized, errs := NormalizeAndValidateV1(contract)
	if errs.HasErrors() {
		t.Fatalf("valid contract rejected: %v", errs)
	}
	if normalized.SchemaVersion != SchemaVersionV1 {
		t.Fatalf("schema version = %d, want %d", normalized.SchemaVersion, SchemaVersionV1)
	}

	encoded, err := json.Marshal(normalized)
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	var roundTrip ContractV1
	if err := json.Unmarshal(encoded, &roundTrip); err != nil {
		t.Fatalf("json.Unmarshal: %v", err)
	}
	if !reflect.DeepEqual(roundTrip, normalized) {
		t.Fatalf("JSON round-trip changed contract\ngot:  %#v\nwant: %#v", roundTrip, normalized)
	}
}

func TestContractV1EmptyProducesDeterministicErrors(t *testing.T) {
	want := []pathCode{
		{"/schema_version", CodeUnsupportedSchemaVersion},
		{"/primary_intent/kind", CodeInvalidEnum},
		{"/primary_intent/statement", CodeRequired},
		{"/audience_context/description", CodeRequired},
		{"/core_claim/statement", CodeRequired},
		{"/primary_action/action_id", CodeRequired},
		{"/primary_action/block_id", CodeRequired},
		{"/primary_action/role", CodeInvalidEnum},
		{"/primary_action/label", CodeRequired},
		{"/primary_action/canonical_url", CodeActionURLRequired},
		{"/language", CodeRequired},
	}

	first := ValidateV1(ContractV1{})
	second := ValidateV1(ContractV1{})
	assertPathCodes(t, first, want)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("validation ordering is not deterministic\nfirst:  %#v\nsecond: %#v", first, second)
	}
	if !first.HasCode(CodeRequired) || first.HasCode(CodeInvalidCurrency) {
		t.Errorf("HasCode returned unexpected result for %v", first)
	}
	if !strings.Contains(first.Error(), "/schema_version [schema_version_unsupported]") {
		t.Errorf("Error() lacks structured context: %q", first.Error())
	}
	if got := (ValidationErrors{}).Error(); got != "" {
		t.Errorf("empty ValidationErrors.Error() = %q, want empty", got)
	}
}

func TestContractV1RejectsUnknownEnums(t *testing.T) {
	tests := []struct {
		name string
		edit func(*ContractV1)
		path string
	}{
		{"intent", func(c *ContractV1) { c.PrimaryIntent.Kind = "broadcast" }, "/primary_intent/kind"},
		{"primary action", func(c *ContractV1) { c.PrimaryAction.Role = "click" }, "/primary_action/role"},
		{"fact type", func(c *ContractV1) { c.RequiredFacts[0].Type = "deadline" }, "/required_facts/0/type"},
		{"criticality", func(c *ContractV1) { c.RequiredFacts[0].Criticality = "block" }, "/required_facts/0/criticality"},
		{"secondary action", func(c *ContractV1) { c.AllowedSecondaryActions[0] = "footer" }, "/allowed_secondary_actions/0"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			contract := validContractV1()
			test.edit(&contract)
			assertContainsPathCode(t, ValidateV1(contract), test.path, CodeInvalidEnum)
		})
	}
}

func TestContractV1PrimaryActionURLPolicy(t *testing.T) {
	tests := []struct {
		name string
		role PrimaryActionRole
		url  string
		code ValidationCode
	}{
		{name: "navigate requires URL", role: PrimaryActionNavigate, code: CodeActionURLRequired},
		{name: "reply omits URL", role: PrimaryActionReply},
		{name: "reply rejects URL", role: PrimaryActionReply, url: "https://example.test/reply", code: CodeActionURLForbidden},
		{name: "rejects ftp", role: PrimaryActionNavigate, url: "ftp://example.test/file", code: CodeInvalidURL},
		{name: "rejects relative", role: PrimaryActionNavigate, url: "/events/launch", code: CodeInvalidURL},
		{name: "rejects malformed host", role: PrimaryActionNavigate, url: "https://[::1", code: CodeInvalidURL},
		{name: "rejects control character", role: PrimaryActionNavigate, url: "https://example.test/a\x00b", code: CodeInvalidURL},
		{name: "rejects overlong URL", role: PrimaryActionNavigate, url: "https://example.test/" + strings.Repeat("a", maxURLBytes), code: CodeInvalidURL},
		{name: "rejects credentials", role: PrimaryActionNavigate, url: "https://user:pass@example.test/path", code: CodeURLCredentialsForbidden},
		{name: "rejects fragment", role: PrimaryActionNavigate, url: "https://example.test/path#details", code: CodeURLFragmentForbidden},
		{name: "allows http", role: PrimaryActionNavigate, url: "http://example.test/path"},
		{name: "allows https query", role: PrimaryActionRegister, url: "https://example.test/path?event=launch"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			contract := validContractV1()
			contract.PrimaryAction.Role = test.role
			contract.PrimaryAction.CanonicalURL = test.url
			errs := ValidateV1(contract)
			if test.code == "" {
				if errs.HasErrors() {
					t.Fatalf("unexpected errors: %v", errs)
				}
				return
			}
			assertContainsPathCode(t, errs, "/primary_action/canonical_url", test.code)
		})
	}
}

func TestContractV1StableReferencesAndDuplicates(t *testing.T) {
	contract := validContractV1()
	contract.AudienceContext.TargetingReference = "bad/reference"
	contract.PrimaryAction.ActionID = "bad action"
	contract.CoreClaim.SourceBlockIDs = []BlockID{"blk_claim", "blk_claim"}
	contract.RequiredFacts[1].ID = contract.RequiredFacts[0].ID
	contract.RequiredFacts[1].SourceBlockIDs = []BlockID{"blk_price", "blk_price"}
	contract.ForbiddenClaims = append(contract.ForbiddenClaims, contract.ForbiddenClaims[0])
	contract.AllowedSecondaryActions = append(contract.AllowedSecondaryActions, SecondaryActionUnsubscribe)

	errs := ValidateV1(contract)
	assertContainsPathCode(t, errs, "/audience_context/targeting_reference", CodeInvalidStableReference)
	assertContainsPathCode(t, errs, "/primary_action/action_id", CodeInvalidStableReference)
	assertContainsPathCode(t, errs, "/core_claim/source_block_ids/1", CodeDuplicate)
	assertContainsPathCode(t, errs, "/required_facts/1/id", CodeDuplicate)
	assertContainsPathCode(t, errs, "/required_facts/1/source_block_ids/1", CodeDuplicate)
	assertContainsPathCode(t, errs, "/forbidden_claims/1/id", CodeDuplicate)
	assertContainsPathCode(t, errs, "/allowed_secondary_actions/2", CodeDuplicate)
}

func TestContractV1FactValueDiscriminator(t *testing.T) {
	t.Run("missing value", func(t *testing.T) {
		contract := validContractV1()
		contract.RequiredFacts[0].DateTimeValue = nil
		assertContainsPathCode(t, ValidateV1(contract), "/required_facts/0/value", CodeFactValueCardinality)
	})

	t.Run("multiple values", func(t *testing.T) {
		contract := validContractV1()
		text := "extra"
		contract.RequiredFacts[0].TextValue = &text
		assertContainsPathCode(t, ValidateV1(contract), "/required_facts/0/value", CodeFactValueCardinality)
	})

	t.Run("wrong single value", func(t *testing.T) {
		contract := validContractV1()
		contract.RequiredFacts[0].DateTimeValue = nil
		text := "14 August"
		contract.RequiredFacts[0].TextValue = &text
		assertContainsPathCode(t, ValidateV1(contract), "/required_facts/0/value", CodeFactValueTypeMismatch)
	})

	t.Run("source block required", func(t *testing.T) {
		contract := validContractV1()
		contract.RequiredFacts[0].SourceBlockIDs = nil
		assertContainsPathCode(t, ValidateV1(contract), "/required_facts/0/source_block_ids", CodeRequired)
	})
}

func TestContractV1DateTimeValidation(t *testing.T) {
	tests := []struct {
		name     string
		value    DateTimeValue
		wantCode ValidationCode
		wantPath string
	}{
		{name: "Kolkata", value: DateTimeValue{RFC3339: "2026-08-14T16:00:00+05:30", Timezone: "Asia/Kolkata"}},
		{name: "New York summer DST", value: DateTimeValue{RFC3339: "2026-07-10T09:00:00-04:00", Timezone: "America/New_York"}},
		{name: "New York winter DST", value: DateTimeValue{RFC3339: "2026-12-10T09:00:00-05:00", Timezone: "America/New_York"}},
		{name: "UTC", value: DateTimeValue{RFC3339: "2026-08-14T10:30:00Z", Timezone: "UTC"}},
		{name: "missing timestamp", value: DateTimeValue{Timezone: "UTC"}, wantCode: CodeRequired, wantPath: "/required_facts/0/datetime_value/rfc3339"},
		{name: "timestamp lacks offset", value: DateTimeValue{RFC3339: "2026-08-14T16:00:00", Timezone: "Asia/Kolkata"}, wantCode: CodeInvalidDateTime, wantPath: "/required_facts/0/datetime_value/rfc3339"},
		{name: "missing timezone", value: DateTimeValue{RFC3339: "2026-08-14T16:00:00+05:30"}, wantCode: CodeRequired, wantPath: "/required_facts/0/datetime_value/timezone"},
		{name: "unknown timezone", value: DateTimeValue{RFC3339: "2026-08-14T16:00:00+05:30", Timezone: "Mars/Olympus"}, wantCode: CodeTimezoneUnknown, wantPath: "/required_facts/0/datetime_value/timezone"},
		{name: "environment local forbidden", value: DateTimeValue{RFC3339: "2026-08-14T10:30:00Z", Timezone: "Local"}, wantCode: CodeTimezoneUnknown, wantPath: "/required_facts/0/datetime_value/timezone"},
		{name: "offset mismatch", value: DateTimeValue{RFC3339: "2026-08-14T16:00:00+04:30", Timezone: "Asia/Kolkata"}, wantCode: CodeTimezoneOffsetMismatch, wantPath: "/required_facts/0/datetime_value/rfc3339"},
		{name: "DST mismatch", value: DateTimeValue{RFC3339: "2026-07-10T09:00:00-05:00", Timezone: "America/New_York"}, wantCode: CodeTimezoneOffsetMismatch, wantPath: "/required_facts/0/datetime_value/rfc3339"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			contract := validContractV1()
			contract.RequiredFacts[0].DateTimeValue = &test.value
			errs := ValidateV1(contract)
			if test.wantCode == "" {
				if errs.HasErrors() {
					t.Fatalf("valid datetime rejected: %v", errs)
				}
				return
			}
			assertContainsPathCode(t, errs, test.wantPath, test.wantCode)
		})
	}
}

func TestContractV1MoneyValidation(t *testing.T) {
	tests := []struct {
		name     string
		value    MoneyValue
		wantCode ValidationCode
	}{
		{name: "USD", value: MoneyValue{Amount: "19.99", Currency: "USD"}},
		{name: "JPY", value: MoneyValue{Amount: "1500", Currency: "JPY"}},
		{name: "ISO precious metal", value: MoneyValue{Amount: "1.25", Currency: "XAU"}},
		{name: "lowercase normalizes", value: MoneyValue{Amount: "0019.990", Currency: "usd"}},
		{name: "unknown currency", value: MoneyValue{Amount: "19.99", Currency: "ZZZ"}, wantCode: CodeInvalidCurrency},
		{name: "no-currency designator", value: MoneyValue{Amount: "19.99", Currency: "XXX"}, wantCode: CodeInvalidCurrency},
		{name: "testing designator", value: MoneyValue{Amount: "19.99", Currency: "XTS"}, wantCode: CodeInvalidCurrency},
		{name: "exponent", value: MoneyValue{Amount: "1e3", Currency: "USD"}, wantCode: CodeInvalidDecimal},
		{name: "too much precision", value: MoneyValue{Amount: "0.1234567891", Currency: "USD"}, wantCode: CodeDecimalPrecisionExceeded},
		{name: "missing amount", value: MoneyValue{Currency: "USD"}, wantCode: CodeRequired},
		{name: "missing currency", value: MoneyValue{Amount: "19.99"}, wantCode: CodeRequired},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			contract := validContractV1()
			contract.RequiredFacts[1].MoneyValue = &test.value
			errs := ValidateV1(contract)
			if test.wantCode == "" {
				if errs.HasErrors() {
					t.Fatalf("valid money rejected: %v", errs)
				}
				return
			}
			path := "/required_facts/1/money_value/amount"
			if (test.wantCode == CodeInvalidCurrency || test.wantCode == CodeRequired) && test.value.Amount != "" {
				path = "/required_facts/1/money_value/currency"
			}
			assertContainsPathCode(t, errs, path, test.wantCode)
		})
	}
}

func TestContractV1PercentageAndQuantityValidation(t *testing.T) {
	tests := []struct {
		name      string
		factIndex int
		value     NumberValue
		wantCode  ValidationCode
		wantPath  string
	}{
		{name: "zero percent", factIndex: 4, value: NumberValue{Value: "0", Unit: "%"}},
		{name: "hundred percent", factIndex: 4, value: NumberValue{Value: "100", Unit: "%"}},
		{name: "percent word normalizes", factIndex: 4, value: NumberValue{Value: "25.00", Unit: "percent"}},
		{name: "percent too high", factIndex: 4, value: NumberValue{Value: "100.01", Unit: "%"}, wantCode: CodeNumberOutOfRange, wantPath: "/required_facts/4/number_value/value"},
		{name: "percent negative", factIndex: 4, value: NumberValue{Value: "-1", Unit: "%"}, wantCode: CodeNumberOutOfRange, wantPath: "/required_facts/4/number_value/value"},
		{name: "percent wrong unit", factIndex: 4, value: NumberValue{Value: "50", Unit: "points"}, wantCode: CodeInvalidUnit, wantPath: "/required_facts/4/number_value/unit"},
		{name: "quantity", factIndex: 5, value: NumberValue{Value: "12.5", Unit: "GB"}},
		{name: "quantity missing unit", factIndex: 5, value: NumberValue{Value: "12.5"}, wantCode: CodeUnitRequired, wantPath: "/required_facts/5/number_value/unit"},
		{name: "quantity negative", factIndex: 5, value: NumberValue{Value: "-0.1", Unit: "seats"}, wantCode: CodeNumberOutOfRange, wantPath: "/required_facts/5/number_value/value"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			contract := validContractV1()
			contract.RequiredFacts[test.factIndex].NumberValue = &test.value
			errs := ValidateV1(contract)
			if test.wantCode == "" {
				if errs.HasErrors() {
					t.Fatalf("valid number rejected: %v", errs)
				}
				return
			}
			assertContainsPathCode(t, errs, test.wantPath, test.wantCode)
		})
	}
}

func TestContractV1LanguageValidation(t *testing.T) {
	tests := []struct {
		input LanguageTag
		valid bool
		want  LanguageTag
	}{
		{input: "en-IN", valid: true, want: "en-IN"},
		{input: "PT-br", valid: true, want: "pt-BR"},
		{input: "zh-Hant-TW", valid: true, want: "zh-Hant-TW"},
		{input: "", valid: false},
		{input: "und", valid: false},
		{input: "en_US", valid: false},
		{input: "not a tag", valid: false},
	}
	for _, test := range tests {
		t.Run(string(test.input), func(t *testing.T) {
			contract := validContractV1()
			contract.Language = test.input
			normalized, errs := NormalizeAndValidateV1(contract)
			if test.valid {
				if errs.HasErrors() {
					t.Fatalf("valid language rejected: %v", errs)
				}
				if normalized.Language != test.want {
					t.Errorf("language = %q, want %q", normalized.Language, test.want)
				}
				return
			}
			code := CodeInvalidLanguage
			if test.input == "" {
				code = CodeRequired
			}
			assertContainsPathCode(t, errs, "/language", code)
		})
	}
}

func TestContractV1TextAndLimitValidation(t *testing.T) {
	t.Run("control character", func(t *testing.T) {
		contract := validContractV1()
		contract.CoreClaim.Statement = "claim\x00hidden"
		assertContainsPathCode(t, ValidateV1(contract), "/core_claim/statement", CodeInvalidText)
	})

	t.Run("invalid UTF-8", func(t *testing.T) {
		contract := validContractV1()
		contract.PrimaryIntent.Statement = string([]byte{0xff, 0xfe})
		assertContainsPathCode(t, ValidateV1(contract), "/primary_intent/statement", CodeInvalidText)
	})

	t.Run("too long", func(t *testing.T) {
		contract := validContractV1()
		contract.PrimaryAction.Label = strings.Repeat("界", maxActionLabelRunes+1)
		assertContainsPathCode(t, ValidateV1(contract), "/primary_action/label", CodeTextTooLong)
	})

	t.Run("fact count", func(t *testing.T) {
		contract := validContractV1()
		prototype := contract.RequiredFacts[2]
		contract.RequiredFacts = make([]RequiredFact, maxRequiredFacts+1)
		for i := range contract.RequiredFacts {
			fact := prototype
			fact.ID = FactID("fact_" + decimalIndex(i))
			contract.RequiredFacts[i] = fact
		}
		assertContainsPathCode(t, ValidateV1(contract), "/required_facts", CodeLimitExceeded)
	})
}

func TestContractV1FactValueURLValidation(t *testing.T) {
	contract := validContractV1()
	invalid := "javascript:alert(1)"
	contract.RequiredFacts[6].URLValue = &invalid
	assertContainsPathCode(t, ValidateV1(contract), "/required_facts/6/url_value", CodeInvalidURL)
}

func FuzzNormalizeAndValidateV1DoesNotPanic(f *testing.F) {
	f.Add(" invite ", "en-IN", "0019.990", "usd", "2026-08-14T16:00:00+05:30", "Asia/Kolkata")
	f.Add("\x00", "not a tag", "1e100", "ZZZ", "not-time", "Local")
	f.Fuzz(func(t *testing.T, intent, language, amount, currencyCode, timestamp, timezone string) {
		contract := validContractV1()
		contract.PrimaryIntent.Statement = intent
		contract.Language = LanguageTag(language)
		contract.RequiredFacts[0].DateTimeValue = &DateTimeValue{RFC3339: timestamp, Timezone: timezone}
		contract.RequiredFacts[1].MoneyValue = &MoneyValue{Amount: amount, Currency: CurrencyCode(currencyCode)}
		_, _ = NormalizeAndValidateV1(contract)
	})
}

type pathCode struct {
	path string
	code ValidationCode
}

func assertPathCodes(t *testing.T, got ValidationErrors, want []pathCode) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("error count = %d, want %d\ngot: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i].Path != want[i].path || got[i].Code != want[i].code {
			t.Fatalf("error[%d] = (%q, %q), want (%q, %q)\nall: %v", i, got[i].Path, got[i].Code, want[i].path, want[i].code, got)
		}
	}
}

func assertContainsPathCode(t *testing.T, errs ValidationErrors, path string, code ValidationCode) {
	t.Helper()
	for _, item := range errs {
		if item.Path == path && item.Code == code {
			return
		}
	}
	t.Fatalf("errors do not contain (%q, %q): %v", path, code, errs)
}

func decimalIndex(value int) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	position := len(digits)
	for value > 0 {
		position--
		digits[position] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[position:])
}

func validContractV1() ContractV1 {
	text := "Workflow automation is included"
	location := "Online"
	code := "LAUNCH20"
	URL := "https://example.test/events/launch/details"
	return ContractV1{
		SchemaVersion: SchemaVersionV1,
		PrimaryIntent: Intent{
			Kind:      IntentInvite,
			Statement: "Invite existing customers to the launch webinar",
		},
		AudienceContext: Audience{
			Description:        "Existing Pro customers in India",
			TargetingReference: "segment:pro-india",
		},
		CoreClaim: Claim{
			Statement:      "The launch webinar demonstrates workflow automation",
			SourceBlockIDs: []BlockID{"blk_claim"},
		},
		PrimaryAction: PrimaryAction{
			ActionID:     "act_register",
			BlockID:      "blk_cta",
			Role:         PrimaryActionRegister,
			Label:        "Reserve my seat",
			CanonicalURL: "https://example.test/events/launch",
		},
		RequiredFacts: []RequiredFact{
			{
				ID: "event_start", Type: FactTypeDateTime,
				DisplayValue: "14 August 2026, 4:00 PM IST", Criticality: CriticalityCritical,
				SourceBlockIDs: []BlockID{"blk_datetime"},
				DateTimeValue:  &DateTimeValue{RFC3339: "2026-08-14T16:00:00+05:30", Timezone: "Asia/Kolkata"},
			},
			{
				ID: "price", Type: FactTypeMoney,
				DisplayValue: "₹1,499.50", Criticality: CriticalityCritical,
				SourceBlockIDs: []BlockID{"blk_price"},
				MoneyValue:     &MoneyValue{Amount: "1499.5", Currency: "INR"},
			},
			{
				ID: "feature", Type: FactTypeText,
				DisplayValue: "Workflow automation is included", Criticality: CriticalityImportant,
				SourceBlockIDs: []BlockID{"blk_claim"}, TextValue: &text,
			},
			{
				ID: "location", Type: FactTypeLocation,
				DisplayValue: "Online", Criticality: CriticalityImportant,
				SourceBlockIDs: []BlockID{"blk_location"}, TextValue: &location,
			},
			{
				ID: "discount", Type: FactTypePercentage,
				DisplayValue: "50%", Criticality: CriticalityImportant,
				SourceBlockIDs: []BlockID{"blk_offer"}, NumberValue: &NumberValue{Value: "50", Unit: "%"},
			},
			{
				ID: "seat_count", Type: FactTypeQuantity,
				DisplayValue: "100 seats", Criticality: CriticalitySupporting,
				SourceBlockIDs: []BlockID{"blk_capacity"}, NumberValue: &NumberValue{Value: "100", Unit: "seats"},
			},
			{
				ID: "details_url", Type: FactTypeURL,
				DisplayValue: "Event details", Criticality: CriticalitySupporting,
				SourceBlockIDs: []BlockID{"blk_details"}, URLValue: &URL,
			},
			{
				ID: "offer_code", Type: FactTypeCode,
				DisplayValue: "LAUNCH20", Criticality: CriticalityImportant,
				SourceBlockIDs: []BlockID{"blk_offer"}, TextValue: &code,
			},
		},
		ForbiddenClaims: []ForbiddenClaim{
			{ID: "claim_no_recording", Statement: "A recording is guaranteed"},
		},
		AllowedSecondaryActions: []SecondaryActionRole{SecondaryActionPreferences, SecondaryActionUnsubscribe},
		Language:                "en-IN",
	}
}
