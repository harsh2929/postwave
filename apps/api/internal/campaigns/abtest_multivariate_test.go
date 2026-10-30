// SPDX-License-Identifier: AGPL-3.0-only

package campaigns

import (
	"math"
	"testing"
	"time"
)

func TestParseABTestVariantConfigOffset(t *testing.T) {
	ds := map[string]any{
		"ab_test": map[string]any{
			"parent_id":                "p1",
			"variant_index":            1,
			"total_variants":           2,
			"send_time_offset_minutes": float64(60), // JSON decodes numbers as float64
		},
	}
	cfg, ok := ParseABTestVariantConfig(ds)
	if !ok {
		t.Fatal("expected a valid variant config")
	}
	if cfg.SendTimeOffsetMin != 60 {
		t.Fatalf("offset = %d, want 60", cfg.SendTimeOffsetMin)
	}
	if cfg.OffsetDuration() != time.Hour {
		t.Fatalf("OffsetDuration = %v, want 1h", cfg.OffsetDuration())
	}
}

func TestCanonicalABVariantsMirrorChildCombos(t *testing.T) {
	combos := []abCombo{
		{Subject: "Subject A", FromName: "Alice", BodyHTML: "<p>A</p>"},
		{Subject: "Subject B", FromName: "Bob", BodyHTML: "<p>B</p>", SendOffsetMin: 60},
	}
	variants := canonicalABVariants(combos)
	if len(variants) != 2 {
		t.Fatalf("variants=%d want 2", len(variants))
	}
	if variants[0].VariantLabel != "A" || variants[1].VariantLabel != "B" {
		t.Fatalf("labels=%q/%q want A/B", variants[0].VariantLabel, variants[1].VariantLabel)
	}
	if variants[1].Subject != "Subject B" || variants[1].FromName != "Bob" || variants[1].SendTimeOffsetMinutes != 60 {
		t.Fatalf("variant B did not mirror combo: %+v", variants[1])
	}
	if math.Abs(variants[0].Weight+variants[1].Weight-100) > 0.001 {
		t.Fatalf("weights do not sum to 100: %v/%v", variants[0].Weight, variants[1].Weight)
	}
}

func TestCanonicalABVariantIDFromChildMetadata(t *testing.T) {
	got := canonicalABVariantID(map[string]any{
		"ab_test": map[string]any{
			"canonical_variant_id": " 7ee4dc86-7d88-4d24-9e7e-2f54a48655b8 ",
		},
	})
	if got != "7ee4dc86-7d88-4d24-9e7e-2f54a48655b8" {
		t.Fatalf("canonical id=%q", got)
	}
	if got := canonicalABVariantID(map[string]any{}); got != "" {
		t.Fatalf("missing canonical id=%q want empty", got)
	}
}

func TestBuildABCombos(t *testing.T) {
	t.Run("subject-only falls back to scalars", func(t *testing.T) {
		combos := buildABCombos(ABTestCreateInput{
			SubjectVariants: []string{"A", "B"},
			FromName:        "Acme",
			BodyHTML:        "<p>hi</p>",
			BodyMJML:        "<mjml><mj-body /></mjml>",
			PlainText:       "hi",
		})
		if len(combos) != 2 {
			t.Fatalf("expected 2 combos, got %d", len(combos))
		}
		for _, c := range combos {
			if c.FromName != "Acme" ||
				c.BodyHTML != "<p>hi</p>" ||
				c.BodyMJML != "<mjml><mj-body /></mjml>" ||
				c.PlainText != "hi" {
				t.Errorf("scalar fallback wrong: %+v", c)
			}
		}
	})

	t.Run("cross-product over subject x from_name", func(t *testing.T) {
		combos := buildABCombos(ABTestCreateInput{
			SubjectVariants:  []string{"S1", "S2"},
			FromNameVariants: []string{"F1", "F2"},
		})
		if len(combos) != 4 {
			t.Fatalf("expected 4 combos, got %d", len(combos))
		}
		// Stable order: subject outermost.
		if combos[0].Subject != "S1" || combos[0].FromName != "F1" {
			t.Errorf("combo[0] wrong: %+v", combos[0])
		}
		if combos[3].Subject != "S2" || combos[3].FromName != "F2" {
			t.Errorf("combo[3] wrong: %+v", combos[3])
		}
	})

	t.Run("send-time offset axis carried", func(t *testing.T) {
		combos := buildABCombos(ABTestCreateInput{
			SubjectVariants:       []string{"S1", "S2"},
			SendTimeOffsetMinutes: []int{0, 60},
		})
		if len(combos) != 4 {
			t.Fatalf("expected 4 combos, got %d", len(combos))
		}
		var sawOffset bool
		for _, c := range combos {
			if c.SendOffsetMin == 60 {
				sawOffset = true
			}
		}
		if !sawOffset {
			t.Errorf("expected a 60-minute offset combo")
		}
	})
}

func TestNormalizeABTestCrossProductCap(t *testing.T) {
	// 3 subjects × 3 from_names = 9 > 8 → reject.
	in := ABTestCreateInput{
		Name:             "Test",
		AudienceListID:   "list-1",
		SubjectVariants:  []string{"a", "b", "c"},
		FromNameVariants: []string{"x", "y", "z"},
	}
	if err := normalizeABTest(&in); err == nil {
		t.Fatal("expected cross-product cap error for 9 combos")
	}

	// 2 subjects × 2 from_names = 4 ≤ 8 → ok.
	ok := ABTestCreateInput{
		Name:             "Test",
		AudienceListID:   "list-1",
		SubjectVariants:  []string{"a", "b"},
		FromNameVariants: []string{"x", "y"},
	}
	if err := normalizeABTest(&ok); err != nil {
		t.Fatalf("expected 4 combos to be allowed, got %v", err)
	}
}
