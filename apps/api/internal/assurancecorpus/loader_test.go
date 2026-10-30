// SPDX-License-Identifier: AGPL-3.0-only

package assurancecorpus

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/postwave/postwave/apps/api/internal/campaignchecks"
)

func TestEmbeddedCorpusLoadsWithRequiredCoverageAndNoPII(t *testing.T) {
	corpus, err := LoadEmbedded()
	if err != nil {
		t.Fatalf("load embedded corpus: %v", err)
	}
	// Pinned deliberately: corpus growth is the lever that makes a
	// false-positive acceptance target reachable, so it must be a conscious
	// edit rather than a file somebody dropped in.
	if len(corpus.Cases) != 150 {
		t.Fatalf("case count = %d, want 150", len(corpus.Cases))
	}
	if len(corpus.ManifestSHA256) != 64 || len(corpus.TaxonomySHA256) != 64 {
		t.Fatalf("invalid corpus receipt hashes: %q %q", corpus.ManifestSHA256, corpus.TaxonomySHA256)
	}
	for _, item := range corpus.Cases {
		if len(item.Raw) == 0 || len(item.Raw) > MaxMessageBytes {
			t.Errorf("case %s raw bytes = %d", item.Definition.ID, len(item.Raw))
		}
		digest := sha256.Sum256(item.Raw)
		if item.SHA256 != hex.EncodeToString(digest[:]) {
			t.Errorf("case %s digest mismatch", item.Definition.ID)
		}
		if item.Definition.MIMEExpectation == MIMEValid && !item.MIME.Valid {
			t.Errorf("case %s should be valid: %+v", item.Definition.ID, item.MIME)
		}
	}
	malformed, ok := corpus.CaseByID("malformed_multipart")
	if !ok || malformed.MIME.Valid || malformed.MIME.ErrorCode == "" {
		t.Fatalf("malformed fixture was not retained as expected-invalid: %+v", malformed.MIME)
	}
	preheader, _ := corpus.CaseByID("compiler_preheader_allowlist")
	if !preheader.Definition.RequiresCompilerReceipt {
		t.Fatal("preheader allowlist case does not require a compiler receipt")
	}
	receipt, err := corpus.ReceiptForCase("compiler_preheader_allowlist")
	if err != nil {
		t.Fatal(err)
	}
	if receipt.CorpusVersion != corpus.Manifest.CorpusVersion || receipt.CaseID != preheader.Definition.ID || receipt.MessageSHA256 != preheader.SHA256 {
		t.Fatalf("invalid case receipt: %+v", receipt)
	}
	tampered := corpus
	tampered.Cases = append([]LoadedCase(nil), corpus.Cases...)
	for index := range tampered.Cases {
		if tampered.Cases[index].Definition.ID == "compiler_preheader_allowlist" {
			tampered.Cases[index].Raw = append([]byte(nil), tampered.Cases[index].Raw...)
			tampered.Cases[index].Raw[0] = 'X'
		}
	}
	if _, err := tampered.ReceiptForCase("compiler_preheader_allowlist"); err == nil {
		t.Fatal("tampered case accepted its stale receipt hash")
	}
}

func TestCorpusFindingTaxonomyExactlyTracksCampaignChecksCatalog(t *testing.T) {
	corpus, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	catalog := map[string]campaignchecks.FindingDefinition{}
	for _, definition := range campaignchecks.FindingDefinitions() {
		catalog[definition.Code] = definition
	}
	for _, expected := range corpus.Taxonomy.Findings {
		actual, ok := catalog[expected.Code]
		if !ok {
			t.Errorf("taxonomy code %s missing from campaignchecks", expected.Code)
			continue
		}
		if expected.Dimension != actual.Dimension || !equalFeatures(expected.Features, actual.Features) {
			t.Errorf("taxonomy code %s drifted: expected %+v actual %+v", expected.Code, expected, actual)
		}
	}
}

func TestEvaluateReportUsesRealDetectorVersionAndAssertions(t *testing.T) {
	corpus, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	report := campaignchecks.Report{
		DetectorVersion: campaignchecks.DetectorVersion,
		PolicyVersion:   campaignchecks.DefaultPolicyVersion,
		Capabilities: []campaignchecks.Capability{
			{ID: "image_ocr", Status: campaignchecks.CapabilityUnavailable},
			{ID: "model_comprehension", Status: campaignchecks.CapabilityUnavailable},
		},
		Findings: []campaignchecks.Finding{
			{Code: "HIDDEN_PROMPT_MANIPULATION", DetectorVersion: campaignchecks.DetectorVersion, PolicyVersion: campaignchecks.DefaultPolicyVersion},
			{Code: "HIDDEN_TEXT_DETECTED", DetectorVersion: campaignchecks.DetectorVersion, PolicyVersion: campaignchecks.DefaultPolicyVersion},
		},
	}
	caseItem, _ := corpus.CaseByID("hidden_prompt_display_none")
	evaluation, err := corpus.EvaluateReport("hidden_prompt_display_none", caseItem.SHA256, report)
	if err != nil {
		t.Fatal(err)
	}
	if !evaluation.Passes() {
		t.Fatalf("expected report to pass: %+v", evaluation)
	}

	report.DetectorVersion = "unversioned"
	if _, err := corpus.EvaluateReport("hidden_prompt_display_none", caseItem.SHA256, report); err == nil {
		t.Fatal("unversioned detector report accepted")
	}

	report.DetectorVersion = campaignchecks.DetectorVersion
	report.Findings = []campaignchecks.Finding{{Code: "HIDDEN_TEXT_DETECTED", DetectorVersion: campaignchecks.DetectorVersion, PolicyVersion: campaignchecks.DefaultPolicyVersion}}
	evaluation, err = corpus.EvaluateReport("hidden_prompt_display_none", caseItem.SHA256, report)
	if err != nil {
		t.Fatal(err)
	}
	if evaluation.Passes() || len(evaluation.MissingRequired) != 1 || evaluation.MissingRequired[0] != "HIDDEN_PROMPT_MANIPULATION" {
		t.Fatalf("missing required finding not reported: %+v", evaluation)
	}

	report.Findings = []campaignchecks.Finding{{Code: "MIME_MESSAGE_INVALID", DetectorVersion: campaignchecks.DetectorVersion, PolicyVersion: campaignchecks.DefaultPolicyVersion}}
	validCase, _ := corpus.CaseByID("valid_multipart")
	evaluation, err = corpus.EvaluateReport("valid_multipart", validCase.SHA256, report)
	if err != nil {
		t.Fatal(err)
	}
	if evaluation.Passes() || len(evaluation.UnexpectedFindings) != 1 {
		t.Fatalf("unexpected finding not reported: %+v", evaluation)
	}
	if _, err := corpus.EvaluateReport("valid_multipart", strings.Repeat("0", 64), report); err == nil {
		t.Fatal("report evaluated against the wrong message hash")
	}
}

func TestLoaderRejectsManifestDriftTraversalAndNonSyntheticPII(t *testing.T) {
	filesystem := embeddedAsMapFS(t)
	manifest := append([]byte(nil), filesystem["fixture/manifest.json"].Data...)
	filesystem["fixture/manifest.json"] = &fstest.MapFile{Data: bytes.Replace(manifest, []byte(`"schema_version":`), []byte(`"unknown":true,"schema_version":`), 1)}
	if _, err := LoadFS(filesystem, "fixture"); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("strict manifest decoder error = %v", err)
	}

	filesystem = embeddedAsMapFS(t)
	manifest = append([]byte(nil), filesystem["fixture/manifest.json"].Data...)
	filesystem["fixture/manifest.json"] = &fstest.MapFile{Data: bytes.Replace(manifest, []byte(`"valid_multipart.eml"`), []byte(`"../valid_multipart.eml"`), 1)}
	if _, err := LoadFS(filesystem, "fixture"); err == nil || !strings.Contains(err.Error(), "contained base-name") {
		t.Fatalf("traversal error = %v", err)
	}

	if err := validateSyntheticContent([]byte("To: customer@real-customer.co\r\n\r\nhttps://example.com")); err == nil {
		t.Fatal("non-synthetic address accepted")
	}
	if err := validateSyntheticContent([]byte("To: recipient@example.net\r\n\r\nhttps://tracker.real-customer.co/x")); err == nil {
		t.Fatal("non-synthetic URL accepted")
	}
}

func TestCaseByIDReturnsAnIndependentRawCopy(t *testing.T) {
	corpus, err := LoadEmbedded()
	if err != nil {
		t.Fatal(err)
	}
	first, _ := corpus.CaseByID("valid_multipart")
	first.Raw[0] = 'X'
	first.Definition.Tags[0] = "mutated"
	second, _ := corpus.CaseByID("valid_multipart")
	if second.Raw[0] == 'X' {
		t.Fatal("case lookup leaked mutable corpus bytes")
	}
	if second.Definition.Tags[0] == "mutated" {
		t.Fatal("case lookup leaked mutable definition slices")
	}
}

func embeddedAsMapFS(t *testing.T) fstest.MapFS {
	t.Helper()
	result := fstest.MapFS{}
	entries, err := fs.ReadDir(embeddedCorpus, "corpus/v1")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		raw, err := embeddedCorpus.ReadFile("corpus/v1/" + entry.Name())
		if err != nil {
			t.Fatal(err)
		}
		result["fixture/"+entry.Name()] = &fstest.MapFile{Data: raw}
	}
	return result
}

func FuzzValidateRFC5322(f *testing.F) {
	raw, err := embeddedCorpus.ReadFile("corpus/v1/valid_multipart.eml")
	if err != nil {
		f.Fatal(err)
	}
	f.Add(raw)
	f.Add([]byte("From: sender@example.com\r\n\r\nbody"))
	f.Fuzz(func(t *testing.T, input []byte) {
		_, _ = validateRFC5322(input)
	})
}

func FuzzDecodeCorpusManifest(f *testing.F) {
	raw, err := embeddedCorpus.ReadFile("corpus/v1/manifest.json")
	if err != nil {
		f.Fatal(err)
	}
	f.Add(raw)
	f.Add([]byte(`{"schema_version":"bad"}`))
	f.Fuzz(func(t *testing.T, input []byte) {
		if len(input) > MaxManifestBytes {
			return
		}
		var manifest Manifest
		_ = decodeStrict(input, &manifest)
	})
}
