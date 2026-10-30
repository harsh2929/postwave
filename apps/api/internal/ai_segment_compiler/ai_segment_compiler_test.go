// SPDX-License-Identifier: AGPL-3.0-only
package ai_segment_compiler

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// fakeProvider is a hand-built test double — we don't use a mocking
// framework because Go interfaces are cheap to stub by hand and the
// fake keeps the test wiring obvious.
type fakeProvider struct {
	resp               string
	err                error
	gotSystem, gotUser string
}

func (f *fakeProvider) Complete(_ context.Context, system, user string) (string, error) {
	f.gotSystem = system
	f.gotUser = user
	return f.resp, f.err
}

func sampleRegistry() []PredicateDef {
	return []PredicateDef{
		{
			Key:         "status",
			Label:       "Subscriber status",
			Category:    "profile",
			ValueType:   "enum",
			Comparators: []string{"equals", "not_equals"},
			Options:     []string{"enabled", "disabled", "blocklisted", "unconfirmed"},
		},
		{
			Key:         "last_opened_at",
			Label:       "Last opened",
			Category:    "engagement",
			ValueType:   "datetime",
			Comparators: []string{"equals", "gt", "gte", "lt", "lte"},
		},
		{
			Key:         "last_clicked_at",
			Label:       "Last clicked",
			Category:    "engagement",
			ValueType:   "datetime",
			Comparators: []string{"equals", "gt", "gte", "lt", "lte"},
		},
	}
}

func TestBuildSystemPromptListsCatalog(t *testing.T) {
	sys := BuildSystemPrompt(sampleRegistry())
	for _, want := range []string{
		"PREDICATE CATALOG",
		"status",
		"last_opened_at",
		"last_clicked_at",
		"and, or, not",
		"now-7d",
		"ISO-8601",
		"values: enabled, disabled, blocklisted, unconfirmed",
	} {
		if !strings.Contains(sys, want) {
			t.Fatalf("system prompt missing %q.\nfull prompt:\n%s", want, sys)
		}
	}
}

func TestCompileFromNLRejectsUnknownPredicate(t *testing.T) {
	prov := &fakeProvider{
		resp: `{"op":"condition","field":"shoe_size","comparator":"equals","value":"large"}`,
	}
	_, err := CompileFromNL(context.Background(), prov, "tenant", "people with big feet", sampleRegistry())
	if err == nil {
		t.Fatal("expected validation error for unknown predicate, got nil")
	}
	if !strings.Contains(err.Error(), "unknown predicate") {
		t.Fatalf("err = %v, want unknown predicate", err)
	}
}

func TestCompileFromNLRejectsMalformedTimeWindow(t *testing.T) {
	prov := &fakeProvider{
		// "now-tomorrow" is not a valid relative window grammar.
		resp: `{"op":"condition","field":"last_opened_at","comparator":"gt","value":"now-tomorrow"}`,
	}
	_, err := CompileFromNL(context.Background(), prov, "tenant", "opens recently", sampleRegistry())
	if err == nil {
		t.Fatal("expected malformed time-window error, got nil")
	}
	if !strings.Contains(err.Error(), "malformed time window") {
		t.Fatalf("err = %v, want malformed time window", err)
	}
}

func TestCompileFromNLAcceptsValidASTAndCollectsNutritionFacts(t *testing.T) {
	prov := &fakeProvider{
		resp: `{
		  "op": "and",
		  "children": [
		    {"op":"condition","field":"last_opened_at","comparator":"gt","value":"now-7d"},
		    {"op":"not","child":{"op":"condition","field":"last_clicked_at","comparator":"gt","value":"now-7d"}}
		  ]
		}`,
	}
	out, err := CompileFromNL(context.Background(), prov, "tenant",
		"subscribers who opened in the last 7 days but haven't clicked", sampleRegistry())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(out.AST) == 0 {
		t.Fatalf("AST was empty")
	}
	if got := out.NutritionFacts.Source; got != "ai-compiler" {
		t.Fatalf("source = %q, want ai-compiler", got)
	}
	if len(out.NutritionFacts.Predicates) != 2 {
		t.Fatalf("predicates = %v, want 2 distinct", out.NutritionFacts.Predicates)
	}
	if !contains(out.NutritionFacts.Predicates, "last_opened_at") ||
		!contains(out.NutritionFacts.Predicates, "last_clicked_at") {
		t.Fatalf("predicates = %v", out.NutritionFacts.Predicates)
	}
	if !contains(out.NutritionFacts.TimeWindows, "now-7d") {
		t.Fatalf("time_windows = %v, want now-7d", out.NutritionFacts.TimeWindows)
	}
}

func TestCompileFromNLStripsCodeFences(t *testing.T) {
	prov := &fakeProvider{
		resp: "```json\n" +
			`{"op":"condition","field":"status","comparator":"equals","value":"enabled"}` +
			"\n```",
	}
	out, err := CompileFromNL(context.Background(), prov, "tenant",
		"active subscribers", sampleRegistry())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(string(out.AST), `"status"`) {
		t.Fatalf("AST did not contain expected field: %s", string(out.AST))
	}
}

func TestCompileFromNLProviderError(t *testing.T) {
	prov := &fakeProvider{err: errors.New("boom")}
	_, err := CompileFromNL(context.Background(), prov, "tenant", "anything", sampleRegistry())
	if err == nil {
		t.Fatal("expected provider error")
	}
	if !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("err = %v, want ErrProviderUnavailable", err)
	}
}

func TestCompileFromNLNilProvider(t *testing.T) {
	_, err := CompileFromNL(context.Background(), nil, "tenant", "anything", sampleRegistry())
	if !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("err = %v, want ErrProviderUnavailable for nil provider", err)
	}
}

func TestCompileFromNLEmptyPrompt(t *testing.T) {
	prov := &fakeProvider{resp: "{}"}
	_, err := CompileFromNL(context.Background(), prov, "tenant", "   ", sampleRegistry())
	if !errors.Is(err, ErrEmptyPrompt) {
		t.Fatalf("err = %v, want ErrEmptyPrompt", err)
	}
}

func TestCompileFromNLRejectsOversizedUnicodePromptWithoutTruncating(t *testing.T) {
	prov := &fakeProvider{resp: `{"op":"condition","field":"status","comparator":"equals","value":"enabled"}`}
	_, err := CompileFromNL(context.Background(), prov, "tenant", strings.Repeat("界", maxPromptCharacters+1), sampleRegistry())
	if err == nil || !strings.Contains(err.Error(), "exceeds") {
		t.Fatalf("err = %v, want character-limit rejection", err)
	}
	if prov.gotUser != "" {
		t.Fatal("oversized prompt was transmitted to the provider")
	}
}

func TestCompileFromNLRejectsUnknownOp(t *testing.T) {
	prov := &fakeProvider{
		resp: `{"op":"xor","children":[]}`,
	}
	_, err := CompileFromNL(context.Background(), prov, "tenant", "xor things", sampleRegistry())
	if err == nil {
		t.Fatal("expected unknown op error")
	}
	if !strings.Contains(err.Error(), "unknown op") {
		t.Fatalf("err = %v, want unknown op", err)
	}
}

func TestCompileFromNLRejectsBadComparator(t *testing.T) {
	prov := &fakeProvider{
		// "status" only accepts equals/not_equals per registry.
		resp: `{"op":"condition","field":"status","comparator":"gte","value":"enabled"}`,
	}
	_, err := CompileFromNL(context.Background(), prov, "tenant", "active", sampleRegistry())
	if err == nil {
		t.Fatal("expected comparator validation error")
	}
	if !strings.Contains(err.Error(), "comparator") {
		t.Fatalf("err = %v, want comparator error", err)
	}
}

func TestCompileFromNLRejectsUndeclaredEnumValue(t *testing.T) {
	prov := &fakeProvider{
		resp: `{"op":"condition","field":"status","comparator":"equals","value":"subscribed"}`,
	}
	_, err := CompileFromNL(context.Background(), prov, "tenant", "subscribed people", sampleRegistry())
	if err == nil || !strings.Contains(err.Error(), "not allowed") {
		t.Fatalf("err = %v, want enum allow-list rejection", err)
	}
}

func TestCompileFromNLRejectsEmptyOrStructurallyAmbiguousTrees(t *testing.T) {
	for _, response := range []string{
		`{"op":"and","children":[]}`,
		`{"op":"or","children":[]}`,
		`{"op":"not","child":{"op":"condition","field":"status","comparator":"equals","value":"enabled"},"children":[{"op":"condition","field":"status","comparator":"equals","value":"disabled"}]}`,
		`{"op":"condition","field":"status","comparator":"equals","value":"enabled","children":[]}`,
	} {
		prov := &fakeProvider{resp: response}
		if _, err := CompileFromNL(context.Background(), prov, "tenant", "unsafe tree", sampleRegistry()); err == nil {
			t.Fatalf("response %s unexpectedly validated", response)
		}
	}
}

func TestCompileFromNLRejectsUnknownNodeProperties(t *testing.T) {
	prov := &fakeProvider{
		resp: `{"op":"condition","field":"status","comparator":"equals","value":"enabled","sql":"TRUE"}`,
	}
	_, err := CompileFromNL(context.Background(), prov, "tenant", "enabled people", sampleRegistry())
	if err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("err = %v, want strict unknown-property rejection", err)
	}
}

func TestCompileFromNLValidatesComparatorAwareValueTypes(t *testing.T) {
	registry := append(sampleRegistry(),
		PredicateDef{Key: "score", ValueType: "number", Comparators: []string{"gt", "in"}},
		PredicateDef{Key: "consented", ValueType: "boolean", Comparators: []string{"equals"}},
		PredicateDef{Key: "last_event_at", ValueType: "engagement_date", Comparators: []string{"in_last_days", "never"}},
		PredicateDef{Key: "tags", ValueType: "tag", Comparators: []string{"contains", "added_in_last_days"}},
	)
	cases := []struct {
		name string
		resp string
	}{
		{"numeric predicate with string", `{"op":"condition","field":"score","comparator":"gt","value":"high"}`},
		{"numeric IN with string member", `{"op":"condition","field":"score","comparator":"in","value":[1,"2"]}`},
		{"boolean predicate with string", `{"op":"condition","field":"consented","comparator":"equals","value":"true"}`},
		{"window with zero days", `{"op":"condition","field":"last_event_at","comparator":"in_last_days","value":0}`},
		{"no-value comparator with value", `{"op":"condition","field":"last_event_at","comparator":"never","value":7}`},
		{"tag lifecycle missing days", `{"op":"condition","field":"tags","comparator":"added_in_last_days","value":{"tag":"vip"}}`},
		{"malformed absolute date", `{"op":"condition","field":"last_opened_at","comparator":"gt","value":"2026-99-99"}`},
		{"unexecutable date alias", `{"op":"condition","field":"last_opened_at","comparator":"gt","value":"last_7_days"}`},
		{"oversized rolling date", `{"op":"condition","field":"last_opened_at","comparator":"gt","value":"now-40000d"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			prov := &fakeProvider{resp: tc.resp}
			if _, err := CompileFromNL(context.Background(), prov, "tenant", "typed request", registry); err == nil {
				t.Fatalf("response %s unexpectedly validated", tc.resp)
			}
		})
	}
}

func TestCompileFromNLAcceptsComparatorAwareValues(t *testing.T) {
	registry := append(sampleRegistry(),
		PredicateDef{Key: "score", ValueType: "number", Comparators: []string{"gt"}},
		PredicateDef{Key: "consented", ValueType: "boolean", Comparators: []string{"equals"}},
		PredicateDef{Key: "last_event_at", ValueType: "engagement_date", Comparators: []string{"in_last_days", "never"}},
		PredicateDef{Key: "tags", ValueType: "tag", Comparators: []string{"added_in_last_days"}},
	)
	prov := &fakeProvider{resp: `{"op":"and","children":[
		{"op":"condition","field":"score","comparator":"gt","value":3.5},
		{"op":"condition","field":"consented","comparator":"equals","value":true},
		{"op":"condition","field":"last_event_at","comparator":"in_last_days","value":14},
		{"op":"condition","field":"tags","comparator":"added_in_last_days","value":{"tag":"vip","days":30}}
	]}`}
	if _, err := CompileFromNL(context.Background(), prov, "tenant", "typed request", registry); err != nil {
		t.Fatalf("valid comparator-aware AST rejected: %v", err)
	}
}

func TestCompileFromNLRejectsTotalNodeBudget(t *testing.T) {
	groups := make([]string, 0, 8)
	for group := 0; group < 8; group++ {
		children := make([]string, 0, 16)
		for i := 0; i < 16; i++ {
			children = append(children, `{"op":"condition","field":"status","comparator":"equals","value":"enabled"}`)
		}
		groups = append(groups, `{"op":"and","children":[`+strings.Join(children, ",")+`]}`)
	}
	prov := &fakeProvider{resp: `{"op":"and","children":[` + strings.Join(groups, ",") + `]}`}
	_, err := CompileFromNL(context.Background(), prov, "tenant", "large tree", sampleRegistry())
	if err == nil || !strings.Contains(err.Error(), "too many") {
		t.Fatalf("err = %v, want total-node budget rejection", err)
	}
}

func TestCompileFromNLDoesNotAcceptUnadvertisedComparatorAliases(t *testing.T) {
	prov := &fakeProvider{
		resp: `{"op":"condition","field":"status","comparator":"=","value":"enabled"}`,
	}
	_, err := CompileFromNL(context.Background(), prov, "tenant", "enabled people", sampleRegistry())
	if err == nil || !strings.Contains(err.Error(), "comparator") {
		t.Fatalf("err = %v, want registry comparator rejection", err)
	}
}

// TestCompileFromNLNestedAndOr exercises a deeper composite AST (an OR
// of two AND clauses) to confirm nested boolean composition validates and
// the NutritionFacts dedupes predicates / collects every distinct window.
func TestCompileFromNLNestedAndOr(t *testing.T) {
	prov := &fakeProvider{
		resp: `{
		  "op":"or",
		  "children":[
		    {"op":"and","children":[
		      {"op":"condition","field":"status","comparator":"equals","value":"enabled"},
		      {"op":"condition","field":"last_opened_at","comparator":"gt","value":"now-7d"}
		    ]},
		    {"op":"and","children":[
		      {"op":"condition","field":"last_clicked_at","comparator":"gte","value":"now-30d"},
		      {"op":"not","child":{"op":"condition","field":"last_opened_at","comparator":"gt","value":"now-90d"}}
		    ]}
		  ]
		}`,
	}
	out, err := CompileFromNL(context.Background(), prov, "tenant",
		"engaged or recently-clicking subscribers", sampleRegistry())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// 3 distinct predicates across the tree (status, last_opened_at, last_clicked_at).
	if len(out.NutritionFacts.Predicates) != 3 {
		t.Fatalf("predicates = %v, want 3 distinct", out.NutritionFacts.Predicates)
	}
	// 3 distinct windows: now-7d, now-30d, now-90d.
	for _, w := range []string{"now-7d", "now-30d", "now-90d"} {
		if !contains(out.NutritionFacts.TimeWindows, w) {
			t.Fatalf("time_windows = %v, missing %s", out.NutritionFacts.TimeWindows, w)
		}
	}
}

// TestCompileFromNLAcceptsISOTimestamp confirms an absolute ISO-8601
// timestamp is accepted as a window for a datetime predicate and
// collected into NutritionFacts.
func TestCompileFromNLAcceptsISOTimestamp(t *testing.T) {
	prov := &fakeProvider{
		resp: `{"op":"condition","field":"last_opened_at","comparator":"gt","value":"2026-01-01T00:00:00Z"}`,
	}
	out, err := CompileFromNL(context.Background(), prov, "tenant",
		"opened since new year", sampleRegistry())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !contains(out.NutritionFacts.TimeWindows, "2026-01-01T00:00:00Z") {
		t.Fatalf("time_windows = %v, want the ISO timestamp", out.NutritionFacts.TimeWindows)
	}
}

// TestCompileFromNLRejectsTooDeep guards the depth budget so a pathological
// model response cannot blow the validator stack.
func TestCompileFromNLRejectsTooDeep(t *testing.T) {
	// Build an AST nested far beyond maxNodeDepth.
	var sb strings.Builder
	const depth = maxNodeDepth + 5
	for i := 0; i < depth; i++ {
		sb.WriteString(`{"op":"not","child":`)
	}
	sb.WriteString(`{"op":"condition","field":"status","comparator":"equals","value":"enabled"}`)
	for i := 0; i < depth; i++ {
		sb.WriteString(`}`)
	}
	prov := &fakeProvider{resp: sb.String()}
	_, err := CompileFromNL(context.Background(), prov, "tenant", "deeply nested", sampleRegistry())
	if err == nil {
		t.Fatal("expected too-deep error")
	}
	if !strings.Contains(err.Error(), "too deep") {
		t.Fatalf("err = %v, want too deep", err)
	}
}

// TestCompileFromNLNoJSON covers the model returning prose with no JSON
// object at all.
func TestCompileFromNLNoJSON(t *testing.T) {
	prov := &fakeProvider{resp: "I'm sorry, I can't help with that."}
	_, err := CompileFromNL(context.Background(), prov, "tenant", "nonsense", sampleRegistry())
	if err == nil {
		t.Fatal("expected no-JSON error")
	}
	if !strings.Contains(err.Error(), "no JSON") {
		t.Fatalf("err = %v, want no JSON", err)
	}
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}
