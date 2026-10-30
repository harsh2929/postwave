package pastein

import (
	"context"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/ingest"
)

func TestPasteIn_SplitsParagraphs(t *testing.T) {
	src := New()
	raw := "First paragraph one.\n\nSecond paragraph two.\n\n\nThird with extra blank lines."
	seq, err := src.Ingest(context.Background(), ingest.IngestParams{RawText: raw})
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	var items []ingest.Item
	for it, ierr := range seq {
		if ierr != nil {
			t.Fatal(ierr)
		}
		items = append(items, it)
	}
	if len(items) != 3 {
		t.Fatalf("got %d items, want 3: %+v", len(items), items)
	}
	if items[0].Text != "First paragraph one." {
		t.Errorf("first item text = %q", items[0].Text)
	}
	if items[2].Text != "Third with extra blank lines." {
		t.Errorf("third item text = %q", items[2].Text)
	}
}

func TestPasteIn_RequiresRawText(t *testing.T) {
	src := New()
	if _, err := src.Ingest(context.Background(), ingest.IngestParams{}); err == nil {
		t.Errorf("expected error for empty RawText")
	}
}
