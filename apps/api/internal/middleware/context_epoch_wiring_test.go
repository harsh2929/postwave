// SPDX-License-Identifier: AGPL-3.0-only

package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The epoch has to actually be SENT.
//
// `ComputeContextEpoch` and `WriteContextEpoch` were written, tested, and had
// ZERO production callers — the server never emitted the header, so no client
// could adopt it even in principle, while the shared package's own doc comment
// said "the server stamps `X-Postwave-Context-Epoch` on every response". These
// tests drive the middleware that does the stamping, through a real handler
// chain, because a unit test of the compute function cannot tell whether
// anything calls it.

func serveWithEpoch(t *testing.T, ctxSetup func(*http.Request) *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	handler := ContextEpochMiddleware()(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/anything", nil)
	if ctxSetup != nil {
		req = ctxSetup(req)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func withIdentity(tenantID, tier, userID, role string, mfa bool) func(*http.Request) *http.Request {
	return func(r *http.Request) *http.Request {
		ctx := WithTenant(r.Context(), &Tenant{ID: tenantID, Slug: "acme", Tier: tier})
		ctx = WithUser(ctx, &User{ID: userID, TenantID: tenantID, Role: role, MFASatisfied: mfa})
		return r.WithContext(ctx)
	}
}

func TestTheEpochHeaderIsActuallyEmitted(t *testing.T) {
	rec := serveWithEpoch(t, withIdentity("t-1", "studio", "u-1", "admin", true))

	got := rec.Header().Get(ContextEpochHeader)
	if got == "" {
		t.Fatalf("no %s header on the response — nothing can adopt an epoch that is never sent",
			ContextEpochHeader)
	}
	if !strings.HasPrefix(got, "ce1-") {
		t.Errorf("epoch = %q, want the versioned `ce1-` prefix", got)
	}
	// Deliberately NO `Vary` on this header: it lists REQUEST header names and
	// nothing sends this one, so the directive could never key a cache. The
	// credential-based `Vary: Cookie, Authorization` from the cache policy is
	// what actually selects the context.
	if vary := rec.Header().Get("Vary"); strings.Contains(vary, ContextEpochHeader) {
		t.Errorf("Vary = %q still names %s, which is inert on a response-only header", vary, ContextEpochHeader)
	}
}

func TestAnonymousResponsesCarryNoEpoch(t *testing.T) {
	// A stable token for "nobody" is a value two signed-out sessions could
	// match on, which is the opposite of what this is for.
	rec := serveWithEpoch(t, nil)
	if got := rec.Header().Get(ContextEpochHeader); got != "" {
		t.Errorf("anonymous response carried an epoch: %q", got)
	}
}

func TestTheEpochMovesWhenTheContextDoes(t *testing.T) {
	base := serveWithEpoch(t, withIdentity("t-1", "studio", "u-1", "admin", true)).
		Header().Get(ContextEpochHeader)
	if base == "" {
		t.Fatal("no baseline epoch")
	}

	cases := []struct {
		name  string
		setup func(*http.Request) *http.Request
		why   string
	}{
		{
			name:  "the user is demoted",
			setup: withIdentity("t-1", "studio", "u-1", "viewer", true),
			why: "same tenant, same user, same query keys — the cache still holds " +
				"the list they could edit a moment ago, and the UI still offers the buttons",
		},
		{
			name:  "the workspace changes plan",
			setup: withIdentity("t-1", "growth", "u-1", "admin", true),
			why:   "features appear or disappear while cached capability answers say otherwise",
		},
		{
			name:  "the session has not satisfied MFA",
			setup: withIdentity("t-1", "studio", "u-1", "admin", false),
			why:   "the UI shows different affordances either side of a step-up challenge",
		},
		{
			name:  "a different user in the same workspace",
			setup: withIdentity("t-1", "studio", "u-2", "admin", true),
			why:   "a colleague signing in on the same machine must not inherit the cache",
		},
		{
			name:  "the same user in a different workspace",
			setup: withIdentity("t-2", "studio", "u-1", "admin", true),
			why:   "the id spaces do not overlap; a queued write would 404 or land somewhere",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := serveWithEpoch(t, tc.setup).Header().Get(ContextEpochHeader)
			if got == base {
				t.Errorf("epoch did not move — %s", tc.why)
			}
		})
	}
}

func TestTheEmittedEpochIsStableForAnUnchangedContext(t *testing.T) {
	// An epoch that moves on its own is worse than none: every response would
	// invalidate every cache and refuse every queued write.
	first := serveWithEpoch(t, withIdentity("t-1", "studio", "u-1", "admin", true)).
		Header().Get(ContextEpochHeader)
	second := serveWithEpoch(t, withIdentity("t-1", "studio", "u-1", "admin", true)).
		Header().Get(ContextEpochHeader)
	if first != second {
		t.Errorf("epoch changed between two identical contexts: %q vs %q", first, second)
	}
}

func TestTheEpochFollowsTheEffectiveRole(t *testing.T) {
	// A View-as-Viewer preview changes what the UI offers. A response cached
	// under the preview must not be served after it ends — which is exactly
	// what an epoch keyed on the DURABLE role would allow.
	durable := serveWithEpoch(t, func(r *http.Request) *http.Request {
		ctx := WithTenant(r.Context(), &Tenant{ID: "t-1", Tier: "studio"})
		ctx = WithUser(ctx, &User{ID: "u-1", Role: "admin"})
		return r.WithContext(ctx)
	}).Header().Get(ContextEpochHeader)

	previewing := serveWithEpoch(t, func(r *http.Request) *http.Request {
		ctx := WithTenant(r.Context(), &Tenant{ID: "t-1", Tier: "studio"})
		ctx = WithUser(ctx, &User{ID: "u-1", Role: "admin", EffectiveRole: "viewer"})
		return r.WithContext(ctx)
	}).Header().Get(ContextEpochHeader)

	if durable == previewing {
		t.Error("the epoch ignored the View-as-Viewer preview, so a response " +
			"computed under it can be served to the unrestricted session")
	}
}

func TestTheEpochDoesNotLeakWhenAnAdminEditedTheRecord(t *testing.T) {
	// It is echoed to the browser on every response, so it must not be a
	// readable fact about the workspace's internals.
	rec := serveWithEpoch(t, withIdentity("t-1", "studio", "u-1", "admin", true))
	got := rec.Header().Get(ContextEpochHeader)
	for _, leaked := range []string{"t-1", "u-1", "admin", "studio"} {
		if strings.Contains(got, leaked) {
			t.Errorf("epoch %q contains %q verbatim; it is meant to be opaque", got, leaked)
		}
	}
}

// The bearer path had no epoch at all.
//
// `middleware.User` is only bound when the key has a bound user
// (internal/apikeys/middleware.go), so a MACHINE key produced no user, the
// middleware skipped, and no header was sent. Mobile in `api_key` mode could
// therefore never learn an epoch and its replay guard was permanently inert.
// A scope revocation was invisible for the same reason: scopes were not an
// input, and on this path there is no role to move either.

func serveAsKey(t *testing.T, tenantID, keyID string, scopes []string) string {
	t.Helper()
	handler := ContextEpochMiddleware(func(*http.Request) []string { return scopes })(
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}),
	)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/anything", nil)
	ctx := WithTenant(req.Context(), &Tenant{ID: tenantID, Tier: "studio"})
	ctx = WithAPIKeyID(ctx, keyID)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req.WithContext(ctx))
	return rec.Header().Get(ContextEpochHeader)
}

func TestAMachineKeyWithNoBoundUserStillGetsAnEpoch(t *testing.T) {
	got := serveAsKey(t, "t-1", "key-1", []string{"campaigns:read"})
	if got == "" {
		t.Fatal("no epoch on the bearer path — a client authenticating with an " +
			"API key can never learn its context changed, so its replay guard " +
			"never fires")
	}
}

func TestRevokingAScopeMovesTheEpoch(t *testing.T) {
	// The only signal available on this path: there is no role here, and the
	// tenant tier does not move when a key is narrowed.
	before := serveAsKey(t, "t-1", "key-1", []string{"campaigns:read", "campaigns:write"})
	after := serveAsKey(t, "t-1", "key-1", []string{"campaigns:read"})
	if before == after {
		t.Error("narrowing a key's scopes left the epoch unchanged, so every " +
			"cached answer computed under the wider grant stays served")
	}
}

func TestScopeORDERDoesNotMoveTheEpoch(t *testing.T) {
	// Hashing whatever order the store happened to return would make the value
	// flap between requests and clear every cache on a coin flip — a
	// correctness mechanism turned into a refetch storm.
	a := serveAsKey(t, "t-1", "key-1", []string{"a:read", "b:write"})
	b := serveAsKey(t, "t-1", "key-1", []string{"b:write", "a:read"})
	if a != b {
		t.Errorf("epoch depends on scope ORDER: %q vs %q", a, b)
	}
}

func TestTwoKeysInOneWorkspaceGetDifferentEpochs(t *testing.T) {
	a := serveAsKey(t, "t-1", "key-1", []string{"campaigns:read"})
	b := serveAsKey(t, "t-1", "key-2", []string{"campaigns:read"})
	if a == b {
		t.Error("two distinct credentials share an epoch, so one key's cached " +
			"answers can be served under another")
	}
}

func TestAnUnauthenticatedRequestStillHasNoEpoch(t *testing.T) {
	// Widening to admit a key must not admit nobody: a stable token for
	// "anonymous" is a value two signed-out sessions could match on.
	if got := serveAsKey(t, "", "", nil); got != "" {
		t.Errorf("anonymous request carried an epoch: %q", got)
	}
}

// A REAL round trip, because `httptest.ResponseRecorder` cannot see this bug.
//
// The middleware sets the header before calling `next`, and the comment says a
// header added after the handler writes its status line is "silently dropped".
// That claim was untested and untestable as written: `ResponseRecorder.Header()`
// returns a live map, so a mutation after `WriteHeader` is still visible to the
// assertion. Moving `WriteContextEpoch` after `next.ServeHTTP` left the whole
// middleware suite green. Only a real server and a real client see the wire.
func TestTheEpochSurvivesToTheWire(t *testing.T) {
	handler := ContextEpochMiddleware()(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// Writes the status line immediately — the case that drops a late header.
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	wrapped := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx := WithTenant(r.Context(), &Tenant{ID: "t-1", Tier: "studio"})
		ctx = WithUser(ctx, &User{ID: "u-1", Role: "admin"})
		handler.ServeHTTP(w, r.WithContext(ctx))
	})

	srv := httptest.NewServer(wrapped)
	defer srv.Close()

	res, err := srv.Client().Get(srv.URL + "/api/v1/anything")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer func() { _ = res.Body.Close() }()

	if got := res.Header.Get(ContextEpochHeader); got == "" {
		t.Fatal("the epoch did not reach the wire — a header set after the " +
			"status line is written is discarded, and no recorder-based test " +
			"can observe that")
	}
}

// The tenant-only path must stay anonymous.
//
// `TestAnUnauthenticatedRequestStillHasNoEpoch` does NOT cover this: it passes
// an empty tenant, so it trips the TenantID guard and never reaches the
// user/key check. But TenantMiddleware explicitly supports "only X-Tenant-Slug
// is provided and no session/API key identity exists" — a tenant with no user
// and no key. Widening ComputeContextEpoch to admit a bare credential made that
// path one line away from emitting a stable, matchable "nobody in tenant T"
// token that two anonymous callers could share.
func TestATenantWithNoUserAndNoKeyGetsNoEpoch(t *testing.T) {
	handler := ContextEpochMiddleware()(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/anything", nil)
	// A tenant, deliberately with NO user and NO api-key id on the context.
	req = req.WithContext(WithTenant(req.Context(), &Tenant{ID: "t-1", Tier: "studio"}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get(ContextEpochHeader); got != "" {
		t.Errorf("a request with no identity at all carried an epoch (%q); two "+
			"anonymous callers in one workspace could match on it", got)
	}
}

// A re-added user gets a new epoch for free.
//
// An earlier comment listed "remove-and-re-add" as a gap needing
// `users.updated_at` on the session. It does not: a re-added user is a new
// `users` row with a new id, and `UserID` is already an input — so the value
// moves by construction. Pinned so the claim cannot quietly stop being true if
// the id ever leaves the hash.
func TestARemovedAndReAddedUserGetsADifferentEpoch(t *testing.T) {
	before := serveWithEpoch(t, withIdentity("t-1", "studio", "u-old", "admin", true)).
		Header().Get(ContextEpochHeader)
	after := serveWithEpoch(t, withIdentity("t-1", "studio", "u-new", "admin", true)).
		Header().Get(ContextEpochHeader)
	if before == "" || before == after {
		t.Errorf("a re-added user (new row, new id) kept the old epoch: %q vs %q",
			before, after)
	}
}
