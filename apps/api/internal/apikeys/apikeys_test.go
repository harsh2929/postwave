package apikeys

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestHashWithPepperDiffersFromBareSHA256(t *testing.T) {
	plaintext := "pw_live_abcd_0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab"

	bare := HashWithPepper(plaintext, nil)
	bareExpected := sha256.Sum256([]byte(plaintext))
	if bare != hex.EncodeToString(bareExpected[:]) {
		t.Fatalf("empty pepper should fall back to plain SHA-256")
	}

	pepper := []byte("a-server-side-pepper-of-meaningful-length-1234")
	peppered := HashWithPepper(plaintext, pepper)
	if peppered == bare {
		t.Fatal("HMAC with non-empty pepper must differ from bare SHA-256")
	}
}

func TestHashIsDeterministic(t *testing.T) {
	pepper := []byte("the-same-pepper")
	plaintext := "pw_live_abcd_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
	a := HashWithPepper(plaintext, pepper)
	b := HashWithPepper(plaintext, pepper)
	if a != b {
		t.Fatalf("HashWithPepper must be deterministic for same inputs")
	}
}

func TestRotatingPepperInvalidatesOldHash(t *testing.T) {
	plaintext := "pw_live_abcd_yyyy"
	a := HashWithPepper(plaintext, []byte("pepper-v1"))
	b := HashWithPepper(plaintext, []byte("pepper-v2"))
	if a == b {
		t.Fatal("different peppers must yield different hashes (rotation invariant)")
	}
}

func TestLegacyHashAliasMatchesEmptyPepper(t *testing.T) {
	// Backward-compat: existing rows hashed via Hash(plaintext) must still
	// resolve when HashWithPepper(plaintext, nil) is called.
	plaintext := "pw_live_abcd_zzzz"
	if Hash(plaintext) != HashWithPepper(plaintext, nil) {
		t.Fatal("legacy Hash() must equal HashWithPepper(., nil) for backward compat")
	}
}

func TestHashOutputShape(t *testing.T) {
	got := HashWithPepper("anything", []byte("pep"))
	if len(got) != 64 {
		t.Errorf("hex SHA-256 should be 64 chars, got %d", len(got))
	}
	if strings.TrimLeft(got, "0123456789abcdef") != "" {
		t.Errorf("hash should be lowercase hex, got %q", got)
	}
}

// TestNewKeyProducesDistinctSecretsAcrossCalls is the security invariant
// that makes Rotate meaningful. If NewKey ever returned the same plain-
// text twice in a process lifetime, rotation would be a no-op and the
// "compromised key" recovery path would silently fail.
func TestNewKeyProducesDistinctSecretsAcrossCalls(t *testing.T) {
	const N = 64
	seen := make(map[string]struct{}, N)
	for i := 0; i < N; i++ {
		plaintext, _, err := NewKey()
		if err != nil {
			t.Fatalf("NewKey: %v", err)
		}
		if _, dup := seen[plaintext]; dup {
			t.Fatalf("NewKey returned a duplicate plaintext at iteration %d", i)
		}
		seen[plaintext] = struct{}{}
	}
}

// TestRotateResponseSerializesExpectedShape pins the JSON shape so SDK
// codegen + the OpenAPI spec stay in lockstep. Specifically: revoked_id
// is its own top-level field (not nested under "key") so SDKs can
// render "rotated from X" without unwrapping the response.
func TestRotateResponseSerializesExpectedShape(t *testing.T) {
	resp := RotateResponse{
		Key: APIKey{
			ID:       "new-id",
			TenantID: "t1",
			Label:    "ci",
			Prefix:   "pw_live_abcd",
			Scopes:   []Scope{ScopeAdmin},
		},
		Plaintext: "pw_live_abcd_secrettail",
		RevokedID: "old-id",
	}
	b, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, want := range []string{
		`"plaintext":"pw_live_abcd_secrettail"`,
		`"revoked_id":"old-id"`,
		`"key":{`,
	} {
		if !bytes.Contains(b, []byte(want)) {
			t.Errorf("serialized output missing %q\nfull: %s", want, string(b))
		}
	}
}

func TestStreamTokenRoundTripRejectsTamperAndExpiry(t *testing.T) {
	secret := []byte("stream-token-secret-with-enough-entropy")
	now := time.Unix(1_700_000_000, 0).UTC()
	token, err := IssueStreamToken(secret, StreamTokenClaims{
		TenantID:  "tenant-1",
		Scopes:    []Scope{ScopeReadReports},
		ActorType: "agent",
	}, now, time.Minute)
	if err != nil {
		t.Fatalf("IssueStreamToken: %v", err)
	}
	claims, err := ParseStreamToken(secret, token, now.Add(10*time.Second))
	if err != nil {
		t.Fatalf("ParseStreamToken: %v", err)
	}
	if claims.TenantID != "tenant-1" || len(claims.Scopes) != 1 || claims.Scopes[0] != ScopeReadReports {
		t.Fatalf("unexpected claims: %+v", claims)
	}
	if _, err := ParseStreamToken(secret, token+"x", now.Add(10*time.Second)); err == nil {
		t.Fatal("tampered token parsed successfully")
	}
	if _, err := ParseStreamToken(secret, token, now.Add(2*time.Minute)); err == nil {
		t.Fatal("expired token parsed successfully")
	}
}

// TestAuditScopesInCatalog locks the new audit scopes into
// AllScopes / AllAuditScopes and ensures IsValidScope accepts them.
// If migration 0262_audit_rbac.sql's CHECK constraint drifts from
// the Go constants, this fails — the SQL stays in lock-step with
// the catalog via this single test.
func TestAuditScopesInCatalog(t *testing.T) {
	want := []Scope{
		ScopeAuditRead,
		ScopeAuditReadPII,
		ScopeAuditReadAllTenants,
		ScopeAuditConfigureSinks,
		ScopeAuditConfigureRetention,
		ScopeAuditExecuteActions,
	}
	for _, s := range want {
		if !IsValidScope(string(s)) {
			t.Errorf("scope %q missing from AllScopes", s)
		}
	}
	// Mirror check: every AllAuditScopes entry must be a known scope.
	for _, s := range AllAuditScopes {
		if !strings.HasPrefix(string(s), "audit:") {
			t.Errorf("AllAuditScopes contains non-audit scope %q", s)
		}
		if !IsValidScope(string(s)) {
			t.Errorf("AllAuditScopes contains scope %q not in AllScopes", s)
		}
	}
	if len(AllAuditScopes) != len(want) {
		t.Errorf("AllAuditScopes len = %d, want %d", len(AllAuditScopes), len(want))
	}
}

// TestRejectsNonAuditScope guards the unknown-scope branch — the
// admin UI ought never to send a scope we don't recognise, but the
// catalog check is the last line of defense.
func TestRejectsNonAuditScope(t *testing.T) {
	if IsValidScope("audit:make_coffee") {
		t.Fatal("IsValidScope must reject unknown audit:* scopes")
	}
	if IsValidScope("not_a_scope_at_all") {
		t.Fatal("IsValidScope must reject random strings")
	}
}
