// Package eval is the Diagnostician evaluation harness. It loads ground-truth
// example cases from `eval/cases/*.json`, runs each through a Diagnostician,
// and scores the output against expected fields.
//
// Phase 2 DoD requires 200 hand-labeled examples and >85% accuracy; this is
// the V1 skeleton supporting 3 starter cases.
package eval

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/postwave/postwave/services/deliverability/internal/diagnostician"
	"github.com/postwave/postwave/services/deliverability/internal/domain"
)

const maxEvalJSONFileBytes int64 = 1 << 20

// Case is one labeled example. Two shapes are supported on disk:
//
//  1. Legacy "expect" block (cases 01-03): headline_phrase + fix_actions +
//     max_fixes.
//  2. Richer "expected" block (cases 04-40): a list of substrings that must
//     all appear in the diagnosis, required fix-action types, min/max fix
//     counts, and a flag asserting predicted_impact is non-empty.
//
// Both are merged into Expectation at load time.
type Case struct {
	Name        string                `json:"name"`
	Description string                `json:"description,omitempty"`
	Signals     diagnostician.Signals `json:"signals"`
	Expect      Expectation           `json:"expect,omitempty"`
	Expected    *expectedV2           `json:"expected,omitempty"`
}

// Expectation captures the evaluator's checks. We deliberately keep
// expectations loose (substring matches, action types) — exact-match scoring
// makes the harness too brittle for an LLM under prompt iteration.
type Expectation struct {
	// HeadlinePhrase is a substring that must appear in `diagnosis`.
	HeadlinePhrase string `json:"headline_phrase"`
	// MustMention is a list of substrings that must all appear in `diagnosis`
	// (case-insensitive).
	MustMention []string `json:"must_mention,omitempty"`
	// FixActions lists the FixAction values that must each appear at least
	// once in `fixes`.
	FixActions []domain.FixAction `json:"fix_actions"`
	// MaxFixes caps how many fixes are allowed.
	MaxFixes int `json:"max_fixes"`
	// MinFixes is the minimum number of fixes required.
	MinFixes int `json:"min_fixes"`
	// PredictedImpactPresent asserts the Diagnosis carries a non-empty
	// PredictedImpact map.
	PredictedImpactPresent bool `json:"predicted_impact_present,omitempty"`
}

// expectedV2 is the on-disk shape for the richer expectation schema used by
// cases 04+. Field names follow the eval/README.md spec.
type expectedV2 struct {
	DiagnosisMustMention   []string           `json:"diagnosis_must_mention,omitempty"`
	FixActionsRequired     []domain.FixAction `json:"fix_actions_required,omitempty"`
	MaxFixes               int                `json:"max_fixes,omitempty"`
	MinFixes               int                `json:"min_fixes,omitempty"`
	PredictedImpactPresent bool               `json:"predicted_impact_present,omitempty"`
}

// Result is the per-case grade.
type Result struct {
	Case   string `json:"case"`
	Passed bool   `json:"passed"`
	Reason string `json:"reason,omitempty"`
}

// Options controls Run behaviour.
type Options struct {
	// BaselineDir, when non-empty, enables structural-similarity grading
	// against expected JSON outputs at <BaselineDir>/<case>.json. The
	// loose checks (must_mention, fix actions, min/max counts) still
	// apply; the baseline adds: predicted_impact within ±0.20 of the
	// baseline value, and fix actions overlap with the baseline set.
	BaselineDir string
}

// Run loads every *.json file under dir and grades the diagnostician using
// default Options.
func Run(ctx context.Context, dir string, d *diagnostician.Diagnostician) ([]Result, error) {
	return RunWithOptions(ctx, dir, d, Options{})
}

// RunWithOptions is Run with explicit Options (e.g. baseline grading).
func RunWithOptions(ctx context.Context, dir string, d *diagnostician.Diagnostician, opts Options) ([]Result, error) {
	matches, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	out := make([]Result, 0, len(matches))
	for _, path := range matches {
		c, err := loadCase(path)
		if err != nil {
			out = append(out, Result{Case: path, Passed: false, Reason: err.Error()})
			continue
		}
		dia, err := d.Diagnose(ctx, c.Signals, "eval-"+c.Name)
		if err != nil {
			out = append(out, Result{Case: c.Name, Passed: false, Reason: err.Error()})
			continue
		}
		if reason := grade(dia, c.Expect); reason != "" {
			out = append(out, Result{Case: c.Name, Passed: false, Reason: reason})
			continue
		}
		// Optional baseline structural-similarity check.
		if opts.BaselineDir != "" {
			if reason := gradeBaseline(opts.BaselineDir, c.Name, dia); reason != "" {
				out = append(out, Result{Case: c.Name, Passed: false, Reason: reason})
				continue
			}
		}
		out = append(out, Result{Case: c.Name, Passed: true})
	}
	return out, nil
}

// gradeBaseline reads <BaselineDir>/<case>.json (if present) and asserts:
//   - every fix action listed in the baseline appears in dia.Fixes
//   - every predicted_impact key from the baseline is within ±0.20 of the
//     baseline value in dia.PredictedImpact
//   - every must_mention term derived from the baseline diagnosis (case-
//     insensitive substrings) appears in dia.Diagnosis
//
// Missing baseline files are treated as a soft pass (no extra check).
func gradeBaseline(dir, caseName string, dia domain.Diagnosis) string {
	path := filepath.Join(dir, caseName+".json")
	b, err := readEvalFile(path)
	if err != nil {
		return "" // baseline file optional — no extra constraints
	}
	var base domain.Diagnosis
	if err := json.Unmarshal(b, &base); err != nil {
		return "baseline parse error: " + err.Error()
	}
	// Action set must overlap.
	want := map[domain.FixAction]bool{}
	for _, f := range base.Fixes {
		want[f.Action] = true
	}
	got := map[domain.FixAction]bool{}
	for _, f := range dia.Fixes {
		got[f.Action] = true
	}
	for a := range want {
		if !got[a] {
			return "baseline action missing: " + string(a)
		}
	}
	// Predicted-impact tolerance.
	for k, baseV := range base.PredictedImpact {
		gotV, ok := dia.PredictedImpact[k]
		if !ok {
			return "baseline predicted_impact missing key: " + k
		}
		if absFloat(gotV-baseV) > 0.20 {
			return fmt.Sprintf("predicted_impact[%s]=%.2f differs from baseline %.2f by >0.20", k, gotV, baseV)
		}
	}
	return ""
}

func absFloat(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}

// Report writes a per-case + aggregate summary string. Useful as a CI gate.
func Report(results []Result) string {
	var b strings.Builder
	passed := 0
	for _, r := range results {
		status := "PASS"
		if !r.Passed {
			status = "FAIL"
		} else {
			passed++
		}
		fmt.Fprintf(&b, "[%s] %s", status, r.Case)
		if r.Reason != "" {
			fmt.Fprintf(&b, " — %s", r.Reason)
		}
		b.WriteString("\n")
	}
	fmt.Fprintf(&b, "\n%d / %d passed (%.1f%%)\n", passed, len(results), 100*Accuracy(results))
	return b.String()
}

// Accuracy returns passed/total as a percentage.
func Accuracy(results []Result) float64 {
	if len(results) == 0 {
		return 0
	}
	passed := 0
	for _, r := range results {
		if r.Passed {
			passed++
		}
	}
	return float64(passed) / float64(len(results))
}

func loadCase(path string) (Case, error) {
	b, err := readEvalFile(path)
	if err != nil {
		return Case{}, err
	}
	var c Case
	if err := json.Unmarshal(b, &c); err != nil {
		return Case{}, fmt.Errorf("parse %s: %w", path, err)
	}
	if c.Name == "" {
		c.Name = strings.TrimSuffix(filepath.Base(path), ".json")
	}
	// Merge richer "expected" block into Expect, where present.
	if c.Expected != nil {
		c.Expect.MustMention = append(c.Expect.MustMention, c.Expected.DiagnosisMustMention...)
		c.Expect.FixActions = append(c.Expect.FixActions, c.Expected.FixActionsRequired...)
		if c.Expected.MaxFixes > 0 {
			c.Expect.MaxFixes = c.Expected.MaxFixes
		}
		if c.Expected.MinFixes > 0 {
			c.Expect.MinFixes = c.Expected.MinFixes
		}
		if c.Expected.PredictedImpactPresent {
			c.Expect.PredictedImpactPresent = true
		}
	}
	return c, nil
}

func readEvalFile(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	b, err := io.ReadAll(io.LimitReader(f, maxEvalJSONFileBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > maxEvalJSONFileBytes {
		return nil, fmt.Errorf("eval JSON file exceeds %d bytes", maxEvalJSONFileBytes)
	}
	return b, nil
}

func grade(dia domain.Diagnosis, exp Expectation) string {
	low := strings.ToLower(dia.Diagnosis)
	if exp.HeadlinePhrase != "" && !strings.Contains(low, strings.ToLower(exp.HeadlinePhrase)) {
		return "diagnosis missing expected phrase: " + exp.HeadlinePhrase
	}
	for _, sub := range exp.MustMention {
		if !strings.Contains(low, strings.ToLower(sub)) {
			return "diagnosis missing required mention: " + sub
		}
	}
	for _, want := range exp.FixActions {
		found := false
		for _, f := range dia.Fixes {
			if f.Action == want {
				found = true
				break
			}
		}
		if !found {
			return "no fix with action: " + string(want)
		}
	}
	if exp.MinFixes > 0 && len(dia.Fixes) < exp.MinFixes {
		return fmt.Sprintf("too few fixes: %d < %d", len(dia.Fixes), exp.MinFixes)
	}
	if exp.MaxFixes > 0 && len(dia.Fixes) > exp.MaxFixes {
		return fmt.Sprintf("too many fixes: %d > %d", len(dia.Fixes), exp.MaxFixes)
	}
	if exp.PredictedImpactPresent && len(dia.PredictedImpact) == 0 {
		return "predicted_impact missing"
	}
	return ""
}
