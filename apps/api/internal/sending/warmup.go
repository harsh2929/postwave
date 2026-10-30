package sending

import (
	"context"
	"sync"
	"time"
)

// WarmupSchedule encodes a 30-day IP warmup curve. Index 0 is Day 1.
//
// The curve is the canonical ESP ramp: start tiny, double-ish each day until
// you hit a steady-state daily volume. Once a tenant exceeds Day 30, we cap
// at the tier's contracted daily limit (passed to EnforceCap explicitly).
//
// Source: Postmark + SparkPost warmup guides; SES recommends a similar curve.
var WarmupSchedule = []int{
	50,        // Day 1
	100,       // Day 2
	500,       // Day 3
	1_000,     // Day 4
	2_000,     // Day 5
	5_000,     // Day 6
	10_000,    // Day 7
	20_000,    // Day 8
	40_000,    // Day 9
	75_000,    // Day 10
	100_000,   // Day 11
	150_000,   // Day 12
	200_000,   // Day 13
	250_000,   // Day 14
	300_000,   // Day 15
	350_000,   // Day 16
	400_000,   // Day 17
	450_000,   // Day 18
	500_000,   // Day 19
	600_000,   // Day 20
	700_000,   // Day 21
	800_000,   // Day 22
	900_000,   // Day 23
	1_000_000, // Day 24
	1_100_000, // Day 25
	1_200_000, // Day 26
	1_300_000, // Day 27
	1_400_000, // Day 28
	1_500_000, // Day 29
	2_000_000, // Day 30
}

// CapForDay returns the daily volume cap for the given 1-indexed warmup day,
// bounded by tierLimit. Passing day <= 0 returns 0 (warmup not started).
// Passing day > len(WarmupSchedule) returns tierLimit when configured, or
// the terminal schedule cap when tierLimit is zero.
func CapForDay(day, tierLimit int) int {
	if day <= 0 {
		return 0
	}
	if day > len(WarmupSchedule) {
		if tierLimit <= 0 {
			return WarmupSchedule[len(WarmupSchedule)-1]
		}
		return tierLimit
	}
	cap := WarmupSchedule[day-1]
	if tierLimit > 0 && cap > tierLimit {
		return tierLimit
	}
	return cap
}

// WarmupState is the persisted projection used by EnforceCap.
type WarmupState struct {
	TenantID        string
	WarmupStartedAt time.Time
	WarmupDay       int
	// DailySent maps "YYYY-MM-DD" → count already sent today.
	DailySent map[string]int
	TierLimit int
}

// WarmupTracker persists per-tenant warmup state. The gateway uses
// PostgresWarmupTracker; MemoryWarmupTracker satisfies tests and local fallback.
type WarmupTracker interface {
	Get(ctx context.Context, tenantID string) (*WarmupState, error)
	// RecordSends bumps the day's counter by n and updates warmup_day if a
	// new day has started.
	RecordSends(ctx context.Context, tenantID string, n int, at time.Time) error
	// Start marks warmup as started today.
	Start(ctx context.Context, tenantID string, at time.Time, tierLimit int) error
}

// MemoryWarmupTracker is the in-process tracker used by tests + dev.
type MemoryWarmupTracker struct {
	mu     sync.Mutex
	states map[string]*WarmupState
}

// NewMemoryWarmupTracker constructs an empty tracker.
func NewMemoryWarmupTracker() *MemoryWarmupTracker {
	return &MemoryWarmupTracker{states: map[string]*WarmupState{}}
}

func (m *MemoryWarmupTracker) Get(ctx context.Context, tenantID string) (*WarmupState, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.states[tenantID]
	if !ok {
		return nil, nil
	}
	cp := *st
	cp.DailySent = make(map[string]int, len(st.DailySent))
	for k, v := range st.DailySent {
		cp.DailySent[k] = v
	}
	return &cp, nil
}

func (m *MemoryWarmupTracker) Start(ctx context.Context, tenantID string, at time.Time, tierLimit int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.states[tenantID] = &WarmupState{
		TenantID:        tenantID,
		WarmupStartedAt: at,
		WarmupDay:       1,
		DailySent:       map[string]int{},
		TierLimit:       tierLimit,
	}
	return nil
}

func (m *MemoryWarmupTracker) RecordSends(ctx context.Context, tenantID string, n int, at time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.states[tenantID]
	if !ok {
		return nil
	}
	day := dayKey(at)
	if st.DailySent == nil {
		st.DailySent = map[string]int{}
	}
	st.DailySent[day] += n
	// Refresh warmup_day from start date.
	st.WarmupDay = daysSince(st.WarmupStartedAt, at)
	return nil
}

// EnforceCap caps intended sends to today's allowed volume. Returns the
// allowed count plus the deferred remainder. The caller is expected to:
//   - send `allowed` immediately,
//   - re-enqueue `deferred` for tomorrow (or fail loud, depending on policy).
func EnforceCap(
	ctx context.Context,
	tracker WarmupTracker,
	tenantID string,
	intended int,
	now time.Time,
) (allowed int, deferred int, err error) {
	st, err := tracker.Get(ctx, tenantID)
	if err != nil {
		return 0, intended, err
	}
	if st == nil {
		// No warmup row yet → caller must call Start first.
		return 0, intended, nil
	}
	day := daysSince(st.WarmupStartedAt, now)
	cap := CapForDay(day, st.TierLimit)
	already := st.DailySent[dayKey(now)]
	remaining := cap - already
	if remaining < 0 {
		remaining = 0
	}
	if intended <= remaining {
		allowed = intended
	} else {
		allowed = remaining
	}
	deferred = intended - allowed
	if allowed > 0 {
		if err := tracker.RecordSends(ctx, tenantID, allowed, now); err != nil {
			return 0, intended, err
		}
	}
	return allowed, deferred, nil
}

func dayKey(t time.Time) string {
	return t.UTC().Format("2006-01-02")
}

// daysSince returns the 1-indexed warmup day. Day 1 = the start date itself.
func daysSince(start, now time.Time) int {
	if start.IsZero() {
		return 0
	}
	s := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, time.UTC)
	n := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	d := int(n.Sub(s).Hours()/24) + 1
	if d < 1 {
		return 0
	}
	return d
}
