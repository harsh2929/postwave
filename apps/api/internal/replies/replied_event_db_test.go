// SPDX-License-Identifier: AGPL-3.0-only

package replies

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
)

func repliesDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping replied-event test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return (*db.Pool)(pool)
}

type replyDBFixture struct {
	TenantID, CampaignID, SubscriberID, Email string
}

func seedReplyFixture(t *testing.T, pool *db.Pool, sandbox bool) replyDBFixture {
	t.Helper()
	ctx := context.Background()
	fixture := replyDBFixture{
		TenantID: uuid.NewString(), CampaignID: uuid.NewString(),
		Email: "replier-" + uuid.NewString()[:8] + "@example.test",
	}
	tx, err := db.WithTenant(ctx, pool, fixture.TenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'replied-event-test', $2, 'studio')`,
		fixture.TenantID, "replev-"+fixture.TenantID[:8]); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api') RETURNING id::text`,
		fixture.TenantID, fixture.Email).Scan(&fixture.SubscriberID); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, status, is_sandbox)
VALUES ($1::uuid, $2::uuid, 'reply-test', 'Reply test', 'sent', $3)`,
		fixture.CampaignID, fixture.TenantID, sandbox); err != nil {
		t.Fatalf("seed campaign: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}
	t.Cleanup(func() {
		cleanup, err := db.WithTenant(context.Background(), pool, fixture.TenantID)
		if err != nil {
			return
		}
		_, _ = cleanup.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1::uuid`, fixture.TenantID)
		_ = cleanup.Commit(context.Background())
	})
	return fixture
}

func replyClassifierRuntime(t *testing.T, pool *db.Pool) *engagementclassification.Runtime {
	t.Helper()
	runtime, err := engagementclassification.BuildRuntime(
		context.Background(), engagementclassification.RuntimeConfiguration{
			Enabled:                  true,
			IdentityHMACKey:          []byte(strings.Repeat("reply-db-key-", 4)),
			IdentityKeyID:            "reply-db-test-v1",
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

func stronglyMatchedHumanReply(fixture replyDBFixture, receivedAt time.Time) Reply {
	return Reply{
		TenantID: fixture.TenantID, CampaignID: fixture.CampaignID,
		SubscriberID: fixture.SubscriberID, RecipientEmail: fixture.Email,
		EnvelopeRecipient:  "replies-acme@reply.example.test",
		InReplyTo:          "<outbound-" + fixture.CampaignID + "@example.test>",
		Subject:            "Re: Spring sale",
		BodySnippet:        "Yes please, Tuesday works.",
		ClassificationBody: "Yes please, Tuesday works.\n\n-- \nPrivate signature",
		RawMessageID:       "<inbound-" + uuid.NewString() + "@example.test>",
		Source:             SourcePostmark,
		ReceivedAt:         receivedAt,
		MatchMethod:        MatchInReplyTo,
		ClassificationHeaders: Headers{
			"Auto-Submitted": "no",
		},
	}
}

type replyEvidenceCounts struct {
	Replies, Events, Observations, Classifications int
	EventAt                                        time.Time
	Verdict, Rules, Headers, Signals               string
}

func loadReplyEvidence(t *testing.T, pool *db.Pool, fixture replyDBFixture) replyEvidenceCounts {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenantWorker(ctx, pool, fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
SELECT set_config('app.engagement_classifier_worker','true',true),
       set_config('app.controlled_seed_evidence_reader','true',true)`); err != nil {
		t.Fatal(err)
	}
	var got replyEvidenceCounts
	if err := tx.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM campaign_replies WHERE campaign_id=$1::uuid),
  (SELECT count(*) FROM subscriber_events WHERE campaign_id=$1::uuid AND event_type='replied'),
  (SELECT count(*) FROM subscriber_event_observations AS observation
     JOIN subscriber_events AS event
       ON event.id=observation.subscriber_event_id AND event.at=observation.subscriber_event_at
    WHERE event.campaign_id=$1::uuid AND event.event_type='replied'),
  (SELECT count(*) FROM event_classifications AS classification
     JOIN subscriber_events AS event
       ON event.id=classification.subscriber_event_id AND event.at=classification.subscriber_event_at
    WHERE event.campaign_id=$1::uuid AND event.event_type='replied')`, fixture.CampaignID).
		Scan(&got.Replies, &got.Events, &got.Observations, &got.Classifications); err != nil {
		t.Fatal(err)
	}
	if got.Events > 0 {
		if err := tx.QueryRow(ctx, `
SELECT event.at, classification.classification, classification.rules_fired::text,
       observation.ordered_headers::text, observation.provider_signals::text
  FROM subscriber_events AS event
  JOIN subscriber_event_observations AS observation
    ON observation.subscriber_event_id=event.id AND observation.subscriber_event_at=event.at
  JOIN event_classifications AS classification
    ON classification.subscriber_event_id=event.id AND classification.subscriber_event_at=event.at
 WHERE event.campaign_id=$1::uuid AND event.event_type='replied'
 ORDER BY event.at, event.id LIMIT 1`, fixture.CampaignID).
			Scan(&got.EventAt, &got.Verdict, &got.Rules, &got.Headers, &got.Signals); err != nil {
			t.Fatal(err)
		}
	}
	return got
}

func TestStrongHumanReplyIsAtomicClassifiedAndReplaySafe_DB(t *testing.T) {
	pool := repliesDB(t)
	receivedAt := time.Now().UTC().Add(-2 * time.Minute).Truncate(time.Microsecond)
	fixture := seedReplyFixture(t, pool, false)
	store := &Store{
		Pool: pool, EngagementClassifier: replyClassifierRuntime(t, pool),
		Now: func() time.Time { return receivedAt.Add(time.Minute) },
	}
	reply := stronglyMatchedHumanReply(fixture, receivedAt)

	id, duplicate, err := store.Persist(context.Background(), fixture.TenantID, reply)
	if err != nil || duplicate || id == "" {
		t.Fatalf("first Persist id=%q duplicate=%v err=%v", id, duplicate, err)
	}
	got := loadReplyEvidence(t, pool, fixture)
	if got.Replies != 1 || got.Events != 1 || got.Observations != 1 || got.Classifications != 1 {
		t.Fatalf("atomic counts = %+v, want one of each", got)
	}
	if !got.EventAt.Equal(receivedAt) {
		t.Fatalf("canonical at=%v, want authenticated received_at=%v", got.EventAt, receivedAt)
	}
	if got.Verdict != "human" || !strings.Contains(got.Rules, "R_TRUSTED_HUMAN_REPLY") {
		t.Fatalf("classification verdict=%q rules=%s", got.Verdict, got.Rules)
	}
	if strings.Contains(got.Headers, "auto-replied") || strings.Contains(got.Signals, fixture.Email) ||
		strings.Contains(got.Signals, "Tuesday works") {
		t.Fatalf("raw header/body/recipient leaked: headers=%s signals=%s", got.Headers, got.Signals)
	}
	if !strings.Contains(got.Headers, `"Auto-Submitted"`) ||
		!strings.Contains(got.Signals, `"reply_classifier_version"`) {
		t.Fatalf("safe provenance missing: headers=%s signals=%s", got.Headers, got.Signals)
	}

	replayedID, duplicate, err := store.Persist(context.Background(), fixture.TenantID, reply)
	if err != nil || !duplicate || replayedID != id {
		t.Fatalf("replay id=%q duplicate=%v err=%v; want id=%q", replayedID, duplicate, err, id)
	}
	if replayed := loadReplyEvidence(t, pool, fixture); replayed.Replies != 1 || replayed.Events != 1 ||
		replayed.Observations != 1 || replayed.Classifications != 1 {
		t.Fatalf("replay inflated ledgers: %+v", replayed)
	}

	mutated := reply
	mutated.Subject = "same provider id, different message"
	if _, _, err := store.Persist(context.Background(), fixture.TenantID, mutated); !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("mutated replay err=%v, want ErrIdempotencyConflict", err)
	}
}

func TestReplyProjectionFailsClosedForAutomationWeakLinksSandboxAndDisabledRuntime_DB(t *testing.T) {
	pool := repliesDB(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	for _, tc := range []struct {
		name       string
		sandbox    bool
		classifier bool
		mutate     func(*Reply)
		wantClass  ReplyClass
	}{
		{
			name: "out of office", classifier: true, wantClass: ClassOutOfOffice,
			mutate: func(reply *Reply) {
				reply.ClassificationHeaders = Headers{"Auto-Submitted": "auto-replied"}
				reply.Subject = "Automatic reply: Spring sale"
				reply.ClassificationBody = "I am out of the office."
			},
		},
		{
			name: "sender fallback", classifier: true, wantClass: ClassHumanReply,
			mutate: func(reply *Reply) { reply.MatchMethod = MatchFromSubscriber },
		},
		{name: "sandbox campaign", sandbox: true, classifier: true, wantClass: ClassHumanReply},
		{name: "F01 runtime disabled", classifier: false, wantClass: ClassHumanReply},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := seedReplyFixture(t, pool, tc.sandbox)
			store := &Store{Pool: pool, Now: func() time.Time { return now }}
			if tc.classifier {
				store.EngagementClassifier = replyClassifierRuntime(t, pool)
			}
			reply := stronglyMatchedHumanReply(fixture, now)
			if tc.mutate != nil {
				tc.mutate(&reply)
			}
			if _, _, err := store.Persist(context.Background(), fixture.TenantID, reply); err != nil {
				t.Fatal(err)
			}
			got := loadReplyEvidence(t, pool, fixture)
			if got.Replies != 1 || got.Events != 0 || got.Observations != 0 || got.Classifications != 0 {
				t.Fatalf("fail-closed counts = %+v", got)
			}
			tx, err := db.WithTenant(context.Background(), pool, fixture.TenantID)
			if err != nil {
				t.Fatal(err)
			}
			var class string
			err = tx.QueryRow(context.Background(), `
SELECT classification FROM campaign_replies WHERE campaign_id=$1::uuid`, fixture.CampaignID).Scan(&class)
			_ = tx.Rollback(context.Background())
			if err != nil || class != string(tc.wantClass) {
				t.Fatalf("reply class=%q err=%v, want %q", class, err, tc.wantClass)
			}
		})
	}
}

func TestConcurrentReplyReplayCreatesOneAtomicEvidenceSet_DB(t *testing.T) {
	pool := repliesDB(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	fixture := seedReplyFixture(t, pool, false)
	store := &Store{Pool: pool, EngagementClassifier: replyClassifierRuntime(t, pool)}
	reply := stronglyMatchedHumanReply(fixture, now)

	const workers = 8
	var wait sync.WaitGroup
	errorsOut := make(chan error, workers)
	for i := 0; i < workers; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, _, err := store.Persist(context.Background(), fixture.TenantID, reply)
			errorsOut <- err
		}()
	}
	wait.Wait()
	close(errorsOut)
	for err := range errorsOut {
		if err != nil {
			t.Fatalf("concurrent replay: %v", err)
		}
	}
	got := loadReplyEvidence(t, pool, fixture)
	if got.Replies != 1 || got.Events != 1 || got.Observations != 1 || got.Classifications != 1 {
		t.Fatalf("concurrent counts = %+v, want one atomic evidence set", got)
	}

	count, err := store.CountForCampaign(context.Background(), fixture.TenantID, fixture.CampaignID)
	if err != nil || count != 1 {
		t.Fatalf("human-only CountForCampaign=%d err=%v", count, err)
	}
}

func TestSendDeliveryMessageIDReturnsCampaignAndSubscriber_DB(t *testing.T) {
	pool := repliesDB(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Temporary tables isolate the lookup contract from the assurance ledger's
	// intentionally large write contract. The matcher only owns these joins and
	// fields; delivery creation itself is covered by campaigndelivery tests.
	if _, err := tx.Exec(ctx, `SET LOCAL search_path = pg_temp, public`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `CREATE TEMP TABLE campaign_send_deliveries (
  tenant_id uuid, campaign_id uuid, campaign_recipient_id bigint,
  message_id text, created_at timestamptz
)`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `CREATE TEMP TABLE campaign_recipients (
  tenant_id uuid, campaign_id uuid, id bigint, subscriber_email text
)`); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `CREATE TEMP TABLE subscribers (
  tenant_id uuid, id uuid, email text
)`); err != nil {
		t.Fatal(err)
	}
	tenantID := uuid.NewString()
	otherTenantID := uuid.NewString()
	campaignID := uuid.NewString()
	subscriberID := uuid.NewString()
	otherCampaignID := uuid.NewString()
	otherSubscriberID := uuid.NewString()
	messageID := "delivery-" + uuid.NewString() + "@example.test"
	if _, err := tx.Exec(ctx, `INSERT INTO campaign_recipients VALUES
  ($1::uuid, $2::uuid, 41, 'right@example.test'),
  ($3::uuid, $4::uuid, 42, 'wrong@example.test')`,
		tenantID, campaignID, otherTenantID, otherCampaignID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO subscribers VALUES
  ($1::uuid, $2::uuid, 'right@example.test'),
  ($3::uuid, $4::uuid, 'wrong@example.test')`,
		tenantID, subscriberID, otherTenantID, otherSubscriberID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO campaign_send_deliveries VALUES
  ($1::uuid, $2::uuid, 41, '<' || $5 || '>', clock_timestamp()),
  ($3::uuid, $4::uuid, 42, '<' || $5 || '>', clock_timestamp() + interval '1 second')`,
		tenantID, campaignID, otherTenantID, otherCampaignID, messageID); err != nil {
		t.Fatal(err)
	}

	matcher := &Matcher{}
	gotCampaign, gotSubscriber, ok := matcher.matchBySendDeliveryMessageID(
		ctx, tx, tenantID, messageID,
	)
	if !ok || gotCampaign != campaignID || gotSubscriber != subscriberID {
		t.Fatalf("match = (%q, %q, %v), want campaign=%q subscriber=%q",
			gotCampaign, gotSubscriber, ok, campaignID, subscriberID)
	}
}
