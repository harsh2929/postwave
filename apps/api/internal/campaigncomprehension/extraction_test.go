// SPDX-License-Identifier: AGPL-3.0-only

package campaigncomprehension

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/factcontract"
)

func TestDecodeAndNormalizeV1CanonicalizesAndHashes(t *testing.T) {
	raw, allowlist := validExtractionJSON(t)
	receipt, errs := DecodeAndNormalizeV1(raw, allowlist)
	if len(errs) != 0 {
		t.Fatalf("DecodeAndNormalizeV1() errors = %v", errs)
	}
	if got, want := receipt.Extraction.Summary, "Launch is on 14 August at 4 PM IST."; got != want {
		t.Fatalf("summary = %q, want %q", got, want)
	}
	if got, want := receipt.Extraction.PrimaryAction.CanonicalURL, "https://example.test/events/launch?seat=founder"; got != want {
		t.Fatalf("canonical URL = %q, want %q", got, want)
	}
	if got, want := receipt.Extraction.Facts[0].FactID, factcontract.FactID("capacity"); got != want {
		t.Fatalf("facts not sorted: first = %q, want %q", got, want)
	}
	if got, want := factByID(&receipt.Extraction, "price").Normalized, "1499.5"; got != want {
		t.Fatalf("decimal = %q, want %q", got, want)
	}
	if len(receipt.ReceiptHash) != 64 || len(VerifyExtractionReceiptV1(receipt)) != 0 {
		t.Fatalf("invalid receipt: hash=%q errors=%v", receipt.ReceiptHash, VerifyExtractionReceiptV1(receipt))
	}
	if errors := VerifyExtractionReceiptV1AgainstEvidence(receipt, allowlist); len(errors) != 0 {
		t.Fatalf("evidence-bound verification errors = %v", errors)
	}
	if errors := VerifyExtractionReceiptV1AgainstEvidence(receipt, []string{"blk_claim"}); !errors.HasCode(CodeEvidenceNotAllowed) {
		t.Fatalf("narrow evidence verification errors = %v, want evidence rejection", errors)
	}

	var reordered ExtractionV1
	if err := json.Unmarshal(raw, &reordered); err != nil {
		t.Fatal(err)
	}
	for left, right := 0, len(reordered.Facts)-1; left < right; left, right = left+1, right-1 {
		reordered.Facts[left], reordered.Facts[right] = reordered.Facts[right], reordered.Facts[left]
	}
	reordered.PrimaryIntent.EvidenceIDs[0], reordered.PrimaryIntent.EvidenceIDs[1] = reordered.PrimaryIntent.EvidenceIDs[1], reordered.PrimaryIntent.EvidenceIDs[0]
	reorderedJSON, _ := json.MarshalIndent(reordered, "", "  ")
	second, secondErrs := DecodeAndNormalizeV1(reorderedJSON, allowlist)
	if len(secondErrs) != 0 || second.ReceiptHash != receipt.ReceiptHash || !bytes.Equal(second.CanonicalExtraction, receipt.CanonicalExtraction) {
		t.Fatalf("canonicalization drift: errs=%v\nfirst=%s\nsecond=%s", secondErrs, receipt.CanonicalExtraction, second.CanonicalExtraction)
	}

	tampered := receipt
	tampered.Extraction.Summary = "Tampered"
	if errors := VerifyExtractionReceiptV1(tampered); !errors.HasCode(CodeReceiptHashMismatch) {
		t.Fatalf("tampered receipt errors = %v, want hash mismatch", errors)
	}
}

func TestExtractionV1Golden(t *testing.T) {
	raw, allowlist := validExtractionJSON(t)
	receipt, errs := DecodeAndNormalizeV1(raw, allowlist)
	if len(errs) != 0 {
		t.Fatal(errs)
	}
	got, err := json.MarshalIndent(struct {
		NormalizationVersion string          `json:"normalization_version"`
		CanonicalExtraction  json.RawMessage `json:"canonical_extraction"`
		ReceiptHash          string          `json:"receipt_hash"`
	}{receipt.NormalizationVersion, receipt.CanonicalExtraction, receipt.ReceiptHash}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile("testdata/extraction_v1.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(append(got, '\n'), want) {
		t.Fatalf("golden mismatch\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

func TestDecodeAndNormalizeV1RejectsClosedSchemaAndUnsafeValues(t *testing.T) {
	base, allowlist := validExtractionJSON(t)
	var valid ExtractionV1
	if err := json.Unmarshal(base, &valid); err != nil {
		t.Fatal(err)
	}
	encode := func(mutator func(*ExtractionV1)) []byte {
		clone := deepCloneExtraction(t, valid)
		mutator(&clone)
		encoded, err := json.Marshal(clone)
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}
	tests := []struct {
		name string
		raw  []byte
		code ValidationCode
	}{
		{"unknown top-level field", bytes.Replace(base, []byte(`"summary":`), []byte(`"confidence":0.9,"summary":`), 1), CodeUnknownField},
		{"unknown nested field", bytes.Replace(base, []byte(`"kind":"promote"`), []byte(`"kind":"promote","confidence":1`), 1), CodeUnknownField},
		{"duplicate top-level key", bytes.Replace(base, []byte(`"summary":`), []byte(`"summary":"duplicate","summary":`), 1), CodeDuplicateKey},
		{"duplicate nested key", bytes.Replace(base, []byte(`"kind":"promote"`), []byte(`"kind":"promote","kind":"invite"`), 1), CodeDuplicateKey},
		{"trailing JSON", append(append([]byte(nil), base...), []byte(` {}`)...), CodeTrailingJSON},
		{"invalid UTF-8", append([]byte(`{"summary":"`), 0xff), CodeInvalidText},
		{"escaped control text", bytes.Replace(base, []byte("Workflow automation launches"), []byte(`Workflow\nautomation launches`), 1), CodeInvalidText},
		{"lone surrogate", bytes.Replace(base, []byte("Workflow automation launches"), []byte(`Workflow \ud800 automation launches`), 1), CodeInvalidText},
		{"bogus action ref", encode(func(v *ExtractionV1) { v.PrimaryAction.ActionID = "../action" }), CodeInvalidReference},
		{"outside evidence allowlist", encode(func(v *ExtractionV1) { v.CoreClaim.EvidenceIDs = []string{"blk_unknown"} }), CodeEvidenceNotAllowed},
		{"URL credentials", encode(func(v *ExtractionV1) { v.PrimaryAction.CanonicalURL = "https://user:pass@example.test/x" }), CodeURLCredentials},
		{"URL fragment", encode(func(v *ExtractionV1) { v.PrimaryAction.CanonicalURL = "https://example.test/x#fragment" }), CodeURLFragment},
		{"unsafe URL scheme", encode(func(v *ExtractionV1) { v.PrimaryAction.CanonicalURL = "javascript:alert(1)" }), CodeInvalidURL},
		{"encoded URL control", encode(func(v *ExtractionV1) { v.PrimaryAction.CanonicalURL = "https://example.test/a%0Ab" }), CodeInvalidURL},
		{"invalid datetime", encode(func(v *ExtractionV1) { factByID(v, "deadline").Normalized = "tomorrow" }), CodeInvalidDateTime},
		{"unknown timezone", encode(func(v *ExtractionV1) { factByID(v, "deadline").Timezone = "Mars/Olympus" }), CodeTimezoneUnknown},
		{"timezone offset mismatch", encode(func(v *ExtractionV1) { factByID(v, "deadline").Normalized = "2026-08-14T16:00:00Z" }), CodeTimezoneOffset},
		{"invalid currency", encode(func(v *ExtractionV1) { factByID(v, "price").Currency = "ZZZ" }), CodeInvalidCurrency},
		{"money carries unit", encode(func(v *ExtractionV1) { factByID(v, "price").Unit = "rupees" }), CodeValueTypeMismatch},
		{"decimal exponent", encode(func(v *ExtractionV1) { factByID(v, "price").Normalized = "1e3" }), CodeInvalidDecimal},
		{"negative quantity", encode(func(v *ExtractionV1) { factByID(v, "capacity").Normalized = "-1" }), CodeNumberOutOfRange},
		{"percentage too large", encode(func(v *ExtractionV1) {
			fact := factByID(v, "capacity")
			fact.Type, fact.Normalized, fact.Unit = factcontract.FactTypePercentage, "101", "%"
		}), CodeNumberOutOfRange},
		{"oversized raw summary", encode(func(v *ExtractionV1) { v.Summary = "Launch" + strings.Repeat(" ", maxSummaryRunes+1) + "summary" }), CodeTextTooLong},
		{"null facts", encode(func(v *ExtractionV1) { v.Facts = nil }), CodeRequired},
		{"duplicate fact id", encode(func(v *ExtractionV1) { v.Facts = append(v.Facts, v.Facts[0]) }), CodeDuplicate},
		{"duplicate evidence id", encode(func(v *ExtractionV1) { v.CoreClaim.EvidenceIDs = []string{"blk_claim", "blk_claim"} }), CodeDuplicate},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, errs := DecodeAndNormalizeV1(test.raw, allowlist)
			if !errs.HasCode(test.code) {
				t.Fatalf("errors = %v, want code %s\nraw=%s", errs, test.code, test.raw)
			}
		})
	}
}

func TestDecodeAndNormalizeV1CanonicalizesPercentageAndReplyDiscriminators(t *testing.T) {
	raw, allowlist := validExtractionJSON(t)
	var extraction ExtractionV1
	_ = json.Unmarshal(raw, &extraction)
	percentage := factByID(&extraction, "capacity")
	percentage.Type, percentage.Raw, percentage.Normalized, percentage.Unit = factcontract.FactTypePercentage, "50 percent", "050.000", "percentage"
	extraction.PrimaryAction.Role = factcontract.PrimaryActionReply
	extraction.PrimaryAction.CanonicalURL = ""
	encoded, _ := json.Marshal(extraction)
	receipt, errs := DecodeAndNormalizeV1(encoded, allowlist)
	if len(errs) != 0 {
		t.Fatalf("errors = %v", errs)
	}
	got := factByID(&receipt.Extraction, "capacity")
	if got.Normalized != "50" || got.Unit != "%" || receipt.Extraction.PrimaryAction.CanonicalURL != "" {
		t.Fatalf("typed normalization = %#v action=%#v", got, receipt.Extraction.PrimaryAction)
	}
}

func TestDecodeAndNormalizeV1BoundsInputAndArrays(t *testing.T) {
	tooLarge := bytes.Repeat([]byte{' '}, MaxExtractionBytes+1)
	if _, errs := DecodeAndNormalizeV1(tooLarge, nil); !errs.HasCode(CodeInputTooLarge) {
		t.Fatalf("oversized errors = %v", errs)
	}
	raw, allowlist := validExtractionJSON(t)
	var extraction ExtractionV1
	_ = json.Unmarshal(raw, &extraction)
	prototype := extraction.UnsupportedClaims[0]
	extraction.UnsupportedClaims = make([]UnsupportedClaim, maxUnsupportedClaims+1)
	for index := range extraction.UnsupportedClaims {
		item := prototype
		item.Statement = item.Statement + " " + decimalIndex(index)
		extraction.UnsupportedClaims[index] = item
	}
	encoded, _ := json.Marshal(extraction)
	if _, errs := DecodeAndNormalizeV1(encoded, allowlist); !errs.HasCode(CodeLimitExceeded) {
		t.Fatalf("array bound errors = %v", errs)
	}
}

func validExtractionJSON(t *testing.T) ([]byte, []string) {
	t.Helper()
	extraction := ExtractionV1{
		SchemaVersion: 1,
		Summary:       "  Ｌaunch   is on 14 August at 4 PM IST.  ",
		PrimaryIntent: ExtractedIntent{Kind: factcontract.IntentPromote, Value: "Reserve a seat for the workflow launch", EvidenceIDs: []string{"blk_claim", "blk_intro"}},
		CoreClaim:     ExtractedStatement{Value: "Workflow automation launches on 14 August", EvidenceIDs: []string{"blk_claim"}},
		PrimaryAction: ExtractedAction{
			ActionID: "reserve_seat", BlockID: "blk_cta", Role: factcontract.PrimaryActionRegister,
			Label: "Reserve my seat", CanonicalURL: "HTTPS://EXAMPLE.TEST/events/launch?utm_source=email&seat=founder&fbclid=tracking",
			EvidenceIDs: []string{"blk_cta"},
		},
		Facts: []ExtractedFact{
			{FactID: "price", Type: factcontract.FactTypeMoney, Raw: "₹1,499.50", Normalized: "001499.5000", Currency: "inr", EvidenceIDs: []string{"blk_price"}},
			{FactID: "deadline", Type: factcontract.FactTypeDateTime, Raw: "14 August, 4 PM IST", Normalized: "2026-08-14T16:00:00.000+05:30", Timezone: "Asia/Kolkata", EvidenceIDs: []string{"blk_deadline"}},
			{FactID: "feature", Type: factcontract.FactTypeText, Raw: "Workflow automation included", Normalized: "Workflow automation is included", EvidenceIDs: []string{"blk_feature"}},
			{FactID: "capacity", Type: factcontract.FactTypeQuantity, Raw: "100 seats", Normalized: "0100.0", Unit: "seats", EvidenceIDs: []string{"blk_capacity"}},
			{FactID: "details_url", Type: factcontract.FactTypeURL, Raw: "Event details", Normalized: "https://example.test/events/launch?utm_medium=email&seat=founder", EvidenceIDs: []string{"blk_cta"}},
		},
		UnsupportedClaims: []UnsupportedClaim{{Statement: "Every customer is guaranteed to double revenue", EvidenceIDs: []string{"blk_claim"}}},
		Ambiguities:       []Ambiguity{{Field: "price", Description: "Taxes are not stated", EvidenceIDs: []string{"blk_price"}}},
	}
	raw, err := json.Marshal(extraction)
	if err != nil {
		t.Fatal(err)
	}
	allowlist := []string{"blk_intro", "blk_claim", "blk_cta", "blk_price", "blk_deadline", "blk_feature", "blk_capacity"}
	return raw, allowlist
}

func deepCloneExtraction(t *testing.T, value ExtractionV1) ExtractionV1 {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var clone ExtractionV1
	if err := json.Unmarshal(raw, &clone); err != nil {
		t.Fatal(err)
	}
	return clone
}

func factByID(value *ExtractionV1, id factcontract.FactID) *ExtractedFact {
	for index := range value.Facts {
		if value.Facts[index].FactID == id {
			return &value.Facts[index]
		}
	}
	panic("test fact not found: " + id)
}

func decimalIndex(value int) string {
	const digits = "0123456789"
	if value < 10 {
		return string(digits[value])
	}
	return decimalIndex(value/10) + string(digits[value%10])
}

func FuzzDecodeAndNormalizeV1(f *testing.F) {
	seed, allowlist := validExtractionJSONForFuzz()
	f.Add(seed)
	f.Add([]byte(`{"summary":"x"}`))
	f.Add([]byte{0xff, 0xfe})
	f.Add([]byte(`{"a":1,"a":2}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		receipt, errs := DecodeAndNormalizeV1(raw, allowlist)
		if len(errs) == 0 {
			if verify := VerifyExtractionReceiptV1(receipt); len(verify) != 0 {
				t.Fatalf("successful decode made unverifiable receipt: %v", verify)
			}
			if !json.Valid(receipt.CanonicalExtraction) {
				t.Fatal("successful decode made invalid canonical JSON")
			}
		}
	})
}

func validExtractionJSONForFuzz() ([]byte, []string) {
	// Kept independent of testing.T so the fuzz seed can be assembled before
	// the fuzz callback starts.
	extraction := ExtractionV1{
		SchemaVersion: 1, Summary: "Launch summary",
		PrimaryIntent: ExtractedIntent{Kind: factcontract.IntentInform, Value: "Launch information", EvidenceIDs: []string{"blk_1"}},
		CoreClaim:     ExtractedStatement{Value: "Launch is Friday", EvidenceIDs: []string{"blk_1"}},
		PrimaryAction: ExtractedAction{ActionID: "view", BlockID: "blk_2", Role: factcontract.PrimaryActionNavigate, Label: "View", CanonicalURL: "https://example.test/", EvidenceIDs: []string{"blk_2"}},
		Facts:         []ExtractedFact{}, UnsupportedClaims: []UnsupportedClaim{}, Ambiguities: []Ambiguity{},
	}
	raw, _ := json.Marshal(extraction)
	return raw, []string{"blk_1", "blk_2"}
}
