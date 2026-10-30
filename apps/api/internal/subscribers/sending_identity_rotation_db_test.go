// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/frequency"
	"github.com/postwave/postwave/apps/api/internal/intelligent_retry"
	"github.com/postwave/postwave/apps/api/internal/subscriberidentitylock"
)

func TestCanonicalEmailRotationRepointsSendingIdentityState_DB(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	var bypassRLS, appRole, canRotateSendEmail, canUpdateSendTable, canUpdateSentAt bool
	if err := pool.QueryRow(ctx, `
SELECT role.rolsuper OR role.rolbypassrls,
       pg_has_role(current_user, 'postwave_app', 'member'),
       has_column_privilege(current_user, 'subscriber_send_log', 'subscriber_email', 'UPDATE'),
       has_table_privilege(current_user, 'subscriber_send_log', 'UPDATE'),
       has_column_privilege(current_user, 'subscriber_send_log', 'sent_at', 'UPDATE')
  FROM pg_roles AS role
 WHERE role.rolname = current_user`).Scan(
		&bypassRLS, &appRole, &canRotateSendEmail, &canUpdateSendTable, &canUpdateSentAt,
	); err != nil {
		t.Fatalf("inspect sending-identity rotation privilege: %v", err)
	}
	if bypassRLS || !appRole {
		t.Fatalf("DATABASE_URL must use a non-BYPASSRLS postwave_app role; bypass=%v member=%v",
			bypassRLS, appRole)
	}
	if !canRotateSendEmail || canUpdateSendTable || canUpdateSentAt {
		t.Fatalf("subscriber_send_log UPDATE privilege email=%v table=%v sent_at=%v; want narrow email-only grant",
			canRotateSendEmail, canUpdateSendTable, canUpdateSentAt)
	}

	tenantID := uuid.NewString()
	otherTenantID := uuid.NewString()
	seedPrimaryEmailTenant(t, pool, tenantID)
	seedPrimaryEmailTenant(t, pool, otherTenantID)
	cleanupTenant := func(id string) {
		t.Helper()
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		tx, err := db.WithTenant(cleanupCtx, pool, id)
		if err != nil {
			t.Logf("begin rotation tenant cleanup %s: %v", id, err)
			return
		}
		defer func() { _ = tx.Rollback(cleanupCtx) }()
		if _, err := tx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id=$1::uuid`, id); err != nil {
			t.Logf("delete rotation tenant %s: %v", id, err)
			return
		}
		if err := tx.Commit(cleanupCtx); err != nil {
			t.Logf("commit rotation tenant cleanup %s: %v", id, err)
		}
	}
	t.Cleanup(func() {
		cleanupTenant(tenantID)
		cleanupTenant(otherTenantID)
	})

	repo := &Repo{Pool: pool}
	suffix := time.Now().UnixNano()
	oldEmail := fmt.Sprintf("rotation-old-%d@example.test", suffix)
	newEmail := fmt.Sprintf("rotation-new-%d@example.test", suffix)
	created, err := repo.Upsert(ctx, tenantID, CreateInput{Email: oldEmail})
	if err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	if _, err := repo.AddEmail(ctx, tenantID, created.ID, AddEmailInput{Email: newEmail}, db.AuditMeta{
		TenantID: tenantID, ActorType: "system", ActorLabel: "sending-identity-rotation-test",
	}); err != nil {
		t.Fatalf("seed canonical target address: %v", err)
	}

	campaignID := uuid.NewString()
	otherCampaignID := uuid.NewString()
	leaseClock := time.Now().UTC().Truncate(time.Microsecond)
	targetLiveRevision := leaseClock.Add(-5 * time.Minute)
	sourceLiveRevision := leaseClock.Add(-4 * time.Minute)
	nonCollisionClaimRevision := leaseClock.Add(-3 * time.Minute)
	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin rotation fixture seed: %v", err)
	}
	defer func() { _ = seedTx.Rollback(context.Background()) }()
	if _, err := seedTx.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html, status)
VALUES ($1::uuid, $2::uuid, 'sending identity rotation', 'rotation', '', 'draft')`,
		campaignID, tenantID); err != nil {
		t.Fatalf("seed rotation campaign: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO frequency_cap_rules (tenant_id, label, max_sends, window_hours, active)
VALUES ($1::uuid, 'rotation history cannot reset', 2, 720, true)`, tenantID); err != nil {
		t.Fatalf("seed frequency rule: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO subscriber_send_log
    (tenant_id, subscriber_email, campaign_id, channel, sent_at)
VALUES
    ($1::uuid, $2::citext, $4::uuid, 'email', now() - interval '2 hours'),
    ($1::uuid, $2::citext, $4::uuid, 'email', now() - interval '1 hour'),
    ($1::uuid, $3::citext, $4::uuid, 'email', now())`,
		tenantID, oldEmail, newEmail, campaignID); err != nil {
		t.Fatalf("seed send history: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO intelligent_retry_events
	(tenant_id, campaign_id, subscriber_email, reason, status, attempts, updated_at)
VALUES
	($1::uuid, $2::uuid, $3::citext, 'sticky-dismissed', 'dismissed', 7, $5),
	($1::uuid, $2::uuid, $4::citext, 'sticky-dismissed', 'pending', 1, $6),
	($1::uuid, $2::uuid, $3::citext, 'terminal-retried', 'retried', 4, $5),
	($1::uuid, $2::uuid, $4::citext, 'terminal-retried', 'pending', 2, $6),
	($1::uuid, $2::uuid, $3::citext, 'canonical-live', 'ready', 2, $6),
	($1::uuid, $2::uuid, $4::citext, 'canonical-live', 'retrying', 3, $7),
	($1::uuid, $2::uuid, $3::citext, 'source-live', 'retrying', 5, $8),
	($1::uuid, $2::uuid, $4::citext, 'source-live', 'pending', 1, $6),
	($1::uuid, $2::uuid, $3::citext, 'move-only', 'failed', 2, $5),
	($1::uuid, $2::uuid, $4::citext, 'target-only', 'retried', 3, $6)`,
		tenantID, campaignID, oldEmail, newEmail,
		leaseClock.Add(-10*time.Minute), leaseClock.Add(-2*time.Minute),
		targetLiveRevision, sourceLiveRevision); err != nil {
		t.Fatalf("seed retry collision fixture: %v", err)
	}
	var claimedMoveID string
	if err := seedTx.QueryRow(ctx, `
INSERT INTO intelligent_retry_events
    (tenant_id, campaign_id, subscriber_email, reason, status, attempts, updated_at)
VALUES ($1::uuid, $2::uuid, $3::citext, 'claimed-move', 'retrying', 4, $4)
RETURNING id::text`, tenantID, campaignID, oldEmail, nonCollisionClaimRevision).Scan(&claimedMoveID); err != nil {
		t.Fatalf("seed non-colliding claimed retry: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit rotation fixture seed: %v", err)
	}

	otherTx, err := db.WithTenant(ctx, pool, otherTenantID)
	if err != nil {
		t.Fatalf("begin cross-tenant rotation fixture: %v", err)
	}
	defer func() { _ = otherTx.Rollback(context.Background()) }()
	if _, err := otherTx.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html, status)
VALUES ($1::uuid, $2::uuid, 'cross-tenant rotation canary', 'rotation', '', 'draft')`,
		otherCampaignID, otherTenantID); err != nil {
		t.Fatalf("seed cross-tenant campaign: %v", err)
	}
	if _, err := otherTx.Exec(ctx, `
INSERT INTO subscriber_send_log (tenant_id, subscriber_email, campaign_id, channel)
VALUES ($1::uuid, $2::citext, $3::uuid, 'email')`,
		otherTenantID, oldEmail, otherCampaignID); err != nil {
		t.Fatalf("seed cross-tenant send-log canary: %v", err)
	}
	if _, err := otherTx.Exec(ctx, `
INSERT INTO intelligent_retry_events
    (tenant_id, campaign_id, subscriber_email, reason, status)
VALUES ($1::uuid, $2::uuid, $3::citext, 'collision', 'pending')`,
		otherTenantID, otherCampaignID, oldEmail); err != nil {
		t.Fatalf("seed cross-tenant retry canary: %v", err)
	}
	if err := otherTx.Commit(ctx); err != nil {
		t.Fatalf("commit cross-tenant rotation fixture: %v", err)
	}

	rotated, err := repo.Update(ctx, tenantID, created.ID, UpdateInput{Email: &newEmail})
	if err != nil {
		t.Fatalf("rotate canonical subscriber address: %v", err)
	}
	if rotated.Email != newEmail || rotated.PrimaryEmail != newEmail {
		t.Fatalf("rotated subscriber identity email=%q primary=%q, want %q",
			rotated.Email, rotated.PrimaryEmail, newEmail)
	}

	// Replaying the canonical helper after the source address is gone is a
	// no-op. This models at-least-once orchestration without duplicating or
	// deleting canonical history.
	idempotentTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin idempotency proof: %v", err)
	}
	defer func() { _ = idempotentTx.Rollback(context.Background()) }()
	if err := RepointSubscriberEmail(ctx, idempotentTx, tenantID, oldEmail, newEmail); err != nil {
		t.Fatalf("replay sending identity repoint: %v", err)
	}
	if err := RepointSubscriberEmail(ctx, idempotentTx, tenantID, oldEmail, newEmail); err != nil {
		t.Fatalf("second replay sending identity repoint: %v", err)
	}
	if err := idempotentTx.Commit(ctx); err != nil {
		t.Fatalf("commit idempotency proof: %v", err)
	}

	verifyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin rotation verification: %v", err)
	}
	defer func() { _ = verifyTx.Rollback(context.Background()) }()
	var oldSends, newSends, totalSends int
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE subscriber_email=$2::citext),
       count(*) FILTER (WHERE subscriber_email=$3::citext),
       count(*)
  FROM subscriber_send_log
 WHERE tenant_id=$1::uuid`, tenantID, oldEmail, newEmail).Scan(
		&oldSends, &newSends, &totalSends,
	); err != nil {
		t.Fatalf("verify canonical send history: %v", err)
	}
	if oldSends != 0 || newSends != 3 || totalSends != 3 {
		t.Fatalf("send history old=%d new=%d total=%d, want 0/3/3", oldSends, newSends, totalSends)
	}
	var oldRetries, newRetries int
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE subscriber_email=$2::citext),
       count(*) FILTER (WHERE subscriber_email=$3::citext)
  FROM intelligent_retry_events
 WHERE tenant_id=$1::uuid`, tenantID, oldEmail, newEmail).Scan(&oldRetries, &newRetries); err != nil {
		t.Fatalf("verify canonical retry identities: %v", err)
	}
	if oldRetries != 0 || newRetries != 7 {
		t.Fatalf("retry identities old=%d new=%d, want 0/7", oldRetries, newRetries)
	}
	for reason, want := range map[string]struct {
		status          string
		attempts        int
		exactRevision   *time.Time
		afterRevision   *time.Time
		expectedEventID string
	}{
		"sticky-dismissed": {status: "dismissed", attempts: 8},
		"terminal-retried": {status: "retried", attempts: 6},
		"canonical-live":   {status: "retrying", attempts: 5, exactRevision: &targetLiveRevision},
		"source-live":      {status: "pending", attempts: 6, afterRevision: &sourceLiveRevision},
		"move-only":        {status: "failed", attempts: 2},
		"claimed-move": {
			status: "pending", attempts: 4, afterRevision: &nonCollisionClaimRevision,
			expectedEventID: claimedMoveID,
		},
		"target-only": {status: "retried", attempts: 3},
	} {
		var id, status string
		var attempts int
		var updatedAt time.Time
		if err := verifyTx.QueryRow(ctx, `
SELECT id::text, status, attempts, updated_at FROM intelligent_retry_events
 WHERE tenant_id=$1::uuid AND campaign_id=$2::uuid
   AND subscriber_email=$3::citext AND reason=$4`,
			tenantID, campaignID, newEmail, reason).Scan(&id, &status, &attempts, &updatedAt); err != nil {
			t.Fatalf("verify retry tuple %s: %v", reason, err)
		}
		if status != want.status || attempts != want.attempts {
			t.Errorf("retry tuple %s status=%q attempts=%d, want %q/%d",
				reason, status, attempts, want.status, want.attempts)
		}
		if want.exactRevision != nil && !updatedAt.Equal(*want.exactRevision) {
			t.Errorf("retry tuple %s revision=%s, want exact live target revision %s",
				reason, updatedAt, *want.exactRevision)
		}
		if want.afterRevision != nil && !updatedAt.After(*want.afterRevision) {
			t.Errorf("retry tuple %s revision=%s did not invalidate old claim %s",
				reason, updatedAt, *want.afterRevision)
		}
		if want.expectedEventID != "" && id != want.expectedEventID {
			t.Errorf("retry tuple %s id=%s, want moved source id %s", reason, id, want.expectedEventID)
		}
	}
	staleClaim, err := verifyTx.Exec(ctx, `
UPDATE intelligent_retry_events
   SET status='failed'
 WHERE tenant_id=$1::uuid AND id=$2::uuid
   AND status='retrying' AND updated_at=$3`,
		tenantID, claimedMoveID, nonCollisionClaimRevision)
	if err != nil {
		t.Fatalf("attempt stale old-email lease CAS: %v", err)
	}
	if staleClaim.RowsAffected() != 0 {
		t.Fatal("old-email worker lease still mutated the repointed retry event")
	}
	if err := verifyTx.Commit(ctx); err != nil {
		t.Fatalf("commit rotation verification: %v", err)
	}

	filtered, err := frequency.FilterAudience(ctx, pool, tenantID, []string{newEmail})
	if err != nil {
		t.Fatalf("evaluate frequency history after rotation: %v", err)
	}
	if filtered.Skipped != 1 || len(filtered.Kept) != 0 {
		t.Fatalf("rotated address evaded frequency history: skipped=%d kept=%v",
			filtered.Skipped, filtered.Kept)
	}

	crossTx, err := db.WithTenant(ctx, pool, otherTenantID)
	if err != nil {
		t.Fatalf("begin cross-tenant rotation verification: %v", err)
	}
	defer func() { _ = crossTx.Rollback(context.Background()) }()
	var crossSends, crossRetries int
	if err := crossTx.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM subscriber_send_log
    WHERE tenant_id=$1::uuid AND subscriber_email=$2::citext),
  (SELECT count(*) FROM intelligent_retry_events
    WHERE tenant_id=$1::uuid AND subscriber_email=$2::citext)`,
		otherTenantID, oldEmail).Scan(&crossSends, &crossRetries); err != nil {
		t.Fatalf("verify cross-tenant rotation canaries: %v", err)
	}
	if crossSends != 1 || crossRetries != 1 {
		t.Fatalf("cross-tenant old-address rows sends/retries=%d/%d, want 1/1", crossSends, crossRetries)
	}
}

func TestCanonicalMergeRepointsSurvivorSendingIdentityWhenDuplicateEmailWins_DB(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	seedPrimaryEmailTenant(t, pool, tenantID)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		tx, err := db.WithTenant(cleanupCtx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx.Rollback(cleanupCtx) }()
		_, _ = tx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id=$1::uuid`, tenantID)
		_ = tx.Commit(cleanupCtx)
	})

	repo := &Repo{Pool: pool}
	primary, err := repo.Upsert(ctx, tenantID, CreateInput{
		Email: "canonical-merge-primary-" + uuid.NewString() + "@example.test",
	})
	if err != nil {
		t.Fatalf("seed merge primary: %v", err)
	}
	duplicate, err := repo.Upsert(ctx, tenantID, CreateInput{
		Email: "canonical-merge-duplicate-" + uuid.NewString() + "@example.test",
	})
	if err != nil {
		t.Fatalf("seed merge duplicate: %v", err)
	}
	campaignID := uuid.NewString()
	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin merge identity seed: %v", err)
	}
	defer func() { _ = seedTx.Rollback(context.Background()) }()
	if _, err := seedTx.Exec(ctx, `
INSERT INTO campaigns (id,tenant_id,name,subject,body_html,status)
VALUES ($1::uuid,$2::uuid,'canonical duplicate wins','merge','','draft')`, campaignID, tenantID); err != nil {
		t.Fatalf("seed merge campaign: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO subscriber_send_log (tenant_id,subscriber_email,campaign_id,channel)
VALUES
 ($1::uuid,$2::citext,$4::uuid,'email'),
 ($1::uuid,$2::citext,$4::uuid,'email'),
 ($1::uuid,$3::citext,$4::uuid,'email')`,
		tenantID, primary.Email, duplicate.Email, campaignID); err != nil {
		t.Fatalf("seed merge send history: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO intelligent_retry_events
    (tenant_id,campaign_id,subscriber_email,reason,status,attempts)
VALUES
 ($1::uuid,$2::uuid,$3::citext,'sticky-merge','dismissed',4),
 ($1::uuid,$2::uuid,$4::citext,'sticky-merge','pending',1),
 ($1::uuid,$2::uuid,$3::citext,'survivor-only','failed',2)`,
		tenantID, campaignID, primary.Email, duplicate.Email); err != nil {
		t.Fatalf("seed merge retry history: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit merge identity seed: %v", err)
	}

	mergeTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin canonical merge: %v", err)
	}
	defer func() { _ = mergeTx.Rollback(context.Background()) }()
	out, err := repo.mergeCanonicalInTx(ctx, mergeTx, tenantID, primary.ID, duplicate.ID, canonicalMergeOptions{
		PrimaryVersion:   primary.Version,
		DuplicateVersion: duplicate.Version,
		CanonicalEmail:   duplicate.Email,
		AuditReason:      "route46_duplicate_email_wins",
		AuditMeta: db.AuditMeta{
			TenantID: tenantID, ActorType: "system", ActorLabel: "route46-merge-test",
		},
	})
	if err != nil {
		t.Fatalf("merge with duplicate canonical email: %v", err)
	}
	if out.Subscriber.Email != duplicate.Email || out.Subscriber.PrimaryEmail != duplicate.Email {
		t.Fatalf("merge survivor identity email=%q primary=%q, want duplicate canonical %q",
			out.Subscriber.Email, out.Subscriber.PrimaryEmail, duplicate.Email)
	}
	if err := mergeTx.Commit(ctx); err != nil {
		t.Fatalf("commit canonical merge: %v", err)
	}

	verifyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin canonical merge verification: %v", err)
	}
	defer func() { _ = verifyTx.Rollback(context.Background()) }()
	var oldSends, canonicalSends int
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE subscriber_email=$2::citext),
       count(*) FILTER (WHERE subscriber_email=$3::citext)
  FROM subscriber_send_log WHERE tenant_id=$1::uuid`,
		tenantID, primary.Email, duplicate.Email).Scan(&oldSends, &canonicalSends); err != nil {
		t.Fatalf("verify survivor send history: %v", err)
	}
	if oldSends != 0 || canonicalSends != 3 {
		t.Fatalf("survivor send history old/canonical=%d/%d, want 0/3", oldSends, canonicalSends)
	}
	var oldRetries, canonicalRetries int
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE subscriber_email=$2::citext),
       count(*) FILTER (WHERE subscriber_email=$3::citext)
  FROM intelligent_retry_events WHERE tenant_id=$1::uuid`,
		tenantID, primary.Email, duplicate.Email).Scan(&oldRetries, &canonicalRetries); err != nil {
		t.Fatalf("verify survivor retry identity: %v", err)
	}
	if oldRetries != 0 || canonicalRetries != 2 {
		t.Fatalf("survivor retries old/canonical=%d/%d, want 0/2", oldRetries, canonicalRetries)
	}
	var stickyStatus string
	var stickyAttempts int
	if err := verifyTx.QueryRow(ctx, `
SELECT status,attempts FROM intelligent_retry_events
 WHERE tenant_id=$1::uuid AND campaign_id=$2::uuid
   AND subscriber_email=$3::citext AND reason='sticky-merge'`,
		tenantID, campaignID, duplicate.Email).Scan(&stickyStatus, &stickyAttempts); err != nil {
		t.Fatalf("verify sticky merge retry: %v", err)
	}
	if stickyStatus != "dismissed" || stickyAttempts != 5 {
		t.Fatalf("sticky merge retry status/attempts=%s/%d, want dismissed/5", stickyStatus, stickyAttempts)
	}
}

func TestRetryEnqueueSerializesWithCanonicalEmailRotation_DB(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	seedPrimaryEmailTenant(t, pool, tenantID)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		tx, err := db.WithTenant(cleanupCtx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx.Rollback(cleanupCtx) }()
		_, _ = tx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id=$1::uuid`, tenantID)
		_ = tx.Commit(cleanupCtx)
	})

	repo := &Repo{Pool: pool}
	oldEmail := "enqueue-race-old-" + uuid.NewString() + "@example.test"
	newEmail := "enqueue-race-new-" + uuid.NewString() + "@example.test"
	subscriber, err := repo.Upsert(ctx, tenantID, CreateInput{Email: oldEmail})
	if err != nil {
		t.Fatalf("seed enqueue-race subscriber: %v", err)
	}
	if _, err := repo.AddEmail(ctx, tenantID, subscriber.ID, AddEmailInput{Email: newEmail}, db.AuditMeta{
		TenantID: tenantID, ActorType: "system", ActorLabel: "enqueue-rotation-race-test",
	}); err != nil {
		t.Fatalf("seed enqueue-race target address: %v", err)
	}
	campaignID := uuid.NewString()
	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin enqueue-race campaign seed: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO campaigns (id,tenant_id,name,subject,body_html,status)
VALUES ($1::uuid,$2::uuid,'retry enqueue rotation race','race','','draft')`, campaignID, tenantID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed enqueue-race campaign: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit enqueue-race campaign: %v", err)
	}

	// Hold the production identity fence after performing the same canonical
	// row/address/repoint sequence as Repo.Update, but before commit. The retry
	// enqueue starts precisely in the old scan/commit gap and must remain blocked
	// rather than inserting oldEmail.
	rotationTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin deterministic rotation transaction: %v", err)
	}
	defer func() { _ = rotationTx.Rollback(context.Background()) }()
	if err := subscriberidentitylock.Tenant(ctx, rotationTx, tenantID); err != nil {
		t.Fatalf("take deterministic rotation fence: %v", err)
	}
	if _, err := rotationTx.Exec(ctx, `
UPDATE subscribers
   SET email=$3::citext,primary_email=$3::citext,updated_at=clock_timestamp()
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, subscriber.ID, newEmail); err != nil {
		t.Fatalf("rotate subscriber row in fenced transaction: %v", err)
	}
	if err := rotateCanonicalSubscriberEmailInTx(ctx, rotationTx, tenantID, subscriber.ID, oldEmail, newEmail); err != nil {
		t.Fatalf("rotate normalized address in fenced transaction: %v", err)
	}
	if err := repointSubscriberEmail(ctx, rotationTx, tenantID, oldEmail, newEmail); err != nil {
		t.Fatalf("repoint satellites in fenced transaction: %v", err)
	}

	enqueueDone := make(chan error, 1)
	go func() {
		enqueueTx, beginErr := db.WithTenant(ctx, pool, tenantID)
		if beginErr != nil {
			enqueueDone <- beginErr
			return
		}
		defer func() { _ = enqueueTx.Rollback(context.Background()) }()
		queue := &intelligent_retry.Queue{}
		if enqueueErr := queue.EnqueueFrequencySkippedTx(
			ctx, enqueueTx, tenantID, campaignID, []string{oldEmail}, nil,
			time.Now().UTC().Add(time.Hour),
		); enqueueErr != nil {
			enqueueDone <- enqueueErr
			return
		}
		enqueueDone <- enqueueTx.Commit(ctx)
	}()
	select {
	case err := <-enqueueDone:
		t.Fatalf("retry enqueue crossed uncommitted rotation fence: %v", err)
	case <-time.After(150 * time.Millisecond):
		// Expected: the enqueue is waiting on the transaction-scoped identity lock.
	}
	if err := rotationTx.Commit(ctx); err != nil {
		t.Fatalf("commit deterministic rotation: %v", err)
	}
	select {
	case err := <-enqueueDone:
		if err != nil {
			t.Fatalf("enqueue after rotation commit: %v", err)
		}
	case <-ctx.Done():
		t.Fatalf("enqueue did not resume after rotation commit: %v", ctx.Err())
	}

	verifyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin enqueue-race verification: %v", err)
	}
	defer func() { _ = verifyTx.Rollback(context.Background()) }()
	var oldRows, canonicalRows int
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE subscriber_email=$2::citext),
       count(*) FILTER (WHERE subscriber_email=$3::citext)
  FROM intelligent_retry_events
 WHERE tenant_id=$1::uuid AND campaign_id=$4::uuid`,
		tenantID, oldEmail, newEmail, campaignID).Scan(&oldRows, &canonicalRows); err != nil {
		t.Fatalf("verify enqueue-race identities: %v", err)
	}
	if oldRows != 0 || canonicalRows != 1 {
		t.Fatalf("interleaved retry enqueue old/canonical rows=%d/%d, want 0/1", oldRows, canonicalRows)
	}
}

func TestFrequencyAdmissionSerializesWithCanonicalEmailRotation_DB(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

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
				t.Fatalf("inspect advisory lock waiter: %v", err)
			}
			if waiting {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("backend %d never became an advisory-lock waiter", backendPID)
			}
			select {
			case <-ctx.Done():
				t.Fatalf("wait for advisory lock waiter: %v", ctx.Err())
			case <-time.After(10 * time.Millisecond):
			}
		}
	}

	type rotationFixture struct {
		tenantID            string
		subscriberID        string
		historyCampaignID   string
		admissionCampaignID string
		oldEmail            string
		newEmail            string
	}
	seedFixture := func(t *testing.T, label string) rotationFixture {
		t.Helper()
		fixture := rotationFixture{
			tenantID:            uuid.NewString(),
			historyCampaignID:   uuid.NewString(),
			admissionCampaignID: uuid.NewString(),
			oldEmail:            "freq-old-" + label + "-" + uuid.NewString()[:8] + "@example.test",
			newEmail:            "freq-new-" + label + "-" + uuid.NewString()[:8] + "@example.test",
		}
		seedPrimaryEmailTenant(t, pool, fixture.tenantID)
		t.Cleanup(func() {
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cleanupCancel()
			tx, err := db.WithTenant(cleanupCtx, pool, fixture.tenantID)
			if err != nil {
				return
			}
			defer func() { _ = tx.Rollback(cleanupCtx) }()
			_, _ = tx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id=$1::uuid`, fixture.tenantID)
			_ = tx.Commit(cleanupCtx)
		})
		repo := &Repo{Pool: pool}
		subscriber, err := repo.Upsert(ctx, fixture.tenantID, CreateInput{Email: fixture.oldEmail})
		if err != nil {
			t.Fatalf("seed %s subscriber: %v", label, err)
		}
		fixture.subscriberID = subscriber.ID
		if _, err := repo.AddEmail(ctx, fixture.tenantID, subscriber.ID, AddEmailInput{Email: fixture.newEmail}, db.AuditMeta{
			TenantID: fixture.tenantID, ActorType: "system", ActorLabel: "frequency-rotation-race-test",
		}); err != nil {
			t.Fatalf("seed %s target alias: %v", label, err)
		}
		tx, err := db.WithTenant(ctx, pool, fixture.tenantID)
		if err != nil {
			t.Fatalf("begin %s frequency fixture: %v", label, err)
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		if _, err := tx.Exec(ctx, `
INSERT INTO campaigns (id,tenant_id,name,subject,body_html,status)
VALUES
    ($1::uuid,$3::uuid,$4 || ' history','race','','draft'),
    ($2::uuid,$3::uuid,$4 || ' admission','race','','draft')`,
			fixture.historyCampaignID, fixture.admissionCampaignID, fixture.tenantID, "frequency rotation "+label); err != nil {
			t.Fatalf("seed %s campaign: %v", label, err)
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO frequency_cap_rules (tenant_id,label,max_sends,window_hours,active,channels)
VALUES ($1::uuid,$2,1,24,true,ARRAY['email']::text[])`, fixture.tenantID, "one send "+label); err != nil {
			t.Fatalf("seed %s cap: %v", label, err)
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_send_log (tenant_id,subscriber_email,campaign_id,channel,sent_at)
VALUES ($1::uuid,$2::citext,$3::uuid,'email',now())`, fixture.tenantID, fixture.oldEmail, fixture.historyCampaignID); err != nil {
			t.Fatalf("seed %s old-address history: %v", label, err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit %s frequency fixture: %v", label, err)
		}
		return fixture
	}

	rotateInTx := func(tx pgx.Tx, fixture rotationFixture) error {
		if err := subscriberidentitylock.Tenant(ctx, tx, fixture.tenantID); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `
UPDATE subscribers
   SET email=$3::citext,primary_email=$3::citext,updated_at=clock_timestamp()
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, fixture.tenantID, fixture.subscriberID, fixture.newEmail); err != nil {
			return err
		}
		if err := rotateCanonicalSubscriberEmailInTx(
			ctx, tx, fixture.tenantID, fixture.subscriberID, fixture.oldEmail, fixture.newEmail,
		); err != nil {
			return err
		}
		return repointSubscriberEmail(ctx, tx, fixture.tenantID, fixture.oldEmail, fixture.newEmail)
	}

	t.Run("rotation first makes admission count moved history", func(t *testing.T) {
		fixture := seedFixture(t, "rotation-first")
		rotationTx, err := db.WithTenant(ctx, pool, fixture.tenantID)
		if err != nil {
			t.Fatalf("begin rotation-first transaction: %v", err)
		}
		defer func() { _ = rotationTx.Rollback(context.Background()) }()
		if err := rotateInTx(rotationTx, fixture); err != nil {
			t.Fatalf("perform uncommitted rotation: %v", err)
		}

		type admissionOutcome struct {
			result frequency.AdmissionResult
			err    error
		}
		pidReady := make(chan uint32, 1)
		admissionDone := make(chan admissionOutcome, 1)
		go func() {
			tx, beginErr := db.WithTenant(ctx, pool, fixture.tenantID)
			if beginErr != nil {
				admissionDone <- admissionOutcome{err: beginErr}
				return
			}
			defer func() { _ = tx.Rollback(context.Background()) }()
			pid := tx.Conn().PgConn().PID()
			pidReady <- pid
			result, admitErr := frequency.AdmitAndReserveTx(
				ctx, tx, fixture.tenantID, fixture.admissionCampaignID, "email", []string{fixture.newEmail},
			)
			if admitErr == nil {
				admitErr = tx.Commit(ctx)
			}
			admissionDone <- admissionOutcome{result: result, err: admitErr}
		}()
		waitForAdvisoryWaiter(t, <-pidReady)
		if err := rotationTx.Commit(ctx); err != nil {
			t.Fatalf("commit rotation-first transaction: %v", err)
		}
		outcome := <-admissionDone
		if outcome.err != nil || outcome.result.Skipped != 1 || len(outcome.result.ReservationIDs) != 0 {
			t.Fatalf("post-rotation admission=%+v err=%v, want capped/no reservation", outcome.result, outcome.err)
		}

		verify, err := db.WithTenant(ctx, pool, fixture.tenantID)
		if err != nil {
			t.Fatalf("begin rotation-first verification: %v", err)
		}
		defer func() { _ = verify.Rollback(context.Background()) }()
		var oldRows, canonicalRows int
		if err := verify.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE subscriber_email=$2::citext),
       count(*) FILTER (WHERE subscriber_email=$3::citext)
  FROM subscriber_send_log WHERE tenant_id=$1::uuid`,
			fixture.tenantID, fixture.oldEmail, fixture.newEmail).Scan(&oldRows, &canonicalRows); err != nil {
			t.Fatalf("verify rotation-first history: %v", err)
		}
		if oldRows != 0 || canonicalRows != 1 {
			t.Fatalf("rotation-first history old/canonical=%d/%d, want 0/1", oldRows, canonicalRows)
		}
	})

	t.Run("admission first holds rotation until stale authority rejects", func(t *testing.T) {
		fixture := seedFixture(t, "admission-first")
		admissionTx, err := db.WithTenant(ctx, pool, fixture.tenantID)
		if err != nil {
			t.Fatalf("begin admission-first transaction: %v", err)
		}
		defer func() { _ = admissionTx.Rollback(context.Background()) }()
		admission, err := frequency.AdmitAndReserveTx(
			ctx, admissionTx, fixture.tenantID, fixture.admissionCampaignID, "email", []string{fixture.newEmail},
		)
		if err != nil || admission.Skipped != 0 || len(admission.ReservationIDs) != 1 {
			t.Fatalf("pre-rotation admission=%+v err=%v, want one provisional reservation", admission, err)
		}

		pidReady := make(chan uint32, 1)
		rotationDone := make(chan error, 1)
		go func() {
			tx, beginErr := db.WithTenant(ctx, pool, fixture.tenantID)
			if beginErr != nil {
				rotationDone <- beginErr
				return
			}
			defer func() { _ = tx.Rollback(context.Background()) }()
			pidReady <- tx.Conn().PgConn().PID()
			rotateErr := rotateInTx(tx, fixture)
			if rotateErr == nil {
				rotateErr = tx.Commit(ctx)
			}
			rotationDone <- rotateErr
		}()
		waitForAdvisoryWaiter(t, <-pidReady)

		// This is the queue path's transaction-bound subscriber-authority check.
		// B is still only an alias while the rotation is blocked, so the attempt
		// must roll back its provisional reservation before allowing rotation.
		var authorityRows int
		if err := admissionTx.QueryRow(ctx, `
SELECT count(*) FROM subscribers
 WHERE tenant_id=$1::uuid AND email=$2::citext`, fixture.tenantID, fixture.newEmail).Scan(&authorityRows); err != nil {
			t.Fatalf("read pre-rotation subscriber authority: %v", err)
		}
		if authorityRows != 0 {
			t.Fatalf("pre-rotation canonical authority rows=%d, want 0", authorityRows)
		}
		if err := admissionTx.Rollback(ctx); err != nil && err != pgx.ErrTxClosed {
			t.Fatalf("roll back rejected provisional admission: %v", err)
		}
		if err := <-rotationDone; err != nil {
			t.Fatalf("rotation after admission rollback: %v", err)
		}

		verify, err := db.WithTenant(ctx, pool, fixture.tenantID)
		if err != nil {
			t.Fatalf("begin admission-first verification: %v", err)
		}
		defer func() { _ = verify.Rollback(context.Background()) }()
		var oldRows, canonicalRows int
		if err := verify.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE subscriber_email=$2::citext),
       count(*) FILTER (WHERE subscriber_email=$3::citext)
  FROM subscriber_send_log WHERE tenant_id=$1::uuid`,
			fixture.tenantID, fixture.oldEmail, fixture.newEmail).Scan(&oldRows, &canonicalRows); err != nil {
			t.Fatalf("verify admission-first history: %v", err)
		}
		if oldRows != 0 || canonicalRows != 1 {
			t.Fatalf("admission-first history old/canonical=%d/%d, want 0/1", oldRows, canonicalRows)
		}
	})
}

func TestClaimedRetryRotationInvalidatesStaleWorkerAndReleasesReservation_DB(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	tenantID := uuid.NewString()
	seedPrimaryEmailTenant(t, pool, tenantID)
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		tx, err := db.WithTenant(cleanupCtx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = tx.Rollback(cleanupCtx) }()
		_, _ = tx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id=$1::uuid`, tenantID)
		_ = tx.Commit(cleanupCtx)
	})

	repo := &Repo{Pool: pool}
	oldEmail := "claimed-race-old-" + uuid.NewString() + "@example.test"
	newEmail := "claimed-race-new-" + uuid.NewString() + "@example.test"
	subscriber, err := repo.Upsert(ctx, tenantID, CreateInput{Email: oldEmail})
	if err != nil {
		t.Fatalf("seed claimed-race subscriber: %v", err)
	}
	if _, err := repo.AddEmail(ctx, tenantID, subscriber.ID, AddEmailInput{Email: newEmail}, db.AuditMeta{
		TenantID: tenantID, ActorType: "system", ActorLabel: "claimed-rotation-race-test",
	}); err != nil {
		t.Fatalf("seed claimed-race target address: %v", err)
	}
	campaignID := uuid.NewString()
	var retryID string
	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin claimed-race seed: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO campaigns (id,tenant_id,name,subject,body_html,status,started_at)
VALUES ($1::uuid,$2::uuid,'claimed retry rotation race','race','','sending',now())`,
		campaignID, tenantID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed claimed-race campaign: %v", err)
	}
	if err := seedTx.QueryRow(ctx, `
INSERT INTO intelligent_retry_events
    (tenant_id,campaign_id,subscriber_email,reason,status,retry_after,updated_at)
VALUES ($1::uuid,$2::uuid,$3::citext,'frequency_cap','pending',now()-interval '1 hour',now()-interval '1 hour')
RETURNING id::text`, tenantID, campaignID, oldEmail).Scan(&retryID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed due retry: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit claimed-race seed: %v", err)
	}

	frequencyEntered := make(chan struct{})
	releaseFrequency := make(chan struct{})
	queue := &intelligent_retry.Queue{
		Pool: pool,
		Frequency: func(_ context.Context, gotTenant, channel string, candidates []string) ([]string, error) {
			if gotTenant != tenantID || channel != "email" || len(candidates) != 1 || candidates[0] != oldEmail {
				return nil, fmt.Errorf("unexpected stale worker frequency input tenant=%s channel=%s candidates=%v", gotTenant, channel, candidates)
			}
			close(frequencyEntered)
			select {
			case <-releaseFrequency:
				return candidates, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		},
		SubscriberPreference: func(_ context.Context, gotTenant string, candidates []string) ([]string, error) {
			if gotTenant != tenantID {
				return nil, fmt.Errorf("unexpected stale worker preference tenant %s", gotTenant)
			}
			return candidates, nil
		},
	}
	promoteDone := make(chan struct {
		count int
		err   error
	}, 1)
	go func() {
		count, promoteErr := queue.PromoteDue(ctx, 1)
		promoteDone <- struct {
			count int
			err   error
		}{count: count, err: promoteErr}
	}()
	select {
	case <-frequencyEntered:
	case <-ctx.Done():
		t.Fatalf("retry worker never reached pre-promotion authority: %v", ctx.Err())
	}

	// claimDue has committed its old-email Event before invoking Frequency.
	// Capture that exact revision, then rotate while the worker is paused.
	claimedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin claimed revision read: %v", err)
	}
	var claimedStatus string
	var claimedRevision time.Time
	if err := claimedTx.QueryRow(ctx, `
SELECT status,updated_at FROM intelligent_retry_events
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, retryID).Scan(&claimedStatus, &claimedRevision); err != nil {
		_ = claimedTx.Rollback(ctx)
		t.Fatalf("read claimed retry revision: %v", err)
	}
	_ = claimedTx.Rollback(ctx)
	if claimedStatus != "retrying" {
		t.Fatalf("retry status before rotation=%q, want retrying", claimedStatus)
	}
	if _, err := repo.Update(ctx, tenantID, subscriber.ID, UpdateInput{Email: &newEmail}); err != nil {
		t.Fatalf("rotate while old-email retry worker is paused: %v", err)
	}
	close(releaseFrequency)
	select {
	case result := <-promoteDone:
		if result.err != nil || result.count != 0 {
			t.Fatalf("stale worker promotion count=%d err=%v, want 0/nil", result.count, result.err)
		}
	case <-ctx.Done():
		t.Fatalf("stale retry worker did not finish: %v", ctx.Err())
	}

	verifyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin claimed-race verification: %v", err)
	}
	defer func() { _ = verifyTx.Rollback(context.Background()) }()
	var storedEmail, storedStatus string
	var storedRevision time.Time
	if err := verifyTx.QueryRow(ctx, `
SELECT subscriber_email::text,status,updated_at
  FROM intelligent_retry_events
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, retryID).Scan(
		&storedEmail, &storedStatus, &storedRevision,
	); err != nil {
		t.Fatalf("read repointed claimed retry: %v", err)
	}
	if storedEmail != newEmail || storedStatus != "pending" || !storedRevision.After(claimedRevision) {
		t.Fatalf("repointed claimed retry email=%q status=%q revision=%s; want %q/pending/after %s",
			storedEmail, storedStatus, storedRevision, newEmail, claimedRevision)
	}
	var oldReservations, anyReservations, oldRecipients int
	if err := verifyTx.QueryRow(ctx, `
SELECT
  count(*) FILTER (WHERE subscriber_email=$3::citext),
  count(*),
  (SELECT count(*) FROM campaign_recipients
    WHERE tenant_id=$1::uuid AND campaign_id=$2::uuid AND subscriber_email=$3::citext)
FROM subscriber_send_log
WHERE tenant_id=$1::uuid AND campaign_id=$2::uuid`, tenantID, campaignID, oldEmail).Scan(
		&oldReservations, &anyReservations, &oldRecipients,
	); err != nil {
		t.Fatalf("verify stale worker provisional cleanup: %v", err)
	}
	if oldReservations != 0 || anyReservations != 0 || oldRecipients != 0 {
		t.Fatalf("stale worker left reservations/recipients old=%d total=%d recipients=%d, want 0/0/0",
			oldReservations, anyReservations, oldRecipients)
	}

	// The reset row is not stranded: it remains ordinary pending work and can
	// be claimed under the canonical address on the next worker pass.
	if _, err := verifyTx.Exec(ctx, `
UPDATE intelligent_retry_events
   SET retry_after=now()-interval '1 second'
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, retryID); err != nil {
		t.Fatalf("make reset retry due: %v", err)
	}
	if err := verifyTx.Commit(ctx); err != nil {
		t.Fatalf("commit reset retry due: %v", err)
	}
	canonicalSeen := make(chan struct{}, 1)
	queue.Frequency = func(_ context.Context, gotTenant, channel string, candidates []string) ([]string, error) {
		if gotTenant == tenantID && channel == "email" && len(candidates) == 1 && candidates[0] == newEmail {
			canonicalSeen <- struct{}{}
			return []string{}, nil // defer after proving the canonical claim
		}
		return nil, fmt.Errorf("unexpected canonical retry input tenant=%s channel=%s candidates=%v", gotTenant, channel, candidates)
	}
	if promoted, err := queue.PromoteDue(ctx, 1); err != nil || promoted != 0 {
		t.Fatalf("reclaim reset canonical retry promoted=%d err=%v, want 0/nil", promoted, err)
	}
	select {
	case <-canonicalSeen:
	default:
		t.Fatal("reset retry was not reclaimable under its canonical email")
	}
}
