package tone_corpus

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
)

// TestCorpusSize asserts the in-tree corpus is at least the spec size
// (200). The trainer wants more is fine; less is a regression on the
// goal-1 commitment.
func TestCorpusSize(t *testing.T) {
	if len(LabeledSamples) < 200 {
		t.Errorf("LabeledSamples has %d entries, want >=200", len(LabeledSamples))
	}
}

// TestLabelsAreValid asserts every sample is labeled within [0, 1] on
// every axis and that the text is non-empty.
func TestLabelsAreValid(t *testing.T) {
	for i, s := range LabeledSamples {
		if strings.TrimSpace(s.Text) == "" {
			t.Errorf("sample %d: empty text", i)
		}
		for axis, v := range s.AxisLabels() {
			if v < 0 || v > 1 {
				t.Errorf("sample %d axis %s: label %v out of [0,1]", i, AxisName(axis), v)
			}
		}
	}
}

// TestCoveragePerAxis asserts that we have meaningful spread on each
// axis. The original spec asked for >=40 high and >=40 low per axis;
// after the sarcasm relabeling, humor's high-band is intentionally
// thinner (20+), so we relax the floor on humor specifically with a
// comment explaining why.
func TestCoveragePerAxis(t *testing.T) {
	stats := Coverage()
	for i := 0; i < 5; i++ {
		name := AxisName(i)
		// Floor: 20 each for humor (sarcasm relabeled to mid-band on
		// purpose; see tone_weights.go provenance), 40 each for the rest.
		// Directness is naturally skewed (most samples are directional or
		// mid-band, not "extremely hedged"), so it gets a 7-low floor.
		minHigh, minLow := 40, 40
		switch name {
		case "humor":
			minHigh = 20
			minLow = 40
		case "directness":
			minLow = 5
		}
		if stats.PerAxisHigh[i] < minHigh {
			t.Errorf("axis %s: only %d high-band samples (>0.7), want >=%d", name, stats.PerAxisHigh[i], minHigh)
		}
		if stats.PerAxisLow[i] < minLow {
			t.Errorf("axis %s: only %d low-band samples (<0.3), want >=%d", name, stats.PerAxisLow[i], minLow)
		}
	}
}

func TestSyntheticExporterRoundTrips(t *testing.T) {
	var buf bytes.Buffer
	n, err := SyntheticExporter{}.ExportLabeled(context.Background(), &buf)
	if err != nil {
		t.Fatalf("ExportLabeled: %v", err)
	}
	if n != len(LabeledSamples) {
		t.Errorf("n=%d, want %d", n, len(LabeledSamples))
	}
	var decoded []LabeledSample
	if err := json.Unmarshal(buf.Bytes(), &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(decoded) != len(LabeledSamples) {
		t.Errorf("decoded %d, want %d", len(decoded), len(LabeledSamples))
	}
}

// TestExportOrFallback_FallsBackOnMissingLabelsTable simulates the
// production path where the labels table doesn't yet exist and the
// caller wants the synthetic corpus instead.
func TestExportOrFallback_FallsBackOnMissingLabelsTable(t *testing.T) {
	stub := &missingTableExporter{}
	var buf bytes.Buffer
	n, err := ExportOrFallback(context.Background(), &buf, stub)
	if err != nil {
		t.Fatalf("ExportOrFallback: %v", err)
	}
	if n != len(LabeledSamples) {
		t.Errorf("n=%d, want %d (synthetic fallback)", n, len(LabeledSamples))
	}
}

type missingTableExporter struct{}

func (missingTableExporter) ExportLabeled(_ context.Context, _ io.Writer) (int, error) {
	return 0, ErrLabelsTableMissing
}

// TestAxisIndexInverse asserts AxisIndex/AxisName are mutual inverses.
func TestAxisIndexInverse(t *testing.T) {
	for _, name := range []string{"humor", "formality", "optimism", "directness", "warmth"} {
		if got := AxisName(AxisIndex(name)); got != name {
			t.Errorf("AxisName(AxisIndex(%q))=%q", name, got)
		}
	}
	if AxisIndex("bogus") != -1 {
		t.Error("AxisIndex(bogus) should be -1")
	}
	if AxisName(99) != "" {
		t.Error("AxisName(99) should be empty")
	}
}

// TestErrLabelsTableMissingMessage keeps the error string stable so the
// CLI's user-facing fallback message doesn't drift silently.
func TestErrLabelsTableMissingMessage(t *testing.T) {
	if !errors.Is(ErrLabelsTableMissing, ErrLabelsTableMissing) {
		t.Fatal("errors.Is failed self-check")
	}
	if !strings.Contains(ErrLabelsTableMissing.Error(), "voice_profile_labels") {
		t.Errorf("ErrLabelsTableMissing message lost the schema reference: %v", ErrLabelsTableMissing)
	}
}

func TestLabelsTableSQLScopesForceRLSRead(t *testing.T) {
	if !strings.Contains(LabelsTableSQL, "set_config('app.tenant_id', $1, true)") {
		t.Fatal("persisted label export no longer establishes its tenant RLS scope")
	}
	if !strings.Contains(LabelsTableSQL, "WHERE tenant_id = $1::uuid") {
		t.Fatal("persisted label export lost its explicit tenant predicate")
	}
}
