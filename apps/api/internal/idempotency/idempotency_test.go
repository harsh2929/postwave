// SPDX-License-Identifier: AGPL-3.0-only
package idempotency

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type memStore struct {
	mu          sync.Mutex
	data        map[string]*Record
	completeErr error
	cleanupErr  error
}

type panicStore struct{}

func (panicStore) Get(context.Context, string, string) (*Record, error) {
	panic("held request consulted idempotency store")
}
func (panicStore) Claim(context.Context, *Record) (bool, error) {
	panic("held request claimed idempotency key")
}
func (panicStore) Complete(context.Context, *Record) error {
	panic("held request completed idempotency key")
}
func (panicStore) DeletePending(context.Context, string, string) error {
	panic("held request deleted idempotency key")
}

type failOnRead struct{ reads int }

func (r *failOnRead) Read([]byte) (int, error) {
	r.reads++
	return 0, errors.New("body must remain unread")
}

func newMemStore() *memStore { return &memStore{data: map[string]*Record{}} }

func (m *memStore) Get(_ context.Context, tenantID, key string) (*Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if r, ok := m.data[tenantID+"|"+key]; ok {
		return r, nil
	}
	return nil, ErrNotFound
}

func (m *memStore) Claim(_ context.Context, rec *Record) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, exists := m.data[rec.TenantID+"|"+rec.Key]; exists {
		return false, nil
	}
	m.data[rec.TenantID+"|"+rec.Key] = rec
	return true, nil
}

func (m *memStore) Complete(_ context.Context, rec *Record) error {
	if m.completeErr != nil {
		return m.completeErr
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if cur, exists := m.data[rec.TenantID+"|"+rec.Key]; exists {
		cur.ResponseStatus = rec.ResponseStatus
		cur.ResponseBody = append([]byte(nil), rec.ResponseBody...)
		cur.ResponseHeaders = cloneHeader(rec.ResponseHeaders)
	}
	return nil
}

func (m *memStore) DeletePending(_ context.Context, tenantID, key string) error {
	if m.cleanupErr != nil {
		return m.cleanupErr
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	k := tenantID + "|" + key
	if rec, exists := m.data[k]; exists && rec.ResponseStatus == 0 {
		delete(m.data, k)
	}
	return nil
}

func TestCompleteFailureDoesNotReturnSuccessfulHandlerBody(t *testing.T) {
	store := newMemStore()
	store.completeErr = errors.New("db down")
	mw := Process(store, resolveFixed("t1"))
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Handler", "should-not-leak")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"created":true}`))
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{"name":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HeaderName, "abc")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("code = %d, want 500; body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "created") {
		t.Fatalf("successful handler body leaked after complete failure: %s", rec.Body.String())
	}
	if rec.Header().Get("X-Handler") != "" {
		t.Fatalf("handler headers leaked after complete failure")
	}
	if len(store.data) != 1 {
		t.Fatalf("pending claim must remain after uncertain completion; rows=%d", len(store.data))
	}

	// A retry cannot execute the handler again while the response-ledger write
	// is uncertain. Operators can reconcile and delete the pending key through
	// the inspector rather than risking a duplicate side effect.
	retry := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{"name":"x"}`))
	retry.Header.Set("Content-Type", "application/json")
	retry.Header.Set(HeaderName, "abc")
	retryRec := httptest.NewRecorder()
	h.ServeHTTP(retryRec, retry)
	if retryRec.Code != http.StatusConflict || !strings.Contains(retryRec.Body.String(), "idempotency_key_in_progress") {
		t.Fatalf("retry status=%d body=%s, want retained-pending 409", retryRec.Code, retryRec.Body.String())
	}
}

func resolveFixed(tenantID string) TenantResolver {
	return func(_ *http.Request) (string, bool) { return tenantID, tenantID != "" }
}

func assertReplayResponseHeaders(t *testing.T, headers http.Header) {
	t.Helper()
	if got := headers.Get(ReplayedHeaderName); got != "true" {
		t.Errorf("%s = %q, want true", ReplayedHeaderName, got)
	}
	if got := headers.Get(LegacyReplayedHeaderName); got != "true" {
		t.Errorf("%s = %q, want compatibility value true",
			LegacyReplayedHeaderName, got)
	}
	if got := headers.Get(InternalReplayHeaderName); got != "1" {
		t.Errorf("%s = %q, want compatibility value 1",
			InternalReplayHeaderName, got)
	}
}

func TestSameKeySameBodyReplays(t *testing.T) {
	store := newMemStore()
	calls := 0
	mw := Process(store, resolveFixed("t1"))
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))

	mk := func() *http.Request {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/forms",
			strings.NewReader(`{"name":"x"}`))
		req.Header.Set("Content-Type", "application/json")
		return req
	}

	r1 := mk()
	r1.Header.Set(HeaderName, "abc")
	w1 := httptest.NewRecorder()
	h.ServeHTTP(w1, r1)
	if w1.Code != http.StatusCreated || calls != 1 {
		t.Fatalf("first: code=%d calls=%d", w1.Code, calls)
	}

	r2 := mk()
	r2.Header.Set(HeaderName, "abc")
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, r2)
	if w2.Code != http.StatusCreated {
		t.Fatalf("replay code=%d", w2.Code)
	}
	if calls != 1 {
		t.Fatalf("handler ran %d times, want 1", calls)
	}
	assertReplayResponseHeaders(t, w2.Header())
	if w1.Body.String() != w2.Body.String() {
		t.Errorf("replay body mismatch: %q vs %q", w1.Body.String(), w2.Body.String())
	}
}

func TestRevalidateResponseExecutesSameKeyUntilAuthoritativeReceipt(t *testing.T) {
	store := newMemStore()
	calls := 0
	h := Process(store, resolveFixed("t1"))(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		if calls == 1 {
			w.Header().Set(RevalidateResponseHeaderName, "1")
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"disposition":"reconciliation_required"}`))
			return
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"disposition":"persisted"}`))
	}))

	request := func() *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/sms/conversations/%2B15551234567/reply", strings.NewReader(`{"body":"hello"}`))
		r.Header.Set(HeaderName, "same-reply")
		return r
	}
	first := httptest.NewRecorder()
	h.ServeHTTP(first, request())
	if first.Code != http.StatusAccepted || first.Header().Get(RevalidateResponseHeaderName) != "" || len(store.data) != 0 {
		t.Fatalf("first status=%d header=%q records=%d", first.Code, first.Header().Get(RevalidateResponseHeaderName), len(store.data))
	}
	resolved := httptest.NewRecorder()
	h.ServeHTTP(resolved, request())
	if resolved.Code != http.StatusCreated || calls != 2 || len(store.data) != 1 {
		t.Fatalf("resolved status=%d calls=%d records=%d", resolved.Code, calls, len(store.data))
	}
	replay := httptest.NewRecorder()
	h.ServeHTTP(replay, request())
	if replay.Code != http.StatusCreated || calls != 2 || replay.Header().Get(ReplayedHeaderName) != "true" {
		t.Fatalf("replay status=%d calls=%d replay=%q", replay.Code, calls, replay.Header().Get(ReplayedHeaderName))
	}
}

func TestHandlerOwnedReplayNeverTouchesGenericLedger(t *testing.T) {
	store := newMemStore()
	store.cleanupErr = errors.New("generic ledger unavailable")
	calls := 0
	h := ProcessWithHandlerOwnedReplay(
		store,
		resolveFixed("t1"),
		func(r *http.Request, _ []byte) bool { return strings.HasSuffix(r.URL.Path, "/reply") },
		func(_ *http.Request) (string, bool) { return "tenant-admin:user-1", true },
	)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		key, ok := StorageKeyFromContext(r.Context())
		if !ok || !strings.HasPrefix(key, "scope-v1:") {
			t.Fatalf("handler storage key=%q ok=%t", key, ok)
		}
		requestHash, ok := RequestHashFromContext(r.Context())
		if !ok || len(requestHash) != 64 {
			t.Fatalf("handler request hash=%q ok=%t", requestHash, ok)
		}
		w.WriteHeader(http.StatusCreated)
	}))

	for range 2 {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/sms/conversations/%2B15551234567/reply", strings.NewReader(`{"body":"hello"}`))
		r.Header.Set(HeaderName, "same-reply")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusCreated {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	}
	if calls != 2 || len(store.data) != 0 {
		t.Fatalf("calls=%d generic records=%d", calls, len(store.data))
	}
}

func TestHandlerOwnedReplayBodyLimitRunsBeforeLedgerAndHandler(t *testing.T) {
	store := newMemStore()
	calls := 0
	h := ProcessWithHandlerOwnedReplayAndBodyLimit(
		store,
		resolveFixed("t1"),
		func(r *http.Request, _ []byte) bool { return strings.HasSuffix(r.URL.Path, "/reply") },
		func(r *http.Request) int64 {
			if strings.HasSuffix(r.URL.Path, "/reply") {
				return 64 << 10
			}
			return 0
		},
	)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusCreated)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/sms/conversations/%2B14155551212/reply", strings.NewReader(strings.Repeat("x", (64<<10)+1)))
	req.Header.Set(HeaderName, "oversized-sms-reply")
	recorder := httptest.NewRecorder()
	h.ServeHTTP(recorder, req)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	if calls != 0 || len(store.data) != 0 {
		t.Fatalf("oversized reply touched side effects: handler_calls=%d ledger_rows=%d", calls, len(store.data))
	}
}

func TestReplayBypassCannotServeAPreviouslyCachedSuccess(t *testing.T) {
	store := newMemStore()
	body := []byte(`{"to":"closed","reason":"old request"}`)
	requestHash := hashRequest(http.MethodPost, "/api/v1/privacy/incidents/incident-id/transition", body)
	store.data["t1|legacy-key"] = &Record{
		Key:            "legacy-key",
		TenantID:       "t1",
		RequestHash:    requestHash,
		ResponseStatus: http.StatusOK,
		ResponseBody:   []byte(`{"to":"closed"}`),
	}
	calls := 0
	handler := ProcessWithReplayBypass(
		store,
		resolveFixed("t1"),
		func(_ *http.Request, gotBody []byte) bool { return string(gotBody) == string(body) },
	)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(`{"error":{"code":"release_hold"}}`))
	}))

	request := httptest.NewRequest(http.MethodPost, "/api/v1/privacy/incidents/incident-id/transition", strings.NewReader(string(body)))
	request.Header.Set(HeaderName, "legacy-key")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusServiceUnavailable || calls != 1 {
		t.Fatalf("status=%d calls=%d body=%s, want current 503 handler", recorder.Code, calls, recorder.Body.String())
	}
	if recorder.Header().Get(ReplayedHeaderName) != "" {
		t.Fatalf("containment response was marked as replayed: %v", recorder.Header())
	}
	if got := store.data["t1|legacy-key"].ResponseStatus; got != http.StatusOK {
		t.Fatalf("bypass mutated the historical receipt: status=%d", got)
	}
}

func TestPathOnlyReplayBypassRunsBeforeBodyTenantAndStore(t *testing.T) {
	for _, path := range []string{
		"/api/v1/service-suite/tickets",
		"/api/v1/support-integrations/integration-id/sync",
	} {
		t.Run(path, func(t *testing.T) {
			body := &failOnRead{}
			resolverCalls := 0
			handler := ProcessWithReplayBypassAndHandlerOwnedReplayAndBodyLimit(
				panicStore{},
				func(*http.Request) (string, bool) {
					resolverCalls++
					return "tenant-id", true
				},
				func(r *http.Request, body []byte) bool {
					return body == nil && (strings.HasPrefix(r.URL.Path, "/api/v1/service-suite/") ||
						strings.HasPrefix(r.URL.Path, "/api/v1/support-integrations/"))
				},
				nil,
				func(*http.Request) int64 { return 16 },
			)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(`{"error":{"code":"release_held"}}`))
			}))
			req := httptest.NewRequest(http.MethodPost, path, body)
			req.Header.Set(HeaderName, "held-request")
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, req)
			if recorder.Code != http.StatusServiceUnavailable || !strings.Contains(recorder.Body.String(), "release_held") {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if body.reads != 0 || resolverCalls != 0 {
				t.Fatalf("held request body_reads=%d tenant_resolver_calls=%d, want 0/0", body.reads, resolverCalls)
			}
		})
	}
}

func TestReadOnlyPathBypassPrecedesMalformedOrDuplicateIdempotencyKey(t *testing.T) {
	tests := []struct {
		name string
		keys []string
	}{
		{name: "valid", keys: []string{"auto-key"}},
		{name: "surrounding whitespace", keys: []string{" auto-key "}},
		{name: "duplicate", keys: []string{"auto-key-a", "auto-key-b"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body := &failOnRead{}
			resolverCalls := 0
			handlerCalls := 0
			handler := ProcessWithReplayBypassAndHandlerOwnedReplayAndBodyLimit(
				panicStore{},
				func(*http.Request) (string, bool) {
					resolverCalls++
					return "tenant-id", true
				},
				func(r *http.Request, body []byte) bool {
					return body == nil && r.Method == http.MethodPost &&
						r.URL.EscapedPath() == "/api/v1/sms/suppressions/query"
				},
				nil,
				nil,
			)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				handlerCalls++
				w.WriteHeader(http.StatusNoContent)
			}))
			req := httptest.NewRequest(http.MethodPost, "/api/v1/sms/suppressions/query", body)
			for _, key := range test.keys {
				req.Header.Add(HeaderName, key)
			}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, req)
			if recorder.Code != http.StatusNoContent || handlerCalls != 1 {
				t.Fatalf("status=%d handler_calls=%d body=%s", recorder.Code, handlerCalls, recorder.Body.String())
			}
			if body.reads != 0 || resolverCalls != 0 {
				t.Fatalf("body_reads=%d tenant_resolver_calls=%d, want 0/0", body.reads, resolverCalls)
			}
		})
	}
}

func TestSurroundingWhitespaceIsRejectedWithoutPoisoningExactKey(t *testing.T) {
	store := newMemStore()
	calls := 0
	h := Process(store, resolveFixed("t1"))(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))

	request := func(key string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/verification/verify", strings.NewReader(`{"email":"a@example.com"}`))
		r.Header.Set(HeaderName, key)
		return r
	}
	invalid := httptest.NewRecorder()
	h.ServeHTTP(invalid, request("  same-attempt  "))
	if invalid.Code != http.StatusBadRequest || !strings.Contains(invalid.Body.String(), "invalid_idempotency_key") {
		t.Fatalf("invalid status=%d body=%s", invalid.Code, invalid.Body.String())
	}
	if calls != 0 || len(store.data) != 0 {
		t.Fatalf("whitespace key reached handler/claim: calls=%d records=%d", calls, len(store.data))
	}

	exact := httptest.NewRecorder()
	h.ServeHTTP(exact, request("same-attempt"))
	if exact.Code != http.StatusOK || calls != 1 || len(store.data) != 1 {
		t.Fatalf("exact key did not proceed: status=%d calls=%d records=%d", exact.Code, calls, len(store.data))
	}
}

func TestDuplicateKeyHeadersAreRejectedBeforeClaim(t *testing.T) {
	store := newMemStore()
	calls := 0
	h := Process(store, resolveFixed("t1"))(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusCreated)
	}))

	duplicate := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/privacy/incidents",
		strings.NewReader(`{"summary":"draft"}`),
	)
	duplicate.Header.Add(HeaderName, "one")
	duplicate.Header.Add(HeaderName, "two")
	duplicateRecorder := httptest.NewRecorder()
	h.ServeHTTP(duplicateRecorder, duplicate)

	if duplicateRecorder.Code != http.StatusBadRequest ||
		!strings.Contains(duplicateRecorder.Body.String(), "invalid_idempotency_key") {
		t.Fatalf(
			"duplicate status=%d body=%s, want uncached invalid-key 400",
			duplicateRecorder.Code,
			duplicateRecorder.Body.String(),
		)
	}
	if calls != 0 || len(store.data) != 0 {
		t.Fatalf("duplicate reached handler/claim: calls=%d records=%d", calls, len(store.data))
	}

	valid := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/privacy/incidents",
		strings.NewReader(`{"summary":"draft"}`),
	)
	valid.Header.Set(HeaderName, "one")
	validRecorder := httptest.NewRecorder()
	h.ServeHTTP(validRecorder, valid)
	if validRecorder.Code != http.StatusCreated || calls != 1 || len(store.data) != 1 {
		t.Fatalf(
			"single-key retry status=%d calls=%d records=%d, want fresh execution",
			validRecorder.Code,
			calls,
			len(store.data),
		)
	}
}

func TestReplayScopeIsolatesSameTenantActors(t *testing.T) {
	store := newMemStore()
	calls := map[string]int{}
	mw := Process(
		store,
		resolveFixed("t1"),
		func(r *http.Request) (string, bool) {
			scope := r.Header.Get("X-Test-Actor")
			return scope, scope != ""
		},
	)
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		actor := r.Header.Get("X-Test-Actor")
		calls[actor]++
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(actor))
	}))
	request := func(actor string) *http.Request {
		r := httptest.NewRequest(
			http.MethodPost,
			"/api/v1/campaign-template-designs",
			strings.NewReader(`{"mode":"generate","brief":"Digest"}`),
		)
		r.Header.Set(HeaderName, "same-visible-key")
		r.Header.Set("X-Test-Actor", actor)
		return r
	}

	firstA := httptest.NewRecorder()
	h.ServeHTTP(firstA, request("actor-a"))
	replayA := httptest.NewRecorder()
	h.ServeHTTP(replayA, request("actor-a"))
	firstB := httptest.NewRecorder()
	h.ServeHTTP(firstB, request("actor-b"))

	if calls["actor-a"] != 1 || calls["actor-b"] != 1 {
		t.Fatalf("actor calls=%v, want one execution per actor", calls)
	}
	if replayA.Header().Get(ReplayedHeaderName) != "true" {
		t.Fatal("same-actor retry did not replay")
	}
	if firstB.Header().Get(ReplayedHeaderName) != "" ||
		firstB.Body.String() != "actor-b" {
		t.Fatalf(
			"other actor received replay: headers=%v body=%q",
			firstB.Header(),
			firstB.Body.String(),
		)
	}
	if len(store.data) != 2 {
		t.Fatalf("stored replay identities=%d, want two", len(store.data))
	}
	for storedKey := range store.data {
		if strings.Contains(storedKey, "same-visible-key") ||
			strings.Contains(storedKey, "actor-a") ||
			strings.Contains(storedKey, "actor-b") {
			t.Fatalf("scoped replay key persisted plaintext identity: %q", storedKey)
		}
	}
}

func TestSameKeyDifferentBodyConflicts(t *testing.T) {
	store := newMemStore()
	mw := Process(store, resolveFixed("t1"))
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
	}))

	r1 := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{"a":1}`))
	r1.Header.Set("Content-Type", "application/json")
	r1.Header.Set(HeaderName, "k")
	h.ServeHTTP(httptest.NewRecorder(), r1)

	r2 := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{"a":2}`))
	r2.Header.Set("Content-Type", "application/json")
	r2.Header.Set(HeaderName, "k")
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, r2)
	if w2.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code=%d, want 422", w2.Code)
	}
	if !strings.Contains(w2.Body.String(), "idempotency_key_request_mismatch") {
		t.Errorf("body=%s", w2.Body.String())
	}
}

func TestNoKeyNoCaching(t *testing.T) {
	store := newMemStore()
	calls := 0
	mw := Process(store, resolveFixed("t1"))
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusOK)
	}))
	for i := 0; i < 3; i++ {
		r := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers", strings.NewReader(`{}`))
		r.Header.Set("Content-Type", "application/json")
		h.ServeHTTP(httptest.NewRecorder(), r)
	}
	if calls != 3 {
		t.Fatalf("calls=%d, want 3 (no caching without header)", calls)
	}
	if len(store.data) != 0 {
		t.Fatalf("store should be empty, has %d", len(store.data))
	}
}

func TestErrorResponsesAreCached(t *testing.T) {
	store := newMemStore()
	calls := 0
	mw := Process(store, resolveFixed("t1"))
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"bad"}`))
	}))
	r := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set(HeaderName, "k")
	w1 := httptest.NewRecorder()
	h.ServeHTTP(w1, r)
	if len(store.data) != 1 {
		t.Fatalf("4xx response should be cached")
	}

	r2 := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{}`))
	r2.Header.Set("Content-Type", "application/json")
	r2.Header.Set(HeaderName, "k")
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, r2)
	if w2.Code != http.StatusBadRequest {
		t.Fatalf("replay status = %d, want 400", w2.Code)
	}
	if calls != 1 {
		t.Fatalf("handler calls = %d, want 1", calls)
	}
	assertReplayResponseHeaders(t, w2.Header())
}

func TestSameKeyDifferentQueryConflicts(t *testing.T) {
	store := newMemStore()
	mw := Process(store, resolveFixed("t1"))
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
	}))

	r1 := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers?source=a", strings.NewReader(`{"email":"a@example.com"}`))
	r1.Header.Set("Content-Type", "application/json")
	r1.Header.Set(HeaderName, "k")
	h.ServeHTTP(httptest.NewRecorder(), r1)

	r2 := httptest.NewRequest(http.MethodPost, "/api/v1/subscribers?source=b", strings.NewReader(`{"email":"a@example.com"}`))
	r2.Header.Set("Content-Type", "application/json")
	r2.Header.Set(HeaderName, "k")
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, r2)
	if w2.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code=%d, want 422", w2.Code)
	}
}

func TestPendingClaimRetainedWhenHandlerPanics(t *testing.T) {
	store := newMemStore()
	mw := Process(store, resolveFixed("t1"))
	h := mw(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HeaderName, "panic-key")
	func() {
		defer func() {
			if recover() == nil {
				t.Fatalf("expected panic to propagate")
			}
		}()
		h.ServeHTTP(httptest.NewRecorder(), req)
	}()

	if len(store.data) != 1 {
		t.Fatalf("pending claim must remain after uncertain panic; rows=%d", len(store.data))
	}

	retry := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{}`))
	retry.Header.Set("Content-Type", "application/json")
	retry.Header.Set(HeaderName, "panic-key")
	retryRec := httptest.NewRecorder()
	h.ServeHTTP(retryRec, retry)
	if retryRec.Code != http.StatusConflict || !strings.Contains(retryRec.Body.String(), "idempotency_key_in_progress") {
		t.Fatalf("retry status=%d body=%s, want retained-pending 409", retryRec.Code, retryRec.Body.String())
	}
}

func TestRejectsOversizedKey(t *testing.T) {
	store := newMemStore()
	mw := Process(store, resolveFixed("t1"))
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(HeaderName, strings.Repeat("x", MaxKeyLength+1))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("code=%d, want 400", w.Code)
	}
	if len(store.data) != 0 {
		t.Fatalf("oversized key should not create a claim")
	}
}

func TestRejectsInvalidUTF8AndControlKeysBeforeHandlerOrLedger(t *testing.T) {
	for name, key := range map[string]string{
		"nul":           "attempt\x00one",
		"ascii control": "attempt\x1fone",
		"c1 control":    "attempt\u0085one",
		"invalid utf8":  "attempt" + string([]byte{0xff}) + "one",
	} {
		t.Run(name, func(t *testing.T) {
			store := newMemStore()
			calls := 0
			h := Process(store, resolveFixed("t1"))(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				calls++
				w.WriteHeader(http.StatusCreated)
			}))
			req := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{}`))
			// Assign directly: net/http's wire writer correctly refuses several
			// controls, but middleware must still fail closed for in-process calls.
			req.Header[HeaderName] = []string{key}
			recorder := httptest.NewRecorder()
			h.ServeHTTP(recorder, req)
			if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "invalid_idempotency_key") {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if calls != 0 || len(store.data) != 0 {
				t.Fatalf("invalid key reached handler/ledger: calls=%d records=%d", calls, len(store.data))
			}
		})
	}
}

func TestRejectsOversizedReplayBody(t *testing.T) {
	store := newMemStore()
	mw := Process(store, resolveFixed("t1"))
	calls := 0
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusCreated)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(strings.Repeat("x", int(MaxReplayBodyBytes)+1)))
	req.Header.Set(HeaderName, "body-too-large")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("code=%d, want 413", w.Code)
	}
	if calls != 0 {
		t.Fatalf("handler should not run for oversized replay body")
	}
	if len(store.data) != 0 {
		t.Fatalf("oversized body should not create a claim")
	}
}

func TestServerErrorsAreNotCachedAndAllowRetry(t *testing.T) {
	store := newMemStore()
	calls := 0
	mw := Process(store, resolveFixed("t1"))
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"transient"}`))
	}))

	// First request: handler 500s.
	r1 := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{}`))
	r1.Header.Set("Content-Type", "application/json")
	r1.Header.Set(HeaderName, "k")
	w1 := httptest.NewRecorder()
	h.ServeHTTP(w1, r1)
	if w1.Code != http.StatusInternalServerError {
		t.Fatalf("first response status = %d, want 500", w1.Code)
	}
	if len(store.data) != 0 {
		t.Fatalf("5xx must NOT be cached; store has %d rows", len(store.data))
	}

	// Retry must re-execute (NOT replay a 500 from cache).
	r2 := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{}`))
	r2.Header.Set("Content-Type", "application/json")
	r2.Header.Set(HeaderName, "k")
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, r2)
	if calls != 2 {
		t.Fatalf("handler calls = %d, want 2 (5xx must allow retry)", calls)
	}
	if w2.Header().Get(ReplayedHeaderName) == "true" ||
		w2.Header().Get(LegacyReplayedHeaderName) == "true" {
		t.Fatalf("retry of cached 5xx should not be flagged as replay")
	}
}

func TestReplayRestoresResponseHeaders(t *testing.T) {
	store := newMemStore()
	mw := Process(store, resolveFixed("t1"))
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/vnd.api+json")
		w.Header().Set("Location", "/api/v1/forms/abc")
		w.Header().Add("X-Postwave-Cost-Cents", "42")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"abc"}`))
	}))

	r1 := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{"name":"x"}`))
	r1.Header.Set("Content-Type", "application/json")
	r1.Header.Set(HeaderName, "hdr-key")
	w1 := httptest.NewRecorder()
	h.ServeHTTP(w1, r1)
	if w1.Header().Get("Content-Type") != "application/vnd.api+json" {
		t.Fatalf("first response missing Content-Type, got %q", w1.Header().Get("Content-Type"))
	}

	r2 := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{"name":"x"}`))
	r2.Header.Set("Content-Type", "application/json")
	r2.Header.Set(HeaderName, "hdr-key")
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, r2)
	if got, want := w2.Header().Get("Content-Type"), "application/vnd.api+json"; got != want {
		t.Errorf("replay Content-Type = %q, want %q", got, want)
	}
	if got, want := w2.Header().Get("Location"), "/api/v1/forms/abc"; got != want {
		t.Errorf("replay Location = %q, want %q", got, want)
	}
	if got, want := w2.Header().Get("X-Postwave-Cost-Cents"), "42"; got != want {
		t.Errorf("replay custom header = %q, want %q", got, want)
	}
	assertReplayResponseHeaders(t, w2.Header())
}

func TestInProgressReturnsRetryAfter(t *testing.T) {
	store := newMemStore()
	mw := Process(store, resolveFixed("t1"))
	block := make(chan struct{})
	started := make(chan struct{}, 1)
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		started <- struct{}{}
		<-block
		w.WriteHeader(http.StatusCreated)
	}))

	r1 := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{"x":1}`))
	r1.Header.Set("Content-Type", "application/json")
	r1.Header.Set(HeaderName, "ra-key")
	go h.ServeHTTP(httptest.NewRecorder(), r1)
	<-started

	r2 := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{"x":1}`))
	r2.Header.Set("Content-Type", "application/json")
	r2.Header.Set(HeaderName, "ra-key")
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, r2)

	close(block)

	if w2.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", w2.Code)
	}
	if w2.Header().Get("Retry-After") == "" {
		t.Errorf("missing Retry-After on 409 in-progress response")
	}
}

func TestConcurrentSameKeyOnlyRunsOneHandler(t *testing.T) {
	store := newMemStore()
	mw := Process(store, resolveFixed("t1"))
	block := make(chan struct{})
	started := make(chan struct{}, 1)
	calls := 0
	h := mw(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		started <- struct{}{}
		<-block
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))

	r1 := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{"name":"x"}`))
	r1.Header.Set("Content-Type", "application/json")
	r1.Header.Set(HeaderName, "abc")
	w1 := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		h.ServeHTTP(w1, r1)
		close(done)
	}()
	<-started

	r2 := httptest.NewRequest(http.MethodPost, "/api/v1/forms", strings.NewReader(`{"name":"x"}`))
	r2.Header.Set("Content-Type", "application/json")
	r2.Header.Set(HeaderName, "abc")
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, r2)

	close(block)
	<-done

	if calls != 1 {
		t.Fatalf("handler calls = %d, want 1", calls)
	}
	if w2.Code != http.StatusConflict {
		t.Fatalf("second status = %d, want 409", w2.Code)
	}
}

func TestCanonicalStoredRouteOmitsSMSPhoneAndQuery(t *testing.T) {
	phone := "%2B14155551212"
	got := canonicalStoredRoute(http.MethodPost, "/api/v1/sms/conversations/"+phone+"/reply")
	if got != "POST /api/v1/sms/conversations/{phone}/reply" {
		t.Fatalf("canonical route=%q", got)
	}
	for _, secret := range []string{phone, "+14155551212", "cursor", "message text"} {
		if strings.Contains(got, secret) {
			t.Fatalf("stored route contains %q: %q", secret, got)
		}
	}
}
