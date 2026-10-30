// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/idempotency"
)

func TestIngestSecretIssueReplayBypassIsExact(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		method string
		target string
		want   bool
	}{
		{name: "exact issue", method: http.MethodPost, target: ingestSecretCollectionPath, want: true},
		{name: "list", method: http.MethodGet, target: ingestSecretCollectionPath},
		{name: "trailing slash", method: http.MethodPost, target: ingestSecretCollectionPath + "/"},
		{name: "revoke", method: http.MethodPost, target: ingestSecretCollectionPath + "/key/revoke"},
		{name: "sibling", method: http.MethodPost, target: ingestSecretCollectionPath + "-archive"},
		{name: "query does not change path", method: http.MethodPost, target: ingestSecretCollectionPath + "?source=admin", want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			request := httptest.NewRequest(test.method, test.target, nil)
			if got := BypassIngestSecretIssueGlobalReplay(request, nil); got != test.want {
				t.Fatalf("bypass=%v, want %v", got, test.want)
			}
		})
	}
	if BypassIngestSecretIssueGlobalReplay(nil, nil) {
		t.Fatal("nil request unexpectedly bypassed replay")
	}
}

func TestProtectIngestSecretResponsesCoversEveryEndpointOutcome(t *testing.T) {
	t.Parallel()
	for _, target := range []string{
		ingestSecretCollectionPath,
		ingestSecretCollectionPath + "/0123456789abcdef/revoke",
	} {
		target := target
		t.Run(target, func(t *testing.T) {
			t.Parallel()
			handler := ProtectIngestSecretResponses(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("If-None-Match") != "" || r.Header.Get("If-Modified-Since") != "" {
					t.Fatal("conditional credential request reached inner handler")
				}
				// Simulate an early middleware trying to weaken the boundary. The
				// protected writer must reassert it at commit time.
				w.Header().Set("Cache-Control", "public, max-age=3600")
				w.Header().Set("ETag", `"credential"`)
				w.Header().Set("Last-Modified", "yesterday")
				w.Header().Set("Expires", "tomorrow")
				w.WriteHeader(http.StatusForbidden)
			}))
			request := httptest.NewRequest(http.MethodPost, target, nil)
			request.Header.Set("If-None-Match", `"credential"`)
			request.Header.Set("If-Modified-Since", "yesterday")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)

			if response.Code != http.StatusForbidden {
				t.Fatalf("status=%d", response.Code)
			}
			if got := response.Header().Get("Cache-Control"); got != "private, no-store" {
				t.Fatalf("Cache-Control=%q", got)
			}
			if got := response.Header().Get("Pragma"); got != "no-cache" {
				t.Fatalf("Pragma=%q", got)
			}
			for _, name := range []string{"ETag", "Last-Modified", "Expires"} {
				if got := response.Header().Get(name); got != "" {
					t.Fatalf("%s survived: %q", name, got)
				}
			}
			vary := strings.Join(response.Header().Values("Vary"), ",")
			if !strings.Contains(vary, "Authorization") || !strings.Contains(vary, "Cookie") {
				t.Fatalf("Vary=%q", vary)
			}
		})
	}
}

func TestProtectIngestSecretResponsesDoesNotMatchSibling(t *testing.T) {
	t.Parallel()
	handler := ProtectIngestSecretResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Cache-Control", "public")
		w.WriteHeader(http.StatusNoContent)
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(
		http.MethodPost,
		ingestSecretCollectionPath+"-archive",
		nil,
	))
	if got := response.Header().Get("Cache-Control"); got != "public" {
		t.Fatalf("sibling unexpectedly protected: %q", got)
	}
}

func TestProtectIngestSecretResponsesWrapsRecoveredPanics(t *testing.T) {
	t.Parallel()
	recovering := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if recover() != nil {
					w.Header().Set("Cache-Control", "public, max-age=3600")
					w.Header().Set("ETag", `"panic"`)
					w.WriteHeader(http.StatusInternalServerError)
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
	handler := ProtectIngestSecretResponses(recovering(http.HandlerFunc(
		func(http.ResponseWriter, *http.Request) { panic("credential route panic") },
	)))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(
		http.MethodPost, ingestSecretCollectionPath, http.NoBody,
	))
	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d", response.Code)
	}
	if got := response.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Fatalf("recovered panic Cache-Control=%q", got)
	}
	if got := response.Header().Get("Pragma"); got != "no-cache" {
		t.Fatalf("recovered panic Pragma=%q", got)
	}
	if got := response.Header().Get("ETag"); got != "" {
		t.Fatalf("recovered panic retained ETag=%q", got)
	}
}

func TestRootIngestSecretResponseGuardPrecedesPanicRecovery(t *testing.T) {
	t.Parallel()
	root := readAPICompositionRoot(t)
	source := root.main
	guard := strings.Index(source, "r.Use(conversions.ProtectIngestSecretResponses)")
	recoverer := strings.Index(source, "r.Use(jsonRecoverer(logger))")
	if guard < 0 || recoverer < 0 || guard >= recoverer {
		t.Fatalf("reveal-once no-store guard must wrap panic recovery: guard=%d recoverer=%d",
			guard, recoverer)
	}
	// The root chain is composed by useRootMiddleware, which run() calls, so
	// the mount is counted in run() together with the functions it calls.
	const mount = "r.Use(conversions.ProtectIngestSecretResponses)"
	reached := root.withCalledFunctions(root.run)
	if inRun, inRoot := strings.Count(reached, mount), strings.Count(root.all, mount); inRun != 1 || inRoot != 1 {
		t.Fatalf("reveal-once response guard must have one unambiguous root mount, reached from run(): "+
			"%d reached from run(), %d in the composition root", inRun, inRoot)
	}
}

type ingestSecretReplaySpy struct {
	getCalls           int
	claimCalls         int
	completeCalls      int
	deletePendingCalls int
	completedBodies    [][]byte
}

func (s *ingestSecretReplaySpy) Get(context.Context, string, string) (*idempotency.Record, error) {
	s.getCalls++
	return nil, idempotency.ErrNotFound
}

func (s *ingestSecretReplaySpy) Claim(context.Context, *idempotency.Record) (bool, error) {
	s.claimCalls++
	return true, nil
}

func (s *ingestSecretReplaySpy) Complete(_ context.Context, record *idempotency.Record) error {
	s.completeCalls++
	s.completedBodies = append(s.completedBodies, bytes.Clone(record.ResponseBody))
	return nil
}

func (s *ingestSecretReplaySpy) DeletePending(context.Context, string, string) error {
	s.deletePendingCalls++
	return nil
}

func TestIngestSecretIssueBodyNeverEntersGlobalReplayStore(t *testing.T) {
	t.Parallel()
	const plaintext = "full-reveal-once-signing-secret"
	store := &ingestSecretReplaySpy{}
	handler := idempotency.ProcessWithReplayBypass(
		store,
		func(*http.Request) (string, bool) { return "tenant-a", true },
		BypassIngestSecretIssueGlobalReplay,
	)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"secret":{"secret":"` + plaintext + `"}}`))
	}))

	request := httptest.NewRequest(
		http.MethodPost,
		ingestSecretCollectionPath,
		strings.NewReader(`{"label":"checkout"}`),
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusCreated || !strings.Contains(response.Body.String(), plaintext) {
		t.Fatalf("issue response was not delivered once: status=%d body=%q", response.Code, response.Body.String())
	}
	if store.getCalls != 0 || store.claimCalls != 0 || store.completeCalls != 0 || store.deletePendingCalls != 0 {
		t.Fatalf(
			"replay store touched for reveal-once issue: get=%d claim=%d complete=%d delete=%d",
			store.getCalls,
			store.claimCalls,
			store.completeCalls,
			store.deletePendingCalls,
		)
	}
	for _, body := range store.completedBodies {
		if bytes.Contains(body, []byte(plaintext)) {
			t.Fatal("full signing secret entered replay storage/inspection")
		}
	}
}

func TestIngestSecretIssueRejectsIdempotencyHeaderWithoutReplayOrStoreAccess(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name   string
		values []string
	}{
		{name: "nonempty", values: []string{"legacy-client-retry-key"}},
		{name: "explicitly empty", values: []string{""}},
		{name: "duplicate field lines", values: []string{"first", "second"}},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			store := &ingestSecretReplaySpy{}
			deps := &IngestSecretDeps{}
			handler := idempotency.ProcessWithReplayBypass(
				store,
				func(*http.Request) (string, bool) { return "tenant-a", true },
				BypassIngestSecretIssueGlobalReplay,
			)(http.HandlerFunc(deps.Issue))
			request := httptest.NewRequest(
				http.MethodPost,
				ingestSecretCollectionPath,
				strings.NewReader(`{"label":"checkout"}`),
			)
			request.Header[idempotency.HeaderName] = append([]string(nil), test.values...)
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)

			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%q", response.Code, response.Body.String())
			}
			if !strings.Contains(response.Body.String(), "idempotency_not_supported") {
				t.Fatalf("unexpected rejection body: %q", response.Body.String())
			}
			if store.getCalls != 0 || store.claimCalls != 0 || store.completeCalls != 0 || store.deletePendingCalls != 0 {
				t.Fatalf(
					"replay store touched for rejected issue: get=%d claim=%d complete=%d delete=%d",
					store.getCalls,
					store.claimCalls,
					store.completeCalls,
					store.deletePendingCalls,
				)
			}
		})
	}
}

func TestIngestSecretReplaySpyWouldObserveAnUnbypassedMutation(t *testing.T) {
	t.Parallel()
	store := &ingestSecretReplaySpy{}
	handler := idempotency.ProcessWithReplayBypass(
		store,
		func(*http.Request) (string, bool) { return "tenant-a", true },
		BypassIngestSecretIssueGlobalReplay,
	)(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"revoked":true}`))
	}))
	request := httptest.NewRequest(
		http.MethodPost,
		ingestSecretCollectionPath+"/key/revoke",
		strings.NewReader(`{}`),
	)
	request.Header.Set(idempotency.HeaderName, "ordinary-revoke-key")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || store.claimCalls != 1 || store.completeCalls != 1 {
		t.Fatalf("spy control did not observe ordinary replay: status=%d claim=%d complete=%d", response.Code, store.claimCalls, store.completeCalls)
	}
	if len(store.completedBodies) != 1 || !bytes.Contains(store.completedBodies[0], []byte("revoked")) {
		t.Fatal("spy control did not retain ordinary response body")
	}
}

func TestChiCannotDispatchAnUnprotectedIngestSecretIssueSpelling(t *testing.T) {
	t.Parallel()
	const plaintext = "encoded-route-reveal-once-secret"
	for _, test := range []struct {
		name        string
		target      string
		wantHandler bool
	}{
		{name: "canonical", target: ingestSecretCollectionPath, wantHandler: true},
		{name: "canonical query", target: ingestSecretCollectionPath + "?source=admin", wantHandler: true},
		{name: "encoded collection prefix", target: "/api/v1/%63onversions/ingest-secrets"},
		{name: "encoded collection segment", target: "/api/v1/conversions/%69ngest-secrets"},
		{name: "encoded hyphen", target: "/api/v1/conversions/ingest%2Dsecrets"},
		{name: "encoded slash", target: "/api/v1/conversions%2Fingest-secrets"},
		{name: "dot segment", target: "/api/v1/unused/../conversions/ingest-secrets"},
		{name: "duplicate slash", target: "/api/v1//conversions/ingest-secrets"},
		{name: "trailing slash", target: ingestSecretCollectionPath + "/"},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			store := &ingestSecretReplaySpy{}
			handlerCalls := 0
			router := chi.NewRouter()
			router.Use(ProtectIngestSecretResponses)
			router.Use(idempotency.ProcessWithReplayBypass(
				store,
				func(*http.Request) (string, bool) { return "tenant-a", true },
				BypassIngestSecretIssueGlobalReplay,
			))
			router.Post(ingestSecretCollectionPath, func(w http.ResponseWriter, _ *http.Request) {
				handlerCalls++
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusCreated)
				_, _ = w.Write([]byte(`{"secret":"` + plaintext + `"}`))
			})

			request := httptest.NewRequest(http.MethodPost, test.target,
				strings.NewReader(`{"label":"canonicalization"}`))
			request.Header.Set(idempotency.HeaderName, "route-canonicalization-key")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)

			if got := handlerCalls == 1; got != test.wantHandler {
				t.Fatalf("handler reached=%t path=%q raw_path=%q status=%d, want %t",
					got, request.URL.Path, request.URL.RawPath, response.Code, test.wantHandler)
			}
			if handlerCalls == 0 {
				if strings.Contains(response.Body.String(), plaintext) {
					t.Fatal("unmatched route returned reveal-once plaintext")
				}
				return
			}
			if response.Code != http.StatusCreated ||
				!strings.Contains(response.Body.String(), plaintext) {
				t.Fatalf("dispatched issue response status=%d body=%q",
					response.Code, response.Body.String())
			}
			if store.getCalls != 0 || store.claimCalls != 0 ||
				store.completeCalls != 0 || store.deletePendingCalls != 0 {
				t.Fatalf("chi dispatched an issue spelling without replay bypass: get=%d claim=%d complete=%d delete=%d",
					store.getCalls, store.claimCalls, store.completeCalls, store.deletePendingCalls)
			}
			if got := response.Header().Get("Cache-Control"); got != "private, no-store" {
				t.Fatalf("chi dispatched an issue spelling without no-store: %q", got)
			}
			if got := response.Header().Get("Pragma"); got != "no-cache" {
				t.Fatalf("chi dispatched an issue spelling without Pragma no-cache: %q", got)
			}
		})
	}
}
