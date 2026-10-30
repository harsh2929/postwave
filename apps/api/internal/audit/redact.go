// Package audit hosts the audit_log redaction + envelope-encryption
// pipeline. The redactor walks every metadata payload before it lands
// in audit_log, masking known sensitive field names and (optionally)
// peeling off sub-paths into a separate encrypted blob that only
// callers holding the audit:read_pii scope can decrypt.
//
// Compliance gap-doc category: Compliance, P0.
package audit

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// RedactSentinel is the visible placeholder for any field stripped by
// the redactor. The exact bytes don't matter for security (the value
// is already gone) — we pick something obvious so a reviewer skimming
// the dashboard immediately spots a redaction.
const RedactSentinel = "[REDACTED]"

// DefaultRedactedFields is the floor every tenant inherits. Tenants
// MAY add to this list via audit_redaction_policies.default_redacted_fields
// but cannot drop below it — enforced in normalizeFloor.
//
// Picked to cover the obvious credentials + PII categories. Kept short
// so the case-insensitive substring match stays cheap; longer lists
// belong in jsonpath_rules.
var DefaultRedactedFields = []string{
	"password", "token", "api_key", "apikey",
	"secret", "credit_card", "creditcard",
	"ssn", "ein", "dob",
}

// Policy is the in-memory representation of one row of
// audit_redaction_policies. Built by the db layer and handed to the
// redactor on every write.
type Policy struct {
	// DefaultRedactedFields are the field-name tokens that are masked
	// on first sight regardless of position in the metadata tree. The
	// match is case-insensitive substring on the JSON object key.
	DefaultRedactedFields []string
	// JSONPathRules are the per-tenant overrides. Each rule has a
	// dot-style path (e.g. "$.billing.card_number") and an action.
	JSONPathRules []Rule
}

// RuleAction enumerates the actions a JSONPath rule can take on a
// matched value.
type RuleAction string

const (
	// ActionMask replaces the value with RedactSentinel. The original
	// is gone — not recoverable. Use for tokens you never need to
	// review post-fact.
	ActionMask RuleAction = "mask"
	// ActionEncrypt moves the value into the encrypted side-blob and
	// replaces the in-place value with RedactSentinel. Decryptable
	// by callers with audit:read_pii via the Unmask handler.
	ActionEncrypt RuleAction = "encrypt"
	// ActionHash replaces the value with RedactSentinel and stores
	// SHA-256(value) in redacted_field_hashes so a reviewer can ask
	// "did any row ever touch <known value>?" without ever seeing
	// the plaintext. Useful for SSNs you want to search by.
	ActionHash RuleAction = "hash"
)

// Rule is one JSONPath redaction directive.
type Rule struct {
	Path   string     `json:"path"`
	Action RuleAction `json:"action"`
}

// Result is the redactor's three-tuple output. The caller writes
// Redacted into audit_log.metadata, Encrypted into
// audit_log.metadata_encrypted (when non-nil), and Hashes into
// audit_log.redacted_field_hashes.
//
// RedactedFields lists the leaf paths that were touched — surfaced
// to the frontend as the "contains redacted fields" badge without
// disclosing values.
type Result struct {
	Redacted       map[string]any
	Encrypted      map[string]any
	Hashes         map[string]string
	RedactedFields []string
}

// Cipher is the encrypt/decrypt surface the redactor depends on.
// Matches *crypto.EnvelopeCipher; kept as an interface so unit tests
// can substitute a deterministic mock without pulling in the AES code.
type Cipher interface {
	Encrypt(ctx context.Context, plaintext []byte) ([]byte, error)
	Decrypt(ctx context.Context, blob, legacyKEK []byte) ([]byte, error)
}

// Redactor applies a Policy to a metadata map. Construct one per
// request; the policy is small and the redactor itself holds no
// state worth pooling.
type Redactor struct {
	Policy Policy
	Cipher Cipher // nil-safe: ActionEncrypt rules fall back to ActionMask
}

// NewRedactor builds a redactor. Always normalizes the floor so a
// misconfigured policy can never drop default protections.
func NewRedactor(p Policy, c Cipher) *Redactor {
	p.DefaultRedactedFields = normalizeFloor(p.DefaultRedactedFields)
	return &Redactor{Policy: p, Cipher: c}
}

// normalizeFloor merges DefaultRedactedFields with the tenant override,
// lower-cases the lot, dedupes, and returns sorted output for
// deterministic behaviour in tests.
func normalizeFloor(extra []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(DefaultRedactedFields)+len(extra))
	for _, f := range DefaultRedactedFields {
		k := strings.ToLower(strings.TrimSpace(f))
		if k == "" {
			continue
		}
		if _, ok := seen[k]; ok {
			continue
		}
		seen[k] = struct{}{}
		out = append(out, k)
	}
	for _, f := range extra {
		k := strings.ToLower(strings.TrimSpace(f))
		if k == "" {
			continue
		}
		if _, ok := seen[k]; ok {
			continue
		}
		seen[k] = struct{}{}
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Redact walks metadata and produces a sanitized copy. The original
// map is not mutated; the caller owns both inputs and outputs.
//
// On any error from the Encrypt phase (cipher unconfigured, etc.) the
// rule degrades to ActionMask so audit writes never fail closed on a
// redaction misconfig.
func (r *Redactor) Redact(ctx context.Context, metadata map[string]any) (Result, error) {
	res := Result{
		Redacted:       map[string]any{},
		Hashes:         map[string]string{},
		RedactedFields: []string{},
	}
	if metadata == nil {
		return res, nil
	}

	// Build a fast-lookup table of JSONPath -> action so the walk can
	// match in O(1) per visit instead of scanning the rule list per
	// node.
	rules := map[string]RuleAction{}
	for _, rule := range r.Policy.JSONPathRules {
		p := normalizePath(rule.Path)
		if p == "" {
			continue
		}
		rules[p] = rule.Action
	}

	// Deep-copy the metadata before mutation so the caller's map is
	// pristine if it shares the reference with anyone else.
	cloned := deepCopyJSON(metadata).(map[string]any)

	encMap := map[string]any{}
	r.walk("$", cloned, rules, &res, encMap, ctx)

	if len(encMap) > 0 {
		res.Encrypted = encMap
	}
	res.Redacted = cloned
	sort.Strings(res.RedactedFields)
	return res, nil
}

// walk recursively visits every node, applying default-field-name
// matches and JSONPath rules. cur is the current path (in $.a.b
// notation); node is the current value (always map[string]any or
// []any when we recurse from a container).
func (r *Redactor) walk(cur string, node any, rules map[string]RuleAction, res *Result, enc map[string]any, ctx context.Context) {
	switch v := node.(type) {
	case map[string]any:
		for k, child := range v {
			childPath := cur + "." + k
			// JSONPath rule wins over the default-field-name match.
			if act, ok := rules[childPath]; ok {
				v[k] = r.applyAction(childPath, child, act, res, enc, ctx)
				continue
			}
			if isSensitiveKey(k, r.Policy.DefaultRedactedFields) {
				v[k] = RedactSentinel
				res.RedactedFields = append(res.RedactedFields, childPath)
				continue
			}
			r.walk(childPath, child, rules, res, enc, ctx)
		}
	case []any:
		for i, child := range v {
			childPath := fmt.Sprintf("%s[%d]", cur, i)
			if act, ok := rules[childPath]; ok {
				v[i] = r.applyAction(childPath, child, act, res, enc, ctx)
				continue
			}
			r.walk(childPath, child, rules, res, enc, ctx)
		}
	default:
		// Scalar — nothing to recurse into. Default-name match was
		// already handled by the parent.
	}
}

// applyAction performs the redaction for a single matched rule and
// returns the value that should replace the in-place node.
func (r *Redactor) applyAction(path string, value any, action RuleAction, res *Result, enc map[string]any, ctx context.Context) any {
	res.RedactedFields = append(res.RedactedFields, path)
	switch action {
	case ActionMask:
		return RedactSentinel
	case ActionHash:
		res.Hashes[path] = hashValue(value)
		return RedactSentinel
	case ActionEncrypt:
		// Store the original value under the path in the encrypted
		// side-map. The caller serialises + encrypts this map as a
		// whole and writes it into metadata_encrypted. Failure-soft:
		// if no cipher is configured the rule degrades to a plain mask.
		if r.Cipher == nil {
			return RedactSentinel
		}
		enc[path] = value
		return RedactSentinel
	default:
		// Unknown action: treat as mask (fail-closed).
		return RedactSentinel
	}
}

// EncryptSideBlob serialises the side-map produced by Redact, encrypts
// it with the configured cipher, and returns the bytea blob that goes
// into audit_log.metadata_encrypted. Returns (nil, nil) when there's
// nothing to encrypt (no ActionEncrypt rules matched).
func (r *Redactor) EncryptSideBlob(ctx context.Context, encMap map[string]any) ([]byte, error) {
	if len(encMap) == 0 || r.Cipher == nil {
		return nil, nil
	}
	blob, err := json.Marshal(encMap)
	if err != nil {
		return nil, fmt.Errorf("marshal encrypted side-blob: %w", err)
	}
	ct, err := r.Cipher.Encrypt(ctx, blob)
	if err != nil {
		return nil, fmt.Errorf("encrypt audit metadata: %w", err)
	}
	return ct, nil
}

// DecryptSideBlob is the read-side counterpart: takes the bytea blob,
// decrypts it with the configured cipher, and returns the original
// map of path -> value. Used by the Unmask handler.
func DecryptSideBlob(ctx context.Context, c Cipher, blob []byte) (map[string]any, error) {
	if len(blob) == 0 {
		return map[string]any{}, nil
	}
	if c == nil {
		return nil, fmt.Errorf("envelope cipher not configured")
	}
	plaintext, err := c.Decrypt(ctx, blob, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt audit metadata: %w", err)
	}
	out := map[string]any{}
	if err := json.Unmarshal(plaintext, &out); err != nil {
		return nil, fmt.Errorf("unmarshal audit metadata: %w", err)
	}
	return out, nil
}

// MergeDecrypted applies the decrypted path -> value side-map back
// onto a redacted metadata payload. Used by the Unmask handler to
// hand the caller a fully-restored view of the original metadata.
//
// Mutates dst in place. Paths use the "$.a.b" / "$.a[0].b" notation
// produced by Redact.
func MergeDecrypted(dst map[string]any, side map[string]any) {
	for path, value := range side {
		setPath(dst, path, value)
	}
}

// isSensitiveKey reports whether the JSON object key looks like a
// known-sensitive field. The match is case-insensitive substring so
// "userPassword" matches "password" too.
func isSensitiveKey(key string, floor []string) bool {
	lk := strings.ToLower(key)
	for _, sensitive := range floor {
		if strings.Contains(lk, sensitive) {
			return true
		}
	}
	return false
}

// normalizePath canonicalises a user-supplied JSONPath. Strips a
// leading "$" if absent, normalises whitespace.
func normalizePath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if !strings.HasPrefix(p, "$") {
		p = "$." + strings.TrimPrefix(p, ".")
	}
	return p
}

// hashValue returns the lowercase hex SHA-256 of the JSON encoding of
// v. JSON encoding (not String()) means {"foo":1} and {"foo":1} hash
// identically regardless of map iteration order.
func hashValue(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		// Fall back to a string repr — better a hash of something than
		// nothing, but should be impossible for JSON-clean values.
		b = []byte(fmt.Sprintf("%v", v))
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// deepCopyJSON walks a JSON-decoded value and returns a copy that
// shares no map/slice references with the input. Necessary because
// the redactor mutates maps in place and the caller may still hold a
// reference to the original (e.g. for the audit-write metadata blob).
func deepCopyJSON(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			out[k] = deepCopyJSON(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = deepCopyJSON(val)
		}
		return out
	default:
		return v
	}
}

// setPath writes value into m at the dotted path. Best-effort: silently
// drops on path mismatch (e.g. unmask of a payload whose structure has
// changed). Used only on the read side where a degraded decrypted view
// is still better than a 500.
func setPath(m map[string]any, path string, value any) {
	// Strip leading "$."
	p := strings.TrimPrefix(path, "$.")
	if p == "" {
		return
	}
	parts := splitPath(p)
	cur := any(m)
	for i, part := range parts {
		last := i == len(parts)-1
		idx, isIdx := arrayIndex(part)
		switch container := cur.(type) {
		case map[string]any:
			if isIdx {
				return
			}
			if last {
				container[part] = value
				return
			}
			next, ok := container[part]
			if !ok || next == nil {
				return
			}
			cur = next
		case []any:
			if !isIdx || idx < 0 || idx >= len(container) {
				return
			}
			if last {
				container[idx] = value
				return
			}
			cur = container[idx]
		default:
			return
		}
	}
}

// splitPath breaks "a.b[0].c" into ["a","b","[0]","c"]. Naive because
// our paths are always machine-generated; we don't accept arbitrary
// JSONPath grammar.
func splitPath(p string) []string {
	out := []string{}
	cur := strings.Builder{}
	for _, r := range p {
		switch r {
		case '.':
			if cur.Len() > 0 {
				out = append(out, cur.String())
				cur.Reset()
			}
		case '[':
			if cur.Len() > 0 {
				out = append(out, cur.String())
				cur.Reset()
			}
			cur.WriteRune(r)
		case ']':
			cur.WriteRune(r)
			out = append(out, cur.String())
			cur.Reset()
		default:
			cur.WriteRune(r)
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

// arrayIndex extracts the integer from "[N]"; returns (idx, true) on
// success or (-1, false) otherwise.
func arrayIndex(part string) (int, bool) {
	if !strings.HasPrefix(part, "[") || !strings.HasSuffix(part, "]") {
		return -1, false
	}
	inner := part[1 : len(part)-1]
	var n int
	if _, err := fmt.Sscanf(inner, "%d", &n); err != nil {
		return -1, false
	}
	return n, true
}
