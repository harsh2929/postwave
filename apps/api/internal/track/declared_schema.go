// SPDX-License-Identifier: AGPL-3.0-only
package track

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
)

// The declared half of the event contract.
//
// `PropertyTypes` and `RecordPropertyTypes` observe: they record the type each
// property first arrived as and count contradictions. That closed the
// no-signal gap and cannot close the next one, because observation has no
// opinion — the first arrival wins by accident of ordering, so a shape that was
// wrong from the start looks perfectly stable.
//
// This checks what arrived against what somebody SAID should arrive.
//
// IT LIVES HERE, next to the observation it complements, and is called from the
// same two boundaries for the same reason the type recorder is: a second copy
// would disagree about an edge — almost certainly about null, or about a
// property that is declared and absent — and the disagreement would appear as
// an event that violates on one path and passes on the other.

// Violation is one way an event failed its declaration.
type Violation struct {
	Property string
	// Want and Got are JSON type names, or "" when the violation is about
	// presence rather than type.
	Want string
	Got  string
	// Missing distinguishes "required and absent" from "present with the wrong
	// type". They are different bugs in the emitting app: one is a field nobody
	// is sending, the other a field whose meaning changed.
	Missing bool
}

func (v Violation) String() string {
	if v.Missing {
		return v.Property + ": required and absent"
	}
	return fmt.Sprintf("%s: declared %s, got %s", v.Property, v.Want, v.Got)
}

// DeclaredSchema is one active declaration.
type DeclaredSchema struct {
	Properties map[string]string
	Required   []string
}

// Validate reports how `types` departs from the declaration.
//
// UNDECLARED PROPERTIES ARE NOT VIOLATIONS. An app adding a field is the normal
// way events evolve, and flagging it would make every declaration a cage that
// breaks on the next release — the declaration says what must be there and what
// those fields mean, not what may never appear. The observed half already
// notices new properties, which is the right place for that signal.
//
// NULL IS NOT A TYPE and cannot violate one: a property arriving as null
// establishes nothing about its type, and treating it as a mismatch would make
// the report loudest about the events with the least wrong with them. This
// mirrors the rule the observed half already applies.
func (d DeclaredSchema) Validate(types map[string]string) []Violation {
	out := []Violation{}
	for _, name := range d.Required {
		if _, ok := types[name]; !ok {
			out = append(out, Violation{Property: name, Missing: true})
		}
	}
	for name, got := range types {
		want, declared := d.Properties[name]
		if !declared || want == "" || got == "" {
			continue
		}
		if want != got {
			out = append(out, Violation{Property: name, Want: want, Got: got})
		}
	}
	// Stable order so a recorded detail string does not churn between two runs
	// that found the same problems.
	sort.Slice(out, func(i, j int) bool { return out[i].Property < out[j].Property })
	return out
}

// LoadActiveSchema returns the active declaration for one event, or ok=false.
//
// A tenant with no declaration is the common case and not an error: the feature
// is opt-in per event, and treating "undeclared" as a failure would make every
// event a violation on the day the table shipped.
func LoadActiveSchema(ctx context.Context, tx pgx.Tx, tenantID, eventName string) (DeclaredSchema, bool, error) {
	var props map[string]string
	var required []string
	err := tx.QueryRow(ctx, `
SELECT properties, required
  FROM product_event_schemas
 WHERE tenant_id = $1::uuid AND event_name = $2 AND active`,
		tenantID, eventName).Scan(&props, &required)
	if err == pgx.ErrNoRows {
		return DeclaredSchema{}, false, nil
	}
	if err != nil {
		return DeclaredSchema{}, false, err
	}
	return DeclaredSchema{Properties: props, Required: required}, true, nil
}

// RecordViolations counts a failed validation against the active declaration.
//
// COUNTED, not logged per event. A tenant whose app has drifted would otherwise
// write a row per event, and the question being asked — "is this declaration
// still true?" — is answered by a count and the most recent example. The detail
// is bounded for the same reason a log line is: an event with fifty violating
// properties should not put fifty sentences in a column somebody reads in a
// table view.
//
// In the CALLER'S transaction, so the count cannot drift from the events it
// counts: a violation recorded outside the tx would survive a rolled-back
// insert and claim an event that was never stored.
func RecordViolations(ctx context.Context, tx pgx.Tx, tenantID, eventName string, violations []Violation) error {
	if len(violations) == 0 {
		return nil
	}
	parts := make([]string, 0, len(violations))
	for _, v := range violations {
		parts = append(parts, v.String())
	}
	detail := strings.Join(parts, "; ")
	if len(detail) > 500 {
		detail = detail[:497] + "..."
	}
	_, err := tx.Exec(ctx, `
UPDATE product_event_schemas
   SET violation_count = violation_count + 1,
       last_violation_at = now(),
       last_violation_detail = $3,
       updated_at = now()
 WHERE tenant_id = $1::uuid AND event_name = $2 AND active`,
		tenantID, eventName, detail)
	return err
}

// CheckDeclared is the one call a boundary makes: load, validate, record.
//
// Best-effort by contract. A declaration problem must never stop an event being
// stored — the gap this closes was the absence of a SIGNAL, not a missing
// rejection — so a caller that cannot reach the table still writes the event.
func CheckDeclared(ctx context.Context, tx pgx.Tx, tenantID, eventName string, types map[string]string) error {
	schema, ok, err := LoadActiveSchema(ctx, tx, tenantID, eventName)
	if err != nil || !ok {
		return err
	}
	return RecordViolations(ctx, tx, tenantID, eventName, schema.Validate(types))
}
