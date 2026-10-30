// SPDX-License-Identifier: AGPL-3.0-only
package handlers

import "testing"

// Saving SSO must not report success when nothing enforces it.
//
// `sso_provider` and `sso_metadata_url` are written and read by
// internal/handlers/security.go and by NOTHING else in the tree: there is no
// ACS route, no OIDC/SAML provider beyond the single hard-coded "google" in
// `internal/auth/oauth.go`, and `scim.SAMLJITProvision` has zero callers. An
// admin fills in the fields, gets a 200, and their workspace is exactly as
// unprotected as before — while the settings screen shows SSO as configured.
//
// The refusal itself is exercised end-to-end in security_sso_db_test.go. It
// needs a database, because the rule is a COMPARISON against the stored value:
// refusing every request that merely CARRIES a provider locked out every
// workspace that had saved one before the gate existed, since this endpoint is
// a full replace and all three clients send the complete settings object on
// every save. That regression is what these two files exist to prevent from
// recurring in either direction.
//
// This file covers the decision itself, exhaustively and without a database.
// The previous version of this file drove the handler with a nil pool and used
// a recovered panic as its assertion; once the rule had to read stored state
// that trick asserted only that the pool was nil, so it is gone.

func TestChangesSSO(t *testing.T) {
	str := func(s string) *string { return &s }

	cases := []struct {
		name   string
		in     *string
		stored string
		want   bool
		why    string
	}{
		{
			name: "omitted field", in: nil, stored: "", want: false,
			why: "an older client that does not know the field must not be refused for what it never sent",
		},
		{
			name: "omitted field with a value stored", in: nil, stored: "okta", want: false,
			why: "omitting is not changing; the stored value is left exactly as it was",
		},
		{
			name: "new provider on an unconfigured workspace", in: str("okta"), stored: "", want: true,
			why: "this is the case the gate exists for — an operator configuring SSO that does not work",
		},
		{
			name: "the same provider echoed back", in: str("okta"), stored: "okta", want: false,
			why: "THE REGRESSION: a full-replace client resends the stored value on every save, and " +
				"refusing it blocks 2FA and session-timeout changes the operator did make",
		},
		{
			name: "switching to a different provider", in: str("onelogin"), stored: "okta", want: true,
			why: "the echo exemption must not become a way to configure SSO",
		},
		{
			name: "clearing a stored provider", in: str(""), stored: "okta", want: false,
			why: "clearing is the one action that makes stored state match reality; refusing it " +
				"strands the operator with a value they can neither use nor remove",
		},
		{
			name: "whitespace clears, and is not a configuration", in: str("   "), stored: "okta", want: false,
			why: "the write path stores a trimmed-empty value as NULL, so this is a clear",
		},
		{
			name: "whitespace on an unconfigured workspace", in: str("  "), stored: "", want: false,
			why: "blanking an already-blank field changes nothing",
		},
		{
			name: "the same provider with stray whitespace", in: str(" okta "), stored: "okta", want: false,
			why: "comparing untrimmed would read a trailing space as a new configuration and " +
				"refuse a save that changes nothing",
		},
		{
			name: "a stored value with stray whitespace", in: str("okta"), stored: " okta ", want: false,
			why: "the stored side is trimmed too, or a legacy row with padding blocks every save",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := changesSSO(tc.in, tc.stored); got != tc.want {
				in := "<nil>"
				if tc.in != nil {
					in = *tc.in
				}
				t.Errorf("changesSSO(%q, %q) = %v, want %v — %s", in, tc.stored, got, tc.want, tc.why)
			}
		})
	}
}
