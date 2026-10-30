// SPDX-License-Identifier: AGPL-3.0-only
package forms

import "testing"

// captchaConfig (FORM-034) resolves per-form + deployment reCAPTCHA settings.
// The secret is deployment-only; a form can opt in but never supplies a secret.
func TestCaptchaConfig(t *testing.T) {
	form := func(settings map[string]any) *Form { return &Form{Settings: settings} }

	cases := []struct {
		name         string
		deps         Deps
		settings     map[string]any
		wantRequired bool
		wantSiteKey  string
	}{
		{
			name:         "no deployment secret — never enforced even if form opts in",
			deps:         Deps{RecaptchaSecret: "", RecaptchaSiteKey: "srv-key"},
			settings:     map[string]any{"captchaRequired": true},
			wantRequired: false,
			wantSiteKey:  "",
		},
		{
			name:         "server fully configured — required for every form",
			deps:         Deps{RecaptchaSecret: "sec", RecaptchaSiteKey: "srv-key"},
			settings:     nil,
			wantRequired: true,
			wantSiteKey:  "srv-key",
		},
		{
			name:         "secret only, form opts in with its own site key",
			deps:         Deps{RecaptchaSecret: "sec", RecaptchaSiteKey: ""},
			settings:     map[string]any{"captchaRequired": true, "recaptchaSiteKey": "form-key"},
			wantRequired: true,
			wantSiteKey:  "form-key",
		},
		{
			name:         "secret only, form does NOT opt in — not enforced",
			deps:         Deps{RecaptchaSecret: "sec", RecaptchaSiteKey: ""},
			settings:     map[string]any{"recaptchaSiteKey": "form-key"},
			wantRequired: false,
			wantSiteKey:  "",
		},
		{
			name:         "form opts in but has no site key and server has none — no-op, not unsubmittable",
			deps:         Deps{RecaptchaSecret: "sec", RecaptchaSiteKey: ""},
			settings:     map[string]any{"captchaRequired": true},
			wantRequired: false,
			wantSiteKey:  "",
		},
		{
			name:         "per-form site key overrides the server default",
			deps:         Deps{RecaptchaSecret: "sec", RecaptchaSiteKey: "srv-key"},
			settings:     map[string]any{"recaptchaSiteKey": "form-key"},
			wantRequired: true,
			wantSiteKey:  "form-key",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			required, siteKey := tc.deps.captchaConfig(form(tc.settings))
			if required != tc.wantRequired || siteKey != tc.wantSiteKey {
				t.Fatalf("captchaConfig = (%v, %q), want (%v, %q)",
					required, siteKey, tc.wantRequired, tc.wantSiteKey)
			}
		})
	}
}
