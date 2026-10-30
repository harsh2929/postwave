// SPDX-License-Identifier: AGPL-3.0-only
//
// aivs.go — AIVS (AI Verifiable Session) proof-bundle builder.
//
// aivs-bundles (Compliance, P2). Produces a downloadable .tar.gz that
// proves the integrity of an AI agent's actions during a single session
// so an EU AI Act Article 50 inspector can independently verify the
// claim "this output was produced by this model with these tool calls
// against these prompts and we have not silently tampered with the log
// since". Bundle layout:
//
//	manifest.json   — AIVS spec metadata (generator, version, pubkey)
//	events.jsonl    — one canonical line per agent audit row
//	chain.json      — per-event SHA-256 hash + Ed25519 signature
//	verify.py       — Python stdlib-only offline verifier
//
// The signing key is generated per bundle (ephemeral) and the public
// key embedded in manifest.json. An external auditor who already
// trusts Moosewave's published rotation log can pin the pubkey there;
// the verifier checks the chain on its own without trusting the API.
package audit

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// AIVSGenerator identifies the producer of the bundle. Bumped on
// breaking schema changes; verifiers refuse bundles with unknown gen.
const AIVSGenerator = "postwave-audit"

// AIVSVersion follows the draft-stone-aivs spec revision we implement.
// Cached as a string so manifests render identically across builds.
const AIVSVersion = "0.1.0"

// ErrNoSession is returned when the requested session_id has no agent
// events for the tenant — the handler maps it to 404 not_found so the
// caller hears about the empty-bundle case explicitly rather than
// receiving a 200 with an empty tarball that looks like success.
var ErrNoSession = errors.New("aivs: no agent events for session")

// AIVSManifest is the manifest.json shape. JSON tags are stable —
// changing one is a breaking spec change.
type AIVSManifest struct {
	Generator    string            `json:"generator"`
	Version      string            `json:"version"`
	TenantID     string            `json:"tenant_id"`
	SessionID    string            `json:"session_id"`
	BuiltAt      string            `json:"built_at"`
	EventCount   int               `json:"event_count"`
	PubKeyHex    string            `json:"pubkey_ed25519_hex"`
	Algorithms   AIVSAlgorithms    `json:"algorithms"`
	BundleSchema string            `json:"bundle_schema"`
	Notes        map[string]string `json:"notes,omitempty"`
}

// AIVSAlgorithms is the algorithm registry embedded in the manifest.
// Verifiers refuse a bundle whose algorithm strings are unrecognized.
type AIVSAlgorithms struct {
	Hash      string `json:"hash"`
	Signature string `json:"signature"`
}

// AIVSEvent is the canonical row written one-per-line to events.jsonl.
// Field order is fixed; never reorder — verifier marshals from the
// same struct to recompute the row hash.
type AIVSEvent struct {
	ID         int64          `json:"id"`
	At         string         `json:"at"`
	Action     string         `json:"action"`
	ActorType  string         `json:"actor_type"`
	ActorLabel string         `json:"actor_label,omitempty"`
	SessionID  string         `json:"session_id"`
	PromptHash string         `json:"prompt_hash,omitempty"`
	ModelID    string         `json:"model_id,omitempty"`
	ToolCalls  []string       `json:"tool_calls,omitempty"`
	OutputHash string         `json:"output_hash,omitempty"`
	Metadata   map[string]any `json:"metadata,omitempty"`
}

// AIVSChainEntry is one line in chain.json — each entry chains to
// the previous via prev_hash so a verifier walks the list once and
// detects any mid-chain edit.
type AIVSChainEntry struct {
	EventID     int64  `json:"event_id"`
	RowHashHex  string `json:"row_hash_hex"`
	PrevHashHex string `json:"prev_hash_hex"`
	SigHex      string `json:"sig_hex"`
}

// AIVSChain is the chain.json wire shape.
type AIVSChain struct {
	Entries []AIVSChainEntry `json:"entries"`
}

//go:embed aivs_verify.py.tmpl
var aivsVerifyPy []byte

// BuildBundle loads the agent audit rows for (tenantID, sessionID),
// canonicalises them, signs the chain, and returns the gzipped tar
// bytes ready to ship as an HTTP response body.
//
// Tenant isolation: we set app.tenant_id on the tx so the existing
// audit_log RLS policy gates row visibility. session_id and
// actor_type='agent' are explicit filters on top.
func BuildBundle(ctx context.Context, pool *pgxpool.Pool, tenantID, sessionID string) ([]byte, error) {
	if pool == nil {
		return nil, errors.New("aivs: nil pool")
	}
	tenantID = strings.TrimSpace(tenantID)
	sessionID = strings.TrimSpace(sessionID)
	if tenantID == "" || sessionID == "" {
		return nil, errors.New("aivs: tenant_id and session_id are required")
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("aivs: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// SET LOCAL takes no bind parameters -- Postgres cannot even PREPARE
	// `SET LOCAL app.tenant_id = $1`, it is a syntax error at the $1 (42601).
	// set_config(name, value, is_local) is the function form, and its third
	// argument gives the same transaction-local scope.
	//
	// Every call through here failed, so this path has never once worked.
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return nil, fmt.Errorf("aivs: set tenant: %w", err)
	}

	rows, err := tx.Query(ctx, `
SELECT id, at, action,
       COALESCE(actor_type, ''),
       COALESCE(actor_label, ''),
       COALESCE(session_id, ''),
       COALESCE(metadata, '{}'::jsonb)
  FROM audit_log
 WHERE tenant_id = $1::uuid
   AND session_id = $2
   AND actor_type = 'agent'
 ORDER BY id ASC`, tenantID, sessionID)
	if err != nil {
		return nil, fmt.Errorf("aivs: query: %w", err)
	}
	defer rows.Close()

	events := make([]AIVSEvent, 0, 64)
	for rows.Next() {
		var (
			id                                 int64
			at                                 time.Time
			action, actorType, actorLabel, sid string
			metadata                           map[string]any
		)
		if err := rows.Scan(&id, &at, &action, &actorType, &actorLabel, &sid, &metadata); err != nil {
			return nil, fmt.Errorf("aivs: scan: %w", err)
		}
		ev := AIVSEvent{
			ID:         id,
			At:         at.UTC().Format(time.RFC3339Nano),
			Action:     action,
			ActorType:  actorType,
			ActorLabel: actorLabel,
			SessionID:  sid,
			Metadata:   metadata,
		}
		extractAIMetadata(metadata, &ev)
		events = append(events, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("aivs: rows: %w", err)
	}
	if len(events) == 0 {
		return nil, ErrNoSession
	}

	// Deterministic order: id ASC (already from SQL) — re-sort defensively
	// so any future projection change can't accidentally produce a bundle
	// whose chain hash depends on row arrival order.
	sort.Slice(events, func(i, j int) bool { return events[i].ID < events[j].ID })

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("aivs: genkey: %w", err)
	}

	chain, eventsJSONL, err := buildChainAndJSONL(events, priv)
	if err != nil {
		return nil, err
	}

	manifest := AIVSManifest{
		Generator:    AIVSGenerator,
		Version:      AIVSVersion,
		TenantID:     tenantID,
		SessionID:    sessionID,
		BuiltAt:      time.Now().UTC().Format(time.RFC3339Nano),
		EventCount:   len(events),
		PubKeyHex:    hex.EncodeToString(pub),
		BundleSchema: "draft-stone-aivs-00",
		Algorithms: AIVSAlgorithms{
			Hash:      "sha256",
			Signature: "ed25519",
		},
		Notes: map[string]string{
			"verifier":    "verify.py — Python 3 stdlib only",
			"chain_model": "events.jsonl ordered by id ASC; row_hash = sha256(line_bytes + prev_hash); sig = ed25519(row_hash)",
		},
	}
	manifestJSON, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("aivs: marshal manifest: %w", err)
	}
	chainJSON, err := json.MarshalIndent(chain, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("aivs: marshal chain: %w", err)
	}

	return writeBundleTarball(BundleFiles{
		Manifest: manifestJSON,
		Events:   eventsJSONL,
		Chain:    chainJSON,
		VerifyPy: aivsVerifyPy,
	})
}

// extractAIMetadata pulls the EU AI Act Article 50 fields out of the
// generic metadata blob (prompt_hash / model_id / tool_calls /
// output_hash) into typed top-level columns on the canonical event so
// the verifier doesn't need to special-case nested lookups.
func extractAIMetadata(meta map[string]any, ev *AIVSEvent) {
	if meta == nil {
		return
	}
	if s, ok := meta["prompt_hash"].(string); ok {
		ev.PromptHash = s
	}
	if s, ok := meta["model_id"].(string); ok {
		ev.ModelID = s
	}
	if s, ok := meta["output_hash"].(string); ok {
		ev.OutputHash = s
	}
	switch v := meta["tool_calls"].(type) {
	case []any:
		tools := make([]string, 0, len(v))
		for _, t := range v {
			if s, ok := t.(string); ok {
				tools = append(tools, s)
			}
		}
		if len(tools) > 0 {
			ev.ToolCalls = tools
		}
	case []string:
		if len(v) > 0 {
			ev.ToolCalls = append([]string(nil), v...)
		}
	}
}

// BundleFiles is the input to writeBundleTarball. Exported so tests in
// the same package can drive the archive writer without re-running the
// SQL path.
type BundleFiles struct {
	Manifest []byte
	Events   []byte
	Chain    []byte
	VerifyPy []byte
}

// buildChainAndJSONL canonicalises each event into one JSONL line and
// folds the SHA-256 hash chain on the side. Returns the chain.json
// payload and the events.jsonl bytes — both pinned to the same byte
// boundaries so a verifier replaying the chain reproduces identical
// hashes.
func buildChainAndJSONL(events []AIVSEvent, priv ed25519.PrivateKey) (AIVSChain, []byte, error) {
	chain := AIVSChain{Entries: make([]AIVSChainEntry, 0, len(events))}
	var jsonl bytes.Buffer
	prev := make([]byte, 32) // genesis = 32 zero bytes
	for _, ev := range events {
		line, err := canonicalJSON(ev)
		if err != nil {
			return AIVSChain{}, nil, fmt.Errorf("aivs: canonical: %w", err)
		}
		jsonl.Write(line)
		jsonl.WriteByte('\n')

		h := sha256.New()
		h.Write(line)
		h.Write(prev)
		row := h.Sum(nil)
		sig := ed25519.Sign(priv, row)

		chain.Entries = append(chain.Entries, AIVSChainEntry{
			EventID:     ev.ID,
			RowHashHex:  hex.EncodeToString(row),
			PrevHashHex: hex.EncodeToString(prev),
			SigHex:      hex.EncodeToString(sig),
		})
		prev = row
	}
	return chain, jsonl.Bytes(), nil
}

// canonicalJSON marshals an AIVSEvent with stable key ordering. Go's
// encoding/json already sorts map keys lexicographically — we rely on
// that here to keep the canonical form deterministic across runs.
func canonicalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	// Encode appends '\n'; the chain hash inputs the raw line WITHOUT
	// the trailing newline so verify.py (which reads with .strip()) can
	// recompute the same hash without ambiguity.
	out := buf.Bytes()
	if n := len(out); n > 0 && out[n-1] == '\n' {
		out = out[:n-1]
	}
	return out, nil
}

// writeBundleTarball stuffs the four canonical files into a single
// gzipped tarball with deterministic mtimes and 0444 mode (read-only —
// the spec demands verifiers refuse to operate on mutated bundles).
func writeBundleTarball(files BundleFiles) ([]byte, error) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)

	// Stable mtime: epoch + 1 second, so two builds of the same
	// session produce bit-identical archives (modulo the per-bundle
	// ephemeral key + signature non-determinism).
	mtime := time.Unix(0, 0).UTC()

	entries := []struct {
		name string
		data []byte
	}{
		{"manifest.json", files.Manifest},
		{"events.jsonl", files.Events},
		{"chain.json", files.Chain},
		{"verify.py", files.VerifyPy},
	}
	for _, e := range entries {
		if err := tw.WriteHeader(&tar.Header{
			Name:    e.name,
			Mode:    0o444,
			Size:    int64(len(e.data)),
			ModTime: mtime,
		}); err != nil {
			return nil, fmt.Errorf("aivs: tar header %s: %w", e.name, err)
		}
		if _, err := tw.Write(e.data); err != nil {
			return nil, fmt.Errorf("aivs: tar write %s: %w", e.name, err)
		}
	}
	if err := tw.Close(); err != nil {
		return nil, fmt.Errorf("aivs: tar close: %w", err)
	}
	if err := gz.Close(); err != nil {
		return nil, fmt.Errorf("aivs: gzip close: %w", err)
	}
	return buf.Bytes(), nil
}
