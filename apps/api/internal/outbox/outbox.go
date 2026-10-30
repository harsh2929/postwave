// SPDX-License-Identifier: AGPL-3.0-only
//
// Package outbox implements the transactional-outbox pattern for the API
// gateway: callers Append an Event inside the same pgx tx that mutates
// business state, and a Worker drains the rows and dispatches them to
// kind-specific Handlers.
//
// Why outbox vs. fire-and-forget HTTP / channels?
//
//	Without an outbox, every "after we commit, also call Listmonk / send
//	email / dispatch webhook" path is independently lossy: the tx commits,
//	the goroutine panics or the process restarts, and the side effect
//	silently doesn't happen. The forms double-opt-in confirm bug is a
//	canonical example.
//
//	With an outbox, the side effect ROW is part of the tx. Either the row
//	is durable and the handler runs (eventually, on this or another
//	instance), or the tx never committed and the row never existed.
//
// Concurrency: workers claim rows via FOR UPDATE SKIP LOCKED with a per-
// row lease (claimed_by, claimed_until). Multi-instance deployments split
// the queue automatically; worker death frees rows after lease expiry.
// Same pattern as services/migration/internal/jobstore for the same
// reason.
package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Event is the in-memory shape of an outbox row. Payload is opaque JSON;
// each handler decodes it according to its own contract.
type Event struct {
	ID          string
	TenantID    string
	Kind        string
	Payload     json.RawMessage
	AvailableAt time.Time
	Attempts    int
	MaxAttempts int
	LastError   string
	CreatedAt   time.Time
}

// Append is the construction shape callers pass to Repo.Append. Defaults:
//
//	AvailableAt zero        → now (run ASAP)
//	MaxAttempts zero        → DefaultMaxAttempts
type Append struct {
	TenantID    string
	Kind        string
	Payload     any
	AvailableAt time.Time
	MaxAttempts int
}

// DefaultMaxAttempts caps how many times an event will retry before being
// parked in the dead-letter (failed_at) state. ~10 retries with exponential
// backoff covers ~17 minutes of transient outage.
const DefaultMaxAttempts = 10

// DefaultClaimBatch is how many events Worker.tick claims per cycle.
const DefaultClaimBatch = 16

// DefaultLeaseTTL is how long a worker may hold a claimed row before it
// must Complete/Fail/Renew. Worker death is bounded by this.
const DefaultLeaseTTL = 60 * time.Second

// DefaultPollInterval is how often the worker polls for new work.
const DefaultPollInterval = 2 * time.Second

// ErrNoEvents is returned by Repo.Claim when no work is available.
var ErrNoEvents = errors.New("outbox: no claimable events")

// HandlerFunc handles a single dequeued event. Return:
//
//	nil           → mark completed
//	non-nil error → bounce back with attempts+1, exponential backoff,
//	                 unless attempts >= MaxAttempts (then DLQ)
type HandlerFunc func(ctx context.Context, ev Event) error

// Registry routes events to handlers by kind. Concurrency-safe to read
// after Register; Register itself is not safe to call once a Worker is
// started.
type Registry struct {
	handlers map[string]HandlerFunc
}

// NewRegistry constructs an empty Registry.
func NewRegistry() *Registry {
	return &Registry{handlers: map[string]HandlerFunc{}}
}

// Register binds kind → fn. Panics on duplicate kind so silent overrides
// are impossible.
func (r *Registry) Register(kind string, fn HandlerFunc) {
	if _, dup := r.handlers[kind]; dup {
		panic(fmt.Sprintf("outbox: duplicate handler for kind %q", kind))
	}
	r.handlers[kind] = fn
}

// Lookup returns the handler for kind, or false.
func (r *Registry) Lookup(kind string) (HandlerFunc, bool) {
	fn, ok := r.handlers[kind]
	return fn, ok
}

// MustHave verifies every kind in `required` has a registered handler.
// Returns the missing kinds (empty slice = all present). Callers
// typically panic at startup if any are missing — a kind written to the
// outbox but with no handler quietly DLQs every event of that kind, which
// looks like the feature is just broken with no audit trail. The
// forms-confirm DOI flow is the canonical example: a missing handler
// would silently re-introduce the audit's #1 user-visible bug.
//
// Usage:
//
//	missing := registry.MustHave(forms.OutboxKindEnableListmonk, ...)
//	if len(missing) > 0 { return fmt.Errorf("outbox kinds missing handlers: %v", missing) }
func (r *Registry) MustHave(required ...string) []string {
	var missing []string
	for _, k := range required {
		if _, ok := r.handlers[k]; !ok {
			missing = append(missing, k)
		}
	}
	return missing
}

// BackoffSeconds returns the next-attempt delay for an event that has
// already been tried `attempts` times. Exponential with jitter-free cap
// at 5 minutes — keeps logs deterministic, and the cap is far short of
// the lease TTL so a stuck handler doesn't starve other rows.
func BackoffSeconds(attempts int) int {
	if attempts < 1 {
		return 1
	}
	// 1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300, …
	delay := 1 << uint(attempts-1)
	if delay > 300 || delay < 0 {
		return 300
	}
	return delay
}
