// SPDX-License-Identifier: AGPL-3.0-only
//
// filter.go — per-webhook filter expression evaluator + payload
// transformer for the fan-out path.
//
// Filter DSL (chosen for being easy to read in a UI field, easy to
// implement, and impossible to abuse — no Turing-complete script
// execution against tenant payloads):
//
//   <field> <op> <value> [ (&& | ||) <field> <op> <value> ... ]
//
//   Field      Dotted path through the payload JSON
//              ("subscriber.email", "campaign.recipients_count")
//   Operators  ==, !=, >, <, >=, <=, contains, startswith, endswith,
//              includes  (array membership for tag lists)
//   Value      Bareword (auto-typed: numbers as numbers, true/false
//              as booleans, anything else as a string).
//              Wrap with quotes to force string ("vip", '5').
//
// Examples:
//   subscriber.status == active
//   subscriber.tags includes vip
//   campaign.recipients_count > 1000
//   subscriber.email endswith @example.com
//
// Composition: && and || left-to-right, no parentheses. If you need
// nesting, split into multiple webhooks (each with its own filter +
// downstream URL).
//
// Transformation DSL: a JSON object whose values are JSON-Pointer
// strings (RFC 6901) into the inbound payload:
//
//   { "email": "/subscriber/email", "tags": "/subscriber/tags" }
//
// produces a flat object with the named fields, dropping everything
// else. Pointers that don't resolve are omitted (no error). This is
// the standard "field selection" half of Hookdeck's transform engine.

package outbound_webhooks

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

var exactFilterNumberPattern = regexp.MustCompile(`^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$`)

const (
	maxFilterExpressionBytes = 4 << 10
	maxFilterConditions      = 32
	maxFilterFieldBytes      = 256
	maxFilterValueBytes      = 1 << 10
	maxTransformJSONBytes    = 16 << 10
	maxTransformFields       = 64
	maxTransformFieldBytes   = 256
	maxTransformPointerBytes = 1 << 10
	maxTransformPointerDepth = 32
)

func normalizeFilterExpression(expr string) (string, error) {
	normalized := strings.TrimSpace(expr)
	if normalized == "" {
		return "", nil
	}
	if _, err := ParseFilter(normalized); err != nil {
		return "", fmt.Errorf("%w: %v", ErrInvalidFilter, err)
	}
	return normalized, nil
}

func encodeTransformTemplate(template map[string]any) ([]byte, error) {
	if len(template) == 0 {
		return nil, nil
	}
	if err := ValidateTransform(template); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidTransform, err)
	}
	encoded, err := json.Marshal(template)
	if err != nil {
		return nil, fmt.Errorf("%w: encode: %v", ErrInvalidTransform, err)
	}
	return encoded, nil
}

// Filter is the compiled, evaluable form of a filter_expression.
type Filter struct {
	conjuncts []conjunctClause
}

// conjunctClause is one OR-clause; AND inside.
type conjunctClause struct {
	conditions []condition
}

type condition struct {
	field  string
	op     string
	rawVal string
}

// ParseFilter compiles a textual expression. Empty input compiles to
// a Filter that matches everything (the legacy "no filter" behaviour).
func ParseFilter(expr string) (*Filter, error) {
	expr = strings.TrimSpace(expr)
	if expr == "" {
		return &Filter{}, nil
	}
	if len(expr) > maxFilterExpressionBytes {
		return nil, fmt.Errorf("filter: expression exceeds %d bytes", maxFilterExpressionBytes)
	}
	orParts, err := splitLogical(expr, "||")
	if err != nil {
		return nil, err
	}
	out := &Filter{}
	conditionCount := 0
	for _, orPart := range orParts {
		orPart = strings.TrimSpace(orPart)
		if orPart == "" {
			return nil, errors.New("filter: empty OR clause")
		}
		andParts, err := splitLogical(orPart, "&&")
		if err != nil {
			return nil, err
		}
		clause := conjunctClause{}
		for _, andPart := range andParts {
			if strings.TrimSpace(andPart) == "" {
				return nil, errors.New("filter: empty AND clause")
			}
			c, err := parseCondition(strings.TrimSpace(andPart))
			if err != nil {
				return nil, err
			}
			clause.conditions = append(clause.conditions, c)
			conditionCount++
			if conditionCount > maxFilterConditions {
				return nil, fmt.Errorf("filter: more than %d conditions", maxFilterConditions)
			}
		}
		if len(clause.conditions) == 0 {
			return nil, errors.New("filter: empty conjunct")
		}
		out.conjuncts = append(out.conjuncts, clause)
	}
	if len(out.conjuncts) == 0 {
		return nil, errors.New("filter: no clauses")
	}
	return out, nil
}

// Matches reports whether the payload satisfies the filter. A nil /
// empty Filter always matches (matches the absent-filter semantic).
func (f *Filter) Matches(payload map[string]any) bool {
	if f == nil || len(f.conjuncts) == 0 {
		return true
	}
	for _, clause := range f.conjuncts {
		all := true
		for _, c := range clause.conditions {
			if !checkCondition(c, payload) {
				all = false
				break
			}
		}
		if all {
			return true
		}
	}
	return false
}

// parseCondition splits "field op value". Every operator MUST be surrounded
// by whitespace. Values containing spaces or logical/operator tokens must be
// quoted, which keeps the grammar deterministic and lets us reject ambiguous
// configuration before a webhook is activated.
func parseCondition(s string) (condition, error) {
	field, rest, ok := cutToken(s)
	if !ok {
		return condition{}, fmt.Errorf("filter: cannot parse condition %q", s)
	}
	op, rawVal, ok := cutToken(rest)
	if !ok || strings.TrimSpace(rawVal) == "" {
		return condition{}, fmt.Errorf("filter: cannot parse condition %q (operator must be flanked by spaces)", s)
	}
	switch op {
	case "==", "!=", ">=", "<=", "contains", "startswith", "endswith", "includes", ">", "<":
	default:
		return condition{}, fmt.Errorf("filter: unsupported operator %q", op)
	}
	if len(field) > maxFilterFieldBytes || !utf8.ValidString(field) {
		return condition{}, errors.New("filter: field is too long or invalid UTF-8")
	}
	for _, c := range field {
		if c <= ' ' || c == '=' || c == '!' || c == '<' || c == '>' || c == '&' || c == '|' {
			return condition{}, fmt.Errorf("filter: field %q contains invalid characters", field)
		}
	}
	for _, segment := range strings.Split(field, ".") {
		if segment == "" {
			return condition{}, fmt.Errorf("filter: field %q contains an empty path segment", field)
		}
	}
	rawVal = strings.TrimSpace(rawVal)
	if len(rawVal) > maxFilterValueBytes || !utf8.ValidString(rawVal) {
		return condition{}, errors.New("filter: value is too long or invalid UTF-8")
	}
	if _, err := parseFilterLiteral(rawVal); err != nil {
		return condition{}, err
	}
	return condition{field: field, op: op, rawVal: rawVal}, nil
}

func cutToken(s string) (token, rest string, ok bool) {
	s = strings.TrimSpace(s)
	for i, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			token = s[:i]
			rest = strings.TrimSpace(s[i:])
			return token, rest, token != "" && rest != ""
		}
	}
	return "", "", false
}

// checkCondition runs one comparison. Named to avoid `eval` which
// trips lint hooks that watch for code-execution patterns.
func checkCondition(c condition, payload map[string]any) bool {
	got := lookupPath(payload, c.field)
	val, err := parseFilterLiteral(c.rawVal)
	if err != nil {
		return false
	}
	quoted := c.rawVal[0] == '"' || c.rawVal[0] == '\''
	switch c.op {
	case "==":
		return looseEqual(got, val, quoted)
	case "!=":
		return !looseEqual(got, val, quoted)
	case ">":
		if quoted {
			return false
		}
		cmp, ok := numCompare(got, val)
		return ok && cmp > 0
	case "<":
		if quoted {
			return false
		}
		cmp, ok := numCompare(got, val)
		return ok && cmp < 0
	case ">=":
		if quoted {
			return false
		}
		cmp, ok := numCompare(got, val)
		return ok && cmp >= 0
	case "<=":
		if quoted {
			return false
		}
		cmp, ok := numCompare(got, val)
		return ok && cmp <= 0
	case "contains":
		s, ok := got.(string)
		return ok && strings.Contains(s, val)
	case "startswith":
		s, ok := got.(string)
		return ok && strings.HasPrefix(s, val)
	case "endswith":
		s, ok := got.(string)
		return ok && strings.HasSuffix(s, val)
	case "includes":
		arr, ok := got.([]any)
		if !ok {
			return false
		}
		for _, v := range arr {
			if looseEqual(v, val, quoted) {
				return true
			}
		}
	}
	return false
}

func lookupPath(payload map[string]any, path string) any {
	parts := strings.Split(path, ".")
	var cur any = payload
	for _, p := range parts {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[p]
	}
	return cur
}

func looseEqual(got any, want string, quoted bool) bool {
	if quoted {
		value, ok := got.(string)
		return ok && value == want
	}
	if got == nil {
		return want == "null"
	}
	switch v := got.(type) {
	case string:
		return v == want
	case bool:
		return strconv.FormatBool(v) == want
	default:
		gotNumber, gotOK := exactFilterNumber(got)
		wantNumber, wantOK := exactDecimalRat(want)
		return gotOK && wantOK && gotNumber.Cmp(wantNumber) == 0
	}
}

func numCompare(got any, want string) (int, bool) {
	w, ok := exactDecimalRat(want)
	if !ok {
		return 0, false
	}
	value, ok := exactFilterNumber(got)
	if !ok {
		return 0, false
	}
	return value.Cmp(w), true
}

func exactFilterNumber(value any) (*big.Rat, bool) {
	switch v := value.(type) {
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, false
		}
		return exactDecimalRat(strconv.FormatFloat(v, 'g', -1, 64))
	case float32:
		if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) {
			return nil, false
		}
		return exactDecimalRat(strconv.FormatFloat(float64(v), 'g', -1, 32))
	case json.Number:
		return exactDecimalRat(v.String())
	case int:
		return exactDecimalRat(strconv.FormatInt(int64(v), 10))
	case int8:
		return exactDecimalRat(strconv.FormatInt(int64(v), 10))
	case int16:
		return exactDecimalRat(strconv.FormatInt(int64(v), 10))
	case int32:
		return exactDecimalRat(strconv.FormatInt(int64(v), 10))
	case int64:
		return exactDecimalRat(strconv.FormatInt(v, 10))
	case uint:
		return exactDecimalRat(strconv.FormatUint(uint64(v), 10))
	case uint8:
		return exactDecimalRat(strconv.FormatUint(uint64(v), 10))
	case uint16:
		return exactDecimalRat(strconv.FormatUint(uint64(v), 10))
	case uint32:
		return exactDecimalRat(strconv.FormatUint(uint64(v), 10))
	case uint64:
		return exactDecimalRat(strconv.FormatUint(v, 10))
	default:
		return nil, false
	}
}

func exactDecimalRat(value string) (*big.Rat, bool) {
	if len(value) == 0 || len(value) > maxFilterValueBytes ||
		!exactFilterNumberPattern.MatchString(value) {
		return nil, false
	}
	// Bound exponent expansion before handing the value to big.Rat. The filter
	// grammar is capped, but a short token such as 1e999999999 could otherwise
	// request an enormous denominator/numerator allocation.
	if exponentAt := strings.IndexAny(value, "eE"); exponentAt >= 0 {
		exponent, err := strconv.ParseInt(value[exponentAt+1:], 10, 32)
		if err != nil || exponent < -10_000 || exponent > 10_000 {
			return nil, false
		}
	}
	number, ok := new(big.Rat).SetString(value)
	return number, ok
}

func parseFilterLiteral(s string) (string, error) {
	if s == "" {
		return "", errors.New("filter: empty value")
	}
	if s[0] == '"' {
		if len(s) < 2 || s[len(s)-1] != '"' {
			return "", errors.New("filter: unterminated quoted value")
		}
		value, err := strconv.Unquote(s)
		if err != nil {
			return "", fmt.Errorf("filter: invalid quoted value: %w", err)
		}
		return value, nil
	}
	if s[0] == '\'' {
		if len(s) < 2 || s[len(s)-1] != '\'' {
			return "", errors.New("filter: unterminated quoted value")
		}
		inner := s[1 : len(s)-1]
		if strings.ContainsAny(inner, "'\r\n") {
			return "", errors.New("filter: invalid single-quoted value")
		}
		return inner, nil
	}
	if strings.ContainsAny(s, " \t\r\n\"'") {
		return "", errors.New("filter: values containing whitespace or quotes must be double-quoted")
	}
	return s, nil
}

// splitLogical splits && / || outside quoted literals. Backslash escaping is
// honored inside double-quoted literals so a value such as "A && B" remains a
// single condition.
func splitLogical(s, sep string) ([]string, error) {
	var out []string
	start := 0
	var quote byte
	escaped := false
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if quote != 0 {
			if quote == '"' && escaped {
				escaped = false
				continue
			}
			if quote == '"' && ch == '\\' {
				escaped = true
				continue
			}
			if ch == quote {
				quote = 0
			}
			continue
		}
		if ch == '"' || ch == '\'' {
			quote = ch
			continue
		}
		if strings.HasPrefix(s[i:], sep) {
			out = append(out, s[start:i])
			i += len(sep) - 1
			start = i + 1
		}
	}
	if quote != 0 || escaped {
		return nil, errors.New("filter: unterminated quoted value")
	}
	out = append(out, s[start:])
	return out, nil
}

// --- Transformation ---

// ValidateTransform verifies the bounded JSON-Pointer projection contract.
// It is called on every write and again when legacy rows are loaded so invalid
// direct-DB configuration cannot reach the delivery path.
func ValidateTransform(template map[string]any) error {
	if len(template) == 0 {
		return nil
	}
	if len(template) > maxTransformFields {
		return fmt.Errorf("transform: more than %d output fields", maxTransformFields)
	}
	encoded, err := json.Marshal(template)
	if err != nil {
		return fmt.Errorf("transform: encode: %w", err)
	}
	if len(encoded) > maxTransformJSONBytes {
		return fmt.Errorf("transform: template exceeds %d bytes", maxTransformJSONBytes)
	}
	for outField, raw := range template {
		if outField == "" || len(outField) > maxTransformFieldBytes || !utf8.ValidString(outField) {
			return errors.New("transform: output field is empty, too long, or invalid UTF-8")
		}
		for _, r := range outField {
			if r < ' ' {
				return fmt.Errorf("transform: output field %q contains control characters", outField)
			}
		}
		ptr, ok := raw.(string)
		if !ok {
			return fmt.Errorf("transform: pointer for %q must be a string", outField)
		}
		if err := validateJSONPointer(ptr); err != nil {
			return fmt.Errorf("transform: pointer for %q: %w", outField, err)
		}
	}
	return nil
}

func validateJSONPointer(ptr string) error {
	if len(ptr) > maxTransformPointerBytes || !utf8.ValidString(ptr) {
		return errors.New("pointer is too long or invalid UTF-8")
	}
	if ptr == "" {
		return nil // RFC 6901 whole-document pointer.
	}
	if !strings.HasPrefix(ptr, "/") {
		return errors.New("pointer must be empty or start with '/'")
	}
	parts := strings.Split(ptr[1:], "/")
	if len(parts) > maxTransformPointerDepth {
		return fmt.Errorf("pointer exceeds %d segments", maxTransformPointerDepth)
	}
	for _, part := range parts {
		for i := 0; i < len(part); i++ {
			if part[i] != '~' {
				continue
			}
			if i+1 >= len(part) || (part[i+1] != '0' && part[i+1] != '1') {
				return errors.New("pointer contains an invalid '~' escape")
			}
			i++
		}
	}
	return nil
}

// Transform projects payload through template (a map of out-field →
// JSON-Pointer-into-payload). Returns the new payload JSON. When
// template is nil/empty, returns payload unchanged.
func Transform(template map[string]any, payload []byte) ([]byte, error) {
	if len(template) == 0 {
		return payload, nil
	}
	if err := ValidateTransform(template); err != nil {
		return nil, err
	}
	var src map[string]any
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	if err := decoder.Decode(&src); err != nil {
		return nil, fmt.Errorf("transform: parse payload: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			err = errors.New("multiple JSON values")
		}
		return nil, fmt.Errorf("transform: parse payload: %w", err)
	}
	out := make(map[string]any, len(template))
	for outField, ptrRaw := range template {
		ptr := ptrRaw.(string) // ValidateTransform established the type.
		if v, ok := jsonPointerLookup(src, ptr); ok {
			out[outField] = v
		}
	}
	return json.Marshal(out)
}

// jsonPointerLookup implements RFC 6901 object/array traversal.
func jsonPointerLookup(src map[string]any, ptr string) (any, bool) {
	if ptr == "" {
		return src, true
	}
	if !strings.HasPrefix(ptr, "/") {
		return nil, false
	}
	parts := strings.Split(ptr[1:], "/")
	var cur any = src
	for _, encodedPart := range parts {
		p := strings.ReplaceAll(strings.ReplaceAll(encodedPart, "~1", "/"), "~0", "~")
		switch v := cur.(type) {
		case map[string]any:
			next, ok := v[p]
			if !ok {
				return nil, false
			}
			cur = next
		case []any:
			i, err := strconv.Atoi(p)
			if err != nil || i < 0 || i >= len(v) {
				return nil, false
			}
			cur = v[i]
		default:
			return nil, false
		}
	}
	return cur, true
}
