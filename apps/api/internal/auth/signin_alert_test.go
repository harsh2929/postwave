// SPDX-License-Identifier: AGPL-3.0-only

package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pagination"
)

const (
	uaMacChrome  = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
	uaMacChrome2 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.1234.5 Safari/537.36"
	uaWinEdge    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87"
)

// signInFixture is a real tenant + owner plus a recording notifier.
type signInFixture struct {
	pool     *db.Pool
	repo     *Repo
	deps     *Deps
	tenantID string
	userID   string
	events   []NewDeviceSignIn
}

func newSignInFixture(t *testing.T) *signInFixture {
	t.Helper()
	pool := cliAuthDB(t)
	repo := &Repo{Pool: pool, Pepper: make([]byte, 32)}
	unique := cliUUID(t)
	phc, err := Hash("Sup3rSecret!passphrase", Recommended)
	if err != nil {
		t.Fatalf("Hash: %v", err)
	}
	ctx := context.Background()
	tenantID, userID, err := repo.CreateTenantWithOwner(ctx,
		"Sign-in alert test", "signin-"+unique[:8], "signin-"+unique[:8]+"@example.test", phc)
	if err != nil {
		t.Fatalf("CreateTenantWithOwner: %v", err)
	}
	// deleteAuthTestTenant: a one-minute budget and a retry on transient lock
	// contention. The five seconds this cleanup had were too few for a tenant
	// cascade (about 735 foreign keys) while other packages delete tenants too.
	t.Cleanup(func() { deleteAuthTestTenant(t, pool, tenantID) })

	f := &signInFixture{pool: pool, repo: repo, tenantID: tenantID, userID: userID}
	f.deps = &Deps{
		Repo:          repo,
		CookieOptions: DefaultCookieOptions(),
		ClientIP: func(r *http.Request) string {
			return r.Header.Get("X-Forwarded-For")
		},
		SignInNotifier: func(_ context.Context, ev NewDeviceSignIn) {
			f.events = append(f.events, ev)
		},
	}
	return f
}

// issue mints a session with the supplied user agent, exercising the real
// issuance path (row + cookie + AUTH#47 hook).
func (f *signInFixture) issue(t *testing.T, userAgent string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/v1/auth/login", nil)
	req.Header.Set("User-Agent", userAgent)
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	rec := httptest.NewRecorder()
	if err := f.deps.issueSession(rec, req, f.tenantID, f.userID, "password"); err != nil {
		t.Fatalf("issueSession(%q): %v", userAgent, err)
	}
	return rec
}

// TestNewDeviceSignInAlertFiresOnlyForUnseenDevices is the AUTH#47 core:
// the FIRST session is silent (it is the user's own first login), a repeat
// on the same device is silent, and a genuinely new device produces exactly
// one event carrying the revoke target.
func TestNewDeviceSignInAlertFiresOnlyForUnseenDevices(t *testing.T) {
	f := newSignInFixture(t)

	// 1. First-ever session: no prior sessions, so no alert. Alerting on a
	//    user's own first login is the fastest way to train them to ignore
	//    the notification.
	f.issue(t, uaMacChrome)
	if len(f.events) != 0 {
		t.Fatalf("first session produced %d alerts, want 0: %+v", len(f.events), f.events)
	}

	// 2. Same device again: still silent. The UA differs only by patch
	//    version, which must normalise to the same label — otherwise every
	//    Chrome auto-update would fire a false alarm.
	f.issue(t, uaMacChrome2)
	if len(f.events) != 0 {
		t.Fatalf("same-device re-login produced %d alerts, want 0: %+v", len(f.events), f.events)
	}

	// 3. A genuinely different device: exactly one alert.
	rec := f.issue(t, uaWinEdge)
	if len(f.events) != 1 {
		t.Fatalf("new device produced %d alerts, want 1: %+v", len(f.events), f.events)
	}
	ev := f.events[0]
	if ev.TenantID != f.tenantID || ev.UserID != f.userID {
		t.Fatalf("event principal = %s/%s, want %s/%s", ev.TenantID, ev.UserID, f.tenantID, f.userID)
	}
	if ev.Device.Label != "Edge on Windows" {
		t.Fatalf("event device label = %q, want %q", ev.Device.Label, "Edge on Windows")
	}
	if ev.AuthMethod != "password" {
		t.Fatalf("event auth method = %q, want password", ev.AuthMethod)
	}
	if ev.IP != "203.0.113.9" {
		t.Fatalf("event ip = %q, want 203.0.113.9", ev.IP)
	}

	// The SessionID must be the id from the cookie that was just set — that
	// is what DELETE /api/v1/auth/sessions/{id} takes, so a push action
	// button can revoke straight from the payload. If these ever diverge the
	// notification's one-tap revoke silently targets nothing.
	var cookieID string
	for _, c := range rec.Result().Cookies() {
		if c.Name == SessionCookieName {
			cookieID = strings.SplitN(c.Value, ".", 2)[0]
		}
	}
	if cookieID == "" {
		t.Fatal("no session cookie was set")
	}
	if ev.SessionID != cookieID {
		t.Fatalf("event session id = %q, cookie session id = %q", ev.SessionID, cookieID)
	}

	// And the id must actually resolve to a revocable session.
	revoked, err := f.repo.RevokeUserSessionByID(context.Background(), f.userID, ev.SessionID)
	if err != nil {
		t.Fatalf("RevokeUserSessionByID: %v", err)
	}
	if !revoked {
		t.Fatal("the session id carried by the alert is not revocable")
	}

	// 4. A fourth login from the ORIGINAL device stays silent even though
	//    the newest device is different — the check is membership in the
	//    user's history, not "differs from the last one".
	f.issue(t, uaMacChrome)
	if len(f.events) != 1 {
		t.Fatalf("known-device re-login produced extra alerts: %+v", f.events)
	}
}

// TestSignInAlertNeverBlocksLogin pins invariant 1: a notifier that panics
// or a missing notifier must not change whether a session is issued. The
// session row and cookie are the contract; the alert is decoration.
func TestSignInAlertNeverBlocksLogin(t *testing.T) {
	f := newSignInFixture(t)
	f.issue(t, uaMacChrome) // establish history so the next login is "new"

	// No notifier wired at all (the deployment has no fanout).
	f.deps.SignInNotifier = nil
	rec := f.issue(t, uaWinEdge)
	if len(rec.Result().Cookies()) == 0 {
		t.Fatal("session cookie missing when no notifier is wired")
	}

	// A notifier that fails loudly must still leave the session intact. The
	// production wiring hands off to a goroutine, but a synchronous panic
	// here would take the login request down with it.
	panicked := false
	f.deps.SignInNotifier = func(context.Context, NewDeviceSignIn) {
		panicked = true
		panic("notifier exploded")
	}
	func() {
		defer func() { _ = recover() }()
		f.issue(t, "curl/8.6.0")
	}()
	if !panicked {
		t.Fatal("notifier was not invoked for a new device")
	}
	// The session must exist despite the notifier blowing up, because the
	// hook runs strictly after the row commits and the cookie is written.
	sessions, _, err := f.repo.ListUserSessions(context.Background(), f.userID, 50, pagination.Cursor{})
	if err != nil {
		t.Fatalf("ListUserSessions: %v", err)
	}
	found := false
	for _, s := range sessions {
		if IdentifyDevice(s.UserAgent).Label == "curl" {
			found = true
		}
	}
	if !found {
		t.Fatal("the session was not persisted when the notifier panicked")
	}
}

// TestSignInAlertSuppressedWhenHistoryUnreadable pins invariant 3: when the
// prior-device lookup cannot answer, we stay QUIET rather than alerting on
// every single login. Alerting on a database hiccup is alarm fatigue, which
// silences the notification permanently instead of for one request.
//
// A cancelled request context is a real, reachable failure of exactly that
// lookup — no fakes, and it proves the error branch rather than skipping it.
func TestSignInAlertSuppressedWhenHistoryUnreadable(t *testing.T) {
	f := newSignInFixture(t)
	f.issue(t, uaMacChrome) // build history so the next device IS new
	f.issue(t, uaWinEdge)   // and confirm the alert normally fires
	if len(f.events) != 1 {
		t.Fatalf("setup: expected 1 alert, got %d", len(f.events))
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequest("POST", "/api/v1/auth/login", nil).WithContext(ctx)
	req.Header.Set("User-Agent", "curl/8.6.0") // a device never seen before
	f.deps.maybeNotifyNewDeviceSignIn(req, f.tenantID, f.userID, "sess-x", "password", "", "curl/8.6.0")

	if len(f.events) != 1 {
		t.Fatalf("an unreadable history produced an alert: %+v", f.events)
	}

	// And the underlying query genuinely failed — otherwise this test would
	// pass for the wrong reason (e.g. the device being classified as known).
	if _, err := f.repo.PriorSessionUserAgents(ctx, f.userID, "sess-x"); err == nil {
		t.Fatal("expected PriorSessionUserAgents to fail on a cancelled context")
	}
}

// TestSignInAlertSurvivesANilPool pins the other half of invariant 1: a
// half-wired Deps must not panic the login request. Before the explicit
// Pool check this dereferenced nil inside withResolverGUC.
func TestSignInAlertSurvivesANilPool(t *testing.T) {
	t.Parallel()
	called := false
	d := &Deps{
		Repo:           &Repo{Pool: nil},
		SignInNotifier: func(context.Context, NewDeviceSignIn) { called = true },
	}
	req := httptest.NewRequest("POST", "/", nil)
	d.maybeNotifyNewDeviceSignIn(req, "tenant", "user", "sess", "password", "", uaMacChrome)
	if called {
		t.Fatal("notifier fired without a usable pool")
	}
}

// TestPriorSessionUserAgentsExcludesTheCurrentSession guards the off-by-one
// that would make EVERY login look like a known device: if the just-created
// session were included in its own history, the label would always match.
func TestPriorSessionUserAgentsExcludesTheCurrentSession(t *testing.T) {
	f := newSignInFixture(t)
	f.deps.SignInNotifier = nil // isolate the repo behaviour
	rec := f.issue(t, uaMacChrome)
	var sessionID string
	for _, c := range rec.Result().Cookies() {
		if c.Name == SessionCookieName {
			sessionID = strings.SplitN(c.Value, ".", 2)[0]
		}
	}
	if sessionID == "" {
		t.Fatal("no session cookie")
	}
	agents, err := f.repo.PriorSessionUserAgents(context.Background(), f.userID, sessionID)
	if err != nil {
		t.Fatalf("PriorSessionUserAgents: %v", err)
	}
	if len(agents) != 0 {
		t.Fatalf("the only session leaked into its own history: %+v", agents)
	}

	f.issue(t, uaWinEdge)
	agents, err = f.repo.PriorSessionUserAgents(context.Background(), f.userID, sessionID)
	if err != nil {
		t.Fatalf("PriorSessionUserAgents: %v", err)
	}
	if len(agents) != 1 || agents[0] != uaWinEdge {
		t.Fatalf("history = %+v, want exactly [%q]", agents, uaWinEdge)
	}
}

// TestMaybeNotifyIsInertWithoutDependencies covers the nil-safety the login
// path relies on, without touching a database.
func TestMaybeNotifyIsInertWithoutDependencies(t *testing.T) {
	t.Parallel()
	req := httptest.NewRequest("POST", "/", nil)
	called := false
	// No repo: nothing to check history against.
	(&Deps{SignInNotifier: func(context.Context, NewDeviceSignIn) { called = true }}).
		maybeNotifyNewDeviceSignIn(req, "t", "u", "s", "password", "", uaMacChrome)
	// No notifier: nothing to call.
	(&Deps{Repo: &Repo{}}).
		maybeNotifyNewDeviceSignIn(req, "t", "u", "s", "password", "", uaMacChrome)
	// Incomplete principal: refuse rather than emit an unattributable alert.
	(&Deps{Repo: &Repo{}, SignInNotifier: func(context.Context, NewDeviceSignIn) { called = true }}).
		maybeNotifyNewDeviceSignIn(req, "", "", "", "password", "", uaMacChrome)
	if called {
		t.Fatal("notifier fired without its dependencies")
	}
}

var _ = http.StatusOK
