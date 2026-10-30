// SPDX-License-Identifier: AGPL-3.0-only

package track

import "testing"

// The validator's judgment calls, each pinned with the failure it prevents.
func TestValidateDeclaredSchema(t *testing.T) {
	schema := DeclaredSchema{
		Properties: map[string]string{"value": TypeNumber, "sku": TypeString},
		Required:   []string{"value"},
	}

	t.Run("a type that moved is a violation", func(t *testing.T) {
		// The failure this whole subsystem exists for: `value` as "10" on Monday
		// and 10 on Tuesday silently stops matching a numeric segment condition.
		got := schema.Validate(map[string]string{"value": TypeString})
		if len(got) != 1 || got[0].Want != TypeNumber || got[0].Got != TypeString {
			t.Fatalf("violations = %+v, want one number/string mismatch", got)
		}
	})

	t.Run("a required property that is absent is a violation", func(t *testing.T) {
		got := schema.Validate(map[string]string{"sku": TypeString})
		if len(got) != 1 || !got[0].Missing || got[0].Property != "value" {
			t.Fatalf("violations = %+v, want one missing-required", got)
		}
	})

	t.Run("an UNDECLARED property is not a violation", func(t *testing.T) {
		// An app adding a field is how events evolve. Flagging it would make
		// every declaration a cage that breaks on the next release, and the
		// observed half already reports new properties.
		got := schema.Validate(map[string]string{"value": TypeNumber, "brand_new": TypeString})
		if len(got) != 0 {
			t.Fatalf("violations = %+v, want none — a new field is not a breach", got)
		}
	})

	t.Run("a declared-but-optional property may be absent", func(t *testing.T) {
		got := schema.Validate(map[string]string{"value": TypeNumber})
		if len(got) != 0 {
			t.Fatalf("violations = %+v, want none — `sku` is declared, not required", got)
		}
	})

	t.Run("an empty observed type establishes nothing", func(t *testing.T) {
		// Mirrors the observed half's rule: null is not a type, so it cannot
		// contradict one. Treating it as a mismatch would make the report
		// loudest about the events with least wrong with them.
		got := schema.Validate(map[string]string{"value": ""})
		if len(got) != 0 {
			t.Fatalf("violations = %+v, want none for an unestablished type", got)
		}
	})

	t.Run("violations are ordered stably", func(t *testing.T) {
		a := schema.Validate(map[string]string{"value": TypeString, "sku": TypeNumber})
		b := schema.Validate(map[string]string{"sku": TypeNumber, "value": TypeString})
		if len(a) != 2 || len(b) != 2 || a[0].Property != b[0].Property {
			t.Fatalf("unstable order: %+v vs %+v — the recorded detail would churn "+
				"between two runs that found the same problems", a, b)
		}
	})
}
