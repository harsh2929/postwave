package privacy

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// GET /api/v1/privacy/dpa answered 500 on every call, for as long as it has
// existed, because loadControllerIdentity selected `workspace_settings.address`
// -- a column no migration has ever created. Postgres returned 42703, the
// handler swallowed it into a bare `controller_lookup` envelope with no logging
// at all, and the package's tests stayed green because none of them touched a
// database.
//
// A DPA is a compliance artifact. "Has never once been generated" is the worst
// state available to it, and the only reason nobody noticed is that the failure
// was silent on the server and generic on the wire.
//
// This test runs the real query against a real schema, which is the only thing
// that could have caught it: any mock of the row would have returned three
// happy strings.

func newDPATestPool(t *testing.T) *db.Pool {
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

func seedDPATenant(t *testing.T, pool *db.Pool, name string) string {
	t.Helper()
	tenantID := uuid.NewString()
	if _, err := pool.Exec(context.Background(),
		`with g as (select set_config('app.tenant_id', $1, true))
		 insert into tenants (id, name, slug, tier)
		 select $1::uuid, $2, $3, 'studio' from g
		 on conflict do nothing`,
		tenantID, name, name+"-"+tenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	return tenantID
}

func TestControllerIdentityQueryMatchesTheRealSchema(t *testing.T) {
	pool := newDPATestPool(t)
	tenantID := seedDPATenant(t, pool, "dpa-identity")
	deps := &DPADeps{Pool: pool}

	name, addr, err := deps.loadControllerIdentity(context.Background(), tenantID)
	if err != nil {
		t.Fatalf("the controller lookup must work against the real schema: %v", err)
	}
	if name == "" {
		t.Fatal("controller name must fall back to the tenant name")
	}
	// There is no stored controller address; empty is the honest answer and
	// renderDPA turns it into a visible placeholder.
	if addr != "" {
		t.Fatalf("no address is stored anywhere, so it must come back empty, got %q", addr)
	}
}

func TestDPAMetadataAnswers200AndNamesTheMissingAddress(t *testing.T) {
	pool := newDPATestPool(t)
	tenantID := seedDPATenant(t, pool, "dpa-metadata")
	deps := &DPADeps{Pool: pool}

	req := httptest.NewRequest(http.MethodGet, "/api/v1/privacy/dpa", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
	rec := httptest.NewRecorder()
	deps.Metadata(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "controller_lookup") {
		t.Fatalf("the lookup must not fail: %s", rec.Body.String())
	}
}

func TestTheRenderedDPAAsksForTheAddressRatherThanInventingOne(t *testing.T) {
	// The placeholder is the point. A DPA that silently omits the controller's
	// address reads as complete when it is not; one that says where to fill it
	// in cannot be mistaken for finished.
	deps := &DPADeps{}
	body := deps.renderDPA("Acme GmbH", "")
	if !strings.Contains(body, "please update in Workspace Settings") {
		t.Fatalf("an absent address must be visible in the document, not silent:\n%s", body[:400])
	}
}
