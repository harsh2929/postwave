// SPDX-License-Identifier: MIT
//
//go:build ignore

// Command run_v0_2_0 is the v0.2.0 eval gate runner for the Diagnostician.
// It loads every case under eval/cases/*.json, runs them through a
// Diagnostician wired to the production system prompt + few-shot block +
// post-response validator, and applies two acceptance gates:
//
//  1. Overall pass rate >= 85% (>= 34/40 on the original 40-case set;
//     proportional on larger sets).
//  2. No individual scenario class below 75% pass rate.
//
// Scenario classes (mapped by case-name keyword):
//
//	auth, reputation, content, mixed, provider-specific, recovery,
//	volume, edge, b2b, proton, yahoo, post-blocklist, permission,
//	calibration, clean-baseline.
//
// Output: per-case pass/fail to stdout, aggregate to stdout, machine
// summary written to eval/results/v0.2.0.json. Exits non-zero if either
// gate fails.
//
// Run from the eval directory:
//
//	go run ./eval/run_v0_2_0.go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/postwave/postwave/services/deliverability/internal/diagnostician"
	"github.com/postwave/postwave/services/deliverability/internal/diagnostician/eval"
)

const (
	overallFloor       = 0.85
	classFloor         = 0.75
	defaultCasesDir    = "eval/cases"
	defaultResultsPath = "eval/results/v0.2.0.json"
)

// casesDirOrEnv returns DIAGNOSTICIAN_EVAL_CASES_PATH if set (cloud), or
// the in-repo proprietary mirror if present, or the default relative path.
func casesDirOrEnv() string {
	if v := os.Getenv("DIAGNOSTICIAN_EVAL_CASES_PATH"); v != "" {
		return v
	}
	cloud := "/etc/postwave/proprietary/eval/diagnostician-cases"
	if entries, err := os.ReadDir(cloud); err == nil && len(entries) > 0 {
		return cloud
	}
	cwd, err := os.Getwd()
	if err != nil {
		return defaultCasesDir
	}
	dir := cwd
	for i := 0; i < 8; i++ {
		candidate := filepath.Join(dir, "proprietary", "eval", "diagnostician-cases")
		if entries, err := os.ReadDir(candidate); err == nil && len(entries) > 0 {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return defaultCasesDir
}

func resultsPathOrEnv() string {
	if v := os.Getenv("DIAGNOSTICIAN_EVAL_RESULTS_PATH"); v != "" {
		return v
	}
	return defaultResultsPath
}

// classifier maps a case name to a scenario class. The order matters:
// the first matching keyword wins.
var classifier = []struct {
	keywords []string
	class    string
}{
	{[]string{"clean_campaign", "clean_baseline", "signals_clean"}, "clean-baseline"},
	{[]string{"proton"}, "proton"},
	{[]string{"yahoo"}, "yahoo"},
	{[]string{"post_blocklist", "post-blocklist"}, "post-blocklist"},
	{[]string{"permission"}, "permission"},
	{[]string{"calibration", "predicted_bad", "predicted_good"}, "calibration"},
	{[]string{"warmup", "recovering"}, "recovery"},
	{[]string{"small_sender", "mid_sender", "large_sender", "high_volume"}, "volume"},
	{[]string{"empty_content", "single_pixel", "transactional", "bimi_eligibility"}, "edge"},
	{[]string{"b2b"}, "b2b"},
	{[]string{"o365", "outlook", "gmail_promo", "apple_dark"}, "provider-specific"},
	{[]string{"stacked", "mixed_provider"}, "mixed"},
	{[]string{"image_heavy", "spam_trigger", "all_caps", "exclamation", "shortened_links",
		"missing_alt", "broken_html", "topic_unsubscribe", "open_click_decoupled"}, "content"},
	{[]string{"blacklist", "low_google", "low_microsoft", "ab_winner"}, "reputation"},
	{[]string{"spf", "dkim", "dmarc", "auth", "brand_new_domain"}, "auth"},
	{[]string{"did_not_open"}, "content"},
}

func classify(name string) string {
	low := strings.ToLower(name)
	for _, c := range classifier {
		for _, kw := range c.keywords {
			if strings.Contains(low, kw) {
				return c.class
			}
		}
	}
	return "uncategorised"
}

type summary struct {
	GeneratedAt time.Time              `json:"generated_at"`
	CasesDir    string                 `json:"cases_dir"`
	Total       int                    `json:"total"`
	Passed      int                    `json:"passed"`
	Accuracy    float64                `json:"accuracy"`
	OverallGate bool                   `json:"overall_gate_pass"`
	ByClass     map[string]classResult `json:"by_class"`
	ClassGate   bool                   `json:"class_gate_pass"`
	Cases       []caseResult           `json:"cases"`
}

type classResult struct {
	Total    int     `json:"total"`
	Passed   int     `json:"passed"`
	Accuracy float64 `json:"accuracy"`
	GatePass bool    `json:"gate_pass"`
}

type caseResult struct {
	Name   string `json:"name"`
	Class  string `json:"class"`
	Passed bool   `json:"passed"`
	Reason string `json:"reason,omitempty"`
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	llm := diagnostician.NewGeminiClient()
	d := diagnostician.New(llm)

	results, err := eval.Run(ctx, casesDirOrEnv(), d)
	if err != nil {
		fmt.Fprintf(os.Stderr, "eval.Run failed: %v\n", err)
		os.Exit(2)
	}
	if len(results) == 0 {
		fmt.Fprintln(os.Stderr, "no cases found under", casesDirOrEnv())
		os.Exit(2)
	}

	// Per-case classification + aggregation.
	byClass := map[string]*classResult{}
	cases := make([]caseResult, 0, len(results))
	passed := 0
	for _, r := range results {
		class := classify(r.Case)
		cr, ok := byClass[class]
		if !ok {
			cr = &classResult{}
			byClass[class] = cr
		}
		cr.Total++
		if r.Passed {
			cr.Passed++
			passed++
		}
		cases = append(cases, caseResult{
			Name:   r.Case,
			Class:  class,
			Passed: r.Passed,
			Reason: r.Reason,
		})
	}

	// Print per-case lines, sorted by name.
	sort.Slice(cases, func(i, j int) bool { return cases[i].Name < cases[j].Name })
	for _, c := range cases {
		status := "PASS"
		if !c.Passed {
			status = "FAIL"
		}
		if c.Reason != "" {
			fmt.Printf("[%s] %-44s (%s) - %s\n", status, c.Name, c.Class, c.Reason)
		} else {
			fmt.Printf("[%s] %-44s (%s)\n", status, c.Name, c.Class)
		}
	}

	// Finalise per-class accuracy and gate flags.
	classOut := make(map[string]classResult, len(byClass))
	classGatePass := true
	classNames := make([]string, 0, len(byClass))
	for name := range byClass {
		classNames = append(classNames, name)
	}
	sort.Strings(classNames)
	fmt.Println()
	fmt.Println("Per-class accuracy:")
	for _, name := range classNames {
		cr := byClass[name]
		acc := 0.0
		if cr.Total > 0 {
			acc = float64(cr.Passed) / float64(cr.Total)
		}
		gate := acc >= classFloor
		if !gate {
			classGatePass = false
		}
		cr.Accuracy = acc
		cr.GatePass = gate
		classOut[name] = *cr
		flag := "ok"
		if !gate {
			flag = "FAIL"
		}
		fmt.Printf("  %-22s %2d/%2d  %5.1f%%  [%s]\n", name, cr.Passed, cr.Total, 100*acc, flag)
	}

	overallAcc := float64(passed) / float64(len(results))
	overallGate := overallAcc >= overallFloor

	fmt.Println()
	fmt.Printf("Overall: %d / %d passed (%.1f%%) -- floor %.0f%%\n",
		passed, len(results), 100*overallAcc, 100*overallFloor)
	fmt.Printf("Class gate: every class >= %.0f%%\n", 100*classFloor)

	sum := summary{
		GeneratedAt: time.Now().UTC(),
		CasesDir:    casesDirOrEnv(),
		Total:       len(results),
		Passed:      passed,
		Accuracy:    overallAcc,
		OverallGate: overallGate,
		ByClass:     classOut,
		ClassGate:   classGatePass,
		Cases:       cases,
	}
	if err := writeResults(resultsPathOrEnv(), sum); err != nil {
		fmt.Fprintf(os.Stderr, "write results: %v\n", err)
		os.Exit(2)
	}

	if !overallGate {
		fmt.Fprintln(os.Stderr, "FAIL: overall accuracy below floor")
		os.Exit(1)
	}
	if !classGatePass {
		fmt.Fprintln(os.Stderr, "FAIL: at least one scenario class below floor")
		os.Exit(1)
	}
	fmt.Println("PASS: both gates met")
}

func writeResults(path string, s summary) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}
