package twitter

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/ingest"
)

func TestTwitterIngestReadsArchive(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)

	raw := `window.YTD.tweets.part0 = [
  {"tweet":{"id_str":"1","full_text":"This is the writer's own post.","created_at":"Mon Apr 01 12:00:00 +0000 2024"}},
  {"tweet":{"id_str":"2","full_text":"RT @someone: skipped","created_at":"Mon Apr 01 13:00:00 +0000 2024"}}
]`
	if err := os.WriteFile("tweets.js", []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}

	seq, err := New().Ingest(context.Background(), ingest.IngestParams{ArchivePath: "tweets.js"})
	if err != nil {
		t.Fatal(err)
	}
	items := collect(t, seq)
	if len(items) != 1 {
		t.Fatalf("items = %d, want 1", len(items))
	}
	if items[0].ID != "tweet:1" {
		t.Fatalf("id = %q", items[0].ID)
	}
	if strings.Contains(items[0].Text, "RT @") {
		t.Fatalf("retweet was not filtered: %q", items[0].Text)
	}
}

func TestTwitterIngestRejectsOversizedArchive(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	if err := os.WriteFile("tweets.js", []byte(strings.Repeat("x", int(maxTwitterArchiveBytes)+1)), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := New().Ingest(context.Background(), ingest.IngestParams{ArchivePath: "tweets.js"})
	if err == nil || !strings.Contains(err.Error(), "archive exceeds") {
		t.Fatalf("err = %v, want archive size error", err)
	}
}

func TestTwitterIngestAPIModeResolvesUsernameAndPaginates(t *testing.T) {
	var sawUserAuth bool
	var sawTweetAuth bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-token" {
			t.Fatalf("missing auth header on %s", r.URL.String())
		}
		switch r.URL.Path {
		case "/users/by/username/postwave":
			sawUserAuth = true
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"data":{"id":"u123"}}`))
		case "/users/u123/tweets":
			sawTweetAuth = true
			if got := r.URL.Query().Get("tweet.fields"); got != "created_at" {
				t.Fatalf("tweet.fields = %q", got)
			}
			w.Header().Set("Content-Type", "application/json")
			if r.URL.Query().Get("pagination_token") == "" {
				_, _ = w.Write([]byte(`{"data":[{"id":"10","text":"First API tweet","created_at":"2026-05-01T12:00:00Z"}],"meta":{"next_token":"next-1"}}`))
				return
			}
			_, _ = w.Write([]byte(`{"data":[{"id":"11","text":"Second API tweet","created_at":"2026-05-02T12:00:00Z"}],"meta":{}}`))
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
	}))
	defer srv.Close()

	src := &Source{
		HTTPClient:  srv.Client(),
		BaseURL:     srv.URL,
		BearerToken: "test-token",
	}
	seq, err := src.Ingest(context.Background(), ingest.IngestParams{
		Limit: 2,
		Extra: map[string]string{
			"mode":     "api",
			"username": "@postwave",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	items := collect(t, seq)
	if len(items) != 2 {
		t.Fatalf("items = %d, want 2", len(items))
	}
	if !sawUserAuth || !sawTweetAuth {
		t.Fatalf("expected username and tweets endpoints to be called")
	}
	if items[0].URL != "https://x.com/i/web/status/10" {
		t.Fatalf("url = %q", items[0].URL)
	}
	if items[1].Text != "Second API tweet" {
		t.Fatalf("second text = %q", items[1].Text)
	}
}

func TestTwitterIngestAPIModeRequiresToken(t *testing.T) {
	_, err := (&Source{}).Ingest(context.Background(), ingest.IngestParams{
		Extra: map[string]string{
			"mode":    "api",
			"user_id": "u123",
		},
	})
	if err == nil || !strings.Contains(err.Error(), "TWITTER_BEARER_TOKEN") {
		t.Fatalf("expected missing-token error, got %v", err)
	}
}

func TestTwitterIngestAPIModeCapsSuccessResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("{", int(maxTwitterAPIBytes)+1)))
	}))
	defer srv.Close()

	src := &Source{
		HTTPClient:  srv.Client(),
		BaseURL:     srv.URL,
		BearerToken: "test-token",
	}
	_, err := src.Ingest(context.Background(), ingest.IngestParams{
		Limit: 1,
		Extra: map[string]string{
			"mode":    "api",
			"user_id": "u123",
		},
	})
	if err == nil || !strings.Contains(err.Error(), "response body too large") {
		t.Fatalf("api ingest err = %v, want response body too large", err)
	}
}

func collect(t *testing.T, seq func(func(ingest.Item, error) bool)) []ingest.Item {
	t.Helper()
	var items []ingest.Item
	for item, err := range seq {
		if err != nil {
			t.Fatal(err)
		}
		items = append(items, item)
	}
	return items
}
