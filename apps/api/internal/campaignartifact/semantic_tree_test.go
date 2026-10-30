// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/semanticemail"
)

func TestNormalizeSemanticTreeV2NormalizesAndPreservesWarnings(t *testing.T) {
	t.Parallel()
	raw := json.RawMessage(`[
		{"id":" title ","type":" HEADING ","role":" HEADING ","version":2,
		 "content":{"heading":{"level":1,"text":{"runs":[{"kind":"text","text":"  Hello   world  "}]}}},
		 "conditions":[],"localizations":{},"provenance":{"source":" USER "}}
	]`)
	first, diagnostics, err := NormalizeSemanticTreeV2(raw, semanticemail.SchemaVersionV2)
	if err != nil {
		t.Fatal(err)
	}
	if diagnostics.HasErrors() {
		t.Fatalf("unexpected diagnostics: %v", diagnostics)
	}
	second, secondDiagnostics, err := NormalizeSemanticTreeV2(first, semanticemail.SchemaVersionV2)
	if err != nil {
		t.Fatal(err)
	}
	if string(first) != string(second) || !reflect.DeepEqual(diagnostics, secondDiagnostics) {
		t.Fatalf("normalization is not idempotent:\nfirst=%s\nsecond=%s", first, second)
	}
	if got, want := string(first), `[{"conditions":[],"content":{"heading":{"level":1,"text":{"runs":[{"kind":"text","text":" Hello world "}]}}},"id":"title","localizations":{},"provenance":{"source":"user"},"role":"heading","type":"heading","version":2}]`; got != want {
		t.Fatalf("normalized tree = %s\nwant = %s", got, want)
	}
}

func TestNormalizeSemanticTreeV2FailsClosed(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		raw    json.RawMessage
		schema int
		typed  bool
	}{
		{name: "wrong schema", raw: json.RawMessage(`[]`), schema: 1},
		{name: "unknown field", raw: json.RawMessage(`[{"id":"x","type":"paragraph","role":"body","version":2,"content":{"paragraph":{"text":{"runs":[{"kind":"text","text":"x"}]}}},"provenance":{"source":"user"},"surprise":true}]`), schema: 2},
		{name: "trailing value", raw: json.RawMessage(`[] {}`), schema: 2},
		{name: "invalid typed node", raw: json.RawMessage(`[{"id":"x","type":"action","role":"primary_action","version":2,"content":{"action":{"action_id":"go","label":"Go","canonical_url":"javascript:alert(1)"}},"provenance":{"source":"user"}}]`), schema: 2, typed: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, _, err := NormalizeSemanticTreeV2(test.raw, test.schema)
			if err == nil {
				t.Fatal("expected error")
			}
			if test.typed {
				var validation *SemanticTreeValidationError
				if !errors.As(err, &validation) || validation == nil || !validation.Diagnostics.HasErrors() {
					t.Fatalf("error = %T %v, want typed diagnostics", err, err)
				}
			} else if !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("error = %v, want ErrInvalidInput", err)
			}
		})
	}
}
