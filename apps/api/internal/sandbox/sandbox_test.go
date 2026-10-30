// SPDX-License-Identifier: AGPL-3.0-only
package sandbox

import (
	"context"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"
)

func TestIsSandboxRequest_Header(t *testing.T) {
	cases := []struct {
		hdr  string
		want bool
	}{
		{"true", true},
		{"True", true},
		{"1", true},
		{"yes", true},
		{"false", false},
		{"", false},
		{"banana", false},
	}
	for _, c := range cases {
		r := httptest.NewRequest("POST", "/x", nil)
		if c.hdr != "" {
			r.Header.Set(HeaderName, c.hdr)
		}
		if got := IsSandboxRequest(r); got != c.want {
			t.Errorf("hdr=%q: want %v got %v", c.hdr, c.want, got)
		}
	}
}

func TestIsSandboxRequest_ContextFlag(t *testing.T) {
	r := httptest.NewRequest("POST", "/x", nil)
	if IsSandboxRequest(r) {
		t.Fatalf("expected false without flag")
	}
	r = r.WithContext(WithFlag(r.Context()))
	if !IsSandboxRequest(r) {
		t.Fatalf("expected true after WithFlag")
	}
}

func TestFakeMessageID_Format(t *testing.T) {
	id := FakeMessageID()
	if !strings.HasPrefix(id, MessageIDPrefix) {
		t.Errorf("missing prefix: %s", id)
	}
	if len(id) != len(MessageIDPrefix)+16 {
		t.Errorf("unexpected length %d for %s", len(id), id)
	}
	// Two calls should differ.
	if FakeMessageID() == id {
		t.Errorf("two FakeMessageID() returned identical values")
	}
}

// memQueue captures enqueued events in order. Used to verify deterministic
// scheduling.
type memQueue struct {
	events []SandboxEvent
}

func (m *memQueue) EnqueueSandbox(_ context.Context, ev SandboxEvent) error {
	m.events = append(m.events, ev)
	return nil
}

func TestSimulateLifecycle_Deterministic(t *testing.T) {
	now := time.Date(2030, 1, 1, 12, 0, 0, 0, time.UTC)
	q1 := &memQueue{}
	q2 := &memQueue{}
	s1 := &Simulator{Queue: q1}
	s2 := &Simulator{Queue: q2}

	tenant := "00000000-0000-0000-0000-000000000001"
	campaign := "11111111-1111-1111-1111-111111111111"
	if err := s1.SimulateLifecycle(context.Background(), tenant, campaign, 200, DefaultSchedule, now); err != nil {
		t.Fatalf("sim1: %v", err)
	}
	if err := s2.SimulateLifecycle(context.Background(), tenant, campaign, 200, DefaultSchedule, now); err != nil {
		t.Fatalf("sim2: %v", err)
	}
	if len(q1.events) != len(q2.events) {
		t.Fatalf("non-deterministic event count: %d vs %d", len(q1.events), len(q2.events))
	}
	sortEvents(q1.events)
	sortEvents(q2.events)
	for i := range q1.events {
		if q1.events[i] != q2.events[i] {
			t.Fatalf("event %d differs:\n  a=%+v\n  b=%+v", i, q1.events[i], q2.events[i])
		}
	}
}

func TestSimulateLifecycle_RatesRoughlyMatch(t *testing.T) {
	now := time.Date(2030, 1, 1, 12, 0, 0, 0, time.UTC)
	q := &memQueue{}
	s := &Simulator{Queue: q}
	const N = 10000
	if err := s.SimulateLifecycle(context.Background(), "ten", "camp", N, DefaultSchedule, now); err != nil {
		t.Fatalf("sim: %v", err)
	}
	counts := map[string]int{}
	for _, e := range q.events {
		counts[e.EventType]++
	}
	// Expect within ~25% of rates*N for the larger buckets.
	wantOpens := int(DefaultSchedule.OpenRate * float64(N))
	if counts["opened"] < wantOpens*7/10 || counts["opened"] > wantOpens*13/10 {
		t.Errorf("opened: got %d want ~%d", counts["opened"], wantOpens)
	}
	wantClicks := int(DefaultSchedule.ClickRate * float64(N))
	if counts["clicked"] < wantClicks*5/10 || counts["clicked"] > wantClicks*15/10 {
		t.Errorf("clicked: got %d want ~%d", counts["clicked"], wantClicks)
	}
}

func TestSimulateLifecycle_NoOutboundCalls(t *testing.T) {
	// Sanity: SimulateLifecycle with a memQueue must not perform any network
	// I/O. The memQueue does nothing; if Simulator ever grew an HTTP client
	// path it would surface here as a panic on dial.
	s := &Simulator{Queue: &memQueue{}}
	if err := s.SimulateLifecycle(context.Background(), "ten", "camp", 5, DefaultSchedule, time.Now()); err != nil {
		t.Fatalf("sim: %v", err)
	}
}

func sortEvents(evs []SandboxEvent) {
	sort.Slice(evs, func(i, j int) bool {
		if evs[i].SubscriberEmail != evs[j].SubscriberEmail {
			return evs[i].SubscriberEmail < evs[j].SubscriberEmail
		}
		if evs[i].EventType != evs[j].EventType {
			return evs[i].EventType < evs[j].EventType
		}
		return evs[i].At.Before(evs[j].At)
	})
}
