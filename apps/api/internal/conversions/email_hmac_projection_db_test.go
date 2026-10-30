// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func seedProjectionKey(
	t *testing.T,
	pool *db.Pool,
	tenantID, secret string,
) string {
	t.Helper()
	keyID := strings.ReplaceAll(uuid.NewString(), "-", "")
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	envelope, err := signedIngestTestEnvelope().Encrypt(
		context.Background(), []byte(secret),
	)
	if err != nil {
		t.Fatalf("encrypt projection key: %v", err)
	}
	if _, err := tx.Exec(context.Background(), `
INSERT INTO conversion_ingest_secrets (
    tenant_id, key_id, label, secret, secret_envelope, secret_kms_key_arn
)
VALUES ($1::uuid, $2, 'projection-test', $3, $4, $5)`, tenantID, keyID,
		ingestSecretEnvelopeSentinel, envelope, testConversionKMSKeyARN); err != nil {
		t.Fatalf("seed projection key: %v", err)
	}
	if err := tx.Commit(context.Background()); err != nil {
		t.Fatalf("commit projection key: %v", err)
	}
	return keyID
}

func insertProjectionKeyInTransaction(
	ctx context.Context,
	tx pgx.Tx,
	secret string,
) (string, error) {
	keyID := strings.ReplaceAll(uuid.NewString(), "-", "")
	envelope, err := signedIngestTestEnvelope().Encrypt(ctx, []byte(secret))
	if err != nil {
		return "", err
	}
	_, err = tx.Exec(ctx, `
INSERT INTO conversion_ingest_secrets (
    tenant_id, key_id, label, secret, secret_envelope, secret_kms_key_arn
)
VALUES (current_setting('app.tenant_id')::uuid, $1, 'projection-race-test', $2, $3, $4)`,
		keyID, ingestSecretEnvelopeSentinel, envelope, testConversionKMSKeyARN)
	if err != nil {
		return "", err
	}
	return keyID, nil
}

func projectionStatus(
	t *testing.T,
	pool *db.Pool,
	tenantID, keyID string,
) ProjectionMetadata {
	t.Helper()
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	metadata, err := loadProjectionMetadata(context.Background(), tx, tenantID, keyID)
	if err != nil {
		t.Fatalf("load projection status: %v", err)
	}
	return metadata
}

func assertProjectionBinding(
	t *testing.T,
	pool *db.Pool,
	tenantID, keyID, digest, subscriberID string,
) {
	t.Helper()
	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("open binding assertion: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var got string
	if err := tx.QueryRow(context.Background(), `
SELECT subscriber_id::text
  FROM conversion_email_hmac_bindings
 WHERE tenant_id = $1::uuid AND key_id = $2 AND digest = $3`,
		tenantID, keyID, digest).Scan(&got); err != nil {
		t.Fatalf("read exact projection binding: %v", err)
	}
	if got != subscriberID {
		t.Fatalf("projection binding subscriber = %q, want %q", got, subscriberID)
	}
}

func TestEmailHMACProjectionDatabaseRejectsNewPlaintextSigningKeys(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO conversion_ingest_secrets (tenant_id, key_id, label, secret)
VALUES ($1::uuid, $2, 'plaintext-must-fail', 'plaintext-must-never-persist')`,
		tenantID, strings.ReplaceAll(uuid.NewString(), "-", ""))
	if err == nil || !strings.Contains(err.Error(), "envelope") {
		t.Fatalf("plaintext signing-key insert = %v, want envelope-required rejection", err)
	}
}

func TestEmailHMACProjectionDatabaseRejectsFalseKMSProvenanceOnLegacyEnvelope(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx, `
INSERT INTO conversion_ingest_secrets (
    tenant_id, key_id, label, secret, secret_envelope, secret_kms_key_arn
) VALUES (
    $1::uuid, $2, 'legacy-static-must-fail', 'envelope:do-not-use',
    decode('0100', 'hex'), $3
)`, tenantID, strings.ReplaceAll(uuid.NewString(), "-", ""), testConversionKMSKeyARN)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.ConstraintName != "conversion_ingest_secret_envelope_required" {
		t.Fatalf("legacy-static envelope insert = %v, want exact-KMS envelope constraint", err)
	}
}

func TestEmailHMACProjectionFailureMetadataAndIngestAreClosed(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	secret := "projection-closed-failure-secret-at-least-32"
	keyID := seedProjectionKey(t, pool, tenantID, secret)
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE conversion_email_hmac_projection_tasks
   SET attempt_count = $3
 WHERE tenant_id = $1::uuid AND key_id = $2`, tenantID, keyID,
		DefaultProjectionMaxAttempts-1); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("prepare terminal attempt: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit terminal attempt: %v", err)
	}
	repository, err := NewEmailHMACProjectionRepository(pool)
	if err != nil {
		t.Fatalf("repository: %v", err)
	}
	claims, err := repository.Claim(ctx, "closed-failure", 1, time.Minute)
	if err != nil || len(claims) != 1 || claims[0].Attempt != DefaultProjectionMaxAttempts {
		t.Fatalf("terminal claim = %+v, %v", claims, err)
	}
	if err := repository.RecordFailure(
		ctx, claims[0], ProjectionErrorSecretUnavailable, time.Hour,
	); err != nil {
		t.Fatalf("record closed failure: %v", err)
	}
	metadata := projectionStatus(t, pool, tenantID, keyID)
	if metadata.Status != ProjectionStatusFailed ||
		metadata.ErrorCode != ProjectionErrorSecretUnavailable || metadata.UpdatedAt.IsZero() {
		t.Fatalf("failed metadata = %+v", metadata)
	}
	listed, err := (&IngestSecretStore{Pool: pool}).List(ctx, tenantID)
	if err != nil || len(listed) != 1 ||
		listed[0].Status != ProjectionStatusFailed ||
		listed[0].ErrorCode != ProjectionErrorSecretUnavailable {
		t.Fatalf("closed list metadata = %+v, %v", listed, err)
	}

	now := time.Now().UTC()
	body := []byte(`{"event_name":"purchase","identity":{"email_hmac_sha256":"` +
		EmailIdentityHMAC(secret, "unknown@example.test") + `"}}`)
	response := httptestResponse(signedRouter(pool, now), signedRequest(t,
		"/api/public/conversions/ingest", secret, keyID,
		"idem-"+uuid.NewString(), body, now))
	if response.code != http.StatusServiceUnavailable ||
		!strings.Contains(response.body, "email_identity_projection_not_ready") {
		t.Fatalf("failed projection ingest = %d %s", response.code, response.body)
	}
}

func TestEmailHMACProjectionRotationMutationAndCrossTenantIsolation(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantA := createAttributionTenant(t, pool, ctx)
	tenantB := createAttributionTenant(t, pool, ctx)
	secretA1 := "projection-secret-a1-at-least-32-bytes"
	secretA2 := "projection-secret-a2-at-least-32-bytes"
	secretB := "projection-secret-b1-at-least-32-bytes"
	keyA1 := seedProjectionKey(t, pool, tenantA, secretA1)
	keyA2 := seedProjectionKey(t, pool, tenantA, secretA2)
	keyB := seedProjectionKey(t, pool, tenantB, secretB)

	if status := projectionStatus(t, pool, tenantA, keyA1); status.Status != ProjectionStatusPending {
		t.Fatalf("new key status = %+v, want pending", status)
	}
	drainEmailHMACProjection(t, pool)

	emailA := "first@example.test"
	subscriberA := seedIdentitySubscriber(t, pool, ctx, tenantA, emailA, "")
	emailB := "other@example.test"
	_ = seedIdentitySubscriber(t, pool, ctx, tenantB, emailB, "")
	for _, key := range []string{keyA1, keyA2} {
		if status := projectionStatus(t, pool, tenantA, key); status.Status != ProjectionStatusReady {
			t.Fatalf("projected key %s status = %+v", key, status)
		}
	}

	assertBinding := func(tenantID, keyID, digest, wantSubscriber string, want bool) {
		t.Helper()
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("WithTenant: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		var subscriberID string
		err = tx.QueryRow(ctx, `
SELECT subscriber_id::text
  FROM conversion_email_hmac_bindings
 WHERE tenant_id = $1::uuid AND key_id = $2 AND digest = $3`,
			tenantID, keyID, digest).Scan(&subscriberID)
		if want && err != nil {
			t.Fatalf("binding (%s,%s) absent: %v", keyID, digest, err)
		}
		if !want && err == nil {
			t.Fatalf("unexpected binding (%s,%s) -> %s", keyID, digest, subscriberID)
		}
		if want && subscriberID != wantSubscriber {
			t.Fatalf("binding subscriber = %s, want %s", subscriberID, wantSubscriber)
		}
	}
	assertBinding(tenantA, keyA1, EmailIdentityHMAC(secretA1, emailA), subscriberA, true)
	assertBinding(tenantA, keyA2, EmailIdentityHMAC(secretA2, emailA), subscriberA, true)
	assertBinding(tenantA, keyA1, EmailIdentityHMAC(secretB, emailB), "", false)
	assertBinding(tenantB, keyB, EmailIdentityHMAC(secretA1, emailA), "", false)

	newEmail := "renamed@example.test"
	tx, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE subscribers SET email = $3
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantA, subscriberA, newEmail); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("rename subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit rename: %v", err)
	}
	if status := projectionStatus(t, pool, tenantA, keyA1); status.Status != ProjectionStatusPending {
		t.Fatalf("rename did not invalidate projection: %+v", status)
	}

	// The old digest must not be treated as an honest miss while mutation work
	// is pending. No idempotency/fact row survives the explicit 503 rollback.
	now := time.Now().UTC()
	body := []byte(`{"event_name":"purchase","identity":{"email_hmac_sha256":"` +
		EmailIdentityHMAC(secretA1, newEmail) + `"}}`)
	recorder := httptestResponse(signedRouter(pool, now), signedRequest(t,
		"/api/public/conversions/ingest", secretA1, keyA1,
		"idem-"+uuid.NewString(), body, now))
	if recorder.code != 503 || !strings.Contains(recorder.body, "email_identity_projection_not_ready") {
		t.Fatalf("pending projection ingest = %d %s", recorder.code, recorder.body)
	}

	drainEmailHMACProjection(t, pool)
	assertBinding(tenantA, keyA1, EmailIdentityHMAC(secretA1, emailA), "", false)
	assertBinding(tenantA, keyA1, EmailIdentityHMAC(secretA1, newEmail), subscriberA, true)

	store := &IngestSecretStore{Pool: pool}
	if err := store.Revoke(ctx, tenantA, keyA1); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	assertBinding(tenantA, keyA1, EmailIdentityHMAC(secretA1, newEmail), "", false)
	listed, err := store.List(ctx, tenantA)
	if err != nil {
		t.Fatalf("list after revoke: %v", err)
	}
	var sawRevoked bool
	for _, item := range listed {
		if item.KeyID == keyA1 {
			sawRevoked = item.RevokedAt != nil && item.UpdatedAt.IsZero() == false
		}
	}
	if !sawRevoked {
		t.Fatal("revoked key lost historical projection metadata")
	}
}

type responseSnapshot struct {
	code int
	body string
}

func httptestResponse(handler http.Handler, request *http.Request) responseSnapshot {
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return responseSnapshot{code: recorder.Code, body: recorder.Body.String()}
}

func TestEmailHMACProjectionLeaseFenceAndReplay(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	seedIdentitySubscriber(t, pool, ctx, tenantID, "one@example.test", "")
	secret := "projection-crash-replay-secret-at-least-32"
	keyID := seedProjectionKey(t, pool, tenantID, secret)
	repository, err := NewEmailHMACProjectionRepository(pool)
	if err != nil {
		t.Fatalf("repository: %v", err)
	}
	if err := repository.Ready(ctx); err != nil {
		t.Fatalf("projection readiness: %v", err)
	}
	claims, err := repository.Claim(ctx, "crashed", 1, time.Minute)
	if err != nil || len(claims) != 1 {
		t.Fatalf("first claim = %v %v", claims, err)
	}
	stale := claims[0]

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE conversion_email_hmac_projection_tasks
   SET lease_expires_at = statement_timestamp() - interval '1 second'
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, stale.TaskID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("expire lease: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit expiry: %v", err)
	}

	replayed, err := repository.Claim(ctx, "replacement", 1, time.Minute)
	if err != nil || len(replayed) != 1 {
		t.Fatalf("reclaim = %v %v", replayed, err)
	}
	if replayed[0].LeaseToken == stale.LeaseToken || replayed[0].Attempt <= stale.Attempt {
		t.Fatalf("reclaim did not fence stale attempt: old=%+v new=%+v", stale, replayed[0])
	}
	if _, err := repository.Apply(ctx, stale, []byte(secret), 1); !errors.Is(err, ErrProjectionLeaseLost) {
		t.Fatalf("stale attempt apply = %v, want lease lost", err)
	}
	if _, err := repository.Apply(ctx, replayed[0], []byte(secret), 1); err != nil {
		t.Fatalf("replacement apply: %v", err)
	}
	drainEmailHMACProjection(t, pool)

	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var bindings int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM conversion_email_hmac_bindings
 WHERE tenant_id = $1::uuid AND key_id = $2`, tenantID, keyID).Scan(&bindings); err != nil {
		t.Fatalf("count replayed bindings: %v", err)
	}
	if bindings != 1 {
		t.Fatalf("replay produced %d bindings, want exactly one", bindings)
	}
}

func TestEmailHMACProjectionFullScanIsFencedByConcurrentEmailMutation(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	oldEmail := "full-stale@example.test"
	newEmail := "full-current@example.test"
	subscriberID := seedIdentitySubscriber(t, pool, ctx, tenantID, oldEmail, "")
	secret := "projection-full-mutation-fence-at-least-32"
	keyID := seedProjectionKey(t, pool, tenantID, secret)
	repository, err := NewEmailHMACProjectionRepository(pool)
	if err != nil {
		t.Fatalf("repository: %v", err)
	}
	claims, err := repository.Claim(ctx, "full-mutation-fence", 1, time.Minute)
	if err != nil || len(claims) != 1 || claims[0].TaskKind != projectionTaskFull {
		t.Fatalf("claim full task = %+v, %v", claims, err)
	}
	claim := claims[0]
	workerTX, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open worker transaction: %v", err)
	}
	if err := lockProjectionClaim(ctx, workerTX, claim); err != nil {
		_ = workerTX.Rollback(ctx)
		t.Fatalf("lock full claim: %v", err)
	}

	mutationStarted := make(chan struct{})
	mutationDone := make(chan error, 1)
	go func() {
		mutationTX, openErr := db.WithTenant(ctx, pool, tenantID)
		if openErr != nil {
			mutationDone <- openErr
			return
		}
		defer func() { _ = mutationTX.Rollback(ctx) }()
		close(mutationStarted)
		if _, updateErr := mutationTX.Exec(ctx, `
UPDATE subscribers SET email = $3
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID, newEmail); updateErr != nil {
			mutationDone <- updateErr
			return
		}
		mutationDone <- mutationTX.Commit(ctx)
	}()
	<-mutationStarted
	select {
	case mutationErr := <-mutationDone:
		_ = workerTX.Rollback(ctx)
		t.Fatalf("mutation did not block behind the full-task fence: %v", mutationErr)
	case <-time.After(100 * time.Millisecond):
	}

	oldDigest := EmailIdentityHMAC(secret, oldEmail)
	if _, err := workerTX.Exec(ctx, `
INSERT INTO conversion_email_hmac_bindings (
    tenant_id, key_id, digest, subscriber_id
) VALUES ($1::uuid, $2, $3, $4::uuid)`, tenantID, keyID, oldDigest, subscriberID); err != nil {
		_ = workerTX.Rollback(ctx)
		t.Fatalf("write simulated stale full binding: %v", err)
	}
	if err := completeProjectionTask(ctx, workerTX, claim); err != nil {
		_ = workerTX.Rollback(ctx)
		t.Fatalf("complete full task: %v", err)
	}
	if err := refreshProjectionState(ctx, workerTX, tenantID, keyID); err != nil {
		_ = workerTX.Rollback(ctx)
		t.Fatalf("refresh before mutation commit: %v", err)
	}
	if err := workerTX.Commit(ctx); err != nil {
		t.Fatalf("commit simulated stale full page: %v", err)
	}
	if err := <-mutationDone; err != nil {
		t.Fatalf("commit concurrent mutation: %v", err)
	}

	if status := projectionStatus(t, pool, tenantID, keyID); status.Status != ProjectionStatusPending {
		t.Fatalf("concurrent mutation left projection usable: %+v", status)
	}
	if _, err := repository.Apply(ctx, claim, []byte(secret), 100); !errors.Is(err, ErrProjectionLeaseLost) {
		t.Fatalf("superseded full claim = %v, want lease lost", err)
	}
	inspection, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("inspect synchronous old-digest removal: %v", err)
	}
	var oldBindings int
	if err := inspection.QueryRow(ctx, `
SELECT count(*) FROM conversion_email_hmac_bindings
 WHERE tenant_id = $1::uuid AND key_id = $2 AND digest = $3`,
		tenantID, keyID, oldDigest).Scan(&oldBindings); err != nil {
		_ = inspection.Rollback(ctx)
		t.Fatalf("count old digest: %v", err)
	}
	_ = inspection.Rollback(ctx)
	if oldBindings != 0 {
		t.Fatalf("concurrent mutation retained %d stale bindings", oldBindings)
	}
	drainEmailHMACProjection(t, pool)
}

func TestProjectionStateRefreshUsesFreshSnapshotAfterWaiting(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	subscriberID := seedIdentitySubscriber(t, pool, ctx, tenantID, "refresh@example.test", "")
	keyID := seedProjectionKey(t, pool, tenantID, "refresh-fresh-snapshot-secret-at-least-32")
	drainEmailHMACProjection(t, pool)

	enqueueTX, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open enqueue transaction: %v", err)
	}
	var locked bool
	if err := enqueueTX.QueryRow(ctx, `
SELECT true FROM conversion_email_hmac_projection_states
 WHERE tenant_id = $1::uuid AND key_id = $2 FOR UPDATE`, tenantID, keyID).Scan(&locked); err != nil || !locked {
		_ = enqueueTX.Rollback(ctx)
		t.Fatalf("lock state before enqueue: %v", err)
	}
	if _, err := enqueueTX.Exec(ctx, `
INSERT INTO conversion_email_hmac_projection_tasks (
    tenant_id, key_id, task_kind, subscriber_id, state
) VALUES ($1::uuid, $2, 'subscriber', $3::uuid, 'pending')`,
		tenantID, keyID, subscriberID); err != nil {
		_ = enqueueTX.Rollback(ctx)
		t.Fatalf("enqueue while state locked: %v", err)
	}

	refreshStarted := make(chan struct{})
	refreshDone := make(chan error, 1)
	go func() {
		refreshTX, openErr := db.WithTenant(ctx, pool, tenantID)
		if openErr != nil {
			refreshDone <- openErr
			return
		}
		defer func() { _ = refreshTX.Rollback(ctx) }()
		close(refreshStarted)
		if refreshErr := refreshProjectionState(ctx, refreshTX, tenantID, keyID); refreshErr != nil {
			refreshDone <- refreshErr
			return
		}
		refreshDone <- refreshTX.Commit(ctx)
	}()
	<-refreshStarted
	select {
	case refreshErr := <-refreshDone:
		_ = enqueueTX.Rollback(ctx)
		t.Fatalf("refresh did not wait for state mutation: %v", refreshErr)
	case <-time.After(100 * time.Millisecond):
	}
	if err := enqueueTX.Commit(ctx); err != nil {
		t.Fatalf("commit pending task: %v", err)
	}
	if err := <-refreshDone; err != nil {
		t.Fatalf("refresh after wait: %v", err)
	}
	if status := projectionStatus(t, pool, tenantID, keyID); status.Status != ProjectionStatusPending {
		t.Fatalf("stale refresh overwrote pending state: %+v", status)
	}
}

func TestSubscriberDeleteSynchronouslyErasesBindingWithoutFalsePending(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	subscriberID := seedIdentitySubscriber(t, pool, ctx, tenantID,
		"projection-delete@example.test", "")
	keyID := seedProjectionKey(t, pool, tenantID,
		"projection-delete-secret-at-least-32")
	drainEmailHMACProjection(t, pool)
	if status := projectionStatus(t, pool, tenantID, keyID); status.Status != ProjectionStatusReady {
		t.Fatalf("projection before delete = %+v", status)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open subscriber delete: %v", err)
	}
	if _, err := tx.Exec(ctx, `
DELETE FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("delete subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber delete: %v", err)
	}

	if status := projectionStatus(t, pool, tenantID, keyID); status.Status != ProjectionStatusReady {
		t.Fatalf("synchronously reconciled delete became falsely pending: %+v", status)
	}
	inspection, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open delete inspection: %v", err)
	}
	defer func() { _ = inspection.Rollback(ctx) }()
	var bindings, tasks int
	if err := inspection.QueryRow(ctx, `
SELECT
    (SELECT count(*) FROM conversion_email_hmac_bindings
      WHERE tenant_id = $1::uuid AND key_id = $2),
    (SELECT count(*) FROM conversion_email_hmac_projection_tasks
      WHERE tenant_id = $1::uuid AND key_id = $2)`, tenantID, keyID).Scan(
		&bindings, &tasks,
	); err != nil {
		t.Fatalf("inspect subscriber deletion convergence: %v", err)
	}
	if bindings != 0 || tasks != 0 {
		t.Fatalf("subscriber deletion retained projection work: bindings=%d tasks=%d",
			bindings, tasks)
	}

	// A create/update can already have made the key pending when deletion wins
	// the race. The subscriber FK cascade removes that task before the AFTER
	// DELETE trigger runs; readiness must converge back to ready rather than
	// becoming a permanent closed-but-unserviceable pending state.
	pendingCreate, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open pending subscriber create: %v", err)
	}
	var pendingSubscriberID string
	if err := pendingCreate.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, 'projection-delete-before-worker@example.test', 'enabled', 'api')
RETURNING id::text`, tenantID).Scan(&pendingSubscriberID); err != nil {
		_ = pendingCreate.Rollback(ctx)
		t.Fatalf("create pending subscriber: %v", err)
	}
	if err := pendingCreate.Commit(ctx); err != nil {
		t.Fatalf("commit pending subscriber create: %v", err)
	}
	if status := projectionStatus(t, pool, tenantID, keyID); status.Status != ProjectionStatusPending {
		t.Fatalf("subscriber create did not close projection: %+v", status)
	}
	pendingDelete, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open pending subscriber delete: %v", err)
	}
	if _, err := pendingDelete.Exec(ctx, `
DELETE FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, pendingSubscriberID); err != nil {
		_ = pendingDelete.Rollback(ctx)
		t.Fatalf("delete pending subscriber: %v", err)
	}
	if err := pendingDelete.Commit(ctx); err != nil {
		t.Fatalf("commit pending subscriber delete: %v", err)
	}
	if status := projectionStatus(t, pool, tenantID, keyID); status.Status != ProjectionStatusReady {
		t.Fatalf("task cascade stranded projection readiness: %+v", status)
	}
}

func TestProjectionRestrictedRoleEnforcesTenantRLSAndDeniesStateDelete(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantA := createAttributionTenant(t, pool, ctx)
	tenantB := createAttributionTenant(t, pool, ctx)
	keyB := seedProjectionKey(t, pool, tenantB, "restricted-role-secret-at-least-32")
	_ = seedIdentitySubscriber(t, pool, ctx, tenantB, "restricted@example.test", "")
	drainEmailHMACProjection(t, pool)

	txA, err := db.WithTenant(ctx, pool, tenantA)
	if err != nil {
		t.Fatalf("open tenant A transaction: %v", err)
	}
	var visible int
	if err := txA.QueryRow(ctx, `
SELECT count(*) FROM conversion_email_hmac_bindings
 WHERE tenant_id = $1::uuid AND key_id = $2`, tenantB, keyB).Scan(&visible); err != nil {
		_ = txA.Rollback(ctx)
		t.Fatalf("probe tenant B binding through tenant A: %v", err)
	}
	if visible != 0 {
		_ = txA.Rollback(ctx)
		t.Fatalf("tenant A saw %d tenant B bindings", visible)
	}
	if _, err := txA.Exec(ctx, `
DELETE FROM conversion_email_hmac_projection_states
 WHERE tenant_id = $1::uuid AND key_id = $2`, tenantA, keyB); err == nil {
		_ = txA.Rollback(ctx)
		t.Fatal("postwave_app unexpectedly deleted projection state")
	}
	_ = txA.Rollback(ctx)

	txB, err := db.WithTenant(ctx, pool, tenantB)
	if err != nil {
		t.Fatalf("open tenant B transaction: %v", err)
	}
	if _, err := txB.Exec(ctx, `
DELETE FROM conversion_ingest_secrets
 WHERE tenant_id = $1::uuid AND key_id = $2`, tenantB, keyB); err == nil {
		_ = txB.Rollback(ctx)
		t.Fatal("postwave_app unexpectedly deleted a signing-key lifecycle receipt")
	}
	_ = txB.Rollback(ctx)

	repository, err := NewEmailHMACProjectionRepository(pool)
	if err != nil {
		t.Fatalf("repository: %v", err)
	}
	if err := repository.Ready(ctx); err != nil {
		t.Fatalf("restricted-role readiness: %v", err)
	}
}

func requireProjectionPGError(
	t *testing.T,
	err error,
	code, constraint string,
) {
	t.Helper()
	if err == nil {
		t.Fatalf("database mutation unexpectedly succeeded; want SQLSTATE %s constraint %q",
			code, constraint)
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		t.Fatalf("database mutation error = %T %v, want PostgreSQL error", err, err)
	}
	if pgErr.Code != code {
		t.Fatalf("database mutation SQLSTATE = %s (%v), want %s", pgErr.Code, pgErr, code)
	}
	if constraint != "" && pgErr.ConstraintName != constraint {
		t.Fatalf("database mutation constraint = %q (%v), want %q",
			pgErr.ConstraintName, pgErr, constraint)
	}
}

func TestSigningKeyLifecycleRestrictedRoleCannotRewriteOrRevive(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	keyID := seedProjectionKey(t, pool, tenantID,
		"restricted-key-lifecycle-secret-at-least-32")

	var canRevoke, canRewriteLegacyFence, canRewriteSecret, canRewriteEnvelope, canRewriteARN,
		canRewriteDestroyedAt, canRewriteLabel bool
	if err := pool.QueryRow(ctx, `
SELECT has_column_privilege(current_user, 'public.conversion_ingest_secrets', 'revoked_at', 'UPDATE'),
       has_column_privilege(current_user, 'public.conversion_ingest_secrets', 'legacy_v1_until', 'UPDATE'),
       has_column_privilege(current_user, 'public.conversion_ingest_secrets', 'secret', 'UPDATE'),
       has_column_privilege(current_user, 'public.conversion_ingest_secrets', 'secret_envelope', 'UPDATE'),
       has_column_privilege(current_user, 'public.conversion_ingest_secrets', 'secret_kms_key_arn', 'UPDATE'),
       has_column_privilege(current_user, 'public.conversion_ingest_secrets', 'secret_destroyed_at', 'UPDATE'),
       has_column_privilege(current_user, 'public.conversion_ingest_secrets', 'label', 'UPDATE')`).Scan(
		&canRevoke, &canRewriteLegacyFence, &canRewriteSecret, &canRewriteEnvelope, &canRewriteARN,
		&canRewriteDestroyedAt, &canRewriteLabel,
	); err != nil {
		t.Fatalf("inspect lifecycle column grants: %v", err)
	}
	if !canRevoke || canRewriteLegacyFence || canRewriteSecret || canRewriteEnvelope || canRewriteARN ||
		canRewriteDestroyedAt || canRewriteLabel {
		t.Fatalf("unsafe signing-key column grants: revoke=%t legacy_fence=%t secret=%t envelope=%t arn=%t destroyed=%t label=%t",
			canRevoke, canRewriteLegacyFence, canRewriteSecret, canRewriteEnvelope, canRewriteARN,
			canRewriteDestroyedAt, canRewriteLabel)
	}

	labelTX, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open label rewrite: %v", err)
	}
	_, labelErr := labelTX.Exec(ctx, `
UPDATE conversion_ingest_secrets SET label = 'rewritten'
 WHERE tenant_id = $1::uuid AND key_id = $2`, tenantID, keyID)
	requireProjectionPGError(t, labelErr, "42501", "")
	_ = labelTX.Rollback(ctx)

	materialTX, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open material rewrite: %v", err)
	}
	_, materialErr := materialTX.Exec(ctx, `
UPDATE conversion_ingest_secrets
   SET secret = 'attacker-replaced',
       secret_envelope = decode('00', 'hex'),
       secret_kms_key_arn = $3
 WHERE tenant_id = $1::uuid AND key_id = $2`, tenantID, keyID, testConversionKMSKeyARN)
	requireProjectionPGError(t, materialErr, "42501", "")
	_ = materialTX.Rollback(ctx)

	requestedRevocation := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	revokeTX, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open direct revocation: %v", err)
	}
	var revokedAt time.Time
	var tombstone string
	var envelope []byte
	var keyARN *string
	var destroyedAt *time.Time
	if err := revokeTX.QueryRow(ctx, `
UPDATE conversion_ingest_secrets
   SET revoked_at = $3
 WHERE tenant_id = $1::uuid AND key_id = $2
RETURNING revoked_at, secret, secret_envelope, secret_kms_key_arn,
          secret_destroyed_at`, tenantID, keyID, requestedRevocation).Scan(
		&revokedAt, &tombstone, &envelope, &keyARN, &destroyedAt,
	); err != nil {
		_ = revokeTX.Rollback(ctx)
		t.Fatalf("direct restricted-role revocation: %v", err)
	}
	if err := revokeTX.Commit(ctx); err != nil {
		t.Fatalf("commit direct revocation: %v", err)
	}
	if revokedAt.Equal(requestedRevocation) || tombstone != ingestSecretRevokedTombstone ||
		envelope != nil || keyARN != nil || destroyedAt == nil ||
		!destroyedAt.Equal(revokedAt) {
		t.Fatalf("database did not normalize and cryptoshred revocation: revoked=%s requested=%s tombstone=%q envelope=%d arn=%v destroyed=%v",
			revokedAt, requestedRevocation, tombstone, len(envelope), keyARN, destroyedAt)
	}

	revivalTX, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open revoked-key revival: %v", err)
	}
	_, revivalErr := revivalTX.Exec(ctx, `
UPDATE conversion_ingest_secrets SET revoked_at = NULL
 WHERE tenant_id = $1::uuid AND key_id = $2`, tenantID, keyID)
	requireProjectionPGError(t, revivalErr, "23514",
		"conversion_ingest_secret_revocation_permanent")
	_ = revivalTX.Rollback(ctx)

	multiTX, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open multi-column revival: %v", err)
	}
	_, multiErr := multiTX.Exec(ctx, `
UPDATE conversion_ingest_secrets
   SET revoked_at = NULL,
       secret = 'envelope:do-not-use',
       secret_envelope = decode('01', 'hex'),
       secret_kms_key_arn = $3,
       secret_destroyed_at = NULL
 WHERE tenant_id = $1::uuid AND key_id = $2`, tenantID, keyID, testConversionKMSKeyARN)
	requireProjectionPGError(t, multiErr, "42501", "")
	_ = multiTX.Rollback(ctx)

	insertTX, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open pre-revoked insert: %v", err)
	}
	_, insertErr := insertTX.Exec(ctx, `
INSERT INTO conversion_ingest_secrets (
    tenant_id, key_id, label, secret, secret_envelope,
    secret_kms_key_arn, revoked_at
) VALUES (
    $1::uuid, $2, 'pre-revoked', 'envelope:do-not-use',
    decode('01', 'hex'), $3, statement_timestamp()
)`, tenantID, strings.ReplaceAll(uuid.NewString(), "-", ""), testConversionKMSKeyARN)
	requireProjectionPGError(t, insertErr, "23514",
		"conversion_ingest_secret_insert_live")
	_ = insertTX.Rollback(ctx)

	repository, err := NewEmailHMACProjectionRepository(pool)
	if err != nil {
		t.Fatalf("repository: %v", err)
	}
	if err := repository.Ready(ctx); err != nil {
		t.Fatalf("readiness rejected exact restricted-role lifecycle grants: %v", err)
	}
}

func TestEmailHMACProjectionLargeSetUsesBoundedPagesAndDigestIndex(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	const subscribers = 2500
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
SELECT $1::uuid, 'bulk-' || value || '@example.test', 'enabled', 'api'
  FROM generate_series(1, $2) value`, tenantID, subscribers); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed large subscriber set: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit large subscriber set: %v", err)
	}
	secret := "projection-large-set-secret-at-least-32-bytes"
	keyID := seedProjectionKey(t, pool, tenantID, secret)
	repository, err := NewEmailHMACProjectionRepository(pool)
	if err != nil {
		t.Fatalf("repository: %v", err)
	}
	pages := 0
	for {
		claims, err := repository.Claim(ctx, "large-set", 1, time.Minute)
		if err != nil {
			t.Fatalf("claim page: %v", err)
		}
		if len(claims) == 0 {
			break
		}
		result, err := repository.Apply(ctx, claims[0], []byte(secret), 200)
		if err != nil {
			t.Fatalf("apply page %d: %v", pages, err)
		}
		if result.Processed > 200 {
			t.Fatalf("page processed %d subscribers, bound is 200", result.Processed)
		}
		pages++
	}
	if pages < subscribers/200 {
		t.Fatalf("large projection completed in %d pages; bounded paging was bypassed", pages)
	}

	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `ANALYZE conversion_email_hmac_bindings`); err != nil {
		t.Fatalf("analyze bindings: %v", err)
	}
	digest := EmailIdentityHMAC(secret, "bulk-1250@example.test")
	rows, err := tx.Query(ctx, `
EXPLAIN (COSTS OFF)
WITH requested(digest) AS (
    SELECT unnest($2::text[])
)
SELECT requested.digest, COALESCE(binding.subscriber_id::text, ''),
       COALESCE(lower(btrim(subscriber.email::text)), '')
  FROM requested
  JOIN conversion_email_hmac_projection_states projection
    ON projection.tenant_id = $1::uuid
   AND projection.key_id = $3
   AND projection.status = 'ready'
  JOIN conversion_ingest_secrets secret
    ON secret.tenant_id = projection.tenant_id
   AND secret.key_id = projection.key_id
   AND secret.revoked_at IS NULL
  LEFT JOIN conversion_email_hmac_bindings binding
    ON binding.tenant_id = $1::uuid
   AND binding.key_id = $3
   AND binding.digest = requested.digest
  LEFT JOIN subscribers subscriber
    ON subscriber.tenant_id = binding.tenant_id
   AND subscriber.id = binding.subscriber_id
 ORDER BY requested.digest, subscriber.id`, tenantID, []string{digest}, keyID)
	if err != nil {
		t.Fatalf("explain digest lookup: %v", err)
	}
	defer rows.Close()
	var planLines []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatalf("scan plan: %v", err)
		}
		planLines = append(planLines, line)
	}
	plan := strings.Join(planLines, "\n")
	if !(strings.Contains(plan, "conversion_email_hmac_bindings_pkey") ||
		strings.Contains(plan, "conversion_email_hmac_bindings_digest_lookup_idx")) ||
		strings.Contains(plan, "Seq Scan on conversion_email_hmac_bindings") ||
		strings.Contains(plan, "Seq Scan on subscribers") {
		t.Fatalf("digest lookup is not index-bound:\n%s", plan)
	}
	var count int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM conversion_email_hmac_bindings
 WHERE tenant_id = $1::uuid AND key_id = $2`, tenantID, keyID).Scan(&count); err != nil {
		t.Fatalf("count bindings: %v", err)
	}
	if count != subscribers {
		t.Fatalf("bindings = %d, want %d", count, subscribers)
	}
}

func TestProjectionQueueClaimAndTenantKeyPlansStayIndexBound(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL is required to inspect the production claim principal")
	}
	tenantID := createAttributionTenant(t, pool, ctx)
	const subscribers = 1000
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
SELECT $1::uuid, 'queue-' || value || '@example.test', 'enabled', 'api'
  FROM generate_series(1, $2) value`, tenantID, subscribers); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed queue subscribers: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit queue subscribers: %v", err)
	}
	keys := make([]string, 0, MaxLiveIngestKeys)
	for index := 0; index < MaxLiveIngestKeys; index++ {
		keys = append(keys, seedProjectionKey(t, pool, tenantID,
			"queue-plan-secret-at-least-32-"+string(rune('a'+index))))
	}
	drainEmailHMACProjection(t, pool)

	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open queue fixture: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO conversion_email_hmac_projection_tasks (
    tenant_id, key_id, task_kind, subscriber_id, state, retry_not_before
)
SELECT $1::uuid, secret.key_id, 'subscriber', subscriber.id, 'retry',
       statement_timestamp() + interval '1 day'
  FROM conversion_ingest_secrets AS secret
  CROSS JOIN subscribers AS subscriber
 WHERE secret.tenant_id = $1::uuid AND secret.revoked_at IS NULL
   AND subscriber.tenant_id = $1::uuid`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed bounded queue fixture: %v", err)
	}
	if _, err := tx.Exec(ctx, `ANALYZE conversion_email_hmac_projection_tasks`); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("analyze projection tasks: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit bounded queue fixture: %v", err)
	}

	admin, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect claim-plan authority: %v", err)
	}
	defer func() { _ = admin.Close(context.Background()) }()
	claimTX, err := admin.Begin(ctx)
	if err != nil {
		t.Fatalf("begin claim-plan transaction: %v", err)
	}
	defer func() { _ = claimTX.Rollback(context.Background()) }()
	if _, err := claimTX.Exec(ctx, `SET LOCAL ROLE postwave_conversion_identity_projector`); err != nil {
		t.Fatalf("assume production claim principal: %v", err)
	}
	if _, err := claimTX.Exec(ctx, `SET LOCAL row_security = on`); err != nil {
		t.Fatalf("enable production claim RLS: %v", err)
	}
	claimRows, err := claimTX.Query(ctx, `
EXPLAIN (COSTS OFF)
SELECT task.id
  FROM conversion_email_hmac_projection_tasks AS task
 WHERE task.task_kind = 'subscriber'
   AND task.state IN ('pending', 'retry', 'leased')
   AND CASE
           WHEN task.state = 'leased' THEN task.lease_expires_at
           ELSE COALESCE(task.retry_not_before, '-infinity'::timestamptz)
       END <= statement_timestamp()
 ORDER BY CASE
              WHEN task.state = 'leased' THEN task.lease_expires_at
              ELSE COALESCE(task.retry_not_before, '-infinity'::timestamptz)
          END,
          task.created_at, task.id
 LIMIT 100`)
	if err != nil {
		t.Fatalf("explain claim: %v", err)
	}
	claimPlan := readExplainPlan(t, claimRows)
	if !strings.Contains(claimPlan, "conversion_email_hmac_projection_subscriber_claim_due_idx") ||
		strings.Contains(claimPlan, "Seq Scan on conversion_email_hmac_projection_tasks") ||
		strings.Contains(claimPlan, "Sort") {
		t.Fatalf("claim is not index-bounded:\n%s", claimPlan)
	}
	_ = claimTX.Rollback(ctx)

	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open tenant/key plan transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	tenantRows, err := tx.Query(ctx, `
EXPLAIN (COSTS OFF)
SELECT EXISTS (
    SELECT 1 FROM conversion_email_hmac_projection_tasks
     WHERE tenant_id = $1::uuid AND key_id = $2
)`, tenantID, keys[0])
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("explain tenant/key refresh: %v", err)
	}
	tenantPlan := readExplainPlan(t, tenantRows)
	if !strings.Contains(tenantPlan, "conversion_email_hmac_projection_tasks_tenant_key_idx") ||
		strings.Contains(tenantPlan, "Seq Scan on conversion_email_hmac_projection_tasks") {
		_ = tx.Rollback(ctx)
		t.Fatalf("tenant/key task lookup is not index-bounded:\n%s", tenantPlan)
	}
	_ = tx.Rollback(ctx)
}

func TestProjectionClaimReservesFullTaskUnderSubscriberBacklog(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	seedProjectionKey(t, pool, tenantID,
		"claim-fairness-first-secret-at-least-32")
	drainEmailHMACProjection(t, pool)
	fullKey := seedProjectionKey(t, pool, tenantID,
		"claim-fairness-full-secret-at-least-32")

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open subscriber backlog: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
SELECT $1::uuid, 'claim-fairness-' || value || '@example.test', 'enabled', 'api'
  FROM generate_series(1, 32) AS value`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber backlog: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber backlog: %v", err)
	}

	repository, err := NewEmailHMACProjectionRepository(pool)
	if err != nil {
		t.Fatalf("repository: %v", err)
	}
	claims, err := repository.Claim(ctx, "claim-fairness", 16, time.Minute)
	if err != nil {
		t.Fatalf("claim mixed backlog: %v", err)
	}
	if len(claims) != 16 {
		t.Fatalf("mixed backlog claims = %d, want 16", len(claims))
	}
	fullClaims, subscriberClaims := 0, 0
	for _, claim := range claims {
		switch claim.TaskKind {
		case projectionTaskFull:
			fullClaims++
			if claim.KeyID != fullKey {
				t.Fatalf("reserved full claim key = %q, want %q", claim.KeyID, fullKey)
			}
		case projectionTaskSubscriber:
			subscriberClaims++
		default:
			t.Fatalf("unexpected task kind %q", claim.TaskKind)
		}
	}
	if fullClaims != 1 || subscriberClaims != 15 {
		t.Fatalf("mixed backlog split = full:%d subscriber:%d, want 1:15",
			fullClaims, subscriberClaims)
	}
}

func TestProjectionKeyLifecycleSerializesConcurrentSubscriberCommits(t *testing.T) {
	pool := attributionDB(t)

	t.Run("key commits before waiting subscriber", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		tenantID := createAttributionTenant(t, pool, ctx)
		secret := "key-first-lifecycle-fence-secret-at-least-32"
		email := "key-first-lifecycle-fence@example.test"

		keyTX, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("open key transaction: %v", err)
		}
		keyID, err := insertProjectionKeyInTransaction(ctx, keyTX, secret)
		if err != nil {
			_ = keyTX.Rollback(ctx)
			t.Fatalf("insert uncommitted key: %v", err)
		}

		type subscriberResult struct {
			id  string
			err error
		}
		started := make(chan struct{})
		done := make(chan subscriberResult, 1)
		go func() {
			subscriberTX, txErr := db.WithTenant(ctx, pool, tenantID)
			if txErr != nil {
				done <- subscriberResult{err: txErr}
				return
			}
			defer func() { _ = subscriberTX.Rollback(ctx) }()
			close(started)
			var subscriberID string
			txErr = subscriberTX.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api')
RETURNING id::text`, tenantID, email).Scan(&subscriberID)
			if txErr == nil {
				txErr = subscriberTX.Commit(ctx)
			}
			done <- subscriberResult{id: subscriberID, err: txErr}
		}()
		<-started
		select {
		case result := <-done:
			_ = keyTX.Rollback(ctx)
			t.Fatalf("subscriber crossed uncommitted key lifecycle fence: %+v", result)
		case <-time.After(100 * time.Millisecond):
		}
		if err := keyTX.Commit(ctx); err != nil {
			t.Fatalf("commit key first: %v", err)
		}
		result := <-done
		if result.err != nil {
			t.Fatalf("commit subscriber after key: %v", result.err)
		}

		inspection, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("open key-first inspection: %v", err)
		}
		var subscriberTasks int
		if err := inspection.QueryRow(ctx, `
SELECT count(*)
  FROM conversion_email_hmac_projection_tasks
 WHERE tenant_id = $1::uuid AND key_id = $2
   AND task_kind = 'subscriber' AND subscriber_id = $3::uuid`,
			tenantID, keyID, result.id).Scan(&subscriberTasks); err != nil {
			_ = inspection.Rollback(ctx)
			t.Fatalf("inspect post-wait subscriber task: %v", err)
		}
		_ = inspection.Rollback(ctx)
		if subscriberTasks != 1 {
			t.Fatalf("post-wait trigger saw %d exact-key tasks, want 1", subscriberTasks)
		}
		drainEmailHMACProjection(t, pool)
		if status := projectionStatus(t, pool, tenantID, keyID); status.Status != ProjectionStatusReady {
			t.Fatalf("key-first projection did not converge: %+v", status)
		}
		assertProjectionBinding(t, pool, tenantID, keyID,
			EmailIdentityHMAC(secret, email), result.id)
	})

	t.Run("subscriber commits before waiting key", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		tenantID := createAttributionTenant(t, pool, ctx)
		secret := "subscriber-first-lifecycle-fence-secret-at-least-32"
		email := "subscriber-first-lifecycle-fence@example.test"

		subscriberTX, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("open subscriber transaction: %v", err)
		}
		var subscriberID string
		if err := subscriberTX.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api')
RETURNING id::text`, tenantID, email).Scan(&subscriberID); err != nil {
			_ = subscriberTX.Rollback(ctx)
			t.Fatalf("insert uncommitted subscriber: %v", err)
		}

		type keyResult struct {
			id  string
			err error
		}
		started := make(chan struct{})
		done := make(chan keyResult, 1)
		go func() {
			keyTX, txErr := db.WithTenant(ctx, pool, tenantID)
			if txErr != nil {
				done <- keyResult{err: txErr}
				return
			}
			defer func() { _ = keyTX.Rollback(ctx) }()
			close(started)
			keyID, txErr := insertProjectionKeyInTransaction(ctx, keyTX, secret)
			if txErr == nil {
				txErr = keyTX.Commit(ctx)
			}
			done <- keyResult{id: keyID, err: txErr}
		}()
		<-started
		select {
		case result := <-done:
			_ = subscriberTX.Rollback(ctx)
			t.Fatalf("key crossed uncommitted subscriber lifecycle fence: %+v", result)
		case <-time.After(100 * time.Millisecond):
		}
		if err := subscriberTX.Commit(ctx); err != nil {
			t.Fatalf("commit subscriber first: %v", err)
		}
		result := <-done
		if result.err != nil {
			t.Fatalf("commit key after subscriber: %v", result.err)
		}
		drainEmailHMACProjection(t, pool)
		if status := projectionStatus(t, pool, tenantID, result.id); status.Status != ProjectionStatusReady {
			t.Fatalf("subscriber-first projection did not converge: %+v", status)
		}
		assertProjectionBinding(t, pool, tenantID, result.id,
			EmailIdentityHMAC(secret, email), subscriberID)
	})
}

func TestProjectionLookupSerializesWithSubscriberMutation(t *testing.T) {
	pool := attributionDB(t)

	t.Run("lookup commits before waiting mutation", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		tenantID := createAttributionTenant(t, pool, ctx)
		secret := "lookup-first-projection-lock-secret-at-least-32"
		oldEmail := "lookup-first-old@example.test"
		newEmail := "lookup-first-new@example.test"
		subscriberID := seedIdentitySubscriber(t, pool, ctx, tenantID, oldEmail, "")
		keyID := seedProjectionKey(t, pool, tenantID, secret)
		drainEmailHMACProjection(t, pool)
		digest := EmailIdentityHMAC(secret, oldEmail)

		lookupTX, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("open locked lookup: %v", err)
		}
		bindings, err := loadEmailHMACBindings(ctx, lookupTX, tenantID, keyID,
			[]signedConversionFact{{emailHMACSHA256: digest, emailHMACKeyID: keyID}})
		if err != nil || bindings[digest].subscriberID != subscriberID {
			_ = lookupTX.Rollback(ctx)
			t.Fatalf("locked exact binding = %+v, err=%v", bindings[digest], err)
		}

		started := make(chan struct{})
		done := make(chan error, 1)
		go func() {
			mutationTX, txErr := db.WithTenant(ctx, pool, tenantID)
			if txErr != nil {
				done <- txErr
				return
			}
			defer func() { _ = mutationTX.Rollback(ctx) }()
			close(started)
			_, txErr = mutationTX.Exec(ctx, `
UPDATE subscribers SET email = $3
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID, newEmail)
			if txErr == nil {
				txErr = mutationTX.Commit(ctx)
			}
			done <- txErr
		}()
		<-started
		select {
		case mutationErr := <-done:
			_ = lookupTX.Rollback(ctx)
			t.Fatalf("subscriber mutation crossed locked readiness lookup: %v", mutationErr)
		case <-time.After(100 * time.Millisecond):
		}
		if err := lookupTX.Commit(ctx); err != nil {
			t.Fatalf("commit locked lookup: %v", err)
		}
		if mutationErr := <-done; mutationErr != nil {
			t.Fatalf("commit waiting subscriber mutation: %v", mutationErr)
		}
		if status := projectionStatus(t, pool, tenantID, keyID); status.Status != ProjectionStatusPending {
			t.Fatalf("committed mutation did not close projection: %+v", status)
		}
		drainEmailHMACProjection(t, pool)
		assertProjectionBinding(t, pool, tenantID, keyID,
			EmailIdentityHMAC(secret, newEmail), subscriberID)
	})

	t.Run("mutation commits before waiting lookup", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		tenantID := createAttributionTenant(t, pool, ctx)
		secret := "mutation-first-projection-lock-secret-at-least-32"
		oldEmail := "mutation-first-old@example.test"
		newEmail := "mutation-first-new@example.test"
		subscriberID := seedIdentitySubscriber(t, pool, ctx, tenantID, oldEmail, "")
		keyID := seedProjectionKey(t, pool, tenantID, secret)
		drainEmailHMACProjection(t, pool)
		digest := EmailIdentityHMAC(secret, oldEmail)

		mutationTX, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("open uncommitted mutation: %v", err)
		}
		if _, err := mutationTX.Exec(ctx, `
UPDATE subscribers SET email = $3
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID, newEmail); err != nil {
			_ = mutationTX.Rollback(ctx)
			t.Fatalf("stage subscriber mutation: %v", err)
		}

		type lookupResult struct {
			bindings map[string]emailHMACBinding
			err      error
		}
		started := make(chan struct{})
		done := make(chan lookupResult, 1)
		go func() {
			lookupTX, txErr := db.WithTenant(ctx, pool, tenantID)
			if txErr != nil {
				done <- lookupResult{err: txErr}
				return
			}
			defer func() { _ = lookupTX.Rollback(ctx) }()
			close(started)
			bindings, txErr := loadEmailHMACBindings(ctx, lookupTX, tenantID, keyID,
				[]signedConversionFact{{emailHMACSHA256: digest, emailHMACKeyID: keyID}})
			done <- lookupResult{bindings: bindings, err: txErr}
		}()
		<-started
		select {
		case result := <-done:
			_ = mutationTX.Rollback(ctx)
			t.Fatalf("readiness lookup crossed uncommitted subscriber mutation: %+v", result)
		case <-time.After(100 * time.Millisecond):
		}
		if err := mutationTX.Commit(ctx); err != nil {
			t.Fatalf("commit mutation before lookup: %v", err)
		}
		result := <-done
		if !errors.Is(result.err, ErrEmailIdentityProjectionNotReady) ||
			len(result.bindings) != 0 {
			t.Fatalf("post-wait lookup = bindings:%+v err:%v, want closed not-ready",
				result.bindings, result.err)
		}
		drainEmailHMACProjection(t, pool)
	})
}

func TestFullProjectionCursorSurvivesSustainedSubscriberMutation(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)
	const subscribers = 80
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open cursor fixture: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source)
SELECT ('00000000-0000-0000-0000-' || lpad(value::text, 12, '0'))::uuid,
       $1::uuid, 'cursor-' || value || '@example.test', 'enabled', 'api'
  FROM generate_series(1, $2) AS value`, tenantID, subscribers); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed cursor fixture: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit cursor fixture: %v", err)
	}
	secret := "cursor-progress-secret-at-least-32-bytes"
	keyID := seedProjectionKey(t, pool, tenantID, secret)
	repository, err := NewEmailHMACProjectionRepository(pool)
	if err != nil {
		t.Fatalf("repository: %v", err)
	}

	lastCursor := ""
	for page := 0; page < 4; page++ {
		claims, err := repository.Claim(ctx, "cursor-progress", 1, time.Minute)
		if err != nil || len(claims) != 1 || claims[0].TaskKind != projectionTaskFull {
			t.Fatalf("claim full page %d = %+v, err=%v", page, claims, err)
		}
		result, err := repository.Apply(ctx, claims[0], []byte(secret), 10)
		if err != nil || result.Complete || result.Processed != 10 {
			t.Fatalf("apply full page %d = %+v, err=%v", page, result, err)
		}

		inspection, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("open cursor inspection: %v", err)
		}
		var cursor string
		if err := inspection.QueryRow(ctx, `
SELECT cursor_subscriber_id::text
  FROM conversion_email_hmac_projection_tasks
 WHERE tenant_id = $1::uuid AND key_id = $2 AND task_kind = 'full'`,
			tenantID, keyID).Scan(&cursor); err != nil {
			_ = inspection.Rollback(ctx)
			t.Fatalf("read full cursor: %v", err)
		}
		_ = inspection.Rollback(ctx)
		if lastCursor != "" && cursor <= lastCursor {
			t.Fatalf("full cursor did not advance: prior=%s current=%s", lastCursor, cursor)
		}
		lastCursor = cursor

		mutation, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("open cursor mutation: %v", err)
		}
		behindID := "00000000-0000-0000-0000-000000000001"
		aheadID := "00000000-0000-0000-0000-000000000080"
		if _, err := mutation.Exec(ctx, `
UPDATE subscribers
   SET email = CASE id
       WHEN $2::uuid THEN $4
       WHEN $3::uuid THEN $5
       ELSE email END
 WHERE tenant_id = $1::uuid AND id IN ($2::uuid, $3::uuid)`,
			tenantID, behindID, aheadID,
			"cursor-behind-"+string(rune('a'+page))+"@example.test",
			"cursor-ahead-"+string(rune('a'+page))+"@example.test"); err != nil {
			_ = mutation.Rollback(ctx)
			t.Fatalf("mutate around cursor page %d: %v", page, err)
		}
		if err := mutation.Commit(ctx); err != nil {
			t.Fatalf("commit cursor mutation page %d: %v", page, err)
		}

		check, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("open cursor preservation check: %v", err)
		}
		var preserved string
		if err := check.QueryRow(ctx, `
SELECT cursor_subscriber_id::text
  FROM conversion_email_hmac_projection_tasks
 WHERE tenant_id = $1::uuid AND key_id = $2 AND task_kind = 'full'`,
			tenantID, keyID).Scan(&preserved); err != nil {
			_ = check.Rollback(ctx)
			t.Fatalf("read preserved full cursor: %v", err)
		}
		_ = check.Rollback(ctx)
		if preserved != lastCursor {
			t.Fatalf("subscriber churn reset full cursor: got=%s want=%s", preserved, lastCursor)
		}
	}

	drainEmailHMACProjection(t, pool)
	if status := projectionStatus(t, pool, tenantID, keyID); status.Status != ProjectionStatusReady {
		t.Fatalf("mutating full projection did not converge: %+v", status)
	}
	assertProjectionBinding(t, pool, tenantID, keyID,
		EmailIdentityHMAC(secret, "cursor-behind-d@example.test"),
		"00000000-0000-0000-0000-000000000001")
	assertProjectionBinding(t, pool, tenantID, keyID,
		EmailIdentityHMAC(secret, "cursor-ahead-d@example.test"),
		"00000000-0000-0000-0000-000000000080")
}

func readExplainPlan(t *testing.T, rows pgx.Rows) string {
	t.Helper()
	defer rows.Close()
	var lines []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatalf("scan explain plan: %v", err)
		}
		lines = append(lines, line)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read explain plan: %v", err)
	}
	return strings.Join(lines, "\n")
}
