// SPDX-License-Identifier: AGPL-3.0-only
//
// membership_origin_db_test.go — who added a member, recorded truthfully.
//
// POST /api/v1/lists/{id}/subscribers serves two callers: the dashboard's
// Members tab (a session, i.e. a person) and a personal-access token (a
// program). Both were written as source 'api', so an operator's own add was
// attributed to the API in list growth and shown as "api" in the Members tab.
// The origin now comes from the request's auth method.

package lists

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// membershipRouter is the production list route table over pool.
func membershipRouter(pool *db.Pool) http.Handler {
	d := New("http://upstream.invalid", "u", "p")
	d.Repo = &Repo{Pool: pool}
	router := chi.NewRouter()
	d.MountRoutes(router)
	return router
}

type caller string

const (
	asOperator caller = "session"
	asProgram  caller = "api-key"
)

// addMember posts one add through the mounted route as the given caller.
func addMember(t *testing.T, router http.Handler, tenantID, listUUID, subscriberID string, who caller) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost,
		"/api/v1/lists/"+listUUID+"/subscribers",
		strings.NewReader(`{"subscriber_ids":["`+subscriberID+`"]}`))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID})
	if who == asOperator {
		// What the dashboard's session cookie leaves on the context.
		ctx = middleware.WithUser(ctx, &middleware.User{
			ID: uuid.NewString(), TenantID: tenantID, Email: "owner@example.test", Role: "owner",
		})
	} else {
		ctx = middleware.WithAPIKeyAuth(ctx)
		ctx = apikeys.WithScopes(ctx, []apikeys.Scope{
			apikeys.ScopeReadSubscribers, apikeys.ScopeWriteSubscribers,
		})
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req.WithContext(ctx))
	return rec
}

// membershipAttribution reads what the membership and its ledger owner say
// about who added the contact.
func membershipAttribution(t *testing.T, pool *db.Pool, tenantID, listUUID, subscriberID string) (source string, owners []string, ownerMetadata []string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open attribution read: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `
SELECT ls.source,
       COALESCE(ARRAY(
           SELECT lss.owner_key FROM list_subscriber_sources lss
            WHERE lss.tenant_id = ls.tenant_id AND lss.list_id = ls.list_id
              AND lss.subscriber_id = ls.subscriber_id AND lss.removed_at IS NULL
            ORDER BY lss.owner_key), '{}'::text[]),
       COALESCE(ARRAY(
           SELECT lss.metadata::text FROM list_subscriber_sources lss
            WHERE lss.tenant_id = ls.tenant_id AND lss.list_id = ls.list_id
              AND lss.subscriber_id = ls.subscriber_id AND lss.removed_at IS NULL
            ORDER BY lss.owner_key), '{}'::text[])
  FROM list_subscribers ls
 WHERE ls.tenant_id = $1::uuid AND ls.list_id = $2::uuid
   AND ls.subscriber_id = $3::uuid AND ls.removed_at IS NULL`,
		tenantID, listUUID, subscriberID).Scan(&source, &owners, &ownerMetadata); err != nil {
		t.Fatalf("read membership attribution: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit attribution read: %v", err)
	}
	return source, owners, ownerMetadata
}

func TestAddMembersRecordsWhoAddedThemDB(t *testing.T) {
	pool := newListMembershipConsentTestPool(t)
	tenantID := seedListMembershipConsentTenant(t, pool)
	listUUID := mappedTestList(t, pool, tenantID)
	router := membershipRouter(pool)

	byOperator := seedExistingOptedOutListMember(t, pool, tenantID,
		"by-operator-"+strings.ReplaceAll(uuid.NewString(), "-", "")[:8]+"@example.test")
	byProgram := seedExistingOptedOutListMember(t, pool, tenantID,
		"by-program-"+strings.ReplaceAll(uuid.NewString(), "-", "")[:8]+"@example.test")

	if rec := addMember(t, router, tenantID, listUUID, byOperator, asOperator); rec.Code != http.StatusOK {
		t.Fatalf("operator add status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := addMember(t, router, tenantID, listUUID, byProgram, asProgram); rec.Code != http.StatusOK {
		t.Fatalf("api-key add status=%d body=%s", rec.Code, rec.Body.String())
	}

	// A person in the dashboard is an operator's manual add, exactly like the
	// bulk add-to-list from the subscribers table.
	source, owners, metadata := membershipAttribution(t, pool, tenantID, listUUID, byOperator)
	if source != "admin" {
		t.Errorf("operator add source = %q, want admin", source)
	}
	if len(owners) != 1 || owners[0] != "source:admin" {
		t.Errorf("operator add owners = %v, want [source:admin]", owners)
	}
	if len(metadata) != 1 || !strings.Contains(metadata[0], "list_console") {
		t.Errorf("operator add owner metadata = %v, want the console owner", metadata)
	}

	// A credentialed program keeps the API attribution.
	source, owners, metadata = membershipAttribution(t, pool, tenantID, listUUID, byProgram)
	if source != "api" {
		t.Errorf("api-key add source = %q, want api", source)
	}
	if len(owners) != 1 || owners[0] != "source:api" {
		t.Errorf("api-key add owners = %v, want [source:api]", owners)
	}
	if len(metadata) != 1 || !strings.Contains(metadata[0], "list_api") {
		t.Errorf("api-key add owner metadata = %v, want the api owner", metadata)
	}

	// Both remain removable from the Members tab: an owner outside
	// operatorMembershipOwnerKeys would keep the membership alive behind a 204.
	for _, subscriberID := range []string{byOperator, byProgram} {
		removed, err := (&Repo{Pool: pool}).RemoveMember(context.Background(), tenantID, listUUID, subscriberID)
		if err != nil || !removed {
			t.Fatalf("remove %s = (%v, %v), want (true, nil)", subscriberID, removed, err)
		}
		if active, owners := activeMembership(t, pool, tenantID, listUUID, subscriberID); active || len(owners) != 0 {
			t.Errorf("%s still a member after Remove: active=%v owners=%v", subscriberID, active, owners)
		}
	}
}
