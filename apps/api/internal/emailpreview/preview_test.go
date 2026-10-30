// SPDX-License-Identifier: AGPL-3.0-only
package emailpreview

import (
	"context"
	"strings"
	"testing"
)

// TestRenderMJML_StubFallback exercises the stub renderer path. We force
// it by pointing MJML_BIN at a non-existent binary; the renderer should
// fall back to the regex stub and produce roughly-right HTML plus a
// warning that the stub was used.
func TestRenderMJML_StubFallback(t *testing.T) {
	t.Setenv("MJML_BIN", "/definitely/does/not/exist/mjml")
	t.Setenv("PATH", "")

	cases := []struct {
		name        string
		mjml        string
		vars        map[string]string
		mustContain []string
	}{
		{
			name: "section becomes table",
			mjml: `<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>`,
			mustContain: []string{
				"<table",
				"<td",
				"<p>Hi</p>",
			},
		},
		{
			name: "var substitution",
			mjml: `<mjml><mj-body><mj-section><mj-column><mj-text>Hello {{name}}</mj-text></mj-column></mj-section></mj-body></mjml>`,
			vars: map[string]string{"name": "Alex"},
			mustContain: []string{
				"Hello Alex",
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			html, warnings, err := RenderMJML(context.Background(), tc.mjml, tc.vars)
			if err != nil {
				t.Fatalf("RenderMJML: %v", err)
			}
			for _, want := range tc.mustContain {
				if !strings.Contains(html, want) {
					t.Errorf("html missing %q\ngot: %s", want, html)
				}
			}
			// stub-warning should always be present in this codepath.
			foundStubWarn := false
			for _, w := range warnings {
				if strings.Contains(w, "stub renderer") {
					foundStubWarn = true
					break
				}
			}
			if !foundStubWarn {
				t.Errorf("expected stub-renderer warning, got %v", warnings)
			}
		})
	}
}

// TestRenderMJML_UnmatchedVarWarning verifies that an unsupplied template
// variable produces a warning + replaces the placeholder with an empty
// string (so it doesn't ship as literal "{{name}}" in the inbox).
func TestRenderMJML_UnmatchedVarWarning(t *testing.T) {
	t.Setenv("MJML_BIN", "/definitely/does/not/exist/mjml")
	t.Setenv("PATH", "")

	html, warnings, err := RenderMJML(context.Background(),
		`<mjml><mj-body><mj-section><mj-column><mj-text>Hi {{name}}</mj-text></mj-column></mj-section></mj-body></mjml>`,
		map[string]string{})
	if err != nil {
		t.Fatalf("RenderMJML: %v", err)
	}
	if strings.Contains(html, "{{name}}") {
		t.Errorf("expected {{name}} to be substituted, got: %s", html)
	}
	foundUnmatched := false
	for _, w := range warnings {
		if strings.Contains(w, "unmatched template variable: name") {
			foundUnmatched = true
		}
	}
	if !foundUnmatched {
		t.Errorf("expected 'unmatched template variable' warning, got %v", warnings)
	}
}

func TestRenderMJML_ProductionRequiresCLI(t *testing.T) {
	t.Setenv("POSTWAVE_ENV", "production")
	t.Setenv("ENVIRONMENT", "")
	t.Setenv("NODE_ENV", "")
	t.Setenv("MJML_BIN", "/definitely/does/not/exist/mjml")
	t.Setenv("PATH", "")

	_, warnings, err := RenderMJML(context.Background(),
		`<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>`,
		nil)
	if err == nil || !strings.Contains(err.Error(), "mjml CLI unavailable in production") {
		t.Fatalf("RenderMJML error = %v, want production CLI failure", err)
	}
	for _, w := range warnings {
		if strings.Contains(w, "stub renderer") {
			t.Fatalf("production warnings contained stub fallback warning: %v", warnings)
		}
	}
}

// TestApplyOutlookDesktop_AddsConditional confirms that the Outlook
// transform injects MSO conditional comments — the email-dev community's
// canonical Outlook-only escape hatch.
func TestApplyOutlookDesktop_AddsConditional(t *testing.T) {
	html := `<!doctype html><html><head></head><body><p>Hello</p></body></html>`
	out := ApplyOutlookDesktop(html)

	if !strings.Contains(out, "<!--[if mso]>") {
		t.Errorf("expected MSO conditional, got: %s", out)
	}
	if !strings.Contains(out, "<![endif]-->") {
		t.Errorf("expected MSO conditional close, got: %s", out)
	}
	if !strings.Contains(out, `data-pw-client="outlook-desktop"`) {
		t.Errorf("expected client label, got: %s", out)
	}
}

// TestApplyOutlookDesktop_StripsUnsupported confirms that border-radius
// and friends — properties Outlook ignores — are removed from the
// preview so reviewers see the squared-off reality.
func TestApplyOutlookDesktop_StripsUnsupported(t *testing.T) {
	html := `<html><head></head><body><div style="border-radius: 8px; color: red;">x</div></body></html>`
	out := ApplyOutlookDesktop(html)
	if strings.Contains(out, "border-radius") {
		t.Errorf("expected border-radius stripped, got: %s", out)
	}
	if !strings.Contains(out, "color: red") {
		t.Errorf("expected color:red preserved, got: %s", out)
	}
}

// TestApplyDarkMode_AddsMediaQuery confirms that the dark-mode transform
// emits a prefers-color-scheme rule.
func TestApplyDarkMode_AddsMediaQuery(t *testing.T) {
	html := `<!doctype html><html><head></head><body><p>Hello</p></body></html>`
	out := ApplyDarkMode(html)
	if !strings.Contains(out, "prefers-color-scheme: dark") {
		t.Errorf("expected dark-mode media query, got: %s", out)
	}
	if !strings.Contains(out, `data-pw-dark="1"`) {
		t.Errorf("expected dark-mode body attribute, got: %s", out)
	}
}

// TestApplyAppleMail_InjectsHints verifies that the Apple Mail transform
// adds the canonical iOS auto-detector suppressors.
func TestApplyAppleMail_InjectsHints(t *testing.T) {
	html := `<html><head></head><body><p>Hello</p></body></html>`
	out := ApplyAppleMail(html)
	if !strings.Contains(out, "x-apple-disable-message-reformatting") {
		t.Errorf("expected x-apple-disable meta, got: %s", out)
	}
	if !strings.Contains(out, "-webkit-text-size-adjust") {
		t.Errorf("expected text-size-adjust rule, got: %s", out)
	}
}

// TestApplyGmailWeb_DataAttribute checks the Gmail label is applied.
func TestApplyGmailWeb_DataAttribute(t *testing.T) {
	html := `<html><head></head><body><p>x</p></body></html>`
	out := ApplyGmailWeb(html)
	if !strings.Contains(out, `data-pw-client="gmail-web"`) {
		t.Errorf("expected gmail-web label, got: %s", out)
	}
}

// TestBuildPreview_AllClientsPresent is the end-to-end smoke test: feed
// MJML in, expect non-empty HTML for each of the four clients.
func TestBuildPreview_AllClientsPresent(t *testing.T) {
	t.Setenv("MJML_BIN", "/definitely/does/not/exist/mjml")
	t.Setenv("PATH", "")

	mjml := `<mjml><mj-body><mj-section><mj-column><mj-text>Hello {{name}}</mj-text></mj-column></mj-section></mj-body></mjml>`
	preview, err := BuildPreview(context.Background(), mjml, map[string]string{"name": "Ada"})
	if err != nil {
		t.Fatalf("BuildPreview: %v", err)
	}
	if preview.GmailHTML == "" || preview.OutlookHTML == "" ||
		preview.AppleHTML == "" || preview.DarkHTML == "" {
		t.Fatalf("expected all four previews populated, got %+v", preview)
	}
	// Each variant should still contain the substituted value.
	for name, html := range map[string]string{
		"gmail":   preview.GmailHTML,
		"outlook": preview.OutlookHTML,
		"apple":   preview.AppleHTML,
		"dark":    preview.DarkHTML,
	} {
		if !strings.Contains(html, "Hello Ada") {
			t.Errorf("%s preview missing substituted var: %s", name, html)
		}
	}
}

// TestBuildPreview_EmptyMJML rejects empty input rather than producing
// an empty preview — better to surface the error than to ship a blank
// approximation.
func TestBuildPreview_EmptyMJML(t *testing.T) {
	_, err := BuildPreview(context.Background(), "   ", nil)
	if err == nil {
		t.Errorf("expected error for empty mjml")
	}
}

// TestBuildPreview_OversizedMJML guards the size cap.
func TestBuildPreview_OversizedMJML(t *testing.T) {
	huge := strings.Repeat("a", maxMJMLBytes+1)
	_, err := BuildPreview(context.Background(), huge, nil)
	if err == nil {
		t.Errorf("expected size-limit error")
	}
}
