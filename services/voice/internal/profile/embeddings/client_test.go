package embeddings

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// TestEmbed_Single asserts the client posts the right body, sets the
// x-goog-api-key header, hits the embedContent URL, and parses the
// returned vector.
func TestEmbed_Single(t *testing.T) {
	var gotURL, gotKey, gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotURL = r.URL.String()
		gotKey = r.Header.Get("x-goog-api-key")
		b, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		gotBody = string(b)
		_, _ = w.Write([]byte(`{"embedding":{"values":[0.1,0.2,0.3]}}`))
	}))
	defer srv.Close()

	c := NewClient("test-key")
	c.BaseURL = srv.URL
	c.Retries = 0

	v, err := c.Embed(context.Background(), "hello world", TaskTypeSemanticSimilarity)
	if err != nil {
		t.Fatalf("Embed: %v", err)
	}
	if len(v) != 3 {
		t.Fatalf("len(v)=%d, want 3", len(v))
	}
	if v[0] != 0.1 || v[1] != 0.2 || v[2] != 0.3 {
		t.Errorf("got %v, want [0.1 0.2 0.3]", v)
	}
	if !strings.Contains(gotURL, "/v1beta/models/text-embedding-004:embedContent") {
		t.Errorf("URL = %q, want embedContent endpoint", gotURL)
	}
	if gotKey != "test-key" {
		t.Errorf("x-goog-api-key = %q, want test-key", gotKey)
	}
	// Body must include the text, the task type, and the dimensionality.
	if !strings.Contains(gotBody, `"text":"hello world"`) {
		t.Errorf("body missing text: %s", gotBody)
	}
	if !strings.Contains(gotBody, `"taskType":"SEMANTIC_SIMILARITY"`) {
		t.Errorf("body missing taskType: %s", gotBody)
	}
	if !strings.Contains(gotBody, `"outputDimensionality":768`) {
		t.Errorf("body missing outputDimensionality: %s", gotBody)
	}
}

func TestEndpointPreservesBasePathAndRejectsUnsafeBase(t *testing.T) {
	c := NewClient("test-key")
	c.BaseURL = "https://gemini.example.test/proxy/"
	got, err := c.endpoint("embedContent")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://gemini.example.test/proxy/v1beta/models/text-embedding-004:embedContent" {
		t.Fatalf("endpoint = %q", got)
	}

	for _, base := range []string{
		"https://user:pass@gemini.example.test",
		"https://gemini.example.test?token=x",
		"https://gemini.example.test#frag",
		"file:///tmp/gemini",
	} {
		c.BaseURL = base
		if _, err := c.endpoint("embedContent"); err == nil {
			t.Fatalf("expected unsafe base %q to fail", base)
		}
	}
	if _, err := c.endpoint("unknown"); err == nil {
		t.Fatal("expected unsupported action to fail")
	}
}

// TestEmbed_Batch asserts EmbedBatch sends one request for ≤100 inputs,
// hits the batchEmbedContents URL, and returns vectors in order.
func TestEmbed_Batch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "batchEmbedContents") {
			http.Error(w, "wrong endpoint", http.StatusBadRequest)
			return
		}
		var body struct {
			Requests []struct {
				Content  map[string]any `json:"content"`
				TaskType string         `json:"taskType"`
			} `json:"requests"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		// Echo back N vectors of length 3, each component = request index
		// so the test can confirm order.
		var sb strings.Builder
		sb.WriteString(`{"embeddings":[`)
		for i := range body.Requests {
			if i > 0 {
				sb.WriteString(",")
			}
			sb.WriteString(`{"values":[`)
			sb.WriteString(itoa(i))
			sb.WriteString(`,0,0]}`)
		}
		sb.WriteString(`]}`)
		_, _ = w.Write([]byte(sb.String()))
	}))
	defer srv.Close()

	c := NewClient("test-key")
	c.BaseURL = srv.URL
	c.Retries = 0

	// 100 inputs (the API's documented maximum).
	inputs := make([]string, 100)
	for i := range inputs {
		inputs[i] = "passage-" + itoa(i)
	}
	got, err := c.EmbedBatch(context.Background(), inputs, TaskTypeClustering)
	if err != nil {
		t.Fatalf("EmbedBatch: %v", err)
	}
	if len(got) != 100 {
		t.Fatalf("got %d vectors, want 100", len(got))
	}
	for i := 0; i < 100; i++ {
		if got[i][0] != float64(i) {
			t.Errorf("vector %d component 0 = %v, want %d (order broke)", i, got[i][0], i)
		}
	}
}

// TestEmbed_BatchOver100ChunksTransparently asserts >100 inputs are
// chunked into multiple requests.
func TestEmbed_BatchOver100ChunksTransparently(t *testing.T) {
	var reqs int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&reqs, 1)
		var body struct {
			Requests []json.RawMessage `json:"requests"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		var sb strings.Builder
		sb.WriteString(`{"embeddings":[`)
		for i := range body.Requests {
			if i > 0 {
				sb.WriteString(",")
			}
			sb.WriteString(`{"values":[1,0,0]}`)
		}
		sb.WriteString(`]}`)
		_, _ = w.Write([]byte(sb.String()))
	}))
	defer srv.Close()

	c := NewClient("k")
	c.BaseURL = srv.URL
	c.Retries = 0
	inputs := make([]string, 250)
	for i := range inputs {
		inputs[i] = "x"
	}
	got, err := c.EmbedBatch(context.Background(), inputs, "")
	if err != nil {
		t.Fatalf("EmbedBatch: %v", err)
	}
	if len(got) != 250 {
		t.Errorf("len(got)=%d, want 250", len(got))
	}
	if n := atomic.LoadInt32(&reqs); n != 3 {
		t.Errorf("expected 3 chunked requests (100+100+50), got %d", n)
	}
}

// TestEmbed_429Retry asserts a 429 retries and then succeeds.
func TestEmbed_429Retry(t *testing.T) {
	var n int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if atomic.AddInt32(&n, 1) == 1 {
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		_, _ = w.Write([]byte(`{"embedding":{"values":[1,2,3]}}`))
	}))
	defer srv.Close()

	c := NewClient("k")
	c.BaseURL = srv.URL
	c.Retries = 2
	// Shorten the HTTP timeout — backoff is 1s on the first attempt;
	// total budget is well under 5s.
	c.HTTP = &http.Client{Timeout: 5 * time.Second}

	v, err := c.Embed(context.Background(), "x", "")
	if err != nil {
		t.Fatalf("Embed after 429 retry: %v", err)
	}
	if len(v) != 3 {
		t.Errorf("got %v", v)
	}
	if atomic.LoadInt32(&n) != 2 {
		t.Errorf("expected 2 requests (1 retry), got %d", n)
	}
}

func TestEmbed_CapsSuccessResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("{", int(geminiEmbeddingMaxResponseBodyBytes)+1)))
	}))
	defer srv.Close()

	c := NewClient("k")
	c.BaseURL = srv.URL
	c.Retries = 0

	_, err := c.Embed(context.Background(), "x", "")
	if err == nil || !strings.Contains(err.Error(), "response body too large") {
		t.Fatalf("Embed err = %v, want response body too large", err)
	}
}

// TestEmbed_NonRetryable4xx asserts a 400 fails immediately without retry.
func TestEmbed_NonRetryable4xx(t *testing.T) {
	var n int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&n, 1)
		http.Error(w, "bad input", http.StatusBadRequest)
	}))
	defer srv.Close()

	c := NewClient("k")
	c.BaseURL = srv.URL
	c.Retries = 3
	_, err := c.Embed(context.Background(), "x", "")
	if err == nil {
		t.Fatal("expected error on 400")
	}
	if !strings.Contains(err.Error(), "400") {
		t.Errorf("error should mention 400 status: %v", err)
	}
	if atomic.LoadInt32(&n) != 1 {
		t.Errorf("expected exactly 1 request (no retry on 4xx), got %d", n)
	}
}

// TestNotWired asserts an unconfigured client returns ErrNotWired.
func TestNotWired(t *testing.T) {
	c := &Client{}
	if _, err := c.Embed(context.Background(), "x", ""); err != ErrNotWired {
		t.Errorf("err = %v, want ErrNotWired", err)
	}
	if _, err := c.EmbedBatch(context.Background(), []string{"x"}, ""); err != ErrNotWired {
		t.Errorf("err = %v, want ErrNotWired", err)
	}
}

// TestEmbedBatch_Empty asserts a nil input list short-circuits.
func TestEmbedBatch_Empty(t *testing.T) {
	c := NewClient("k")
	got, err := c.EmbedBatch(context.Background(), nil, "")
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Errorf("expected nil, got %v", got)
	}
}

// itoa is a tiny stdlib-free int-to-string for test bodies.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := false
	if i < 0 {
		neg, i = true, -i
	}
	buf := make([]byte, 0, 8)
	for i > 0 {
		buf = append(buf, byte('0'+i%10))
		i /= 10
	}
	if neg {
		buf = append(buf, '-')
	}
	for l, r := 0, len(buf)-1; l < r; l, r = l+1, r-1 {
		buf[l], buf[r] = buf[r], buf[l]
	}
	return string(buf)
}
