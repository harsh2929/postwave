package archive

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// tenant_public_settings was unwritable from migration 0152 until 1990.
//
// 0071 created a RESTRICTIVE `tenant_isolation` policy FOR ALL, which also
// constrained SELECT and so blocked the anonymous archive_slug -> tenant_id
// lookup the PERMISSIVE public-lookup policy exists to allow. 0152 fixed reads
// by splitting it into three write-only RESTRICTIVE policies -- and left the
// table with no PERMISSIVE policy covering writes at all.
//
// Postgres requires a row to satisfy at least one PERMISSIVE policy AND every
// RESTRICTIVE one. Restrictive policies only subtract. With an empty permissive
// set, every write is denied however correct the tenant GUC is, which is why
// PUT /api/v1/admin/archive/tenant-settings answered 500 with "new row violates
// row-level security policy" while app.tenant_id held exactly the tenant_id
// being written.
//
// Both halves are asserted here: the write works, and it is still confined to
// one tenant.
//
// BE PRECISE ABOUT WHAT THE SECOND HALF PROVES. Mutation-testing showed the
// isolation assertions below still pass if 1990's permissive policy is widened
// to `USING (true) WITH CHECK (true)` -- because the three RESTRICTIVE policies
// from 0152 are what actually confine the write, and a permissive policy cannot
// widen past them. So these tests do NOT guard 1990's predicate; they guard the
// OBSERVABLE guarantee, and they would catch the restrictive policies being
// dropped or loosened, which is the change that could really open a hole.
//
// Loosening EITHER layer alone is also invisible, for the same reason in
// reverse: 1990's WITH CHECK still confines the write when 0152's is widened,
// and 0152's still confines it when 1990's is. Both had to be widened together
// before these two tests went red -- which is what was actually run, with
// -count=1, because Go's test cache had happily replayed a stale pass over the
// first attempt.
//
// So: real defence in depth, and assertions that fail only when all of it is
// gone. Worth stating rather than implying. A comment claiming these catch
// `USING (true)` would be false, and a false claim about what a test covers is
// worse than no claim at all.

func newArchiveSettingsPool(t *testing.T) *db.Pool {
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

func TestTenantSettingsCanActuallyBeWritten(t *testing.T) {
	pool := newArchiveSettingsPool(t)
	repo := &Repo{Pool: pool}
	ctx := context.Background()
	tenantID := seedArchiveTenant(t, ctx, pool)

	title := "Field Notes"
	tagline := "monthly"
	out, err := repo.UpsertTenantSettings(ctx, tenantID, TenantSettingsInput{
		ArchiveTitle: &title, ArchiveTagline: &tagline,
	})
	if err != nil {
		t.Fatalf("writing archive settings must succeed: %v", err)
	}
	if out.ArchiveTitle != title || out.ArchiveTagline != tagline {
		t.Fatalf("write did not round-trip: %+v", out)
	}

	// And it must be durable, not just echoed back from the input.
	read, err := repo.GetTenantSettings(ctx, tenantID)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if read.ArchiveTitle != title {
		t.Fatalf("value did not persist: got %q want %q", read.ArchiveTitle, title)
	}
}

func TestTenantSettingsWriteStillRefusesAnotherTenant(t *testing.T) {
	// The half that matters. `USING (true)` would restore the write and pass
	// the test above while making every workspace's archive branding writable
	// by every other workspace.
	pool := newArchiveSettingsPool(t)
	ctx := context.Background()
	victim := seedArchiveTenant(t, ctx, pool)
	attacker := seedArchiveTenant(t, ctx, pool)

	// Bind the connection to the ATTACKER, then try to write the VICTIM's row.
	_, err := pool.Exec(ctx,
		`with g as (select set_config('app.tenant_id', $1, true))
		 insert into tenant_public_settings (tenant_id, updated_at)
		 select $2::uuid, now() from g`,
		attacker, victim)
	if err == nil {
		t.Fatal("a tenant must not be able to write another tenant's archive settings")
	}
	if !strings.Contains(err.Error(), "row-level security") {
		t.Fatalf("expected an RLS refusal, got: %v", err)
	}
}

func TestTenantSettingsWriteRefusesAnUnsetTenantGUC(t *testing.T) {
	// An unset GUC must not become a wildcard. NULLIF(...) is why this holds;
	// a bare cast would error instead, and a policy written without it would
	// behave differently here.
	pool := newArchiveSettingsPool(t)
	ctx := context.Background()
	tenantID := seedArchiveTenant(t, ctx, pool)

	_, err := pool.Exec(ctx,
		`with g as (select set_config('app.tenant_id', '', true))
		 insert into tenant_public_settings (tenant_id, updated_at)
		 select $1::uuid, now() from g`,
		tenantID)
	if err == nil {
		t.Fatal("an unset app.tenant_id must not permit a write")
	}
	if !strings.Contains(err.Error(), "row-level security") {
		t.Fatalf("expected an RLS refusal, got: %v", err)
	}
}
