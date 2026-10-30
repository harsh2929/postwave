// SPDX-License-Identifier: AGPL-3.0-only

package engagementhoneypot

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

type recordingSink struct {
	fetches []Fetch
	err     error
}

func (s *recordingSink) RecordFetch(_ context.Context, fetch Fetch) error {
	s.fetches = append(s.fetches, fetch)
	return s.err
}

func newTestServer(t *testing.T, sink FetchRecorder, now time.Time) http.Handler {
	t.Helper()
	router := chi.NewRouter()
	MountPublicHoneypotRoutes(router, &Deps{
		Minter:   testMinter(t),
		Recorder: sink,
		Now:      func() time.Time { return now },
	})
	return router
}

func getDecoy(t *testing.T, handler http.Handler, token string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, DecoyPath+"/"+token, nil)
	request.RemoteAddr = "203.0.113.10:44444"
	request.Header.Set("User-Agent", "ExampleScanner/1.0")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestValidDecoyFetchIsRecorded(t *testing.T) {
	issued := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)
	now := issued.Add(time.Hour)
	minter := testMinter(t)
	token, err := minter.Mint(testClaim(issued))
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	sink := &recordingSink{}
	response := getDecoy(t, newTestServer(t, sink, now), token)

	if response.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", response.Code)
	}
	if len(sink.fetches) != 1 {
		t.Fatalf("recorded %d fetches, want 1", len(sink.fetches))
	}
	fetch := sink.fetches[0]
	if fetch.Claim.CampaignID != testClaim(issued).CampaignID {
		t.Errorf("recorded campaign %q", fetch.Claim.CampaignID)
	}
	if fetch.UserAgent != "ExampleScanner/1.0" {
		t.Errorf("recorded user agent %q", fetch.UserAgent)
	}
	if !fetch.FetchedAt.Equal(now) {
		t.Errorf("FetchedAt = %v, want %v", fetch.FetchedAt, now)
	}
}

func TestForgedTokenIsNotRecorded(t *testing.T) {
	// The write path behind this endpoint feeds the corpus that certifies the
	// classifier. If an unsigned token were accepted, anyone could manufacture
	// machine labels for any tenant with a plain GET.
	sink := &recordingSink{}
	response := getDecoy(t, newTestServer(t, sink, time.Now()), "not-a-real-token.AAAA")
	if len(sink.fetches) != 0 {
		t.Errorf("recorded %d fetches for a forged token, want 0", len(sink.fetches))
	}
	if response.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204 — a rejection must be indistinguishable from an acceptance", response.Code)
	}
}

func TestRejectionIsIndistinguishableFromAcceptance(t *testing.T) {
	// An unauthenticated endpoint that answers differently for "bad signature"
	// and "expired" is an oracle for probing the scheme. Every outcome must
	// look the same from outside: same status, same empty body.
	issued := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)
	minter := testMinter(t)
	valid, err := minter.Mint(testClaim(issued))
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	handler := newTestServer(t, &recordingSink{}, issued.Add(time.Hour))
	expiredHandler := newTestServer(t, &recordingSink{}, issued.Add(TokenLifetime+time.Hour))

	accepted := getDecoy(t, handler, valid)
	forged := getDecoy(t, handler, "AAAA.BBBB")
	expired := getDecoy(t, expiredHandler, valid)

	for name, response := range map[string]*httptest.ResponseRecorder{
		"forged": forged, "expired": expired,
	} {
		if response.Code != accepted.Code {
			t.Errorf("%s status %d differs from accepted status %d", name, response.Code, accepted.Code)
		}
		if response.Body.Len() != accepted.Body.Len() {
			t.Errorf("%s body length %d differs from accepted %d", name, response.Body.Len(), accepted.Body.Len())
		}
	}
}

func TestAStorageFailureStillAnswersTheSameWay(t *testing.T) {
	// A scanner retrying on a 500 would hammer the endpoint, and the response
	// would leak that the token was genuine. Losing one label is the cheaper
	// failure.
	issued := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)
	minter := testMinter(t)
	token, err := minter.Mint(testClaim(issued))
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	sink := &recordingSink{err: errors.New("database is down")}
	response := getDecoy(t, newTestServer(t, sink, issued.Add(time.Hour)), token)
	if response.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204 even when the write failed", response.Code)
	}
}

func TestDecoyResponseIsNotCacheable(t *testing.T) {
	// A cached decoy response would let an intermediary absorb the second and
	// subsequent fetches, silently dropping evidence — and worse, would make
	// yield differ by network rather than by scanner behaviour.
	issued := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)
	minter := testMinter(t)
	token, err := minter.Mint(testClaim(issued))
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	response := getDecoy(t, newTestServer(t, &recordingSink{}, issued.Add(time.Hour)), token)
	if cache := response.Header().Get("Cache-Control"); cache == "" {
		t.Error("decoy response carries no Cache-Control")
	}
}

func TestDecoyResponseCarriesNoRedirect(t *testing.T) {
	// A honeypot is not a tracked link. Redirecting anywhere would give a
	// human who somehow reached the decoy a destination, and would make the
	// endpoint useful to an attacker as an open redirect.
	issued := time.Date(2026, 8, 17, 12, 0, 0, 0, time.UTC)
	minter := testMinter(t)
	token, err := minter.Mint(testClaim(issued))
	if err != nil {
		t.Fatalf("Mint: %v", err)
	}
	response := getDecoy(t, newTestServer(t, &recordingSink{}, issued.Add(time.Hour)), token)
	if location := response.Header().Get("Location"); location != "" {
		t.Errorf("decoy response redirects to %q", location)
	}
}

func TestMountedPathMatchesDecoyPath(t *testing.T) {
	// The mount uses a literal because the route-inventory scanner cannot
	// evaluate a constant expression, while decoy URLs are built from
	// DecoyPath. If those two drift, every decoy points at a path nothing
	// serves — and the failure is silent, because a decoy nobody fetches looks
	// exactly like a decoy no scanner found.
	router := chi.NewRouter()
	MountPublicHoneypotRoutes(router, &Deps{})
	var mounted []string
	if err := chi.Walk(router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		mounted = append(mounted, method+" "+route)
		return nil
	}); err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	want := "GET " + DecoyPath + "/{token}"
	for _, route := range mounted {
		if route == want {
			return
		}
	}
	t.Errorf("no mounted route matches %q; mounted routes are %v", want, mounted)
}
