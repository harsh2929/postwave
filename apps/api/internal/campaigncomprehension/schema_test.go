// SPDX-License-Identifier: AGPL-3.0-only

package campaigncomprehension

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestExtractionJSONSchemaV1IsClosedStableAndIsolated(t *testing.T) {
	first := ExtractionJSONSchemaV1()
	second := ExtractionJSONSchemaV1()
	if !json.Valid(first) || !bytes.Equal(first, second) {
		t.Fatal("Extraction JSON Schema v1 is invalid or unstable")
	}
	var schema map[string]any
	if err := json.Unmarshal(first, &schema); err != nil {
		t.Fatal(err)
	}
	if schema["additionalProperties"] != false || schema["type"] != "object" {
		t.Fatalf("root schema is not closed: %#v", schema)
	}
	definitions, ok := schema["$defs"].(map[string]any)
	if !ok {
		t.Fatal("schema definitions missing")
	}
	for _, name := range []string{"intent", "statement", "action", "fact", "unsupported_claim", "ambiguity"} {
		definition, ok := definitions[name].(map[string]any)
		if !ok || definition["additionalProperties"] != false {
			t.Fatalf("definition %q is not closed", name)
		}
	}
	first[0] = '!'
	if !json.Valid(ExtractionJSONSchemaV1()) {
		t.Fatal("caller mutation changed package schema")
	}
}
