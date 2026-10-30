// SPDX-License-Identifier: AGPL-3.0-only
package track

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

// The shape half of the event contract.
//
// `ValidEventName` made the NAME addressable from both ingestion boundaries.
// Nothing did the same for what the event carries, and the catalog — which
// reads like a schema registry — is a `GROUP BY event_name` that reports names
// and says nothing about contents. So the failure that actually breaks
// segmentation is the one with no signal at all: a `value` that arrives as "10"
// on Monday and 10 on Tuesday. A numeric segment condition silently stops
// matching the string rows and a revenue sum quietly drops them.
//
// This is the same shape as the naming contract and for the same reason: ONE
// derivation, called from both `POST /api/v1/track` and the warehouse importer.
// A second copy would disagree about some edge — almost certainly about null,
// or about whether 10 and 10.0 are the same type — and the disagreement would
// appear as an event whose shape is stable on one path and drifting on the
// other.

// JSON type names. Deliberately JSON's own vocabulary rather than Go's or
// Postgres's: the property arrived as JSON, the client that reads this report
// wrote JSON, and translating into a third vocabulary would mean a client
// mapping `float64` back to "number" to explain it to a person.
const (
	TypeString  = "string"
	TypeNumber  = "number"
	TypeBoolean = "boolean"
	TypeObject  = "object"
	TypeArray   = "array"
)

// PropertyTypes derives the JSON type of each top-level property.
//
// TOP-LEVEL ONLY. Recursing would make one deeply-nested object produce hundreds
// of rows and turn a summary table into a copy of the event log; the drift that
// breaks a segment condition is on the property the condition names.
//
// NULLS ARE OMITTED, not typed. A null establishes nothing about a property's
// type — it is the absence of a value. Were null recorded as a type, the first
// real value would be reported as drift, and the report would be loudest about
// the events with the least wrong with them.
//
// JSON HAS ONE NUMBER TYPE. 10 and 10.5 are both `number`. Splitting them into
// integer and float would flag ordinary data as drift on the first decimal —
// and it is the string-versus-number case that actually breaks comparison.
func PropertyTypes(propsJSON []byte) (map[string]string, error) {
	if len(propsJSON) == 0 {
		return map[string]string{}, nil
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(propsJSON, &raw); err != nil {
		// A non-object body (an array, a bare string) carries no named
		// properties. That is not an error here — the ingestion path has its own
		// opinion about what it accepts, and this must not become a second,
		// differently-worded validator.
		return map[string]string{}, nil
	}
	out := make(map[string]string, len(raw))
	for key, value := range raw {
		if key == "" || len(key) > 256 {
			// The column is bounded; a key that cannot be stored is skipped
			// rather than allowed to fail the whole recording, which would take
			// the other properties' drift down with it.
			continue
		}
		if t := jsonTypeOf(value); t != "" {
			out[key] = t
		}
	}
	return out, nil
}

// jsonTypeOf returns the JSON type of one raw value, or "" for null.
//
// Decided on the first byte rather than by unmarshalling into `any`: that would
// turn every number into a float64 and every object into a map, allocating a
// full copy of the event's payload just to learn its shape.
func jsonTypeOf(raw json.RawMessage) string {
	for _, b := range raw {
		switch b {
		case ' ', '\t', '\n', '\r':
			continue
		case '"':
			return TypeString
		case '{':
			return TypeObject
		case '[':
			return TypeArray
		case 't', 'f':
			return TypeBoolean
		case 'n':
			// null — the absence of a value. See the doc above.
			return ""
		default:
			// A leading digit or minus sign. json.Unmarshal already guaranteed
			// this is valid JSON, so nothing else can appear here.
			return TypeNumber
		}
	}
	return ""
}

// RecordPropertyTypes writes the first-seen type of each property and counts
// every later contradiction.
//
// IN THE CALLER'S TRANSACTION. Handed a tx rather than opening its own, so the
// summary cannot disagree with the log it summarises: a separate best-effort
// write fails independently, and a registry that has quietly missed an unknown
// number of events answers "has this event's shape been stable" with something
// that is not an answer. The table is built so the only way this fails is
// infrastructure — ON CONFLICT DO UPDATE, no constraint that a value could
// violate — and if the database is refusing writes then failing the event write
// too is the correct outcome rather than an extra loss.
//
// FIRST-SEEN IS THE BASELINE, and it is never overwritten. A most-common
// baseline moves: once enough of the new type arrives it becomes the baseline,
// the conflict count stops growing, and the drift vanishes from the report at
// exactly the point it has done the most damage.
func RecordPropertyTypes(ctx context.Context, tx pgx.Tx, tenantID, eventName string, types map[string]string) error {
	if tx == nil || len(types) == 0 {
		return nil
	}
	for property, jsonType := range types {
		if _, err := tx.Exec(ctx, `
INSERT INTO product_event_property_types
    (tenant_id, event_name, property, json_type)
VALUES ($1::uuid, $2, $3, $4)
ON CONFLICT (tenant_id, event_name, property) DO UPDATE
   SET last_seen_at = now(),
       -- The baseline is untouched. Only the contradiction is counted, and
       -- only when the incoming type actually differs — an unconditional
       -- increment would count every ordinary event as drift.
       conflict_count = product_event_property_types.conflict_count
                        + CASE WHEN product_event_property_types.json_type <> EXCLUDED.json_type
                               THEN 1 ELSE 0 END,
       last_conflict_type = CASE WHEN product_event_property_types.json_type <> EXCLUDED.json_type
                                 THEN EXCLUDED.json_type
                                 ELSE product_event_property_types.last_conflict_type END,
       last_conflict_at = CASE WHEN product_event_property_types.json_type <> EXCLUDED.json_type
                               THEN now()
                               ELSE product_event_property_types.last_conflict_at END`,
			tenantID, eventName, property, jsonType); err != nil {
			return err
		}
	}
	return nil
}
