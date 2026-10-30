package eval

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadEvalFileRejectsOversizedFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "case.json")
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create eval file: %v", err)
	}
	if err := f.Truncate(maxEvalJSONFileBytes + 1); err != nil {
		_ = f.Close()
		t.Fatalf("truncate eval file: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("close eval file: %v", err)
	}

	_, err = readEvalFile(path)
	if err == nil || !strings.Contains(err.Error(), "eval JSON file exceeds") {
		t.Fatalf("expected oversized eval file error, got %v", err)
	}
}
