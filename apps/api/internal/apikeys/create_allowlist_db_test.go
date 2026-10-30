package apikeys

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Minting an API key WITHOUT an IP allowlist is the ordinary case -- it is what
// every "Create key" form submits when the operator leaves the optional
// allowlist blank.
//
// CreateWithOptions names allowed_ips explicitly in its INSERT and passes
// opts.AllowedIPs straight through. An omitted JSON array decodes to a nil
// slice, a nil slice encodes as SQL NULL, and api_keys.allowed_ips is NOT NULL
// (migration 0046). The column's DEFAULT '{}' cannot save it: a default applies
// only when the column is left out of the statement, never when NULL is passed
// for it.
//
// So the ordinary case is a 500. Found by minting a key against the running
// server, not by reading the code -- and the handler logs nothing on this path,
// so the server offered no clue either.

func newAllowlistTestPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedTenant inserts a tenant THROUGH row-level security rather than around it.
// The tenants insert policy is `id = current_setting('app.tenant_id')`, so the
// GUC has to name the row being written. set_config's third argument makes the
// setting transaction-local, and a lone statement is its own transaction, so
// the CTE form sets and uses it without leaking onto a pooled connection.
func seedTenantUser(t *testing.T, pool *db.Pool, tenantID, name string) string {
	t.Helper()
	if _, err := pool.Exec(context.Background(),
		`with g as (select set_config('app.tenant_id', $1, true))
		 insert into tenants (id, name, slug, tier)
		 select $1::uuid, $2, $3, 'studio' from g
		 on conflict do nothing`,
		tenantID, name, name+"-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	userID := uuid.NewString()
	if _, err := pool.Exec(context.Background(),
		`with g as (select set_config('app.tenant_id', $1, true))
		 insert into users (id, tenant_id, email, role, status, auth_provider)
		 select $2::uuid, $1::uuid, $3, 'owner', 'active', 'password' from g
		 on conflict do nothing`,
		tenantID, userID, name+"-"+userID[:8]+"@example.test"); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	return userID
}

func TestCreateWithOptionsAcceptsNoAllowlist(t *testing.T) {
	pool := newAllowlistTestPool(t)
	repo := &Repo{Pool: pool, Pepper: []byte("test-pepper")}
	ctx := context.Background()
	tenantID := uuid.NewString()
	userID := seedTenantUser(t, pool, tenantID, "allowlist-test")

	plaintext, _, err := NewKey()
	if err != nil {
		t.Fatalf("NewKey: %v", err)
	}
	// AllowedIPs deliberately absent, UserID deliberately PRESENT.
	//
	// UserID is what makes this the real case. CreateWithOptions short-circuits
	// to the 5-arg Create when every option is zero, and that statement omits
	// allowed_ips so the column DEFAULT applies. A bare CreateOptions{} therefore
	// tests the branch the handler never takes -- which is exactly how the first
	// version of this test passed against genuinely broken code.
	//
	// The handler always sets UserID from the session principal, so a signed-in
	// operator creating a key without an allowlist takes the long form every
	// time.
	k, err := repo.CreateWithOptions(ctx, tenantID, "no-allowlist", plaintext,
		[]Scope{ScopeAdmin}, CreateOptions{UserID: userID})
	if err != nil {
		t.Fatalf("minting a key with no IP allowlist must succeed: %v", err)
	}
	if k == nil {
		t.Fatal("expected a key back")
	}
	if len(k.AllowedIPs) != 0 {
		t.Fatalf("no allowlist must mean unrestricted, got %v", k.AllowedIPs)
	}
}

func TestCreateWithOptionsStillHonoursAnExplicitAllowlist(t *testing.T) {
	// The fix must not quietly discard a real allowlist -- that would turn a
	// 500 into a silent security downgrade.
	pool := newAllowlistTestPool(t)
	repo := &Repo{Pool: pool, Pepper: []byte("test-pepper")}
	ctx := context.Background()
	tenantID := uuid.NewString()
	_ = seedTenantUser(t, pool, tenantID, "allowlist-test-2")
	plaintext, _, err := NewKey()
	if err != nil {
		t.Fatalf("NewKey: %v", err)
	}
	k, err := repo.CreateWithOptions(ctx, tenantID, "with-allowlist", plaintext,
		[]Scope{ScopeAdmin}, CreateOptions{AllowedIPs: []string{"203.0.113.0/24"}})
	if err != nil {
		t.Fatalf("explicit allowlist must still work: %v", err)
	}
	if len(k.AllowedIPs) != 1 || !strings.HasPrefix(k.AllowedIPs[0], "203.0.113.0") {
		t.Fatalf("allowlist was not persisted, got %v", k.AllowedIPs)
	}
}
