// SPDX-License-Identifier: AGPL-3.0-only

package privacy

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/intelligent_retry"
)

func TestSendingOperationalIdentityErasure_DB(t *testing.T) {
	pool := newErasureTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	otherTenantID := uuid.NewString()
	seedErasureTenant(t, pool, tenantID)
	seedErasureTenant(t, pool, otherTenantID)
	t.Cleanup(func() {
		cleanupErasureTenant(t, pool, tenantID)
		cleanupErasureTenant(t, pool, otherTenantID)
	})

	const (
		subject = "sending-identity-erasure@example.test"
		alias   = "sending-identity-alias@example.test"
	)
	campaignID := uuid.NewString()
	otherCampaignID := uuid.NewString()

	otherTx, err := db.WithTenant(ctx, pool, otherTenantID)
	if err != nil {
		t.Fatalf("begin cross-tenant seed: %v", err)
	}
	defer func() { _ = otherTx.Rollback(context.Background()) }()
	seedErasureSubscriber(t, otherTx, otherTenantID, subject, "Other Tenant", "+15555550199", false)
	if _, err := otherTx.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html, status)
VALUES ($1::uuid, $2::uuid, 'cross-tenant privacy canary', 'privacy', '', 'draft')`,
		otherCampaignID, otherTenantID); err != nil {
		t.Fatalf("seed cross-tenant campaign: %v", err)
	}
	if _, err := otherTx.Exec(ctx, `
INSERT INTO subscriber_send_log (tenant_id, subscriber_email, campaign_id, channel)
VALUES ($2::uuid, $3::citext, $1::uuid, 'email')`,
		otherCampaignID, otherTenantID, subject); err != nil {
		t.Fatalf("seed cross-tenant send log: %v", err)
	}
	if _, err := otherTx.Exec(ctx, `
INSERT INTO intelligent_retry_events
    (tenant_id, campaign_id, subscriber_email, reason, status)
VALUES ($2::uuid, $1::uuid, $3::citext, 'cross-tenant-canary', 'pending')`,
		otherCampaignID, otherTenantID, subject); err != nil {
		t.Fatalf("seed cross-tenant retry event: %v", err)
	}
	if err := otherTx.Commit(ctx); err != nil {
		t.Fatalf("commit cross-tenant seed: %v", err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin subject erasure transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	subscriberID := seedErasureSubscriber(t, tx, tenantID, subject, "Erase Subject", "+15555550123", false)
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_emails
    (tenant_id, subscriber_id, email, is_primary, consent_status, suppressed)
VALUES ($1::uuid, $2::uuid, $3::citext, false, 'never_subscribed', false)
ON CONFLICT DO NOTHING`, tenantID, subscriberID, alias); err != nil {
		t.Fatalf("seed subject alias: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html, status)
VALUES ($2::uuid, $1::uuid, 'subject privacy lifecycle', 'privacy', '', 'draft')`,
		tenantID, campaignID); err != nil {
		t.Fatalf("seed subject campaign: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_send_log (tenant_id, subscriber_email, campaign_id, channel)
VALUES
	($1::uuid, $3::citext, $2::uuid, 'email'),
	($1::uuid, $4::citext, $2::uuid, 'email')`,
		tenantID, campaignID, subject, alias); err != nil {
		t.Fatalf("seed subject send log: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO intelligent_retry_events
    (tenant_id, campaign_id, subscriber_email, reason, status, created_at, updated_at)
VALUES
	($1::uuid, $2::uuid, $3::citext, 'erase-primary', 'pending', now(), now()),
	($1::uuid, $2::uuid, $4::citext, 'erase-alias-live-lease', 'retrying',
     now() - interval '40 days', now())`,
		tenantID, campaignID, subject, alias); err != nil {
		t.Fatalf("seed subject retry events: %v", err)
	}

	before := scanForAddress(ctx, t, tx, tenantID, subject, []string{
		"subscriber_send_log", "intelligent_retry_events",
	})
	if before["subscriber_send_log"] != 1 || before["intelligent_retry_events"] != 1 {
		t.Fatalf("primary-address non-vacuity counts = %v", before)
	}
	aliasBefore := scanForAddress(ctx, t, tx, tenantID, alias, []string{
		"subscriber_send_log", "intelligent_retry_events",
	})
	if aliasBefore["subscriber_send_log"] != 1 || aliasBefore["intelligent_retry_events"] != 1 {
		t.Fatalf("alias-address non-vacuity counts = %v", aliasBefore)
	}

	stats, err := eraseSubscriberDataWithEntropy(
		ctx, tx, tenantID, "  "+strings.ToUpper(subject)+"  ",
		bytes.NewReader(bytes.Repeat([]byte{0x91}, erasureNonceBytes)),
	)
	if err != nil {
		t.Fatalf("erase sending operational identity: %v", err)
	}
	if stats.SubscriberSendLogDeleted != 2 || stats.IntelligentRetryEventsDeleted != 2 {
		t.Fatalf("erasure counts send-log/retry=%d/%d, want 2/2",
			stats.SubscriberSendLogDeleted, stats.IntelligentRetryEventsDeleted)
	}
	for _, address := range []string{subject, alias} {
		if after := scanForAddress(ctx, t, tx, tenantID, address, []string{
			"subscriber_send_log", "intelligent_retry_events",
		}); len(after) != 0 {
			t.Fatalf("address %q survived sending identity erasure in %v", address, after)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit sending identity erasure: %v", err)
	}

	otherVerify, err := db.WithTenant(ctx, pool, otherTenantID)
	if err != nil {
		t.Fatalf("begin cross-tenant verification: %v", err)
	}
	defer func() { _ = otherVerify.Rollback(context.Background()) }()
	var otherRows int
	if err := otherVerify.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM subscriber_send_log
    WHERE tenant_id=$1::uuid AND subscriber_email=$2::citext)
  +
  (SELECT count(*) FROM intelligent_retry_events
    WHERE tenant_id=$1::uuid AND subscriber_email=$2::citext)`,
		otherTenantID, subject).Scan(&otherRows); err != nil {
		t.Fatalf("read cross-tenant sending identity canaries: %v", err)
	}
	if otherRows != 2 {
		t.Fatalf("cross-tenant sending identity rows=%d, want 2", otherRows)
	}
}

func TestSendingIdentityErasureSerializesRetryEnqueue_DB(t *testing.T) {
	pool := newErasureTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	seedErasureTenant(t, pool, tenantID)
	t.Cleanup(func() { cleanupErasureTenant(t, pool, tenantID) })
	waitForAdvisoryWaiter := func(t *testing.T, backendPID uint32) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			var waiting bool
			if err := pool.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM pg_locks
     WHERE pid=$1 AND locktype='advisory' AND NOT granted
)`, backendPID).Scan(&waiting); err != nil {
				t.Fatalf("inspect erasure/enqueue advisory waiter: %v", err)
			}
			if waiting {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("backend %d never became an advisory-lock waiter", backendPID)
			}
			select {
			case <-ctx.Done():
				t.Fatalf("wait for erasure/enqueue advisory waiter: %v", ctx.Err())
			case <-time.After(10 * time.Millisecond):
			}
		}
	}

	type fixture struct {
		email      string
		alias      string
		campaignID string
	}
	seedFixture := func(label string) fixture {
		item := fixture{
			email:      "erasure-enqueue-" + label + "-" + uuid.NewString() + "@example.test",
			alias:      "erasure-enqueue-alias-" + label + "-" + uuid.NewString() + "@example.test",
			campaignID: uuid.NewString(),
		}
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("begin %s fixture: %v", label, err)
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		subscriberID := seedErasureSubscriber(t, tx, tenantID, item.email, "Race Subject", "+15555550123", false)
		if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_emails
    (tenant_id,subscriber_id,email,is_primary,consent_status,suppressed)
VALUES ($1::uuid,$2::uuid,$3::citext,false,'never_subscribed',false)`,
			tenantID, subscriberID, item.alias); err != nil {
			t.Fatalf("seed %s secondary alias: %v", label, err)
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html, status)
VALUES ($1::uuid, $2::uuid, $3, 'privacy race', '', 'draft')`,
			item.campaignID, tenantID, "erasure enqueue "+label); err != nil {
			t.Fatalf("seed %s campaign: %v", label, err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit %s fixture: %v", label, err)
		}
		return item
	}

	t.Run("erasure commits before blocked enqueue", func(t *testing.T) {
		item := seedFixture("erasure-first")
		erasureTx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("begin erasure-first transaction: %v", err)
		}
		defer func() { _ = erasureTx.Rollback(context.Background()) }()
		if _, err := eraseSubscriberDataWithEntropy(
			ctx, erasureTx, tenantID, item.email,
			bytes.NewReader(bytes.Repeat([]byte{0xa1}, erasureNonceBytes)),
		); err != nil {
			t.Fatalf("run fenced erasure: %v", err)
		}

		pidReady := make(chan uint32, 1)
		enqueueDone := make(chan error, 1)
		go func() {
			tx, beginErr := db.WithTenant(ctx, pool, tenantID)
			if beginErr != nil {
				enqueueDone <- beginErr
				return
			}
			defer func() { _ = tx.Rollback(context.Background()) }()
			pidReady <- tx.Conn().PgConn().PID()
			queue := &intelligent_retry.Queue{}
			if enqueueErr := queue.EnqueueFrequencySkippedTx(
				ctx, tx, tenantID, item.campaignID, []string{item.email, item.alias}, nil,
				time.Now().UTC().Add(time.Hour),
			); enqueueErr != nil {
				enqueueDone <- enqueueErr
				return
			}
			enqueueDone <- tx.Commit(ctx)
		}()
		waitForAdvisoryWaiter(t, <-pidReady)
		if err := erasureTx.Commit(ctx); err != nil {
			t.Fatalf("commit erasure-first transaction: %v", err)
		}
		select {
		case err := <-enqueueDone:
			if err != nil {
				t.Fatalf("enqueue after erasure commit: %v", err)
			}
		case <-ctx.Done():
			t.Fatalf("enqueue did not resume after erasure commit: %v", ctx.Err())
		}

		verify, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("begin erasure-first verification: %v", err)
		}
		defer func() { _ = verify.Rollback(context.Background()) }()
		var retryRows, tombstones int
		if err := verify.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM intelligent_retry_events
	WHERE tenant_id=$1::uuid AND campaign_id=$2::uuid),
  (SELECT count(*) FROM subscriber_suppressions
    WHERE tenant_id=$1::uuid AND reason='dsar_deletion'
	  AND email_sha256 IN (
	      encode(digest(lower($3), 'sha256'), 'hex'),
	      encode(digest(lower($4), 'sha256'), 'hex')
	  ))`, tenantID, item.campaignID, item.email, item.alias).Scan(&retryRows, &tombstones); err != nil {
			t.Fatalf("verify erasure-first retry/tombstone: %v", err)
		}
		if retryRows != 0 || tombstones != 2 {
			t.Fatalf("erasure-first retry/tombstones=%d/%d, want 0/2", retryRows, tombstones)
		}
	})

	t.Run("enqueue commits before blocked erasure", func(t *testing.T) {
		item := seedFixture("enqueue-first")
		enqueueTx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("begin enqueue-first transaction: %v", err)
		}
		defer func() { _ = enqueueTx.Rollback(context.Background()) }()
		queue := &intelligent_retry.Queue{}
		if err := queue.EnqueueFrequencySkippedTx(
			ctx, enqueueTx, tenantID, item.campaignID, []string{item.email, item.alias}, nil,
			time.Now().UTC().Add(time.Hour),
		); err != nil {
			t.Fatalf("insert retry before erasure: %v", err)
		}

		type eraseOutcome struct {
			stats eraseStats
			err   error
		}
		pidReady := make(chan uint32, 1)
		eraseDone := make(chan eraseOutcome, 1)
		go func() {
			tx, beginErr := db.WithTenant(ctx, pool, tenantID)
			if beginErr != nil {
				eraseDone <- eraseOutcome{err: beginErr}
				return
			}
			defer func() { _ = tx.Rollback(context.Background()) }()
			pidReady <- tx.Conn().PgConn().PID()
			stats, eraseErr := eraseSubscriberDataWithEntropy(
				ctx, tx, tenantID, item.email,
				bytes.NewReader(bytes.Repeat([]byte{0xa2}, erasureNonceBytes)),
			)
			if eraseErr == nil {
				eraseErr = tx.Commit(ctx)
			}
			eraseDone <- eraseOutcome{stats: stats, err: eraseErr}
		}()
		waitForAdvisoryWaiter(t, <-pidReady)
		if err := enqueueTx.Commit(ctx); err != nil {
			t.Fatalf("commit enqueue-first transaction: %v", err)
		}
		var outcome eraseOutcome
		select {
		case outcome = <-eraseDone:
		case <-ctx.Done():
			t.Fatalf("erasure did not resume after enqueue commit: %v", ctx.Err())
		}
		if outcome.err != nil {
			t.Fatalf("erasure after enqueue commit: %v", outcome.err)
		}
		// Both addresses resolve to one canonical tuple before enqueue, so the
		// unique retry key stores one row; erasure must remove that row.
		if outcome.stats.IntelligentRetryEventsDeleted != 1 {
			t.Fatalf("erasure deleted retry rows=%d, want 1", outcome.stats.IntelligentRetryEventsDeleted)
		}

		verify, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("begin enqueue-first verification: %v", err)
		}
		defer func() { _ = verify.Rollback(context.Background()) }()
		var retryRows int
		if err := verify.QueryRow(ctx, `
SELECT count(*) FROM intelligent_retry_events
	 WHERE tenant_id=$1::uuid AND campaign_id=$2::uuid`,
			tenantID, item.campaignID).Scan(&retryRows); err != nil {
			t.Fatalf("verify enqueue-first retry rows: %v", err)
		}
		if retryRows != 0 {
			t.Fatalf("enqueue-first retry rows after erasure=%d, want 0", retryRows)
		}
	})
}
