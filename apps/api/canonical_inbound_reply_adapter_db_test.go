// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/campaignreportprojection"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
	"github.com/postwave/postwave/apps/api/internal/inbound_email"
	"github.com/postwave/postwave/apps/api/internal/replies"
)

func canonicalInboundDB(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping canonical inbound reply proof")
	}
	pool, err := pgxpool.New(t.Context(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	var ready bool
	if err := pool.QueryRow(t.Context(), `
SELECT to_regclass('public.inbound_email_campaign_reply_links') IS NOT NULL
   AND to_regclass('public.campaign_reply_intent_classifications') IS NOT NULL`).Scan(&ready); err != nil {
		t.Fatal(err)
	}
	if !ready {
		t.Fatal("DATABASE_URL is configured but migration 1966 is not applied")
	}
	return (*db.Pool)(pool)
}

func seedCanonicalInboundFixture(t *testing.T, pool *db.Pool) (tenantID, campaignID, subscriberID, email string) {
	t.Helper()
	tenantID, campaignID = uuid.NewString(), uuid.NewString()
	email = "canonical-inbound-" + uuid.NewString()[:8] + "@example.test"
	tx, err := db.WithTenant(t.Context(), pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	if _, err := tx.Exec(t.Context(), `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'canonical inbound reply', $2, 'studio')`,
		tenantID, "canonical-inbound-"+tenantID[:8]); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(t.Context(), `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api')
RETURNING id::text`, tenantID, email).Scan(&subscriberID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(t.Context(), `
INSERT INTO campaigns (id, tenant_id, name, subject, status, is_sandbox)
VALUES ($1::uuid, $2::uuid, 'canonical-inbound', 'Reply', 'sent', false)`,
		campaignID, tenantID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, err := db.WithTenant(context.Background(), pool, tenantID)
		if err != nil {
			return
		}
		_, _ = cleanup.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1::uuid`, tenantID)
		_ = cleanup.Commit(context.Background())
	})
	return tenantID, campaignID, subscriberID, email
}

func canonicalInboundClassifier(t *testing.T, pool *db.Pool) *engagementclassification.Runtime {
	t.Helper()
	runtime, err := engagementclassification.BuildRuntime(
		t.Context(), engagementclassification.RuntimeConfiguration{
			Enabled:                  true,
			IdentityHMACKey:          []byte(strings.Repeat("canonical-inbound-key-", 2)),
			IdentityKeyID:            "canonical-inbound-db-v1",
			ObservationRetention:     365 * 24 * time.Hour,
			ReclassificationLeaseTTL: time.Minute,
			RetentionSweepInterval:   time.Minute,
		}, pool,
	)
	if err != nil {
		t.Fatalf("BuildRuntime: %v", err)
	}
	return runtime
}

func canonicalInboundReplay(event string, body []byte) (string, string) {
	eventDigest := sha256.Sum256([]byte(event))
	bodyDigest := sha256.Sum256(body)
	return "event:v1:" + hex.EncodeToString(eventDigest[:]), hex.EncodeToString(bodyDigest[:])
}

func canonicalInboundExpectPGCode(
	t *testing.T,
	tx pgx.Tx,
	name string,
	wantCode string,
	query string,
	args ...any,
) {
	t.Helper()
	savepoint := "canonical_inbound_adversarial"
	if _, err := tx.Exec(t.Context(), "SAVEPOINT "+savepoint); err != nil {
		t.Fatalf("%s savepoint: %v", name, err)
	}
	_, err := tx.Exec(t.Context(), query, args...)
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.Code != wantCode {
		_ = func() error {
			_, rollbackErr := tx.Exec(t.Context(), "ROLLBACK TO SAVEPOINT "+savepoint)
			return rollbackErr
		}()
		t.Fatalf("%s error=%v, want PostgreSQL code %s", name, err, wantCode)
	}
	if _, err := tx.Exec(t.Context(), "ROLLBACK TO SAVEPOINT "+savepoint); err != nil {
		t.Fatalf("%s rollback savepoint: %v", name, err)
	}
	if _, err := tx.Exec(t.Context(), "RELEASE SAVEPOINT "+savepoint); err != nil {
		t.Fatalf("%s release savepoint: %v", name, err)
	}
}

func TestSignedInboundCampaignReplyConvergesAtomicallyAndReplays_DB(t *testing.T) {
	pool := canonicalInboundDB(t)
	tenantID, campaignID, subscriberID, email := seedCanonicalInboundFixture(t, pool)
	projection, err := campaignreportprojection.BuildRuntime(
		t.Context(), campaignreportprojection.RuntimeConfiguration{Enabled: true}, pool,
	)
	if err != nil {
		t.Fatalf("Build projection runtime: %v", err)
	}
	store := &replies.Store{
		Pool:                    pool,
		EngagementClassifier:    canonicalInboundClassifier(t, pool),
		CampaignReportProjector: projection,
	}
	repo := &inbound_email.Repo{
		Pool:                 pool,
		CanonicalReplyWriter: canonicalInboundReplyWriter{Store: store},
	}
	key, bodyHash := canonicalInboundReplay("generic-provider-event", []byte("exact signed body"))
	emailRow := inbound_email.Email{
		SubscriberID: subscriberID,
		CampaignID:   campaignID,
		From:         email,
		To:           "reply-endpoint@example.test",
		Subject:      "Re: launch",
		MessageID:    "<generic-inbound-" + uuid.NewString() + "@example.test>",
		InReplyTo:    "<outbound-" + campaignID + "@example.test>",
		BodyText:     "Yes, please send the details.",
		ReplyHeaders: map[string]string{"Auto-Submitted": "no"},
	}

	id, duplicate, err := repo.InsertIdempotent(t.Context(), tenantID, emailRow, key, bodyHash)
	if err != nil || duplicate || id == 0 {
		t.Fatalf("first ingest id=%d duplicate=%v err=%v", id, duplicate, err)
	}
	replayID, duplicate, err := repo.InsertIdempotent(t.Context(), tenantID, emailRow, key, bodyHash)
	if err != nil || !duplicate || replayID != id {
		t.Fatalf("exact replay id=%d duplicate=%v err=%v; want id=%d", replayID, duplicate, err, id)
	}

	tx, err := db.WithTenantWorker(t.Context(), pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	if _, err := tx.Exec(t.Context(), `
SELECT set_config('app.engagement_classifier_worker','true',true),
       set_config('app.controlled_seed_evidence_reader','true',true),
       set_config('app.campaign_report_projection_worker','true',true)`); err != nil {
		t.Fatal(err)
	}
	var inbound, canonical, links, events, observations, classifications, reportRows, projectionRows int
	var replyClass, source, bodyHashEvidence, receipt string
	if err := tx.QueryRow(t.Context(), `
SELECT
  (SELECT count(*) FROM inbound_emails WHERE campaign_id=$1::uuid),
  (SELECT count(*) FROM campaign_replies WHERE campaign_id=$1::uuid),
  (SELECT count(*) FROM inbound_email_campaign_reply_links link
     JOIN inbound_emails inbound ON inbound.id=link.inbound_email_id
    WHERE inbound.campaign_id=$1::uuid),
  (SELECT count(*) FROM subscriber_events WHERE campaign_id=$1::uuid AND event_type='replied'),
  (SELECT count(*) FROM subscriber_event_observations observation
     JOIN subscriber_events event
       ON event.id=observation.subscriber_event_id AND event.at=observation.subscriber_event_at
    WHERE event.campaign_id=$1::uuid AND event.event_type='replied'),
  (SELECT count(*) FROM event_classifications classification
     JOIN subscriber_events event
       ON event.id=classification.subscriber_event_id AND event.at=classification.subscriber_event_at
    WHERE event.campaign_id=$1::uuid AND event.event_type='replied'),
  (SELECT count(*) FROM campaign_report_events WHERE campaign_id=$1::uuid AND event_type='replied'),
  (SELECT count(*) FROM campaign_report_event_projections projection
     JOIN subscriber_events event
       ON event.tenant_id=projection.tenant_id
      AND event.id=projection.subscriber_event_id
      AND event.at=projection.subscriber_event_at
    WHERE event.campaign_id=$1::uuid AND event.event_type='replied'),
  (SELECT classification FROM campaign_replies WHERE campaign_id=$1::uuid),
  (SELECT source FROM campaign_replies WHERE campaign_id=$1::uuid),
  (SELECT body_evidence_sha256 FROM campaign_replies WHERE campaign_id=$1::uuid),
  (SELECT evidence_receipt_sha256 FROM campaign_replies WHERE campaign_id=$1::uuid)`, campaignID).
		Scan(&inbound, &canonical, &links, &events, &observations, &classifications,
			&reportRows, &projectionRows, &replyClass, &source, &bodyHashEvidence, &receipt); err != nil {
		t.Fatal(err)
	}
	if inbound != 1 || canonical != 1 || links != 1 || events != 1 || observations != 1 ||
		classifications != 1 || reportRows != 1 || projectionRows != 1 {
		t.Fatalf("converged counts inbound/canonical/link/event/observation/classification/report/projection = %d/%d/%d/%d/%d/%d/%d/%d",
			inbound, canonical, links, events, observations, classifications, reportRows, projectionRows)
	}
	if replyClass != "human_reply" || source != "postwave-inbound" ||
		len(bodyHashEvidence) != 64 || len(receipt) != 64 {
		t.Fatalf("canonical evidence class=%q source=%q body_hash=%q receipt=%q",
			replyClass, source, bodyHashEvidence, receipt)
	}

	var canonicalReplyID string
	if err := tx.QueryRow(t.Context(), `
SELECT campaign_reply_id::text
  FROM inbound_email_campaign_reply_links
 WHERE tenant_id=$1::uuid AND inbound_email_id=$2`, tenantID, id).
		Scan(&canonicalReplyID); err != nil {
		t.Fatal(err)
	}
	canonicalInboundExpectPGCode(t, tx, "forged link receipt", "23514", `
INSERT INTO inbound_email_campaign_reply_links (
    tenant_id, inbound_email_id, campaign_reply_id, link_method,
    link_receipt_sha256
)
VALUES ($1::uuid, $2, $3::uuid, 'transactional_projection', repeat('0', 64))
ON CONFLICT DO NOTHING`, tenantID, id, canonicalReplyID)
	canonicalInboundExpectPGCode(t, tx, "link update", "42501", `
UPDATE inbound_email_campaign_reply_links
   SET link_method='legacy_materialized'
 WHERE tenant_id=$1::uuid AND inbound_email_id=$2`, tenantID, id)
	canonicalInboundExpectPGCode(t, tx, "link delete", "42501", `
DELETE FROM inbound_email_campaign_reply_links
 WHERE tenant_id=$1::uuid AND inbound_email_id=$2`, tenantID, id)

	var intentID int64
	if err := tx.QueryRow(t.Context(), `
INSERT INTO campaign_reply_intent_classifications (
    tenant_id, campaign_reply_id, intent_class, intent_confidence,
    classifier, classifier_version
)
VALUES ($1::uuid, $2::uuid, 'question', 0.9000,
        'heuristic', 'postwave.reply-intent-heuristic.v1')
RETURNING id`, tenantID, canonicalReplyID).Scan(&intentID); err != nil {
		t.Fatalf("insert valid intent evidence: %v", err)
	}
	canonicalInboundExpectPGCode(t, tx, "forged intent receipt", "23514", `
INSERT INTO campaign_reply_intent_classifications (
    tenant_id, campaign_reply_id, intent_class, intent_confidence,
    classifier, classifier_version, evidence_receipt_sha256
)
VALUES ($1::uuid, $2::uuid, 'praise', 0.8000,
        'heuristic', 'postwave.reply-intent-heuristic.v1', repeat('0', 64))`,
		tenantID, canonicalReplyID)
	canonicalInboundExpectPGCode(t, tx, "intent update", "42501", `
UPDATE campaign_reply_intent_classifications
   SET intent_class='other'
 WHERE tenant_id=$1::uuid AND id=$2`, tenantID, intentID)
	canonicalInboundExpectPGCode(t, tx, "intent delete", "42501", `
DELETE FROM campaign_reply_intent_classifications
 WHERE tenant_id=$1::uuid AND id=$2`, tenantID, intentID)
}

type failingCanonicalInboundWriter struct{ err error }

func (f failingCanonicalInboundWriter) RequiresWorkerScope() bool { return false }
func (f failingCanonicalInboundWriter) PersistInboundEmail(
	context.Context, pgx.Tx, string, inbound_email.Email, int64, string, time.Time,
) (string, bool, error) {
	return "", false, f.err
}

func TestCanonicalInboundFailureRollsBackSourceLedger_DB(t *testing.T) {
	pool := canonicalInboundDB(t)
	tenantID, campaignID, subscriberID, email := seedCanonicalInboundFixture(t, pool)
	sentinel := errors.New("injected canonical reply failure")
	repo := &inbound_email.Repo{
		Pool:                 pool,
		CanonicalReplyWriter: failingCanonicalInboundWriter{err: sentinel},
	}
	key, bodyHash := canonicalInboundReplay("rollback-event", []byte("rollback-body"))
	_, _, err := repo.InsertIdempotent(t.Context(), tenantID, inbound_email.Email{
		SubscriberID: subscriberID, CampaignID: campaignID,
		From: email, To: "reply@example.test", Subject: "Re: rollback",
		MessageID: "<rollback@example.test>", InReplyTo: "<outbound@example.test>",
		BodyText: "must roll back",
	}, key, bodyHash)
	if !errors.Is(err, sentinel) {
		t.Fatalf("ingest error=%v, want sentinel", err)
	}
	tx, err := db.WithTenant(t.Context(), pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	var count int
	if err := tx.QueryRow(t.Context(), `
SELECT count(*) FROM inbound_emails WHERE campaign_id=$1::uuid`, campaignID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("source ledger rows=%d after canonical failure, want 0", count)
	}
}
