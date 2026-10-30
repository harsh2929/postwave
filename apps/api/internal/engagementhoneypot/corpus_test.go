// SPDX-License-Identifier: AGPL-3.0-only

package engagementhoneypot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	ec "github.com/postwave/postwave/apps/api/internal/engagementclassification"
)

func testFetch(index int, technique Technique) Fetch {
	at := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC).Add(time.Duration(index) * time.Minute)
	digest := sha256.Sum256([]byte(fmt.Sprintf("recipient-%d", index)))
	return Fetch{
		Claim: Claim{
			TenantID:              "8e3d1c6a-0000-4000-8000-000000000001",
			CampaignID:            "8e3d1c6a-0000-4000-8000-000000000002",
			RecipientIdentityHMAC: hex.EncodeToString(digest[:]),
			Technique:             technique,
			IssuedAt:              at.Add(-time.Hour),
		},
		Provider:   "ses",
		FetchedAt:  at,
		UserAgent:  "Mozilla/5.0 (compatible; ExampleScanner/1.0)",
		IP:         "203.0.113.10",
		ReverseDNS: "scan.example.test",
	}
}

func exportToTemp(t *testing.T, fetches []Fetch) string {
	t.Helper()
	directory := t.TempDir()
	if err := ExportCorpus(directory, CorpusOptions{
		Name:    "honeypot-2026q3",
		Version: "2026.08.17",
	}, fetches); err != nil {
		t.Fatalf("ExportCorpus: %v", err)
	}
	return directory
}

// The reason this package exists. The calibration harness demotes seed-derived
// machine labels to diagnostic because seed identity is an absolute classifier
// input, so certifying machine evidence requires a machine label on a REAL
// recipient. Before the honeypot there was no way to produce one. This test
// proves the exported corpus lands on the certifying side of that line, using
// the real loader and the real evaluator rather than a local re-reading of the
// rules.
func TestExportedHoneypotCorpusIsCertifyingNotDiagnostic(t *testing.T) {
	fetches := []Fetch{
		testFetch(1, TechniqueHTMLComment),
		testFetch(2, TechniqueDisplayNone),
		testFetch(3, TechniqueHTMLComment),
	}
	corpus, err := ec.LoadCalibrationCorpusDirectory(exportToTemp(t, fetches))
	if err != nil {
		t.Fatalf("the exported corpus did not load: %v", err)
	}
	// An empty registry on purpose: this test is about which side of the
	// certifying/diagnostic line the evidence lands on, not about whether the
	// classifier happens to catch this particular scanner.
	classifier, err := ec.NewClassifier(ec.DefaultConfig(), nil)
	if err != nil {
		t.Fatalf("NewClassifier: %v", err)
	}
	report, err := ec.EvaluateCalibration(context.Background(), classifier, permissivePolicy(), corpus)
	if err != nil {
		t.Fatalf("EvaluateCalibration: %v", err)
	}

	if report.MachineSampleCount != int64(len(fetches)) {
		t.Errorf("MachineSampleCount = %d, want %d", report.MachineSampleCount, len(fetches))
	}
	if report.ControlledSeedSampleCount != 0 {
		t.Errorf("ControlledSeedSampleCount = %d; honeypot labels come from real recipients and must never count as seeds",
			report.ControlledSeedSampleCount)
	}
	metrics := report.PerSource["ses"]
	if metrics.CertifyingSamples != int64(len(fetches)) {
		t.Errorf("CertifyingSamples = %d, want %d — the corpus landed as diagnostic and certifies nothing",
			metrics.CertifyingSamples, len(fetches))
	}
	if metrics.DiagnosticSamples != 0 {
		t.Errorf("DiagnosticSamples = %d, want 0", metrics.DiagnosticSamples)
	}
}

func TestExportRefusesANonCertifyingTechnique(t *testing.T) {
	// The last gate before evidence becomes certification. A fetch of an
	// off-screen decoy may well be a screen-reader user, and admitting it here
	// would put a human into the corpus that certifies machine recall.
	fetch := testFetch(1, TechniqueOffScreen)
	err := ExportCorpus(t.TempDir(), CorpusOptions{Name: "bad", Version: "2026.08.17"}, []Fetch{fetch})
	if err == nil {
		t.Fatal("exported a fetch whose technique cannot certify a label")
	}
	if !strings.Contains(err.Error(), string(TechniqueOffScreen)) {
		t.Errorf("error does not name the offending technique: %v", err)
	}
}

func TestExportCollapsesRepeatFetchesOfOneRecipient(t *testing.T) {
	// A scanner fetches both decoys, and retries. Every one of those is the
	// same underlying fact — this message was machine-processed — and counting
	// it three times would narrow the Wilson interval on evidence that is not
	// independent, reporting more confidence than was earned.
	first := testFetch(1, TechniqueHTMLComment)
	again := testFetch(1, TechniqueDisplayNone)
	third := testFetch(1, TechniqueHTMLComment)
	third.FetchedAt = first.FetchedAt.Add(time.Second)

	directory := exportToTemp(t, []Fetch{first, again, third})
	corpus, err := ec.LoadCalibrationCorpusDirectory(directory)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	manifest, err := corpus.Manifest(context.Background())
	if err != nil {
		t.Fatalf("manifest: %v", err)
	}
	if manifest.SampleCount != 1 {
		t.Errorf("SampleCount = %d, want 1; repeat fetches of one recipient are one observation",
			manifest.SampleCount)
	}
}

func TestExportKeepsTheEarliestFetchForARecipient(t *testing.T) {
	// The first fetch is the one closest to delivery and the one whose latency
	// relative to send is meaningful. Keeping a later retry would smear the
	// timing signal the classifier reads.
	early := testFetch(1, TechniqueHTMLComment)
	late := testFetch(1, TechniqueDisplayNone)
	late.FetchedAt = early.FetchedAt.Add(48 * time.Hour)

	directory := exportToTemp(t, []Fetch{late, early})
	raw, err := os.ReadFile(filepath.Join(directory, "examples.jsonl"))
	if err != nil {
		t.Fatalf("read examples: %v", err)
	}
	if !strings.Contains(string(raw), early.FetchedAt.UTC().Format(time.RFC3339)) {
		t.Errorf("exported example does not carry the earliest fetch time %v: %s",
			early.FetchedAt, raw)
	}
}

func TestExportedBytesCarryNoRecipientAddress(t *testing.T) {
	// A calibration corpus is copied to wherever it is analysed. It must be
	// safe to hand to someone who has no right to the mailing list.
	fetch := testFetch(1, TechniqueHTMLComment)
	fetch.UserAgent = "Mozilla/5.0"
	directory := exportToTemp(t, []Fetch{fetch})
	for _, name := range []string{"manifest.json", "examples.jsonl"} {
		raw, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if strings.Contains(string(raw), "@") {
			t.Errorf("%s contains an at-sign and may carry an address: %s", name, raw)
		}
	}
}

func TestExportRejectsAnEmptyFetchSet(t *testing.T) {
	// An empty corpus would load, evaluate, and report a machine recall of
	// nothing — a certification built on no evidence at all.
	if err := ExportCorpus(t.TempDir(), CorpusOptions{Name: "empty", Version: "2026.08.17"}, nil); err == nil {
		t.Error("exported an empty corpus")
	}
}

func permissivePolicy() ec.CalibrationPolicy {
	return ec.CalibrationPolicy{
		MinimumMachineSamples:           1,
		MinimumHumanSamples:             1,
		MinimumMachineRecall:            0.5,
		MinimumMachinePrecision:         0.5,
		MaximumFalseMachinePositiveRate: 0.5,
		ConfidenceLevel:                 0.95,
		AssumedMachinePrevalence:        0.4,
		PrevalenceEvidenceManifestHash:  strings.Repeat("0", 64),
	}
}
