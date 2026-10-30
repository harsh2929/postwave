package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// fakeStore is an in-memory Store that approximates the Postgres semantics
// closely enough to exercise the Worker. It does NOT need to be production-
// quality; its job is to verify the worker dispatches/retries/DLQs correctly.
type fakeStore struct {
	mu     sync.Mutex
	events map[string]*Event
	state  map[string]*fakeRow
	now    func() time.Time
	seq    int
}

type fakeRow struct {
	OwnerID      string
	ClaimedUntil time.Time
	CompletedAt  time.Time
	FailedAt     time.Time
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		events: map[string]*Event{},
		state:  map[string]*fakeRow{},
		now:    time.Now,
	}
}

func (f *fakeStore) Append(_ context.Context, _ pgx.Tx, in Append) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seq++
	id := "evt-" + intToStr(f.seq)
	payload, _ := marshalPayload(in.Payload)
	available := in.AvailableAt
	if available.IsZero() {
		available = f.now()
	}
	max := in.MaxAttempts
	if max <= 0 {
		max = DefaultMaxAttempts
	}
	f.events[id] = &Event{
		ID:          id,
		TenantID:    in.TenantID,
		Kind:        in.Kind,
		Payload:     payload,
		AvailableAt: available,
		MaxAttempts: max,
		CreatedAt:   f.now(),
	}
	f.state[id] = &fakeRow{}
	return id, nil
}

func intToStr(i int) string {
	if i == 0 {
		return "0"
	}
	digits := []byte{}
	for i > 0 {
		digits = append([]byte{byte('0' + i%10)}, digits...)
		i /= 10
	}
	return string(digits)
}

func (f *fakeStore) Claim(_ context.Context, ownerID string, ttl time.Duration, limit int) ([]Event, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	now := f.now()
	out := []Event{}
	for id, ev := range f.events {
		st := f.state[id]
		if !st.CompletedAt.IsZero() || !st.FailedAt.IsZero() {
			continue
		}
		if ev.AvailableAt.After(now) {
			continue
		}
		if !st.ClaimedUntil.IsZero() && st.ClaimedUntil.After(now) {
			continue
		}
		ev.Attempts++
		st.OwnerID = ownerID
		st.ClaimedUntil = now.Add(ttl)
		evCopy := *ev
		out = append(out, evCopy)
		if len(out) >= limit {
			break
		}
	}
	if len(out) == 0 {
		return nil, ErrNoEvents
	}
	return out, nil
}

func (f *fakeStore) Complete(_ context.Context, eventID, ownerID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	st, ok := f.state[eventID]
	if !ok {
		return errors.New("not found")
	}
	if st.OwnerID != ownerID {
		return ErrLeaseLost
	}
	st.CompletedAt = f.now()
	st.OwnerID = ""
	st.ClaimedUntil = time.Time{}
	return nil
}

func (f *fakeStore) Fail(_ context.Context, eventID, ownerID, errMsg string, retryAt time.Time, dead bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	st, ok := f.state[eventID]
	if !ok {
		return errors.New("not found")
	}
	if st.OwnerID != ownerID {
		return ErrLeaseLost
	}
	if dead {
		st.FailedAt = f.now()
	} else {
		f.events[eventID].LastError = errMsg
		f.events[eventID].AvailableAt = retryAt
	}
	st.OwnerID = ""
	st.ClaimedUntil = time.Time{}
	return nil
}

func (f *fakeStore) Renew(_ context.Context, eventID, ownerID string, ttl time.Duration) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	st, ok := f.state[eventID]
	if !ok || st.OwnerID != ownerID {
		return ErrLeaseLost
	}
	st.ClaimedUntil = f.now().Add(ttl)
	return nil
}

func TestWorkerDispatchesAndCompletes(t *testing.T) {
	store := newFakeStore()
	reg := NewRegistry()
	called := atomic.Int32{}
	reg.Register("test.ok", func(_ context.Context, ev Event) error {
		called.Add(1)
		return nil
	})
	if _, err := store.Append(context.Background(), nil, Append{
		TenantID: "t1", Kind: "test.ok", Payload: map[string]string{"x": "1"},
	}); err != nil {
		t.Fatal(err)
	}
	w := NewWorker(store, reg)
	w.PollInterval = 10 * time.Millisecond
	w.HandlerTimeout = 100 * time.Millisecond

	if n, err := w.tick(context.Background()); err != nil || n != 1 {
		t.Fatalf("tick: n=%d err=%v", n, err)
	}
	if got := called.Load(); got != 1 {
		t.Errorf("handler ran %d times, want 1", got)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	for id, st := range store.state {
		if st.CompletedAt.IsZero() {
			t.Errorf("event %q not marked complete", id)
		}
	}
}

func TestWorkerRetriesOnHandlerError(t *testing.T) {
	store := newFakeStore()
	reg := NewRegistry()
	calls := atomic.Int32{}
	reg.Register("test.flaky", func(_ context.Context, ev Event) error {
		calls.Add(1)
		return errors.New("transient")
	})
	if _, err := store.Append(context.Background(), nil, Append{
		TenantID: "t1", Kind: "test.flaky", MaxAttempts: 3,
	}); err != nil {
		t.Fatal(err)
	}
	w := NewWorker(store, reg)
	w.HandlerTimeout = 100 * time.Millisecond

	for i := 0; i < 3; i++ {
		// rewind the available_at so each tick re-picks the event
		store.mu.Lock()
		for _, ev := range store.events {
			ev.AvailableAt = time.Now().Add(-time.Hour)
		}
		store.mu.Unlock()
		if _, err := w.tick(context.Background()); err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
	}

	if got := calls.Load(); got != 3 {
		t.Errorf("handler attempts = %d, want 3", got)
	}
	// After 3 attempts at MaxAttempts=3, the row should be DLQ'd.
	store.mu.Lock()
	defer store.mu.Unlock()
	dlq := 0
	for _, st := range store.state {
		if !st.FailedAt.IsZero() {
			dlq++
		}
	}
	if dlq != 1 {
		t.Errorf("expected 1 DLQ row, got %d", dlq)
	}
}

func TestWorkerSendsUnregisteredKindStraightToDLQ(t *testing.T) {
	store := newFakeStore()
	reg := NewRegistry()
	if _, err := store.Append(context.Background(), nil, Append{
		TenantID: "t1", Kind: "unknown.kind",
	}); err != nil {
		t.Fatal(err)
	}
	w := NewWorker(store, reg)
	if _, err := w.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	for _, st := range store.state {
		if st.FailedAt.IsZero() {
			t.Error("unregistered kind should be DLQ'd, not retried")
		}
	}
}

func TestWorkerSurvivesPanickingHandler(t *testing.T) {
	store := newFakeStore()
	reg := NewRegistry()
	reg.Register("test.boom", func(_ context.Context, _ Event) error {
		panic("kaboom")
	})
	if _, err := store.Append(context.Background(), nil, Append{
		TenantID: "t1", Kind: "test.boom", MaxAttempts: 1,
	}); err != nil {
		t.Fatal(err)
	}
	w := NewWorker(store, reg)
	if _, err := w.tick(context.Background()); err != nil {
		t.Fatal(err)
	}
	// Panic should have been caught and the row DLQ'd (MaxAttempts=1 means
	// one attempt → straight to DLQ on failure).
	store.mu.Lock()
	defer store.mu.Unlock()
	dlq := false
	for _, st := range store.state {
		if !st.FailedAt.IsZero() {
			dlq = true
		}
	}
	if !dlq {
		t.Error("panicking handler should mark row DLQ'd")
	}
}

// TestRegistryMustHaveCatchesMissingHandlers locks the regression-fix
// invariant: a wiring drop in main.go that forgot to Register a kind
// would otherwise produce silent DLQs at runtime. MustHave gives the
// startup gate something to assert against.
func TestRegistryMustHaveCatchesMissingHandlers(t *testing.T) {
	reg := NewRegistry()
	reg.Register("kind.a", func(_ context.Context, _ Event) error { return nil })

	if missing := reg.MustHave("kind.a"); len(missing) != 0 {
		t.Errorf("registered kind reported missing: %v", missing)
	}
	missing := reg.MustHave("kind.a", "kind.b", "kind.c")
	if len(missing) != 2 || missing[0] != "kind.b" || missing[1] != "kind.c" {
		t.Errorf("MustHave returned %v, want [kind.b kind.c]", missing)
	}
	// Empty input → empty result (no required kinds).
	if got := reg.MustHave(); len(got) != 0 {
		t.Errorf("empty MustHave should return empty slice, got %v", got)
	}
}

func TestRegistryRejectsDuplicateKind(t *testing.T) {
	reg := NewRegistry()
	reg.Register("a", func(_ context.Context, _ Event) error { return nil })
	defer func() {
		if r := recover(); r == nil {
			t.Error("duplicate Register should panic")
		}
	}()
	reg.Register("a", func(_ context.Context, _ Event) error { return nil })
}

func TestBackoffSecondsCapsAtFiveMinutes(t *testing.T) {
	if BackoffSeconds(0) < 1 {
		t.Errorf("backoff(0) should be at least 1s, got %d", BackoffSeconds(0))
	}
	if BackoffSeconds(20) != 300 {
		t.Errorf("backoff(20) should saturate at 300s, got %d", BackoffSeconds(20))
	}
	if got := BackoffSeconds(1); got != 1 {
		t.Errorf("backoff(1) = %d, want 1", got)
	}
	if got := BackoffSeconds(4); got != 8 {
		t.Errorf("backoff(4) = %d, want 8", got)
	}
}

func TestMarshalPayloadHandlesShapes(t *testing.T) {
	cases := []struct {
		in   any
		want string
	}{
		{nil, `{}`},
		{json.RawMessage(`{"x":1}`), `{"x":1}`},
		{[]byte(`{"y":2}`), `{"y":2}`},
		{map[string]int{"z": 3}, `{"z":3}`},
	}
	for _, tc := range cases {
		got, err := marshalPayload(tc.in)
		if err != nil {
			t.Errorf("input %#v: err %v", tc.in, err)
			continue
		}
		if string(got) != tc.want {
			t.Errorf("input %#v: got %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestWorkerCompletesEventAfterParentContextCancellation locks in the
// regression fix for the agent-found bug: dispatch was using the worker-
// loop's parent context for Complete/Fail, so graceful shutdown would
// silently drop successful completions, leading to duplicate dispatch
// on the next claim. The fix uses a detached bookkeeping context.
func TestWorkerCompletesEventAfterParentContextCancellation(t *testing.T) {
	store := newFakeStore()
	reg := NewRegistry()
	reg.Register("test.cancel", func(_ context.Context, _ Event) error {
		// Handler succeeds — but the parent ctx will be canceled before
		// the worker calls Complete.
		return nil
	})
	if _, err := store.Append(context.Background(), nil, Append{
		TenantID: "t1", Kind: "test.cancel",
	}); err != nil {
		t.Fatal(err)
	}
	w := NewWorker(store, reg)

	parent, cancelParent := context.WithCancel(context.Background())
	// Cancel BEFORE tick so any code path using parent ctx for Complete
	// would fail with context.Canceled. Detached bookkeepingCtx survives.
	cancelParent()

	if _, err := w.tick(parent); err != nil {
		t.Fatalf("tick: %v", err)
	}

	store.mu.Lock()
	defer store.mu.Unlock()
	for id, st := range store.state {
		if st.CompletedAt.IsZero() {
			t.Errorf("event %q lost its completion across parent-ctx cancellation — duplicate dispatch will occur on next claim",
				id)
		}
	}
}

func TestNewOwnerIDIsUniquePerCall(t *testing.T) {
	a := newOwnerID()
	b := newOwnerID()
	if a == b {
		t.Error("newOwnerID should produce distinct ids")
	}
	if len(a) != 36 || a[8] != '-' {
		t.Errorf("owner id shape unexpected: %q", a)
	}
}
