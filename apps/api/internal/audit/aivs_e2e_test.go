// SPDX-License-Identifier: AGPL-3.0-only
//
// aivs_e2e_test.go — end-to-end builder/verifier test. Drives
// BundleFiles writeBundleTarball through the buildChainAndJSONL path
// with a real Ed25519 keypair and confirms the embedded Python
// verifier (when python3 is available on PATH) accepts the bundle.
// Skips on hosts without python3.
package audit

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestAIVSBundle_PythonVerifierAccepts(t *testing.T) {
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not on PATH")
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	events := []AIVSEvent{
		{ID: 1, At: "2026-06-04T10:00:00Z", Action: "ai.start",
			ActorType: "agent", SessionID: "sess-1", ModelID: "m"},
		{ID: 2, At: "2026-06-04T10:00:01Z", Action: "ai.tool_call",
			ActorType: "agent", SessionID: "sess-1",
			ToolCalls: []string{"send_email"}},
		{ID: 3, At: "2026-06-04T10:00:02Z", Action: "ai.complete",
			ActorType: "agent", SessionID: "sess-1",
			OutputHash: "deadbeef"},
	}
	chain, jsonl, err := buildChainAndJSONL(events, priv)
	if err != nil {
		t.Fatal(err)
	}
	chainJSON, _ := json.MarshalIndent(chain, "", "  ")
	manifest := AIVSManifest{
		Generator:    AIVSGenerator,
		Version:      AIVSVersion,
		TenantID:     "tn",
		SessionID:    "sess-1",
		EventCount:   len(events),
		PubKeyHex:    hex.EncodeToString(pub),
		BundleSchema: "draft-stone-aivs-00",
		Algorithms:   AIVSAlgorithms{Hash: "sha256", Signature: "ed25519"},
	}
	manifestJSON, _ := json.MarshalIndent(manifest, "", "  ")

	gz, err := writeBundleTarball(BundleFiles{
		Manifest: manifestJSON,
		Events:   jsonl,
		Chain:    chainJSON,
		VerifyPy: aivsVerifyPy,
	})
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	if err := extractTarGz(gz, dir); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(py, filepath.Join(dir, "verify.py"), dir)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("verify.py rejected bundle: %v\noutput:\n%s", err, string(out))
	}
	if !bytes.Contains(out, []byte("OK")) {
		t.Fatalf("verify.py output missing OK marker: %s", string(out))
	}
}

func TestAIVSBundle_VerifierRejectsTamper(t *testing.T) {
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not on PATH")
	}
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	events := []AIVSEvent{
		{ID: 1, At: "t1", Action: "a", ActorType: "agent", SessionID: "s"},
		{ID: 2, At: "t2", Action: "b", ActorType: "agent", SessionID: "s"},
	}
	chain, jsonl, _ := buildChainAndJSONL(events, priv)
	chainJSON, _ := json.MarshalIndent(chain, "", "  ")
	manifest := AIVSManifest{
		Generator:    AIVSGenerator,
		Version:      AIVSVersion,
		PubKeyHex:    hex.EncodeToString(pub),
		BundleSchema: "draft-stone-aivs-00",
		Algorithms:   AIVSAlgorithms{Hash: "sha256", Signature: "ed25519"},
		SessionID:    "s",
		EventCount:   2,
	}
	manifestJSON, _ := json.MarshalIndent(manifest, "", "  ")

	// Replace the second line with a tampered version BUT keep the
	// chain.json intact — the recomputed hash should disagree.
	jsonl = bytes.Replace(jsonl, []byte(`"action":"b"`), []byte(`"action":"X"`), 1)
	gz, _ := writeBundleTarball(BundleFiles{
		Manifest: manifestJSON,
		Events:   jsonl,
		Chain:    chainJSON,
		VerifyPy: aivsVerifyPy,
	})
	dir := t.TempDir()
	if err := extractTarGz(gz, dir); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(py, filepath.Join(dir, "verify.py"), dir)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatalf("verify.py accepted tampered bundle: %s", string(out))
	}
}

func extractTarGz(gz []byte, dest string) error {
	gr, err := gzip.NewReader(bytes.NewReader(gz))
	if err != nil {
		return err
	}
	defer func() { _ = gr.Close() }()
	tr := tar.NewReader(gr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		p := filepath.Join(dest, hdr.Name)
		body, err := io.ReadAll(tr)
		if err != nil {
			return err
		}
		if err := os.WriteFile(p, body, 0o644); err != nil {
			return err
		}
	}
}
