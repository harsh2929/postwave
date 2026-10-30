// SPDX-License-Identifier: AGPL-3.0-only
package campaigntemplates

import "testing"

func TestValidApprovedGroundingContent(t *testing.T) {
	if !validApprovedGroundingContent(map[string]any{
		"approved_facts":  []any{"Our event begins 12 October."},
		"approved_urls":   []any{"https://moosewave.com/event"},
		"approved_assets": []any{map[string]any{"url": "https://moosewave.com/hero.png", "alt": "Autumn launch hero"}},
	}) {
		t.Fatal("valid approved content rejected")
	}
	for _, content := range []map[string]any{
		{"approved_facts": []any{12}},
		{"approved_facts": []any{"line\nbreak"}},
		{"approved_urls": []any{"http://example.com"}},
		{"approved_urls": []any{"https://user:pass@example.com"}},
		{"approved_urls": "https://example.com"},
		{"approved_assets": []any{map[string]any{"url": "javascript:alert(1)", "alt": "Bad"}}},
	} {
		if validApprovedGroundingContent(content) {
			t.Errorf("invalid content accepted: %#v", content)
		}
	}
}

func TestGenerationContentValuesExcludesGroundingEvidence(t *testing.T) {
	values := generationContentValues(map[string]any{
		"approved_facts":  []any{"A private internal fact"},
		"approved_urls":   []any{"https://example.com"},
		"approved_assets": []any{map[string]any{"url": "https://example.com/hero.png", "alt": "Hero"}},
		"headline":        "Launch day",
	})
	if len(values) != 1 || values["headline"] != "Launch day" {
		t.Fatalf("unexpected draft merge values: %#v", values)
	}
}
