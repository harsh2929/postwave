// SPDX-License-Identifier: AGPL-3.0-only
package webhook_retry

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// memStore is an in-memory Store for unit-testing the worker without
// pgx.
type memStore struct {
	mu     sync.Mutex
	rows   map[string]*Attempt
	nextID int
	now    func() time.Time
}

func newMemStore() *memStore {
	return &memStore{
		rows: map[string]*Attempt{},
		now:  func() time.Time { return time.Now().UTC() },
	}
}

func (m *memStore) clock() time.Time { return m.now() }

func (m *memStore) Enqueue(_ context.Context, eventID string, payload []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, r := range m.rows {
		if r.EventID == eventID && r.AttemptNumber == 0 {
			return nil // idempotent
		}
	}
	m.nextID++
	id := stringFromInt(m.nextID)
	now := m.clock()
	m.rows[id] = &Attempt{
		ID:            id,
		EventID:       eventID,
		PayloadJSON:   append([]byte(nil), payload...),
		AttemptNumber: 0,
		Status:        StatusPending,
		NextAttemptAt: now,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	return nil
}

func stringFromInt(i int) string {
	const digits = "0123456789"
	if i == 0 {
		return "0"
	}
	out := []byte{}
	for i > 0 {
		out = append([]byte{digits[i%10]}, out...)
		i /= 10
	}
	return string(out)
}

func (m *memStore) DequeueDue(_ context.Context, limit int) ([]Attempt, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.clock()
	var out []Attempt
	for _, r := range m.rows {
		if r.Status != StatusPending {
			continue
		}
		if r.NextAttemptAt.After(now) {
			continue
		}
		out = append(out, *r)
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func (m *memStore) MarkSucceeded(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok || r.Status != StatusPending {
		return errors.New("not found")
	}
	r.Status = StatusSucceeded
	r.UpdatedAt = m.clock()
	return nil
}

func (m *memStore) MarkFailed(_ context.Context, id string, errFromHandler error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok || r.Status != StatusPending {
		return errors.New("not found")
	}
	delay, dead := NextAttemptDelay(r.AttemptNumber)
	if dead {
		return errExhausted
	}
	r.AttemptNumber++
	r.NextAttemptAt = m.clock().Add(delay)
	if errFromHandler != nil {
		r.LastError = errFromHandler.Error()
	}
	r.UpdatedAt = m.clock()
	return nil
}

func (m *memStore) DeadLetter(_ context.Context, id string, finalErr error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok || r.Status != StatusPending {
		return errors.New("not found")
	}
	r.Status = StatusDeadLettered
	if finalErr != nil {
		r.LastError = finalErr.Error()
	}
	r.UpdatedAt = m.clock()
	return nil
}

func (m *memStore) ListByStatus(_ context.Context, status AttemptStatus, limit int) ([]Attempt, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Attempt
	for _, r := range m.rows {
		if r.Status == status {
			out = append(out, *r)
		}
		if len(out) >= limit {
			break
		}
	}
	return out, nil
}

func (m *memStore) Replay(_ context.Context, id string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[id]
	if !ok || r.Status != StatusDeadLettered {
		return "", errors.New("not dead-lettered")
	}
	m.nextID++
	newID := stringFromInt(m.nextID)
	now := m.clock()
	m.rows[newID] = &Attempt{
		ID:            newID,
		EventID:       r.EventID,
		PayloadJSON:   append([]byte(nil), r.PayloadJSON...),
		AttemptNumber: 0,
		Status:        StatusPending,
		NextAttemptAt: now,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	return newID, nil
}

// fakeHandler returns a fixed status code and counts hits.
type fakeHandler struct {
	code   int
	hits   int32
	bodies [][]byte
	mu     sync.Mutex
}

func (h *fakeHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	atomic.AddInt32(&h.hits, 1)
	h.mu.Lock()
	if r.Body != nil {
		buf := make([]byte, 4096)
		n, _ := r.Body.Read(buf)
		h.bodies = append(h.bodies, buf[:n])
	}
	h.mu.Unlock()
	w.WriteHeader(h.code)
}

type panicHandler struct{}

func (panicHandler) ServeHTTP(http.ResponseWriter, *http.Request) {
	panic("handler exploded")
}

type panicMailer struct {
	done chan<- struct{}
}

func (p panicMailer) SendDeadLetterAlert(context.Context, string, Attempt) error {
	select {
	case p.done <- struct{}{}:
	default:
	}
	panic("mailer exploded")
}

func TestWorkerHappyPath(t *testing.T) {
	store := newMemStore()
	if err := store.Enqueue(context.Background(), "evt_ok", []byte(`{"id":"evt_ok","type":"x"}`)); err != nil {
		t.Fatal(err)
	}
	h := &fakeHandler{code: http.StatusOK}
	w := NewWorker(store, h)
	w.RunOnce(context.Background())
	if got := atomic.LoadInt32(&h.hits); got != 1 {
		t.Fatalf("expected 1 hit, got %d", got)
	}
	rows, _ := store.ListByStatus(context.Background(), StatusSucceeded, 10)
	if len(rows) != 1 {
		t.Fatalf("expected 1 succeeded row, got %d", len(rows))
	}
}

func TestWorkerSchedulesNextAttemptOnFailure(t *testing.T) {
	store := newMemStore()
	if err := store.Enqueue(context.Background(), "evt_fail", []byte(`{"id":"evt_fail","type":"x"}`)); err != nil {
		t.Fatal(err)
	}
	h := &fakeHandler{code: http.StatusInternalServerError}
	w := NewWorker(store, h)
	w.RunOnce(context.Background())
	pending, _ := store.ListByStatus(context.Background(), StatusPending, 10)
	if len(pending) != 1 {
		t.Fatalf("expected 1 pending row after failure, got %d", len(pending))
	}
	if pending[0].AttemptNumber != 1 {
		t.Fatalf("expected attempt_number=1, got %d", pending[0].AttemptNumber)
	}
	if pending[0].LastError == "" {
		t.Fatalf("expected last_error to be set")
	}
}

func TestWorkerRecoversHandlerPanicAsRetryableFailure(t *testing.T) {
	store := newMemStore()
	if err := store.Enqueue(context.Background(), "evt_panic", []byte(`{"id":"evt_panic","type":"x"}`)); err != nil {
		t.Fatal(err)
	}
	w := NewWorker(store, panicHandler{})
	w.RunOnce(context.Background())
	pending, _ := store.ListByStatus(context.Background(), StatusPending, 10)
	if len(pending) != 1 {
		t.Fatalf("expected 1 pending row after handler panic, got %d", len(pending))
	}
	if pending[0].AttemptNumber != 1 {
		t.Fatalf("expected attempt_number=1, got %d", pending[0].AttemptNumber)
	}
	if !strings.Contains(pending[0].LastError, "handler panic: handler exploded") {
		t.Fatalf("last_error = %q; want recovered panic", pending[0].LastError)
	}
}

func TestWorkerDeadLettersAfterMaxAttempts(t *testing.T) {
	store := newMemStore()
	// Pre-seed a row already at attempt MaxAttempts so the next
	// failure exhausts the backoff schedule and dead-letters.
	// (attempt_number=MaxAttempts is the slot where
	// NextAttemptDelay returns dead=true.)
	store.mu.Lock()
	store.rows["1"] = &Attempt{
		ID:            "1",
		EventID:       "evt_doomed",
		PayloadJSON:   []byte(`{"id":"evt_doomed","type":"customer.subscription.created"}`),
		AttemptNumber: MaxAttempts,
		Status:        StatusPending,
		NextAttemptAt: time.Now().UTC().Add(-time.Hour),
		CreatedAt:     time.Now().UTC().Add(-time.Hour),
		UpdatedAt:     time.Now().UTC().Add(-time.Hour),
	}
	store.nextID = 1
	store.mu.Unlock()

	// Wire a failing handler.
	h := &fakeHandler{code: http.StatusInternalServerError}
	w := NewWorker(store, h)
	w.RunOnce(context.Background())

	// Should now be dead-lettered.
	rows, _ := store.ListByStatus(context.Background(), StatusDeadLettered, 10)
	if len(rows) != 1 {
		t.Fatalf("expected 1 dead-lettered row, got %d", len(rows))
	}
	if rows[0].EventID != "evt_doomed" {
		t.Fatalf("unexpected event id: %s", rows[0].EventID)
	}
}

func TestWorkerRecoversDeadLetterMailerPanic(t *testing.T) {
	store := newMemStore()
	store.mu.Lock()
	store.rows["1"] = &Attempt{
		ID:            "1",
		EventID:       "evt_mailer_panic",
		PayloadJSON:   []byte(`{"id":"evt_mailer_panic","type":"customer.subscription.created"}`),
		AttemptNumber: MaxAttempts,
		Status:        StatusPending,
		NextAttemptAt: time.Now().UTC().Add(-time.Hour),
		CreatedAt:     time.Now().UTC().Add(-time.Hour),
		UpdatedAt:     time.Now().UTC().Add(-time.Hour),
	}
	store.nextID = 1
	store.mu.Unlock()

	done := make(chan struct{}, 1)
	w := NewWorker(store, &fakeHandler{code: http.StatusInternalServerError})
	w.AlertEmail = "ops@example.com"
	w.Mailer = panicMailer{done: done}
	w.RunOnce(context.Background())
	select {
	case <-done:
		// If the mailer panic is not recovered, this test process exits
		// before reaching the assertion.
	case <-time.After(time.Second):
		t.Fatal("dead-letter mailer was not invoked")
	}
}

func TestWorkerSignsRequestWhenSecretConfigured(t *testing.T) {
	store := newMemStore()
	if err := store.Enqueue(context.Background(), "evt_sig", []byte(`{"id":"evt_sig","type":"x"}`)); err != nil {
		t.Fatal(err)
	}
	var seenSig string
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenSig = r.Header.Get("Stripe-Signature")
		w.WriteHeader(http.StatusOK)
	})
	w := NewWorker(store, h)
	w.SignerSecret = "whsec_unit"
	w.RunOnce(context.Background())
	if seenSig == "" {
		t.Fatalf("expected Stripe-Signature to be set when secret configured")
	}
	if seenSig[:2] != "t=" {
		t.Fatalf("signature missing t= prefix: %q", seenSig)
	}
}

func TestWorkerRunCancellable(t *testing.T) {
	store := newMemStore()
	h := &fakeHandler{code: http.StatusOK}
	w := NewWorker(store, h)
	w.Interval = 20 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		w.Run(ctx)
		close(done)
	}()
	time.Sleep(50 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not exit within 1s of cancel")
	}
}

func TestWorkerRunOnceDoesNotPanicOnNilStore(t *testing.T) {
	w := NewWorker(nil, &fakeHandler{code: 200})
	w.Run(context.Background())
}

func TestWorkerInvokeHandlerReturnsErrOnNon2xx(t *testing.T) {
	w := NewWorker(newMemStore(), http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "boom", http.StatusBadGateway)
	}))
	err := w.invokeHandler(context.Background(), Attempt{PayloadJSON: []byte("{}")})
	if err == nil {
		t.Fatal("expected error on 502")
	}
}

func TestWorkerInvokeHandlerSuccessOn2xx(t *testing.T) {
	w := NewWorker(newMemStore(), http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	if err := w.invokeHandler(context.Background(), Attempt{PayloadJSON: []byte("{}")}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// Sanity check: httptest.NewRecorder records non-2xx codes correctly.
// (Guarding against future Go std-lib changes.)
func TestRecorderCapturesNon2xx(t *testing.T) {
	rec := httptest.NewRecorder()
	rec.WriteHeader(http.StatusBadRequest)
	if rec.Code != 400 {
		t.Fatal("recorder broke")
	}
}
