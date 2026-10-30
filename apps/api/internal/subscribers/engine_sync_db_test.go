// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
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
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

type subscriberOutboxTestAdapter struct {
	repo *outbox.Repo
	err  error
}

func (a subscriberOutboxTestAdapter) Append(
	ctx context.Context,
	tx pgx.Tx,
	in EngineSyncOutboxAppendInput,
) (string, error) {
	if a.err != nil {
		return "", a.err
	}
	return a.repo.Append(ctx, tx, outbox.Append{
		TenantID:    in.TenantID,
		Kind:        in.Kind,
		Payload:     in.Payload,
		MaxAttempts: in.MaxAttempts,
	})
}

func (a subscriberOutboxTestAdapter) AppendMany(
	ctx context.Context,
	tx pgx.Tx,
	inputs []EngineSyncOutboxAppendInput,
) error {
	if a.err != nil {
		return a.err
	}
	batch := make([]outbox.Append, 0, len(inputs))
	for _, in := range inputs {
		batch = append(batch, outbox.Append{
			TenantID:    in.TenantID,
			Kind:        in.Kind,
			Payload:     in.Payload,
			MaxAttempts: in.MaxAttempts,
		})
	}
	return a.repo.AppendMany(ctx, tx, batch)
}

func TestEngineSyncBatchIntentCommitsAtomically(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}}
	ctx := context.Background()
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("batch intent tx: %v", err)
	}
	if err := repo.appendEngineSyncMany(ctx, tx, tenantID, ids); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("append batch intents: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit batch intents: %v", err)
	}
	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("batch verify tx: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var count, distinctSubscribers int
	if err := verify.QueryRow(ctx, `
SELECT count(*), count(DISTINCT payload ->> 'subscriber_id')
  FROM outbox_events
 WHERE tenant_id = $1::uuid AND kind = $2
   AND payload ? 'subscriber_id'
   AND NOT payload ? 'email'`, tenantID, OutboxKindListmonkSync).Scan(&count, &distinctSubscribers); err != nil {
		t.Fatalf("read batch intents: %v", err)
	}
	if count != len(ids) || distinctSubscribers != len(ids) {
		t.Fatalf("batch intents count/distinct=%d/%d, want %d/%d", count, distinctSubscribers, len(ids), len(ids))
	}

	failing := &Repo{Pool: pool, EngineSyncOutbox: subscriberOutboxTestAdapter{err: errors.New("injected batch failure")}}
	failTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("failing batch tx: %v", err)
	}
	if err := failing.appendEngineSyncMany(ctx, failTx, tenantID, []string{uuid.NewString()}); err == nil ||
		!strings.Contains(err.Error(), "append subscriber engine sync intents") {
		_ = failTx.Rollback(ctx)
		t.Fatalf("batch failure = %v, want wrapped error", err)
	}
	_ = failTx.Rollback(ctx)
}

func TestEngineSyncIntentCommitsAtomicallyAndAppendFailureRollsBack(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}}
	ctx := context.Background()
	email := "engine-outbox-" + uuid.NewString() + "@example.test"

	sub, err := repo.Upsert(ctx, tenantID, writePathCreate(email, nil))
	if err != nil {
		t.Fatalf("upsert with durable engine sync: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("inspect outbox scope: %v", err)
	}
	var kind string
	var payloadRaw []byte
	if err := tx.QueryRow(ctx, `
SELECT kind, payload
  FROM outbox_events
 WHERE tenant_id = $1::uuid
   AND kind = $2
 ORDER BY created_at DESC, id DESC
 LIMIT 1`, tenantID, OutboxKindListmonkSync).Scan(&kind, &payloadRaw); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read committed sync intent: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit intent inspection: %v", err)
	}
	var payload map[string]any
	if err := json.Unmarshal(payloadRaw, &payload); err != nil {
		t.Fatalf("decode sync payload: %v", err)
	}
	if kind != OutboxKindListmonkSync || payload["subscriber_id"] != sub.ID {
		t.Fatalf("sync intent = kind %q payload %#v; want subscriber %s", kind, payload, sub.ID)
	}
	if _, leaked := payload["email"]; leaked || strings.Contains(string(payloadRaw), email) {
		t.Fatalf("ordinary sync payload retained subscriber email: %s", payloadRaw)
	}
	rotatedEmail := "engine-outbox-rotated-" + uuid.NewString() + "@example.test"
	if _, err := repo.Update(ctx, tenantID, sub.ID, UpdateInput{Email: &rotatedEmail}); err != nil {
		t.Fatalf("rotate unmarked subscriber with durable sync: %v", err)
	}
	rotationTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("rotation intent scope: %v", err)
	}
	var rotationPayloadRaw []byte
	if err := rotationTx.QueryRow(ctx, `
SELECT payload
  FROM outbox_events
 WHERE tenant_id = $1::uuid AND kind = $2 AND payload ? 'previous_email'
 ORDER BY created_at DESC, id DESC
 LIMIT 1`, tenantID, OutboxKindListmonkSync).Scan(&rotationPayloadRaw); err != nil {
		_ = rotationTx.Rollback(ctx)
		t.Fatalf("read rotation sync intent: %v", err)
	}
	if err := rotationTx.Commit(ctx); err != nil {
		t.Fatalf("commit rotation intent inspection: %v", err)
	}
	var rotationPayload listmonkSyncPayload
	if err := json.Unmarshal(rotationPayloadRaw, &rotationPayload); err != nil {
		t.Fatalf("decode rotation sync payload: %v", err)
	}
	if rotationPayload.SubscriberID != sub.ID || rotationPayload.PreviousEmail != email || strings.Contains(string(rotationPayloadRaw), rotatedEmail) {
		t.Fatalf("rotation payload=%s; want subscriber id + strictly-needed prior email only", rotationPayloadRaw)
	}

	failing, _, failingTenantID := newWritePathTestRepo(t)
	failing.EngineSyncOutbox = subscriberOutboxTestAdapter{err: errors.New("injected append failure")}
	failingEmail := "engine-outbox-fail-" + uuid.NewString() + "@example.test"
	if _, err := failing.Upsert(ctx, failingTenantID, writePathCreate(failingEmail, nil)); err == nil || !strings.Contains(err.Error(), "append subscriber engine sync intent") {
		t.Fatalf("upsert append failure = %v; want wrapped append error", err)
	}
	if _, err := failing.Get(ctx, failingTenantID, failingEmail); !errors.Is(err, ErrNotFound) {
		t.Fatalf("subscriber committed despite append failure: %v", err)
	}
}

func TestEngineDeleteIntentCommitsWithAuditAndReconcilesIdempotently(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	email := "engine-delete-" + uuid.NewString() + "@example.test"
	sub, err := repo.Upsert(ctx, tenantID, writePathCreate(email, nil))
	if err != nil {
		t.Fatalf("seed deletion subscriber: %v", err)
	}
	secondaryEmail := "engine-delete-secondary-" + uuid.NewString() + "@example.test"
	if _, err := repo.AddEmail(ctx, tenantID, sub.ID, AddEmailInput{Email: secondaryEmail}, db.AuditMeta{
		TenantID: tenantID, ActorType: "human", ActorLabel: "deletion-test",
	}); err != nil {
		t.Fatalf("attach secondary deletion address: %v", err)
	}
	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}}
	meta := db.AuditMeta{TenantID: tenantID, ActorType: "human", ActorLabel: "deletion-test"}
	deleted, err := repo.DeleteWithAudit(ctx, tenantID, sub.ID, sub.Version, meta)
	if err != nil || deleted == nil {
		t.Fatalf("delete with durable tombstone: %#v %v", deleted, err)
	}

	inspect, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("inspect deletion commit: %v", err)
	}
	var payloadRaw, suppressionMeta []byte
	var auditCount, suppressionCount int
	if err := inspect.QueryRow(ctx, `
SELECT payload
  FROM outbox_events
 WHERE tenant_id = $1::uuid AND kind = $2
 ORDER BY created_at DESC, id DESC
 LIMIT 1`, tenantID, OutboxKindListmonkDelete).Scan(&payloadRaw); err != nil {
		_ = inspect.Rollback(ctx)
		t.Fatalf("read delete intent: %v", err)
	}
	if err := inspect.QueryRow(ctx, `
SELECT metadata
  FROM subscriber_suppressions
 WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)`, tenantID, email).Scan(&suppressionMeta); err != nil {
		_ = inspect.Rollback(ctx)
		t.Fatalf("read erasure tombstone: %v", err)
	}
	if err := inspect.QueryRow(ctx, `
SELECT count(*)
  FROM audit_log
 WHERE tenant_id = $1::uuid
   AND action = 'subscriber.deleted'
   AND resource_id = $2`, tenantID, sub.ID).Scan(&auditCount); err != nil {
		_ = inspect.Rollback(ctx)
		t.Fatalf("read deletion audit: %v", err)
	}
	if err := inspect.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_suppressions
 WHERE tenant_id = $1::uuid
   AND lower(email::text) = ANY($2::text[])`, tenantID,
		[]string{strings.ToLower(email), strings.ToLower(secondaryEmail)}).Scan(&suppressionCount); err != nil {
		_ = inspect.Rollback(ctx)
		t.Fatalf("count all address tombstones: %v", err)
	}
	if err := inspect.Commit(ctx); err != nil {
		t.Fatalf("commit deletion inspection: %v", err)
	}
	var payload listmonkDeletePayload
	if err := json.Unmarshal(payloadRaw, &payload); err != nil {
		t.Fatalf("decode delete payload: %v", err)
	}
	if payload.SubscriberID != sub.ID || strings.Contains(string(payloadRaw), email) {
		t.Fatalf("delete payload retained PII or wrong identity: %s", payloadRaw)
	}
	if !strings.Contains(string(suppressionMeta), sub.ID) || auditCount != 1 || suppressionCount != 2 {
		t.Fatalf("tombstone metadata=%s audit_count=%d address_count=%d", suppressionMeta, auditCount, suppressionCount)
	}

	engine := newSubscriberSyncFakeEngine()
	engine.seed(73, email, StatusUnconfirmed)
	handler := &ListmonkDeleteHandler{
		Repo:     repo,
		Resolver: tenantScopedTestResolver{tenantID: tenantID, engine: engine},
	}
	event := outbox.Event{TenantID: tenantID, Kind: OutboxKindListmonkDelete, Payload: payloadRaw}
	if err := handler.Handle(ctx, event); err != nil {
		t.Fatalf("reconcile external deletion: %v", err)
	}
	if engine.byID(73) != nil || engine.deleteCalls != 1 {
		t.Fatalf("external deletion state=%#v delete_calls=%d", engine.byID(73), engine.deleteCalls)
	}
	if err := handler.Handle(ctx, event); err != nil {
		t.Fatalf("idempotent deletion retry: %v", err)
	}
	if engine.deleteCalls != 1 {
		t.Fatalf("idempotent retry repeated delete: %d", engine.deleteCalls)
	}

	failing, _, failingTenantID := newWritePathTestRepo(t)
	failingEmail := "engine-delete-fail-" + uuid.NewString() + "@example.test"
	failingSub, err := failing.Upsert(ctx, failingTenantID, writePathCreate(failingEmail, nil))
	if err != nil {
		t.Fatalf("seed failing delete subscriber: %v", err)
	}
	failing.EngineSyncOutbox = subscriberOutboxTestAdapter{err: errors.New("injected delete append failure")}
	if _, err := failing.Delete(ctx, failingTenantID, failingSub.ID); err == nil ||
		!strings.Contains(err.Error(), "append subscriber engine delete intent") {
		t.Fatalf("delete append failure=%v", err)
	}
	if _, err := failing.Get(ctx, failingTenantID, failingSub.ID); err != nil {
		t.Fatalf("subscriber erased despite delete-intent failure: %v", err)
	}
}

func TestDeleteHandlerRequiresExactRevisionAndDefersExternalMutation(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	email := "handler-delete-" + uuid.NewString() + "@example.test"
	sub, err := repo.Upsert(ctx, tenantID, writePathCreate(email, nil))
	if err != nil {
		t.Fatalf("seed handler deletion subscriber: %v", err)
	}
	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}}
	engine := newSubscriberSyncFakeEngine()
	engine.seed(81, email, StatusUnconfirmed)
	deps := &Deps{Repo: repo, Engine: engine}
	router := chi.NewRouter()
	router.Delete("/api/v1/subscribers/{id}", deps.Delete)

	request := func(ifMatch string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		req := tenantRequest(http.MethodDelete, "/api/v1/subscribers/"+sub.ID, "", "", tenantID)
		if ifMatch != "" {
			req.Header.Set("If-Match", ifMatch)
		}
		router.ServeHTTP(recorder, req)
		return recorder
	}
	if rec := request(""); rec.Code != http.StatusPreconditionRequired {
		t.Fatalf("missing delete precondition=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := request("*"); rec.Code != http.StatusPreconditionRequired {
		t.Fatalf("wildcard delete precondition=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := request(`"subscriber:` + sub.ID + `:v0"`); rec.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale delete precondition=%d body=%s", rec.Code, rec.Body.String())
	}
	if _, err := repo.Get(ctx, tenantID, sub.ID); err != nil {
		t.Fatalf("precondition failure mutated subscriber: %v", err)
	}
	if engine.totalCalls() != 0 {
		t.Fatalf("precondition failure touched external engine: %d", engine.totalCalls())
	}
	if rec := request(sub.Version); rec.Code != http.StatusNoContent {
		t.Fatalf("exact delete precondition=%d body=%s", rec.Code, rec.Body.String())
	}
	if _, err := repo.Get(ctx, tenantID, sub.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("exact delete left subscriber: %v", err)
	}
	if engine.totalCalls() != 0 || engine.byID(81) == nil {
		t.Fatalf("handler mutated engine before outbox: calls=%d state=%#v", engine.totalCalls(), engine.byID(81))
	}
}

func TestEngineSyncAppendFailureRollsBackUpdateStatusAndSuppression(t *testing.T) {
	repo, _, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	email := "engine-outbox-rollback-" + uuid.NewString() + "@example.test"
	seeded, err := repo.Upsert(ctx, tenantID, writePathCreate(email, nil))
	if err != nil {
		t.Fatalf("seed rollback subscriber: %v", err)
	}
	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{err: errors.New("injected append failure")}

	disabled := StatusDisabled
	if _, err := repo.Update(ctx, tenantID, seeded.ID, UpdateInput{Status: &disabled}); err == nil {
		t.Fatal("Update committed despite engine-sync append failure")
	}
	afterUpdate, err := repo.Get(ctx, tenantID, seeded.ID)
	if err != nil || afterUpdate.Status != StatusUnconfirmed {
		t.Fatalf("Update rollback state=%#v err=%v; want unconfirmed", afterUpdate, err)
	}

	if _, err := repo.SetStatus(ctx, tenantID, seeded.ID, StatusBlocklisted); err == nil {
		t.Fatal("SetStatus committed despite engine-sync append failure")
	}
	afterStatus, err := repo.Get(ctx, tenantID, seeded.ID)
	if err != nil || afterStatus.Status != StatusUnconfirmed {
		t.Fatalf("SetStatus rollback state=%#v err=%v; want unconfirmed", afterStatus, err)
	}

	if _, err := repo.CreateSuppression(ctx, tenantID, CreateSuppressionInput{
		Email: email, Reason: "manual", Source: "test",
	}); err == nil {
		t.Fatal("CreateSuppression committed despite engine-sync append failure")
	}
	afterSuppression, err := repo.Get(ctx, tenantID, seeded.ID)
	if err != nil || afterSuppression.Status != StatusUnconfirmed {
		t.Fatalf("suppression rollback state=%#v err=%v; want unconfirmed", afterSuppression, err)
	}
	page, err := repo.ListSuppressions(ctx, tenantID, email, "", "", 1, 10)
	if err != nil {
		t.Fatalf("list suppressions after rollback: %v", err)
	}
	if page.Total != 0 {
		t.Fatalf("suppression row committed despite append failure: %#v", page.Items)
	}
}

func TestDurableHandlersNeverCallEngineBeforeCommitAndCoverBatchBulkSuppression(t *testing.T) {
	repo, pool, tenantID := newWritePathTestRepo(t)
	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}}
	engine := newSubscriberSyncFakeEngine()
	deps := &Deps{Repo: repo, Engine: engine}

	createEmail := "durable-create-" + uuid.NewString() + "@example.test"
	createRec := httptest.NewRecorder()
	deps.Create(createRec, tenantRequest(http.MethodPost, "/api/v1/subscribers",
		fmt.Sprintf(`{"email":%q}`, createEmail), "application/json", tenantID))
	if createRec.Code != http.StatusCreated {
		t.Fatalf("durable create status=%d body=%s", createRec.Code, createRec.Body.String())
	}

	batchEmails := []string{
		"durable-batch-" + uuid.NewString() + "@example.test",
		"durable-batch-" + uuid.NewString() + "@example.test",
	}
	batchRec := httptest.NewRecorder()
	deps.BatchUpsert(batchRec, tenantRequest(http.MethodPost, "/api/v1/subscribers/batch",
		fmt.Sprintf(`{"subscribers":[{"email":%q},{"email":%q}]}`, batchEmails[0], batchEmails[1]),
		"application/json", tenantID))
	if batchRec.Code != http.StatusOK || strings.Contains(batchRec.Body.String(), `"status":"error"`) {
		t.Fatalf("durable batch status=%d body=%s", batchRec.Code, batchRec.Body.String())
	}

	pasteEmails := []string{
		"durable-paste-" + uuid.NewString() + "@example.test",
		"durable-paste-" + uuid.NewString() + "@example.test",
	}
	pasteRec := httptest.NewRecorder()
	deps.BulkPaste(pasteRec, tenantRequest(http.MethodPost, "/api/v1/subscribers/bulk-paste",
		fmt.Sprintf(`{"emails":%q}`, strings.Join(pasteEmails, "\n")), "application/json", tenantID))
	if pasteRec.Code != http.StatusOK || strings.Contains(pasteRec.Body.String(), `"status":"error"`) {
		t.Fatalf("durable bulk paste status=%d body=%s", pasteRec.Code, pasteRec.Body.String())
	}
	csvEmail := "durable-csv-" + uuid.NewString() + "@example.test"
	csvRec := httptest.NewRecorder()
	deps.ImportCSV(csvRec, tenantRequest(http.MethodPost, "/api/v1/subscribers/import",
		"email\n"+csvEmail+"\n", "text/csv", tenantID))
	if csvRec.Code != http.StatusOK || strings.Contains(csvRec.Body.String(), `"status":"error"`) {
		t.Fatalf("durable CSV import status=%d body=%s", csvRec.Code, csvRec.Body.String())
	}

	suppressRouter := chi.NewRouter()
	suppressRouter.Post("/api/v1/subscribers/{id}/suppress", deps.Suppress)
	suppressRec := httptest.NewRecorder()
	suppressReq := tenantRequest(http.MethodPost, "/api/v1/subscribers/"+createEmail+"/suppress",
		`{"reason":"manual"}`, "application/json", tenantID)
	if version := createRec.Header().Get("ETag"); version == "" {
		t.Fatal("durable create response omitted the subscriber ETag")
	} else {
		suppressReq.Header.Set("If-Match", version)
	}
	suppressRouter.ServeHTTP(suppressRec, suppressReq)
	if suppressRec.Code != http.StatusNoContent {
		t.Fatalf("durable suppression status=%d body=%s", suppressRec.Code, suppressRec.Body.String())
	}

	if got := engine.totalCalls(); got != 0 {
		t.Fatalf("durable handler path called external engine before local commit: %d calls", got)
	}
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("intent count scope: %v", err)
	}
	var intents int
	if err := tx.QueryRow(context.Background(), `
SELECT count(*) FROM outbox_events
 WHERE tenant_id = $1::uuid AND kind = $2`, tenantID, OutboxKindListmonkSync).Scan(&intents); err != nil {
		_ = tx.Rollback(context.Background())
		t.Fatalf("count sync intents: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit intent count: %v", err)
	}
	// create + 2 batch + 2 bulk-paste + 1 CSV + suppression.
	if intents != 7 {
		t.Fatalf("sync intents=%d; want 7 covering create/batch/bulk/CSV/suppression", intents)
	}
}

func TestListmonkSyncHandlerRetryStaleStateRotationAndMarkerPersistence(t *testing.T) {
	repo, _, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	oldEmail := "engine-legacy-" + uuid.NewString() + "@example.test"
	sub, err := repo.Upsert(ctx, tenantID, writePathCreate(oldEmail, nil))
	if err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}

	// Simulate the crash window: Listmonk accepted the earlier create but the
	// worker died before the local _listmonk_id marker committed.
	engine := newSubscriberSyncFakeEngine()
	engine.seed(77, oldEmail, StatusDisabled)
	handler := tenantScopedTestSyncHandler(repo, tenantID, engine)
	if err := handler.Handle(ctx, syncEvent(t, tenantID, sub.ID, "")); err != nil {
		t.Fatalf("reconcile crash-window record: %v", err)
	}
	marked, err := repo.Get(ctx, tenantID, sub.ID)
	if err != nil {
		t.Fatalf("get marker: %v", err)
	}
	if got := listmonkIDFromCustomFields(marked.CustomFields); got != 77 {
		t.Fatalf("persisted listmonk id=%d; want 77", got)
	}
	if !marked.UpdatedAt.Equal(sub.UpdatedAt) {
		t.Fatalf("internal listmonk marker invalidated subscriber ETag: before=%s after=%s", sub.UpdatedAt, marked.UpdatedAt)
	}
	if engine.createCalls != 0 || engine.findCalls != 1 || engine.updateCalls != 1 {
		t.Fatalf("crash-window calls find=%d create=%d update=%d", engine.findCalls, engine.createCalls, engine.updateCalls)
	}
	// A duplicate delivery is idempotent and uses the marker; it cannot create.
	if err := handler.Handle(ctx, syncEvent(t, tenantID, sub.ID, "")); err != nil {
		t.Fatalf("retry marked record: %v", err)
	}
	if engine.createCalls != 0 || engine.updateCalls != 2 {
		t.Fatalf("retry was not idempotent: create=%d update=%d", engine.createCalls, engine.updateCalls)
	}

	// Rotate locally and change state after an event was conceptually emitted.
	// The worker must load this latest state, not replay the old event snapshot.
	newEmail := "engine-current-" + uuid.NewString() + "@example.test"
	newStatus := StatusBlocklisted
	newTags := []string{"current", "vip"}
	newColor := map[string]any{"favorite_color": "violet", listmonkIDField: "77"}
	updated, err := repo.Update(ctx, tenantID, sub.ID, UpdateInput{
		Email:        &newEmail,
		Status:       &newStatus,
		Tags:         newTags,
		CustomFields: newColor,
	})
	if err != nil {
		t.Fatalf("rotate canonical subscriber: %v", err)
	}
	if err := handler.Handle(ctx, syncEvent(t, tenantID, sub.ID, oldEmail)); err != nil {
		t.Fatalf("reconcile stale event to current state: %v", err)
	}
	external := engine.byID(77)
	if external == nil || external.Email != newEmail || external.Status != StatusBlocklisted {
		t.Fatalf("external state=%#v; want latest email/status", external)
	}
	if fmt.Sprint(external.Tags) != fmt.Sprint(newTags) || external.Attribs["favorite_color"] != "violet" {
		t.Fatalf("external tags/attribs=%#v/%#v; want latest canonical values", external.Tags, external.Attribs)
	}
	if _, leaked := external.Attribs[listmonkIDField]; leaked {
		t.Fatalf("internal listmonk marker leaked into external attribs: %#v", external.Attribs)
	}
	if updated.Email != newEmail {
		t.Fatalf("local update did not rotate email: %#v", updated)
	}
}

func TestListmonkSyncHandlerWithholdsArchivedSubscriber(t *testing.T) {
	repo, _, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	sub, err := repo.Upsert(ctx, tenantID, writePathCreate("engine-archived-"+uuid.NewString()+"@example.test", nil))
	if err != nil {
		t.Fatalf("seed archived subscriber: %v", err)
	}
	archived, err := repo.Archive(ctx, tenantID, sub.ID, sub.Version, db.AuditMeta{ActorType: "system", ActorLabel: "engine-archive-test"})
	if err != nil {
		t.Fatalf("archive subscriber: %v", err)
	}
	if archived.ArchivedAt == nil {
		t.Fatal("archive projection missing")
	}

	engine := newSubscriberSyncFakeEngine()
	handler := tenantScopedTestSyncHandler(repo, tenantID, engine)
	if err := handler.Handle(ctx, syncEvent(t, tenantID, sub.ID, "")); err != nil {
		t.Fatalf("reconcile archived subscriber: %v", err)
	}
	external := engine.byID(100)
	if external == nil || external.Status != StatusBlocklisted {
		t.Fatalf("archived external state = %#v, want status %q", external, StatusBlocklisted)
	}
}

func TestListmonkSyncHandlerRotatesLegacyMissingMarkerAndIgnoresDeletedStaleEvent(t *testing.T) {
	repo, _, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	oldEmail := "engine-unmarked-old-" + uuid.NewString() + "@example.test"
	sub, err := repo.Upsert(ctx, tenantID, writePathCreate(oldEmail, nil))
	if err != nil {
		t.Fatalf("seed legacy subscriber: %v", err)
	}
	newEmail := "engine-unmarked-new-" + uuid.NewString() + "@example.test"
	if _, err := repo.Update(ctx, tenantID, sub.ID, UpdateInput{Email: &newEmail}); err != nil {
		t.Fatalf("rotate unmarked local subscriber: %v", err)
	}
	engine := newSubscriberSyncFakeEngine()
	engine.seed(91, oldEmail, StatusDisabled)
	handler := tenantScopedTestSyncHandler(repo, tenantID, engine)
	if err := handler.Handle(ctx, syncEvent(t, tenantID, sub.ID, oldEmail)); err != nil {
		t.Fatalf("rotate legacy external subscriber: %v", err)
	}
	if engine.createCalls != 0 || engine.byID(91).Email != newEmail {
		t.Fatalf("legacy rotation created duplicate or missed email: create=%d state=%#v", engine.createCalls, engine.byID(91))
	}

	deleted, err := repo.Delete(ctx, tenantID, sub.ID)
	if err != nil || deleted == nil {
		t.Fatalf("delete local subscriber: %#v %v", deleted, err)
	}
	callsBefore := engine.totalCalls()
	if err := handler.Handle(ctx, syncEvent(t, tenantID, sub.ID, oldEmail)); err != nil {
		t.Fatalf("stale post-delete event: %v", err)
	}
	if engine.totalCalls() != callsBefore {
		t.Fatalf("stale event recreated or touched external state after local deletion")
	}
}

func TestListmonkSyncHandlerSerializesConcurrentFirstDelivery(t *testing.T) {
	repo, _, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	email := "engine-concurrent-" + uuid.NewString() + "@example.test"
	sub, err := repo.Upsert(ctx, tenantID, writePathCreate(email, nil))
	if err != nil {
		t.Fatalf("seed concurrent subscriber: %v", err)
	}
	engine := newSubscriberSyncFakeEngine()
	handler := tenantScopedTestSyncHandler(repo, tenantID, engine)
	event := syncEvent(t, tenantID, sub.ID, "")

	start := make(chan struct{})
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			errs <- handler.Handle(context.Background(), event)
		}()
	}
	close(start)
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent sync %d: %v", i, err)
		}
	}
	if engine.createCalls != 1 {
		t.Fatalf("concurrent first deliveries created %d external rows; want exactly 1", engine.createCalls)
	}
	marked, err := repo.Get(ctx, tenantID, sub.ID)
	if err != nil || listmonkIDFromCustomFields(marked.CustomFields) <= 0 {
		t.Fatalf("concurrent delivery marker missing: sub=%#v err=%v", marked, err)
	}
}

func TestListmonkSyncHandlerDoesNotPersistUpstreamPIIInErrors(t *testing.T) {
	repo, _, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	email := "engine-error-redaction-" + uuid.NewString() + "@example.test"
	sub, err := repo.Upsert(ctx, tenantID, writePathCreate(email, nil))
	if err != nil {
		t.Fatalf("seed error-redaction subscriber: %v", err)
	}
	upstreamDetail := "provider lookup failed for " + email + " using secret-token-value"
	engine := &subscriberSyncPIIErrorEngine{
		subscriberSyncFakeEngine: newSubscriberSyncFakeEngine(),
		err:                      errors.New(upstreamDetail),
	}
	handler := tenantScopedTestSyncHandler(repo, tenantID, engine)
	err = handler.Handle(ctx, syncEvent(t, tenantID, sub.ID, ""))
	if err == nil {
		t.Fatal("upstream lookup failure unexpectedly reconciled")
	}
	if got := err.Error(); got != "subscriber engine sync could not resolve external state" ||
		strings.Contains(got, email) || strings.Contains(got, "secret-token-value") {
		t.Fatalf("handler exposed persistence/log-unsafe upstream detail: %q", got)
	}
}

func TestGlobalListmonkResolverFailsClosedForTwoTenantsWithSameEmail(t *testing.T) {
	repo, pool, firstTenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	sharedEmail := "engine-cross-tenant-" + uuid.NewString() + "@example.test"
	first, err := repo.Upsert(ctx, firstTenantID, writePathCreate(sharedEmail, nil))
	if err != nil {
		t.Fatalf("seed first-tenant subscriber: %v", err)
	}
	engine := newSubscriberSyncFakeEngine()
	resolver := &SingleTenantGlobalEngineResolver{Pool: pool, Engine: engine}

	secondTenantID := uuid.NewString()
	secondTx, err := db.WithTenant(ctx, pool, secondTenantID)
	if err != nil {
		t.Fatalf("second tenant scope: %v", err)
	}
	if _, err := secondTx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier, custom_fields_mode)
VALUES ($1::uuid, 'engine-cross-tenant-test', $2, 'studio', 'strict')`,
		secondTenantID, "engine-cross-tenant-"+strings.ReplaceAll(secondTenantID, "-", "")); err != nil {
		_ = secondTx.Rollback(ctx)
		t.Fatalf("seed second tenant: %v", err)
	}
	if err := secondTx.Commit(ctx); err != nil {
		t.Fatalf("commit second tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupTx, cleanupErr := db.WithTenant(context.Background(), pool, secondTenantID)
		if cleanupErr == nil {
			_, _ = cleanupTx.Exec(context.Background(), `DELETE FROM tenants WHERE id = $1::uuid`, secondTenantID)
			_ = cleanupTx.Commit(context.Background())
		}
	})
	second, err := repo.Upsert(ctx, secondTenantID, writePathCreate(sharedEmail, nil))
	if err != nil {
		t.Fatalf("seed same email in second tenant: %v", err)
	}

	handler := &ListmonkSyncHandler{Repo: repo, Resolver: resolver}
	for _, event := range []outbox.Event{
		syncEvent(t, firstTenantID, first.ID, ""),
		syncEvent(t, secondTenantID, second.ID, ""),
	} {
		err := handler.Handle(ctx, event)
		if !errors.Is(err, ErrGlobalEngineRequiresSingleTenant) {
			t.Fatalf("multi-tenant global sync error=%v; want stable fail-closed sentinel", err)
		}
	}
	if calls := engine.totalCalls(); calls != 0 {
		t.Fatalf("global Listmonk engine received %d calls for same email across two tenants; want zero", calls)
	}
}

func TestSingleTenantGlobalResolverRechecksAndLocksTenantCreation(t *testing.T) {
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if adminURL == "" || appURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL and DATABASE_URL are required for global-engine lock proof")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect admin guard fixture: %v", err)
	}
	defer func() { _ = admin.Close(context.Background()) }()
	schema := "subscriber_engine_guard_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quotedSchema := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+quotedSchema); err != nil {
		t.Fatalf("create guard schema: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+quotedSchema+" CASCADE")
	})
	if _, err := admin.Exec(ctx, `
CREATE TABLE `+quotedSchema+`.tenants (id uuid PRIMARY KEY);
GRANT USAGE ON SCHEMA `+quotedSchema+` TO postwave_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON `+quotedSchema+`.tenants TO postwave_app;
ALTER TABLE `+quotedSchema+`.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE `+quotedSchema+`.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_worker_select ON `+quotedSchema+`.tenants
    AS PERMISSIVE FOR SELECT TO postwave_app
    USING (current_setting('app.outbox_worker', true) = 'true');`); err != nil {
		t.Fatalf("create guard table/policy: %v", err)
	}
	soleTenantID := uuid.NewString()
	if _, err := admin.Exec(ctx, `INSERT INTO `+quotedSchema+`.tenants (id) VALUES ($1::uuid)`, soleTenantID); err != nil {
		t.Fatalf("seed sole guard tenant: %v", err)
	}

	appConfig, err := pgxpool.ParseConfig(appURL)
	if err != nil {
		t.Fatalf("parse app guard URL: %v", err)
	}
	appConfig.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	appPool, err := pgxpool.NewWithConfig(ctx, appConfig)
	if err != nil {
		t.Fatalf("connect app guard pool: %v", err)
	}
	defer appPool.Close()
	engine := newSubscriberSyncFakeEngine()
	resolver := &SingleTenantGlobalEngineResolver{Pool: appPool, Engine: engine}
	lease, err := resolver.Acquire(ctx, soleTenantID)
	if err != nil {
		t.Fatalf("acquire sole-tenant global engine proof: %v", err)
	}

	secondTenantID := uuid.NewString()
	insertDone := make(chan error, 1)
	go func() {
		_, insertErr := admin.Exec(context.Background(),
			`INSERT INTO `+quotedSchema+`.tenants (id) VALUES ($1::uuid)`, secondTenantID)
		insertDone <- insertErr
	}()
	select {
	case insertErr := <-insertDone:
		t.Fatalf("tenant creation escaped the active global-engine proof lock: %v", insertErr)
	case <-time.After(100 * time.Millisecond):
		// Expected: ROW EXCLUSIVE waits behind the resolver's SHARE lock.
	}
	if err := lease.Close(); err != nil {
		t.Fatalf("release sole-tenant global engine proof: %v", err)
	}
	select {
	case insertErr := <-insertDone:
		if insertErr != nil {
			t.Fatalf("tenant creation after proof release: %v", insertErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("tenant creation remained blocked after engine proof release")
	}
	if _, err := resolver.Acquire(ctx, soleTenantID); !errors.Is(err, ErrGlobalEngineRequiresSingleTenant) {
		t.Fatalf("resolver reused stale single-tenant proof after tenant creation: %v", err)
	}
	if calls := engine.totalCalls(); calls != 0 {
		t.Fatalf("tenancy proof unexpectedly called external engine %d times", calls)
	}
}

func syncEvent(t *testing.T, tenantID, subscriberID, previousEmail string) outbox.Event {
	t.Helper()
	payload, err := json.Marshal(listmonkSyncPayload{SubscriberID: subscriberID, PreviousEmail: previousEmail})
	if err != nil {
		t.Fatalf("marshal sync event: %v", err)
	}
	return outbox.Event{
		ID:       uuid.NewString(),
		TenantID: tenantID,
		Kind:     OutboxKindListmonkSync,
		Payload:  payload,
	}
}

func tenantScopedTestSyncHandler(repo *Repo, tenantID string, engine Engine) *ListmonkSyncHandler {
	return &ListmonkSyncHandler{
		Repo:     repo,
		Resolver: tenantScopedTestResolver{tenantID: tenantID, engine: engine},
	}
}

type tenantScopedTestResolver struct {
	tenantID string
	engine   Engine
}

func (r tenantScopedTestResolver) Acquire(_ context.Context, tenantID string) (EngineLease, error) {
	if tenantID != r.tenantID {
		return nil, errors.New("test tenant engine not found")
	}
	return staticEngineLease{engine: r.engine}, nil
}

type staticEngineLease struct{ engine Engine }

func (l staticEngineLease) Engine() Engine { return l.engine }
func (staticEngineLease) Close() error     { return nil }

type subscriberSyncFakeEngine struct {
	mu sync.Mutex

	nextID      int64
	byIDRows    map[int64]*listmonk.Subscriber
	findCalls   int
	createCalls int
	updateCalls int
	deleteCalls int
}

type subscriberSyncPIIErrorEngine struct {
	*subscriberSyncFakeEngine
	err error
}

func (e *subscriberSyncPIIErrorEngine) FindSubscriberByEmail(context.Context, string) (*listmonk.Subscriber, error) {
	return nil, e.err
}

func newSubscriberSyncFakeEngine() *subscriberSyncFakeEngine {
	return &subscriberSyncFakeEngine{nextID: 100, byIDRows: make(map[int64]*listmonk.Subscriber)}
}

func (e *subscriberSyncFakeEngine) seed(id int64, email, status string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.byIDRows[id] = &listmonk.Subscriber{ID: id, Email: email, Status: status, Attribs: map[string]any{}}
	if id >= e.nextID {
		e.nextID = id + 1
	}
}

func (e *subscriberSyncFakeEngine) CreateSubscriber(_ context.Context, req listmonk.CreateSubscriberReq) (*listmonk.Subscriber, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.createCalls++
	for _, row := range e.byIDRows {
		if strings.EqualFold(row.Email, req.Email) {
			return nil, &listmonk.HTTPError{StatusCode: http.StatusConflict}
		}
	}
	id := e.nextID
	e.nextID++
	e.byIDRows[id] = &listmonk.Subscriber{
		ID: id, Email: req.Email, Name: req.Name, Status: req.Status,
		Attribs: cloneAnyMap(req.Attribs), Tags: append([]string(nil), req.Tags...),
	}
	copy := *e.byIDRows[id]
	return &copy, nil
}

func (e *subscriberSyncFakeEngine) UpdateSubscriberStatus(_ context.Context, id int64, req listmonk.UpdateSubscriberStatusReq) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.updateCalls++
	row := e.byIDRows[id]
	if row == nil {
		return &listmonk.HTTPError{StatusCode: http.StatusNotFound}
	}
	row.Email = req.Email
	row.Name = req.Name
	row.Status = req.Status
	row.Attribs = cloneAnyMap(req.Attribs)
	row.Tags = append([]string(nil), req.Tags...)
	return nil
}

func (e *subscriberSyncFakeEngine) FindSubscriberByEmail(_ context.Context, email string) (*listmonk.Subscriber, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.findCalls++
	ids := make([]int, 0, len(e.byIDRows))
	for id := range e.byIDRows {
		ids = append(ids, int(id))
	}
	sort.Ints(ids)
	for _, rawID := range ids {
		row := e.byIDRows[int64(rawID)]
		if strings.EqualFold(row.Email, email) {
			copy := *row
			copy.Attribs = cloneAnyMap(row.Attribs)
			copy.Tags = append([]string(nil), row.Tags...)
			return &copy, nil
		}
	}
	return nil, nil
}

func (e *subscriberSyncFakeEngine) DeleteSubscriber(_ context.Context, id int64) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.deleteCalls++
	if e.byIDRows[id] == nil {
		return &listmonk.HTTPError{StatusCode: http.StatusNotFound}
	}
	delete(e.byIDRows, id)
	return nil
}

func (e *subscriberSyncFakeEngine) byID(id int64) *listmonk.Subscriber {
	e.mu.Lock()
	defer e.mu.Unlock()
	row := e.byIDRows[id]
	if row == nil {
		return nil
	}
	copy := *row
	copy.Attribs = cloneAnyMap(row.Attribs)
	copy.Tags = append([]string(nil), row.Tags...)
	return &copy
}

func (e *subscriberSyncFakeEngine) totalCalls() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.findCalls + e.createCalls + e.updateCalls + e.deleteCalls
}

func cloneAnyMap(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}
