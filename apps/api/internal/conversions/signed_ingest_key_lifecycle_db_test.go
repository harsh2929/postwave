// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func waitForLifecycleShareWait(
	ctx context.Context,
	t *testing.T,
	pool *db.Pool,
	exclusiveHolderPID int32,
) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var waiting bool
		err := pool.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_locks AS held
      JOIN pg_catalog.pg_locks AS waiter
        ON waiter.locktype = held.locktype
       AND waiter.database IS NOT DISTINCT FROM held.database
       AND waiter.classid IS NOT DISTINCT FROM held.classid
       AND waiter.objid IS NOT DISTINCT FROM held.objid
       AND waiter.objsubid IS NOT DISTINCT FROM held.objsubid
     WHERE held.pid = $1
       AND held.locktype = 'advisory'
       AND held.mode = 'ExclusiveLock'
       AND held.granted
       AND waiter.pid <> held.pid
       AND waiter.mode = 'ShareLock'
       AND NOT waiter.granted
)`, exclusiveHolderPID).Scan(&waiting)
		if err != nil {
			t.Fatalf("inspect lifecycle advisory wait: %v", err)
		}
		if waiting {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("signed ingest never reached the shared key-lifecycle fence")
}

func waitForBlockedByPID(
	ctx context.Context,
	t *testing.T,
	pool *db.Pool,
	blockingPID int32,
) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var waiting bool
		err := pool.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_stat_activity AS activity
     WHERE activity.pid <> $1
       AND $1 = ANY(pg_catalog.pg_blocking_pids(activity.pid))
       AND activity.wait_event_type = 'Lock'
)`, blockingPID).Scan(&waiting)
		if err != nil {
			t.Fatalf("inspect signing-key row wait: %v", err)
		}
		if waiting {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("signed ingest never waited on the in-flight revocation")
}

func recordLifecycleRaceConversion(
	ctx context.Context,
	pool *db.Pool,
	tenantID, keyID, idempotencyKey, externalID string,
) (*StoredResponse, error) {
	return (&Repo{Pool: pool}).RecordSignedConversions(
		ctx,
		tenantID,
		keyID,
		idempotencyKey,
		RequestDigest([]byte(idempotencyKey)),
		[]signedConversion{{
			EventName: "key-lifecycle-race",
			Identity:  signedIdentity{ExternalID: externalID},
		}},
		time.Now().UTC(),
	)
}

func assertLifecycleRaceRows(
	ctx context.Context,
	t *testing.T,
	pool *db.Pool,
	tenantID, idempotencyKey, externalID string,
	want int,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open lifecycle result inspection: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var conversions, receipts int
	if err := tx.QueryRow(ctx, `
SELECT (SELECT count(*) FROM conversions
         WHERE tenant_id=$1::uuid AND event_name='key-lifecycle-race'
           AND external_id=$2),
       (SELECT count(*) FROM conversion_ingest_idempotency
         WHERE tenant_id=$1::uuid AND idempotency_key=$3)`,
		tenantID, externalID, idempotencyKey).Scan(&conversions, &receipts); err != nil {
		t.Fatalf("inspect lifecycle result: %v", err)
	}
	if conversions != want || receipts != want {
		t.Fatalf("post-cutover writes conversions=%d receipts=%d, want %d/%d",
			conversions, receipts, want, want)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit lifecycle result inspection: %v", err)
	}
}

// The exact key row and the tenant lifecycle fence define one revocation
// cutover. This test forces both possible winners and inspects live lock waits,
// so a timing accident cannot turn the race proof into two sequential calls.
func TestSignedIngestAndRevocationHaveOneLinearizableCutover_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := attributionDB(t)

	t.Run("ingest wins and revocation waits for its commit", func(t *testing.T) {
		tenantID, keyID, _ := signedIngestFixture(t, pool)
		idempotencyKey := "lifecycle-before-" + uuid.NewString()
		externalID := "external-before-" + uuid.NewString()

		gate, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("open lifecycle gate: %v", err)
		}
		defer func() { _ = gate.Rollback(context.Background()) }()
		var gatePID int32
		if err := gate.QueryRow(ctx, `SELECT pg_catalog.pg_backend_pid()`).Scan(&gatePID); err != nil {
			t.Fatalf("read lifecycle gate pid: %v", err)
		}
		if _, err := gate.Exec(ctx, `
SELECT pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended($1, 2017)
)`, tenantID); err != nil {
			t.Fatalf("hold exclusive lifecycle gate: %v", err)
		}

		recorded := make(chan struct {
			response *StoredResponse
			err      error
		}, 1)
		go func() {
			response, recordErr := recordLifecycleRaceConversion(
				ctx, pool, tenantID, keyID, idempotencyKey, externalID,
			)
			recorded <- struct {
				response *StoredResponse
				err      error
			}{response: response, err: recordErr}
		}()
		waitForLifecycleShareWait(ctx, t, pool, gatePID)

		revoked := make(chan error, 1)
		go func() {
			revoked <- (&IngestSecretStore{Pool: pool}).Revoke(ctx, tenantID, keyID)
		}()
		select {
		case err := <-revoked:
			t.Fatalf("revocation crossed the ingest's locked live-key row: %v", err)
		case <-time.After(100 * time.Millisecond):
		}

		if err := gate.Commit(ctx); err != nil {
			t.Fatalf("release lifecycle gate: %v", err)
		}
		result := <-recorded
		if result.err != nil || result.response == nil ||
			result.response.StatusCode != 202 || result.response.Replayed {
			t.Fatalf("pre-cutover ingest result response=%+v err=%v", result.response, result.err)
		}
		if err := <-revoked; err != nil {
			t.Fatalf("revocation after ingest commit: %v", err)
		}
		assertLifecycleRaceRows(ctx, t, pool, tenantID, idempotencyKey, externalID, 1)
	})

	t.Run("revocation wins and authenticated request writes nothing", func(t *testing.T) {
		tenantID, keyID, _ := signedIngestFixture(t, pool)
		idempotencyKey := "lifecycle-after-" + uuid.NewString()
		externalID := "external-after-" + uuid.NewString()

		revokeTX, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("open in-flight revocation: %v", err)
		}
		defer func() { _ = revokeTX.Rollback(context.Background()) }()
		var revokePID int32
		if err := revokeTX.QueryRow(ctx, `SELECT pg_catalog.pg_backend_pid()`).Scan(&revokePID); err != nil {
			t.Fatalf("read revocation pid: %v", err)
		}
		if _, err := revokeTX.Exec(ctx, `
UPDATE conversion_ingest_secrets
   SET revoked_at=statement_timestamp()
 WHERE tenant_id=$1::uuid AND key_id=$2 AND revoked_at IS NULL`, tenantID, keyID); err != nil {
			t.Fatalf("stage revocation: %v", err)
		}

		recorded := make(chan error, 1)
		go func() {
			_, recordErr := recordLifecycleRaceConversion(
				ctx, pool, tenantID, keyID, idempotencyKey, externalID,
			)
			recorded <- recordErr
		}()
		waitForBlockedByPID(ctx, t, pool, revokePID)
		if err := revokeTX.Commit(ctx); err != nil {
			t.Fatalf("commit winning revocation: %v", err)
		}
		select {
		case err := <-recorded:
			if !errors.Is(err, ErrUnsignedRequest) {
				t.Fatalf("post-revocation ingest error=%v, want ErrUnsignedRequest", err)
			}
		case <-ctx.Done():
			t.Fatal(fmt.Errorf("post-revocation ingest did not converge: %w", ctx.Err()))
		}
		assertLifecycleRaceRows(ctx, t, pool, tenantID, idempotencyKey, externalID, 0)
	})
}
