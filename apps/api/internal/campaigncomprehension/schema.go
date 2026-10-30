// SPDX-License-Identifier: AGPL-3.0-only

package campaigncomprehension

import "encoding/json"

// ExtractionJSONSchemaV1 returns an isolated copy of the closed JSON Schema
// supplied to structured-output analyzers. Runtime parsing remains authoritative
// because JSON Schema formats do not enforce URL, IANA, ISO 4217, or offset
// semantics consistently across implementations.
func ExtractionJSONSchemaV1() json.RawMessage {
	return append(json.RawMessage(nil), extractionJSONSchemaV1...)
}

var extractionJSONSchemaV1 = json.RawMessage(`{
  "$schema":"https://json-schema.org/draft/2020-12/schema",
  "$id":"https://schemas.moosewave.com/campaign-comprehension/extraction-v1.json",
  "title":"Moosewave Campaign Comprehension Extraction v1",
  "type":"object",
  "additionalProperties":false,
  "required":["schema_version","summary","primary_intent","core_claim","primary_action","facts","unsupported_claims","ambiguities","would_surface_in_digest"],
  "properties":{
    "schema_version":{"const":1},
    "summary":{"type":"string","minLength":1,"maxLength":2000},
    "primary_intent":{"$ref":"#/$defs/intent"},
    "core_claim":{"$ref":"#/$defs/statement"},
    "primary_action":{"$ref":"#/$defs/action"},
    "facts":{"type":"array","maxItems":128,"items":{"$ref":"#/$defs/fact"}},
    "unsupported_claims":{"type":"array","maxItems":64,"items":{"$ref":"#/$defs/unsupported_claim"}},
    "ambiguities":{"type":"array","maxItems":64,"items":{"$ref":"#/$defs/ambiguity"}},
    "would_surface_in_digest":{"type":"boolean"}
  },
  "$defs":{
    "reference":{
      "type":"string",
      "minLength":1,
      "maxLength":128,
      "pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"
    },
    "evidence":{
      "type":"array",
      "minItems":1,
      "maxItems":64,
      "uniqueItems":true,
      "items":{"$ref":"#/$defs/reference"}
    },
    "intent":{
      "type":"object",
      "additionalProperties":false,
      "required":["kind","value","evidence_ids"],
      "properties":{
        "kind":{"enum":["inform","invite","promote","request_action","remind","survey","transact","onboard","retain","other"]},
        "value":{"type":"string","minLength":1,"maxLength":4000},
        "evidence_ids":{"$ref":"#/$defs/evidence"}
      }
    },
    "statement":{
      "type":"object",
      "additionalProperties":false,
      "required":["value","evidence_ids"],
      "properties":{
        "value":{"type":"string","minLength":1,"maxLength":4000},
        "evidence_ids":{"$ref":"#/$defs/evidence"}
      }
    },
    "action":{
      "type":"object",
      "additionalProperties":false,
      "required":["action_id","block_id","role","label","evidence_ids"],
      "properties":{
        "action_id":{"$ref":"#/$defs/reference"},
        "block_id":{"$ref":"#/$defs/reference"},
        "role":{"enum":["navigate","register","purchase","rsvp","confirm","download","survey","reply","track"]},
        "label":{"type":"string","minLength":1,"maxLength":512},
        "canonical_url":{"type":"string","maxLength":4096,"pattern":"^[Hh][Tt][Tt][Pp][Ss]?://"},
        "evidence_ids":{"$ref":"#/$defs/evidence"}
      },
      "allOf":[
        {
          "if":{"properties":{"role":{"const":"reply"}},"required":["role"]},
          "then":{"properties":{"canonical_url":{"maxLength":0}}},
          "else":{"required":["canonical_url"],"properties":{"canonical_url":{"minLength":1}}}
        }
      ]
    },
    "fact":{
      "type":"object",
      "additionalProperties":false,
      "required":["fact_id","type","raw","normalized","evidence_ids"],
      "properties":{
        "fact_id":{"$ref":"#/$defs/reference"},
        "type":{"enum":["text","datetime","money","location","code","percentage","quantity","url"]},
        "raw":{"type":"string","minLength":1,"maxLength":4000},
        "normalized":{"type":"string","minLength":1,"maxLength":4000},
        "timezone":{"type":"string","maxLength":255},
        "currency":{"type":"string","maxLength":16},
        "unit":{"type":"string","maxLength":64},
        "evidence_ids":{"$ref":"#/$defs/evidence"}
      },
      "allOf":[
        {
          "if":{"properties":{"type":{"const":"datetime"}},"required":["type"]},
          "then":{"required":["timezone"],"properties":{"timezone":{"minLength":1},"currency":{"maxLength":0},"unit":{"maxLength":0}}}
        },
        {
          "if":{"properties":{"type":{"const":"money"}},"required":["type"]},
          "then":{"required":["currency"],"properties":{"currency":{"minLength":3},"timezone":{"maxLength":0},"unit":{"maxLength":0}}}
        },
        {
          "if":{"properties":{"type":{"enum":["percentage","quantity"]}},"required":["type"]},
          "then":{"required":["unit"],"properties":{"unit":{"minLength":1},"timezone":{"maxLength":0},"currency":{"maxLength":0}}}
        },
        {
          "if":{"properties":{"type":{"enum":["text","location","code","url"]}},"required":["type"]},
          "then":{"properties":{"timezone":{"maxLength":0},"currency":{"maxLength":0},"unit":{"maxLength":0}}}
        }
      ]
    },
    "unsupported_claim":{
      "type":"object",
      "additionalProperties":false,
      "required":["statement","evidence_ids"],
      "properties":{
        "statement":{"type":"string","minLength":1,"maxLength":4000},
        "evidence_ids":{"$ref":"#/$defs/evidence"}
      }
    },
    "ambiguity":{
      "type":"object",
      "additionalProperties":false,
      "required":["field","description","evidence_ids"],
      "properties":{
        "field":{"$ref":"#/$defs/reference"},
        "description":{"type":"string","minLength":1,"maxLength":4000},
        "evidence_ids":{"$ref":"#/$defs/evidence"}
      }
    }
  }
}`)
