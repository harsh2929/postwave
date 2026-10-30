package public

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadCorpusMessageFileRejectsOversizedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "message.eml")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create message: %v", err)
	}
	if err := f.Truncate(maxCorpusMessageBytes + 1); err != nil {
		_ = f.Close()
		t.Fatalf("truncate message: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close message: %v", err)
	}

	_, err = readCorpusMessageFile(path)
	if err == nil || !strings.Contains(err.Error(), "corpus message exceeds") {
		t.Fatalf("expected oversized corpus message error, got %v", err)
	}
}
