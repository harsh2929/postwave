// SPDX-License-Identifier: AGPL-3.0-only

package experiments

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func identityPool(t *testing.T) (*pgxpool.Pool, string) {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping experiment identity test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	adminURL := os.Getenv("POSTWAVE_ADMIN_DATABASE_URL")
	if adminURL == "" {
		adminURL = url
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("admin connect: %v", err)
	}
	t.Cleanup(admin.Close)

	tenantID := uuid.NewString()
	tx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'experiment-identity-test', $2, 'studio')`, tenantID, "expid-"+tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	// The teardown runs under the same tenant binding as the seed. In CI
	// POSTWAVE_ADMIN_DATABASE_URL is unset, so "admin" is the application role,
	// and the tenants DELETE policy sees only the row whose id equals
	// app.tenant_id. The bare `admin.Exec` DELETE this replaces matched no row,
	// reported no error, and left every seeded tenant in the shared database.
	t.Cleanup(func() { deleteIdentityTestTenant(t, admin, tenantID) })
	return pool, tenantID
}

// A key the registry does not know is refused, not stored.
//
// An identity table accepting arbitrary keys accumulates rows for systems
// nobody can find, and then reports coverage that is not real — worse than
// reporting none, because it reads as progress.
func TestAnUnknownSystemKeyIsRefused(t *testing.T) {
	pool, tenantID := identityPool(t)
	repo := &IdentityRepo{Pool: pool}
	err := repo.Register(context.Background(), tenantID, Identity{
		SystemKey: "not_a_real_system", ExternalID: "x1", Hypothesis: "…",
	})
	if !errors.Is(err, ErrUnknownSystem) {
		t.Fatalf("err = %v, want ErrUnknownSystem", err)
	}
}

// Every one of the nine the registry lists must be registrable, or the identity
// covers fewer systems than it claims.
func TestEveryRegisteredSystemCanRegisterAnIdentity(t *testing.T) {
	pool, tenantID := identityPool(t)
	repo := &IdentityRepo{Pool: pool}
	ctx := context.Background()
	for _, s := range Systems {
		if err := repo.Register(ctx, tenantID, Identity{
			SystemKey: s.Key, ExternalID: "ext-" + s.Key, Hypothesis: "h",
		}); err != nil {
			t.Fatalf("%s could not register: %v", s.Key, err)
		}
	}
	got, err := repo.List(ctx, tenantID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != len(Systems) {
		t.Fatalf("identities = %d, want %d — a registered system cannot record "+
			"what its experiments were for", len(got), len(Systems))
	}
}

// Re-registering to ADD a field must not erase one recorded earlier.
//
// The hypothesis is the field that cannot be reconstructed later: a metric can
// be inferred from the data and an owner from the audit log, but what somebody
// believed would happen exists only if they wrote it down. A partial update that
// silently blanked it would destroy the one fact this table exists to hold.
func TestRegisteringAgainDoesNotErasePreviouslyRecordedFields(t *testing.T) {
	pool, tenantID := identityPool(t)
	repo := &IdentityRepo{Pool: pool}
	ctx := context.Background()

	if err := repo.Register(ctx, tenantID, Identity{
		SystemKey: "campaign_ab", ExternalID: "e1",
		Hypothesis: "shorter subject lines lift opens",
	}); err != nil {
		t.Fatalf("first register: %v", err)
	}
	// A later call that only supplies a stopping policy.
	if err := repo.Register(ctx, tenantID, Identity{
		SystemKey: "campaign_ab", ExternalID: "e1",
		StoppingPolicy: "fixed horizon, 14 days",
	}); err != nil {
		t.Fatalf("second register: %v", err)
	}

	got, err := repo.List(ctx, tenantID)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("identities = %d, want 1 (upsert, not insert)", len(got))
	}
	if got[0].Hypothesis == "" {
		t.Fatal("the hypothesis was erased by a later partial update — the one " +
			"field that cannot be reconstructed afterwards")
	}
	if got[0].StoppingPolicy == "" {
		t.Fatal("the stopping policy was not recorded")
	}
}

// Another tenant's identities are not readable.
func TestIdentitiesAreTenantScoped(t *testing.T) {
	pool, mine := identityPool(t)
	_, theirs := identityPool(t)
	repo := &IdentityRepo{Pool: pool}
	ctx := context.Background()
	if err := repo.Register(ctx, theirs, Identity{
		SystemKey: "flow_ab", ExternalID: "secret", Hypothesis: "theirs",
	}); err != nil {
		t.Fatalf("register: %v", err)
	}
	got, err := repo.List(ctx, mine)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, i := range got {
		if i.ExternalID == "secret" {
			t.Fatal("read another tenant's experiment identity")
		}
	}
	_ = db.Pool{}
}

// deleteIdentityTestTenant removes a tenant the test created, and everything
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
func deleteIdentityTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteIdentityTestTenantOnce(ctx, pool, tenantID)
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

func deleteIdentityTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
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
