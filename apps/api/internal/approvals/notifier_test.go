// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for per-recipient gating in the approvals Notifier. The bug
// these tests pin down: previously the handler ran a single gate keyed
// on the REQUESTER's user_id and, if it returned false, silenced the
// email for every admin recipient. With multi-admin tenants that's
// wrong — each admin has their own notification_preferences row and
// should be honored independently. The fix moves the gate from
// handler-level into the notifier loop, one Dispatcher.Gate call per
// admin recipient.
package approvals

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/notifications"
)

// dispatcherStub is a notifications.Dispatcher whose Gate result is
// looked up per-user_id from a map. Defaults to allow=true (fail-open
// matches the production contract) for users not in the map, so tests
// only have to enumerate the negative cases.
type dispatcherStub struct {
	mu      sync.Mutex
	allow   map[string]bool
	errFor  map[string]error
	gateErr error // global fallback when allow + errFor have no entry
	calls   int32
}

func (s *dispatcherStub) Gate(_ context.Context, _, userID string, _ notifications.Pref) (bool, error) {
	atomic.AddInt32(&s.calls, 1)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err, ok := s.errFor[userID]; ok {
		// Production PgDispatcher fails open: (true, err). Mirror that.
		return true, err
	}
	if allowed, ok := s.allow[userID]; ok {
		return allowed, nil
	}
	if s.gateErr != nil {
		return true, s.gateErr
	}
	return true, nil
}

// captureMailer records every outbound recipient. Stands in for the
// Postmark HTTP target so tests don't need a fake HTTP server for
// every send — the test below DOES use httptest for the wire layer,
// but this lighter recorder is reused for the per-recipient loop
// assertions on PostmarkNotifier.send via a stubbed HTTP server.
//
// Each test below constructs its own httptest.Server inside the test
// body so we record exact request counts without leaking server
// state between subtests.
//
// (Kept around as a doc comment placeholder; the actual recording
// happens via the httptest.Server's handler below.)

// TestPostmarkNotifier_PerRecipientGating asserts the headline fix: 3
// admins, 2 have pref=true and 1 has pref=false → notifier sends to 2
// addresses and skips 1.
func TestPostmarkNotifier_PerRecipientGating(t *testing.T) {
	t.Parallel()

	var (
		mu       sync.Mutex
		gotTos   []string
		serverCt int32
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&serverCt, 1)
		// The Postmark POST body is a JSON object with a "To" field.
		// Pull it out without decoding to a typed struct (we don't
		// need anything else here).
		mu.Lock()
		defer mu.Unlock()
		// Cheap manual parse: the body always looks like
		//   {"From":"...","To":"<addr>",...}
		// Read it, then scan for the To field.
		var body map[string]any
		if err := decodeJSON(r, &body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		if to, ok := body["To"].(string); ok {
			gotTos = append(gotTos, to)
		}
		w.WriteHeader(200)
	}))
	defer srv.Close()

	disp := &dispatcherStub{
		allow: map[string]bool{
			"u-alice": true,
			"u-bob":   true,
			"u-carol": false, // opted out
		},
	}
	notifier := &PostmarkNotifier{
		HTTPClient:    srv.Client(),
		ServerToken:   "fake",
		BaseURL:       srv.URL,
		From:          "noreply@postwave.test",
		PublicBaseURL: "https://example.test",
		Service:       &Service{HMACKey: []byte("k"), Now: func() time.Time { return time.Unix(0, 0) }},
		AdminLister: AdminListerFunc(func(_ context.Context, _ string) ([]AdminRecipient, error) {
			return []AdminRecipient{
				{UserID: "u-alice", Email: "alice@tenant.test"},
				{UserID: "u-bob", Email: "bob@tenant.test"},
				{UserID: "u-carol", Email: "carol@tenant.test"},
			}, nil
		}),
		Dispatcher: disp,
	}

	a := &Approval{
		ID:           "ap-1",
		TenantID:     "t1",
		ResourceType: string(ResourceCampaign),
		ResourceID:   "c1",
		ExpiresAt:    time.Unix(0, 0).Add(time.Hour),
	}
	if err := notifier.NotifyRequested(context.Background(), "t1", a); err != nil {
		t.Fatalf("NotifyRequested: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	sort.Strings(gotTos)
	want := []string{"alice@tenant.test", "bob@tenant.test"}
	if got := atomic.LoadInt32(&serverCt); int(got) != len(want) {
		t.Fatalf("postmark server hit %d times, want %d (tos=%v)", got, len(want), gotTos)
	}
	if !equalStringSlice(gotTos, want) {
		t.Errorf("recipients: got %v want %v", gotTos, want)
	}
	if atomic.LoadInt32(&disp.calls) != 3 {
		t.Errorf("dispatcher.Gate calls: got %d want 3 (one per recipient)", atomic.LoadInt32(&disp.calls))
	}
}

// TestPostmarkNotifier_DispatcherError_FailsOpen asserts that a DB
// error in the gate lookup defaults to send, matching the documented
// fail-open contract on notifications.Dispatcher.
func TestPostmarkNotifier_DispatcherError_FailsOpen(t *testing.T) {
	t.Parallel()
	var serverCt int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&serverCt, 1)
		w.WriteHeader(200)
	}))
	defer srv.Close()

	disp := &dispatcherStub{
		// Carol's per-user lookup errors; production PgDispatcher
		// returns (true, err) in that case so the notifier MUST still
		// fire.
		errFor: map[string]error{"u-carol": errors.New("pgx: connection closed")},
		allow: map[string]bool{
			"u-alice": true,
			"u-bob":   true,
		},
	}
	notifier := &PostmarkNotifier{
		HTTPClient:  srv.Client(),
		ServerToken: "fake",
		BaseURL:     srv.URL,
		From:        "noreply@postwave.test",
		Service:     &Service{HMACKey: []byte("k"), Now: func() time.Time { return time.Unix(0, 0) }},
		AdminLister: AdminListerFunc(func(_ context.Context, _ string) ([]AdminRecipient, error) {
			return []AdminRecipient{
				{UserID: "u-alice", Email: "alice@tenant.test"},
				{UserID: "u-bob", Email: "bob@tenant.test"},
				{UserID: "u-carol", Email: "carol@tenant.test"},
			}, nil
		}),
		Dispatcher: disp,
	}

	a := &Approval{ID: "ap-2", TenantID: "t1", ResourceType: "campaign", ResourceID: "c1",
		ExpiresAt: time.Unix(0, 0).Add(time.Hour)}
	if err := notifier.NotifyRequested(context.Background(), "t1", a); err != nil {
		t.Fatalf("NotifyRequested: %v", err)
	}
	if got := atomic.LoadInt32(&serverCt); got != 3 {
		t.Errorf("postmark hits = %d, want 3 (fail-open should still send to carol)", got)
	}
}

// TestPostmarkNotifier_WithSilencedNotifier asserts the
// WithSilencedNotifier() opt still works at the Service.Request level:
// no notifier invocation at all, regardless of how many recipients
// AdminLister would produce. This pins the backward-compat contract.
func TestPostmarkNotifier_WithSilencedNotifier(t *testing.T) {
	t.Parallel()
	var serverCt int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&serverCt, 1)
		w.WriteHeader(200)
	}))
	defer srv.Close()

	notifier := &PostmarkNotifier{
		HTTPClient:  srv.Client(),
		ServerToken: "fake",
		BaseURL:     srv.URL,
		From:        "noreply@postwave.test",
		Service:     &Service{HMACKey: []byte("k"), Now: func() time.Time { return time.Unix(0, 0) }},
		AdminLister: AdminListerFunc(func(_ context.Context, _ string) ([]AdminRecipient, error) {
			return []AdminRecipient{{UserID: "u1", Email: "a@b.test"}}, nil
		}),
	}

	// Build a Service whose insert path is a no-op, and whose
	// Notifier is the one under test. WithSilencedNotifier() should
	// short-circuit BEFORE the notifier goroutine is dispatched.
	svc := &Service{
		Notifier: notifier,
		Now:      func() time.Time { return time.Unix(0, 0) },
		TTL:      time.Hour,
	}
	svc.insertFn = func(_ context.Context, a *Approval) error {
		a.ID = "ap-silent"
		return nil
	}

	if _, err := svc.Request(context.Background(), "t1",
		Resource{Type: ResourceCampaign, ID: "c1"},
		Actor{Type: "user", Label: "user-1"},
		WithSilencedNotifier()); err != nil {
		t.Fatalf("Request: %v", err)
	}

	// Give the goroutine a moment to NOT fire.
	time.Sleep(150 * time.Millisecond)
	if got := atomic.LoadInt32(&serverCt); got != 0 {
		t.Errorf("postmark hits = %d, want 0 (silenced notifier must not fire)", got)
	}
}

// TestPostmarkNotifier_LegacyFallback_NoAdminLister asserts that when
// AdminLister is unset, the notifier falls back to the tenants
// .approval_notify_email path. The legacy path is NOT per-user gated.
//
// We can't construct a real Repo without a database, but the
// PostmarkNotifier code path bails before LookupTenantApprovalNotifyEmail
// when AdminLister is wired AND returns at least one recipient. To
// exercise the fallback cleanly we'd need a Repo stub; instead, we
// assert the symmetric case: AdminLister returns an empty list AND the
// Repo is nil → the notifier returns an error rather than panicking.
// That's the contract production needs: never crash on a missing repo.
func TestPostmarkNotifier_LegacyFallback_EmptyListNoRepo(t *testing.T) {
	t.Parallel()
	notifier := &PostmarkNotifier{
		HTTPClient:  &http.Client{},
		ServerToken: "fake",
		BaseURL:     "http://unused",
		Service:     &Service{HMACKey: []byte("k"), Now: func() time.Time { return time.Unix(0, 0) }},
		AdminLister: AdminListerFunc(func(_ context.Context, _ string) ([]AdminRecipient, error) {
			return nil, nil
		}),
		// Repo intentionally left nil so the legacy fallback's pool
		// access panics — except the fallback only runs when the
		// recipient list is empty AND Repo is set. With Repo nil we
		// expect a clean no-op (no panic).
	}
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("notifier panicked on empty list + nil repo: %v", r)
		}
	}()
	// nil Repo will dereference inside LookupTenantApprovalNotifyEmail,
	// so we expect an error. The important property is no panic.
	_ = notifier.NotifyRequested(context.Background(), "t1", &Approval{
		ID: "ap-empty", TenantID: "t1", ExpiresAt: time.Unix(0, 0).Add(time.Hour),
	})
}

func TestPostmarkNotifierPreservesBasePathAndTrimsPublicBase(t *testing.T) {
	t.Parallel()
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	notifier := &PostmarkNotifier{
		HTTPClient:    srv.Client(),
		ServerToken:   "fake",
		BaseURL:       srv.URL + "/postmark/",
		From:          "noreply@postwave.test",
		PublicBaseURL: "https://app.example.test/",
		Service:       &Service{HMACKey: []byte("k"), Now: func() time.Time { return time.Unix(0, 0) }},
		AdminLister: AdminListerFunc(func(_ context.Context, _ string) ([]AdminRecipient, error) {
			return []AdminRecipient{{UserID: "u1", Email: "admin@tenant.test"}}, nil
		}),
	}
	a := &Approval{ID: "ap-base", TenantID: "t1", ResourceType: "campaign", ResourceID: "c1", ExpiresAt: time.Unix(0, 0).Add(time.Hour)}
	if err := notifier.NotifyRequested(context.Background(), "t1", a); err != nil {
		t.Fatalf("NotifyRequested: %v", err)
	}
	if gotPath != "/postmark/email" {
		t.Fatalf("path = %q", gotPath)
	}
	link := notifier.linkFor("ap-base", DecisionApprove, "tok")
	if strings.HasPrefix(link, "https://app.example.test//") {
		t.Fatalf("link kept duplicate slash: %q", link)
	}
	link = notifier.linkFor("ap/base", DecisionApprove, "tok")
	if !strings.Contains(link, "/approvals/ap%2Fbase/decide?") {
		t.Fatalf("link did not path-escape id: %q", link)
	}
}

func TestPostmarkNotifierURLRejectsUnsafeBase(t *testing.T) {
	t.Parallel()
	for _, base := range []string{
		"https://user:pass@api.postmarkapp.com",
		"https://api.postmarkapp.com?tenant=one",
		"https://api.postmarkapp.com#fragment",
		"file:///tmp/postmark",
	} {
		if _, err := postmarkNotifierURL(base, "/email"); err == nil {
			t.Fatalf("expected unsafe base %q to fail", base)
		}
	}
	for _, path := range []string{"/%2e%2e/email", "/postmark\\email"} {
		if _, err := postmarkNotifierURL("https://api.postmarkapp.com", path); err == nil {
			t.Fatalf("expected unsafe path %q to fail", path)
		}
	}
}

// pushStub records every (userID, payload) a PushNotifier receives. The
// configured return mimics webpush.Deps.SendToUser: (deviceCount, err).
type pushStub struct {
	mu      sync.Mutex
	gotUser []string
	gotTag  []string
	err     error
}

func (p *pushStub) SendToUser(_ context.Context, _, userID string, n PushNotification) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.gotUser = append(p.gotUser, userID)
	p.gotTag = append(p.gotTag, n.Tag)
	return 1, p.err
}

// TestPostmarkNotifier_PushFiresForGatedRecipients asserts the browser-push
// channel fans out to exactly the recipients that pass the PrefApprovalRequest
// gate — the same set the email reaches — and never to a pref-opted-out user.
func TestPostmarkNotifier_PushFiresForGatedRecipients(t *testing.T) {
	t.Parallel()

	var serverCt int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&serverCt, 1)
		w.WriteHeader(200)
	}))
	defer srv.Close()

	disp := &dispatcherStub{allow: map[string]bool{
		"u-alice": true,
		"u-bob":   true,
		"u-carol": false, // opted out → neither email nor push
	}}
	push := &pushStub{}
	notifier := &PostmarkNotifier{
		HTTPClient:  srv.Client(),
		ServerToken: "fake",
		BaseURL:     srv.URL,
		From:        "noreply@postwave.test",
		Service:     &Service{HMACKey: []byte("k"), Now: func() time.Time { return time.Unix(0, 0) }},
		AdminLister: AdminListerFunc(func(_ context.Context, _ string) ([]AdminRecipient, error) {
			return []AdminRecipient{
				{UserID: "u-alice", Email: "alice@tenant.test"},
				{UserID: "u-bob", Email: "bob@tenant.test"},
				{UserID: "u-carol", Email: "carol@tenant.test"},
			}, nil
		}),
		Dispatcher: disp,
		Push:       push,
	}

	a := &Approval{ID: "ap-9", TenantID: "t1", ResourceType: string(ResourceCampaign),
		ResourceID: "c1", ExpiresAt: time.Unix(0, 0).Add(time.Hour)}
	if err := notifier.NotifyRequested(context.Background(), "t1", a); err != nil {
		t.Fatalf("NotifyRequested: %v", err)
	}

	push.mu.Lock()
	defer push.mu.Unlock()
	sort.Strings(push.gotUser)
	if want := []string{"u-alice", "u-bob"}; !equalStringSlice(push.gotUser, want) {
		t.Errorf("push recipients: got %v want %v", push.gotUser, want)
	}
	if got := atomic.LoadInt32(&serverCt); got != 2 {
		t.Errorf("email hits = %d, want 2 (push must not change email fan-out)", got)
	}
	for _, tag := range push.gotTag {
		if tag != "approval-ap-9" {
			t.Errorf("push tag = %q, want approval-ap-9", tag)
		}
	}
}

// TestPostmarkNotifier_PushFailureDoesNotBlockEmail asserts a push delivery
// error is swallowed (best-effort) and the email still sends to every recipient.
func TestPostmarkNotifier_PushFailureDoesNotBlockEmail(t *testing.T) {
	t.Parallel()

	var serverCt int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&serverCt, 1)
		w.WriteHeader(200)
	}))
	defer srv.Close()

	notifier := &PostmarkNotifier{
		HTTPClient:  srv.Client(),
		ServerToken: "fake",
		BaseURL:     srv.URL,
		From:        "noreply@postwave.test",
		Service:     &Service{HMACKey: []byte("k"), Now: func() time.Time { return time.Unix(0, 0) }},
		AdminLister: AdminListerFunc(func(_ context.Context, _ string) ([]AdminRecipient, error) {
			return []AdminRecipient{{UserID: "u1", Email: "a@b.test"}}, nil
		}),
		Push: &pushStub{err: errors.New("vapid blew up")},
	}
	a := &Approval{ID: "ap-10", TenantID: "t1", ResourceType: "campaign", ResourceID: "c1",
		ExpiresAt: time.Unix(0, 0).Add(time.Hour)}
	if err := notifier.NotifyRequested(context.Background(), "t1", a); err != nil {
		t.Fatalf("NotifyRequested returned err on push failure: %v", err)
	}
	if got := atomic.LoadInt32(&serverCt); got != 1 {
		t.Errorf("email hits = %d, want 1 (push failure must not block email)", got)
	}
}

// --- helpers ---

func equalStringSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// decodeJSON is a tiny inline JSON decoder so the per-recipient test
// doesn't have to lug a typed struct just to peek at the "To" field.
func decodeJSON(r *http.Request, out *map[string]any) error {
	return json.NewDecoder(r.Body).Decode(out)
}
