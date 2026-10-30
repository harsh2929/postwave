// SPDX-License-Identifier: AGPL-3.0-only
//
// Tests for RequestApprovalHandler's notification-gate behaviour. The
// historical bug these tests pin down is a race condition: the previous
// implementation silenced the Notifier by mutating d.Service.Notifier
// across the request boundary and restoring it via defer. Concurrent
// Request calls on the same shared Service raced on that mutation; the
// fix is the WithSilencedNotifier() functional opt, which is per-call
// state. These tests assert the handler now passes that opt iff the
// dispatcher gate returns false, and never mutates Service.Notifier.
package approvals

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/notifications"
)

// stubDispatcher is a notifications.Dispatcher that returns a fixed
// allowed/err pair. Used to drive the handler's gate decision.
type stubDispatcher struct {
	allowed bool
	err     error
	calls   int32
}

func (s *stubDispatcher) Gate(_ context.Context, _, _ string, _ notifications.Pref) (bool, error) {
	atomic.AddInt32(&s.calls, 1)
	return s.allowed, s.err
}

type panicSlackPoster struct {
	done chan<- struct{}
}

func (p panicSlackPoster) PostApprovalRequest(context.Context, *Approval) error {
	select {
	case p.done <- struct{}{}:
	default:
	}
	panic("slack exploded")
}

// newHandlerTestService constructs a Service whose insert path is a
// no-op id-stamper (so we don't need a real pgx-backed Repo) and whose
// Notifier is the supplied recordingNotifier.
func newHandlerTestService(n Notifier) *Service {
	s := &Service{
		Notifier: n,
		Now:      func() time.Time { return time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC) },
		TTL:      time.Hour,
	}
	var seq int64
	s.insertFn = func(_ context.Context, a *Approval) error {
		i := atomic.AddInt64(&seq, 1)
		a.ID = "row-" + itoa(i)
		return nil
	}
	return s
}

// makeRequest builds a POST /api/v1/approvals request with a tenant +
// user attached to ctx the same way TenantMiddleware would.
func makeRequest(t *testing.T, in RequestApprovalInput) *http.Request {
	t.Helper()
	body, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/v1/approvals", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	ctx := r.Context()
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "tenant-1", Slug: "acme", Tier: "pro"})
	// requireAdmin fails closed when no session user + no API-key auth
	// is present, so the test must attach an owner/admin user (the
	// same gate production traffic must satisfy).
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID:       "user-test-admin",
		TenantID: "tenant-1",
		Email:    "test-admin@example.com",
		Role:     "admin",
	})
	r = r.WithContext(ctx)
	return r
}

// TestRequestApprovalHandler_GateAllowed_FiresNotifier asserts the
// happy path: dispatcher Gate returns true → no opt → notifier fires.
func TestRequestApprovalHandler_GateAllowed_FiresNotifier(t *testing.T) {
	t.Parallel()
	done := make(chan struct{}, 1)
	notifier := &chanNotifier{done: done}
	svc := newHandlerTestService(notifier)
	originalNotifier := svc.Notifier // pin the field value so we can detect any mutation

	deps := &Deps{
		Service:         svc,
		NotifDispatcher: &stubDispatcher{allowed: true},
	}

	req := makeRequest(t, RequestApprovalInput{
		ResourceType: string(ResourceCampaign),
		ResourceID:   "camp-1",
	})
	w := httptest.NewRecorder()
	deps.RequestApprovalHandler(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("status: want 201 got %d body=%s", w.Code, w.Body.String())
	}
	select {
	case <-done:
		// good — notifier fired
	case <-time.After(2 * time.Second):
		t.Fatalf("Notifier did not fire under allowed=true gate")
	}
	// Race regression guard: the field must NEVER be mutated by the
	// handler. Compare interface identity (reflect.DeepEqual handles
	// the nil-vs-non-nil cases without panicking on iface comparisons).
	if !reflect.DeepEqual(svc.Notifier, originalNotifier) {
		t.Errorf("svc.Notifier was mutated by handler (race-prone hack regression)")
	}
}

// TestRequestApprovalHandler_GateDenied_StillFiresNotifier asserts that
// the handler NO LONGER consults the dispatcher.Gate result to silence
// the notifier wholesale: per-recipient gating now lives inside the
// Notifier (see notifier.go + PostmarkNotifier.NotifyRequested), so a
// "denied" reading on the dispatcher should not skip the notifier
// dispatch — individual recipients are gated INSIDE the notifier
// loop, and a stub Notifier in this test has no gating so it fires.
//
// This pins the per-recipient refactor: the requester's pref must not
// silence the email for the OTHER admins who each have their own
// pref. The dispatcher field is kept on Deps for wiring compat but is
// inert at handler level.
func TestRequestApprovalHandler_GateDenied_StillFiresNotifier(t *testing.T) {
	t.Parallel()
	done := make(chan struct{}, 1)
	notifier := &chanNotifier{done: done}
	svc := newHandlerTestService(notifier)
	originalNotifier := svc.Notifier

	deps := &Deps{
		Service:         svc,
		NotifDispatcher: &stubDispatcher{allowed: false},
	}

	req := makeRequest(t, RequestApprovalInput{
		ResourceType: string(ResourceCampaign),
		ResourceID:   "camp-1",
	})
	w := httptest.NewRecorder()
	deps.RequestApprovalHandler(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("status: want 201 got %d body=%s", w.Code, w.Body.String())
	}
	select {
	case <-done:
		// good — handler did not silence the notifier; per-recipient
		// gating is the notifier's job now.
	case <-time.After(2 * time.Second):
		t.Fatalf("Notifier did not fire; handler must not silence the notifier on dispatcher denial — per-recipient gating moved inside the notifier")
	}
	if !reflect.DeepEqual(svc.Notifier, originalNotifier) {
		t.Errorf("svc.Notifier was mutated by handler (race-prone hack regression)")
	}
}

// TestRequestApprovalHandler_GateError_FailsOpen asserts that when the
// dispatcher returns an error, the gate fails open (notifier still
// fires), matching the documented fail-open contract in the
// notifications package.
func TestRequestApprovalHandler_GateError_FailsOpen(t *testing.T) {
	t.Parallel()
	done := make(chan struct{}, 1)
	notifier := &chanNotifier{done: done}
	svc := newHandlerTestService(notifier)

	// allowed=true with a non-nil err mirrors PgDispatcher's fail-open
	// behaviour: it returns (true, err) on lookup failure so the
	// notifier still fires while the handler logs a Warn.
	deps := &Deps{
		Service:         svc,
		NotifDispatcher: &stubDispatcher{allowed: true, err: errors.New("pg: boom")},
	}

	req := makeRequest(t, RequestApprovalInput{
		ResourceType: string(ResourceCampaign),
		ResourceID:   "camp-1",
	})
	w := httptest.NewRecorder()
	deps.RequestApprovalHandler(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("status: want 201 got %d body=%s", w.Code, w.Body.String())
	}
	select {
	case <-done:
		// good — fail-open: notifier still fires
	case <-time.After(2 * time.Second):
		t.Fatalf("Notifier did not fire under fail-open path")
	}
}

func TestRequestApprovalHandler_RecoversSlackPosterPanic(t *testing.T) {
	t.Parallel()
	done := make(chan struct{}, 1)
	svc := newHandlerTestService(nil)
	deps := &Deps{
		Service:     svc,
		SlackPoster: panicSlackPoster{done: done},
	}

	req := makeRequest(t, RequestApprovalInput{
		ResourceType: string(ResourceCampaign),
		ResourceID:   "camp-1",
	})
	w := httptest.NewRecorder()
	deps.RequestApprovalHandler(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("status: want 201 got %d body=%s", w.Code, w.Body.String())
	}
	select {
	case <-done:
		// If the goroutine panic is not recovered, this test process
		// crashes before reaching the assertion.
	case <-time.After(2 * time.Second):
		t.Fatal("SlackPoster was not invoked")
	}
}

func TestRequestApprovalHandlerRejectsOversizedBody(t *testing.T) {
	t.Parallel()
	deps := &Deps{Service: newHandlerTestService(nil)}
	body := `{"resource_type":"campaign","resource_id":"` + strings.Repeat("a", int(approvalJSONMaxBodyBytes)+1) + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/approvals", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: "tenant-1"})
	ctx = middleware.WithUser(ctx, &middleware.User{ID: "u1", TenantID: "tenant-1", Role: "admin"})
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()
	deps.RequestApprovalHandler(w, req)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413 body=%s", w.Code, w.Body.String())
	}
}

// TestRequestApprovalHandler_CapturesRequesterUserID asserts the
// handler reads middleware.UserFromContext and threads the user ID
// onto Approval.RequestedByUserID. This is what gives Service.Decide
// the requester identity it needs to enforce the two-person rule
// (audit HIGH F5). Without this, every approval row would have
// NULL requested_by_user_id and the self-approval check would
// silently no-op.
func TestRequestApprovalHandler_CapturesRequesterUserID(t *testing.T) {
	t.Parallel()
	svc := newHandlerTestService(nil)
	var captured *Approval
	svc.insertFn = func(_ context.Context, a *Approval) error {
		a.ID = "row-uid-1"
		captured = a
		return nil
	}
	deps := &Deps{Service: svc}
	req := makeRequest(t, RequestApprovalInput{
		ResourceType: string(ResourceCampaign),
		ResourceID:   "camp-uid-1",
	})
	w := httptest.NewRecorder()
	deps.RequestApprovalHandler(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if captured == nil {
		t.Fatal("insertFn never called")
	}
	if captured.RequestedByUserID == nil {
		t.Fatalf("RequestedByUserID is nil; user ID was not captured from context")
	}
	if *captured.RequestedByUserID != "user-test-admin" {
		t.Errorf("RequestedByUserID = %q, want %q", *captured.RequestedByUserID, "user-test-admin")
	}
	// makeRequest sets actor type/label to empty in the body; handler
	// must default Type to "user" and Label to the session email.
	if captured.RequestedByActorType != "user" {
		t.Errorf("RequestedByActorType = %q, want \"user\"", captured.RequestedByActorType)
	}
	if captured.RequestedByActorLabel != "test-admin@example.com" {
		t.Errorf("RequestedByActorLabel = %q, want \"test-admin@example.com\"", captured.RequestedByActorLabel)
	}
}

// TestRequestApprovalHandler_PreservesExplicitActorFields asserts the
// handler does NOT overwrite caller-supplied actor_type / actor_label.
// API-key clients (Slack bots, agents) set these explicitly and the
// session-user defaults should only fill the blanks.
func TestRequestApprovalHandler_PreservesExplicitActorFields(t *testing.T) {
	t.Parallel()
	svc := newHandlerTestService(nil)
	var captured *Approval
	svc.insertFn = func(_ context.Context, a *Approval) error {
		a.ID = "row-explicit-1"
		captured = a
		return nil
	}
	deps := &Deps{Service: svc}
	req := makeRequest(t, RequestApprovalInput{
		ResourceType: string(ResourceCampaign),
		ResourceID:   "camp-explicit-1",
		ActorType:    "slack",
		ActorLabel:   "#sends",
	})
	w := httptest.NewRecorder()
	deps.RequestApprovalHandler(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if captured == nil {
		t.Fatal("insertFn never called")
	}
	if captured.RequestedByActorType != "slack" {
		t.Errorf("ActorType overwritten: got %q, want \"slack\"", captured.RequestedByActorType)
	}
	if captured.RequestedByActorLabel != "#sends" {
		t.Errorf("ActorLabel overwritten: got %q, want \"#sends\"", captured.RequestedByActorLabel)
	}
}

// TestErrorEnvelope_NewCodes pins the JSON wire format that
// d.decide / d.decideReturningApproval / d.publicDecide emit for the
// new ErrSelfApproval and ErrTokenAlreadyUsed branches. The
// dashboard's toast-mapping table keys off these exact strings — a
// silent rename here would degrade UX to "decide failed" without any
// test catching it.
func TestErrorEnvelope_NewCodes(t *testing.T) {
	cases := []struct {
		name     string
		status   int
		code     string
		message  string
		wantHTTP int
	}{
		{"self approval", http.StatusForbidden, "self_approval",
			"the user who requested an approval cannot decide it", 403},
		{"token already used", http.StatusConflict, "token_already_used",
			"this approval link has already been used", 409},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			writeErr(w, tc.status, tc.code, tc.message)
			if w.Code != tc.wantHTTP {
				t.Errorf("status = %d, want %d", w.Code, tc.wantHTTP)
			}
			var env struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
				t.Fatalf("body not JSON: %v body=%s", err, w.Body.String())
			}
			if env.Error.Code != tc.code {
				t.Errorf("code = %q, want %q", env.Error.Code, tc.code)
			}
			if env.Error.Message != tc.message {
				t.Errorf("message = %q, want %q", env.Error.Message, tc.message)
			}
		})
	}
}

func TestPublicDecisionRejectsUnprovenRecipientBeforeEffect(t *testing.T) {
	t.Parallel()
	now := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	const id = "11111111-1111-4111-8111-111111111111"
	service := &Service{HMACKey: []byte("public-approval-test-key"), Now: fakeNow(now)}
	boundToken := service.SignToken(id, DecisionApprove, now.Add(time.Hour), "alice@example.com")
	unboundToken := service.SignToken(id, DecisionApprove, now.Add(time.Hour), "")
	legacyToken := signLegacyApprovalToken(service.HMACKey, id, DecisionApprove, now.Add(time.Hour))

	matchingIdentity := func(_ *http.Request) (*middleware.Tenant, *middleware.User, error) {
		return &middleware.Tenant{ID: "tenant-1"}, &middleware.User{
			ID: "alice-id", TenantID: "tenant-1", SessionID: "session-1",
			Email: "alice@example.com", Role: "admin",
		}, nil
	}

	tests := []struct {
		name       string
		token      string
		resolver   func(*http.Request) (*middleware.Tenant, *middleware.User, error)
		requestCtx func(context.Context) context.Context
		wantStatus int
		wantCode   string
	}{
		{
			name: "anonymous possession is not identity", token: boundToken,
			resolver: func(*http.Request) (*middleware.Tenant, *middleware.User, error) {
				return nil, nil, nil
			},
			wantStatus: http.StatusUnauthorized, wantCode: "authentication_required",
		},
		{
			name: "forwarded link cannot be used by another session", token: boundToken,
			resolver: func(*http.Request) (*middleware.Tenant, *middleware.User, error) {
				return &middleware.Tenant{ID: "tenant-1"}, &middleware.User{
					ID: "bob-id", TenantID: "tenant-1", SessionID: "session-2",
					Email: "bob@example.com", Role: "admin",
				}, nil
			},
			wantStatus: http.StatusForbidden, wantCode: "approver_mismatch",
		},
		{
			name: "user context without concrete session is not authenticated", token: boundToken,
			resolver: func(*http.Request) (*middleware.Tenant, *middleware.User, error) {
				return &middleware.Tenant{ID: "tenant-1"}, &middleware.User{
					ID: "alice-id", TenantID: "tenant-1", Email: "alice@example.com", Role: "admin",
				}, nil
			},
			wantStatus: http.StatusUnauthorized, wantCode: "authentication_required",
		},
		{
			name: "demoted recipient cannot decide", token: boundToken,
			resolver: func(*http.Request) (*middleware.Tenant, *middleware.User, error) {
				return &middleware.Tenant{ID: "tenant-1"}, &middleware.User{
					ID: "alice-id", TenantID: "tenant-1", SessionID: "session-1",
					Email: "alice@example.com", Role: "viewer",
				}, nil
			},
			wantStatus: http.StatusForbidden, wantCode: "forbidden",
		},
		{
			name: "view-as viewer cannot use durable admin authority", token: boundToken,
			resolver: func(*http.Request) (*middleware.Tenant, *middleware.User, error) {
				return &middleware.Tenant{ID: "tenant-1"}, &middleware.User{
					ID: "alice-id", TenantID: "tenant-1", SessionID: "session-1",
					Email: "alice@example.com", Role: "admin", EffectiveRole: "viewer",
				}, nil
			},
			wantStatus: http.StatusForbidden, wantCode: "forbidden",
		},
		{
			name: "anonymous-recipient token cannot authorize", token: unboundToken,
			resolver: func(*http.Request) (*middleware.Tenant, *middleware.User, error) {
				panic("unbound token must be rejected before session resolution")
			},
			wantStatus: http.StatusUnauthorized, wantCode: "approver_identity_unbound",
		},
		{
			name: "legacy token cannot authorize", token: legacyToken,
			resolver: func(*http.Request) (*middleware.Tenant, *middleware.User, error) {
				panic("legacy token must be rejected before session resolution")
			},
			wantStatus: http.StatusUnauthorized, wantCode: "approver_identity_unbound",
		},
		{
			name: "api key cannot impersonate recipient session", token: boundToken,
			resolver: func(*http.Request) (*middleware.Tenant, *middleware.User, error) {
				panic("API-key request must not invoke browser session resolver")
			},
			requestCtx: func(ctx context.Context) context.Context {
				ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: "tenant-1"})
				ctx = middleware.WithUser(ctx, &middleware.User{
					ID: "alice-id", TenantID: "tenant-1", SessionID: "session-1",
					Email: "alice@example.com", Role: "admin",
				})
				return middleware.WithAPIKeyAuth(ctx)
			},
			wantStatus: http.StatusUnauthorized, wantCode: "authentication_required",
		},
		{
			name: "session lookup uncertainty fails closed", token: boundToken,
			resolver: func(*http.Request) (*middleware.Tenant, *middleware.User, error) {
				return nil, nil, errors.New("session store unavailable")
			},
			wantStatus: http.StatusInternalServerError, wantCode: "internal_error",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var effectCalls atomic.Int32
			deps := &Deps{Service: service, PublicSessionResolver: tc.resolver}
			deps.publicDecisionFn = func(context.Context, string, string, string, string, Decision) (*Approval, error) {
				effectCalls.Add(1)
				return &Approval{ID: id, TenantID: "tenant-1", Status: StatusApproved}, nil
			}
			req := publicApprovalRequest(t, id, tc.token, DecisionApprove)
			if tc.requestCtx != nil {
				req = req.WithContext(tc.requestCtx(req.Context()))
			}
			rec := httptest.NewRecorder()
			router := chi.NewRouter()
			deps.MountPublic(router)
			router.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d body=%s", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if code := decode(t, rec)["code"]; code != tc.wantCode {
				t.Fatalf("code = %v, want %q body=%s", code, tc.wantCode, rec.Body.String())
			}
			if got := effectCalls.Load(); got != 0 {
				t.Fatalf("effect boundary called %d time(s), want zero", got)
			}
		})
	}

	// Positive control: the exact, current recipient session reaches the
	// mutation boundary once and carries the authenticated tenant/user ids.
	var effectCalls atomic.Int32
	deps := &Deps{Service: service, PublicSessionResolver: matchingIdentity}
	deps.publicDecisionFn = func(_ context.Context, gotID, rawToken, tenantID, userID string, decision Decision) (*Approval, error) {
		effectCalls.Add(1)
		if gotID != id || rawToken != boundToken || tenantID != "tenant-1" || userID != "alice-id" || decision != DecisionApprove {
			t.Fatalf("effect args = (%q, %q, %q, %q, %q)", gotID, rawToken, tenantID, userID, decision)
		}
		return &Approval{ID: id, TenantID: tenantID, Status: StatusApproved}, nil
	}
	rec := httptest.NewRecorder()
	router := chi.NewRouter()
	deps.MountPublic(router)
	router.ServeHTTP(rec, publicApprovalRequest(t, id, boundToken, DecisionApprove))
	if rec.Code != http.StatusOK {
		t.Fatalf("matching session status = %d, want 200 body=%s", rec.Code, rec.Body.String())
	}
	if got := effectCalls.Load(); got != 1 {
		t.Fatalf("matching session effect calls = %d, want one", got)
	}
}

func TestPublicDecisionGETRemainsReadOnlyAndPublic(t *testing.T) {
	t.Parallel()
	now := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	const id = "22222222-2222-4222-8222-222222222222"
	service := &Service{HMACKey: []byte("public-approval-test-key"), Now: fakeNow(now)}
	token := service.SignToken(id, DecisionReject, now.Add(time.Hour), "alice@example.com")
	deps := &Deps{
		Service: service,
		PublicSessionResolver: func(*http.Request) (*middleware.Tenant, *middleware.User, error) {
			panic("read-only GET must not resolve a session")
		},
		publicDecisionFn: func(context.Context, string, string, string, string, Decision) (*Approval, error) {
			panic("read-only GET must not reach effect boundary")
		},
	}
	req := publicApprovalRequest(t, id, token, DecisionReject)
	req.Method = http.MethodGet
	// RawQuery is HTTP input. A suffix must not break out of the form action
	// attribute even when the signed token itself remains valid.
	req.URL.RawQuery += `&return="><script>alert(1)</script>`
	rec := httptest.NewRecorder()
	router := chi.NewRouter()
	deps.MountPublic(router)
	router.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Confirm: reject this approval?") {
		t.Fatalf("GET response = %d %q", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "<script>") || !strings.Contains(rec.Body.String(), "&#34;&gt;&lt;script&gt;") {
		t.Fatalf("GET reflected unescaped query input: %q", rec.Body.String())
	}
	if got := rec.Header().Get("Content-Security-Policy"); !strings.Contains(got, "form-action 'self'") || !strings.Contains(got, "frame-ancestors 'none'") {
		t.Fatalf("Content-Security-Policy = %q", got)
	}
	if got := rec.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want no-referrer", got)
	}
}

func publicApprovalRequest(t *testing.T, id, token string, decision Decision) *http.Request {
	t.Helper()
	query := url.Values{"token": {token}, "decision": {string(decision)}}
	return httptest.NewRequest(
		http.MethodPost,
		"/api/public/approvals/"+id+"/decide?"+query.Encode(),
		nil,
	)
}

func signLegacyApprovalToken(key []byte, id string, decision Decision, expiresAt time.Time) string {
	exp := strconv.FormatInt(expiresAt.Unix(), 10)
	payload := id + "." + string(decision) + "." + exp
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
