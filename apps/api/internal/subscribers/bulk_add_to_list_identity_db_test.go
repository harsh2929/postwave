// SPDX-License-Identifier: AGPL-3.0-only
//
// bulk_add_to_list_identity_db_test.go — the add-to-list verb driven through
// the production route table (MountBulkRoutes, admin scope gate included)
// against a migrated database as the RLS-bound application role.
//
// Every first-party client sends the engine id its list picker was filled
// with. These tests send exactly that — never an id no client holds — and then
// read back the membership, its owner row, the undo receipt and the automation
// enrolment it touched.

package subscribers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// bulkListFixture is one tenant with one mapped list, and the production
// router serving the bulk verbs for it.
type bulkListFixture struct {
	pool     *pgxpool.Pool
	tenantID string
	listUUID string
	engineID int64
	router   http.Handler
	webhooks *bulkWebhookRecorder
}

func newBulkListFixture(t *testing.T) *bulkListFixture {
	t.Helper()
	pool := newBulkVerbsTestPool(t)
	tenantID := uuid.NewString()
	seedBulkVerbsTenant(t, pool, tenantID)
	const engineID int64 = 10
	listUUID := seedBulkListIdentity(t, pool, tenantID, engineID)
	webhooks := &bulkWebhookRecorder{}
	router := chi.NewRouter()
	MountBulkRoutes(router, &Deps{Repo: &Repo{Pool: pool, Webhooks: webhooks}})
	return &bulkListFixture{
		pool: pool, tenantID: tenantID, listUUID: listUUID, engineID: engineID,
		router: router, webhooks: webhooks,
	}
}

// seedBulkListIdentity records the (uuid, engine id) pair the list-create
// handler persists, and returns the uuid.
func seedBulkListIdentity(t *testing.T, pool *pgxpool.Pool, tenantID string, engineID int64) string {
	t.Helper()
	ctx := context.Background()
	listUUID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open list identity seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO list_id_map (postwave_uuid, listmonk_bigint_id, tenant_id)
VALUES ($1::uuid, $2, $3::uuid)`, listUUID, engineID, tenantID); err != nil {
		t.Fatalf("seed list identity: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit list identity seed: %v", err)
	}
	return listUUID
}

// post sends body to path through the router as an admin-scoped API key of
// the fixture's tenant.
func (f *bulkListFixture) post(t *testing.T, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	ctx := middleware.WithAPIKeyAuth(req.Context())
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: f.tenantID})
	ctx = apikeys.WithScopes(ctx, []apikeys.Scope{apikeys.ScopeAdmin})
	w := httptest.NewRecorder()
	f.router.ServeHTTP(w, req.WithContext(ctx))
	return w
}

func (f *bulkListFixture) addToList(t *testing.T, listID string, subscriberIDs ...string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]any{"subscriber_ids": subscriberIDs, "list_id": listID})
	if err != nil {
		t.Fatalf("marshal add-to-list body: %v", err)
	}
	return f.post(t, "/api/v1/subscribers/bulk/add-to-list", string(body))
}

func (f *bulkListFixture) recover(t *testing.T, token string) BulkResult {
	t.Helper()
	w := f.post(t, "/api/v1/subscribers/bulk/recover", fmt.Sprintf(`{"recovery_token":%q}`, token))
	return decodeBulkResult(t, w)
}

// bulkMembership is a list_subscribers row plus its bulk owner row, read back
// as the application role.
type bulkMembership struct {
	Exists         bool
	ListmonkListID *int64
	Email          *string
	Source         string
	AddedAt        time.Time
	RemovedAt      *time.Time
	OwnerExists    bool
	OwnerRemovedAt *time.Time
}

func (f *bulkListFixture) membership(t *testing.T, subscriberID string) bulkMembership {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, f.pool, f.tenantID)
	if err != nil {
		t.Fatalf("open membership read: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out bulkMembership
	err = tx.QueryRow(ctx, `
SELECT listmonk_list_id, email::text, source, added_at, removed_at
  FROM list_subscribers
 WHERE tenant_id = $1::uuid AND list_id = $2::uuid AND subscriber_id = $3::uuid`,
		f.tenantID, f.listUUID, subscriberID).Scan(&out.ListmonkListID, &out.Email, &out.Source, &out.AddedAt, &out.RemovedAt)
	if err == nil {
		out.Exists = true
	} else if !strings.Contains(err.Error(), "no rows") {
		t.Fatalf("read membership: %v", err)
	}
	err = tx.QueryRow(ctx, `
SELECT removed_at
  FROM list_subscriber_sources
 WHERE tenant_id = $1::uuid AND list_id = $2::uuid AND subscriber_id = $3::uuid
   AND owner_key = 'source:admin'`, f.tenantID, f.listUUID, subscriberID).Scan(&out.OwnerRemovedAt)
	if err == nil {
		out.OwnerExists = true
	} else if !strings.Contains(err.Error(), "no rows") {
		t.Fatalf("read membership owner: %v", err)
	}
	return out
}

func (f *bulkListFixture) exec(t *testing.T, sql string, args ...any) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, f.pool, f.tenantID)
	if err != nil {
		t.Fatalf("open fixture write: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, sql, args...); err != nil {
		t.Fatalf("fixture write: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture write: %v", err)
	}
}

func decodeBulkError(t *testing.T, w *httptest.ResponseRecorder, wantStatus int) string {
	t.Helper()
	if w.Code != wantStatus {
		t.Fatalf("status = %d, want %d (body=%s)", w.Code, wantStatus, w.Body.String())
	}
	var env struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("decode error envelope: %v (body=%s)", err, w.Body.String())
	}
	return env.Error.Code
}

// TestBulkAddToListAcceptsTheEngineIDEveryClientSends is the staging 500:
// the page sends list_id "10" and the handler cast it to uuid.
func TestBulkAddToListAcceptsTheEngineIDEveryClientSends(t *testing.T) {
	f := newBulkListFixture(t)
	email := fmt.Sprintf("bulk-engine-%d@example.test", time.Now().UnixNano())
	id := seedBulkVerbsSubscriber(t, f.pool, f.tenantID, email, "enabled")

	w := f.addToList(t, "10", id)
	res := decodeBulkResult(t, w)
	if res.Affected != 1 || res.Skipped != 0 || res.RecoveryToken == "" {
		t.Fatalf("add-to-list by engine id = %+v, want one added with an undo token", res)
	}

	got := f.membership(t, id)
	if !got.Exists || got.RemovedAt != nil {
		t.Fatalf("membership after add = %+v, want an active row on the mapped uuid", got)
	}
	if got.ListmonkListID == nil || *got.ListmonkListID != f.engineID {
		t.Fatalf("listmonk_list_id = %v, want %d (the Lists panel names a list through it)", got.ListmonkListID, f.engineID)
	}
	if got.Email == nil || !strings.EqualFold(*got.Email, email) {
		t.Fatalf("membership email = %v, want %q", got.Email, email)
	}
	if got.Source != "admin" {
		t.Fatalf("membership source = %q, want admin (not the column default 'migration')", got.Source)
	}
	if !got.OwnerExists || got.OwnerRemovedAt != nil {
		t.Fatalf("owner row = exists:%v removed:%v, want an active source:admin owner", got.OwnerExists, got.OwnerRemovedAt)
	}
	if len(f.webhooks.inputs) != 1 {
		t.Fatalf("list.subscriber.added intents = %d, want 1", len(f.webhooks.inputs))
	}
	body, _ := f.webhooks.inputs[0].Body.(map[string]any)
	if body["list_id"] != f.listUUID {
		t.Fatalf("webhook list_id = %v, want the canonical uuid %s", body["list_id"], f.listUUID)
	}

	// The members endpoint keyed on the same engine id now sees the contact.
	listsRepo := &lists.Repo{Pool: f.pool}
	members, total, err := listsRepo.ListMembers(context.Background(), f.tenantID, f.listUUID, "", "", 1, 25)
	if err != nil || total != 1 || len(members) != 1 || members[0].ID != id || members[0].Source != "admin" {
		t.Fatalf("members after bulk add = %+v total=%d err=%v, want the one contact with source admin", members, total, err)
	}
}

func TestBulkAddToListAcceptsTheCanonicalUUIDAndReportsWhoWasAlreadyThere(t *testing.T) {
	f := newBulkListFixture(t)
	suffix := time.Now().UnixNano()
	member := seedBulkVerbsSubscriber(t, f.pool, f.tenantID, fmt.Sprintf("bulk-uuid-a-%d@example.test", suffix), "enabled")
	newcomer := seedBulkVerbsSubscriber(t, f.pool, f.tenantID, fmt.Sprintf("bulk-uuid-b-%d@example.test", suffix), "enabled")

	if res := decodeBulkResult(t, f.addToList(t, "10", member)); res.Affected != 1 {
		t.Fatalf("seed add = %+v", res)
	}
	res := decodeBulkResult(t, f.addToList(t, strings.ToUpper(f.listUUID), member, newcomer))
	if res.Affected != 1 || res.Skipped != 1 || res.Exclusions["already_on_list"] != 1 {
		t.Fatalf("add by uuid = %+v, want 1 added and 1 reported already_on_list", res)
	}
	if got := f.membership(t, newcomer); !got.Exists || got.RemovedAt != nil {
		t.Fatalf("newcomer membership = %+v, want active", got)
	}
}

func TestBulkAddToListRefusesListsThisTenantDoesNotHave(t *testing.T) {
	f := newBulkListFixture(t)
	id := seedBulkVerbsSubscriber(t, f.pool, f.tenantID,
		fmt.Sprintf("bulk-unknown-list-%d@example.test", time.Now().UnixNano()), "enabled")

	// Another tenant's list: its engine id and its uuid both exist, but not here.
	otherTenant := uuid.NewString()
	seedBulkVerbsTenant(t, f.pool, otherTenant)
	otherUUID := seedBulkListIdentity(t, f.pool, otherTenant, 77)

	for _, listID := range []string{"999", "77", uuid.NewString(), otherUUID} {
		w := f.addToList(t, listID, id)
		if code := decodeBulkError(t, w, http.StatusNotFound); code != "list_not_found" {
			t.Fatalf("list_id %q: error code = %q, want list_not_found", listID, code)
		}
	}
	if got := f.membership(t, id); got.Exists {
		t.Fatalf("an unknown list produced a membership row: %+v", got)
	}
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, f.pool, f.tenantID)
	if err != nil {
		t.Fatalf("open orphan check: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var orphans int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM list_subscribers WHERE tenant_id = $1::uuid`, f.tenantID).Scan(&orphans); err != nil {
		t.Fatalf("count memberships: %v", err)
	}
	if orphans != 0 {
		t.Fatalf("memberships written for unknown lists = %d, want 0", orphans)
	}
}

func TestBulkAddToListRejectsMalformedListIDsBeforeTouchingTheDatabase(t *testing.T) {
	f := newBulkListFixture(t)
	id := seedBulkVerbsSubscriber(t, f.pool, f.tenantID,
		fmt.Sprintf("bulk-malformed-%d@example.test", time.Now().UnixNano()), "enabled")
	for _, listID := range []string{"abc", "0", "-1", " 10", "10 ", "010", "1e3", "{" + f.listUUID + "}", "urn:uuid:" + f.listUUID} {
		w := f.addToList(t, listID, id)
		if code := decodeBulkError(t, w, http.StatusBadRequest); code != "invalid_list_id" {
			t.Fatalf("list_id %q: error code = %q, want invalid_list_id", listID, code)
		}
	}
	w := f.post(t, "/api/v1/subscribers/bulk/add-to-list", fmt.Sprintf(`{"subscriber_ids":[%q]}`, id))
	if code := decodeBulkError(t, w, http.StatusBadRequest); code != "missing_list_id" {
		t.Fatalf("missing list_id: error code = %q, want missing_list_id", code)
	}
}

// TestBulkAddToListCountsUnknownAndForeignSubscribersAsMissing covers the
// other half of the old insert: it wrote unnest($3) without looking the ids up,
// so an unknown id was an FK violation (a 500) and another tenant's subscriber
// uuid passed the FK, because referential checks bypass RLS.
func TestBulkAddToListCountsUnknownAndForeignSubscribersAsMissing(t *testing.T) {
	f := newBulkListFixture(t)
	suffix := time.Now().UnixNano()
	own := seedBulkVerbsSubscriber(t, f.pool, f.tenantID, fmt.Sprintf("bulk-own-%d@example.test", suffix), "enabled")
	otherTenant := uuid.NewString()
	seedBulkVerbsTenant(t, f.pool, otherTenant)
	foreign := seedBulkVerbsSubscriber(t, f.pool, otherTenant, fmt.Sprintf("bulk-foreign-%d@example.test", suffix), "enabled")
	unknown := uuid.NewString()

	res := decodeBulkResult(t, f.addToList(t, "10", own, foreign, unknown))
	if res.Affected != 1 || res.Skipped != 2 || res.Exclusions["missing_or_outside_tenant"] != 2 || len(res.Exclusions) != 1 {
		t.Fatalf("add with foreign and unknown ids = %+v, want 1 added and exactly 2 reported missing", res)
	}
	if got := f.membership(t, foreign); got.Exists {
		t.Fatalf("another tenant's subscriber was put on this tenant's list: %+v", got)
	}
}

// TestBulkAddToListUndoUsesTheCanonicalUUID proves the receipt stores the
// resolved uuid and not the "10" the client sent: the undo removes the row,
// its owner, and cancels the welcome series the insert enrolled — all of which
// compare against the uuid.
func TestBulkAddToListUndoUsesTheCanonicalUUID(t *testing.T) {
	f := newBulkListFixture(t)
	id := seedBulkVerbsSubscriber(t, f.pool, f.tenantID,
		fmt.Sprintf("bulk-undo-uuid-%d@example.test", time.Now().UnixNano()), "enabled")
	f.exec(t, `
INSERT INTO automation_journeys (tenant_id, name, status, triggers)
VALUES ($1::uuid, 'welcome series', 'active',
        jsonb_build_array(jsonb_build_object('type', 'list_joined', 'list_id', $2::text)))`,
		f.tenantID, f.listUUID)

	added := decodeBulkResult(t, f.addToList(t, "10", id))
	if added.Affected != 1 || added.RecoveryToken == "" {
		t.Fatalf("add-to-list = %+v", added)
	}
	if queued := countFlowRuns(t, f.pool, f.tenantID, id, "queued"); queued != 1 {
		t.Fatalf("queued enrolments after add = %d, want 1 (without it the undo cannot be observed)", queued)
	}

	undone := f.recover(t, added.RecoveryToken)
	if undone.Affected != 1 || undone.Skipped != 0 {
		t.Fatalf("undo = %+v, want exactly the one membership reversed", undone)
	}
	if got := f.membership(t, id); got.Exists || got.OwnerExists {
		t.Fatalf("after undo membership=%v owner=%v, want both gone (the row was created by the add)", got.Exists, got.OwnerExists)
	}
	if left := countFlowRuns(t, f.pool, f.tenantID, id, "queued"); left != 0 {
		t.Fatalf("queued enrolments after undo = %d, want 0", left)
	}
	if cancelled := countFlowRuns(t, f.pool, f.tenantID, id, "cancelled"); cancelled != 1 {
		t.Fatalf("cancelled enrolments after undo = %d, want 1", cancelled)
	}
}

// TestBulkAddToListRevivesARemovedMemberAndUndoRestoresTheTombstone is LIST-A2:
// a contact removed from a list could never be put back with this verb.
func TestBulkAddToListRevivesARemovedMemberAndUndoRestoresTheTombstone(t *testing.T) {
	f := newBulkListFixture(t)
	id := seedBulkVerbsSubscriber(t, f.pool, f.tenantID,
		fmt.Sprintf("bulk-revive-%d@example.test", time.Now().UnixNano()), "enabled")
	originalAdded := time.Now().UTC().Add(-48 * time.Hour).Truncate(time.Microsecond)
	originalRemoved := time.Now().UTC().Add(-1 * time.Hour).Truncate(time.Microsecond)
	f.exec(t, `
INSERT INTO list_subscribers (tenant_id, list_id, subscriber_id, listmonk_list_id, source, added_at, removed_at)
VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'form', $5, $6)`,
		f.tenantID, f.listUUID, id, f.engineID, originalAdded, originalRemoved)

	added := decodeBulkResult(t, f.addToList(t, "10", id))
	if added.Affected != 1 || added.Skipped != 0 || added.RecoveryToken == "" {
		t.Fatalf("re-adding a removed member = %+v, want 1 added (it was reported as skipped and stayed removed)", added)
	}
	revived := f.membership(t, id)
	if !revived.Exists || revived.RemovedAt != nil || revived.Source != "admin" || !revived.AddedAt.After(originalAdded) {
		t.Fatalf("revived membership = %+v, want active, source admin and a new added_at", revived)
	}
	if len(f.webhooks.inputs) != 1 {
		t.Fatalf("list.subscriber.added intents for the revival = %d, want 1", len(f.webhooks.inputs))
	}

	undone := f.recover(t, added.RecoveryToken)
	if undone.Affected != 1 || undone.Skipped != 0 {
		t.Fatalf("undo of a revival = %+v, want one membership restored", undone)
	}
	restored := f.membership(t, id)
	if !restored.Exists {
		t.Fatal("undo deleted a membership that existed (removed) before the add; the record of who left is gone")
	}
	if restored.RemovedAt == nil || !restored.RemovedAt.Equal(originalRemoved) {
		t.Fatalf("restored removed_at = %v, want the original tombstone %v", restored.RemovedAt, originalRemoved)
	}
	if !restored.AddedAt.Equal(originalAdded) || restored.Source != "form" {
		t.Fatalf("restored added_at/source = %v/%q, want %v/form", restored.AddedAt, restored.Source, originalAdded)
	}
	if !restored.OwnerExists || restored.OwnerRemovedAt == nil {
		t.Fatalf("bulk owner row after undo = exists:%v removed:%v, want tombstoned", restored.OwnerExists, restored.OwnerRemovedAt)
	}
}

// TestBulkAddedMembersCanBeRemovedFromTheMembersTab pins the owner row this verb
// now writes against the operator's removal path. An owner the Members-tab
// removal does not recognise would keep the membership alive behind a 204.
func TestBulkAddedMembersCanBeRemovedFromTheMembersTab(t *testing.T) {
	f := newBulkListFixture(t)
	id := seedBulkVerbsSubscriber(t, f.pool, f.tenantID,
		fmt.Sprintf("bulk-remove-%d@example.test", time.Now().UnixNano()), "enabled")
	if res := decodeBulkResult(t, f.addToList(t, "10", id)); res.Affected != 1 {
		t.Fatalf("add = %+v", res)
	}
	removed, err := (&lists.Repo{Pool: f.pool}).RemoveMember(context.Background(), f.tenantID, f.listUUID, id)
	if err != nil || !removed {
		t.Fatalf("RemoveMember = %v, %v", removed, err)
	}
	if got := f.membership(t, id); got.RemovedAt == nil || got.OwnerRemovedAt == nil {
		t.Fatalf("after Members-tab removal membership removed_at=%v owner removed_at=%v, want both set",
			got.RemovedAt, got.OwnerRemovedAt)
	}
}
