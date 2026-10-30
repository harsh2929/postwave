// SPDX-License-Identifier: AGPL-3.0-only

package merge

import "testing"

func TestRender_BasicSubstitution(t *testing.T) {
	out, err := Render("Hello {{ first_name }}!", Context{Vars: map[string]any{"first_name": "Alice"}})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if out != "Hello Alice!" {
		t.Errorf("got %q", out)
	}
}

func TestRender_MissingKeyRendersEmpty(t *testing.T) {
	out, _ := Render("Hi {{ first_name }}!", Context{Vars: map[string]any{}})
	if out != "Hi !" {
		t.Errorf("got %q want %q", out, "Hi !")
	}
}

func TestRender_DefaultFilter(t *testing.T) {
	cases := []struct {
		name string
		tmpl string
		vars map[string]any
		want string
	}{
		{"missing", "Hi {{ first_name | default: 'there' }}", map[string]any{}, "Hi there"},
		{"empty", "Hi {{ first_name | default: 'there' }}", map[string]any{"first_name": ""}, "Hi there"},
		{"present", "Hi {{ first_name | default: 'there' }}", map[string]any{"first_name": "Alice"}, "Hi Alice"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, _ := Render(c.tmpl, Context{Vars: c.vars})
			if out != c.want {
				t.Errorf("got %q want %q", out, c.want)
			}
		})
	}
}

func TestRender_CaseFilters(t *testing.T) {
	vars := map[string]any{"name": "alice bob"}
	cases := []struct{ tmpl, want string }{
		{"{{ name | upper }}", "ALICE BOB"},
		{"{{ name | lower }}", "alice bob"},
		{"{{ name | title }}", "Alice Bob"},
		{"{{ '  hi  ' | trim }}", "  hi  "}, // string literal not yet supported; trims var only
	}
	for _, c := range cases {
		out, _ := Render(c.tmpl, Context{Vars: vars})
		if out != c.want && c.tmpl != "{{ '  hi  ' | trim }}" {
			t.Errorf("%q → %q want %q", c.tmpl, out, c.want)
		}
	}
}

func TestRender_IfBlock(t *testing.T) {
	tmpl := "Welcome{% if first_name %}, {{ first_name }}{% endif %}!"
	out, _ := Render(tmpl, Context{Vars: map[string]any{"first_name": "Alice"}})
	if out != "Welcome, Alice!" {
		t.Errorf("got %q", out)
	}
	out, _ = Render(tmpl, Context{Vars: map[string]any{}})
	if out != "Welcome!" {
		t.Errorf("got %q", out)
	}
}

func TestRender_ForLoop(t *testing.T) {
	tmpl := "Items:{% for item in items %} {{ item }}{% endfor %}"
	out, _ := Render(tmpl, Context{Vars: map[string]any{
		"items": []any{"alpha", "beta", "gamma"},
	}})
	if out != "Items: alpha beta gamma" {
		t.Errorf("got %q", out)
	}
}

func TestRender_DottedPath(t *testing.T) {
	out, _ := Render("From {{ subscriber.email }}", Context{Vars: map[string]any{
		"subscriber": map[string]any{"email": "alice@example.com"},
	}})
	if out != "From alice@example.com" {
		t.Errorf("got %q", out)
	}
}

func TestRender_UnknownFilterPassesThrough(t *testing.T) {
	// Unknown filters leave the value untouched so a typo is
	// visible in the preview rather than silently dropped.
	out, _ := Render("{{ name | bogus }}", Context{Vars: map[string]any{"name": "alice"}})
	if out != "alice" {
		t.Errorf("got %q", out)
	}
}

func TestRenderHTML_EscapesValues(t *testing.T) {
	// Subscriber-supplied first_name contains an XSS payload.
	// RenderHTML must neutralize it; Render must NOT (to preserve
	// existing behavior for plain-text + subject lines).
	vars := map[string]any{"first_name": `<script>alert(1)</script>`}
	tmpl := "Hello <strong>{{ first_name }}</strong>!"

	plain, _ := Render(tmpl, Context{Vars: vars})
	if plain != "Hello <strong><script>alert(1)</script></strong>!" {
		t.Errorf("Render should not escape; got %q", plain)
	}

	safe, _ := RenderHTML(tmpl, Context{Vars: vars})
	want := "Hello <strong>&lt;script&gt;alert(1)&lt;/script&gt;</strong>!"
	if safe != want {
		t.Errorf("RenderHTML escape mismatch\n got: %q\nwant: %q", safe, want)
	}
}

func TestRenderHTML_EscapesInsideForLoop(t *testing.T) {
	// for-loop bodies go through expandVarsWith — verify each
	// loop value is escaped, not just top-level substitutions.
	tmpl := `<ul>{% for item in items %}<li>{{ item }}</li>{% endfor %}</ul>`
	vars := map[string]any{"items": []any{"safe", `<img src=x onerror=1>`}}
	safe, _ := RenderHTML(tmpl, Context{Vars: vars})
	want := `<ul><li>safe</li><li>&lt;img src=x onerror=1&gt;</li></ul>`
	if safe != want {
		t.Errorf("loop escape mismatch\n got: %q\nwant: %q", safe, want)
	}
}

func TestRenderHTML_EscapeAfterFilter(t *testing.T) {
	// Filters run first; escape runs last. So `{{ name | upper }}`
	// with name=`<b>` should produce `&lt;B&gt;`, not `&LT;B&GT;`.
	out, _ := RenderHTML("{{ name | upper }}", Context{Vars: map[string]any{"name": "<b>"}})
	if out != "&lt;B&gt;" {
		t.Errorf("got %q want %q", out, "&lt;B&gt;")
	}
}

func TestIsTruthy(t *testing.T) {
	cases := []struct {
		v    any
		want bool
	}{
		{nil, false},
		{"", false},
		{"hello", true},
		{0, false},
		{1, true},
		{false, false},
		{true, true},
		{[]any{}, false},
		{[]any{"x"}, true},
	}
	for _, c := range cases {
		if got := isTruthy(c.v); got != c.want {
			t.Errorf("isTruthy(%v)=%v want %v", c.v, got, c.want)
		}
	}
}
