// SPDX-License-Identifier: AGPL-3.0-only
//
// SUB-072 — AI gateway / privacy firewall for prompts.
//
// token_registry.go is the in-memory, per-request token registry. The
// sanitizer substitutes each sensitive value with an opaque, deterministic
// (within one registry) token before a prompt is sent to a model, and the
// registry reverses those tokens on the model's response. The registry is
// request-scoped: build a fresh one per Generate call so tokens never leak
// between requests or tenants.
//
// Determinism within a registry matters: the same cleartext value tokenizes to
// the SAME token every time, so a prompt that mentions the subject's email
// three times collapses to one stable placeholder the model can reason about
// consistently — and the single reversal entry detokenizes all three.

package pii_gateway

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"sync"
)

// TokenRegistry maps opaque tokens to their cleartext values for one request.
// It is safe for concurrent use (the sanitizer may tokenize from multiple
// goroutines), though the common path is single-threaded.
type TokenRegistry struct {
	mu sync.RWMutex
	// forward maps a cleartext value -> its token (so repeated values reuse one
	// token deterministically).
	forward map[string]string
	// reverse maps a token -> its cleartext value (the detokenize direction).
	reverse map[string]string
	// salt scopes the deterministic token hash so two registries (or two
	// tenants) never produce a colliding token for the same value.
	salt string
}

// NewTokenRegistry builds an empty registry. salt should be unique per request
// (e.g. a request id, or tenant+nonce) so tokens are unguessable across
// requests; an empty salt still works but is less defensive.
func NewTokenRegistry(salt string) *TokenRegistry {
	return &TokenRegistry{
		forward: map[string]string{},
		reverse: map[string]string{},
		salt:    salt,
	}
}

// Tokenize returns a stable token for value under the given kind label
// (e.g. "EMAIL", "PHONE", a custom field name). The same (kind, value) always
// yields the same token within this registry. An empty value is returned
// unchanged (nothing to protect).
func (t *TokenRegistry) Tokenize(kind, value string) string {
	if value == "" {
		return value
	}
	key := kind + "\x00" + value
	t.mu.RLock()
	if tok, ok := t.forward[key]; ok {
		t.mu.RUnlock()
		return tok
	}
	t.mu.RUnlock()

	tok := t.makeToken(kind, value)
	t.mu.Lock()
	// Re-check under the write lock in case a concurrent Tokenize raced us.
	if existing, ok := t.forward[key]; ok {
		t.mu.Unlock()
		return existing
	}
	t.forward[key] = tok
	t.reverse[tok] = value
	t.mu.Unlock()
	return tok
}

// makeToken builds the opaque placeholder. Format: [[PII:<KIND>:<8 hex>]].
// The hex is a salted sha256 prefix of the value so it is stable per registry
// and not reversible without the reverse map.
func (t *TokenRegistry) makeToken(kind, value string) string {
	sum := sha256.Sum256([]byte(t.salt + "\x00" + kind + "\x00" + value))
	short := hex.EncodeToString(sum[:])[:8]
	upperKind := strings.ToUpper(sanitizeKind(kind))
	return fmt.Sprintf("[[PII:%s:%s]]", upperKind, short)
}

// Detokenize reverses every known token found in s back to its cleartext
// value. Tokens not present in the registry are left untouched (defensive: a
// model that hallucinates a token-shaped string must not crash detokenization).
// Replacement is done longest-token-first so no token is a prefix of another's
// replacement target.
func (t *TokenRegistry) Detokenize(s string) string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	if len(t.reverse) == 0 || s == "" {
		return s
	}
	toks := make([]string, 0, len(t.reverse))
	for tok := range t.reverse {
		toks = append(toks, tok)
	}
	// Longest first so a token that is a substring of another is replaced after
	// the longer one.
	sort.Slice(toks, func(i, j int) bool { return len(toks[i]) > len(toks[j]) })
	out := s
	for _, tok := range toks {
		out = strings.ReplaceAll(out, tok, t.reverse[tok])
	}
	return out
}

// Len reports the number of distinct values tokenized (for tests + metrics).
func (t *TokenRegistry) Len() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return len(t.reverse)
}

// Mappings returns a copy of the token->value reversals. Used to persist the
// ephemeral mappings for two-phase (async) detokenization via the gateway's
// durable store. The caller owns the returned map.
func (t *TokenRegistry) Mappings() map[string]string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	out := make(map[string]string, len(t.reverse))
	for k, v := range t.reverse {
		out[k] = v
	}
	return out
}

// sanitizeKind keeps a kind label safe for embedding in a token: letters,
// digits, and underscore only; everything else becomes underscore. Empty kinds
// become "FIELD".
func sanitizeKind(kind string) string {
	if kind == "" {
		return "FIELD"
	}
	var b strings.Builder
	for _, r := range kind {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	if b.Len() == 0 {
		return "FIELD"
	}
	return b.String()
}
