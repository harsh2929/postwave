package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tone_corpus "github.com/postwave/postwave/services/voice/internal/profile/tone_corpus"
)

func TestRunWritesExplicitSyntheticCorpusAtomically(t *testing.T) {
	output := filepath.Join(t.TempDir(), "corpus.json")
	var stderr bytes.Buffer
	if code := run([]string{"--output", output}, &stderr); code != 0 {
		t.Fatalf("run code=%d stderr=%s", code, stderr.String())
	}
	raw, err := os.ReadFile(output)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}
	var samples []tone_corpus.LabeledSample
	if err := json.Unmarshal(raw, &samples); err != nil {
		t.Fatalf("decode output: %v", err)
	}
	if len(samples) != len(tone_corpus.LabeledSamples) {
		t.Fatalf("samples=%d want=%d", len(samples), len(tone_corpus.LabeledSamples))
	}
	if !strings.Contains(stderr.String(), "synthetic seed") {
		t.Fatalf("source disclosure missing: %s", stderr.String())
	}
}

func TestRunRejectsInvalidTenantBeforeReplacingOutput(t *testing.T) {
	output := filepath.Join(t.TempDir(), "corpus.json")
	if err := os.WriteFile(output, []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	if code := run([]string{"--output", output, "--tenant-id", "not-a-uuid"}, &stderr); code != 2 {
		t.Fatalf("run code=%d stderr=%s", code, stderr.String())
	}
	raw, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != "existing" {
		t.Fatalf("invalid request replaced existing output: %q", raw)
	}
}

func TestRunRequiresDatabaseForPersistedTenantExport(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	output := filepath.Join(t.TempDir(), "corpus.json")
	var stderr bytes.Buffer
	code := run([]string{
		"--output", output,
		"--tenant-id", "11111111-1111-4111-8111-111111111111",
	}, &stderr)
	if code != 2 {
		t.Fatalf("run code=%d stderr=%s", code, stderr.String())
	}
	if _, err := os.Stat(output); !os.IsNotExist(err) {
		t.Fatalf("failed persisted export left an output file: %v", err)
	}
}
