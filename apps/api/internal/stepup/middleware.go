// SPDX-License-Identifier: AGPL-3.0-only
package stepup

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// Middleware enforces the step-up policy on the route being served.
//
// Mounted once on the authenticated router rather than wrapped around each
// sensitive handler. A per-handler wrapper is a rule you must REMEMBER, and the
// endpoints that need this most are the ones somebody adds in a hurry.
//
// Runs AFTER role and scope checks and grants nothing: a person who may not
// rotate a key still cannot. It only asks somebody already permitted to show
// they are still present.
// EnrolmentChecker reports whether this user has a usable second factor.
//
// Required, not optional. A nil-able field would make the exemption below
// silently permanent the day somebody forgets to wire it — the failure this
// repository has shipped before — so it is a constructor argument the compiler
// insists on.
type EnrolmentChecker func(ctx context.Context, userID string) (bool, error)

// Middleware enforces the step-up policy, exempting users who cannot answer it.
//
// THE EXEMPTION IS WHY THIS CAN BE MOUNTED AT ALL. `mfa_satisfied` is written
// true only by TOTP verification, so a user who never enrolled has it false
// permanently: an unexempted gate would 401 them out of workspace invites, role
// changes, subscriber export, security settings and API-key create/rotate,
// forever, with the prompt's own re-proof endpoint answering `not_enrolled`.
// That was recorded as the hard blocker on mounting, and it was right.
//
// The recorded objection to exempting them — "it weakens the control" — is
// comparing the exemption to the ideal. Compared to the ACTUAL state, which is
// unmounted, it is strictly stronger: today nobody on these six routes is asked
// to re-prove anything, and after this everybody who CAN be asked is. A user
// with no second factor is no less protected than they were; a user with one is
// meaningfully more.
func Middleware(enrolled EnrolmentChecker) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return middlewareWith(enrolled, next)
	}
}

func middlewareWith(enrolled EnrolmentChecker, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req := requirementFor(r)
		if !req.Required() {
			next.ServeHTTP(w, r)
			return
		}

		// An API key is not a session and cannot be stepped up: there is nobody
		// present to prompt. Keys are guarded by scopes and by their own
		// creation being step-up'd — which is the point of putting
		// `POST /api/v1/api-keys` in the policy. Gating key traffic here would
		// break every integration for a prompt no machine can answer.
		if middleware.IsAPIKeyAuth(r.Context()) {
			next.ServeHTTP(w, r)
			return
		}

		user, ok := middleware.UserFromContext(r.Context())
		if !ok || user == nil {
			// No identified session on a step-up route. The auth middleware
			// should already have refused; failing closed here costs nothing
			// and means this gate is never the reason an unauthenticated
			// request got further than it should.
			writeChallenge(w, req)
			return
		}
		if !user.MFASatisfied || !req.Satisfied(user.MFASatisfiedAt, time.Now().UTC()) {
			// Only challenge somebody who can answer.
			//
			// FAIL OPEN on a checker error, deliberately, and this is the
			// sharpest trade-off in the file. Failing closed would lock a user
			// out of six routes because a database call blipped, and this gate
			// is defence in depth rather than the primary authorisation — the
			// role and scope checks have already run and still apply. The cost
			// is that a sustained checker outage makes the control quiet, so the
			// error is logged rather than swallowed: a silent pass is how a
			// control stops existing without anyone noticing.
			ok, err := enrolled(r.Context(), user.ID)
			if err != nil {
				observeExemption(r, "check_failed", err)
				next.ServeHTTP(w, r)
				return
			}
			if !ok {
				// No second factor: the prompt would answer `not_enrolled` and
				// the user would have no way forward. Let them through, exactly
				// as today, rather than inventing a wall they cannot climb.
				observeExemption(r, "not_enrolled", nil)
				next.ServeHTTP(w, r)
				return
			}
			writeChallenge(w, req)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// requirementFor resolves the policy for this request.
//
// It matches the request PATH against the policy's route TEMPLATES itself
// rather than asking chi for the matched pattern. The first version did the
// latter and was INERT: middleware registered with `Use` runs before chi
// matches a route, so `RoutePattern()` is empty and every request resolved to
// `Never`. The gate returned 200 for a stale session and the only thing that
// noticed was a test asserting the challenge — a test asserting "no error"
// would have shipped a security control that does nothing.
//
// Matching here also removes the ordering dependency entirely: this middleware
// now behaves the same wherever it is mounted, instead of silently switching
// off if someone moves it.
func requirementFor(r *http.Request) Requirement {
	return Match(r.Method, r.URL.Path)
}

func writeChallenge(w http.ResponseWriter, req Requirement) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	// A machine-readable hint alongside the body, so a client that only looks at
	// headers on a 401 still learns this is a prompt rather than a dead session
	// — the difference between showing a dialog and logging somebody out.
	w.Header().Set("X-Postwave-Step-Up", req.Action)
	w.WriteHeader(StatusCode)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": req.Body()})
}

// observeExemption records that a step-up requirement was waived.
//
// Logged rather than counted silently: the two reasons mean very different
// things. `not_enrolled` is the designed exemption and will be the common case
// until enrolment is enforced. `check_failed` is the control degrading, and a
// run of them is the signal that this gate has quietly stopped applying to
// anybody.
func observeExemption(r *http.Request, reason string, err error) {
	attrs := []any{"reason", reason, "path", r.URL.Path, "method", r.Method}
	if err != nil {
		attrs = append(attrs, "err", err.Error())
	}
	slog.Default().Warn("step-up requirement waived", attrs...)
}
