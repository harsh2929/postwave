package rss

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mmcdole/gofeed"

	"github.com/postwave/postwave/services/voice/internal/ingest"
)

const sampleFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Blog</title>
    <link>https://example.com</link>
    <description>desc</description>
    <item>
      <title>First Post</title>
      <link>https://example.com/1</link>
      <guid>g1</guid>
      <pubDate>Tue, 01 Apr 2025 12:00:00 GMT</pubDate>
      <description>&lt;p&gt;Hello &lt;b&gt;world&lt;/b&gt;.&lt;/p&gt;&lt;p&gt;Second paragraph.&lt;/p&gt;</description>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://example.com/2</link>
      <guid>g2</guid>
      <pubDate>Wed, 02 Apr 2025 12:00:00 GMT</pubDate>
      <description>Plain text body.</description>
    </item>
  </channel>
</rss>`

func TestRSSIngest(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/rss+xml")
		_, _ = w.Write([]byte(sampleFeed))
	}))
	defer srv.Close()

	// New() wires the SSRF-safe http client, which (correctly)
	// refuses to dial 127.0.0.1 — defeating httptest. Tests swap in
	// the bare gofeed parser so the local-loopback fixture works;
	// production callers omit this and get the secure default.
	src := New()
	src.parser = gofeed.NewParser()
	seq, err := src.Ingest(context.Background(), ingest.IngestParams{FeedURL: srv.URL})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}

	var items []ingest.Item
	for it, ierr := range seq {
		if ierr != nil {
			t.Fatalf("iter err: %v", ierr)
		}
		items = append(items, it)
	}
	if len(items) != 2 {
		t.Fatalf("got %d items, want 2", len(items))
	}
	if items[0].Title != "First Post" {
		t.Errorf("title = %q", items[0].Title)
	}
	if !strings.Contains(items[0].Text, "Hello") {
		t.Errorf("text missing Hello: %q", items[0].Text)
	}
	if strings.Contains(items[0].Text, "<b>") {
		t.Errorf("text still has HTML tags: %q", items[0].Text)
	}
}
