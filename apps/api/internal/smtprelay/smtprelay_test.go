// SPDX-License-Identifier: AGPL-3.0-only

package smtprelay

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/emersion/go-smtp"
)

type fakeVerifier struct {
	key    string
	tenant string
}

func (f fakeVerifier) Verify(_ context.Context, plaintext string) (string, bool) {
	if plaintext == f.key {
		return f.tenant, true
	}
	return "", false
}

type fakeSender struct {
	tenant    string
	from      string
	rcpts     []string
	raw       []byte
	called    int
	err       error
	permanent bool
}

func (f *fakeSender) SendRawSMTP(_ context.Context, tenantID, from string, rcpts []string, raw []byte) (bool, error) {
	f.called++
	f.tenant, f.from, f.rcpts, f.raw = tenantID, from, rcpts, raw
	return f.permanent, f.err
}

func newSession(v Verifier, s RawSender) *session {
	be := &Backend{Verify: v, Sender: s, MaxRecipients: 3}
	return &session{be: be}
}

// The open-relay guard: every envelope command must fail before AUTH.
func TestUnauthenticatedCommandsRejected(t *testing.T) {
	s := newSession(fakeVerifier{key: "k", tenant: "t1"}, &fakeSender{})
	if err := s.Mail("a@b.com", nil); !errors.Is(err, smtp.ErrAuthRequired) {
		t.Errorf("Mail pre-auth: want ErrAuthRequired, got %v", err)
	}
	if err := s.Rcpt("c@d.com", nil); !errors.Is(err, smtp.ErrAuthRequired) {
		t.Errorf("Rcpt pre-auth: want ErrAuthRequired, got %v", err)
	}
	if err := s.Data(strings.NewReader("x")); !errors.Is(err, smtp.ErrAuthRequired) {
		t.Errorf("Data pre-auth: want ErrAuthRequired, got %v", err)
	}
}

func TestAuthThenRelay(t *testing.T) {
	sender := &fakeSender{}
	s := newSession(fakeVerifier{key: "secret-key", tenant: "tenant-9"}, sender)

	// Drive the SASL PLAIN exchange with the right key.
	srv, err := s.Auth("PLAIN")
	if err != nil {
		t.Fatal(err)
	}
	// PLAIN: \x00 authcid \x00 passwd
	if _, _, err := srv.Next([]byte("\x00user\x00secret-key")); err != nil {
		t.Fatalf("auth with good key failed: %v", err)
	}
	if !s.authed || s.tenantID != "tenant-9" {
		t.Fatalf("session not authed/bound: %v %q", s.authed, s.tenantID)
	}

	if err := s.Mail("from@app.com", nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Rcpt("to@x.com", nil); err != nil {
		t.Fatal(err)
	}
	if err := s.Data(strings.NewReader("Subject: hi\r\n\r\nbody")); err != nil {
		t.Fatal(err)
	}
	if sender.called != 1 || sender.tenant != "tenant-9" || sender.from != "from@app.com" {
		t.Fatalf("relay args wrong: %+v", sender)
	}
	if len(sender.rcpts) != 1 || sender.rcpts[0] != "to@x.com" {
		t.Fatalf("rcpts: %v", sender.rcpts)
	}
}

func TestAuthBadKeyRejected(t *testing.T) {
	s := newSession(fakeVerifier{key: "good", tenant: "t"}, &fakeSender{})
	srv, _ := s.Auth("PLAIN")
	if _, _, err := srv.Next([]byte("\x00user\x00WRONG")); err == nil {
		t.Fatal("auth with wrong key should fail")
	}
	if s.authed {
		t.Fatal("session must not be authed after bad key")
	}
}

func TestResetKeepsAuthDropsEnvelope(t *testing.T) {
	s := newSession(fakeVerifier{key: "k", tenant: "t"}, &fakeSender{})
	s.authed = true
	s.tenantID = "t"
	_ = s.Mail("a@b.com", nil)
	_ = s.Rcpt("c@d.com", nil)
	s.Reset()
	if !s.authed {
		t.Error("Reset must keep auth (pipelined messages)")
	}
	if s.from != "" || len(s.rcpts) != 0 {
		t.Error("Reset must clear the envelope")
	}
}

func TestMaxRecipientsEnforced(t *testing.T) {
	s := newSession(fakeVerifier{key: "k", tenant: "t"}, &fakeSender{})
	s.authed = true
	for i := 0; i < 3; i++ {
		if err := s.Rcpt("a@b.com", nil); err != nil {
			t.Fatalf("rcpt %d: %v", i, err)
		}
	}
	if err := s.Rcpt("over@b.com", nil); err == nil {
		t.Fatal("4th recipient should be rejected (max 3)")
	}
}

func TestDataPermanentVsTransient(t *testing.T) {
	// A permanent relay failure → 550 (client must NOT retry).
	sp := &fakeSender{err: errors.New("rejected"), permanent: true}
	s := newSession(fakeVerifier{key: "k", tenant: "t"}, sp)
	s.authed = true
	_ = s.Rcpt("a@b.com", nil)
	err := s.Data(strings.NewReader("x"))
	se, ok := err.(*smtp.SMTPError)
	if !ok || se.Code != 550 {
		t.Fatalf("permanent failure must be 550, got %v", err)
	}
	// A transient failure → 451 (retry).
	st := &fakeSender{err: errors.New("throttled"), permanent: false}
	s2 := newSession(fakeVerifier{key: "k", tenant: "t"}, st)
	s2.authed = true
	_ = s2.Rcpt("a@b.com", nil)
	err2 := s2.Data(strings.NewReader("x"))
	se2, ok2 := err2.(*smtp.SMTPError)
	if !ok2 || se2.Code != 451 {
		t.Fatalf("transient failure must be 451, got %v", err2)
	}
}

func TestDataNoRecipients(t *testing.T) {
	s := newSession(fakeVerifier{key: "k", tenant: "t"}, &fakeSender{})
	s.authed = true
	if err := s.Data(strings.NewReader("x")); err == nil {
		t.Fatal("Data with no recipients should fail")
	}
}
