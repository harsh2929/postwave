// SPDX-License-Identifier: AGPL-3.0-only
//
// triggers.go — drip sequence trigger configuration plus a compatibility
// evaluator for inbound webhooks. Each Trigger row maps "incoming webhook
// event matching X" to a sequence/tag/automation action. Production ingest
// freezes matching actions into the durable intent outbox in
// action_outbox_repo.go; EvaluateTriggers remains a direct evaluator for
// isolated tests and log-only previews and is not mounted on the receive path.

package inbound_webhooks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Operator constants — keep these greppable rather than scattering
// magic strings through the codebase + UI.
const (
	OpEquals   = "equals"
	OpContains = "contains"
	OpExists   = "exists"
	OpRegex    = "regex"

	ActionAddToSequence   = "add_to_sequence"
	ActionAddTag          = "add_tag"
	ActionRemoveTag       = "remove_tag"
	ActionStartAutomation = "start_automation"
)

// Trigger is one configured rule for an inbound webhook endpoint.
type Trigger struct {
	ID             string     `json:"id"`
	TenantID       string     `json:"tenant_id"`
	WebhookID      string     `json:"webhook_id"`
	Name           string     `json:"name"`
	Active         bool       `json:"active"`
	MatchJSONPath  string     `json:"match_jsonpath"`
	MatchOperator  string     `json:"match_operator"`
	MatchValue     *string    `json:"match_value,omitempty"`
	EmailJSONPath  string     `json:"email_jsonpath"`
	ActionType     string     `json:"action_type"`
	ActionTargetID string     `json:"action_target_id"`
	FiredCount     int        `json:"fired_count"`
	LastFiredAt    *time.Time `json:"last_fired_at,omitempty"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

// ValidateOperator returns an error when op is not one of the known
// match operators.
func ValidateOperator(op string) error {
	switch op {
	case OpEquals, OpContains, OpExists, OpRegex:
		return nil
	}
	return fmt.Errorf("inbound_webhooks: unknown operator %q", op)
}

// ValidateAction returns an error when at is not one of the known
// action types.
func ValidateAction(at string) error {
	switch at {
	case ActionAddToSequence, ActionAddTag, ActionRemoveTag, ActionStartAutomation:
		return nil
	}
	return fmt.Errorf("inbound_webhooks: unknown action %q", at)
}

// Match is one fired-trigger record returned by EvaluateTriggers. It
// carries enough context for the caller to log/audit the side-effect
// without re-querying. SubscriberEmail is the resolved email, even if
// the subsequent action errors out.
type Match struct {
	TriggerID       string `json:"trigger_id"`
	Name            string `json:"name"`
	SubscriberEmail string `json:"subscriber_email"`
	ActionType      string `json:"action_type"`
	ActionTargetID  string `json:"action_target_id"`
	Queued          bool   `json:"queued,omitempty"`
	Executed        bool   `json:"executed"`
	Error           string `json:"error,omitempty"`
}

// TriggerStore is the persistence seam used by EvaluateTriggers. The
// real implementation lives in repo.go; tests inject an in-memory
// map.
type TriggerStore interface {
	ListActive(ctx context.Context, tenantID, webhookID string) ([]Trigger, error)
	RecordFire(ctx context.Context, tenantID, triggerID string) error
}

// ActionExecutor performs the product side-effect resolved from the
// trigger config (sequence enrollment, tag add/remove, automation
// start). All methods are safe to call repeatedly — implementations
// should de-dupe at the source-of-truth level (idempotent enrollment
// via the existing sequences API).
//
// nil ActionExecutor degrades EvaluateTriggers to "log only" mode:
// matches are returned but no side-effect runs. Useful for the "test
// fire" UI button.
type ActionExecutor interface {
	AddToSequence(ctx context.Context, tenantID, sequenceID, email string) error
	AddTag(ctx context.Context, tenantID, tag, email string) error
	RemoveTag(ctx context.Context, tenantID, tag, email string) error
	StartAutomation(ctx context.Context, tenantID, automationID, email string) error
}

// EvaluateTriggers directly runs every active trigger for a webhook against
// the given payload. Production receive/replay must use the durable outbox
// planner instead, because this compatibility helper does not hold an endpoint
// lifecycle lock across external side effects. For each trigger:
//
//  1. JSONPath query against payload for match_jsonpath
//  2. Apply operator (equals/contains/exists/regex)
//  3. If match, JSONPath for email_jsonpath
//  4. Resolve subscriber by email
//  5. Execute action (call existing sequences/tags APIs)
//  6. Record the matched condition (increment counter/update last_fired_at,
//     including when email resolution or the downstream action fails)
//
// Errors on individual triggers are captured into the returned []Match
// rather than aborting the loop — a misconfigured trigger should not
// block its siblings.
func EvaluateTriggers(
	ctx context.Context,
	store TriggerStore,
	exec ActionExecutor,
	tenantID, webhookID string,
	payload []byte,
) ([]Match, error) {
	if store == nil {
		return nil, errors.New("inbound_webhooks: nil TriggerStore")
	}
	triggers, err := store.ListActive(ctx, tenantID, webhookID)
	if err != nil {
		return nil, err
	}
	if len(triggers) == 0 {
		return nil, nil
	}
	var parsed any
	if err := json.Unmarshal(payload, &parsed); err != nil {
		// Non-JSON payloads can't be matched. We return nil rather
		// than an error: this is a config mismatch, not a programmer
		// bug. The receive path doesn't care.
		return nil, nil
	}

	matches := make([]Match, 0, len(triggers))
	for _, t := range triggers {
		match, err := evaluateOne(ctx, exec, t, parsed)
		if err != nil {
			match.Error = err.Error()
		}
		if match.TriggerID != "" {
			matches = append(matches, match)
			// Best-effort fire counter; ignore errors so a transient
			// pg blip doesn't lose the match record.
			_ = store.RecordFire(ctx, tenantID, t.ID)
		}
	}
	return matches, nil
}

// evaluateOne runs a single trigger. Returns a Match{} with TriggerID
// set when the rule fired; zero Match when the rule didn't match.
func evaluateOne(ctx context.Context, exec ActionExecutor, t Trigger, payload any) (Match, error) {
	matchedVal, ok := QueryJSONPath(payload, t.MatchJSONPath)
	if !operatorMatches(t.MatchOperator, matchedVal, ok, t.MatchValue) {
		return Match{}, nil
	}
	emailVal, ok := QueryJSONPath(payload, t.EmailJSONPath)
	if !ok {
		return Match{
			TriggerID:      t.ID,
			Name:           t.Name,
			ActionType:     t.ActionType,
			ActionTargetID: t.ActionTargetID,
		}, fmt.Errorf("email_jsonpath %q did not resolve", t.EmailJSONPath)
	}
	email := strings.TrimSpace(stringify(emailVal))
	if email == "" || !strings.Contains(email, "@") {
		return Match{
			TriggerID:       t.ID,
			Name:            t.Name,
			SubscriberEmail: email,
			ActionType:      t.ActionType,
			ActionTargetID:  t.ActionTargetID,
		}, fmt.Errorf("resolved email %q is not a valid address", email)
	}
	m := Match{
		TriggerID:       t.ID,
		Name:            t.Name,
		SubscriberEmail: email,
		ActionType:      t.ActionType,
		ActionTargetID:  t.ActionTargetID,
	}
	if exec == nil {
		// Test-fire / log-only mode.
		return m, nil
	}
	var err error
	switch t.ActionType {
	case ActionAddToSequence:
		err = exec.AddToSequence(ctx, t.TenantID, t.ActionTargetID, email)
	case ActionAddTag:
		err = exec.AddTag(ctx, t.TenantID, t.ActionTargetID, email)
	case ActionRemoveTag:
		err = exec.RemoveTag(ctx, t.TenantID, t.ActionTargetID, email)
	case ActionStartAutomation:
		err = exec.StartAutomation(ctx, t.TenantID, t.ActionTargetID, email)
	default:
		err = fmt.Errorf("unknown action_type %q", t.ActionType)
	}
	if err != nil {
		return m, err
	}
	m.Executed = true
	return m, nil
}

// operatorMatches encapsulates the four supported match operators.
//   - equals   : stringify(actual) == *expected
//   - contains : strings.Contains(stringify(actual), *expected)
//   - exists   : ok (the JSONPath resolved to anything, including
//     null/false/0)
//   - regex    : *expected (compiled) matches stringify(actual)
//
// When `expected` is nil for operators that need it, we treat it as
// "always false" rather than panicking.
func operatorMatches(op string, actual any, found bool, expected *string) bool {
	switch op {
	case OpExists:
		return found
	case OpEquals:
		if !found || expected == nil {
			return false
		}
		return stringify(actual) == *expected
	case OpContains:
		if !found || expected == nil {
			return false
		}
		return strings.Contains(stringify(actual), *expected)
	case OpRegex:
		if !found || expected == nil {
			return false
		}
		re, err := regexp.Compile(*expected)
		if err != nil {
			return false
		}
		return re.MatchString(stringify(actual))
	}
	return false
}

// stringify renders a JSONPath-resolved value into a comparable
// string. Numbers/bools take their fmt.Sprint representation;
// objects/arrays serialise via json.Marshal so callers can match on
// the canonical JSON form.
func stringify(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case bool:
		return fmt.Sprintf("%v", x)
	case float64:
		// Trim trailing zero on integer-valued floats so "5" matches
		// "5" instead of "5.000000".
		if x == float64(int64(x)) {
			return fmt.Sprintf("%d", int64(x))
		}
		return fmt.Sprintf("%g", x)
	}
	b, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(b)
}

// ---------------------------------------------------------------------
// Tiny JSONPath subset
// ---------------------------------------------------------------------
//
// We only support what v1 needs: dot-paths from the root with optional
// `[N]` index segments and `[*]` glob segments that flatten into the
// first element. Examples:
//
//   $.event_type
//   $.user.email
//   $.items[0].sku
//   $.items[*].sku    -> first element's sku
//
// The full JSONPath spec is out of scope; we'd pull in PaesslerAG's
// library if it were already in go.mod. It's not, and this subset is
// enough for v1 — the UI lets users paste a path and we match it.

// QueryJSONPath walks the dotted path against v and returns the
// resolved value plus a found-flag. Returns (nil, false) for any
// non-resolving segment.
func QueryJSONPath(v any, path string) (any, bool) {
	segments, err := parseJSONPath(path)
	if err != nil {
		return nil, false
	}
	cur := v
	for _, seg := range segments {
		next, ok := step(cur, seg)
		if !ok {
			return nil, false
		}
		cur = next
	}
	return cur, true
}

// segment is a single token in the parsed path: either a key into an
// object or an index into an array. `glob` matches "[*]" and resolves
// to the first element of an array (sufficient for v1).
type segment struct {
	key   string
	idx   int
	isIdx bool
	glob  bool
}

// parseJSONPath accepts only the syntax QueryJSONPath actually implements.
// Rejecting unsupported or partial expressions is important: the old parser
// could silently accept "$.user[" as "$.user", producing a trigger with
// materially different semantics than its author intended. Dotted keys reject
// JSONPath-reserved punctuation; bracket-quoted keys support a non-empty UTF-8
// literal without control characters or escapes. Consequently quote,
// backslash, and closing-bracket characters inside a quoted key are outside
// this deliberately bounded grammar.
func parseJSONPath(path string) ([]segment, error) {
	p := strings.TrimSpace(path)
	if p == "" || len(p) > maxTriggerJSONPathBytes || p[0] != '$' {
		return nil, errors.New("invalid JSONPath root")
	}
	p = p[1:]
	var out []segment
	for len(p) > 0 {
		switch p[0] {
		case '.':
			p = p[1:]
			end := strings.IndexAny(p, ".[")
			if end == -1 {
				end = len(p)
			}
			key := p[:end]
			if !validDottedJSONPathKey(key) {
				return nil, errors.New("invalid dotted JSONPath key")
			}
			out = append(out, segment{key: key})
			p = p[end:]
		case '[':
			close := strings.IndexByte(p, ']')
			if close < 0 {
				return nil, errors.New("unclosed JSONPath bracket")
			}
			body := strings.TrimSpace(p[1:close])
			if body == "" {
				return nil, errors.New("empty JSONPath bracket")
			}
			p = p[close+1:]
			if body == "*" {
				out = append(out, segment{glob: true, isIdx: true})
				continue
			}
			if body[0] == '\'' || body[0] == '"' {
				quote := body[0]
				if len(body) < 3 || body[len(body)-1] != quote {
					return nil, errors.New("invalid quoted JSONPath key")
				}
				key := body[1 : len(body)-1]
				if strings.ContainsRune(key, rune(quote)) ||
					strings.ContainsRune(key, '\\') ||
					!validQuotedJSONPathKey(key) {
					return nil, errors.New("invalid quoted JSONPath key")
				}
				out = append(out, segment{key: key})
				continue
			}
			for _, r := range body {
				if r < '0' || r > '9' {
					return nil, errors.New("invalid JSONPath index")
				}
			}
			n, err := strconv.Atoi(body)
			if err != nil {
				return nil, errors.New("JSONPath index is too large")
			}
			out = append(out, segment{idx: n, isIdx: true})
		default:
			return nil, errors.New("JSONPath segment must start with dot or bracket")
		}
	}
	return out, nil
}

func validDottedJSONPathKey(key string) bool {
	return key != "" &&
		utf8.ValidString(key) &&
		strings.IndexFunc(key, func(r rune) bool {
			return unicode.IsSpace(r) ||
				unicode.IsControl(r) ||
				r == '\'' ||
				r == '"' ||
				r == '*' ||
				r == ']' ||
				r == '\\'
		}) < 0
}

func validQuotedJSONPathKey(key string) bool {
	return key != "" &&
		utf8.ValidString(key) &&
		strings.IndexFunc(key, unicode.IsControl) < 0
}

// step walks one segment forward from cur and returns the next
// position plus a found-flag.
func step(cur any, seg segment) (any, bool) {
	if seg.isIdx {
		arr, ok := cur.([]any)
		if !ok {
			return nil, false
		}
		if seg.glob {
			if len(arr) == 0 {
				return nil, false
			}
			return arr[0], true
		}
		if seg.idx < 0 || seg.idx >= len(arr) {
			return nil, false
		}
		return arr[seg.idx], true
	}
	obj, ok := cur.(map[string]any)
	if !ok {
		return nil, false
	}
	val, ok := obj[seg.key]
	return val, ok
}
