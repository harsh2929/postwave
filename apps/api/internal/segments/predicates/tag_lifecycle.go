// tag_lifecycle.go — added_in_last_days / removed_in_last_days
// comparators for the tags field. Backed by tag_history (added in
// infra/migrations/0292_tag_history.sql), which records one row per
// tag mutation with action ∈ (tag_added, tag_removed, …).
//
// The legacy tag predicate (compile.go: tagCondition) only knows
// about set-membership comparators. These two comparators answer a
// different question: "did the subscriber acquire/lose tag X within
// the last N days?" — a lifecycle window query that drives churn
// retention triggers and onboarding journeys.

package predicates

import (
	"fmt"
	"strconv"
	"strings"
)

// TagLifecycleAction is the tag_history.action value we filter on.
type TagLifecycleAction string

const (
	TagActionAdded   TagLifecycleAction = "tag_added"
	TagActionRemoved TagLifecycleAction = "tag_removed"
)

// TagLifecycleInput is the value payload for a lifecycle predicate.
// Both an object form ({"tag":"vip","days":30}) and a shorthand
// string form ("vip:30") are accepted by the parser.
type TagLifecycleInput struct {
	Tag  string
	Days int
}

// ParseLifecycleValue accepts either a string shorthand "tag:days"
// or a typed object {Tag,Days}. Returns the parsed pair.
func ParseLifecycleValue(v any) (TagLifecycleInput, error) {
	switch t := v.(type) {
	case string:
		parts := strings.SplitN(t, ":", 2)
		if len(parts) != 2 {
			return TagLifecycleInput{}, fmt.Errorf("predicates: tag lifecycle shorthand expects 'tag:days', got %q", t)
		}
		tag := strings.TrimSpace(parts[0])
		days, err := strconv.Atoi(strings.TrimSpace(parts[1]))
		if err != nil {
			return TagLifecycleInput{}, fmt.Errorf("predicates: invalid days %q in shorthand: %w", parts[1], err)
		}
		return TagLifecycleInput{Tag: tag, Days: days}, nil
	case map[string]any:
		tag, _ := t["tag"].(string)
		var days int
		switch d := t["days"].(type) {
		case float64:
			days = int(d)
		case int:
			days = d
		case string:
			parsed, err := strconv.Atoi(strings.TrimSpace(d))
			if err != nil {
				return TagLifecycleInput{}, fmt.Errorf("predicates: invalid days field %q: %w", d, err)
			}
			days = parsed
		}
		return TagLifecycleInput{Tag: strings.TrimSpace(tag), Days: days}, nil
	}
	return TagLifecycleInput{}, fmt.Errorf("predicates: unsupported tag lifecycle value type %T", v)
}

// TagLifecycleFragment returns a SQL EXISTS fragment that matches
// subscribers who have a tag_history row with the given action +
// tag name within the last N days. A zero-day window short-circuits
// to FALSE (no rows can satisfy "within 0 days") so the editor's
// transient zero state does not silently match every subscriber.
//
// Returns the fragment plus the three positional args that the
// caller should bind: (tag, action, interval-string). The fragment
// is templated with bare $1/$2/$3 placeholders so the parent
// compiler can renumber via the standard placeholder() flow.
func TagLifecycleFragment(action TagLifecycleAction, in TagLifecycleInput) (Fragment, error) {
	if in.Days <= 0 {
		return Fragment{SQL: "FALSE", Args: nil}, nil
	}
	if in.Tag == "" {
		return Fragment{}, fmt.Errorf("predicates: tag lifecycle requires a non-empty tag name")
	}
	sql := "EXISTS (SELECT 1 FROM tag_history h" +
		" WHERE h.tenant_id = subscribers.tenant_id" +
		" AND h.subscriber_id = subscribers.id" +
		" AND h.tag_name = $1" +
		" AND h.action = $2" +
		" AND h.occurred_at > now() - $3::interval)"
	interval := fmt.Sprintf("%d days", in.Days)
	return Fragment{SQL: sql, Args: []any{in.Tag, string(action), interval}}, nil
}
