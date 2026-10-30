package linkedin

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/postwave/postwave/services/voice/internal/ingest"
)

func TestLinkedInIngestReadsExportCSV(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	path := "linkedin.csv"
	csv := `Date,ShareCommentary,URL
2026-05-01,"Shipping is about sequencing the boring work.",https://linkedin.test/post/1
2026-05-02,,https://linkedin.test/post/2
`
	if err := os.WriteFile(filepath.Join(dir, path), []byte(csv), 0o600); err != nil {
		t.Fatal(err)
	}

	seq, err := New().Ingest(context.Background(), ingest.IngestParams{ArchivePath: path})
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
	if len(items) != 1 {
		t.Fatalf("want 1 non-empty post, got %d", len(items))
	}
	if items[0].SourceType != ingest.SourceLinkedInExport {
		t.Fatalf("source type = %q", items[0].SourceType)
	}
	if items[0].Text != "Shipping is about sequencing the boring work." {
		t.Fatalf("unexpected text: %q", items[0].Text)
	}
	if items[0].URL != "https://linkedin.test/post/1" {
		t.Fatalf("url not preserved: %q", items[0].URL)
	}
}

func TestLinkedInIngestReadsRawCSV(t *testing.T) {
	csv := `Date,Text,Permalink
2026-05-01,"Raw CSV lets the app ingest an uploaded export without a shared filesystem.",https://linkedin.test/post/raw
`
	seq, err := New().Ingest(context.Background(), ingest.IngestParams{RawText: csv})
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
	if len(items) != 1 {
		t.Fatalf("want 1 post, got %d", len(items))
	}
	if items[0].Text != "Raw CSV lets the app ingest an uploaded export without a shared filesystem." {
		t.Fatalf("unexpected text: %q", items[0].Text)
	}
	if items[0].URL != "https://linkedin.test/post/raw" {
		t.Fatalf("url not preserved: %q", items[0].URL)
	}
}

func TestLinkedInIngestRejectsOversizedRawCSV(t *testing.T) {
	raw := "Date,Text\n" + strings.Repeat("x", int(maxLinkedInCSVBytes)+1)
	_, err := New().Ingest(context.Background(), ingest.IngestParams{RawText: raw})
	if err == nil || !strings.Contains(err.Error(), "linkedin csv exceeds") {
		t.Fatalf("err = %v, want csv size error", err)
	}
}

func TestLinkedInIngestRejectsTooManyRows(t *testing.T) {
	var b strings.Builder
	b.WriteString("Date,Text\n")
	for i := 0; i < maxLinkedInCSVRows+1; i++ {
		b.WriteString("2026-05-01,row\n")
	}
	_, err := New().Ingest(context.Background(), ingest.IngestParams{RawText: b.String()})
	if err == nil || !strings.Contains(err.Error(), "max is") {
		t.Fatalf("err = %v, want row limit error", err)
	}
}
