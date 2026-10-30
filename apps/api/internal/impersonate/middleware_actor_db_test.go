// SPDX-License-Identifier: AGPL-3.0-only

package impersonate

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// An impersonated action must be audited as SUPPORT, not as the customer.
//
// The middleware swaps the tenant and marks the context, and its own comment
// said downstream audit middleware would "stamp actor_type=platform_operator +
// actor_label=<operator_email>". Nothing did: `FromContext` had zero callers
// repo-wide and `middleware.ActorFromContext` reads different keys entirely. So
// every action an operator took while impersonating went into the CUSTOMER'S
// audit log as an ordinary actor.
//
// That is the failure this test exists to prevent, and it is a trust failure
// rather than a cosmetic one. The tenant reads their own audit log and sees
// their account doing things nobody at their company did; the privileged access
// is neither attributable nor reviewable by the person it was exercised
// against, which is the entire purpose of bounding it with a reason, a TTL and
// a read-only default.
func TestAnImpersonatedRequestIsAuditedAsSupport(t *testing.T) {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping impersonation actor test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)

	const operator = "support.engineer@postwave.test"
	tenantID := seedImpersonationTenant(t, pool)
	token, sessionID := seedImpersonationSession(t, pool, tenantID, operator)
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM impersonation_sessions WHERE id = $1::uuid`, sessionID)
	})

	var (
		gotActorType  string
		gotActorLabel string
		gotTenant     string
	)
	handler := Middleware(pool)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		gotActorType, gotActorLabel = middleware.ActorFromContext(r.Context())
		if tenant, ok := middleware.TenantFromContext(r.Context()); ok {
			gotTenant = tenant.ID
		}
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/subscribers", nil)
	req.Header.Set(HeaderName, token)
	handler.ServeHTTP(httptest.NewRecorder(), req)

	// The tenant swap is the part that already worked; asserted so a future
	// change cannot trade one for the other.
	if gotTenant != tenantID {
		t.Fatalf("tenant = %q, want the impersonated tenant %q", gotTenant, tenantID)
	}
	if gotActorType != ActorType {
		t.Fatalf("actor type = %q, want %q — an impersonated action written under "+
			"any other actor lands in the customer's audit log as though they did it",
			gotActorType, ActorType)
	}
	if gotActorLabel != operator {
		t.Fatalf("actor label = %q, want the operator's email %q — without it the row "+
			"says support was here and not WHICH engineer, so the access is bounded "+
			"but not attributable", gotActorLabel, operator)
	}
}

func seedImpersonationTenant(t *testing.T, pool *db.Pool) string {
	t.Helper()
	ctx := context.Background()
	id := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, id)
	if err != nil {
		t.Fatalf("open tenant seed tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'impersonation-actor-test', $2, 'studio')`,
		id, "imp-actor-"+id[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		c, err := db.WithTenant(bg, pool, id)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(bg) }()
		_, _ = c.Exec(bg, `DELETE FROM tenants WHERE id = $1::uuid`, id)
		_ = c.Commit(bg)
	})
	return id
}

// Seeds a live session the way Start does: the row stores only the sha256 of
// the token, so the test holds the plaintext and the database never sees it.
func seedImpersonationSession(t *testing.T, pool *db.Pool, tenantID, operator string) (token, sessionID string) {
	t.Helper()
	ctx := context.Background()
	token = uuid.NewString() + uuid.NewString()
	if err := pool.QueryRow(ctx, `
INSERT INTO impersonation_sessions
  (operator_email, target_tenant_id, token_sha256, token_prefix, scope, reason,
   started_at, expires_at)
VALUES ($1, $2::uuid, sha256($3::text::bytea), left($3::text, 8), 'read_only',
        'verifying audit attribution', now(), now() + interval '1 hour')
RETURNING id::text`, operator, tenantID, token).Scan(&sessionID); err != nil {
		t.Fatalf("seed impersonation session: %v", err)
	}
	return token, sessionID
}
