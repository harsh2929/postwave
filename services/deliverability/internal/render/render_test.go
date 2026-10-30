package render

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMockRenderer_RoundTrip(t *testing.T) {
	m := MockRenderer{}
	out, err := m.Render(context.Background(), "<html><body>hi</body></html>", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != len(AllEnvironments) {
		t.Fatalf("want %d renders, got %d", len(AllEnvironments), len(out))
	}
	for i, r := range out {
		if r.ImageURL == "" {
			t.Errorf("env %s: empty image URL", r.Environment.Name)
		}
		if r.Environment.Name != AllEnvironments[i].Name {
			t.Errorf("env order mismatch at %d", i)
		}
	}
}

func TestMockRenderer_Subset(t *testing.T) {
	m := MockRenderer{}
	envs := []Environment{AllEnvironments[0], AllEnvironments[5]}
	out, err := m.Render(context.Background(), "x", envs)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 {
		t.Fatalf("want 2 renders, got %d", len(out))
	}
	if out[0].Environment.Name != envs[0].Name {
		t.Errorf("env name mismatch")
	}
}

func TestHCTIClient_HTTPTestServer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Validate auth header.
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Basic ") {
			http.Error(w, "no auth", http.StatusUnauthorized)
			return
		}
		// Validate body decodes.
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if _, ok := body["html"]; !ok {
			http.Error(w, "no html", http.StatusBadRequest)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"url": "https://example.test/render.png"})
	}))
	defer srv.Close()

	c, err := NewHCTIClient("uid", "apikey")
	if err != nil {
		t.Fatal(err)
	}
	c.Endpoint = srv.URL
	c.Timeout = 5 * time.Second

	out, err := c.Render(context.Background(), "<html></html>", []Environment{AllEnvironments[0]})
	if err != nil {
		t.Fatal(err)
	}
	if out[0].ImageURL != "https://example.test/render.png" {
		t.Fatalf("unexpected image URL: %q", out[0].ImageURL)
	}

	// Second call must hit the cache (the server panics if invoked again).
	srv.Close()
	out2, err := c.Render(context.Background(), "<html></html>", []Environment{AllEnvironments[0]})
	if err != nil {
		t.Fatal(err)
	}
	if out2[0].ImageURL != "https://example.test/render.png" {
		t.Fatalf("cache miss: got %q", out2[0].ImageURL)
	}
	if !c.CacheHit(AllEnvironments[0], "<html></html>") {
		t.Fatalf("CacheHit should report true")
	}
}

func TestHCTIClient_CapsSuccessResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("{", (1<<20)+1)))
	}))
	defer srv.Close()

	c, err := NewHCTIClient("uid", "apikey")
	if err != nil {
		t.Fatal(err)
	}
	c.Endpoint = srv.URL
	c.Timeout = 5 * time.Second

	out, err := c.Render(context.Background(), "<html></html>", []Environment{AllEnvironments[0]})
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 {
		t.Fatalf("want one render, got %d", len(out))
	}
	if !strings.Contains(strings.Join(out[0].Issues, "\n"), "response body too large") {
		t.Fatalf("issues = %#v, want response body too large", out[0].Issues)
	}
}

func TestHCTIClient_UsesExternalCache(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		_ = json.NewEncoder(w).Encode(map[string]string{"url": "https://example.test/render.png"})
	}))
	defer srv.Close()

	c, err := NewHCTIClient("uid", "apikey")
	if err != nil {
		t.Fatal(err)
	}
	cache := newMemoryRenderCacheForTest()
	c.Cache = cache
	c.Endpoint = srv.URL
	c.Timeout = 5 * time.Second

	env := AllEnvironments[0]
	if _, err := c.Render(context.Background(), "<html>cached</html>", []Environment{env}); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("first render should hit server once, got %d", calls)
	}
	// Clear the process cache so the second render proves the durable cache
	// path is used, not the in-memory fallback.
	c.cacheMu.Lock()
	c.cache = map[string]cachedRender{}
	c.cacheMu.Unlock()

	srv.Close()
	out, err := c.Render(context.Background(), "<html>cached</html>", []Environment{env})
	if err != nil {
		t.Fatal(err)
	}
	if out[0].ImageURL != "https://example.test/render.png" {
		t.Fatalf("external cache miss: got %q", out[0].ImageURL)
	}
	if cache.gets == 0 || cache.sets == 0 {
		t.Fatalf("expected external cache get/set, got gets=%d sets=%d", cache.gets, cache.sets)
	}
}

func TestNewHCTIClient_RequiresCreds(t *testing.T) {
	if _, err := NewHCTIClient("", ""); err == nil {
		t.Fatal("expected error on empty creds")
	}
}

func TestLookupEnvironment(t *testing.T) {
	if _, ok := LookupEnvironment("gmail_web_promotions"); !ok {
		t.Fatal("expected gmail_web_promotions to exist")
	}
	if _, ok := LookupEnvironment("nonsense"); ok {
		t.Fatal("expected nonsense to be missing")
	}
}

type memoryRenderCacheForTest struct {
	mu    sync.Mutex
	items map[string]Render
	gets  int
	sets  int
}

func newMemoryRenderCacheForTest() *memoryRenderCacheForTest {
	return &memoryRenderCacheForTest{items: map[string]Render{}}
}

func (m *memoryRenderCacheForTest) Get(_ context.Context, key string) (Render, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gets++
	r, ok := m.items[key]
	return r, ok, nil
}

func (m *memoryRenderCacheForTest) Set(_ context.Context, key string, r Render, _ time.Duration) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sets++
	m.items[key] = r
	return nil
}
