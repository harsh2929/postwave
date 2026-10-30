// SPDX-License-Identifier: AGPL-3.0-only

package tags

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

func tagContractDBPools(t *testing.T) (*pgxpool.Pool, *pgxpool.Pool) {
	t.Helper()
	appURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if appURL == "" || adminURL == "" {
		t.Skip("DATABASE_URL and POSTWAVE_TEST_ADMIN_DATABASE_URL are required for tag DB contracts")
	}
	ctx := context.Background()
	app, err := pgxpool.New(ctx, appURL)
	if err != nil {
		t.Fatal(err)
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		app.Close()
		t.Fatal(err)
	}
	t.Cleanup(app.Close)
	t.Cleanup(admin.Close)
	return app, admin
}

type tagContractFixture struct {
	TenantID    string
	OtherTenant string
	UserID      string
	Subscriber  string
	OtherSub    string
	CrossSub    string
	GroupID     string
	CrossGroup  string
}

func seedTagContractFixture(t *testing.T, admin *pgxpool.Pool) tagContractFixture {
	t.Helper()
	f := tagContractFixture{
		TenantID:    uuid.NewString(),
		OtherTenant: uuid.NewString(),
		UserID:      uuid.NewString(),
		Subscriber:  uuid.NewString(),
		OtherSub:    uuid.NewString(),
		CrossSub:    uuid.NewString(),
		GroupID:     uuid.NewString(),
		CrossGroup:  uuid.NewString(),
	}
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	createdAt := time.Now().UTC().Add(-time.Second).Truncate(time.Microsecond)
	if _, err := admin.Exec(context.Background(), `
INSERT INTO tenants (id, slug, name, tier, created_at)
VALUES ($1::uuid, $2, 'Tags contract tenant', 'studio', $4),
       ($3::uuid, $2 || '-other', 'Tags contract other tenant', 'studio', $4)`,
		f.TenantID, "tags-contract-"+suffix, f.OtherTenant, createdAt); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), `DELETE FROM tenants WHERE id = ANY($1::uuid[])`, []string{f.TenantID, f.OtherTenant})
	})

	var coverageStart time.Time
	if err := admin.QueryRow(context.Background(), `
SELECT coverage_started_at FROM tag_membership_coverage WHERE tenant_id=$1::uuid`, f.TenantID).Scan(&coverageStart); err != nil {
		t.Fatalf("fresh tenant coverage row: %v", err)
	}
	if !coverageStart.Equal(createdAt) {
		t.Fatalf("coverage_started_at=%s, want tenant.created_at=%s", coverageStart, createdAt)
	}

	if _, err := admin.Exec(context.Background(), `
INSERT INTO users (id, tenant_id, email, role)
VALUES ($1::uuid, $2::uuid, $3, 'owner')`,
		f.UserID, f.TenantID, "owner-"+suffix+"@example.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(context.Background(), `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::uuid, $3, 'enabled', 'api'),
       ($4::uuid, $2::uuid, $5, 'enabled', 'api'),
       ($6::uuid, $7::uuid, $8, 'enabled', 'api')`,
		f.Subscriber, f.TenantID, "one-"+suffix+"@example.test",
		f.OtherSub, "two-"+suffix+"@example.test",
		f.CrossSub, f.OtherTenant, "cross-"+suffix+"@example.test"); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(context.Background(), `
INSERT INTO tag_groups (id, tenant_id, name, color, sort_order)
VALUES ($1::uuid, $2::uuid, 'Lifecycle', 'teal', 1),
       ($3::uuid, $4::uuid, 'Cross tenant', 'rose', 1)`,
		f.GroupID, f.TenantID, f.CrossGroup, f.OtherTenant); err != nil {
		t.Fatal(err)
	}
	return f
}

func requirePGCode(t *testing.T, err error, code string) *pgconn.PgError {
	t.Helper()
	var pgErr *pgconn.PgError
	if err == nil || !errors.As(err, &pgErr) || pgErr.Code != code {
		t.Fatalf("error=%v, want PostgreSQL code %s", err, code)
	}
	return pgErr
}

func withTagRequestIdentity(req *http.Request, f tagContractFixture) *http.Request {
	ctx := middleware.WithTenant(req.Context(), &middleware.Tenant{ID: f.TenantID})
	ctx = middleware.WithUser(ctx, &middleware.User{
		ID: f.UserID, TenantID: f.TenantID, Email: "owner@example.test", Role: "owner",
	})
	return req.WithContext(ctx)
}

func TestTagsHTTPETagAndDesktopFieldsDB(t *testing.T) {
	app, admin := tagContractDBPools(t)
	f := seedTagContractFixture(t, admin)
	deps := &Deps{Repo: &Repo{Pool: app}}
	router := chi.NewRouter()
	deps.MountRoutes(router)

	request := func(method, path, body, ifMatch string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewBufferString(body))
		req.Header.Set("Content-Type", "application/json")
		if ifMatch != "" {
			req.Header.Set("If-Match", ifMatch)
		}
		req = withTagRequestIdentity(req, f)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)
		return rec
	}

	createBody := fmt.Sprintf(`{"name":"High intent","color":"#14B8A6","description":"Desktop exact-field contract","group_id":%q,"pii":true}`, f.GroupID)
	created := request(http.MethodPost, "/api/v1/tags", createBody, "")
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var tag Tag
	if err := json.Unmarshal(created.Body.Bytes(), &tag); err != nil {
		t.Fatal(err)
	}
	if tag.ID == "" || tag.GroupID != f.GroupID || !tag.PII || tag.Version != 1 || tag.ETag == "" {
		t.Fatalf("create response lost desktop fields: %+v", tag)
	}
	if got := created.Header().Get("ETag"); got != tag.ETag {
		t.Fatalf("create ETag header=%q body=%q", got, tag.ETag)
	}

	if rec := request(http.MethodPatch, "/api/v1/tags/"+tag.ID, `{"color":"rose"}`, ""); rec.Code != http.StatusPreconditionRequired {
		t.Fatalf("missing If-Match status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := request(http.MethodPatch, "/api/v1/tags/"+tag.ID, `{"color":"rose"}`, `"tag:`+tag.ID+`:v999"`); rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale If-Match status=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := request(http.MethodPatch, "/api/v1/tags/"+uuid.NewString(), `{"color":"rose"}`, tag.ETag); rec.Code != http.StatusBadRequest {
		t.Fatalf("cross-id If-Match status=%d body=%s", rec.Code, rec.Body.String())
	}

	start := make(chan struct{})
	responses := make(chan *httptest.ResponseRecorder, 2)
	var wg sync.WaitGroup
	for _, color := range []string{"rose", "amber"} {
		color := color
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			responses <- request(http.MethodPatch, "/api/v1/tags/"+tag.ID, `{"color":"`+color+`"}`, tag.ETag)
		}()
	}
	close(start)
	wg.Wait()
	close(responses)
	statuses := make([]int, 0, 2)
	for rec := range responses {
		statuses = append(statuses, rec.Code)
		if rec.Code == http.StatusOK {
			var updated Tag
			if err := json.Unmarshal(rec.Body.Bytes(), &updated); err != nil {
				t.Fatal(err)
			}
			if updated.ID != tag.ID || updated.Version != 2 || rec.Header().Get("ETag") != updated.ETag ||
				updated.Description != "Desktop exact-field contract" || updated.GroupID != f.GroupID || !updated.PII {
				t.Fatalf("update identity/version/ETag mismatch: header=%q body=%+v", rec.Header().Get("ETag"), updated)
			}
		}
	}
	sort.Ints(statuses)
	if fmt.Sprint(statuses) != fmt.Sprint([]int{http.StatusOK, http.StatusPreconditionFailed}) {
		t.Fatalf("concurrent CAS statuses=%v, want [200 412]", statuses)
	}

	crossGroupBody := fmt.Sprintf(`{"name":"Cross group","group_id":%q}`, f.CrossGroup)
	if rec := request(http.MethodPost, "/api/v1/tags", crossGroupBody, ""); rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("cross-tenant group status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestTagGroupsCRUDTenantIsolationAndUngroupingDB(t *testing.T) {
	app, admin := tagContractDBPools(t)
	f := seedTagContractFixture(t, admin)
	ctx := context.Background()
	groups := &GroupRepo{Pool: app}
	tagRepo := &Repo{Pool: app}

	group, err := groups.Create(ctx, f.TenantID, GroupCreateInput{
		Name: "Customer lifecycle", Color: "#14b8a6", SortOrder: 42,
	})
	if err != nil {
		t.Fatal(err)
	}
	if group.ID == "" || group.Name != "Customer lifecycle" ||
		group.Color != "#14b8a6" || group.SortOrder != 42 {
		t.Fatalf("created group lost fields: %+v", group)
	}

	listed, err := groups.List(ctx, f.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, candidate := range listed {
		if candidate.ID == group.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("created group %s absent from tenant list: %+v", group.ID, listed)
	}

	name := "Lifecycle stage"
	color := ""
	sortOrder := 7
	group, err = groups.Update(ctx, f.TenantID, group.ID, GroupUpdateInput{
		Name: &name, Color: &color, SortOrder: &sortOrder,
	})
	if err != nil {
		t.Fatal(err)
	}
	if group.Name != name || group.Color != "" || group.SortOrder != sortOrder {
		t.Fatalf("updated group lost omission/clear semantics: %+v", group)
	}

	if _, err := groups.GetByID(ctx, f.TenantID, f.CrossGroup); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant group read error=%v, want ErrNotFound", err)
	}
	if _, err := groups.Update(ctx, f.TenantID, f.CrossGroup, GroupUpdateInput{Name: &name}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant group update error=%v, want ErrNotFound", err)
	}

	tag, err := tagRepo.Create(ctx, f.TenantID, CreateInput{
		Name: "Group deletion contract", GroupID: group.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := groups.Delete(ctx, f.TenantID, group.ID); err != nil {
		t.Fatal(err)
	}
	afterDelete, err := tagRepo.GetByID(ctx, f.TenantID, tag.ID)
	if err != nil {
		t.Fatal(err)
	}
	if afterDelete.GroupID != "" {
		t.Fatalf("deleting group did not ungroup retained tag: %+v", afterDelete)
	}
	if afterDelete.Version != tag.Version+1 || afterDelete.ETag == tag.ETag {
		t.Fatalf("group-driven tag change did not invalidate the tag ETag: before=%+v after=%+v", tag, afterDelete)
	}
	if _, err := groups.GetByID(ctx, f.TenantID, group.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted group lookup error=%v, want ErrNotFound", err)
	}
	if err := groups.Delete(ctx, f.TenantID, f.CrossGroup); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant group delete error=%v, want ErrNotFound", err)
	}
}

func TestTagMembershipLedgerInvariantsAndIdempotencyDB(t *testing.T) {
	app, admin := tagContractDBPools(t)
	f := seedTagContractFixture(t, admin)
	ctx := context.Background()

	for name, statement := range map[string]string{
		"insert": `INSERT INTO tag_membership_events (tenant_id,tag_id,subscriber_id,action,source,actor_evidence)
VALUES ('00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000','00000000-0000-0000-0000-000000000000','tag_added','forged','unavailable')`,
		"update": `UPDATE tag_membership_events SET source='forged'`,
		"delete": `DELETE FROM tag_membership_events`,
	} {
		t.Run("ledger_"+name+"_denied", func(t *testing.T) {
			_, err := app.Exec(ctx, statement)
			_ = requirePGCode(t, err, "42501")
		})
	}
	if _, err := app.Exec(ctx, `SET ROLE postwave_tag_event_definer`); err == nil {
		t.Fatal("application role unexpectedly SET ROLE to ledger definer")
	} else {
		_ = requirePGCode(t, err, "42501")
	}

	crossLedgerTag := uuid.NewString()
	if _, err := admin.Exec(ctx, `INSERT INTO tags (id,tenant_id,name) VALUES ($1::uuid,$2::uuid,'Cross ledger')`,
		crossLedgerTag, f.OtherTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `INSERT INTO subscriber_tags (tenant_id,subscriber_id,tag_id,source)
VALUES ($1::uuid,$2::uuid,$3::uuid,'cross_tenant_rls_test')`,
		f.OtherTenant, f.CrossSub, crossLedgerTag); err != nil {
		t.Fatal(err)
	}

	var crossCoverageVisible, crossEventsVisible int
	tx, err := db.WithTenant(ctx, app, f.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM tag_membership_coverage WHERE tenant_id=$1::uuid`, f.OtherTenant).Scan(&crossCoverageVisible); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM tag_membership_events WHERE tenant_id=$1::uuid`, f.OtherTenant).Scan(&crossEventsVisible); err != nil {
		t.Fatal(err)
	}
	if crossCoverageVisible != 0 || crossEventsVisible != 0 {
		t.Fatalf("cross-tenant ledger visible: coverage=%d events=%d", crossCoverageVisible, crossEventsVisible)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	tagID := uuid.NewString()
	if _, err := admin.Exec(ctx, `INSERT INTO tags (id,tenant_id,name) VALUES ($1::uuid,$2::uuid,'Concurrency')`, tagID, f.TenantID); err != nil {
		t.Fatal(err)
	}
	repo := &SubscriberTagsRepo{Pool: app}
	start := make(chan struct{})
	results := make(chan BulkResult, 8)
	errs := make(chan error, 8)
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			result, opErr := repo.BulkApply(ctx, f.TenantID, tagID, []string{f.Subscriber}, f.UserID, "contract_test", "same-key")
			results <- result
			errs <- opErr
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	close(errs)
	for opErr := range errs {
		if opErr != nil {
			t.Fatalf("concurrent idempotent apply: %v", opErr)
		}
	}
	for result := range results {
		if result != (BulkResult{Applied: 1, Skipped: 0}) {
			t.Fatalf("idempotent replay result=%+v", result)
		}
	}
	var joins, addedEvents int
	var projected []string
	if err := admin.QueryRow(ctx, `
SELECT
 (SELECT count(*) FROM subscriber_tags WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid AND tag_id=$3::uuid),
 (SELECT count(*) FROM tag_membership_events WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid AND tag_id=$3::uuid AND action='tag_added'),
 (SELECT tags FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid)`, f.TenantID, f.Subscriber, tagID).
		Scan(&joins, &addedEvents, &projected); err != nil {
		t.Fatal(err)
	}
	if joins != 1 || addedEvents != 1 || len(projected) != 1 || projected[0] != "Concurrency" {
		t.Fatalf("join=%d added_events=%d projection=%v", joins, addedEvents, projected)
	}

	if _, err := repo.BulkUnapply(ctx, f.TenantID, tagID, []string{f.Subscriber}, f.UserID, "contract_remove", "remove-key"); err != nil {
		t.Fatal(err)
	}
	var removedEvents int
	if err := admin.QueryRow(ctx, `
SELECT
 (SELECT count(*) FROM tag_membership_events WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid AND tag_id=$3::uuid AND action='tag_removed'),
 (SELECT tags FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid)`, f.TenantID, f.Subscriber, tagID).
		Scan(&removedEvents, &projected); err != nil {
		t.Fatal(err)
	}
	if removedEvents != 1 || len(projected) != 0 {
		t.Fatalf("removed_events=%d projection=%v", removedEvents, projected)
	}

	// A privileged maintenance key move is represented as one removal plus one
	// addition, and both the old and new subscriber projections are rebuilt.
	keyMoveTag := uuid.NewString()
	if _, err := admin.Exec(ctx, `INSERT INTO tags (id,tenant_id,name) VALUES ($1::uuid,$2::uuid,'KeyMove')`, keyMoveTag, f.TenantID); err != nil {
		t.Fatal(err)
	}
	maintenanceTx, err := admin.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := maintenanceTx.Exec(ctx, `
SELECT set_config('app.tenant_id',$1,true),
       set_config('app.actor_id',$2,true),
       set_config('app.tag_membership_source','key_move_test',true)`, f.TenantID, f.UserID); err != nil {
		_ = maintenanceTx.Rollback(ctx)
		t.Fatal(err)
	}
	if _, err := maintenanceTx.Exec(ctx, `
INSERT INTO subscriber_tags (tenant_id,subscriber_id,tag_id,applied_by,source)
VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'key_move_seed')`, f.TenantID, f.Subscriber, keyMoveTag, f.UserID); err != nil {
		_ = maintenanceTx.Rollback(ctx)
		t.Fatal(err)
	}
	if _, err := maintenanceTx.Exec(ctx, `
UPDATE subscriber_tags SET subscriber_id=$3::uuid
WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid AND tag_id=$4::uuid`, f.TenantID, f.Subscriber, f.OtherSub, keyMoveTag); err != nil {
		_ = maintenanceTx.Rollback(ctx)
		t.Fatal(err)
	}
	if err := maintenanceTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var moveAdds, moveRemoves, moveRemovalEvidence, moveAdditionEvidence int
	var oldProjection, newProjection []string
	if err := admin.QueryRow(ctx, `
SELECT
 (SELECT count(*) FROM tag_membership_events WHERE tenant_id=$1::uuid AND tag_id=$2::uuid AND action='tag_added'),
 (SELECT count(*) FROM tag_membership_events WHERE tenant_id=$1::uuid AND tag_id=$2::uuid AND action='tag_removed'),
 (SELECT count(*) FROM tag_membership_events
   WHERE tenant_id=$1::uuid AND tag_id=$2::uuid AND subscriber_id=$3::uuid
     AND action='tag_removed' AND source='key_move_test'
     AND actor_id=$5::uuid AND actor_evidence='session_asserted'
     AND metadata->>'reason'='join_key_updated'),
 (SELECT count(*) FROM tag_membership_events
   WHERE tenant_id=$1::uuid AND tag_id=$2::uuid AND subscriber_id=$4::uuid
     AND action='tag_added' AND source='key_move_seed'
     AND actor_id=$5::uuid AND actor_evidence='writer_asserted'
     AND metadata->>'reason'='join_key_updated'),
 (SELECT tags FROM subscribers WHERE tenant_id=$1::uuid AND id=$3::uuid),
 (SELECT tags FROM subscribers WHERE tenant_id=$1::uuid AND id=$4::uuid)`,
		f.TenantID, keyMoveTag, f.Subscriber, f.OtherSub, f.UserID).Scan(
		&moveAdds, &moveRemoves, &moveRemovalEvidence, &moveAdditionEvidence,
		&oldProjection, &newProjection,
	); err != nil {
		t.Fatal(err)
	}
	if moveAdds != 2 || moveRemoves != 1 || moveRemovalEvidence != 1 || moveAdditionEvidence != 1 ||
		len(oldProjection) != 0 || fmt.Sprint(newProjection) != fmt.Sprint([]string{"KeyMove"}) {
		t.Fatalf("key move adds=%d removes=%d removal_evidence=%d addition_evidence=%d old=%v new=%v",
			moveAdds, moveRemoves, moveRemovalEvidence, moveAdditionEvidence, oldProjection, newProjection)
	}

	// Composite tenant foreign keys reject a visible-tenant membership that
	// references a tag owned by another tenant.
	crossTag := uuid.NewString()
	if _, err := admin.Exec(ctx, `INSERT INTO tags (id,tenant_id,name) VALUES ($1::uuid,$2::uuid,'Cross')`, crossTag, f.OtherTenant); err != nil {
		t.Fatal(err)
	}
	tx, err = db.WithTenant(ctx, app, f.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO subscriber_tags (tenant_id,subscriber_id,tag_id) VALUES ($1::uuid,$2::uuid,$3::uuid)`, f.TenantID, f.Subscriber, crossTag)
	_ = requirePGCode(t, err, "23503")
	_ = tx.Rollback(ctx)

	// The compatibility projection accepts exactly 50 memberships and rejects
	// the 51st atomically on both canonical-join and legacy-array entry points.
	boundarySub := uuid.NewString()
	arraySub := uuid.NewString()
	if _, err := admin.Exec(ctx, `
INSERT INTO subscribers (id,tenant_id,email,status,consent_source)
VALUES ($1::uuid,$3::uuid,$4,'enabled','api'),($2::uuid,$3::uuid,$5,'enabled','api')`,
		boundarySub, arraySub, f.TenantID, boundarySub+"@example.test", arraySub+"@example.test"); err != nil {
		t.Fatal(err)
	}
	tagIDs := make([]string, 0, 51)
	tagNames := make([]string, 0, 51)
	for i := 0; i < 51; i++ {
		tagIDs = append(tagIDs, uuid.NewString())
		tagNames = append(tagNames, fmt.Sprintf("Boundary-%02d", i))
	}
	if _, err := admin.Exec(ctx, `
INSERT INTO tags (id,tenant_id,name)
SELECT ids.id::uuid,$1::uuid,names.name
FROM unnest($2::text[]) WITH ORDINALITY ids(id,n)
JOIN unnest($3::text[]) WITH ORDINALITY names(name,n) USING (n)`, f.TenantID, tagIDs, tagNames); err != nil {
		t.Fatal(err)
	}
	tx, err = db.WithTenant(ctx, app, f.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_tags (tenant_id,subscriber_id,tag_id,source)
SELECT $1::uuid,$2::uuid,id::uuid,'boundary_test' FROM unnest($3::text[]) id`, f.TenantID, boundarySub, tagIDs[:50]); err != nil {
		t.Fatalf("50th canonical membership: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = db.WithTenant(ctx, app, f.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO subscriber_tags (tenant_id,subscriber_id,tag_id,source) VALUES ($1::uuid,$2::uuid,$3::uuid,'boundary_test')`, f.TenantID, boundarySub, tagIDs[50])
	pgErr := requirePGCode(t, err, "23514")
	if pgErr.ConstraintName != "tag_membership_compatibility_budget_1774" {
		t.Fatalf("51st join constraint=%q", pgErr.ConstraintName)
	}
	_ = tx.Rollback(ctx)

	tx, err = db.WithTenant(ctx, app, f.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE subscribers SET tags=$3::text[] WHERE tenant_id=$1::uuid AND id=$2::uuid`, f.TenantID, arraySub, tagNames[:50]); err != nil {
		t.Fatalf("50-item legacy array: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = db.WithTenant(ctx, app, f.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `UPDATE subscribers SET tags=$3::text[] WHERE tenant_id=$1::uuid AND id=$2::uuid`, f.TenantID, arraySub, tagNames)
	_ = requirePGCode(t, err, "23514")
	_ = tx.Rollback(ctx)

	// CITEXT uniqueness and the legacy-array guard reject case variants as
	// duplicates rather than manufacturing two labels for one canonical id.
	caseTag := uuid.NewString()
	if _, err := admin.Exec(ctx, `INSERT INTO tags (id,tenant_id,name) VALUES ($1::uuid,$2::uuid,'CaseFold')`, caseTag, f.TenantID); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `INSERT INTO tags (tenant_id,name) VALUES ($1::uuid,'casefold')`, f.TenantID); err == nil {
		t.Fatal("case-insensitive duplicate tag unexpectedly inserted")
	} else {
		_ = requirePGCode(t, err, "23505")
	}
	caseSub := uuid.NewString()
	if _, err := admin.Exec(ctx, `INSERT INTO subscribers (id,tenant_id,email,status,consent_source,tags) VALUES ($1::uuid,$2::uuid,$3,'enabled','api',ARRAY['CaseFold','casefold'])`, caseSub, f.TenantID, caseSub+"@example.test"); err == nil {
		t.Fatal("case-insensitive duplicate array unexpectedly inserted")
	} else {
		_ = requirePGCode(t, err, "23514")
	}
	if _, err := admin.Exec(ctx, `INSERT INTO subscribers (id,tenant_id,email,status,consent_source,tags) VALUES ($1::uuid,$2::uuid,$3,'enabled','api',ARRAY['CaseFold'])`, caseSub, f.TenantID, caseSub+"@example.test"); err != nil {
		t.Fatal(err)
	}
	var caseJoins int
	if err := admin.QueryRow(ctx, `SELECT count(*), max(s.tags) FROM subscriber_tags st JOIN subscribers s ON s.tenant_id=st.tenant_id AND s.id=st.subscriber_id WHERE st.tenant_id=$1::uuid AND st.subscriber_id=$2::uuid GROUP BY s.id`, f.TenantID, caseSub).Scan(&caseJoins, &projected); err != nil {
		t.Fatal(err)
	}
	if caseJoins != 1 || fmt.Sprint(projected) != fmt.Sprint([]string{"CaseFold"}) {
		t.Fatalf("casefold joins=%d projection=%v", caseJoins, projected)
	}
	if _, err := admin.Exec(ctx, `UPDATE tags SET name='CaseRenamed' WHERE tenant_id=$1::uuid AND id=$2::uuid`, f.TenantID, caseTag); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(ctx, `SELECT tags FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid`, f.TenantID, caseSub).Scan(&projected); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(projected) != fmt.Sprint([]string{"CaseRenamed"}) {
		t.Fatalf("rename projection=%v", projected)
	}
}

func TestTagHistoryCompositeCursorDoesNotLoseEqualTimestampsDB(t *testing.T) {
	app, admin := tagContractDBPools(t)
	f := seedTagContractFixture(t, admin)
	ctx := context.Background()
	tagID := uuid.NewString()
	if _, err := admin.Exec(ctx, `INSERT INTO tags (id,tenant_id,name) VALUES ($1::uuid,$2::uuid,'History')`, tagID, f.TenantID); err != nil {
		t.Fatal(err)
	}
	occurredAt := time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond)
	ids := make([]string, 5)
	for i := range ids {
		ids[i] = uuid.NewString()
	}
	if _, err := admin.Exec(ctx, `
INSERT INTO tag_history (id,tenant_id,tag_id,tag_name,action,source,occurred_at)
SELECT event_id::uuid,$1::uuid,$2::uuid,'History','tag_updated','contract_test',$3
FROM unnest($4::text[]) event_id`, f.TenantID, tagID, occurredAt, ids); err != nil {
		t.Fatal(err)
	}

	history := &History{Pool: app}
	cursor := historyPageCursor{}
	seen := map[string]struct{}{}
	for page := 0; page < 3; page++ {
		rows, err := history.ListByTag(ctx, f.TenantID, tagID, cursor, 2)
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range rows {
			if _, duplicate := seen[row.ID]; duplicate {
				t.Fatalf("history row %s repeated", row.ID)
			}
			seen[row.ID] = struct{}{}
		}
		if len(rows) < 2 {
			break
		}
		encoded := encodeHistoryCursor(rows[len(rows)-1])
		cursor, err = decodeHistoryCursor(encoded)
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(seen) != len(ids) {
		t.Fatalf("equal-timestamp pagination returned %d unique rows, want %d", len(seen), len(ids))
	}
}
