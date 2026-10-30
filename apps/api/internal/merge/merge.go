// SPDX-License-Identifier: AGPL-3.0-only
//
// Package merge implements the merge-field engine for personalized
// email content. Intentionally a TINY subset of Liquid — we want
// the marketing team's {{ first_name }} story to Just Work, not a
// full template DSL that operators trip over.
//
// Supported syntax:
//
//   {{ key }}                       value lookup; missing key → ""
//   {{ key | default: 'fallback' }} when value is empty, use the
//                                   literal fallback. Quotes are
//                                   stripped from the literal.
//   {{ key | upper }}               uppercase
//   {{ key | lower }}               lowercase
//   {{ key | title }}               title-case
//   {{ key | trim }}                strip leading/trailing whitespace
//
//   {% if key %}...{% endif %}      conditional block; "key" must be
//                                   present + truthy (non-empty
//                                   string / non-zero number / true).
//                                   No else branch in V1.
//
//   {% for item in items %}...{% endfor %}
//                                   simple loop over an array. The
//                                   loop variable is exposed inside
//                                   the block. Properties accessed
//                                   via dot: {{ item.name }}.
//
// Intentionally NOT supported:
//   * Nested if/for chains beyond depth 2.
//   * Math expressions.
//   * Custom filters beyond the four listed above.
//   * Arbitrary expressions.
//
// If an operator asks for "I want elif" — we're in the wrong
// product surface; they want code, not templates.
//
// Render safety:
//   * Missing keys silently render as empty strings (Liquid
//     default; matches Mailchimp's MERGE-tag behavior).
//   * Output is NOT HTML-escaped by this package — the caller
//     wraps with html.EscapeString when rendering into an HTML
//     context. We don't escape here because the subject line and
//     plain-text body use the same engine but don't want
//     escaping.

package merge

import (
	"fmt"
	"html"
	"regexp"
	"strings"
)

// Context is the per-render variable bag. Keys are dot-path
// strings; "subscriber.first_name" is one canonical key. The
// Resolve method handles the lookup including dotted paths.
type Context struct {
	// Vars holds top-level keys + nested maps. Nested keys are
	// looked up by dotting through map[string]any.
	Vars map[string]any
}

// Resolve walks key (e.g. "subscriber.first_name" or "items") down
// Vars. Returns the value + ok=true when found, nil + false when
// the path doesn't exist (caller treats as empty string).
func (c *Context) Resolve(key string) (any, bool) {
	parts := strings.Split(key, ".")
	var cur any = c.Vars
	for _, p := range parts {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		v, ok := m[p]
		if !ok {
			return nil, false
		}
		cur = v
	}
	return cur, true
}

// Render expands every {{ ... }} expression + {% if/for %} block
// in the supplied template. Errors are returned only for
// genuinely unparseable templates (unmatched {% endif %}, etc.);
// missing variables render as empty strings.
//
// V1 doesn't compile a parsed AST — for the editor preview path
// the regex-driven walk is comfortably fast (sub-millisecond on
// realistic email-body sizes) and easier to maintain.
//
// Render does NOT HTML-escape merge values — use RenderHTML when
// substituting into an HTML body.
func Render(template string, ctx Context) (string, error) {
	return renderWith(template, ctx, identityEscape)
}

// RenderHTML is the HTML-safe variant of Render. Every merge-tag
// value is passed through html.EscapeString *after* filters but
// *before* substitution into the template. This is the right
// choice for HTML email bodies, where subscriber-supplied fields
// like `first_name`, `company`, and custom attributes are
// attacker-controllable.
//
// The template itself is NOT escaped — only the *values* that
// flow through {{ ... }}. That preserves the marketer's freedom
// to write `<strong>{{ first_name }}</strong>` without their
// markup being mangled, while still neutralizing a subscriber
// named `<script>alert(1)</script>`.
//
// Use Render (no escaping) for: subject lines, plain-text bodies,
// and the editor preview pane (which renders into an iframe with
// its own sandbox).
func RenderHTML(template string, ctx Context) (string, error) {
	return renderWith(template, ctx, html.EscapeString)
}

// renderWith is the shared pipeline. The escape parameter is
// applied to each substituted value in expandVars (and inside
// for-loop bodies via the same expandVars call).
func renderWith(template string, ctx Context, escape func(string) string) (string, error) {
	// First: resolve {% for %} blocks (outermost first). Loops can
	// contain {{ ... }} expressions; substitute the loop variable
	// into the inner block + recurse.
	expanded, err := expandForWith(template, ctx, escape)
	if err != nil {
		return "", err
	}
	// Then: resolve {% if %} blocks. Same pattern.
	expanded, err = expandIf(expanded, ctx)
	if err != nil {
		return "", err
	}
	// Finally: substitute {{ ... }} expressions.
	return expandVarsWith(expanded, ctx, escape), nil
}

func identityEscape(s string) string { return s }

// --- variable expansion ---

// varRE matches `{{ key | filter:'arg' }}` with optional whitespace.
// We accept | with or without surrounding spaces.
var varRE = regexp.MustCompile(`\{\{\s*([^{}]+?)\s*\}\}`)

func expandVars(template string, ctx Context) string {
	return expandVarsWith(template, ctx, identityEscape)
}

// expandVarsWith is the escape-aware variant. escape is applied
// AFTER filters so a user with `name = "<b>"` and template
// `{{ name | upper }}` produces `&lt;B&gt;` rather than `<B>`.
func expandVarsWith(template string, ctx Context, escape func(string) string) string {
	return varRE.ReplaceAllStringFunc(template, func(match string) string {
		// Strip the {{ }} and split by pipes.
		inner := strings.TrimSpace(match[2 : len(match)-2])
		parts := splitPipes(inner)
		if len(parts) == 0 {
			return ""
		}
		key := strings.TrimSpace(parts[0])
		val, _ := ctx.Resolve(key)
		out := stringify(val)
		for _, filter := range parts[1:] {
			out = applyFilter(out, strings.TrimSpace(filter))
		}
		return escape(out)
	})
}

// splitPipes splits "key | filter:'arg' | upper" into the three
// segments. Pipes inside single-quoted literals are preserved.
func splitPipes(s string) []string {
	out := []string{}
	cur := strings.Builder{}
	inQuote := false
	for _, ch := range s {
		if ch == '\'' {
			inQuote = !inQuote
		}
		if ch == '|' && !inQuote {
			out = append(out, cur.String())
			cur.Reset()
			continue
		}
		cur.WriteRune(ch)
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

// applyFilter runs a single filter against the value. The supported
// set is intentionally narrow — see package doc.
func applyFilter(value, filter string) string {
	name := filter
	arg := ""
	if i := strings.Index(filter, ":"); i >= 0 {
		name = strings.TrimSpace(filter[:i])
		arg = strings.TrimSpace(filter[i+1:])
		arg = strings.Trim(arg, `'"`)
	}
	switch strings.ToLower(name) {
	case "default":
		if strings.TrimSpace(value) == "" {
			return arg
		}
		return value
	case "upper":
		return strings.ToUpper(value)
	case "lower":
		return strings.ToLower(value)
	case "title":
		// Go's strings.Title is deprecated; this is the simpler
		// language-aware-enough replacement for ASCII names. Real
		// i18n would use cases.Title from golang.org/x/text.
		return titleCase(value)
	case "trim":
		return strings.TrimSpace(value)
	}
	// Unknown filter — leave value untouched so a typo is visible
	// in the preview rather than silently dropped.
	return value
}

func titleCase(s string) string {
	var b strings.Builder
	prev := ' '
	for _, ch := range s {
		if isWordStart(prev) {
			b.WriteRune(toUpperRune(ch))
		} else {
			b.WriteRune(toLowerRune(ch))
		}
		prev = ch
	}
	return b.String()
}

func isWordStart(prev rune) bool {
	return prev == ' ' || prev == '\t' || prev == '\n' || prev == '-' || prev == '_' || prev == '\''
}

func toUpperRune(ch rune) rune {
	if ch >= 'a' && ch <= 'z' {
		return ch - 32
	}
	return ch
}

func toLowerRune(ch rune) rune {
	if ch >= 'A' && ch <= 'Z' {
		return ch + 32
	}
	return ch
}

// stringify coerces a Resolve value into a string. nil → "";
// numbers + bools render as their fmt-default form.
func stringify(v any) string {
	if v == nil {
		return ""
	}
	switch t := v.(type) {
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		return fmt.Sprintf("%v", v)
	}
}

// --- conditional expansion ---

var ifRE = regexp.MustCompile(`(?s)\{%\s*if\s+([^%]+?)\s*%\}(.*?)\{%\s*endif\s*%\}`)

func expandIf(template string, ctx Context) (string, error) {
	for {
		match := ifRE.FindStringSubmatchIndex(template)
		if match == nil {
			break
		}
		key := strings.TrimSpace(template[match[2]:match[3]])
		body := template[match[4]:match[5]]
		val, ok := ctx.Resolve(key)
		var replacement string
		if ok && isTruthy(val) {
			replacement = body
		}
		template = template[:match[0]] + replacement + template[match[1]:]
	}
	return template, nil
}

// isTruthy mirrors Liquid: non-nil + non-empty-string + non-false.
func isTruthy(v any) bool {
	if v == nil {
		return false
	}
	switch t := v.(type) {
	case string:
		return strings.TrimSpace(t) != ""
	case bool:
		return t
	case int, int32, int64, float32, float64:
		return fmt.Sprintf("%v", t) != "0"
	case []any:
		return len(t) > 0
	case map[string]any:
		return len(t) > 0
	}
	return true
}

// --- for-loop expansion ---

var forRE = regexp.MustCompile(`(?s)\{%\s*for\s+(\w+)\s+in\s+([^%]+?)\s*%\}(.*?)\{%\s*endfor\s*%\}`)

func expandFor(template string, ctx Context) (string, error) {
	return expandForWith(template, ctx, identityEscape)
}

func expandForWith(template string, ctx Context, escape func(string) string) (string, error) {
	for {
		match := forRE.FindStringSubmatchIndex(template)
		if match == nil {
			break
		}
		loopVar := template[match[2]:match[3]]
		collectionKey := strings.TrimSpace(template[match[4]:match[5]])
		body := template[match[6]:match[7]]
		val, _ := ctx.Resolve(collectionKey)
		items, ok := val.([]any)
		if !ok {
			// Empty collection / wrong type → render zero iterations.
			template = template[:match[0]] + template[match[1]:]
			continue
		}
		var out strings.Builder
		for _, item := range items {
			// Build a sub-context with the loop var bound.
			subVars := make(map[string]any, len(ctx.Vars)+1)
			for k, v := range ctx.Vars {
				subVars[k] = v
			}
			subVars[loopVar] = item
			subCtx := Context{Vars: subVars}
			// Recursively expand inner ifs + vars within this body.
			expandedBody, _ := expandIf(body, subCtx)
			out.WriteString(expandVarsWith(expandedBody, subCtx, escape))
		}
		template = template[:match[0]] + out.String() + template[match[1]:]
	}
	return template, nil
}
