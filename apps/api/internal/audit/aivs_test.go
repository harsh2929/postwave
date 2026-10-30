// SPDX-License-Identifier: AGPL-3.0-only
package audit

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"strings"
	"testing"
)

func TestCanonicalJSON_DeterministicKeyOrder(t *testing.T) {
	ev := AIVSEvent{
		ID:         42,
		At:         "2026-06-04T12:00:00Z",
		Action:     "ai.complete",
		ActorType:  "agent",
		ActorLabel: "claude-code",
		SessionID:  "sess-abc",
		PromptHash: "deadbeef",
		ModelID:    "claude-opus-4.7",
		ToolCalls:  []string{"send_message"},
		OutputHash: "feedface",
		Metadata: map[string]any{
			"z": 1,
			"a": 2,
		},
	}
	a, err := canonicalJSON(ev)
	if err != nil {
		t.Fatal(err)
	}
	b, err := canonicalJSON(ev)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Fatalf("canonical form unstable: %q vs %q", a, b)
	}
	// Sanity — the embedded metadata map must serialise with keys sorted.
	if !bytes.Contains(a, []byte(`"a":2,"z":1`)) {
		t.Fatalf("metadata keys not sorted in %s", string(a))
	}
}

func TestExtractAIMetadata_PullsArticle50Fields(t *testing.T) {
	ev := AIVSEvent{ID: 1}
	extractAIMetadata(map[string]any{
		"prompt_hash": "p",
		"model_id":    "m",
		"output_hash": "o",
		"tool_calls":  []any{"a", "b"},
	}, &ev)
	if ev.PromptHash != "p" || ev.ModelID != "m" || ev.OutputHash != "o" {
		t.Fatalf("expected fields populated, got %+v", ev)
	}
	if len(ev.ToolCalls) != 2 || ev.ToolCalls[0] != "a" {
		t.Fatalf("tool_calls not extracted: %+v", ev.ToolCalls)
	}
	// []string variant
	ev2 := AIVSEvent{ID: 2}
	extractAIMetadata(map[string]any{"tool_calls": []string{"x"}}, &ev2)
	if len(ev2.ToolCalls) != 1 || ev2.ToolCalls[0] != "x" {
		t.Fatalf("string-slice tool_calls not extracted: %+v", ev2.ToolCalls)
	}
}

func TestBuildChainAndJSONL_ChainIsCorrectAndVerifies(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	events := []AIVSEvent{
		{ID: 1, At: "2026-06-04T10:00:00Z", Action: "ai.start", ActorType: "agent", SessionID: "s1"},
		{ID: 2, At: "2026-06-04T10:00:01Z", Action: "ai.tool_call", ActorType: "agent", SessionID: "s1", ModelID: "m"},
		{ID: 3, At: "2026-06-04T10:00:02Z", Action: "ai.complete", ActorType: "agent", SessionID: "s1", OutputHash: "ff"},
	}
	chain, jsonl, err := buildChainAndJSONL(events, priv)
	if err != nil {
		t.Fatal(err)
	}
	if len(chain.Entries) != len(events) {
		t.Fatalf("chain length = %d, want %d", len(chain.Entries), len(events))
	}
	// Walk the chain like a verifier would.
	lines := bytes.Split(bytes.TrimRight(jsonl, "\n"), []byte{'\n'})
	if len(lines) != len(events) {
		t.Fatalf("jsonl lines = %d, want %d", len(lines), len(events))
	}
	prev := make([]byte, 32)
	for i, line := range lines {
		h := sha256.New()
		h.Write(line)
		h.Write(prev)
		row := h.Sum(nil)
		if hex.EncodeToString(row) != chain.Entries[i].RowHashHex {
			t.Fatalf("entry %d row_hash mismatch", i)
		}
		if hex.EncodeToString(prev) != chain.Entries[i].PrevHashHex {
			t.Fatalf("entry %d prev_hash mismatch", i)
		}
		sig, _ := hex.DecodeString(chain.Entries[i].SigHex)
		if !ed25519.Verify(pub, row, sig) {
			t.Fatalf("entry %d signature failed", i)
		}
		prev = row
	}
}

func TestBuildChainAndJSONL_TamperDetected(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	events := []AIVSEvent{
		{ID: 1, At: "t1", Action: "a", ActorType: "agent", SessionID: "s"},
		{ID: 2, At: "t2", Action: "b", ActorType: "agent", SessionID: "s"},
	}
	chain, jsonl, err := buildChainAndJSONL(events, priv)
	if err != nil {
		t.Fatal(err)
	}
	// Recompute as if the second line had been swapped for something else.
	lines := bytes.Split(bytes.TrimRight(jsonl, "\n"), []byte{'\n'})
	prev := make([]byte, 32)
	h := sha256.New()
	h.Write(lines[0])
	h.Write(prev)
	prev = h.Sum(nil)
	h.Reset()
	tampered := append([]byte{}, lines[1]...)
	tampered = bytes.Replace(tampered, []byte(`"b"`), []byte(`"c"`), 1)
	h.Write(tampered)
	h.Write(prev)
	row := h.Sum(nil)
	if hex.EncodeToString(row) == chain.Entries[1].RowHashHex {
		t.Fatal("tampered row should not match recorded hash")
	}
}

func TestWriteBundleTarball_HasFourCanonicalFiles(t *testing.T) {
	manifest, _ := json.Marshal(AIVSManifest{Generator: AIVSGenerator, Version: AIVSVersion})
	chain, _ := json.Marshal(AIVSChain{Entries: []AIVSChainEntry{{EventID: 1, RowHashHex: "deadbeef"}}})
	gz, err := writeBundleTarball(BundleFiles{
		Manifest: manifest,
		Events:   []byte(`{"id":1}` + "\n"),
		Chain:    chain,
		VerifyPy: []byte("#!/usr/bin/env python3\nprint('hi')\n"),
	})
	if err != nil {
		t.Fatal(err)
	}
	got := readTarball(t, gz)
	wantNames := []string{"manifest.json", "events.jsonl", "chain.json", "verify.py"}
	if len(got) != len(wantNames) {
		t.Fatalf("entry count = %d, want %d", len(got), len(wantNames))
	}
	for i, n := range wantNames {
		if got[i].name != n {
			t.Fatalf("entry %d name = %q, want %q", i, got[i].name, n)
		}
		if got[i].mode != 0o444 {
			t.Fatalf("entry %d mode = %o, want 0444", i, got[i].mode)
		}
		if len(got[i].body) == 0 {
			t.Fatalf("entry %d empty", i)
		}
	}
}

func TestEmbeddedVerifyPy_HasStdlibVerifier(t *testing.T) {
	// verify.py must be embedded (not empty) and contain the ed25519
	// verifier function so a downloaded bundle works without the
	// Moosewave repo handy.
	s := string(aivsVerifyPy)
	if !strings.Contains(s, "ed25519_verify") {
		t.Fatalf("embedded verify.py missing ed25519_verify function")
	}
	if !strings.Contains(s, "sha256") {
		t.Fatalf("embedded verify.py missing sha256 use")
	}
}

type tarEntry struct {
	name string
	mode int64
	body []byte
}

func readTarball(t *testing.T, gz []byte) []tarEntry {
	t.Helper()
	gr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = gr.Close() }()
	tr := tar.NewReader(gr)
	var out []tarEntry
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(tr)
		out = append(out, tarEntry{name: hdr.Name, mode: hdr.Mode, body: body})
	}
	return out
}
