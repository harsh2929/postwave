// SPDX-License-Identifier: AGPL-3.0-only
//
// cli_auth_test.go — PKCE math (pure, RFC 7636 vector) + a DB-gated end-to-end
// of the authorize → token exchange against real handlers + grant store. The
// DB test skips without DATABASE_URL; the grant SQL was also hand-verified on
// PG16 (atomic one-shot consume).

package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func TestPKCEMatches_RFC7636Vector(t *testing.T) {
	// The canonical RFC 7636 Appendix B example.
	const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
	const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
	if !pkceMatches(verifier, challenge) {
		t.Fatal("RFC 7636 verifier/challenge vector must match")
	}
	if pkceMatches(verifier+"x", challenge) {
		t.Fatal("a wrong verifier must not match")
	}
	if pkceMatches(verifier, challenge+"x") {
		t.Fatal("a tampered challenge must not match")
	}
}

func cliAuthDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		url = os.Getenv("DATABASE_URL")
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set; skipping pg-backed cli-auth test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func cliUUID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand: %v", err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	s := hex.EncodeToString(b[:])
	return s[0:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:32]
}

func newPKCE(t *testing.T) (verifier, challenge string) {
	t.Helper()
	vb := make([]byte, 32)
	if _, err := rand.Read(vb); err != nil {
		t.Fatalf("rand: %v", err)
	}
	verifier = base64.RawURLEncoding.EncodeToString(vb)
	sum := sha256.Sum256([]byte(verifier))
	return verifier, base64.RawURLEncoding.EncodeToString(sum[:])
}

// TestCLIAuthFlow exercises the real authorize + token handlers end-to-end:
// consent (authorize) issues a one-time code, the CLI exchanges code+verifier
// for a minted key, a wrong verifier is rejected, and a code is strictly
// one-shot.
func TestCLIAuthFlow(t *testing.T) {
	pool := cliAuthDB(t)
	ctx := context.Background()
	tenantID := cliUUID(t)

	// Seed a tenant.
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	_, _ = tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID)
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid,$2,$2,'studio')`,
		tenantID, "cliauth-"+tenantID[:8]); err != nil {
		t.Fatalf("tenant: %v", err)
	}
	_ = tx.Commit(ctx)
	t.Cleanup(func() { deleteAuthTestTenant(t, pool, tenantID) })

	var minted int
	d := &Deps{
		Repo: &Repo{Pool: pool, Pepper: make([]byte, 32)},
		MeContextLookup: func(_ *http.Request) (MeContext, bool) {
			return MeContext{TenantID: tenantID, UserID: cliUUID(t), UserEmail: "dev@x.com", UserRole: "admin", MFASatisfied: true}, true
		},
		MintCLIKey: func(_ context.Context, tid, _ string, _ []string) (string, error) {
			minted++
			return "pw_live_MINTED_" + tid[:8], nil
		},
	}

	verifier, challenge := newPKCE(t)
	const state = "state-abcdef-123456"

	authorize := func() string {
		body, _ := json.Marshal(map[string]any{
			"state": state, "code_challenge": challenge, "challenge_method": "S256", "port": 8123,
		})
		r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/cli/authorize", strings.NewReader(string(body)))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		d.CLIAuthorize(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("authorize: want 200, got %d: %s", w.Code, w.Body.String())
		}
		var resp struct {
			Code string `json:"code"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &resp)
		if resp.Code == "" {
			t.Fatal("authorize returned no code")
		}
		return resp.Code
	}
	token := func(code, verifier, state string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{"code": code, "code_verifier": verifier, "state": state})
		r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/cli/token", strings.NewReader(string(body)))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		d.CLIToken(w, r)
		return w
	}

	// Happy path: authorize → exchange → minted key returned.
	code := authorize()
	w := token(code, verifier, state)
	if w.Code != http.StatusOK {
		t.Fatalf("token: want 200, got %d: %s", w.Code, w.Body.String())
	}
	var ok struct {
		APIKey   string `json:"api_key"`
		TenantID string `json:"tenant_id"`
		Email    string `json:"email"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &ok)
	if !strings.HasPrefix(ok.APIKey, "pw_live_MINTED_") || ok.TenantID != tenantID || ok.Email != "dev@x.com" {
		t.Fatalf("token response wrong: %+v", ok)
	}

	// Replay the same code → rejected (one-shot).
	if w := token(code, verifier, state); w.Code != http.StatusBadRequest {
		t.Fatalf("replay should be 400, got %d", w.Code)
	}

	// Fresh grant, wrong verifier → pkce_mismatch (and no key minted).
	mintedBefore := minted
	code2 := authorize()
	if w := token(code2, verifier+"WRONG", state); w.Code != http.StatusBadRequest {
		t.Fatalf("wrong verifier should be 400, got %d", w.Code)
	}
	if minted != mintedBefore {
		t.Fatal("a failed PKCE exchange must not mint a key")
	}

	// Fresh grant, wrong state → state_mismatch.
	code3 := authorize()
	if w := token(code3, verifier, "WRONG-STATE"); w.Code != http.StatusBadRequest {
		t.Fatalf("wrong state should be 400, got %d", w.Code)
	}
}

// deleteAuthTestTenant removes a tenant the test created, and everything
// that cascades from it, in a transaction bound to that tenant. The tenants
// DELETE policy sees only the row whose id equals app.tenant_id, so a DELETE
// issued without that binding matches nothing and reports no error.
//
// It retries the whole transaction when Postgres reports its shared lock table
// full (SQLSTATE 53200) or picks it as a deadlock victim (40P01). One tenant
// delete cascades through every foreign key that references tenants(id), about
// 735 at migration head, and holds a lock on each of those tables and their
// indexes until commit. So a few concurrent deletes from other packages sharing
// the database can briefly exhaust the lock table, and one can deadlock with
// another package's DDL on a shared table (the consent tracking test's
// CREATE/DROP TRIGGER on audit_log, for one). Both clear on their own. Any other
// failure, or a delete that removes no row, fails the test, so a leaked tenant
// cannot go unnoticed.
func deleteAuthTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteAuthTestTenantOnce(ctx, pool, tenantID)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "53200" || pgErr.Code == "40P01") && ctx.Err() == nil {
			t.Logf("cleanup of tenant %s: %s (SQLSTATE %s), retrying in %v", tenantID, pgErr.Message, pgErr.Code, wait)
			time.Sleep(wait)
			continue
		}
		if err != nil {
			t.Errorf("cleanup of tenant %s: %v", tenantID, err)
		} else if removed != 1 {
			t.Errorf("cleanup of tenant %s removed %d tenant rows, want 1", tenantID, removed)
		}
		return
	}
}

func deleteAuthTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}
