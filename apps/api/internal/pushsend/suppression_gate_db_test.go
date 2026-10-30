// SPDX-License-Identifier: AGPL-3.0-only

package pushsend

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/pushauthoritylock"
	"github.com/postwave/postwave/apps/api/internal/pushsuppressions"
)

func TestRepoResolveSendableDevicesUsesAuthorityUnion(t *testing.T) {
	adminURL := strings.TrimSpace(os.Getenv("PUSH_SUPPRESSIONS_ADMIN_TEST_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("PUSH_SUPPRESSIONS_APP_TEST_DATABASE_URL"))
	if adminURL == "" || appURL == "" {
		t.Skip("PUSH_SUPPRESSIONS_ADMIN_TEST_DATABASE_URL and PUSH_SUPPRESSIONS_APP_TEST_DATABASE_URL are required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("open admin DB: %v", err)
	}
	t.Cleanup(admin.Close)
	app, err := db.New(ctx, appURL)
	if err != nil {
		t.Fatalf("open app DB: %v", err)
	}
	t.Cleanup(app.Close)

	tenantID, subscriberID := uuid.NewString(), uuid.NewString()
	if _, err := admin.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'Route43 send-gate DB proof', $2, 'studio')`, tenantID, "route43-send-"+tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})

	iosToken := "exact-ios-token-bytes-0123456789"
	androidToken := "exact-android-token-bytes-0123456789"
	tx, err := db.WithTenant(ctx, app, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::uuid, $3, 'enabled', 'api')`,
		subscriberID, tenantID, "route43-send-"+subscriberID+"@example.test"); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO push_devices (tenant_id, subscriber_id, platform, token, enabled)
VALUES ($1::uuid, $2::uuid, 'ios', $3, true),
       ($1::uuid, $2::uuid, 'android', $4, true)`,
		tenantID, subscriberID, iosToken, androidToken); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed devices: %v", err)
	}
	iosDigest := sha256.Sum256([]byte(iosToken))
	if _, err := tx.Exec(ctx, `
INSERT INTO push_suppression_authorities
    (tenant_id, device_token_hash, platform, authority, reason, source)
VALUES ($1::uuid, $2, 'apns', 'complaint', 'complaint', 'abuse.pipeline.v2')`,
		tenantID, iosDigest[:]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed APNs complaint authority: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	// The database is the final exact-byte identity boundary even for a caller
	// that bypasses Repo validation. Exercise both INSERT and UPDATE, including
	// the two accepted octet-length edges, without retaining the probe rows.
	for _, probe := range []struct {
		name       string
		token      string
		constraint string
	}{
		{name: "nineteen bytes", token: strings.Repeat("a", 19), constraint: "push_devices_suppressible_token_check"},
		{name: "embedded whitespace", token: strings.Repeat("b", 20) + " " + strings.Repeat("c", 20), constraint: "push_devices_suppressible_token_check"},
		{name: "four thousand ninety-seven bytes", token: strings.Repeat("d", 4097), constraint: "push_devices_suppressible_token_check"},
		{name: "twenty bytes accepted", token: strings.Repeat("e", 20)},
		{name: "four thousand ninety-six bytes accepted", token: strings.Repeat("f", 4096)},
	} {
		t.Run("device constraint "+probe.name, func(t *testing.T) {
			probeTx, err := db.WithTenant(ctx, app, tenantID)
			if err != nil {
				t.Fatal(err)
			}
			_, insertErr := probeTx.Exec(ctx, `
INSERT INTO push_devices (tenant_id, subscriber_id, platform, token, enabled)
VALUES ($1::uuid, $2::uuid, 'ios', $3, true)`, tenantID, subscriberID, probe.token)
			_ = probeTx.Rollback(ctx)
			if probe.constraint == "" {
				if insertErr != nil {
					t.Fatalf("valid boundary token insert: %v", insertErr)
				}
				return
			}
			var pgErr *pgconn.PgError
			if !errors.As(insertErr, &pgErr) || pgErr.Code != "23514" || pgErr.ConstraintName != probe.constraint {
				t.Fatalf("invalid token error=%v code=%q constraint=%q, want 23514/%s",
					insertErr, pgErrorCode(pgErr), pgErrorConstraint(pgErr), probe.constraint)
			}
		})
	}
	probeTx, err := db.WithTenant(ctx, app, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	_, updateErr := probeTx.Exec(ctx, `
UPDATE push_devices SET token = $3
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND token = $4`,
		tenantID, subscriberID, strings.Repeat("u", 19), iosToken)
	_ = probeTx.Rollback(ctx)
	var updatePGErr *pgconn.PgError
	if !errors.As(updateErr, &updatePGErr) || updatePGErr.Code != "23514" ||
		updatePGErr.ConstraintName != "push_devices_suppressible_token_check" {
		t.Fatalf("invalid token update error=%v code=%q constraint=%q",
			updateErr, pgErrorCode(updatePGErr), pgErrorConstraint(updatePGErr))
	}

	repo := &Repo{Pool: app}
	resolution, err := repo.ResolveSendableDevices(ctx, tenantID, subscriberID)
	if err != nil {
		t.Fatalf("resolve sendable devices: %v", err)
	}
	if resolution.EnabledCount != 2 || resolution.SuppressedCount != 1 || len(resolution.Devices) != 1 {
		t.Fatalf("authority union did not partition exact candidates: %+v", resolution)
	}
	if resolution.Devices[0].Platform != "android" || resolution.Devices[0].Token != androidToken {
		t.Fatalf("APNs fact crossed platform or wrong device survived: %+v", resolution.Devices)
	}

	// The eligibility transaction's shared tenant lease spans the entire
	// callback. Marked-context first-party mutations fail fast; an independent
	// authority writer is visibly waiting on the advisory lock until release.
	callbackEntered := make(chan struct{})
	callbackRelease := make(chan struct{})
	callbackDone := make(chan error, 1)
	callbackReleased := false
	releaseCallback := func() {
		if !callbackReleased {
			close(callbackRelease)
			callbackReleased = true
		}
	}
	defer releaseCallback()
	suppressionStore := &pushsuppressions.Store{Pool: app}
	go func() {
		callbackDone <- repo.WithSendableDevices(ctx, tenantID, subscriberID, func(leaseCtx context.Context, got DeviceResolution) error {
			if got.EnabledCount != 2 || got.SuppressedCount != 1 || len(got.Devices) != 1 {
				return fmt.Errorf("unexpected leased resolution: %+v", got)
			}
			if _, mutationErr := suppressionStore.AddManual(leaseCtx, tenantID, pushsuppressions.ManualAdd{
				DeviceToken: "route43-marked-callback-authority-token-0123456789", Platform: "fcm",
			}, db.AuditMeta{TenantID: tenantID, ActorType: "human", ActorLabel: "route43-send-db-test"}); !errors.Is(mutationErr, pushauthoritylock.ErrMutationDuringSendLease) {
				return fmt.Errorf("marked authority mutation error=%v, want %v", mutationErr, pushauthoritylock.ErrMutationDuringSendLease)
			}
			if _, mutationErr := repo.UpsertDevice(leaseCtx, tenantID, UpsertDeviceInput{
				SubscriberID: subscriberID, Platform: "android", Token: androidToken, Enabled: true,
			}); !errors.Is(mutationErr, pushauthoritylock.ErrMutationDuringSendLease) {
				return fmt.Errorf("marked device mutation error=%v, want %v", mutationErr, pushauthoritylock.ErrMutationDuringSendLease)
			}
			close(callbackEntered)
			select {
			case <-callbackRelease:
				return nil
			case <-leaseCtx.Done():
				return leaseCtx.Err()
			}
		})
	}()
	select {
	case <-callbackEntered:
	case callbackErr := <-callbackDone:
		t.Fatalf("eligibility callback returned before blocking: %v", callbackErr)
	case <-ctx.Done():
		t.Fatalf("wait for eligibility callback: %v", ctx.Err())
	}

	writerPID := make(chan int, 1)
	writerDone := make(chan error, 1)
	blockedToken := "route43-blocked-authority-writer-token-0123456789"
	blockedDigest := sha256.Sum256([]byte(blockedToken))
	go func() {
		writerCtx, writerCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer writerCancel()
		writerTx, writerErr := db.WithTenant(writerCtx, app, tenantID)
		if writerErr != nil {
			writerPID <- 0
			writerDone <- writerErr
			return
		}
		defer func() { _ = writerTx.Rollback(writerCtx) }()
		var pid int
		if writerErr = writerTx.QueryRow(writerCtx, `SELECT pg_backend_pid()`).Scan(&pid); writerErr != nil {
			writerPID <- 0
			writerDone <- writerErr
			return
		}
		writerPID <- pid
		if writerErr = pushauthoritylock.Exclusive(writerCtx, writerTx, tenantID); writerErr == nil {
			_, writerErr = writerTx.Exec(writerCtx, `
INSERT INTO push_suppression_authorities
    (tenant_id, device_token_hash, platform, authority, reason, source)
VALUES ($1::uuid, $2, 'fcm', 'manual', 'manual', 'dashboard')`, tenantID, blockedDigest[:])
		}
		if writerErr == nil {
			writerErr = writerTx.Commit(writerCtx)
		}
		writerDone <- writerErr
	}()
	var pid int
	select {
	case pid = <-writerPID:
	case <-ctx.Done():
		releaseCallback()
		t.Fatalf("wait for authority writer backend: %v", ctx.Err())
	}
	if pid == 0 {
		releaseCallback()
		t.Fatalf("open authority writer: %v", <-writerDone)
	}
	waitDeadline := time.Now().Add(5 * time.Second)
	waitingOnAdvisory := false
	for time.Now().Before(waitDeadline) {
		if err := admin.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_locks
     WHERE pid = $1 AND locktype = 'advisory' AND NOT granted
)`, pid).Scan(&waitingOnAdvisory); err != nil {
			releaseCallback()
			t.Fatalf("inspect blocked authority writer: %v", err)
		}
		if waitingOnAdvisory {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !waitingOnAdvisory {
		releaseCallback()
		t.Fatal("authority writer was not observed waiting on the callback's shared advisory lease")
	}
	select {
	case writerErr := <-writerDone:
		releaseCallback()
		t.Fatalf("authority writer completed while eligibility callback was held: %v", writerErr)
	default:
	}
	releaseCallback()
	select {
	case callbackErr := <-callbackDone:
		if callbackErr != nil {
			t.Fatalf("release eligibility callback: %v", callbackErr)
		}
	case <-ctx.Done():
		t.Fatalf("eligibility callback did not release: %v", ctx.Err())
	}
	select {
	case writerErr := <-writerDone:
		if writerErr != nil {
			t.Fatalf("authority writer after callback release: %v", writerErr)
		}
	case <-ctx.Done():
		t.Fatalf("authority writer remained blocked after callback release: %v", ctx.Err())
	}
	var blockedAuthorityCount int
	if err := admin.QueryRow(ctx, `
SELECT count(*)::int FROM push_suppression_authorities
 WHERE tenant_id = $1::uuid AND platform = 'fcm' AND device_token_hash = $2
   AND revoked_at IS NULL`, tenantID, blockedDigest[:]).Scan(&blockedAuthorityCount); err != nil {
		t.Fatalf("verify callback-ordered authority write: %v", err)
	}
	if blockedAuthorityCount != 1 {
		t.Fatalf("callback-ordered authority rows=%d want 1", blockedAuthorityCount)
	}

	// Add the FCM authority and prove the resolver returns an all-suppressed
	// result rather than a partial error or an allowed token.
	tx, err = db.WithTenant(ctx, app, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	androidDigest := sha256.Sum256([]byte(androidToken))
	if _, err := tx.Exec(ctx, `
INSERT INTO push_suppression_authorities
    (tenant_id, device_token_hash, platform, authority, reason, source)
VALUES ($1::uuid, $2, 'fcm', 'user', 'user_opt_out', 'preferences.api')`,
		tenantID, androidDigest[:]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed FCM user authority: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	resolution, err = repo.ResolveSendableDevices(ctx, tenantID, subscriberID)
	if err != nil {
		t.Fatalf("resolve all-suppressed devices: %v", err)
	}
	if resolution.EnabledCount != 2 || resolution.SuppressedCount != 2 || len(resolution.Devices) != 0 {
		t.Fatalf("all-authority gate failed: %+v", resolution)
	}

	// Subscriber deletion and device registration take the same pre-row-lock
	// writer lease. Whichever wins may determine the upsert result, but the two
	// operations must complete without a row/advisory-lock deadlock.
	raceSubscriberID := uuid.NewString()
	if _, err := admin.Exec(ctx, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::uuid, $3, 'enabled', 'api')`,
		raceSubscriberID, tenantID, "route43-race-"+raceSubscriberID+"@example.test"); err != nil {
		t.Fatalf("seed subscriber/device race: %v", err)
	}
	raceStart := make(chan struct{})
	type raceResult struct {
		operation string
		err       error
	}
	raceResults := make(chan raceResult, 2)
	go func() {
		<-raceStart
		raceCtx, raceCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer raceCancel()
		_, raceErr := repo.UpsertDevice(raceCtx, tenantID, UpsertDeviceInput{
			SubscriberID: raceSubscriberID,
			Platform:     "ios",
			Token:        "route43-subscriber-delete-race-token-0123456789",
			Enabled:      true,
		})
		raceResults <- raceResult{operation: "upsert", err: raceErr}
	}()
	go func() {
		<-raceStart
		raceCtx, raceCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer raceCancel()
		deleteTx, deleteErr := db.WithTenant(raceCtx, app, tenantID)
		if deleteErr == nil {
			var command pgconn.CommandTag
			command, deleteErr = deleteTx.Exec(raceCtx, `
DELETE FROM subscribers WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, raceSubscriberID)
			if deleteErr == nil && command.RowsAffected() != 1 {
				deleteErr = fmt.Errorf("subscriber delete affected %d rows", command.RowsAffected())
			}
			if deleteErr == nil {
				deleteErr = deleteTx.Commit(raceCtx)
			} else {
				_ = deleteTx.Rollback(raceCtx)
			}
		}
		raceResults <- raceResult{operation: "delete", err: deleteErr}
	}()
	close(raceStart)
	for range 2 {
		select {
		case result := <-raceResults:
			switch result.operation {
			case "delete":
				if result.err != nil {
					t.Fatalf("subscriber delete race: %v", result.err)
				}
			case "upsert":
				if result.err != nil && !errors.Is(result.err, ErrSubscriberNotFound) {
					t.Fatalf("device upsert race: %v", result.err)
				}
			}
		case <-ctx.Done():
			t.Fatalf("subscriber delete/device upsert race did not complete: %v", ctx.Err())
		}
	}
	var remainingSubscriber, remainingRaceDevices int
	if err := admin.QueryRow(ctx, `
SELECT (SELECT count(*)::int FROM subscribers WHERE tenant_id = $1::uuid AND id = $2::uuid),
       (SELECT count(*)::int FROM push_devices WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid)`,
		tenantID, raceSubscriberID).Scan(&remainingSubscriber, &remainingRaceDevices); err != nil {
		t.Fatalf("verify subscriber/device race: %v", err)
	}
	if remainingSubscriber != 0 || remainingRaceDevices != 0 {
		t.Fatalf("subscriber/device race left subscriber/devices=%d/%d", remainingSubscriber, remainingRaceDevices)
	}
}

func pgErrorCode(err *pgconn.PgError) string {
	if err == nil {
		return ""
	}
	return err.Code
}

func pgErrorConstraint(err *pgconn.PgError) string {
	if err == nil {
		return ""
	}
	return err.ConstraintName
}
