// SPDX-License-Identifier: AGPL-3.0-only

package transactional

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/sendallowance"
)

type fakeAllowance struct {
	reserveErr error
	reserved   []sendallowance.Request
	committed  int
	released   int
}

func (f *fakeAllowance) Reserve(_ context.Context, in sendallowance.Request) (sendallowance.Reservation, error) {
	f.reserved = append(f.reserved, in)
	if f.reserveErr != nil {
		return sendallowance.Reservation{}, f.reserveErr
	}
	return sendallowance.Reservation{ID: "reservation", TenantID: in.TenantID, Units: len(in.RecipientIDs), Managed: true, State: "reserved"}, nil
}
func (f *fakeAllowance) Commit(context.Context, sendallowance.Reservation) error {
	f.committed++
	return nil
}
func (f *fakeAllowance) Release(context.Context, sendallowance.Reservation, string) error {
	f.released++
	return nil
}

type fakeMailer struct {
	last mailer.Message
	err  error
}

func (f *fakeMailer) Send(_ context.Context, m mailer.Message) error {
	f.last = m
	return f.err
}

type fakeReceiptMailer struct {
	fakeMailer
	providerMessageID string
}

func (f *fakeReceiptMailer) SendWithReceipt(_ context.Context, m mailer.Message) (mailer.DeliveryReceipt, error) {
	f.last = m
	return mailer.DeliveryReceipt{ProviderMessageID: f.providerMessageID}, f.err
}

type fakeSupp struct{ set map[string]bool }

func (f fakeSupp) IsSuppressed(_ context.Context, _, email string) (bool, error) {
	return f.set[strings.ToLower(email)], nil
}

func TestNormalize(t *testing.T) {
	now := time.Unix(1700000000, 0).UTC()
	t.Run("defaults from + dedups + validates", func(t *testing.T) {
		r := SendRequest{To: stringList{"a@b.com", "A@B.com", " "}, Subject: "hi", Text: "yo"}
		if err := r.Normalize("noreply@moosewave.com", now); err != nil {
			t.Fatal(err)
		}
		if r.From != "noreply@moosewave.com" {
			t.Fatalf("from default not applied: %q", r.From)
		}
		if len(r.To) != 1 { // dedup case-insensitive + drop blank
			t.Fatalf("to not deduped: %v", r.To)
		}
	})
	t.Run("rejects missing to / subject / body / bad email", func(t *testing.T) {
		cases := []SendRequest{
			{From: "a@b.com", Subject: "s", Text: "t"},                               // no to
			{From: "a@b.com", To: stringList{"x@y.com"}, Text: "t"},                  // no subject
			{From: "a@b.com", To: stringList{"x@y.com"}, Subject: "s"},               // no body
			{From: "a@b.com", To: stringList{"notanemail"}, Subject: "s", Text: "t"}, // bad addr
		}
		for i, c := range cases {
			if err := c.Normalize("", now); !errors.Is(err, ErrValidation) {
				t.Errorf("case %d: want ErrValidation, got %v", i, err)
			}
		}
	})
	t.Run("too many recipients", func(t *testing.T) {
		var to stringList
		for i := 0; i < MaxRecipients+1; i++ {
			to = append(to, "u"+string(rune('a'+i%26))+string(rune('0'+i/26))+"@x.com")
		}
		r := SendRequest{From: "a@b.com", To: to, Subject: "s", Text: "t"}
		if err := r.Normalize("", now); !errors.Is(err, ErrValidation) {
			t.Fatalf("want too-many-recipients rejection, got %v", err)
		}
	})
	t.Run("scheduled in the past is cleared to immediate", func(t *testing.T) {
		past := now.Add(-time.Hour)
		r := SendRequest{From: "a@b.com", To: stringList{"x@y.com"}, Subject: "s", Text: "t", ScheduledAt: &past}
		if err := r.Normalize("", now); err != nil {
			t.Fatal(err)
		}
		if r.ScheduledAt != nil {
			t.Fatal("past schedule should be cleared")
		}
	})
	t.Run("attachment needs exactly one of content/path", func(t *testing.T) {
		r := SendRequest{From: "a@b.com", To: stringList{"x@y.com"}, Subject: "s", Text: "t",
			Attachments: []Attachment{{Filename: "f.txt"}}} // neither
		if err := r.Normalize("", now); !errors.Is(err, ErrValidation) {
			t.Fatalf("want attachment validation, got %v", err)
		}
	})
}

func TestStringListUnmarshal(t *testing.T) {
	var single struct {
		To stringList `json:"to"`
	}
	if err := json.Unmarshal([]byte(`{"to":"a@b.com"}`), &single); err != nil || len(single.To) != 1 {
		t.Fatalf("single string: %v %v", single.To, err)
	}
	var arr struct {
		To stringList `json:"to"`
	}
	if err := json.Unmarshal([]byte(`{"to":["a@b.com","c@d.com"]}`), &arr); err != nil || len(arr.To) != 2 {
		t.Fatalf("array: %v %v", arr.To, err)
	}
}

func TestDispatchMapsMessage(t *testing.T) {
	fm := &fakeMailer{}
	d := &Deps{Mailer: fm, DefaultFrom: "noreply@moosewave.com"}
	r := &SendRequest{
		From: "send@moosewave.com", To: stringList{"to@x.com"}, Cc: stringList{"cc@x.com"},
		Bcc: stringList{"bcc@x.com"}, ReplyTo: stringList{"reply@x.com"},
		Subject: "Subject", HTML: "<b>hi</b>", Text: "hi",
		Headers:     map[string]string{"X-Entity-Ref-ID": "abc"},
		Tags:        []Tag{{Name: "category", Value: "welcome"}},
		Attachments: []Attachment{{Filename: "a.txt", Content: base64.StdEncoding.EncodeToString([]byte("hello")), ContentType: "text/plain"}},
	}
	if err := r.Normalize(d.DefaultFrom, time.Now()); err != nil {
		t.Fatal(err)
	}
	status, suppressed, err := d.dispatch(context.Background(), "t1", r)
	if err != nil || status != "sent" || suppressed != 0 {
		t.Fatalf("dispatch: %s %d %v", status, suppressed, err)
	}
	m := fm.last
	if len(m.ToList) != 1 || m.ToList[0] != "to@x.com" {
		t.Errorf("to: %v", m.ToList)
	}
	if len(m.Cc) != 1 || len(m.Bcc) != 1 || m.ReplyTo != "reply@x.com" {
		t.Errorf("cc/bcc/replyto: %v %v %q", m.Cc, m.Bcc, m.ReplyTo)
	}
	if m.HTMLBody != "<b>hi</b>" || m.Body != "hi" {
		t.Errorf("bodies: %q %q", m.HTMLBody, m.Body)
	}
	if m.Headers["X-Entity-Ref-ID"] != "abc" || m.Tags["category"] != "welcome" {
		t.Errorf("headers/tags: %v %v", m.Headers, m.Tags)
	}
	if len(m.Attachments) != 1 || string(m.Attachments[0].Content) != "hello" || m.Attachments[0].Filename != "a.txt" {
		t.Errorf("attachment: %+v", m.Attachments)
	}
}

func TestDispatchWithReceiptRetainsProviderAttribution(t *testing.T) {
	fm := &fakeReceiptMailer{providerMessageID: "ses-message-123"}
	d := &Deps{Mailer: fm}
	r := &SendRequest{
		From: "send@example.com", To: stringList{"to@example.com"},
		Subject: "subject", Text: "body",
	}
	if err := r.Normalize("", time.Now()); err != nil {
		t.Fatal(err)
	}
	const tenantID = "11111111-1111-4111-8111-111111111111"
	status, suppressed, providerMessageID, err := d.dispatchWithReceipt(
		context.Background(), tenantID, r,
	)
	if err != nil || status != "sent" || suppressed != 0 {
		t.Fatalf("dispatch = (%q,%d,%q,%v)", status, suppressed, providerMessageID, err)
	}
	if providerMessageID != fm.providerMessageID {
		t.Fatalf("provider message id = %q, want %q", providerMessageID, fm.providerMessageID)
	}
	if fm.last.TenantID != tenantID {
		t.Fatalf("message tenant binding = %q, want %q", fm.last.TenantID, tenantID)
	}
}

func TestDispatchManagedAllowanceIsCommittedBeforeProvider(t *testing.T) {
	gate := &fakeAllowance{}
	fm := &fakeMailer{}
	d := &Deps{Mailer: fm, Allowance: gate, RequireAllowance: true}
	r := &SendRequest{From: "send@example.com", To: stringList{"to@example.com"}, Subject: "subject", Text: "body"}
	if err := r.Normalize("", time.Now()); err != nil {
		t.Fatal(err)
	}
	status, _, _, err := d.dispatchWithReceiptForIntent(
		context.Background(), "tenant-1", r, "transactional-email:row-1", "transactional_emails:row-1",
	)
	if err != nil || status != "sent" || len(gate.reserved) != 1 || gate.committed != 1 || gate.released != 0 {
		t.Fatalf("dispatch=%q err=%v gate=%+v", status, err, gate)
	}
	if fm.last.ToList[0] != "to@example.com" || gate.reserved[0].RecipientIDs[0] != "to@example.com" {
		t.Fatalf("provider and allowance recipient diverged: mail=%v allowance=%v", fm.last.ToList, gate.reserved[0].RecipientIDs)
	}
}

func TestDispatchManagedAllowanceExhaustionNeverCallsProvider(t *testing.T) {
	gate := &fakeAllowance{reserveErr: &sendallowance.ExhaustedError{Limit: 2, Current: 2, Requested: 1}}
	fm := &fakeMailer{}
	d := &Deps{Mailer: fm, Allowance: gate, RequireAllowance: true}
	r := &SendRequest{From: "send@example.com", To: stringList{"to@example.com"}, Subject: "subject", Text: "body"}
	_ = r.Normalize("", time.Now())
	status, _, _, err := d.dispatchWithReceiptForIntent(
		context.Background(), "tenant-1", r, "transactional-email:row-1", "transactional_emails:row-1",
	)
	if status != "failed" || !errors.Is(err, sendallowance.ErrExhausted) || fm.last.From != "" || gate.committed != 0 {
		t.Fatalf("exhausted dispatch=%q err=%v provider=%+v gate=%+v", status, err, fm.last, gate)
	}
}

func TestDispatchManagedAllowanceReconcilesProviderOutcome(t *testing.T) {
	for _, test := range []struct {
		name     string
		err      error
		released int
	}{
		{name: "definite rejection releases", err: errors.New("provider rejected request"), released: 1},
		{name: "ambiguous timeout remains consumed", err: context.DeadlineExceeded},
	} {
		t.Run(test.name, func(t *testing.T) {
			gate := &fakeAllowance{}
			fm := &fakeMailer{err: test.err}
			d := &Deps{Mailer: fm, Allowance: gate, RequireAllowance: true}
			r := &SendRequest{From: "send@example.com", To: stringList{"to@example.com"}, Subject: "subject", Text: "body"}
			_ = r.Normalize("", time.Now())
			status, _, _, err := d.dispatchWithReceiptForIntent(
				context.Background(), "tenant-1", r, "transactional-email:row-1", "transactional_emails:row-1",
			)
			if status != "failed" || !errors.Is(err, test.err) || gate.committed != 1 || gate.released != test.released {
				t.Fatalf("dispatch=%q err=%v gate=%+v", status, err, gate)
			}
		})
	}
}

func TestDispatchSuppressionFilter(t *testing.T) {
	fm := &fakeMailer{}
	d := &Deps{Mailer: fm, Suppression: fakeSupp{set: map[string]bool{"bad@x.com": true}}}
	r := &SendRequest{From: "s@p.com", To: stringList{"good@x.com", "bad@x.com"}, Subject: "s", Text: "t"}
	if err := r.Normalize("", time.Now()); err != nil {
		t.Fatal(err)
	}
	status, suppressed, err := d.dispatch(context.Background(), "t1", r)
	if err != nil || status != "sent" || suppressed != 1 {
		t.Fatalf("want sent w/ 1 suppressed: %s %d %v", status, suppressed, err)
	}
	if len(fm.last.ToList) != 1 || fm.last.ToList[0] != "good@x.com" {
		t.Fatalf("suppressed recipient not filtered: %v", fm.last.ToList)
	}

	// All recipients suppressed → skipped, no send.
	fm2 := &fakeMailer{}
	d2 := &Deps{Mailer: fm2, Suppression: fakeSupp{set: map[string]bool{"bad@x.com": true}}}
	r2 := &SendRequest{From: "s@p.com", To: stringList{"bad@x.com"}, Subject: "s", Text: "t"}
	_ = r2.Normalize("", time.Now())
	status2, _, err2 := d2.dispatch(context.Background(), "t1", r2)
	if status2 != "skipped" || !errors.Is(err2, ErrAllSuppressed) {
		t.Fatalf("want skipped/ErrAllSuppressed: %s %v", status2, err2)
	}
	if fm2.last.From != "" {
		t.Fatal("should not have sent when all suppressed")
	}
}

type fakeFromVerify struct {
	verified map[string]bool
	err      error
}

func (f fakeFromVerify) IsFromDomainVerified(_ context.Context, _, domain string) (bool, error) {
	if f.err != nil {
		return false, f.err
	}
	return f.verified[domain], nil
}

func TestCheckFromAllowed(t *testing.T) {
	ctx := context.Background()
	// nil verifier → allowed (dev).
	if err := (&Deps{}).checkFromAllowed(ctx, "t", "x@any.com"); err != nil {
		t.Fatalf("nil verifier should allow: %v", err)
	}
	d := &Deps{
		DefaultFrom: "noreply@moosewave.com",
		FromVerify:  fakeFromVerify{verified: map[string]bool{"acme.com": true}},
	}
	// platform default domain → allowed without a verified identity.
	if err := d.checkFromAllowed(ctx, "t", "hi@moosewave.com"); err != nil {
		t.Errorf("default domain should be allowed: %v", err)
	}
	// tenant's own verified domain → allowed.
	if err := d.checkFromAllowed(ctx, "t", "ceo@acme.com"); err != nil {
		t.Errorf("verified domain should be allowed: %v", err)
	}
	// another tenant's domain (not verified for THIS tenant) → rejected (spoofing).
	if err := d.checkFromAllowed(ctx, "t", "ceo@victim.com"); !errors.Is(err, ErrValidation) {
		t.Errorf("unverified domain must be rejected, got %v", err)
	}
	// verifier error → fail closed (reject).
	d2 := &Deps{DefaultFrom: "noreply@moosewave.com", FromVerify: fakeFromVerify{err: errors.New("db down")}}
	if err := d2.checkFromAllowed(ctx, "t", "x@acme.com"); !errors.Is(err, ErrValidation) {
		t.Errorf("verifier error must fail closed, got %v", err)
	}
}

func TestSMTPDedupKey(t *testing.T) {
	// Message-Id present → keyed on it (retries reuse the same id → same key).
	withID := []byte("Message-Id: <abc@app>\r\nSubject: hi\r\n\r\nbody")
	k1 := smtpDedupKey(withID)
	if k1 != "mid:<abc@app>" {
		t.Fatalf("message-id key wrong: %q", k1)
	}
	// Same id, different body → still the same key (client's retry intent).
	k1b := smtpDedupKey([]byte("Message-Id: <abc@app>\r\nSubject: hi\r\n\r\nDIFFERENT"))
	if k1b != k1 {
		t.Fatalf("same message-id should give same key: %q vs %q", k1, k1b)
	}
	// No Message-Id → content hash; identical bytes → identical key.
	noID := []byte("Subject: hi\r\n\r\nbody")
	k2, k2b := smtpDedupKey(noID), smtpDedupKey(noID)
	if k2 != k2b || k2[:4] != "sha:" {
		t.Fatalf("content-hash key unstable/wrong: %q %q", k2, k2b)
	}
	// Different content → different hash key.
	if smtpDedupKey([]byte("Subject: hi\r\n\r\nother")) == k2 {
		t.Fatal("different content must give a different key")
	}
}

func TestResolveAttachments(t *testing.T) {
	d := &Deps{}
	// good base64
	atts, err := d.resolveAttachments(context.Background(), []Attachment{
		{Filename: "f", Content: base64.StdEncoding.EncodeToString([]byte("data"))},
	})
	if err != nil || len(atts) != 1 || string(atts[0].Content) != "data" {
		t.Fatalf("good base64: %v %v", atts, err)
	}
	// bad base64
	if _, err := d.resolveAttachments(context.Background(), []Attachment{{Filename: "f", Content: "!!!notb64"}}); !errors.Is(err, ErrValidation) {
		t.Fatalf("bad base64 should be ErrValidation, got %v", err)
	}
	// path without a fetcher → rejected
	if _, err := d.resolveAttachments(context.Background(), []Attachment{{Filename: "f", Path: "https://x/y"}}); !errors.Is(err, ErrValidation) {
		t.Fatalf("path-without-fetcher should be ErrValidation, got %v", err)
	}
	// over-size
	big := base64.StdEncoding.EncodeToString(make([]byte, MaxAttachmentBytes+1))
	if _, err := d.resolveAttachments(context.Background(), []Attachment{{Filename: "f", Content: big}}); !errors.Is(err, ErrValidation) {
		t.Fatalf("oversize should be ErrValidation, got %v", err)
	}
}
