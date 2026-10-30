// SPDX-License-Identifier: AGPL-3.0-only
package segments

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestCompileTextEmpty asserts the empty-input guard.
func TestCompileTextEmpty(t *testing.T) {
	if _, _, _, err := compileText("  "); err == nil {
		t.Fatal("expected error for empty text")
	}
}

// TestCompileTextUnsupported asserts a phrase that matches nothing 422s
// (returns an error) so the desktop falls back to engine=ai.
func TestCompileTextUnsupported(t *testing.T) {
	if _, _, _, err := compileText("people who like the color blue"); err == nil {
		t.Fatal("expected unsupported-text error")
	}
}

// TestCompileTextPatterns exercises the SUB-064 rules surface. Each case
// asserts the compiled leaf field + comparator (and value where it is
// load-bearing) so a pattern regression is caught precisely.
func TestCompileTextPatterns(t *testing.T) {
	cases := []struct {
		name       string
		text       string
		field      string
		comparator string
		value      any // nil = don't assert value
	}{
		{"premium", "premium subscribers", "custom.tier", "equals", "premium"},
		{"free tier", "free tier users", "custom.tier", "equals", "free"},
		{"tagged", "people tagged vip", "tag", "equals", "vip"},
		{"with tag", "subscribers with tag loyalty", "tag", "equals", "loyalty"},
		{"tag", "tag newsletter", "tag", "equals", "newsletter"},
		{"in country", "in country DE", "country", "equals", "DE"},
		{"from country", "from canada", "country", "equals", "CA"},
		{"language", "language fr", "language", "equals", "fr"},
		{"opened window", "opened in the last 14 days", "last_opened_at", "in_last_days", 14},
		{"opened weeks", "opened in the last 2 weeks", "last_opened_at", "in_last_days", 14},
		{"not opened", "have not opened in the last 30 days", "last_opened_at", "more_than_days_ago", 30},
		{"openers", "recent openers", "last_opened_at", "in_last_days", 30},
		{"clicked window", "clicked in the last 7 days", "last_clicked_at", "in_last_days", 7},
		{"clickers", "clickers", "last_clicked_at", "in_last_days", 30},
		{"never clicked", "people who never clicked", "last_clicked_at", "is_null", nil},
		{"not clicked", "have not clicked in the last 14 days", "last_clicked_at", "more_than_days_ago", 14},
		{"never opened", "never opened an email", "last_opened_at", "is_null", nil},
		{"cold", "cold subscribers", "last_event_at", "more_than_days_ago", 60},
		{"inactive", "inactive contacts", "last_event_at", "more_than_days_ago", 60},
		{"joined window", "joined in the last 3 days", "created_at", "gte", "now-3d"},
		{"signed up months", "signed up in the last 2 months", "created_at", "gte", "now-60d"},
		{"new subscribers", "new subscribers", "created_at", "gte", "now-7d"},
		{"churn risk", "subscribers at risk of churn", "predictive.churn_risk", "gte", nil},
		{"high value", "high-value customers", "predictive.total_clv_cents", "gte", nil},
		{"champions", "best customers", "rfm.segment_key", "equals", "champions"},
		{"sms consent", "people who can receive sms", "channel_consent.sms", "equals", true},
		{"unsubscribed", "unsubscribed people", "status", "equals", "blocklisted"},
		{"disabled", "disabled people", "status", "equals", "disabled"},
		{"active", "active subscribers", "status", "equals", "enabled"},
		{"email domain", "everyone at @acme.com", "email", "ends_with", "@acme.com"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ast, rationale, name, err := compileText(c.text)
			if err != nil {
				t.Fatalf("compileText(%q) errored: %v", c.text, err)
			}
			if ast["op"] != "condition" {
				t.Fatalf("op = %v, want condition", ast["op"])
			}
			if ast["field"] != c.field {
				t.Fatalf("field = %v, want %s", ast["field"], c.field)
			}
			if ast["comparator"] != c.comparator {
				t.Fatalf("comparator = %v, want %s", ast["comparator"], c.comparator)
			}
			if c.value != nil && ast["value"] != c.value {
				t.Fatalf("value = %v (%T), want %v (%T)", ast["value"], ast["value"], c.value, c.value)
			}
			if rationale == "" {
				t.Errorf("rationale should be non-empty")
			}
			if name == "" {
				t.Errorf("suggested_name should be non-empty")
			}
		})
	}
}

func TestCompileTextRejectsCompoundIntentInsteadOfDroppingClauses(t *testing.T) {
	for _, text := range []string{
		"subscribed readers who opened in the last 7 days but never clicked",
		"premium subscribers from canada",
		"active subscribers tagged vip",
		"people tagged vip or tagged trial",
		"language en or fr",
		"from canada or germany",
		"opened recently, never clicked",
		"people tagged vip tagged trial",
		"language en language fr",
		"from canada from germany",
		"active subscribers disabled subscribers",
		"subscribers except people tagged trial",
		"opened recently unless tagged internal",
	} {
		if _, _, _, err := compileText(text); err == nil || !strings.Contains(err.Error(), "multiple audience intents") {
			t.Fatalf("compileText(%q) err = %v, want compound-intent rejection", text, err)
		}
	}
}

func TestCompileTextNeverOpenedProducesExecutableAST(t *testing.T) {
	ast, _, _, err := compileText("people who never opened an email")
	if err != nil {
		t.Fatalf("compileText: %v", err)
	}
	raw, err := json.Marshal(ast)
	if err != nil {
		t.Fatalf("marshal AST: %v", err)
	}
	fragment, args, err := CompileAST(raw)
	if err != nil {
		t.Fatalf("CompileAST rejected deterministic output: %v", err)
	}
	if !strings.Contains(fragment, " IS NULL") || len(args) != 0 {
		t.Fatalf("compiled deterministic AST = %q args=%#v", fragment, args)
	}
}

func TestCompileTextProfileColumnsProduceExecutableAST(t *testing.T) {
	for _, text := range []string{"in country DE", "language fr", "joined in the last 3 days"} {
		ast, _, _, err := compileText(text)
		if err != nil {
			t.Fatalf("compileText(%q): %v", text, err)
		}
		raw, err := json.Marshal(ast)
		if err != nil {
			t.Fatalf("marshal %q: %v", text, err)
		}
		fragment, _, err := CompileAST(raw)
		if err != nil {
			t.Fatalf("CompileAST(%q): %v", text, err)
		}
		if strings.Contains(fragment, "custom_fields") {
			t.Fatalf("CompileAST(%q) fell through to custom_fields: %s", text, fragment)
		}
	}
}

// TestWindowDays pins the relative-window parser used by the engagement
// and lifecycle patterns.
func TestWindowDays(t *testing.T) {
	cases := []struct {
		text   string
		verb   string
		want   int
		wantOk bool
	}{
		{"opened in the last 14 days", "opened", 14, true},
		{"opened in the last 2 weeks", "opened", 14, true},
		{"opened in the last 3 months", "opened", 90, true},
		{"opened recently", "opened", 30, true}, // recency cue, no number
		{"opened an email", "opened", 0, false}, // verb only, no recency
		{"never clicked", "opened", 0, false},   // verb absent
		{"joined in the last 5 days", "joined", 5, true},
	}
	for _, c := range cases {
		got, ok := windowDays(c.text, c.verb)
		if ok != c.wantOk {
			t.Errorf("windowDays(%q,%q) ok = %v, want %v", c.text, c.verb, ok, c.wantOk)
			continue
		}
		if ok && got != c.want {
			t.Errorf("windowDays(%q,%q) = %d, want %d", c.text, c.verb, got, c.want)
		}
	}
}

// TestLooksLikeCountry guards the "from <x>" disambiguation so vendor
// names don't get treated as countries.
func TestLooksLikeCountry(t *testing.T) {
	for _, s := range []string{"de", "us", "canada", "germany"} {
		if !looksLikeCountry(s) {
			t.Errorf("looksLikeCountry(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"acme", "vendor", "somelongword"} {
		if looksLikeCountry(s) {
			t.Errorf("looksLikeCountry(%q) = true, want false", s)
		}
	}
}
