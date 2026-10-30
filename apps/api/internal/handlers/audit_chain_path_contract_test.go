// SPDX-License-Identifier: AGPL-3.0-only

package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/go-chi/chi/v5"
)

// The URL a client builds, checked by the server that has to read it.
//
// audit_chain_db_test.go already proves the handler decodes an id that Go's own
// url.PathEscape produced. That is the server agreeing with itself. It says
// nothing about the URL a TypeScript client actually puts on the wire, and the
// clients cannot ask Go anything at test time — so each one was left asserting
// its own construction, which passes on precisely the bug that matters: a
// mis-encoded id returns an EMPTY CHAIN, not an error, and the operator is told
// the request touched nothing.
//
// testdata/audit_chain_client_paths.json closes that loop. The clients assert
// they emit those paths; this test serves those same paths through a real chi
// router and checks the production decode recovers the id. Neither side can
// drift without one of the two failing.
//
// No database: the decode is all that is under test here, and requiring
// DATABASE_URL would make the contract skippable in exactly the environments
// (client CI) that most need it.

type chainPathCase struct {
	Name      string `json:"name"`
	RequestID string `json:"requestId"`
	Path      string `json:"path"`
}

type chainPathContract struct {
	Route                 string          `json:"route"`
	Cases                 []chainPathCase `json:"cases"`
	UnencodedMustNotRoute chainPathCase   `json:"unencodedMustNotRoute"`
}

func loadChainPathContract(t *testing.T) chainPathContract {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "audit_chain_client_paths.json"))
	if err != nil {
		t.Fatalf("read client path contract: %v", err)
	}
	var contract chainPathContract
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatalf("client path contract is not valid JSON: %v", err)
	}
	if contract.Route == "" {
		t.Fatal("client path contract has no route")
	}
	if len(contract.Cases) == 0 {
		t.Fatal("client path contract has no cases — it would pass vacuously")
	}
	return contract
}

// chainDecodeRouter mounts the real route pattern and reports what the
// production decode saw. Everything about the request path — Go's URL parsing,
// whether chi consults RawPath, the PathUnescape — runs for real.
func chainDecodeRouter(seen *string, matched *bool) *chi.Mux {
	router := chi.NewRouter()
	router.Get(chainRouteForTest, func(w http.ResponseWriter, r *http.Request) {
		*matched = true
		*seen = chainRequestID(r)
	})
	return router
}

// Kept as a constant rather than read from the fixture: chi panics on a pattern
// it cannot compile, and a fixture typo should fail as a comparison, not as a
// panic inside the router.
const chainRouteForTest = "/api/v1/audit/chain/{requestId}"

func TestClientEncodedPathsDecodeToTheStoredRequestID(t *testing.T) {
	contract := loadChainPathContract(t)
	if contract.Route != chainRouteForTest {
		t.Fatalf("contract route = %q, but the mounted route is %q — the fixture "+
			"describes a route this server does not serve",
			contract.Route, chainRouteForTest)
	}

	for _, tc := range contract.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			var seen string
			var matched bool
			router := chainDecodeRouter(&seen, &matched)

			req := httptest.NewRequest(http.MethodGet, tc.Path, nil)
			rec := httptest.NewRecorder()
			router.ServeHTTP(rec, req)

			if !matched {
				t.Fatalf("client path %q did not reach the chain route at all "+
					"(status %d) — a client sending it gets a 404, not a chain",
					tc.Path, rec.Code)
			}
			if seen != tc.RequestID {
				t.Fatalf("decoded request id = %q, want %q.\n"+
					"The SQL compares this against the stored correlation_id, so a "+
					"mismatch returns an EMPTY chain — the operator is told this "+
					"request touched nothing.", seen, tc.RequestID)
			}
		})
	}
}

func TestAnUnencodedSlashNeverReachesTheChainRoute(t *testing.T) {
	// Why the clients must encode at all. With the slash left raw the id becomes
	// two path segments and the one-segment route does not match — so "just send
	// the id" is not a working alternative to percent-encoding it.
	contract := loadChainPathContract(t)
	raw := contract.UnencodedMustNotRoute
	if raw.Path == "" {
		t.Fatal("contract is missing the unencoded counter-example")
	}

	var seen string
	var matched bool
	router := chainDecodeRouter(&seen, &matched)

	req := httptest.NewRequest(http.MethodGet, raw.Path, nil)
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if matched {
		t.Fatalf("the unencoded path %q reached the handler with requestId=%q; "+
			"the fixture claims encoding is mandatory and it is not",
			raw.Path, seen)
	}
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d for an unencoded id, want 404", rec.Code)
	}
}
