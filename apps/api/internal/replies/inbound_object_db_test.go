// SPDX-License-Identifier: AGPL-3.0-only
//
// The three claims the SES-object path has to earn, against the real database
// and the real classifier: a malformed object writes nothing, an auto-reply
// never becomes a `replied` event, and the same object twice is one row and one
// event.
//
// These are DB tests rather than fakes because every one of the claims is about
// what Store.Persist did — and Persist is the only thing in the package allowed
// to classify. A test that stubbed Persist would be testing the stub.
//
// What IS stubbed is the F01 runtime, and only its RecordProviderEvent call.
// Everything the claims are about stays real: the classifier decision, the
// campaign_replies insert with its partial unique index, the subscriber_events
// `replied` row, and the subscriber-event dedup ledger that guards it. The stub
// exists so this file does not depend on the evidence tables' current column
// set, which lives in another package.

package replies

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
)

const inboundTestEnvelopeDomain = "reply.example.test"

// recordingEngagementClassifier stands in for the F01 runtime. It is non-nil,
// which is what Store.Persist checks before emitting the canonical event, and it
// records what it was handed so a test can assert the classification receipt
// travelled with the event rather than being invented at the far end.
type recordingEngagementClassifier struct {
	calls     int
	eventType string
	signals   map[string]any
}

func (c *recordingEngagementClassifier) RecordProviderEvent(
	_ context.Context, _ pgx.Tx, _ string,
	input engagementclassification.ProviderEventInput,
) error {
	c.calls++
	c.eventType = input.EventType
	c.signals = input.ProviderSignals
	return nil
}

// inboundObjectFor builds one stored RFC 5322 object for the seeded fixture.
// extraHeaders is where a test says what KIND of message this is; everything
// else is held constant so the assertion is about that difference alone.
func inboundObjectFor(fixture replyDBFixture, subject, body string, extraHeaders ...string) []byte {
	lines := []string{
		"From: " + fixture.Email,
		"To: replies-acme@" + inboundTestEnvelopeDomain,
		"Subject: " + subject,
		"Date: Thu, 13 Aug 2026 09:14:00 +0000",
		"In-Reply-To: <outbound-" + fixture.CampaignID + "@example.test>",
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
	}
	lines = append(lines, extraHeaders...)
	lines = append(lines, "", body, "")
	return mimeMessage(lines...)
}

func newInboundDBWorker(
	pool *db.Pool, fixture replyDBFixture, objects *inboundFakeObjects,
	classifier *recordingEngagementClassifier,
) *InboundObjectWorker {
	return &InboundObjectWorker{
		Objects: objects,
		Store:   &Store{Pool: pool, EngagementClassifier: classifier},
		// A strong, campaign-bearing correlation, so the ONLY thing that can
		// suppress the canonical event in these tests is the classification.
		Matcher: &inboundStubMatcher{result: MatchResult{
			CampaignID:   fixture.CampaignID,
			SubscriberID: fixture.SubscriberID,
			Method:       MatchInReplyTo,
		}},
		TenantResolver: inboundStubResolver{
			bySlug: map[string]string{"acme": fixture.TenantID},
		},
		EnvelopeDomainSuffix: inboundTestEnvelopeDomain,
	}
}

func inboundDeliveryFor(key string) InboundDelivery {
	return InboundDelivery{
		Object:       ObjectRef{Bucket: "postwave-test-inbound-mail", Key: "inbound/" + key},
		SESMessageID: key,
		Recipients:   []string{"replies-acme@" + inboundTestEnvelopeDomain},
		SpamVerdict:  "PASS",
		VirusVerdict: "PASS",
		ReceivedAt:   time.Date(2026, 8, 13, 9, 15, 1, 0, time.UTC),
	}
}

type inboundCounts struct {
	Replies        int
	RepliedEvents  int
	Classification string
}

func loadInboundCounts(t *testing.T, pool *db.Pool, fixture replyDBFixture) inboundCounts {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenantWorker(ctx, pool, fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var got inboundCounts
	if err := tx.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM campaign_replies WHERE campaign_id=$1::uuid),
  (SELECT count(*) FROM subscriber_events
     WHERE campaign_id=$1::uuid AND event_type='replied'),
  (SELECT COALESCE(string_agg(classification, ','), '')
     FROM campaign_replies WHERE campaign_id=$1::uuid)`, fixture.CampaignID).
		Scan(&got.Replies, &got.RepliedEvents, &got.Classification); err != nil {
		t.Fatal(err)
	}
	return got
}

// An auto-reply arriving over the S3 path must not emit `replied`.
//
// The auto-reply here is detectable ONLY from a header: the subject says
// "Re: Spring sale" and the body says a ticket was opened, so nothing in the
// text gives it away. That is the point. A worker that fetched the object but
// failed to carry the allow-listed headers into the Reply would classify this
// as human, push the lead score up by 10, and teach send-time optimisation that
// this recipient is most engaged whenever their helpdesk robot answers.
func TestInboundObjectAutoReplyIsStoredWithoutCanonicalReplyEvent_DB(t *testing.T) {
	pool := repliesDB(t)

	t.Run("header-only auto-reply", func(t *testing.T) {
		fixture := seedReplyFixture(t, pool, false)
		key := uuid.NewString()
		objects := &inboundFakeObjects{objects: map[string][]byte{
			"postwave-test-inbound-mail/inbound/" + key: inboundObjectFor(fixture,
				"Re: Spring sale",
				"Ticket 4471 has been opened for your message.",
				"Precedence: bulk"),
		}}
		classifier := &recordingEngagementClassifier{}
		worker := newInboundDBWorker(pool, fixture, objects, classifier)

		outcome, err := worker.ProcessObject(context.Background(), inboundDeliveryFor(key))
		if err != nil {
			t.Fatalf("ProcessObject: %v", err)
		}
		if outcome.Dropped != "" || outcome.ReplyID == "" || outcome.Duplicate {
			t.Fatalf("outcome = %+v, want a freshly stored row", outcome)
		}
		got := loadInboundCounts(t, pool, fixture)
		if got.Replies != 1 {
			t.Fatalf("replies = %d, want the auto-reply stored for triage", got.Replies)
		}
		// The headline claim first, so a regression reports the consequence
		// rather than only the mechanism.
		if got.RepliedEvents != 0 {
			t.Fatalf("auto-reply emitted %d replied events (classified %q), want 0",
				got.RepliedEvents, got.Classification)
		}
		if got.Classification != string(ClassAutoReply) {
			t.Fatalf("classification = %q, want %q", got.Classification, ClassAutoReply)
		}
		if classifier.calls != 0 {
			t.Fatalf("auto-reply reached the engagement classifier %d times", classifier.calls)
		}
	})

	// Guards the guard. Same object, same worker, same correlation — only the
	// header differs. Without this, "RepliedEvents == 0" above would also pass
	// on a harness that could never emit an event at all.
	t.Run("human reply through the same path", func(t *testing.T) {
		fixture := seedReplyFixture(t, pool, false)
		key := uuid.NewString()
		objects := &inboundFakeObjects{objects: map[string][]byte{
			"postwave-test-inbound-mail/inbound/" + key: inboundObjectFor(fixture,
				"Re: Spring sale",
				"Ticket 4471 has been opened for your message.",
				"Auto-Submitted: no"),
		}}
		classifier := &recordingEngagementClassifier{}
		worker := newInboundDBWorker(pool, fixture, objects, classifier)

		if _, err := worker.ProcessObject(context.Background(), inboundDeliveryFor(key)); err != nil {
			t.Fatalf("ProcessObject: %v", err)
		}
		got := loadInboundCounts(t, pool, fixture)
		if got.Replies != 1 || got.RepliedEvents != 1 {
			t.Fatalf("human reply counts = %+v, want one reply and one replied event", got)
		}
		if got.Classification != string(ClassHumanReply) {
			t.Fatalf("classification = %q, want %q", got.Classification, ClassHumanReply)
		}
		if classifier.calls != 1 || classifier.eventType != "replied" {
			t.Fatalf("classifier calls = %d type = %q", classifier.calls, classifier.eventType)
		}
		if classifier.signals["reply_classification"] != string(ClassHumanReply) ||
			classifier.signals["reply_classifier_version"] != ReplyClassifierVersion {
			t.Fatalf("classification receipt did not travel with the event: %#v", classifier.signals)
		}
	})
}

// A message whose bytes Postgres cannot store is still stored.
//
// 0x00 is valid UTF-8 and illegal in a Postgres text column, so a sender who
// puts one anywhere in the subject, the body or an address makes the insert
// fail — and an at-least-once ingest path retries a failing insert forever.
// This is the whole class, not one field: the assertions below place a NUL in
// each of the three the worker carries.
func TestInboundObjectWithBytesPostgresRejectsIsStillStored_DB(t *testing.T) {
	pool := repliesDB(t)
	for _, tc := range []struct {
		name      string
		subject   string
		body      string
		recipient string
		keySuffix string
	}{
		{
			// Reaches the database and fails the INSERT.
			name: "subject and body", subject: "Re: Spring\x00 sale",
			body:      "Yes\x00 please, Tuesday works.",
			recipient: "replies-acme@" + inboundTestEnvelopeDomain,
		},
		{
			// Never reaches the database: the slug no longer matches, so the
			// reply is dropped as unmapped instead.
			name: "envelope recipient", subject: "Re: Spring sale",
			body:      "Yes please, Tuesday works.",
			recipient: "replies-acme@" + inboundTestEnvelopeDomain + "\x00",
		},
		{
			// Reaches the metadata document rather than a column. A control
			// character here is what breaks a JSON literal built with %q, and a
			// NUL is what jsonb rejects even when correctly escaped.
			name: "object key", subject: "Re: Spring sale",
			body:      "Yes please, Tuesday works.",
			recipient: "replies-acme@" + inboundTestEnvelopeDomain,
			keySuffix: "\x01\x00",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := seedReplyFixture(t, pool, false)
			key := uuid.NewString() + tc.keySuffix
			objects := &inboundFakeObjects{objects: map[string][]byte{
				"postwave-test-inbound-mail/inbound/" + key: inboundObjectFor(
					fixture, tc.subject, tc.body, "Auto-Submitted: no"),
			}}
			worker := newInboundDBWorker(pool, fixture, objects,
				&recordingEngagementClassifier{})
			delivery := inboundDeliveryFor(key)
			delivery.Recipients = []string{tc.recipient}

			outcome, err := worker.ProcessObject(context.Background(), delivery)
			if err != nil {
				t.Fatalf("ProcessObject: %v", err)
			}
			if outcome.ReplyID == "" || outcome.Dropped != "" {
				t.Fatalf("outcome = %+v, want the reply stored", outcome)
			}
			if got := loadInboundCounts(t, pool, fixture); got.Replies != 1 {
				t.Fatalf("replies = %d, want 1", got.Replies)
			}
		})
	}
}

// The same object processed twice is one row and one event.
//
// SNS redelivers, workers crash between the fetch and the commit, and an
// operator replaying a day of objects is a supported recovery. All three send
// the identical bytes through twice.
func TestInboundObjectProcessedTwiceDoesNotDoubleCount_DB(t *testing.T) {
	pool := repliesDB(t)
	fixture := seedReplyFixture(t, pool, false)
	key := uuid.NewString()
	objects := &inboundFakeObjects{objects: map[string][]byte{
		"postwave-test-inbound-mail/inbound/" + key: inboundObjectFor(fixture,
			"Re: Spring sale", "Yes please, Tuesday works.", "Auto-Submitted: no"),
	}}
	classifier := &recordingEngagementClassifier{}
	worker := newInboundDBWorker(pool, fixture, objects, classifier)
	delivery := inboundDeliveryFor(key)

	first, err := worker.ProcessObject(context.Background(), delivery)
	if err != nil || first.Duplicate || first.ReplyID == "" {
		t.Fatalf("first ProcessObject = %+v err = %v", first, err)
	}
	if after := loadInboundCounts(t, pool, fixture); after.Replies != 1 || after.RepliedEvents != 1 {
		t.Fatalf("first pass counts = %+v, want one reply and one event", after)
	}

	second, err := worker.ProcessObject(context.Background(), delivery)
	if err != nil {
		t.Fatalf("second ProcessObject: %v", err)
	}
	// Counts first: the claim is about what is in the database, not about a
	// flag on the return value.
	replayed := loadInboundCounts(t, pool, fixture)
	if replayed.Replies != 1 {
		t.Fatalf("replay wrote %d reply rows, want 1", replayed.Replies)
	}
	if replayed.RepliedEvents != 1 {
		t.Fatalf("replay wrote %d replied events, want 1", replayed.RepliedEvents)
	}
	if classifier.calls != 1 {
		t.Fatalf("replay scored engagement %d times, want 1", classifier.calls)
	}
	if !second.Duplicate {
		t.Fatal("second pass did not report the object as a duplicate")
	}
	if second.ReplyID != first.ReplyID {
		t.Fatalf("second pass id = %q, want the first row's id %q", second.ReplyID, first.ReplyID)
	}
	if objects.reads != 2 {
		t.Fatalf("object reads = %d, want the second pass to have re-read the object", objects.reads)
	}
}

// A malformed object is refused, writes nothing, and does not take the worker
// with it.
//
// These bytes came from a stranger. "It parses" is a hypothesis; the failure
// mode this guards is not only a crash but the quieter one where an unparseable
// object becomes an empty reply — and an empty body classifies as human.
func TestMalformedInboundObjectWritesNothingAndLeavesTheWorkerUsable_DB(t *testing.T) {
	pool := repliesDB(t)
	fixture := seedReplyFixture(t, pool, false)

	badKey := uuid.NewString()
	goodKey := uuid.NewString()
	objects := &inboundFakeObjects{objects: map[string][]byte{
		"postwave-test-inbound-mail/inbound/" + badKey: []byte(
			"\x00\x01 this is not a message, it is a stranger's bytes\r\nno header here\r\n"),
		"postwave-test-inbound-mail/inbound/" + goodKey: inboundObjectFor(fixture,
			"Re: Spring sale", "Yes please, Tuesday works.", "Auto-Submitted: no"),
	}}
	classifier := &recordingEngagementClassifier{}
	worker := newInboundDBWorker(pool, fixture, objects, classifier)

	outcome, err := worker.ProcessObject(context.Background(), inboundDeliveryFor(badKey))
	if !errors.Is(err, ErrMalformedObject) {
		t.Fatalf("err = %v, want ErrMalformedObject", err)
	}
	if outcome.ReplyID != "" || outcome.Dropped != "" {
		t.Fatalf("outcome = %+v, want nothing stored and no drop verdict", outcome)
	}
	if empty := loadInboundCounts(t, pool, fixture); empty.Replies != 0 || empty.RepliedEvents != 0 {
		t.Fatalf("malformed object wrote rows: %+v", empty)
	}
	if classifier.calls != 0 {
		t.Fatalf("malformed object scored engagement %d times", classifier.calls)
	}

	// Same worker, next object. A worker that a bad object had poisoned would
	// fail here, and this is the assertion that says "does not crash" in a form
	// that is checked rather than assumed.
	good, err := worker.ProcessObject(context.Background(), inboundDeliveryFor(goodKey))
	if err != nil {
		t.Fatalf("worker did not survive the malformed object: %v", err)
	}
	if good.ReplyID == "" || good.Duplicate {
		t.Fatalf("recovery outcome = %+v", good)
	}
	recovered := loadInboundCounts(t, pool, fixture)
	if recovered.Replies != 1 || recovered.RepliedEvents != 1 {
		t.Fatalf("post-recovery counts = %+v, want one reply and one event", recovered)
	}
}
