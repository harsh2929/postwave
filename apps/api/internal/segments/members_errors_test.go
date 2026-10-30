// SPDX-License-Identifier: AGPL-3.0-only

package segments

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// A segment whose rules cannot be evaluated is answered 422 and blamed on the
// definition; a database or deadline failure while compiling it is a 500, so
// it reaches monitoring instead of telling the user to fix rules that are fine.
func TestCompileFailuresBlameTheDefinitionOnlyWhenItIsAtFault(t *testing.T) {
	composed := json.RawMessage(`{"op":"condition","field":"segment_id","comparator":"in_segment","value":"8a1f8d2e-6a57-4c2a-9d1e-3f1f4b8f6c11"}`)
	resolverFailing := func(err error) SegmentResolver {
		return SegmentResolverFunc(func(context.Context, string, string) (json.RawMessage, error) { return nil, err })
	}
	cases := []struct {
		name       string
		ast        json.RawMessage
		resolver   SegmentResolver
		definition bool
	}{
		{"unknown comparator", json.RawMessage(`{"op":"condition","field":"email","comparator":"sounds_like","value":"x"}`), resolverFailing(nil), true},
		{"referenced segment deleted", composed, resolverFailing(ErrNotFound), true},
		{"database error reading the referenced segment", composed, resolverFailing(&pgconn.PgError{Code: "57P01", Message: "terminating connection due to administrator command"}), false},
		{"deadline while reading the referenced segment", composed, resolverFailing(context.DeadlineExceeded), false},
	}
	for _, tc := range cases {
		_, err := CompilePopulation(context.Background(), tc.ast, "00000000-0000-0000-0000-000000000001", tc.resolver, DefinitionPopulation(false))
		if err == nil {
			t.Fatalf("%s: compiled without error; the case is not exercising a failure", tc.name)
		}
		if got := isDefinitionError(err); got != tc.definition {
			t.Errorf("%s: isDefinitionError(%v) = %v, want %v", tc.name, err, got, tc.definition)
		}
	}
}
