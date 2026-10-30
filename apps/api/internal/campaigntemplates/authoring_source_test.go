// SPDX-License-Identifier: AGPL-3.0-only
package campaigntemplates

import "testing"

func TestHandAuthoredCreateKeepsOnlyAuthoritativeSource(t *testing.T) {
	for _, tc := range []struct {
		name, html, mjml, wantHTML, wantMJML string
	}{
		{"html only", "<p>HTML</p>", "", "<p>HTML</p>", ""},
		{"mjml only", "", "<mjml><mj-body /></mjml>", "", "<mjml><mj-body /></mjml>"},
		{"legacy dual source", "<p>Stale HTML</p>", "<mjml><mj-body /></mjml>", "", "<mjml><mj-body /></mjml>"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			trusted, err := (authoringCreateInput{
				Slug: "source-test", Name: "Source test", Subject: "Subject",
				BodyHTML: tc.html, BodyMJML: tc.mjml,
			}).trustedInput()
			if err != nil {
				t.Fatalf("trustedInput: %v", err)
			}
			if trusted.BodyHTML != tc.wantHTML || trusted.BodyMJML != tc.wantMJML {
				t.Fatalf("source = (%q, %q), want (%q, %q)", trusted.BodyHTML, trusted.BodyMJML, tc.wantHTML, tc.wantMJML)
			}
		})
	}
}

func TestHandAuthoredUpdateRetiresStaleSource(t *testing.T) {
	html := "<p>Edited HTML</p>"
	mjml := "<mjml><mj-body><mj-text>Edited</mj-text></mj-body></mjml>"
	for _, tc := range []struct {
		name, wantHTML, wantMJML string
		patch                    UpdateInput
	}{
		{"metadata only", "<p>Old HTML</p>", "<mjml>Old MJML</mjml>", UpdateInput{}},
		{"HTML edit", html, "", UpdateInput{BodyHTML: &html}},
		{"MJML edit", "", mjml, UpdateInput{BodyMJML: &mjml}},
		{"legacy dual edit", "", mjml, UpdateInput{BodyHTML: &html, BodyMJML: &mjml}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			template := &Template{BodyHTML: "<p>Old HTML</p>", BodyMJML: "<mjml>Old MJML</mjml>"}
			applyAuthoringSourcePatch(template, tc.patch)
			if template.BodyHTML != tc.wantHTML || template.BodyMJML != tc.wantMJML {
				t.Fatalf("source = (%q, %q), want (%q, %q)", template.BodyHTML, template.BodyMJML, tc.wantHTML, tc.wantMJML)
			}
		})
	}
}

func TestEditableRegionsFollowAuthoritativeMJML(t *testing.T) {
	template := &Template{BodyHTML: "{{region:old}}", BodyMJML: "{{region:current}}"}
	if got := regionSource(template); got != template.BodyMJML {
		t.Fatalf("region source = %q, want MJML", got)
	}
}
