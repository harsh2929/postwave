package listmonk

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestClient(handler http.Handler) (*Client, *httptest.Server) {
	srv := httptest.NewServer(handler)
	c := New(Config{BaseURL: srv.URL, User: "u", Password: "p"})
	return c, srv
}

func TestSendTransactional(t *testing.T) {
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/tx" || r.Method != http.MethodPost {
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
		var body TransactionalReq
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if body.SubscriberEmail != "a@b.com" || body.TemplateID != 7 {
			t.Fatalf("bad body: %+v", body)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if err := c.SendTransactional(context.Background(), TransactionalReq{
		SubscriberEmail: "a@b.com", TemplateID: 7,
	}); err != nil {
		t.Fatalf("send: %v", err)
	}
}

func TestClientURLBuilderPreservesBasePathAndQuery(t *testing.T) {
	calls := make([]string, 0, 2)
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.String())
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"data": map[string]interface{}{
					"results": []map[string]interface{}{
						{"id": 1, "email": "x@y.com", "tags": []string{}},
					},
				},
			})
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	c.baseURL = srv.URL + "/listmonk///"

	if err := c.AddTagToSubscriber(context.Background(), "x@y.com", "vip"); err != nil {
		t.Fatal(err)
	}
	if len(calls) < 2 {
		t.Fatalf("calls = %v, want get + put", calls)
	}
	if !strings.HasPrefix(calls[0], "/listmonk/api/subscribers?") {
		t.Fatalf("first call = %q, want base path + subscriber query", calls[0])
	}
	if calls[1] != "/listmonk/api/subscribers/1" {
		t.Fatalf("second call = %q, want base path preserved", calls[1])
	}
}

func TestClientRejectsUnsafeBaseURL(t *testing.T) {
	c := New(Config{BaseURL: "https://user:pass@example.test", User: "u", Password: "p"})
	err := c.SendTransactional(context.Background(), TransactionalReq{TemplateID: 1})
	if err == nil || !strings.Contains(err.Error(), "unsafe base URL") {
		t.Fatalf("err = %v, want unsafe base URL", err)
	}
}

func TestClientRejectsEncodedTraversalAndBackslashes(t *testing.T) {
	for _, path := range []string{
		"/api/%2e%2e/tx",
		"/api/%2E/tx",
		"/api\\tx",
	} {
		_, err := listmonkURL("https://listmonk.example.test", path)
		if err == nil || !strings.Contains(err.Error(), "unsafe request path") {
			t.Fatalf("path %q err = %v, want unsafe request path", path, err)
		}
	}
}

func TestSendTransactional_Error(t *testing.T) {
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer srv.Close()

	err := c.SendTransactional(context.Background(), TransactionalReq{TemplateID: 1})
	if err == nil {
		t.Fatal("expected error")
	}
	if _, ok := err.(*HTTPError); !ok {
		t.Fatalf("want *HTTPError, got %T", err)
	}
}

func TestHTTPErrorBodyIsCapped(t *testing.T) {
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte(strings.Repeat("x", int(listmonkMaxResponseBodyBytes)+1024)))
	}))
	defer srv.Close()

	err := c.SendTransactional(context.Background(), TransactionalReq{TemplateID: 1})
	if err == nil {
		t.Fatal("expected error")
	}
	httpErr, ok := err.(*HTTPError)
	if !ok {
		t.Fatalf("want *HTTPError, got %T", err)
	}
	if got := len(httpErr.Body); got != int(listmonkMaxResponseBodyBytes) {
		t.Fatalf("error body length = %d, want %d", got, listmonkMaxResponseBodyBytes)
	}
}

func TestAddTagToSubscriber_Idempotent(t *testing.T) {
	patches := 0
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/api/subscribers"):
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"data": map[string]interface{}{
					"results": []map[string]interface{}{
						{"id": 1, "email": "x@y.com", "tags": []string{"vip"}},
					},
				},
			})
		case r.Method == http.MethodPatch:
			patches++
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	// already tagged → no write
	if err := c.AddTagToSubscriber(context.Background(), "x@y.com", "vip"); err != nil {
		t.Fatal(err)
	}
	if patches != 0 {
		t.Fatalf("idempotent add should not write, got %d", patches)
	}

	// new tag → one PATCH
	if err := c.AddTagToSubscriber(context.Background(), "x@y.com", "welcomed"); err != nil {
		t.Fatal(err)
	}
	if patches != 1 {
		t.Fatalf("want 1 PATCH, got %d", patches)
	}
}

// v6Subscriber is a Listmonk v6.1.0 subscriber row for the property test.
type v6Subscriber struct {
	attribs map[string]interface{}
	lists   []int
}

// Listmonk v6.1.0 answers PUT /api/subscribers/:id without an email with 400
// "Invalid email.", and a PUT with one replaces every subscription with the
// body's lists and resets attribs. PATCH starts from the stored row. The
// update_profile_property node therefore failed on every run, and would have
// removed the subscriber from its lists had it succeeded.
func TestUpdateSubscriberPropertyPatchesAndKeepsListsAndOtherAttribs(t *testing.T) {
	stored := &v6Subscriber{attribs: map[string]interface{}{"city": "Oslo"}, lists: []int{3, 4}}
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/subscribers":
			// The recorded v6.1.0 lookup shape: lists are objects.
			_, _ = w.Write([]byte(`{"data":{"results":[{"id":7,"email":"x@y.com","name":"X","attribs":{"city":"Oslo"},"status":"enabled","lists":[{"subscription_status":"confirmed","id":3,"name":"A"},{"subscription_status":"unconfirmed","id":4,"name":"B"}]}],"total":1,"per_page":1,"page":1}}`))
		case r.URL.Path == "/api/subscribers/7":
			var body map[string]interface{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			if r.Method == http.MethodPut {
				if email, _ := body["email"].(string); email == "" {
					w.WriteHeader(http.StatusBadRequest)
					_, _ = w.Write([]byte(`{"message":"Invalid email."}`))
					return
				}
				stored.lists = nil
				stored.attribs = map[string]interface{}{}
			}
			if attribs, ok := body["attribs"].(map[string]interface{}); ok {
				for k, v := range attribs {
					stored.attribs[k] = v
				}
			}
			if _, hasLists := body["lists"]; hasLists {
				t.Fatalf("a property update carried lists: %v", body)
			}
			_, _ = w.Write([]byte(`{"data":true}`))
		default:
			t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()

	if err := c.UpdateSubscriberProperty(context.Background(), "x@y.com", "plan", "pro"); err != nil {
		t.Fatalf("UpdateSubscriberProperty: %v", err)
	}
	if stored.attribs["plan"] != "pro" || stored.attribs["city"] != "Oslo" {
		t.Fatalf("attribs = %v, want plan set and city kept", stored.attribs)
	}
	if len(stored.lists) != 2 {
		t.Fatalf("lists = %v, want both subscriptions kept", stored.lists)
	}
}

func TestRemoveTagFromSubscriber(t *testing.T) {
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"data": map[string]interface{}{
					"results": []map[string]interface{}{
						{"id": 2, "email": "x@y.com", "tags": []string{"a", "b"}},
					},
				},
			})
			return
		}
		var body map[string]interface{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		tags, _ := body["tags"].([]interface{})
		if len(tags) != 1 || tags[0] != "a" {
			t.Fatalf("expected [a], got %+v", tags)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if err := c.RemoveTagFromSubscriber(context.Background(), "x@y.com", "b"); err != nil {
		t.Fatal(err)
	}
}

func TestUnsubscribeFromAll(t *testing.T) {
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"data": map[string]interface{}{
					"results": []map[string]interface{}{
						{"id": 4, "email": "x@y.com"},
					},
				},
			})
			return
		}
		if r.Method == http.MethodPut && r.URL.Path == "/api/subscribers/4/blocklist" {
			w.WriteHeader(http.StatusOK)
			return
		}
		t.Fatalf("unexpected %s %s", r.Method, r.URL.Path)
	}))
	defer srv.Close()

	if err := c.UnsubscribeFromAll(context.Background(), "x@y.com"); err != nil {
		t.Fatal(err)
	}
}

func TestGetSubscriber_NotFound(t *testing.T) {
	c, srv := newTestClient(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"data": map[string]interface{}{
				"results": []map[string]interface{}{},
			},
		})
	}))
	defer srv.Close()

	_, err := c.GetSubscriberByEmail(context.Background(), "no@one.com")
	if err != ErrSubscriberNotFound {
		t.Fatalf("want ErrSubscriberNotFound, got %v", err)
	}
}
