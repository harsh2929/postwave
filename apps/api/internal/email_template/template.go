// Package email_template implements a tiny conditional-block preprocessor
// for MJML / HTML email bodies. It supports two forms only:
//
//	{{#if subscriber.tier == "pro"}}A{{else}}B{{/if}}
//	{{#if has subscriber.tag "vip"}}A{{/if}}
//
// The grammar is intentionally a small subset of Handlebars-style if/else
// so we can ship without pulling in a templating dependency. Anything that
// is not an `{{#if ...}}` / `{{else}}` / `{{/if}}` directive is passed
// through verbatim, including `{{ subscriber.email }}` style interpolations
// that other layers may handle later.
package email_template

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Render evaluates conditional blocks against vars and returns the
// resulting string. Variable lookups use dotted paths (`subscriber.tier`),
// which traverse map[string]any nesting.
func Render(template string, vars map[string]any) (string, error) {
	tokens, err := tokenize(template)
	if err != nil {
		return "", err
	}
	p := &parser{tokens: tokens}
	nodes, err := p.parseUntil("")
	if err != nil {
		return "", err
	}
	if p.pos != len(tokens) {
		return "", fmt.Errorf("template: trailing tokens at pos %d", p.pos)
	}
	var b strings.Builder
	for _, n := range nodes {
		if err := n.render(&b, vars); err != nil {
			return "", err
		}
	}
	return b.String(), nil
}

// ---------- tokenizer ----------

type tokenKind int

const (
	tokText tokenKind = iota
	tokIf
	tokElse
	tokEndIf
)

type token struct {
	kind tokenKind
	text string // raw text for tokText, raw expression body for tokIf
}

func tokenize(src string) ([]token, error) {
	var out []token
	i := 0
	for i < len(src) {
		open := strings.Index(src[i:], "{{")
		if open < 0 {
			out = append(out, token{kind: tokText, text: src[i:]})
			break
		}
		if open > 0 {
			out = append(out, token{kind: tokText, text: src[i : i+open]})
		}
		start := i + open
		close := strings.Index(src[start:], "}}")
		if close < 0 {
			return nil, fmt.Errorf("template: unterminated tag at offset %d", start)
		}
		body := strings.TrimSpace(src[start+2 : start+close])
		switch {
		case strings.HasPrefix(body, "#if "):
			out = append(out, token{kind: tokIf, text: strings.TrimSpace(strings.TrimPrefix(body, "#if "))})
		case body == "else":
			out = append(out, token{kind: tokElse})
		case body == "/if":
			out = append(out, token{kind: tokEndIf})
		default:
			// Pass-through interpolation; another layer (e.g. Listmonk
			// templating) handles substitutions. Round-trip the literal.
			out = append(out, token{kind: tokText, text: src[start : start+close+2]})
		}
		i = start + close + 2
	}
	return out, nil
}

// ---------- AST ----------

type node interface {
	render(b *strings.Builder, vars map[string]any) error
}

type textNode struct{ text string }

func (t *textNode) render(b *strings.Builder, _ map[string]any) error {
	b.WriteString(t.text)
	return nil
}

type ifNode struct {
	expr      string
	thenNodes []node
	elseNodes []node
}

func (n *ifNode) render(b *strings.Builder, vars map[string]any) error {
	v, err := evalExpr(n.expr, vars)
	if err != nil {
		return err
	}
	if v {
		for _, c := range n.thenNodes {
			if err := c.render(b, vars); err != nil {
				return err
			}
		}
	} else {
		for _, c := range n.elseNodes {
			if err := c.render(b, vars); err != nil {
				return err
			}
		}
	}
	return nil
}

// ---------- parser ----------

type parser struct {
	tokens []token
	pos    int
}

// parseUntil reads nodes until it hits a sentinel. Sentinels for nested
// blocks are "else" and "/if"; "" means parse-to-EOF.
func (p *parser) parseUntil(sentinel string) ([]node, error) {
	var out []node
	for p.pos < len(p.tokens) {
		t := p.tokens[p.pos]
		switch t.kind {
		case tokText:
			out = append(out, &textNode{text: t.text})
			p.pos++
		case tokIf:
			p.pos++
			thenNodes, err := p.parseUntil("else_or_endif")
			if err != nil {
				return nil, err
			}
			var elseNodes []node
			if p.pos < len(p.tokens) && p.tokens[p.pos].kind == tokElse {
				p.pos++
				elseNodes, err = p.parseUntil("endif")
				if err != nil {
					return nil, err
				}
			}
			if p.pos >= len(p.tokens) || p.tokens[p.pos].kind != tokEndIf {
				return nil, errors.New("template: missing {{/if}}")
			}
			p.pos++
			out = append(out, &ifNode{expr: t.text, thenNodes: thenNodes, elseNodes: elseNodes})
		case tokElse:
			if sentinel == "else_or_endif" {
				return out, nil
			}
			return nil, errors.New("template: unexpected {{else}}")
		case tokEndIf:
			if sentinel == "endif" || sentinel == "else_or_endif" {
				return out, nil
			}
			return nil, errors.New("template: unexpected {{/if}}")
		}
	}
	if sentinel != "" {
		return nil, errors.New("template: unexpected end of template inside if-block")
	}
	return out, nil
}

// ---------- expression eval ----------

// evalExpr evaluates the boolean expression body of an {{#if ...}}.
// Supported shapes:
//
//	<path> == <literal>
//	<path> != <literal>
//	has <path> <literal>
//	<path>                 (truthy if non-zero / non-empty)
//
// Literals are bare numbers/booleans or "double-quoted" strings.
func evalExpr(expr string, vars map[string]any) (bool, error) {
	expr = strings.TrimSpace(expr)
	if strings.HasPrefix(expr, "has ") {
		rest := strings.TrimSpace(strings.TrimPrefix(expr, "has "))
		path, lit, ok := splitOnce(rest, " ")
		if !ok {
			return false, fmt.Errorf("template: 'has' needs <path> <literal>")
		}
		needle, err := parseLiteral(strings.TrimSpace(lit))
		if err != nil {
			return false, err
		}
		v := lookup(strings.TrimSpace(path), vars)
		switch arr := v.(type) {
		case []any:
			for _, item := range arr {
				if equalAny(item, needle) {
					return true, nil
				}
			}
		case []string:
			s, _ := needle.(string)
			for _, item := range arr {
				if item == s {
					return true, nil
				}
			}
		}
		return false, nil
	}
	for _, op := range []string{"==", "!="} {
		if idx := strings.Index(expr, op); idx >= 0 {
			lhs := strings.TrimSpace(expr[:idx])
			rhs := strings.TrimSpace(expr[idx+len(op):])
			lv := lookup(lhs, vars)
			rv, err := parseLiteral(rhs)
			if err != nil {
				return false, err
			}
			eq := equalAny(lv, rv)
			if op == "!=" {
				return !eq, nil
			}
			return eq, nil
		}
	}
	v := lookup(expr, vars)
	return truthy(v), nil
}

func splitOnce(s, sep string) (string, string, bool) {
	idx := strings.Index(s, sep)
	if idx < 0 {
		return s, "", false
	}
	return s[:idx], s[idx+len(sep):], true
}

func parseLiteral(s string) (any, error) {
	if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
		return s[1 : len(s)-1], nil
	}
	if s == "true" {
		return true, nil
	}
	if s == "false" {
		return false, nil
	}
	if n, err := strconv.ParseFloat(s, 64); err == nil {
		return n, nil
	}
	return nil, fmt.Errorf("template: invalid literal %q", s)
}

func lookup(path string, vars map[string]any) any {
	parts := strings.Split(path, ".")
	var cur any = vars
	for _, p := range parts {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[p]
	}
	return cur
}

func equalAny(a, b any) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	switch av := a.(type) {
	case string:
		bv, ok := b.(string)
		return ok && av == bv
	case bool:
		bv, ok := b.(bool)
		return ok && av == bv
	case float64:
		switch bv := b.(type) {
		case float64:
			return av == bv
		case int:
			return av == float64(bv)
		}
	case int:
		switch bv := b.(type) {
		case float64:
			return float64(av) == bv
		case int:
			return av == bv
		}
	}
	return fmt.Sprintf("%v", a) == fmt.Sprintf("%v", b)
}

func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case bool:
		return t
	case string:
		return t != ""
	case float64:
		return t != 0
	case int:
		return t != 0
	case []any:
		return len(t) > 0
	case map[string]any:
		return len(t) > 0
	}
	return true
}
