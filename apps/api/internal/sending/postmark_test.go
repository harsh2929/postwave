package sending

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestPostmark(handler http.Handler) (*PostmarkClient, *httptest.Server) {
	srv := httptest.NewServer(handler)
	return NewPostmarkClient(PostmarkConfig{BaseURL: srv.URL, AccountToken: "tok"}), srv
}

func TestCreateServer(t *testing.T) {
	pc, srv := newTestPostmark(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Postmark-Account-Token") != "tok" {
			t.Fatalf("missing account token header")
		}
		if r.URL.Path != "/servers" || r.Method != http.MethodPost {
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body CreateServerReq
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Name != "tenant-acme" {
			t.Fatalf("bad body: %+v", body)
		}
		_ = json.NewEncoder(w).Encode(Server{
			ID: 42, Name: body.Name, APITokens: []string{"server-token-xyz"},
		})
	}))
	defer srv.Close()

	got, err := pc.CreateServer(context.Background(), "tenant-acme", "blue")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != 42 || len(got.APITokens) != 1 {
		t.Fatalf("bad response: %+v", got)
	}
}

func TestCreateMessageStream(t *testing.T) {
	pc, srv := newTestPostmark(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/servers/42/message-streams" {
			t.Fatalf("path %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(MessageStream{ID: "broadcasts", ServerID: 42, Name: "broadcasts"})
	}))
	defer srv.Close()

	got, err := pc.CreateMessageStream(context.Background(), 42, "broadcasts")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "broadcasts" {
		t.Fatalf("bad stream id %q", got.ID)
	}
}

func TestRotateToken(t *testing.T) {
	pc, srv := newTestPostmark(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ApiTokens": []string{"new-token"},
		})
	}))
	defer srv.Close()

	tok, err := pc.RotateToken(context.Background(), 42)
	if err != nil {
		t.Fatal(err)
	}
	if tok != "new-token" {
		t.Fatalf("got %q", tok)
	}
}

func TestRentDedicatedIP(t *testing.T) {
	pc, srv := newTestPostmark(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(DedicatedIP{IP: "1.2.3.4", ServerID: 42, Status: "Provisioning"})
	}))
	defer srv.Close()

	ip, err := pc.RentDedicatedIP(context.Background(), 42, "us-east-1")
	if err != nil {
		t.Fatal(err)
	}
	if ip.IP != "1.2.3.4" {
		t.Fatalf("bad ip %+v", ip)
	}
}

func TestHTTPError(t *testing.T) {
	pc, srv := newTestPostmark(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusUnprocessableEntity)
	}))
	defer srv.Close()

	_, err := pc.CreateServer(context.Background(), "x", "")
	if err == nil {
		t.Fatal("expected err")
	}
	if _, ok := err.(*HTTPError); !ok {
		t.Fatalf("want *HTTPError, got %T", err)
	}
}

func TestHTTPErrorBodyIsCapped(t *testing.T) {
	pc, srv := newTestPostmark(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(strings.Repeat("x", int(postmarkMaxResponseBodyBytes)+1024)))
	}))
	defer srv.Close()

	_, err := pc.CreateServer(context.Background(), "x", "")
	if err == nil {
		t.Fatal("expected err")
	}
	httpErr, ok := err.(*HTTPError)
	if !ok {
		t.Fatalf("want *HTTPError, got %T", err)
	}
	if got := len(httpErr.Body); got != int(postmarkMaxResponseBodyBytes) {
		t.Fatalf("error body length = %d, want %d", got, postmarkMaxResponseBodyBytes)
	}
}

func TestPostmarkURLPreservesBasePathAndRejectsUnsafeBase(t *testing.T) {
	got, err := postmarkURL("https://api.postmark.test/proxy/", "/servers")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://api.postmark.test/proxy/servers" {
		t.Fatalf("postmarkURL = %q", got)
	}

	for _, base := range []string{
		"https://user:pass@api.postmark.test",
		"https://api.postmark.test?tenant=one",
		"https://api.postmark.test#fragment",
		"file:///tmp/postmark",
	} {
		if _, err := postmarkURL(base, "/servers"); err == nil {
			t.Fatalf("expected unsafe base %q to fail", base)
		}
	}
	if _, err := postmarkURL("https://api.postmark.test", "/../servers"); err == nil {
		t.Fatal("expected path traversal to fail")
	}
	for _, path := range []string{"/%2e%2e/servers", "/servers\\42"} {
		if _, err := postmarkURL("https://api.postmark.test", path); err == nil {
			t.Fatalf("expected unsafe path %q to fail", path)
		}
	}
}

func TestPostmarkClientPreservesBasePath(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_ = json.NewEncoder(w).Encode(Server{ID: 42, Name: "tenant-acme", APITokens: []string{"server-token-xyz"}})
	}))
	defer srv.Close()

	pc := NewPostmarkClient(PostmarkConfig{BaseURL: srv.URL + "/postmark/", AccountToken: "tok"})
	if _, err := pc.CreateServer(context.Background(), "tenant-acme", "blue"); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/postmark/servers" {
		t.Fatalf("path = %q", gotPath)
	}
}
