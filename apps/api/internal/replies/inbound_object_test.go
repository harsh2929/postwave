// SPDX-License-Identifier: AGPL-3.0-only

package replies

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// ---------------------------------------------------------------------------
// doubles
// ---------------------------------------------------------------------------

type inboundFakeObjects struct {
	objects map[string][]byte
	err     error
	reads   int
}

func (f *inboundFakeObjects) GetInboundObject(_ context.Context, ref ObjectRef) (io.ReadCloser, error) {
	f.reads++
	if f.err != nil {
		return nil, f.err
	}
	raw, ok := f.objects[ref.Bucket+"/"+ref.Key]
	if !ok {
		return nil, errors.New("no such object")
	}
	return io.NopCloser(bytes.NewReader(raw)), nil
}

// inboundStubMatcher records what it was asked, so a test can assert which
// tenant the worker resolved without reaching the database.
type inboundStubMatcher struct {
	result     MatchResult
	err        error
	verpTenant string

	sawTenant string
	sawReply  Reply
	calls     int
}

func (s *inboundStubMatcher) Resolve(_ context.Context, tenantID string, reply Reply) (MatchResult, error) {
	s.calls++
	s.sawTenant = tenantID
	s.sawReply = reply
	return s.result, s.err
}

func (s *inboundStubMatcher) TenantFromVERPRecipient(_ string) (string, bool) {
	if s.verpTenant == "" {
		return "", false
	}
	return s.verpTenant, true
}

type unreachableS3 struct{ t *testing.T }

func (u unreachableS3) GetObject(
	_ context.Context, _ *s3.GetObjectInput, _ ...func(*s3.Options),
) (*s3.GetObjectOutput, error) {
	u.t.Fatal("S3 GetObject called for a bucket that should have been refused")
	return nil, errors.New("unreachable")
}

type inboundStubResolver struct {
	bySlug  map[string]string
	byEmail map[string]string
}

func (s inboundStubResolver) LookupTenantBySlug(_ context.Context, slug string) (string, error) {
	return s.bySlug[strings.ToLower(slug)], nil
}

func (s inboundStubResolver) LookupTenantBySubscriberEmail(_ context.Context, email string) (string, error) {
	return s.byEmail[strings.ToLower(email)], nil
}

// mimeMessage joins lines with CRLF, which is what a real object contains and
// what mail.ReadMessage's header scanner expects.
func mimeMessage(lines ...string) []byte {
	return []byte(strings.Join(lines, "\r\n"))
}

// ---------------------------------------------------------------------------
// notification parsing
// ---------------------------------------------------------------------------

const sesS3Notification = `{
  "notificationType": "Received",
  "mail": {
    "timestamp": "2026-08-13T09:15:00.000Z",
    "source": "person@example.test",
    "messageId": "s3nq1k4p9v8g0m2b",
    "destination": ["replies-acme@reply.example.test"]
  },
  "receipt": {
    "timestamp": "2026-08-13T09:15:01.000Z",
    "recipients": ["reply+abc@reply.example.test"],
    "spamVerdict": {"status": "PASS"},
    "virusVerdict": {"status": "PASS"},
    "action": {
      "type": "S3",
      "topicArn": "arn:aws:sns:us-west-2:1:postwave-prod-inbound-mail",
      "bucketName": "postwave-prod-inbound-mail-1",
      "objectKey": "inbound/s3nq1k4p9v8g0m2b"
    }
  }
}`

func TestParseSESInboundNotificationExtractsPointerAndEnvelope(t *testing.T) {
	delivery, err := ParseSESInboundNotification([]byte(sesS3Notification))
	if err != nil {
		t.Fatalf("ParseSESInboundNotification: %v", err)
	}
	if delivery.Object.Bucket != "postwave-prod-inbound-mail-1" ||
		delivery.Object.Key != "inbound/s3nq1k4p9v8g0m2b" {
		t.Fatalf("object = %+v", delivery.Object)
	}
	if delivery.SESMessageID != "s3nq1k4p9v8g0m2b" {
		t.Fatalf("ses message id = %q", delivery.SESMessageID)
	}
	// The envelope recipient must lead: it is the one VERP is encoded in, and
	// receipt.recipients is the envelope while mail.destination is header-derived.
	if len(delivery.Recipients) != 2 || delivery.Recipients[0] != "reply+abc@reply.example.test" {
		t.Fatalf("recipients = %#v, want envelope recipient first", delivery.Recipients)
	}
	if delivery.SpamVerdict != "PASS" || delivery.VirusVerdict != "PASS" {
		t.Fatalf("verdicts = %q/%q", delivery.SpamVerdict, delivery.VirusVerdict)
	}
	want := time.Date(2026, 8, 13, 9, 15, 1, 0, time.UTC)
	if !delivery.ReceivedAt.Equal(want) {
		t.Fatalf("received_at = %v, want %v", delivery.ReceivedAt, want)
	}
}

func TestParseSESInboundNotificationWithoutS3ActionIsDistinguishable(t *testing.T) {
	// A well-formed notification with a Lambda action is not an error: the
	// caller has to be able to fall back to the inline shape.
	const lambdaAction = `{"notificationType":"Received","mail":{"messageId":"x"},
	  "receipt":{"action":{"type":"Lambda","functionArn":"arn:aws:lambda:::f"}}}`
	if _, err := ParseSESInboundNotification([]byte(lambdaAction)); !errors.Is(err, ErrNoObjectPointer) {
		t.Fatalf("lambda action err = %v, want ErrNoObjectPointer", err)
	}
	// An S3 action missing its bucket is equally unusable.
	const noBucket = `{"receipt":{"action":{"type":"S3","objectKey":"inbound/x"}}}`
	if _, err := ParseSESInboundNotification([]byte(noBucket)); !errors.Is(err, ErrNoObjectPointer) {
		t.Fatalf("bucketless S3 action err = %v, want ErrNoObjectPointer", err)
	}
	if _, err := ParseSESInboundNotification([]byte("{not json")); err == nil {
		t.Fatal("malformed notification parsed without error")
	}
}

// ---------------------------------------------------------------------------
// MIME extraction
// ---------------------------------------------------------------------------

func TestInboundMessageParsingDecodesHeadersAndPrefersPlainText(t *testing.T) {
	raw := mimeMessage(
		`From: "Dana Fields" <dana@example.test>`,
		`To: replies-acme@reply.example.test`,
		`Subject: =?utf-8?B?UmU6IEZyw7xobGluZ3NhbmdlYm90?=`,
		`Date: Thu, 13 Aug 2026 09:14:00 +0000`,
		`In-Reply-To: <outbound-77@postwave.test>`,
		`Precedence: bulk`,
		`X-Mailer: SomethingIrrelevant`,
		`MIME-Version: 1.0`,
		`Content-Type: multipart/mixed; boundary="OUTER"`,
		``,
		`--OUTER`,
		`Content-Type: application/pdf; name="invoice.pdf"`,
		`Content-Disposition: attachment; filename="invoice.pdf"`,
		`Content-Transfer-Encoding: base64`,
		``,
		`JVBERi0xLjQK`,
		`--OUTER`,
		`Content-Type: multipart/alternative; boundary="INNER"`,
		``,
		`--INNER`,
		`Content-Type: text/html; charset=utf-8`,
		`Content-Transfer-Encoding: quoted-printable`,
		``,
		`<p>ignored=20html</p>`,
		`--INNER`,
		`Content-Type: text/plain; charset=utf-8`,
		`Content-Transfer-Encoding: base64`,
		``,
		`WWVzIHBsZWFzZSwgVHVlc2RheSB3b3Jrcy4=`,
		`--INNER--`,
		`--OUTER--`,
		``,
	)

	parsed, err := parseInboundMessage(raw)
	if err != nil {
		t.Fatalf("parseInboundMessage: %v", err)
	}
	if parsed.From != "dana@example.test" {
		t.Fatalf("from = %q, want the bare address", parsed.From)
	}
	if parsed.Subject != "Re: Frühlingsangebot" {
		t.Fatalf("subject = %q, want the RFC 2047 encoded-word decoded", parsed.Subject)
	}
	if parsed.Body != "Yes please, Tuesday works." {
		t.Fatalf("body = %q, want the base64 text/plain alternative", parsed.Body)
	}
	if parsed.InReplyTo != "<outbound-77@postwave.test>" {
		t.Fatalf("in_reply_to = %q", parsed.InReplyTo)
	}
	want := time.Date(2026, 8, 13, 9, 14, 0, 0, time.UTC)
	if !parsed.Date.Equal(want) {
		t.Fatalf("date = %v, want %v", parsed.Date, want)
	}
	// Only the allow-list survives. X-Mailer is a header, not a classification
	// header, and capturing it would widen what reaches the F01 observation.
	if parsed.Headers.Get("Precedence") != "bulk" {
		t.Fatalf("headers = %#v, want Precedence captured", parsed.Headers)
	}
	if len(parsed.Headers) != 2 { // Precedence + Content-Type
		t.Fatalf("headers = %#v, want exactly the allow-listed subset", parsed.Headers)
	}
	if parsed.Headers.Get("X-Mailer") != "" {
		t.Fatalf("non-allow-listed header captured: %#v", parsed.Headers)
	}
}

func TestInboundMessageParsingRejectsGarbage(t *testing.T) {
	for name, raw := range map[string][]byte{
		"prose":      []byte("this is not a message at all, it is just prose\r\nwith no header\r\n"),
		"empty":      {},
		"whitespace": []byte("   \r\n\r\n   "),
		"binary":     {0x00, 0x01, 0x02, 0xff, 0xfe},
	} {
		t.Run(name, func(t *testing.T) {
			parsed, err := parseInboundMessage(raw)
			if !errors.Is(err, ErrMalformedObject) {
				t.Fatalf("err = %v, want ErrMalformedObject", err)
			}
			// Not merely "an error": nothing usable may come back, because a
			// zero-valued parse result classifies as a human reply.
			if parsed.From != "" || parsed.Subject != "" || parsed.Body != "" {
				t.Fatalf("malformed object yielded content: %+v", parsed)
			}
		})
	}
}

func TestInboundMessageWithNoContentTypeIsTreatedAsPlainText(t *testing.T) {
	raw := mimeMessage(
		`From: dana@example.test`,
		`Subject: Re: hello`,
		``,
		`Sure, that works for me.`,
		``,
	)
	parsed, err := parseInboundMessage(raw)
	if err != nil {
		t.Fatalf("parseInboundMessage: %v", err)
	}
	if parsed.Body != "Sure, that works for me." {
		t.Fatalf("body = %q", parsed.Body)
	}
}

// ---------------------------------------------------------------------------
// worker guards that need no database
// ---------------------------------------------------------------------------

func newInboundTestWorker(objects *inboundFakeObjects) *InboundObjectWorker {
	return &InboundObjectWorker{
		Objects:              objects,
		Store:                &Store{},
		Matcher:              &inboundStubMatcher{result: MatchResult{Method: MatchNone}},
		TenantResolver:       inboundStubResolver{},
		EnvelopeDomainSuffix: "reply.example.test",
	}
}

func TestProcessObjectEnforcesTheObjectCeiling(t *testing.T) {
	objects := &inboundFakeObjects{objects: map[string][]byte{
		"b/inbound/k": bytes.Repeat([]byte("A"), 4096),
	}}
	worker := newInboundTestWorker(objects)
	worker.MaxObjectBytes = 1024

	_, err := worker.ProcessObject(context.Background(), InboundDelivery{
		Object: ObjectRef{Bucket: "b", Key: "inbound/k"}, SESMessageID: "k",
		ReceivedAt: time.Now().UTC(),
	})
	if !errors.Is(err, ErrObjectTooLarge) {
		t.Fatalf("err = %v, want ErrObjectTooLarge", err)
	}
}

func TestProcessObjectDropsScannedUnsafeMailWithoutFetchingIt(t *testing.T) {
	for _, tc := range []struct {
		name    string
		spam    string
		virus   string
		want    string
		fetched bool
	}{
		{name: "virus fail", virus: "FAIL", want: DropVirus},
		{name: "spam fail", spam: "FAIL", want: DropSpam},
		// GRAY is not FAIL. Dropping on it would silently discard real replies
		// whenever the scanner was uncertain.
		{name: "spam gray is delivered", spam: "GRAY", want: "", fetched: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			objects := &inboundFakeObjects{objects: map[string][]byte{
				"b/inbound/k": mimeMessage(`From: a@example.test`, `Subject: Re: x`, ``, `hi`, ``),
			}}
			worker := newInboundTestWorker(objects)
			var rejected atomic.Int64
			worker.RejectedCounter = &rejected

			outcome, err := worker.ProcessObject(context.Background(), InboundDelivery{
				Object: ObjectRef{Bucket: "b", Key: "inbound/k"}, SESMessageID: "k",
				SpamVerdict: tc.spam, VirusVerdict: tc.virus,
				ReceivedAt: time.Now().UTC(),
			})
			if tc.want != "" {
				if err != nil || outcome.Dropped != tc.want {
					t.Fatalf("outcome = %+v err = %v, want dropped %q", outcome, err, tc.want)
				}
				if objects.reads != 0 {
					t.Fatalf("fetched %d objects for a %s verdict; the drop must precede the read",
						objects.reads, tc.want)
				}
				if rejected.Load() != 1 {
					t.Fatalf("rejected counter = %d, want 1", rejected.Load())
				}
				return
			}
			// GRAY: no tenant resolves in this stub, so it drops as unmapped —
			// but only AFTER the object was read, which is the point.
			if outcome.Dropped != DropTenantUnmapped || err != nil {
				t.Fatalf("outcome = %+v err = %v", outcome, err)
			}
			if objects.reads != 1 {
				t.Fatalf("reads = %d, want the GRAY object to have been fetched", objects.reads)
			}
			if rejected.Load() != 0 {
				t.Fatalf("rejected counter = %d, want 0 for GRAY", rejected.Load())
			}
		})
	}
}

func TestProcessObjectRefusesAnObjectItCannotReplayKey(t *testing.T) {
	objects := &inboundFakeObjects{objects: map[string][]byte{
		"b/": mimeMessage(`From: a@example.test`, `Subject: Re: x`, ``, `hi`, ``),
	}}
	worker := newInboundTestWorker(objects)
	if _, err := worker.ProcessObject(context.Background(), InboundDelivery{
		Object: ObjectRef{Bucket: "b", Key: "inbound/"}, ReceivedAt: time.Now().UTC(),
	}); !errors.Is(err, ErrNoStableMessageID) {
		t.Fatalf("err = %v, want ErrNoStableMessageID", err)
	}
	if _, err := worker.ProcessObject(context.Background(), InboundDelivery{
		Object: ObjectRef{Key: "inbound/k"}, SESMessageID: "k",
	}); !errors.Is(err, ErrNoObjectPointer) {
		t.Fatalf("bucketless err = %v, want ErrNoObjectPointer", err)
	}
}

func TestProcessObjectRefusesAnObjectWithNoStableReceivedAt(t *testing.T) {
	// No Date header and no notification timestamp. Store.Persist would fill
	// received_at from the clock, and its duplicate check compares received_at
	// exactly — so the SECOND delivery of this same message would be an
	// idempotency conflict rather than a recognised duplicate.
	objects := &inboundFakeObjects{objects: map[string][]byte{
		"b/inbound/k": mimeMessage(`From: a@example.test`, `Subject: Re: x`, ``, `hi`, ``),
	}}
	worker := newInboundTestWorker(objects)
	if _, err := worker.ProcessObject(context.Background(), InboundDelivery{
		Object: ObjectRef{Bucket: "b", Key: "inbound/k"}, SESMessageID: "k",
	}); !errors.Is(err, ErrNoStableTimestamp) {
		t.Fatalf("err = %v, want ErrNoStableTimestamp", err)
	}
}

func TestProcessObjectResolvesTenantByVERPBeforeTheEmailGuess(t *testing.T) {
	objects := &inboundFakeObjects{objects: map[string][]byte{
		"b/inbound/k": mimeMessage(
			`From: dana@example.test`,
			`To: reply+token@reply.example.test`,
			`Subject: Re: x`,
			`Date: Thu, 13 Aug 2026 09:14:00 +0000`,
			``, `hi`, ``,
		),
	}}
	worker := newInboundTestWorker(objects)
	matcher := &inboundStubMatcher{
		result: MatchResult{Method: MatchNone}, verpTenant: "tenant-from-verp",
	}
	worker.Matcher = matcher
	worker.TenantResolver = inboundStubResolver{
		byEmail: map[string]string{"dana@example.test": "tenant-from-email"},
	}
	// The store has no pool, so Persist fails after the interesting part. What
	// is asserted is the tenant the matcher was handed: a worker that fell
	// through to the global email guess would have reached it with the other id.
	if _, err := worker.ProcessObject(context.Background(), InboundDelivery{
		Object:       ObjectRef{Bucket: "b", Key: "inbound/k"},
		SESMessageID: "k",
		Recipients:   []string{"reply+token@reply.example.test"},
	}); err == nil {
		t.Fatal("expected the uninitialised store to fail the persist")
	}
	if matcher.calls != 1 {
		t.Fatalf("matcher calls = %d, want the worker to have resolved and matched", matcher.calls)
	}
	if matcher.sawTenant != "tenant-from-verp" {
		t.Fatalf("tenant = %q, want the signed VERP answer to win over the email guess",
			matcher.sawTenant)
	}
	// The envelope recipient, not the To: header, is what VERP is read from.
	if matcher.sawReply.EnvelopeRecipient != "reply+token@reply.example.test" {
		t.Fatalf("envelope recipient = %q", matcher.sawReply.EnvelopeRecipient)
	}
}

func TestS3ObjectSourceRefusesAnUnexpectedBucket(t *testing.T) {
	source := &S3ObjectSource{API: unreachableS3{t: t}, Bucket: "postwave-prod-inbound-mail-1"}
	if _, err := source.GetInboundObject(context.Background(),
		ObjectRef{Bucket: "attacker-bucket", Key: "inbound/k"}); !errors.Is(err, ErrBucketNotAllowed) {
		t.Fatalf("err = %v, want ErrBucketNotAllowed", err)
	}
	if _, err := source.GetInboundObject(context.Background(),
		ObjectRef{Bucket: "", Key: "inbound/k"}); !errors.Is(err, ErrNoObjectPointer) {
		t.Fatalf("err = %v, want ErrNoObjectPointer", err)
	}
}
