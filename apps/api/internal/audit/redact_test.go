// SPDX-License-Identifier: AGPL-3.0-only
//
// Redactor + envelope-blob round-trip tests for the PII redaction
// pipeline. These tests deliberately exercise the corner cases that
// have historically broken silent-default-deny code paths:
//
//   - case-insensitive substring match on the default-deny list
//   - JSONPath rule wins over the default-name match
//   - encrypted side-blob round-trips through the cipher
//   - deeply-nested paths + array indices
//   - nil + empty metadata don't crash
//   - degraded mask when the cipher is nil (fail-soft)

package audit

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type redactAuditTxStub struct {
	pgx.Tx
	execCount int
}

func (s *redactAuditTxStub) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	s.execCount++
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func TestWireDBPropagatesPolicyLookupFailure(t *testing.T) {
	want := errors.New("policy database unavailable")
	unwire := WireDB(policyLoaderFunc(func(context.Context, string) (Policy, error) {
		return Policy{}, want
	}), nil)
	t.Cleanup(unwire)
	tx := &redactAuditTxStub{}
	err := db.Audit(context.Background(), tx, db.AuditMeta{TenantID: "tenant-1"},
		"subscriber.update", "subscriber", "subscriber-1", map[string]any{"email": "private@example.com"})
	if !errors.Is(err, want) {
		t.Fatalf("redactor error = %v, want wrapped %v", err, want)
	}
	if tx.execCount != 0 {
		t.Fatalf("audit insert calls = %d, want zero", tx.execCount)
	}
}

// fakeCipher is a deterministic Cipher used to verify the encrypt
// pipeline without invoking the real envelope code. The base64 encode
// is reversible so DecryptSideBlob round-trips work.
type fakeCipher struct {
	encErr error
	decErr error
}

func (f *fakeCipher) Encrypt(_ context.Context, plaintext []byte) ([]byte, error) {
	if f.encErr != nil {
		return nil, f.encErr
	}
	enc := base64.StdEncoding.EncodeToString(plaintext)
	return []byte(enc), nil
}

func (f *fakeCipher) Decrypt(_ context.Context, blob, _ []byte) ([]byte, error) {
	if f.decErr != nil {
		return nil, f.decErr
	}
	return base64.StdEncoding.DecodeString(string(blob))
}

func TestRedact_DefaultSensitiveFieldsMasked(t *testing.T) {
	r := NewRedactor(Policy{}, nil)
	ctx := context.Background()
	in := map[string]any{
		"email":    "alice@example.com",
		"password": "hunter2",
		"api_key":  "sk_live_xxx",
		"profile": map[string]any{
			"ssn":   "123-45-6789",
			"phone": "555-0100",
		},
	}
	res, err := r.Redact(ctx, in)
	if err != nil {
		t.Fatalf("Redact: %v", err)
	}
	if res.Redacted["email"] != "alice@example.com" {
		t.Errorf("safe field email got mutated: %#v", res.Redacted["email"])
	}
	if res.Redacted["password"] != RedactSentinel {
		t.Errorf("password not redacted: %#v", res.Redacted["password"])
	}
	if res.Redacted["api_key"] != RedactSentinel {
		t.Errorf("api_key not redacted: %#v", res.Redacted["api_key"])
	}
	prof, ok := res.Redacted["profile"].(map[string]any)
	if !ok {
		t.Fatalf("profile missing: %#v", res.Redacted["profile"])
	}
	if prof["ssn"] != RedactSentinel {
		t.Errorf("nested ssn not redacted: %#v", prof["ssn"])
	}
	if prof["phone"] != "555-0100" {
		t.Errorf("phone got mutated: %#v", prof["phone"])
	}
	if len(res.RedactedFields) != 3 {
		t.Errorf("expected 3 redacted fields, got %d: %v",
			len(res.RedactedFields), res.RedactedFields)
	}
}

func TestRedact_CaseInsensitiveSubstring(t *testing.T) {
	r := NewRedactor(Policy{}, nil)
	in := map[string]any{
		"UserPassword":    "x",
		"ApiKeyHeader":    "y",
		"creditCardLast4": "1234",
	}
	res, _ := r.Redact(context.Background(), in)
	for _, k := range []string{"UserPassword", "ApiKeyHeader", "creditCardLast4"} {
		if res.Redacted[k] != RedactSentinel {
			t.Errorf("%s not redacted: %#v", k, res.Redacted[k])
		}
	}
}

func TestRedact_JSONPathMaskAction(t *testing.T) {
	r := NewRedactor(Policy{
		JSONPathRules: []Rule{
			{Path: "$.payment.card_number", Action: ActionMask},
		},
	}, nil)
	in := map[string]any{
		"payment": map[string]any{
			"card_number": "4111-1111-1111-1111",
			"holder":      "Alice",
		},
	}
	res, _ := r.Redact(context.Background(), in)
	pay := res.Redacted["payment"].(map[string]any)
	if pay["card_number"] != RedactSentinel {
		t.Errorf("card_number not masked: %#v", pay["card_number"])
	}
	if pay["holder"] != "Alice" {
		t.Errorf("holder got mutated: %#v", pay["holder"])
	}
}

func TestRedact_JSONPathHashAction(t *testing.T) {
	r := NewRedactor(Policy{
		JSONPathRules: []Rule{
			{Path: "$.contact.email", Action: ActionHash},
		},
	}, nil)
	in := map[string]any{
		"contact": map[string]any{
			"email": "bob@example.com",
		},
	}
	res, _ := r.Redact(context.Background(), in)
	ct := res.Redacted["contact"].(map[string]any)
	if ct["email"] != RedactSentinel {
		t.Errorf("email not hashed-out: %#v", ct["email"])
	}
	h, ok := res.Hashes["$.contact.email"]
	if !ok || len(h) != 64 {
		t.Errorf("expected sha256 hex hash, got: %q", h)
	}
	// Re-hash the same value and confirm determinism.
	if hashValue("bob@example.com") != h {
		t.Errorf("hash not deterministic: %q vs %q", hashValue("bob@example.com"), h)
	}
}

func TestRedact_EncryptRoundTrip(t *testing.T) {
	cipher := &fakeCipher{}
	r := NewRedactor(Policy{
		JSONPathRules: []Rule{
			{Path: "$.dob", Action: ActionEncrypt},
		},
	}, cipher)
	ctx := context.Background()
	in := map[string]any{"dob": "1990-01-01", "name": "Alice"}
	res, err := r.Redact(ctx, in)
	if err != nil {
		t.Fatalf("Redact: %v", err)
	}
	// in-place value should be sentinel; original lives in the
	// encrypted side-map.
	// Note: "dob" is also in the default floor so this also exercises
	// the JSONPath-wins-over-floor branch.
	if res.Redacted["dob"] != RedactSentinel {
		t.Errorf("dob in-place not sentinel: %#v", res.Redacted["dob"])
	}
	if res.Encrypted["$.dob"] != "1990-01-01" {
		t.Errorf("dob not captured in side-map: %#v", res.Encrypted)
	}
	blob, err := r.EncryptSideBlob(ctx, res.Encrypted)
	if err != nil {
		t.Fatalf("EncryptSideBlob: %v", err)
	}
	if len(blob) == 0 {
		t.Fatal("expected non-empty blob")
	}
	// Round-trip decrypt + merge restores the original.
	side, err := DecryptSideBlob(ctx, cipher, blob)
	if err != nil {
		t.Fatalf("DecryptSideBlob: %v", err)
	}
	merged := map[string]any{}
	for k, v := range res.Redacted {
		merged[k] = v
	}
	MergeDecrypted(merged, side)
	if merged["dob"] != "1990-01-01" {
		t.Errorf("merge did not restore dob: %#v", merged["dob"])
	}
}

func TestRedact_EncryptDegradesToMaskWithoutCipher(t *testing.T) {
	r := NewRedactor(Policy{
		JSONPathRules: []Rule{
			{Path: "$.dob", Action: ActionEncrypt},
		},
	}, nil) // no cipher
	res, _ := r.Redact(context.Background(), map[string]any{"dob": "1990-01-01"})
	if res.Redacted["dob"] != RedactSentinel {
		t.Errorf("dob should be masked on missing cipher: %#v", res.Redacted["dob"])
	}
	if len(res.Encrypted) != 0 {
		t.Errorf("expected empty encrypted map, got %#v", res.Encrypted)
	}
}

func TestRedact_NilMetadataNoCrash(t *testing.T) {
	r := NewRedactor(Policy{}, nil)
	res, err := r.Redact(context.Background(), nil)
	if err != nil {
		t.Fatalf("Redact(nil): %v", err)
	}
	if len(res.RedactedFields) != 0 {
		t.Errorf("nil metadata should produce no redactions")
	}
}

func TestRedact_OriginalMetadataNotMutated(t *testing.T) {
	r := NewRedactor(Policy{}, nil)
	in := map[string]any{
		"password": "hunter2",
		"profile":  map[string]any{"ssn": "123"},
	}
	_, _ = r.Redact(context.Background(), in)
	if in["password"] != "hunter2" {
		t.Errorf("original mutated: %#v", in)
	}
	prof := in["profile"].(map[string]any)
	if prof["ssn"] != "123" {
		t.Errorf("original nested mutated: %#v", prof)
	}
}

func TestRedact_ArrayPathHandled(t *testing.T) {
	r := NewRedactor(Policy{
		JSONPathRules: []Rule{
			{Path: "$.cards[0].number", Action: ActionMask},
		},
	}, nil)
	in := map[string]any{
		"cards": []any{
			map[string]any{"number": "4111", "label": "primary"},
			map[string]any{"number": "5500", "label": "backup"},
		},
	}
	res, _ := r.Redact(context.Background(), in)
	cards := res.Redacted["cards"].([]any)
	first := cards[0].(map[string]any)
	if first["number"] != RedactSentinel {
		t.Errorf("cards[0].number not masked: %#v", first["number"])
	}
	second := cards[1].(map[string]any)
	if second["number"] != "5500" {
		t.Errorf("cards[1].number wrongly mutated: %#v", second["number"])
	}
}

func TestNormalizeFloorAddsExtrasButKeepsDefaults(t *testing.T) {
	got := normalizeFloor([]string{"phone", "PASSWORD", " "})
	// Must contain every DefaultRedactedFields entry, lowercased.
	defaults := map[string]bool{}
	for _, d := range DefaultRedactedFields {
		defaults[d] = false
	}
	for _, g := range got {
		if _, ok := defaults[g]; ok {
			defaults[g] = true
		}
	}
	for d, present := range defaults {
		if !present {
			t.Errorf("default %q dropped from floor: %v", d, got)
		}
	}
	// Extras must be present, lowercased.
	found := false
	for _, g := range got {
		if g == "phone" {
			found = true
		}
	}
	if !found {
		t.Errorf("extra 'phone' missing: %v", got)
	}
}

func TestNormalizePath(t *testing.T) {
	cases := map[string]string{
		"":          "",
		"$.a.b":     "$.a.b",
		"a.b":       "$.a.b",
		".a.b":      "$.a.b",
		"   $.x   ": "$.x",
	}
	for in, want := range cases {
		if got := normalizePath(in); got != want {
			t.Errorf("normalizePath(%q) = %q, want %q", in, got, want)
		}
	}
}
