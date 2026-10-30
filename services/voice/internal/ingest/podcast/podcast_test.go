package podcast

import (
	"context"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/ingest"
)

func TestPodcastIngestCleansTranscriptBlocks(t *testing.T) {
	src := New()
	seq, err := src.Ingest(context.Background(), ingest.IngestParams{
		RawText: "[00:01] Host: Welcome to the show.\nGuest: Glad to be here.\n\n00:42 - This is the second block.",
		Extra:   map[string]string{"title": "Founder interview", "url": "https://example.test/podcast"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var items []ingest.Item
	for item, err := range seq {
		if err != nil {
			t.Fatal(err)
		}
		items = append(items, item)
	}
	if len(items) != 2 {
		t.Fatalf("want 2 items, got %d", len(items))
	}
	if items[0].SourceType != ingest.SourcePodcastTranscript {
		t.Fatalf("source type = %q", items[0].SourceType)
	}
	if items[0].Text != "Host: Welcome to the show.\nGuest: Glad to be here." {
		t.Fatalf("unexpected cleaned transcript: %q", items[0].Text)
	}
	if items[0].Title != "Founder interview" || items[0].URL == "" {
		t.Fatalf("metadata not preserved: %#v", items[0])
	}
}
