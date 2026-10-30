// SPDX-License-Identifier: AGPL-3.0-only
//
// Send-path tests for the win-back worker's per-subscriber decision
// logic (deliverOne). These use a fake mailer + in-memory test seams so
// they run with no live Postgres — they exercise: e-mail is queued via
// the platform mailer, suppression is respected, consent is respected,
// and the cooldown is enforced.

package retention_offers

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/mailer"
)

// fakeMailer records every Send. Satisfies mailer.Mailer.
type fakeMailer struct {
	mu   sync.Mutex
	sent []mailer.Message
	err  error
}

func (m *fakeMailer) Send(_ context.Context, msg mailer.Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.err != nil {
		return m.err
	}
	m.sent = append(m.sent, msg)
	return nil
}

func (m *fakeMailer) count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.sent)
}

// fakeSuppression / fakeConsent are static gates.
type fakeSuppression struct{ suppressed map[string]bool }

func (f fakeSuppression) Check(_ context.Context, _, email string) (bool, error) {
	return f.suppressed[email], nil
}

type fakeConsent struct{ denied map[string]bool }

func (f fakeConsent) Allowed(_ context.Context, _, email, _ string) (bool, error) {
	return !f.denied[email], nil
}

// newSendTestWorker builds a worker whose DB seams are in-memory: the
// cooldown set + recorded sends + shown events live in maps so we can
// assert on them without a database.
func newSendTestWorker(m mailer.Mailer) (*WinbackWorker, *sendState) {
	st := &sendState{cooldown: map[string]bool{}}
	w := &WinbackWorker{
		Mailer:        m,
		From:          "Moosewave <win@moosewave.com>",
		PortalBaseURL: "https://portal.example.com",
		Suppressions:  fakeSuppression{suppressed: map[string]bool{}},
		Consent:       fakeConsent{denied: map[string]bool{}},
		cooldownFn: func(_ context.Context, _, email string) (bool, error) {
			return st.cooldown[email], nil
		},
		recordFn: func(_ context.Context, _, _, email, source string, risk float64) error {
			st.mu.Lock()
			defer st.mu.Unlock()
			st.recorded = append(st.recorded, email)
			st.cooldown[email] = true // a recorded send starts the cooldown
			return nil
		},
		shownFn: func(_ context.Context, _, _, email string) error {
			st.mu.Lock()
			defer st.mu.Unlock()
			st.shown = append(st.shown, email)
			return nil
		},
	}
	return w, st
}

type sendState struct {
	mu       sync.Mutex
	cooldown map[string]bool
	recorded []string
	shown    []string
}

func testOffer() Offer { return Offer{ID: "off_1", Headline: "Stay", Body: "Please"} }

func TestDeliverOneSendsEmailAndRecords(t *testing.T) {
	t.Parallel()
	m := &fakeMailer{}
	w, st := newSendTestWorker(m)
	ok, err := w.deliverOne(context.Background(), "t1", testOffer(), "25% off",
		ChurnCrosser{Email: "User@Example.com", Source: "engagement", Risk: 0.9})
	if err != nil || !ok {
		t.Fatalf("deliverOne = (%v, %v), want (true, nil)", ok, err)
	}
	if m.count() != 1 {
		t.Fatalf("mailer sent %d, want 1", m.count())
	}
	if m.sent[0].To != "user@example.com" {
		t.Fatalf("recipient lower-cased? got %q", m.sent[0].To)
	}
	if len(st.recorded) != 1 || len(st.shown) != 1 {
		t.Fatalf("recorded=%v shown=%v, want one each", st.recorded, st.shown)
	}
}

func TestDeliverOneRespectsSuppression(t *testing.T) {
	t.Parallel()
	m := &fakeMailer{}
	w, st := newSendTestWorker(m)
	w.Suppressions = fakeSuppression{suppressed: map[string]bool{"blocked@example.com": true}}
	ok, err := w.deliverOne(context.Background(), "t1", testOffer(), "25% off",
		ChurnCrosser{Email: "blocked@example.com", Source: "engagement", Risk: 0.9})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if ok {
		t.Fatal("suppressed subscriber should be skipped (ok=false)")
	}
	if m.count() != 0 {
		t.Fatalf("mailer sent %d to a suppressed address, want 0", m.count())
	}
	if len(st.recorded) != 0 {
		t.Fatalf("recorded a send for a suppressed address: %v", st.recorded)
	}
}

func TestDeliverOneRespectsConsent(t *testing.T) {
	t.Parallel()
	m := &fakeMailer{}
	w, _ := newSendTestWorker(m)
	w.Consent = fakeConsent{denied: map[string]bool{"noconsent@example.com": true}}
	ok, err := w.deliverOne(context.Background(), "t1", testOffer(), "25% off",
		ChurnCrosser{Email: "noconsent@example.com", Source: "engagement", Risk: 0.9})
	if err != nil || ok {
		t.Fatalf("deliverOne = (%v, %v), want (false, nil) for non-consented", ok, err)
	}
	if m.count() != 0 {
		t.Fatalf("mailer sent %d to non-consented address, want 0", m.count())
	}
}

func TestDeliverOneEnforcesCooldown(t *testing.T) {
	t.Parallel()
	m := &fakeMailer{}
	w, st := newSendTestWorker(m)
	c := ChurnCrosser{Email: "repeat@example.com", Source: "engagement", Risk: 0.9}
	// First send goes out and starts the cooldown.
	if ok, err := w.deliverOne(context.Background(), "t1", testOffer(), "25% off", c); err != nil || !ok {
		t.Fatalf("first deliverOne = (%v, %v)", ok, err)
	}
	// Second send within the cooldown window must be skipped — no second
	// e-mail. This is the "safe to run repeatedly" / no-spam guarantee.
	ok, err := w.deliverOne(context.Background(), "t1", testOffer(), "25% off", c)
	if err != nil {
		t.Fatalf("second deliverOne err = %v", err)
	}
	if ok {
		t.Fatal("second send within cooldown should be skipped")
	}
	if m.count() != 1 {
		t.Fatalf("mailer sent %d, want 1 (cooldown blocks the second)", m.count())
	}
	if len(st.recorded) != 1 {
		t.Fatalf("recorded %d sends, want 1", len(st.recorded))
	}
}

func TestDeliverOneNoMailerFailsClosed(t *testing.T) {
	t.Parallel()
	w, st := newSendTestWorker(nil)
	ok, err := w.deliverOne(context.Background(), "t1", testOffer(), "25% off",
		ChurnCrosser{Email: "a@example.com", Source: "engagement", Risk: 0.9})
	if err == nil || ok {
		t.Fatalf("deliverOne = (%v, %v), want (false, err) with nil mailer", ok, err)
	}
	if len(st.recorded) != 0 {
		t.Fatalf("should not record a send when nothing was mailed: %v", st.recorded)
	}
}

func TestDeliverOneMailerErrorDoesNotRecord(t *testing.T) {
	t.Parallel()
	m := &fakeMailer{err: errors.New("ses down")}
	w, st := newSendTestWorker(m)
	ok, err := w.deliverOne(context.Background(), "t1", testOffer(), "25% off",
		ChurnCrosser{Email: "a@example.com", Source: "engagement", Risk: 0.9})
	if err == nil || ok {
		t.Fatalf("deliverOne = (%v, %v), want (false, err) on mailer failure", ok, err)
	}
	// No cooldown marker on a failed send — the next tick must be free to
	// retry.
	if len(st.recorded) != 0 {
		t.Fatalf("recorded a send despite mailer failure: %v", st.recorded)
	}
}

func TestDeliverOneNoPortalBaseFailsClosed(t *testing.T) {
	t.Parallel()
	m := &fakeMailer{}
	w, _ := newSendTestWorker(m)
	w.PortalBaseURL = ""
	ok, err := w.deliverOne(context.Background(), "t1", testOffer(), "25% off",
		ChurnCrosser{Email: "a@example.com", Source: "engagement", Risk: 0.9})
	if err == nil || ok {
		t.Fatalf("deliverOne = (%v, %v), want (false, err) with no portal base", ok, err)
	}
	if m.count() != 0 {
		t.Fatalf("sent %d with no portal link, want 0", m.count())
	}
}

func TestDeliverOneMissingSafetyGateFailsClosed(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name   string
		mutate func(*WinbackWorker)
	}{
		{name: "suppression", mutate: func(w *WinbackWorker) { w.Suppressions = nil }},
		{name: "consent", mutate: func(w *WinbackWorker) { w.Consent = nil }},
	} {
		t.Run(test.name, func(t *testing.T) {
			m := &fakeMailer{}
			w, st := newSendTestWorker(m)
			test.mutate(w)
			ok, err := w.deliverOne(context.Background(), "t1", testOffer(), "25% off",
				ChurnCrosser{Email: "a@example.com", Source: "engagement", Risk: 0.9})
			if err == nil || ok {
				t.Fatalf("deliverOne = (%v, %v), want (false, err)", ok, err)
			}
			if m.count() != 0 || len(st.recorded) != 0 || len(st.shown) != 0 {
				t.Fatalf("missing safety gate had side effects: sent=%d recorded=%v shown=%v", m.count(), st.recorded, st.shown)
			}
		})
	}
}
