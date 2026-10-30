// SPDX-License-Identifier: AGPL-3.0-only

package stepup

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// stepUpRouter builds the protected route with a given session and checker.
func stepUpRouter(satisfied bool, provenAt time.Time, enrolled EnrolmentChecker) http.Handler {
	r := chi.NewRouter()
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := middleware.WithUser(req.Context(), &middleware.User{
				ID: "u1", MFASatisfied: satisfied, MFASatisfiedAt: provenAt,
			})
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	})
	r.Use(Middleware(enrolled))
	r.Post("/api/v1/api-keys/{id}/rotate", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	return r
}

func rotate(h http.Handler) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/api-keys/k1/rotate", nil))
	return rec
}

// The exemption is the whole reason this gate can be mounted.
//
// `mfa_satisfied` is written true only by TOTP verification, so a user who
// never enrolled has it false permanently. Without this they would be 401'd out
// of six routes forever, and the prompt's own re-proof endpoint answers
// `not_enrolled` — a wall with no way over it. That was the recorded blocker on
// mounting, and it was correct.
func TestAUserWithNoSecondFactorIsNotLockedOut(t *testing.T) {
	notEnrolled := func(context.Context, string) (bool, error) { return false, nil }
	rec := rotate(stepUpRouter(false, time.Time{}, notEnrolled))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — a user who cannot answer a challenge "+
			"must not be asked one; they would be locked out of this route forever",
			rec.Code)
	}
}

// And the control must still APPLY to everybody who can answer, or mounting it
// bought nothing.
func TestAnEnrolledUserWithAStaleProofIsStillChallenged(t *testing.T) {
	enrolled := func(context.Context, string) (bool, error) { return true, nil }
	rec := rotate(stepUpRouter(true, time.Now().UTC().Add(-2*time.Hour), enrolled))
	if rec.Code != StatusCode {
		t.Fatalf("status = %d, want %d — the exemption has swallowed the control "+
			"for a user who has a second factor and a stale proof", rec.Code, StatusCode)
	}
	if rec.Header().Get("X-Postwave-Step-Up") == "" {
		t.Error("no X-Postwave-Step-Up header; the client shows a logout rather than a prompt")
	}
}

// A checker error FAILS OPEN, deliberately, and the test states why so nobody
// "fixes" it into a lockout.
//
// Failing closed would deny six routes because a database call blipped, and
// this gate is defence in depth: role and scope checks have already run and
// still apply. The cost is that a sustained outage makes the control quiet,
// which is why the waiver is logged rather than silent.
func TestACheckerFailureLetsTheRequestThroughRatherThanLockingItOut(t *testing.T) {
	broken := func(context.Context, string) (bool, error) {
		return false, errors.New("database unavailable")
	}
	rec := rotate(stepUpRouter(true, time.Time{}, broken))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 — a transient checker failure must not "+
			"deny a route the user is otherwise authorised for", rec.Code)
	}
}

// A fresh proof never consults the checker at all: the cheap path stays cheap,
// and a database call on every protected request would be a cost paid for
// nothing.
func TestAFreshProofDoesNotConsultTheEnrolmentChecker(t *testing.T) {
	called := false
	counting := func(context.Context, string) (bool, error) {
		called = true
		return true, nil
	}
	rec := rotate(stepUpRouter(true, time.Now().UTC().Add(-time.Minute), counting))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if called {
		t.Error("the enrolment checker ran for a session that had already proven " +
			"itself; that is a database round-trip per request on every protected route")
	}
}
