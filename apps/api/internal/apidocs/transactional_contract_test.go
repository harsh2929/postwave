// SPDX-License-Identifier: AGPL-3.0-only
package apidocs

// The Go→OpenAPI generator's output has to reach a CLIENT.
//
// `packages/openapi/generated/go-schemas.yaml` was produced by
// scripts/gen-go-schemas.go and merged into nothing — `-check` guarded a file
// no consumer had, so a Go struct could drift from the published contract and
// the gate stayed green. That is the scaffolding-without-wiring shape this repo
// keeps finding, in the tool meant to prevent exactly that.
//
// This asserts against the EMBEDDED spec (the bytes the API actually serves),
// so it fails if the merge is skipped, if the mirrors drift, or if a field is
// added to the Go struct without regenerating.

import (
	"encoding/json"
	"testing"
)

func TestTransactionalEmailRecordIsPublishedAndClosed(t *testing.T) {
	var spec struct {
		Components struct {
			Schemas map[string]json.RawMessage `json:"schemas"`
		} `json:"components"`
	}
	if err := json.Unmarshal([]byte(SpecJSON), &spec); err != nil {
		t.Fatalf("decode embedded spec: %v", err)
	}
	raw, ok := spec.Components.Schemas["TransactionalEmailRecord"]
	if !ok {
		t.Fatal("TransactionalEmailRecord is not in the served spec — the generated schema was never merged, " +
			"so the generator's output reaches no client")
	}

	var schema struct {
		Type                 string                     `json:"type"`
		AdditionalProperties *bool                      `json:"additionalProperties"`
		Properties           map[string]json.RawMessage `json:"properties"`
		Required             []string                   `json:"required"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		t.Fatalf("decode schema: %v", err)
	}
	if schema.Type != "object" {
		t.Fatalf("type = %q, want object", schema.Type)
	}
	// A permissive schema merged into the served spec makes the contract WEAKER
	// while the debt counter goes down — the worst of both.
	if schema.AdditionalProperties == nil || *schema.AdditionalProperties {
		t.Error("TransactionalEmailRecord must be closed (additionalProperties: false)")
	}

	// The two fields the intent lifecycle added. Their presence here is the
	// point: a Go struct change now shows up in the published contract.
	for _, field := range []string{
		"id", "status", "attempt_state", "external_effect", "last_error", "provider_message_id",
	} {
		if _, ok := schema.Properties[field]; !ok {
			t.Errorf("published schema is missing %q — regenerate with `pnpm regen:go-schemas` and re-merge", field)
		}
	}
}

// The 409 the intent lifecycle introduced must be documented. An undocumented
// status code is a contract an SDK cannot generate a branch for.
func TestSendEmailDocumentsTheIdempotencyConflict(t *testing.T) {
	// A path item's values are NOT all operations — `parameters` is an array —
	// so decoding it as map[string]struct fails the whole document silently
	// enough to look like "the 409 is missing". Decode lazily instead.
	var spec struct {
		Paths map[string]map[string]json.RawMessage `json:"paths"`
	}
	if err := json.Unmarshal([]byte(SpecJSON), &spec); err != nil {
		t.Fatalf("decode embedded spec: %v", err)
	}
	rawOp, ok := spec.Paths["/api/v1/emails"]["post"]
	if !ok {
		t.Fatal("POST /api/v1/emails is not in the served spec")
	}
	var op struct {
		Responses map[string]json.RawMessage `json:"responses"`
	}
	if err := json.Unmarshal(rawOp, &op); err != nil {
		t.Fatalf("decode operation: %v", err)
	}
	if _, ok := op.Responses["409"]; !ok {
		t.Error("POST /api/v1/emails returns 409 on a reused Idempotency-Key with different content, " +
			"and the spec does not say so")
	}
}
