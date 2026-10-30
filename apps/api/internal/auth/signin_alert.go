// SPDX-License-Identifier: AGPL-3.0-only
//
// signin_alert.go — the producer half of "a new device just signed in as you".
//
// The delivery half already existed and was fully built: notifyfanout is the
// single dispatch chokepoint (identity → dedup → mobile/web/SSE fanout), the
// mobile client registers actionable push categories, and DELETE
// /api/v1/auth/sessions/{id} is the revoke verb the notification's action
// button calls. What was missing was an EVENT: nothing in this package ever
// announced that a session had been created, so the push had nothing to
// carry.
//
// This file emits exactly that, and nothing else. It does not send anything
// itself — auth stays free of the push/mail dependency graph, the same way
// MintCLIKey and MeContextLookup are callbacks rather than imports.
//
// FOUR INVARIANTS, because this runs inside session issuance:
//
//  1. IT CANNOT FAIL A LOGIN. Every path here is best-effort. The notifier
//     is invoked only after the session row has committed and the cookie is
//     set, and every error is swallowed after a structured log line.
//
//  2. IT CANNOT ALERT ON A FIRST LOGIN. A user with no prior sessions is
//     signing in for the first time; telling them their own signup is
//     suspicious is the fastest way to teach them to ignore the alert.
//
//  3. IT DOES NOT GUESS WHEN IT CANNOT TELL. If the prior-device lookup
//     fails, no notification is emitted and a warning is logged. The
//     alternative — alerting on every login while the database is unhappy —
//     is alarm fatigue, which silences the alert permanently rather than
//     for one request. The log line is the escalation path.
//
//  4. THE HEURISTIC IS RECOGNITION, NOT AUTHORIZATION. Device identity comes
//     from IdentifyDevice, i.e. a self-reported header. Nothing here gates
//     access; a forged UA buys an attacker only a quieter notification, and
//     the session is created identically either way.
package auth

import (
	"context"
	"log/slog"
	"net/http"
)

// SignInEventType is the canonical notifyfanout event type for this
// producer. Kept as an exported constant so the wiring in main.go, the
// notification manifest, and the mobile push category all name the same
// string instead of three copies of a literal.
// Native delivery uses a staged compatibility fence: the event is in the
// shared manifest and server allowlist, but listDevicesForUser still requires
// it to be present in each installation's persisted enabled_events array. An
// older installed build therefore cannot receive a push naming the new
// Android channel/action until a compatible client re-registers that event.
const SignInEventType = "auth.new_device_sign_in"

// NewDeviceSignIn is everything a notification renderer needs about a
// just-created session. It is deliberately free of secrets: no session
// verifier, no cookie, no token — only the session ID, which is exactly the
// value DELETE /api/v1/auth/sessions/{id} takes, so a push action button can
// revoke straight from the payload.
type NewDeviceSignIn struct {
	TenantID string
	UserID   string
	// SessionID is the revoke target.
	SessionID string
	// AuthMethod is how the session was minted: password, magic_link,
	// oauth, device_grant. Worth surfacing — "signed in with a magic link
	// from a Windows PC" is a very different sentence to the user than
	// "signed in with your password".
	AuthMethod string
	// Device is the normalised label (AUTH#53's parser, reused so the
	// notification copy and the sessions list cannot describe the same
	// device differently).
	Device DeviceIdentity
	// IP is the issue-time client IP, already normalised by
	// bestEffortClientIP. May be empty.
	IP string
}

// SignInNotifier is main.go's hook into notifyfanout. Nil disables the
// feature entirely (the deployment simply has no fanout wired).
//
// CONTRACT: implementations MUST NOT block. They are called synchronously on
// the login path after the session commits; the wiring is responsible for
// handing off to a goroutine before doing any network I/O. Keeping the
// decision here synchronous is what makes it testable.
type SignInNotifier func(ctx context.Context, ev NewDeviceSignIn)

// maybeNotifyNewDeviceSignIn decides whether the just-issued session came
// from a device this user has not been seen on, and if so hands the event to
// the notifier. Best-effort throughout; never returns an error because there
// is no caller that should act on one.
func (d *Deps) maybeNotifyNewDeviceSignIn(
	r *http.Request, tenantID, userID, sessionID, authMethod, ip, userAgent string,
) {
	// Repo.Pool is checked explicitly: withResolverGUC dereferences it, and a
	// nil-pointer panic on the login path would take the request down with
	// it — the exact thing invariant 1 forbids.
	if d == nil || d.SignInNotifier == nil || d.Repo == nil || d.Repo.Pool == nil {
		return
	}
	if tenantID == "" || userID == "" || sessionID == "" {
		return
	}
	log := d.Logger
	if log == nil {
		log = slog.Default()
	}

	priorAgents, err := d.Repo.PriorSessionUserAgents(r.Context(), userID, sessionID)
	if err != nil {
		// Invariant 3: say nothing, but say loudly that we said nothing.
		log.Warn("auth: new-device check failed; suppressing sign-in alert",
			"event", SignInEventType, "tenant_id", tenantID,
			"user_id", userID, "err", err.Error())
		return
	}
	if len(priorAgents) == 0 {
		// Invariant 2: first ever session for this user.
		return
	}

	device := IdentifyDevice(userAgent)
	for _, prior := range priorAgents {
		if IdentifyDevice(prior).Label == device.Label {
			return // known device
		}
	}

	d.SignInNotifier(r.Context(), NewDeviceSignIn{
		TenantID:   tenantID,
		UserID:     userID,
		SessionID:  sessionID,
		AuthMethod: authMethod,
		Device:     device,
		IP:         ip,
	})
}
