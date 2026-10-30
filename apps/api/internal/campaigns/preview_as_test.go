// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"strings"
	"testing"
)

func TestIsTruthyValue(t *testing.T) {
	truthy := []any{true, "yes", "anything", 1, 3.14, "Premium"}
	falsey := []any{nil, false, "", "false", "0", "no", 0, 0.0}
	for _, v := range truthy {
		if !isTruthyValue(v) {
			t.Errorf("isTruthyValue(%v) = false, want true", v)
		}
	}
	for _, v := range falsey {
		if isTruthyValue(v) {
			t.Errorf("isTruthyValue(%v) = true, want false", v)
		}
	}
}

func TestResolveRegionsFor(t *testing.T) {
	t.Run("true branch when key truthy", func(t *testing.T) {
		body := `Hi {{#if VIP}}<b>valued member</b>{{else}}friend{{/if}}!`
		out, unresolved := resolveRegionsFor(body, func(k string) bool { return k == "VIP" })
		if !strings.Contains(out, "valued member") || strings.Contains(out, "friend") {
			t.Fatalf("expected true branch, got: %s", out)
		}
		if len(unresolved) != 0 {
			t.Errorf("expected no unresolved, got %v", unresolved)
		}
	})

	t.Run("else branch + unresolved when key falsey", func(t *testing.T) {
		body := `Hi {{#if VIP}}member{{else}}friend{{/if}}!`
		out, unresolved := resolveRegionsFor(body, func(string) bool { return false })
		if !strings.Contains(out, "friend") || strings.Contains(out, "member") {
			t.Fatalf("expected else branch, got: %s", out)
		}
		if len(unresolved) != 1 || unresolved[0] != "VIP" {
			t.Errorf("expected [VIP] unresolved, got %v", unresolved)
		}
	})

	t.Run("no-else falsey collapses to empty", func(t *testing.T) {
		body := `A{{#if X}}HIDDEN{{/if}}B`
		out, _ := resolveRegionsFor(body, func(string) bool { return false })
		if out != "AB" {
			t.Fatalf("expected 'AB', got: %q", out)
		}
	})

	t.Run("plain body untouched", func(t *testing.T) {
		body := `<p>No regions here</p>`
		out, unresolved := resolveRegionsFor(body, func(string) bool { return true })
		if out != body || unresolved != nil {
			t.Fatalf("plain body should pass through, got: %q %v", out, unresolved)
		}
	})
}
