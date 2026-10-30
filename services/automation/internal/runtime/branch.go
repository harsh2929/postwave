package runtime

import (
	"strings"
	"time"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// Evaluate evaluates a single SegmentCondition against a Subscriber. Returns
// false when the subscriber is missing fields the condition references —
// branch nodes treat "unknown" as the false leg.
//
// Supported fields:
//   - "email"
//   - "status"
//   - "tag" / "tags" (set membership)
//   - "consent_source"
//   - "custom.<name>" — anything in CustomFields
//
// Supported comparators:
//   - "eq" / "neq"
//   - "contains" / "not_contains"  (string substring; tag set membership)
//   - "gt" / "gte" / "lt" / "lte"  (numeric or RFC3339 timestamp)
//   - "exists" / "not_exists"      (presence in custom_fields)
//
// canonicalComparator maps every spelling this engine accepts onto the one the
// SQL compiler in apps/api/internal/segments uses.
//
// The two engines had genuinely different vocabularies, not just different
// names for the same set: this side knew `eq`/`neq`, that side emits
// `equals`/`not_equals`, and `starts_with`, `ends_with`, `is_null` and
// `is_not_null` existed only there. Every condition authored in the segment
// vocabulary therefore fell through to a trailing `return false` here and sent
// 100% of subscribers down the branch's false leg, reporting nothing.
var canonicalComparator = map[string]string{
	"eq": "equals", "=": "equals", "equals": "equals",
	"neq": "not_equals", "!=": "not_equals", "not_equals": "not_equals",
	"contains": "contains", "not_contains": "not_contains",
	"starts_with": "starts_with", "ends_with": "ends_with",
	"exists": "is_not_null", "is_not_null": "is_not_null",
	"not_exists": "is_null", "is_null": "is_null",
	"gt": "gt", ">": "gt", "gte": "gte", ">=": "gte",
	"lt": "lt", "<": "lt", "lte": "lte", "<=": "lte",
	// `in`/`not_in` are declared by the shared vocabulary (@postwave/schema's
	// SegmentCondition) and implemented by the SQL compiler, but were absent
	// here. A flow branch reading `Tag in [vip, gold]` therefore missed this
	// map, fell through to `return false`, and routed 100% of subscribers down
	// the FALSE leg — while the identically-worded segment matched correctly.
	// That is the same failure this package's parity fixture was created for
	// (`eq` vs `equals`), for two more comparators.
	"in": "in", "not_in": "not_in",
}

// Supported reports whether this engine implements a comparator.
//
// Exported because "the branch evaluated false" and "this engine has never
// heard of that comparator" are different facts, and collapsing them is what
// let an entire missing vocabulary look like ordinary non-matching traffic. The
// authoring side uses it to reject a condition at save time rather than
// persisting one that can only ever be false.
func Supported(comparator string) bool {
	_, ok := canonicalComparator[strings.ToLower(strings.TrimSpace(comparator))]
	return ok
}

func Evaluate(cond canonical.SegmentCondition, sub canonical.Subscriber) bool {
	if cond.Op != "" && cond.Op != "condition" {
		return false
	}
	comparator, known := canonicalComparator[strings.ToLower(strings.TrimSpace(cond.Comparator))]
	if !known {
		// An unknown comparator cannot match, so this returns false — the same
		// answer a genuinely non-matching subscriber gets, which is what makes the
		// case dangerous rather than merely wrong: every subscriber takes the
		// FALSE leg and nothing distinguishes that from a working branch.
		//
		// This used to say "Callers gate on Supported() before persisting, so
		// reaching here means a condition was stored before that check existed."
		// That is not true. Supported() has NO production caller anywhere in the
		// repo — the only references are in this package's own test. So nothing
		// stops an unsupported comparator being stored, and the reassurance made
		// the silent false look like a residual case instead of a live one.
		//
		// It was live: `in` and `not_in` are declared by the shared vocabulary and
		// compiled by the SQL segment engine, and were missing from the map above.
		// They are there now. If a caller ever DOES gate on Supported(), this
		// comment should say which one.
		return false
	}
	left, ok := resolveField(cond.Field, sub)

	switch comparator {
	case "is_not_null":
		return ok
	case "is_null":
		return !ok
	}
	if !ok {
		return false
	}

	switch comparator {
	case "equals":
		return equal(left, cond.Value)
	case "not_equals":
		return !equal(left, cond.Value)
	case "contains":
		return contains(left, cond.Value)
	case "not_contains":
		return !contains(left, cond.Value)
	case "starts_with":
		return hasAffix(left, cond.Value, true)
	case "ends_with":
		return hasAffix(left, cond.Value, false)
	case "gt":
		return compareNumeric(left, cond.Value) > 0
	case "gte":
		return compareNumeric(left, cond.Value) >= 0
	case "lt":
		return compareNumeric(left, cond.Value) < 0
	case "lte":
		return compareNumeric(left, cond.Value) <= 0
	case "in", "not_in":
		// Mirrors apps/api/internal/segments/compile.go, including its empty-list
		// rule: `IN ()` is FALSE and `NOT IN ()` is TRUE, because "member of
		// nothing" is false and "not a member of nothing" is true.
		list, decoded := listOf(cond.Value)
		if !decoded {
			// The SQL side returns an error here and the whole segment fails to
			// compile — loudly. An evaluator cannot error mid-flow, so it refuses
			// instead: a condition nobody can evaluate must not route anyone down
			// the TRUE leg, whichever of the two comparators it is.
			return false
		}
		if len(list) == 0 {
			return comparator == "not_in"
		}
		for _, want := range list {
			if equal(left, want) {
				return comparator == "in"
			}
		}
		return comparator == "not_in"
	}
	return false
}

// listOf mirrors decodeList in apps/api/internal/segments/compile.go: a real
// list, or a single comma-separated string as a convenience. Kept deliberately
// close to that function — `in` and `not_in` are the two comparators where the
// two engines have to agree about what the VALUE is before they can agree about
// the answer.
func listOf(v interface{}) ([]interface{}, bool) {
	switch t := v.(type) {
	case []interface{}:
		return t, true
	case []string:
		out := make([]interface{}, 0, len(t))
		for _, s := range t {
			out = append(out, s)
		}
		return out, true
	case string:
		parts := strings.Split(t, ",")
		out := make([]interface{}, 0, len(parts))
		for _, p := range parts {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
		return out, true
	}
	return nil, false
}

// hasAffix implements starts_with/ends_with with the SQL side's case-folding.
// Both compile to ILIKE there, so a case-sensitive match here would disagree.
func hasAffix(a, b interface{}, prefix bool) bool {
	as, aok := stringOf(a)
	bs, bok := stringOf(b)
	if !aok || !bok {
		return false
	}
	as, bs = strings.ToLower(as), strings.ToLower(bs)
	if prefix {
		return strings.HasPrefix(as, bs)
	}
	return strings.HasSuffix(as, bs)
}

func resolveField(field string, sub canonical.Subscriber) (interface{}, bool) {
	switch {
	case field == "email":
		return sub.Email, sub.Email != ""
	case field == "status":
		return string(sub.Status), sub.Status != ""
	case field == "tag" || field == "tags":
		return sub.Tags, sub.Tags != nil
	case field == "consent_source":
		return string(sub.ConsentSource), sub.ConsentSource != ""
	case strings.HasPrefix(field, "custom."):
		key := strings.TrimPrefix(field, "custom.")
		v, ok := sub.CustomFields[key]
		return v, ok
	}
	// Fallback: try as bare custom field key.
	if v, ok := sub.CustomFields[field]; ok {
		return v, true
	}
	return nil, false
}

func equal(a, b interface{}) bool {
	as, aok := stringOf(a)
	bs, bok := stringOf(b)
	if aok && bok {
		return as == bs
	}
	af, aok2 := floatOf(a)
	bf, bok2 := floatOf(b)
	if aok2 && bok2 {
		return af == bf
	}
	return false
}

// contains matches the SQL compiler, which renders `contains` as
// `ILIKE '%value%'` — a CASE-INSENSITIVE SUBSTRING test.
//
// This previously compared tags for exact equality and strings case-sensitively.
// The visible consequence: a subscriber tagged `vip-gold` satisfied the segment
// "Tag contains vip" and took the FALSE leg of an identically-worded flow
// branch. Two answers to one question the user asked once.
func contains(a, b interface{}) bool {
	bs, bok := stringOf(b)
	if !bok {
		return false
	}
	needle := strings.ToLower(bs)
	if tags, ok := a.([]string); ok {
		for _, t := range tags {
			if strings.Contains(strings.ToLower(t), needle) {
				return true
			}
		}
		return false
	}
	as, aok := stringOf(a)
	if !aok {
		return false
	}
	return strings.Contains(strings.ToLower(as), needle)
}

func compareNumeric(a, b interface{}) int {
	if af, aok := floatOf(a); aok {
		if bf, bok := floatOf(b); bok {
			switch {
			case af < bf:
				return -1
			case af > bf:
				return 1
			default:
				return 0
			}
		}
	}
	if at, aok := timeOf(a); aok {
		if bt, bok := timeOf(b); bok {
			switch {
			case at.Before(bt):
				return -1
			case at.After(bt):
				return 1
			default:
				return 0
			}
		}
	}
	return 0
}

func stringOf(v interface{}) (string, bool) {
	switch x := v.(type) {
	case string:
		return x, true
	case []byte:
		return string(x), true
	}
	return "", false
}

func floatOf(v interface{}) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	}
	return 0, false
}

func timeOf(v interface{}) (time.Time, bool) {
	s, ok := stringOf(v)
	if !ok {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}
