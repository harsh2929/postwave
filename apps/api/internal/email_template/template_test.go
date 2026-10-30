package email_template

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRender_IfElseBranch(t *testing.T) {
	tpl := `Hi {{#if subscriber.tier == "pro"}}Pro user{{else}}Free user{{/if}}!`
	pro, err := Render(tpl, map[string]any{
		"subscriber": map[string]any{"tier": "pro"},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if pro != "Hi Pro user!" {
		t.Fatalf("pro branch wrong: %q", pro)
	}
	free, err := Render(tpl, map[string]any{
		"subscriber": map[string]any{"tier": "free"},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if free != "Hi Free user!" {
		t.Fatalf("free branch wrong: %q", free)
	}
}

func TestPreviewRejectsOversizedBody(t *testing.T) {
	deps := &Deps{}
	body := `{"template":"` + strings.Repeat("x", int(previewJSONMaxBodyBytes)) + `","vars":{}}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/templates/preview", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	deps.Preview(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "payload_too_large") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestRender_HasTag(t *testing.T) {
	tpl := `{{#if has subscriber.tag "vip"}}VIP{{/if}}`
	got, err := Render(tpl, map[string]any{
		"subscriber": map[string]any{"tag": []any{"foo", "vip", "bar"}},
	})
	if err != nil || got != "VIP" {
		t.Fatalf("vip case got=%q err=%v", got, err)
	}
	got, err = Render(tpl, map[string]any{
		"subscriber": map[string]any{"tag": []any{"foo"}},
	})
	if err != nil || got != "" {
		t.Fatalf("non-vip case got=%q err=%v", got, err)
	}
}

func TestRender_PassthroughInterpolation(t *testing.T) {
	tpl := `Hello {{ subscriber.name }}!`
	got, err := Render(tpl, nil)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if got != tpl {
		t.Fatalf("interpolation should pass through verbatim: %q", got)
	}
}

func TestRender_NestedIf(t *testing.T) {
	tpl := `{{#if a == "x"}}A{{#if b == "y"}}B{{/if}}{{/if}}`
	got, err := Render(tpl, map[string]any{"a": "x", "b": "y"})
	if err != nil || got != "AB" {
		t.Fatalf("nested if got=%q err=%v", got, err)
	}
}

func TestRender_NotEqualAndTruthy(t *testing.T) {
	tpl := `{{#if subscriber.tier != "free"}}upgrade{{/if}}`
	got, err := Render(tpl, map[string]any{"subscriber": map[string]any{"tier": "pro"}})
	if err != nil || got != "upgrade" {
		t.Fatalf("ne got=%q err=%v", got, err)
	}
	tpl2 := `{{#if flag}}on{{else}}off{{/if}}`
	got, _ = Render(tpl2, map[string]any{"flag": true})
	if got != "on" {
		t.Fatalf("truthy true: %q", got)
	}
	got, _ = Render(tpl2, map[string]any{"flag": false})
	if got != "off" {
		t.Fatalf("truthy false: %q", got)
	}
}

func TestRender_MissingClose(t *testing.T) {
	if _, err := Render(`{{#if a == "x"}}oops`, nil); err == nil {
		t.Fatal("expected error for missing /if")
	}
}
