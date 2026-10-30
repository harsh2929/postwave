package serviceproxy

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A JSON microservice never answers text/html. When something DOES, the thing
// that answered is not the service: a bundler, an SPA, a captive portal, or a
// load balancer error page squatting on the port.
//
// This is not hypothetical. MIGRATION_SERVICE_URL defaults to
// http://localhost:8081 -- byte-identical to Expo Metro's default port -- so in
// this monorepo, running the mobile app and the API together routes every
// migration call into the React Native bundler. It answers 200 with the Expo
// dev page, and the proxy forwarded it verbatim: a 200 whose body is HTML,
// handed to a client that will parse it as the migration payload.
//
// A 502 is the honest answer. The upstream service did not reply; something
// else did.
func upstreamAnswering(t *testing.T, status int, contentType, body string) http.Handler {
	t.Helper()
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", contentType)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(up.Close)
	return New(Options{Target: up.URL, PublicPrefix: "/api/v1/migrations", UpstreamPrefix: "/v1/migrations"})
}

func TestHTMLFromUpstreamIsNotPassedOffAsSuccess(t *testing.T) {
	h := upstreamAnswering(t, http.StatusOK, "text/html; charset=utf-8", "<!DOCTYPE html><html><body>Expo</body></html>")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/migrations", nil))

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("HTML on a JSON route must be 502, got %d body=%q", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("the error we substitute must itself be JSON, got %q", ct)
	}
	var payload struct {
		Error struct{ Code, Message string } `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}
	if payload.Error.Code != "upstream_not_a_service" {
		t.Fatalf("code must distinguish this from a dead upstream, got %q", payload.Error.Code)
	}
	// The message has to name the actual cause, because the symptom (a 200 that
	// will not parse) points nowhere near a port collision.
	if !strings.Contains(payload.Error.Message, "port") {
		t.Fatalf("message must point at the port collision, got %q", payload.Error.Message)
	}
	// The HTML must not survive into the response at all.
	if strings.Contains(rec.Body.String(), "Expo") {
		t.Fatalf("upstream HTML leaked into the reply: %q", rec.Body.String())
	}
}

func TestJSONUpstreamStillPassesThrough(t *testing.T) {
	// The guard must not become a second failure mode.
	h := upstreamAnswering(t, http.StatusOK, "application/json", `{"jobs":[]}`)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/migrations", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"jobs"`) {
		t.Fatalf("legitimate JSON must pass untouched, got %d %q", rec.Code, rec.Body.String())
	}
}

func TestNonHTMLBodiesAreNotBlocked(t *testing.T) {
	// Exports and file downloads are legitimate. Only HTML is the tell, so the
	// guard is deliberately narrow rather than a JSON-only allowlist.
	for _, ct := range []string{"text/csv", "application/octet-stream", "text/plain"} {
		h := upstreamAnswering(t, http.StatusOK, ct, "a,b,c")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/migrations/export", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s must pass through, got %d", ct, rec.Code)
		}
	}
}

func TestUpstreamErrorPagesKeepTheirStatus(t *testing.T) {
	// A 503 HTML error page is already honest about being a failure; rewriting
	// its status would lose the upstream's own signal.
	h := upstreamAnswering(t, http.StatusServiceUnavailable, "text/html", "<html>maintenance</html>")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/migrations", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("upstream failure status must survive, got %d", rec.Code)
	}
}
