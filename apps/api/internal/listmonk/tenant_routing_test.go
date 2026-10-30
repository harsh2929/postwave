package listmonk

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/postwave/postwave/packages/runtime/tenantengine"
)

func TestTenantRoutingIsolatesIdenticalEmailsIDsAndSends(t *testing.T) {
	configs := map[string]Config{}
	counts := map[string]*atomic.Int64{}
	for _, tenant := range []string{"a", "b"} {
		count := new(atomic.Int64)
		counts[tenant] = count
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			count.Add(1)
			user, password, ok := r.BasicAuth()
			if !ok || user != tenant || password != "password-"+tenant {
				t.Error("wrong destination credentials")
			}
			w.Header().Set("Content-Type", "application/json")
			switch r.URL.Path {
			case "/api/subscribers":
				var body CreateSubscriberReq
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Email != "same@example.test" {
					t.Error("wrong subscriber")
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": 1, "email": body.Email, "name": tenant}})
			case "/api/lists/1":
				_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": 1, "name": tenant}})
			case "/api/tx":
				var body SendTransactionalReq
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.SubscriberEmail != "same@example.test" {
					t.Error("wrong send")
				}
				_, _ = w.Write([]byte(`{"data":true}`))
			default:
				t.Errorf("unexpected request %s", r.URL.Path)
				w.WriteHeader(404)
			}
		}))
		t.Cleanup(server.Close)
		configs[tenant] = Config{BaseURL: server.URL, Username: tenant, Password: "password-" + tenant}
	}
	client := New(Config{BaseURL: "http://must-never-fallback.invalid", ResolveDestination: func(ctx context.Context, tenant string) (Config, error) {
		config, ok := configs[tenant]
		if !ok {
			return Config{}, tenantengine.ErrUnavailable
		}
		return config, nil
	}})
	for _, tenant := range []string{"a", "b"} {
		ctx := tenantengine.WithTenant(context.Background(), tenant)
		sub, err := client.CreateSubscriber(ctx, CreateSubscriberReq{Email: "same@example.test", Status: SubscriberEnabled})
		if err != nil || sub.ID != 1 || sub.Name != tenant {
			t.Fatalf("subscriber crossed tenant: %v", err)
		}
		list, err := client.GetList(ctx, 1)
		if err != nil || list.Name != tenant {
			t.Fatalf("list crossed tenant: %v", err)
		}
		if err := client.SendTransactional(ctx, SendTransactionalReq{SubscriberEmail: "same@example.test"}); err != nil {
			t.Fatal(err)
		}
		bound, err := client.ForTenant(context.Background(), tenant)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := bound.GetList(context.Background(), 1); err != nil {
			t.Fatal(err)
		}
		if _, err := bound.GetList(tenantengine.WithTenant(context.Background(), "other"), 1); !errors.Is(err, tenantengine.ErrUnavailable) {
			t.Fatal("bound worker accepted another tenant")
		}
	}
	for _, ctx := range []context.Context{context.Background(), tenantengine.WithTenant(context.Background(), "missing")} {
		if _, err := client.GetList(ctx, 1); !errors.Is(err, tenantengine.ErrUnavailable) {
			t.Fatalf("unknown tenant fallback: %v", err)
		}
	}
	for tenant, count := range counts {
		if count.Load() != 4 {
			t.Errorf("tenant %s received %d requests", tenant, count.Load())
		}
	}
}

func TestDestinationCredentialRedirectIsRejected(t *testing.T) {
	var calls atomic.Int64
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer other.Close()
	from := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL, http.StatusTemporaryRedirect)
	}))
	defer from.Close()
	client := New(Config{BaseURL: from.URL, Username: "api", Password: "secret"})
	if _, err := client.GetList(context.Background(), 1); err == nil {
		t.Fatal("redirect accepted")
	}
	if calls.Load() != 0 {
		t.Fatal("credentials followed redirect")
	}
}
