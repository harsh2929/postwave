// SPDX-License-Identifier: AGPL-3.0-only
//
// device_trust_consume.go — the one place a device-trust credential is turned
// into an MFA-satisfied session.
//
// It lives in its own file, apart from both the issuance handler and the
// generic session plumbing, because it is the single line of AUTH#48 whose
// failure mode is "MFA silently bypassed". Keeping it small, isolated and
// directly tested is the point.
//
// THE RULE: this function returns true ONLY when a live, unrevoked, unexpired
// trust record for exactly this (tenant, user) is presented with a matching
// verifier by a tenant that still permits device trust. EVERY other outcome —
// including an unreadable database — returns false. There is no branch in
// which uncertainty grants access.
package auth

import (
	"log/slog"
	"net/http"
)

// consumeDeviceTrust reports whether the request carries a valid device-trust
// credential for (tenantID, userID), and records the use.
//
// Called from issueSessionWithLifetime, so it applies uniformly to password
// login, magic link, OAuth, passkey login, workspace switch and CLI device
// grants. That uniformity is intentional: the credential describes a DEVICE,
// not a sign-in method, and a user who trusted this phone should not have to
// re-challenge merely because they signed in with a link this time.
//
// Cross-tenant safety comes from the lookup being scoped by tenant_id AND
// user_id: a record trusted in workspace A cannot satisfy MFA in workspace B
// even though the cookie is shared, because the row simply will not match.
func (d *Deps) consumeDeviceTrust(r *http.Request, tenantID, userID string) bool {
	if d == nil || d.Repo == nil || tenantID == "" || userID == "" {
		return false
	}
	tok, err := ParseTrustCookie(r)
	if err != nil {
		// No cookie is the common case (most logins are untrusted devices);
		// a malformed one is either tampering or a bad copy. Both mean the
		// same thing here: no trust.
		return false
	}
	trusted, err := d.Repo.ConsumeTrustedDevice(r.Context(), tenantID, userID, tok.ID, tok.Verifier)
	if err != nil {
		// FAIL CLOSED, AND FAIL LOUD. A database we could not read has not
		// told us this device is trusted. The user simply gets challenged,
		// which is the correct outcome; the log line exists so a persistent
		// failure here does not silently look like "nobody uses the feature".
		log := d.Logger
		if log == nil {
			log = slog.Default()
		}
		log.ErrorContext(r.Context(), "auth: device-trust consumption failed; challenging instead",
			"tenant_id", tenantID, "user_id", userID, "err", err.Error())
		return false
	}
	return trusted
}
