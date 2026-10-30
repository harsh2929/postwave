// SPDX-License-Identifier: AGPL-3.0-only

package semanticemail

import (
	"reflect"
	"testing"
)

func TestValidDocumentV2PassesDeterministicValidation(t *testing.T) {
	document := validDocumentV2()
	normalized, diagnostics := NormalizeAndValidateV2(document)
	if diagnostics.HasErrors() {
		t.Fatalf("NormalizeAndValidateV2() diagnostics = %v", diagnostics)
	}
	if len(diagnostics) != 0 {
		t.Fatalf("valid document produced warnings = %v", diagnostics)
	}
	if normalized.SchemaVersion != SchemaVersionV2 || normalized.Nodes[0].ID != "blk_event_name" {
		t.Fatalf("normalized identity changed unexpectedly: %#v", normalized)
	}

	for i := 0; i < 20; i++ {
		if got := ValidateV2(document); !reflect.DeepEqual(got, diagnostics) {
			t.Fatalf("validation run %d not deterministic:\n got %#v\nwant %#v", i, got, diagnostics)
		}
	}
}

func TestNormalizeV2IsIdempotentAndDoesNotAliasInput(t *testing.T) {
	document := validDocumentV2()
	document.Language = " EN-in "
	document.Direction = " LTR "
	document.Nodes[0].ID = " blk_event_name "
	document.Nodes[0].Content.Heading.Text.Runs[0].Text = "  Workflow\tAutomation  Live "
	document.Nodes[4].Content.Action.CanonicalURL = " HTTPS://EXAMPLE.TEST/events/launch "
	document.Nodes[7].Content.Money.Amount = " 001499.000 "
	document.Nodes[7].Content.Money.Currency = " inr "
	document.Nodes[0].Localizations = map[string]NodeContent{
		"hi-in": {Heading: &HeadingContent{Level: 1, Text: text("कार्यप्रवाह स्वचालन")}},
	}

	normalized := NormalizeV2(document)
	if got, want := normalized.Language, "en-IN"; got != want {
		t.Errorf("language = %q, want %q", got, want)
	}
	if got, want := normalized.Nodes[0].Content.Heading.Text.Runs[0].Text, " Workflow Automation Live "; got != want {
		t.Errorf("inline text = %q, want %q", got, want)
	}
	if got, want := normalized.Nodes[4].Content.Action.CanonicalURL, "https://example.test/events/launch"; got != want {
		t.Errorf("URL = %q, want %q", got, want)
	}
	if got, want := normalized.Nodes[7].Content.Money.Amount, "1499"; got != want {
		t.Errorf("amount = %q, want %q", got, want)
	}
	if got, want := normalized.Nodes[7].Content.Money.Currency, "INR"; got != want {
		t.Errorf("currency = %q, want %q", got, want)
	}
	if _, ok := normalized.Nodes[0].Localizations["hi-IN"]; !ok {
		t.Fatalf("localization keys = %#v, want canonical hi-IN", normalized.Nodes[0].Localizations)
	}
	if twice := NormalizeV2(normalized); !reflect.DeepEqual(twice, normalized) {
		t.Fatalf("normalization is not idempotent:\n once %#v\n twice %#v", normalized, twice)
	}

	normalized.Nodes[0].Content.Heading.Text.Runs[0].Text = "changed"
	normalized.Nodes[0].Localizations["hi-IN"] = NodeContent{}
	normalized.Nodes[1].Conditions[0].Value = "changed"
	if document.Nodes[0].Content.Heading.Text.Runs[0].Text == "changed" || document.Nodes[1].Conditions[0].Value == "changed" {
		t.Fatal("normalized document aliases mutable input")
	}
}

func TestValidationReportsStableTypedDiagnostics(t *testing.T) {
	document := validDocumentV2()
	document.SchemaVersion = 3
	document.Nodes[1].ID = document.Nodes[0].ID
	document.Nodes[1].Content.Heading = &HeadingContent{Level: 3, Text: text("wrong union")}
	document.Nodes[2].Role = RolePrice
	document.Nodes[4].Content.Action.CanonicalURL = "https://user:secret@example.test/action#fragment"
	document.Nodes[5].Content.Image.Alt = ""
	document.Nodes[8].Content.Money.Currency = "XXX"
	document.Nodes[9].Content.Deadline.Timezone = "Local"
	document.Nodes[20].Content.StructuredData.RegistryVersion = "gmail.latest"
	document.Nodes[22].Content.StructuredData.Declaration.EventReservation.LocationNodeID = "missing"
	document.Nodes = append(document.Nodes, Node{
		ID: "blk_other_primary", Type: NodeAction, Role: RolePrimaryAction, Version: NodeVersionV2,
		Content:    NodeContent{Action: &ActionContent{ActionID: "act_other", Label: "Other", CanonicalURL: "https://example.test/other"}},
		Provenance: Provenance{Source: SourceUser},
	})

	diagnostics := ValidateV2(document)
	for _, code := range []DiagnosticCode{
		CodeUnsupportedSchemaVersion,
		CodeDuplicate,
		CodeContentCardinality,
		CodeRoleTypeMismatch,
		CodeURLCredentialsForbidden,
		CodeURLFragmentForbidden,
		CodeRequired,
		CodeInvalidCurrency,
		CodeTimezoneUnknown,
		CodeRegistryVersionUnsupported,
		CodeNodeReferenceMissing,
		CodeMultiplePrimaryActions,
	} {
		if !diagnostics.HasCode(code) {
			t.Errorf("diagnostics missing code %q: %v", code, diagnostics)
		}
	}
	if !diagnostics.HasErrors() {
		t.Fatal("invalid document did not fail validation")
	}
	for i := 0; i < 20; i++ {
		if again := ValidateV2(document); !reflect.DeepEqual(again, diagnostics) {
			t.Fatalf("diagnostic order changed on run %d", i)
		}
	}
}

func TestLocalizationCollisionIsRejectedDeterministically(t *testing.T) {
	document := validDocumentV2()
	document.Nodes[0].Localizations = map[string]NodeContent{
		"hi-IN": {Heading: &HeadingContent{Level: 1, Text: text("एक")}},
		"HI-in": {Heading: &HeadingContent{Level: 1, Text: text("दो")}},
	}
	diagnostics := ValidateV2(document)
	if !diagnostics.HasCode(CodeDuplicate) {
		t.Fatalf("diagnostics = %v, want normalized locale collision", diagnostics)
	}
	if got, want := diagnostics[0].Path, "/nodes/0/localizations/hi-IN"; got != want {
		t.Fatalf("collision path = %q, want %q", got, want)
	}
}

func TestAccessibilityWarningsDoNotBecomeValidationErrors(t *testing.T) {
	document := validDocumentV2()
	document.Nodes = append([]Node{{
		ID: "blk_skipped_heading", Type: NodeHeading, Role: RoleHeading, Version: NodeVersionV2,
		Content:    NodeContent{Heading: &HeadingContent{Level: 3, Text: text("Deep heading")}},
		Provenance: Provenance{Source: SourceUser},
	}}, document.Nodes...)
	document.Nodes = append(document.Nodes, Node{
		ID: "blk_second_h1", Type: NodeHeading, Role: RoleHeading, Version: NodeVersionV2,
		Content:    NodeContent{Heading: &HeadingContent{Level: 1, Text: text("Another title")}},
		Provenance: Provenance{Source: SourceUser},
	})
	diagnostics := ValidateV2(document)
	if diagnostics.HasErrors() {
		t.Fatalf("heading warnings became errors: %v", diagnostics)
	}
	if !diagnostics.HasCode(CodeHeadingLevelSkipped) || !diagnostics.HasCode(CodeMultipleTopLevelHeadings) {
		t.Fatalf("diagnostics = %v, want heading hierarchy warnings", diagnostics)
	}
}

func TestPromotionCardRequiresSupportedKnownAspectRatio(t *testing.T) {
	document := validDocumentV2()
	document.Nodes[5].Content.Image.Width = 1600
	document.Nodes[5].Content.Image.Height = 900
	diagnostics := ValidateV2(document)
	if !diagnostics.HasCode(CodeNumberOutOfRange) {
		t.Fatalf("diagnostics = %v, want unsupported promotion ratio", diagnostics)
	}
}

func TestDateTimeAndCurrencyValidationAreLocaleIndependent(t *testing.T) {
	document := validDocumentV2()
	document.Nodes[6].Content.DateTime = &DateTimeContent{
		DisplayValue: "1 July 2026 at noon",
		RFC3339:      "2026-07-01T12:00:00-05:00",
		Timezone:     "America/New_York",
	}
	document.Nodes[7].Content.Money.Currency = "ZZZ"
	diagnostics := ValidateV2(document)
	if !diagnostics.HasCode(CodeTimezoneOffsetMismatch) {
		t.Errorf("diagnostics = %v, want DST-aware timezone mismatch", diagnostics)
	}
	if !diagnostics.HasCode(CodeInvalidCurrency) {
		t.Errorf("diagnostics = %v, want ISO 4217 failure", diagnostics)
	}

	document.Nodes[6].Content.DateTime.RFC3339 = "2026-07-01T12:00:00-04:00"
	document.Nodes[7].Content.Money.Currency = "usd"
	normalized, diagnostics := NormalizeAndValidateV2(document)
	if diagnostics.HasCode(CodeTimezoneOffsetMismatch) || diagnostics.HasCode(CodeInvalidCurrency) {
		t.Fatalf("canonical datetime/currency should validate: %v", diagnostics)
	}
	if got, want := normalized.Nodes[7].Content.Money.Currency, "USD"; got != want {
		t.Fatalf("normalized currency = %q, want %q", got, want)
	}
}
