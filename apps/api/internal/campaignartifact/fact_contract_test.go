// SPDX-License-Identifier: AGPL-3.0-only

package campaignartifact

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/factcontract"
)

func validFactContractJSON() json.RawMessage {
	return json.RawMessage(`{
      "schema_version": 1,
      "primary_intent": {"kind":"invite","statement":"Invite Pro customers"},
      "audience_context": {"description":"Existing Pro customers"},
      "core_claim": {"statement":"The webinar explains automation","source_block_ids":["blk_claim"]},
      "primary_action": {
        "action_id":"act_reserve","block_id":"blk_action","role":"register",
        "label":"Reserve my seat","canonical_url":"HTTPS://EXAMPLE.TEST/events/launch"
      },
      "required_facts": [{
        "id":"event_start","type":"datetime","display_value":"14 August 2026, 4 PM IST",
        "criticality":"critical","source_block_ids":["blk_fact"],
        "datetime_value":{"rfc3339":"2026-08-14T16:00:00.000+05:30","timezone":"Asia/Kolkata"}
      }],
      "forbidden_claims": [],
      "allowed_secondary_actions": ["preferences","unsubscribe"],
      "language":"en-in"
    }`)
}

func semanticTreeJSON() json.RawMessage {
	return json.RawMessage(`[
      {"id":"blk_claim","type":"paragraph","content":{"text":"The webinar explains automation"}},
      {"id":"blk_fact","type":"datetime","content":{"value":"2026-08-14T16:00:00+05:30"}},
      {"id":"blk_action","type":"action","content":{"action_id":"act_reserve"}}
    ]`)
}

func TestNormalizeFactContractFreezesCanonicalValidatedV1(t *testing.T) {
	t.Parallel()
	normalized, err := normalizeFactContract(validFactContractJSON(), SourceModeSemantic, semanticTreeJSON())
	if err != nil {
		t.Fatalf("normalize Fact Contract: %v", err)
	}
	var contract factcontract.ContractV1
	if err := json.Unmarshal(normalized, &contract); err != nil {
		t.Fatalf("decode normalized contract: %v", err)
	}
	if contract.Language != "en-IN" {
		t.Fatalf("language = %q, want canonical en-IN", contract.Language)
	}
	if contract.PrimaryAction.CanonicalURL != "https://example.test/events/launch" {
		t.Fatalf("URL = %q, want canonical host/scheme", contract.PrimaryAction.CanonicalURL)
	}
	if got := contract.RequiredFacts[0].DateTimeValue.RFC3339; got != "2026-08-14T16:00:00+05:30" {
		t.Fatalf("datetime = %q, want canonical RFC3339", got)
	}
}

func TestNormalizeFactContractAllowsExplicitNoContractState(t *testing.T) {
	t.Parallel()
	normalized, err := normalizeFactContract(json.RawMessage(` { } `), SourceModeLegacyHTML, json.RawMessage(`[]`))
	if err != nil || string(normalized) != `{}` {
		t.Fatalf("empty contract normalized=%s err=%v", normalized, err)
	}
}

func TestNormalizeFactContractRejectsUnknownFieldsAndValidationErrors(t *testing.T) {
	t.Parallel()
	unknown := validFactContractJSON()
	var value map[string]any
	if err := json.Unmarshal(unknown, &value); err != nil {
		t.Fatal(err)
	}
	value["provider_summary"] = "fabricated observation"
	unknown, _ = json.Marshal(value)
	if _, err := normalizeFactContract(unknown, SourceModeSemantic, semanticTreeJSON()); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("unknown field error = %v, want ErrInvalidInput", err)
	}

	invalid := validFactContractJSON()
	value = nil
	if err := json.Unmarshal(invalid, &value); err != nil {
		t.Fatal(err)
	}
	value["language"] = "not_a_language"
	invalid, _ = json.Marshal(value)
	_, err := normalizeFactContract(invalid, SourceModeSemantic, semanticTreeJSON())
	var validationErr *FactContractValidationError
	if !errors.As(err, &validationErr) || !validationErr.Errors.HasCode(factcontract.CodeInvalidLanguage) {
		t.Fatalf("validation error = %v, want invalid-language receipt", err)
	}
}

func TestNormalizeFactContractRejectsMissingSemanticReferences(t *testing.T) {
	t.Parallel()
	_, err := normalizeFactContract(validFactContractJSON(), SourceModeSemantic,
		json.RawMessage(`[{"id":"blk_action"}]`))
	var referenceErr *FactContractReferenceError
	if !errors.As(err, &referenceErr) {
		t.Fatalf("reference error = %v, want FactContractReferenceError", err)
	}
	want := []string{"blk_claim", "blk_fact"}
	if len(referenceErr.MissingBlockIDs) != len(want) {
		t.Fatalf("missing IDs = %#v, want %#v", referenceErr.MissingBlockIDs, want)
	}
	for index := range want {
		if referenceErr.MissingBlockIDs[index] != want[index] {
			t.Fatalf("missing IDs = %#v, want %#v", referenceErr.MissingBlockIDs, want)
		}
	}
}

func TestNormalizeFactContractDoesNotTreatNestedIdentifiersAsBlockIDs(t *testing.T) {
	t.Parallel()
	_, err := normalizeFactContract(validFactContractJSON(), SourceModeSemantic,
		json.RawMessage(`[
			{"id":"blk_action","content":{"action_id":"blk_claim"}},
			{"id":"blk_fact","content":{"slot":{"id":"blk_claim"}}}
		]`))
	var referenceErr *FactContractReferenceError
	if !errors.As(err, &referenceErr) {
		t.Fatalf("reference error = %v, want FactContractReferenceError", err)
	}
	if len(referenceErr.MissingBlockIDs) != 1 || referenceErr.MissingBlockIDs[0] != "blk_claim" {
		t.Fatalf("nested identifier falsely satisfied a block reference: %#v", referenceErr.MissingBlockIDs)
	}
}
