// SPDX-License-Identifier: AGPL-3.0-only

package sending

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var (
	// ErrCapCoordinationUnavailable means a settings write or send admission
	// cannot reach the shared cap authority. Callers must fail closed: falling
	// back to a per-process cached/unlimited value would recreate the
	// cross-replica over-admission defect this coordinator closes.
	ErrCapCoordinationUnavailable = errors.New("sending: shared cap coordination unavailable")
	// ErrCapChangeInProgress means another settings request owns the tenant's
	// mutation fence. Retrying after that control request completes is safe.
	ErrCapChangeInProgress = errors.New("sending: cap change already in progress")
	// ErrCapStateCorrupt is deliberately terminal for an admission. An unknown
	// shared state must never be interpreted as uncapped.
	ErrCapStateCorrupt = errors.New("sending: shared cap state is invalid")
)

const (
	// CapMutationMaxDuration bounds an HTTP/control mutation after its Redis
	// fence is installed. It must stay strictly below the stale threshold so a
	// writer cannot continue its durable critical section after a reconciler is
	// allowed to reclaim an abandoned fence.
	CapMutationMaxDuration = 30 * time.Second
	// CapMutationFenceStaleAfter is the minimum age before an admission may try
	// to reconcile an abandoned fence under the same Postgres advisory lock as
	// every cap writer.
	CapMutationFenceStaleAfter = 2 * time.Minute
	// CapMutationAdvisoryLockSeed namespaces the tenant-scoped Postgres lock
	// shared by settings writes, automatic throttle writes, and stale-fence
	// reconciliation.
	CapMutationAdvisoryLockSeed int64 = 460046
)

// WithCapMutationDeadline bounds the lifetime of a control path after it is
// ready to install a shared fence. Every caller must use the returned context
// for Begin, all subsequent SQL/commit work, and the initial convergence call.
func WithCapMutationDeadline(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, CapMutationMaxDuration)
}

// CapChangeLease identifies one tenant-scoped mutation fence. Its fields are
// intentionally opaque to HTTP callers; only the coordinating limiter and its
// backend interpret them.
type CapChangeLease struct {
	TenantID     string
	Token        string
	EffectiveCap int
}

// CapReservation is the result of one atomic shared cap-read + counter update.
// HasCap=false means the authority explicitly recorded an uncapped tenant, not
// that coordination was absent.
type CapReservation struct {
	Allowed bool
	HasCap  bool
	Cap     int
	Count   int
	RetryAt time.Time
}

const (
	CapCoordinationStateReady  = "ready"
	CapCoordinationStateFenced = "conservatively_fenced"
	CapCoordinationStateDown   = "unavailable"
)

// CapCoordinationStatus is a tenant-safe shared-authority projection. It never
// exposes lease tokens. Callers compare Cap/HasCap to the durable settings row
// before treating a prior ambiguous write as recovered.
type CapCoordinationStatus struct {
	State          string
	Cap            int
	HasCap         bool
	FenceStartedAt *time.Time
}

// CapCoordinationBackend is the shared linearisation boundary used by every
// gateway replica. Reserve must read the current (or conservatively fenced)
// cap and increment its counter atomically. Begin/Commit/Abort form the control
// path's mutation fence around the durable settings transaction.
type CapCoordinationBackend interface {
	Start(ctx context.Context) error
	Initialize(ctx context.Context, tenantID string, cap int) error
	// Rehydrate force-publishes the canonical durable cap after the caller has
	// acquired the tenant Postgres cap-mutation lock. It is the recovery path
	// for missing/corrupt state and for a newly established Redis connection
	// whose snapshot has not yet been validated against PostgreSQL.
	Rehydrate(ctx context.Context, tenantID string, cap int) error
	Reserve(ctx context.Context, tenantID string, n int, window time.Duration, now time.Time) (CapReservation, error)
	Inspect(ctx context.Context, tenantID string, now time.Time) (CapCoordinationStatus, error)
	Begin(ctx context.Context, tenantID, token string, currentCap, targetCap int, now time.Time) error
	Commit(ctx context.Context, lease CapChangeLease, committedCap int, now time.Time) error
	Abort(ctx context.Context, lease CapChangeLease, durableCap int) error
	ReconcileStale(ctx context.Context, tenantID, token string, startedAt time.Time, durableCap int) error
	Close() error
}

// RedisCapScriptStore is implemented by middleware.RedisFixedWindowStore. The
// narrow interface keeps Redis protocol details out of the sending package and
// makes multi-replica behavior deterministic in unit tests.
type RedisCapScriptStore interface {
	EvalNamespacedString(ctx context.Context, script string, keys []string, args ...string) (string, error)
	ConnectionGeneration() uint64
	Close() error
}

const (
	redisCapKeyPrefix    = "cap:tenant:"
	redisSendCounterKey  = "sending:tenant:"
	redisCapLifecycleKey = "cap:lifecycle:"
)

// All cap state transitions and reservations are Lua-linearised. Ready state
// is `r:<cap>`; cap=0 explicitly means uncapped. An in-flight write is
// `u:<token>:<effective-cap>:<unix-ms>`. A commit that lost ownership installs
// replay-stable containment `c:<token>:<effective-cap>:<unix-ms>`; unlike an
// original u fence, replaying Commit can never finalize c into a ready value.
// effective-cap is the stricter of the pre-write and requested caps, so an
// ambiguous control outcome can restrict sending but can never admit above
// either cap.
// The startup probe deliberately exercises every Redis command family that
// cap admission depends on. Both probe keys are unique to this process and
// receive a TTL before any later command can fail; DEL makes the successful
// path immediately disposable while the TTL bounds debris from an ACL or
// READONLY failure halfway through the script.
const redisCapStartScript = `
local clock = redis.call('TIME')
redis.call('SET', KEYS[1], ARGV[1], 'EX', 30)
redis.call('SET', KEYS[2], '0', 'EX', 30)
local value = redis.call('GET', KEYS[1])
local count = redis.call('INCRBY', KEYS[2], 1)
redis.call('EXPIRE', KEYS[2], 30)
local ttl = redis.call('TTL', KEYS[2])
redis.call('DEL', KEYS[1], KEYS[2])
if not clock[1] or value ~= ARGV[1] or count ~= 1 or ttl < 1 then
  return 'invalid'
end
return 'ok'`

const redisCapInitializeScript = `
local current = redis.call('GET', KEYS[1])
if current then return 'exists' end
redis.call('SET', KEYS[1], 'r:' .. ARGV[1])
return 'ok'`

// Rehydrate is deliberately unconditional. Its caller owns the tenant's
// Postgres cap-mutation lock and read the canonical cap only after acquiring
// it, so any Redis value it replaces (missing, corrupt, ready, or fenced) is
// older than that durable decision. Keeping this separate from Initialize
// makes it impossible for an ordinary unlocked cold-path SETNX to masquerade
// as validation after a Redis reconnect or snapshot rollback.
const redisCapRehydrateScript = `
redis.call('SET', KEYS[1], 'r:' .. ARGV[1])
return 'ok'`

const redisCapReserveScript = `
local clock = redis.call('TIME')
local now_ms = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local state = redis.call('GET', KEYS[1])
if not state then return 'missing' end
local cap = string.match(state, '^r:(%d+)$')
if not cap then
  local phase, token, effective, started = string.match(state, '^([uc]):([0-9a-f]+):(%d+):(%d+)$')
  if token and now_ms - tonumber(started) >= tonumber(ARGV[3]) then
    return 'stale:' .. token .. ':' .. started
  end
  cap = effective
end
if not cap then return 'invalid' end
cap = tonumber(cap)
if cap == 0 then return 'uncapped' end
local count = redis.call('INCRBY', KEYS[2], ARGV[1])
if count == tonumber(ARGV[1]) then
  redis.call('EXPIRE', KEYS[2], ARGV[2])
end
local ttl = redis.call('TTL', KEYS[2])
if ttl < 0 then ttl = tonumber(ARGV[2]) end
return 'reserved:' .. count .. ':' .. ttl .. ':' .. cap`

const redisCapInspectScript = `
local clock = redis.call('TIME')
local now_ms = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local state = redis.call('GET', KEYS[1])
if not state then return 'missing' end
local ready = string.match(state, '^r:(%d+)$')
if ready then return 'ready:' .. ready end
local phase, token, effective, started = string.match(state, '^([uc]):([0-9a-f]+):(%d+):(%d+)$')
if not token then return 'invalid' end
if now_ms - tonumber(started) >= tonumber(ARGV[1]) then
  return 'stale:' .. token .. ':' .. started
end
return 'fenced:' .. effective .. ':' .. started`

const redisCapReconcileStaleScript = `
local state = redis.call('GET', KEYS[1])
if not state then return 'changed' end
local phase, owner, effective, started = string.match(state, '^([uc]):([0-9a-f]+):(%d+):(%d+)$')
if not owner then return 'changed' end
if owner ~= ARGV[1] or started ~= ARGV[2] then return 'changed' end
redis.call('SET', KEYS[1], 'r:' .. ARGV[3])
return 'ok'`

const redisCapBeginScript = `
local clock = redis.call('TIME')
local now_ms = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local function stricter(a, b)
  if a == 0 then return b end
  if b == 0 then return a end
  if a < b then return a end
  return b
end
local state = redis.call('GET', KEYS[1])
if not state then state = 'r:' .. ARGV[2] end
local phase, owner, existing_effective, existing_started = string.match(state, '^([uc]):([0-9a-f]+):(%d+):(%d+)$')
if owner then
  if phase == 'u' and owner == ARGV[1] then return 'ok' end
  if now_ms - tonumber(existing_started) >= tonumber(ARGV[4]) then
    return 'stale:' .. owner .. ':' .. existing_started
  end
  return 'busy'
end
local current = string.match(state, '^r:(%d+)$')
if not current then return 'invalid' end
-- The Postgres value in ARGV[2] was read only after taking the tenant cap
-- mutation lock and is therefore the canonical pre-write cap. Redis can be
-- tighter after a failover/restore or incomplete convergence, so preserve that
-- restriction too; it must never be allowed to make the fence looser than the
-- durable old value merely because a stale ready key says otherwise.
local effective = stricter(
  stricter(tonumber(current), tonumber(ARGV[2])),
  tonumber(ARGV[3])
)
redis.call('SET', KEYS[1], 'u:' .. ARGV[1] .. ':' .. effective .. ':' .. now_ms)
return 'ok'`

const redisCapCommitScript = `
local clock = redis.call('TIME')
local now_ms = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local function stricter(a, b)
  if a == 0 then return b end
  if b == 0 then return a end
  if a < b then return a end
  return b
end
local desired = 'r:' .. ARGV[2]
local state = redis.call('GET', KEYS[1])
if state == desired then return 'ok' end
local updating_owner = state and string.match(state, '^u:([0-9a-f]+):%d+:%d+$') or nil
if updating_owner == ARGV[1] then
  redis.call('SET', KEYS[1], desired)
  return 'ok'
end
-- A lost reply may cause the store to replay this script. Containment is a
-- distinct phase so the replay returns the same lost result and cannot turn
-- its own conservative fence into a ready (possibly wider) committed cap.
local containment_owner = state and string.match(state, '^c:([0-9a-f]+):%d+:%d+$') or nil
if containment_owner == ARGV[1] then return 'lost' end
-- The durable commit is already complete. If ownership was lost or the key
-- disappeared, never destroy a valid newer owner/value. Only a missing key
-- receives replay-stable containment using the stricter cap captured in the
-- lease before the database write.
if not state then
  local effective = stricter(tonumber(ARGV[2]), tonumber(ARGV[3]))
  redis.call('SET', KEYS[1], 'c:' .. ARGV[1] .. ':' .. effective .. ':' .. now_ms)
  return 'lost'
end
local ready = string.match(state, '^r:(%d+)$')
local foreign_phase, foreign_owner = string.match(state, '^([uc]):([0-9a-f]+):%d+:%d+$')
if ready or foreign_owner then return 'lost' end
return 'invalid'`

const redisCapAbortScript = `
local desired = 'r:' .. ARGV[2]
local state = redis.call('GET', KEYS[1])
if state == desired then return 'ok' end
local owner = state and string.match(state, '^[uc]:([0-9a-f]+):%d+:%d+$') or nil
if owner ~= ARGV[1] then return 'lost' end
redis.call('SET', KEYS[1], desired)
return 'ok'`

// RedisCapBackend implements the shared cap authority using the same Redis
// connection/namespace as the sending counter. It owns the supplied store and
// closes it when the limiter stops.
type RedisCapBackend struct {
	store RedisCapScriptStore

	mu sync.RWMutex
	// validated records the exact Redis connection generation on which each
	// tenant's state was derived from a canonical Postgres read (or installed
	// by Begin under that same Postgres lock). A reconnect makes every older
	// entry fail comparison without an O(n) invalidation pass.
	validated map[string]uint64
	started   bool
	closed    bool
}

const redisCapValidatedTenantLimit = 100_000

func NewRedisCapBackend(store RedisCapScriptStore) *RedisCapBackend {
	return &RedisCapBackend{store: store}
}

func (b *RedisCapBackend) Start(ctx context.Context) error {
	if b == nil || b.store == nil {
		return ErrCapCoordinationUnavailable
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return fmt.Errorf("%w: backend is closed", ErrCapCoordinationUnavailable)
	}
	if b.started {
		return nil
	}
	probeToken, err := newCapLeaseToken()
	if err != nil {
		return fmt.Errorf("%w: create startup probe: %v", ErrCapCoordinationUnavailable, err)
	}
	result, err := b.store.EvalNamespacedString(ctx, redisCapStartScript,
		[]string{
			redisCapLifecycleKey + probeToken + ":value",
			redisCapLifecycleKey + probeToken + ":counter",
		}, probeToken)
	if err != nil {
		return fmt.Errorf("%w: start: %v", ErrCapCoordinationUnavailable, err)
	}
	if result != "ok" {
		return fmt.Errorf("%w: startup probe returned %q", ErrCapStateCorrupt, result)
	}
	if generation := b.store.ConnectionGeneration(); generation == 0 {
		return fmt.Errorf("%w: startup probe completed without a Redis connection generation", ErrCapCoordinationUnavailable)
	}
	b.validated = make(map[string]uint64, 256)
	b.started = true
	return nil
}

func (b *RedisCapBackend) ready() error {
	if b == nil || b.store == nil {
		return ErrCapCoordinationUnavailable
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	if !b.started || b.closed {
		return ErrCapCoordinationUnavailable
	}
	return nil
}

// trustedGeneration returns the exact connection generation on which tenantID
// was last tied to a canonical Postgres cap. A syntactically valid r:<cap>
// value is not sufficient after a reconnect: it may have come from an older
// snapshot and could be looser than the durable setting.
func (b *RedisCapBackend) trustedGeneration(tenantID string) (uint64, error) {
	if err := b.ready(); err != nil {
		return 0, err
	}
	generation := b.store.ConnectionGeneration()
	if generation == 0 {
		return 0, ErrCapCoordinationUnavailable
	}
	b.mu.RLock()
	validated := b.validated[tenantID]
	b.mu.RUnlock()
	if validated != generation {
		return 0, errCapStateUntrusted
	}
	return generation, nil
}

func (b *RedisCapBackend) stableGeneration(before uint64) error {
	if before == 0 || b.store.ConnectionGeneration() != before {
		return errCapStateUntrusted
	}
	return nil
}

func (b *RedisCapBackend) markValidated(tenantID string, generation uint64) error {
	if strings.TrimSpace(tenantID) == "" || generation == 0 || b.store.ConnectionGeneration() != generation {
		return errCapStateUntrusted
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.started || b.closed || b.store.ConnectionGeneration() != generation {
		return errCapStateUntrusted
	}
	if b.validated == nil {
		b.validated = make(map[string]uint64, 256)
	}
	if _, exists := b.validated[tenantID]; !exists && len(b.validated) >= redisCapValidatedTenantLimit {
		// A full flush is conservative: every tenant is forced through the same
		// locked canonical rehydration again, while the map stays bounded under
		// tenant-ID spray.
		b.validated = make(map[string]uint64, 256)
	}
	b.validated[tenantID] = generation
	return nil
}

func (b *RedisCapBackend) Initialize(ctx context.Context, tenantID string, cap int) error {
	if err := b.ready(); err != nil {
		return err
	}
	generation := b.store.ConnectionGeneration()
	if generation == 0 {
		return ErrCapCoordinationUnavailable
	}
	result, err := b.store.EvalNamespacedString(ctx, redisCapInitializeScript,
		[]string{redisCapKeyPrefix + tenantID}, strconv.Itoa(normalizeCap(cap)))
	if err != nil {
		return fmt.Errorf("%w: initialize: %v", ErrCapCoordinationUnavailable, err)
	}
	if err := b.stableGeneration(generation); err != nil {
		return err
	}
	if result == "ok" {
		return b.markValidated(tenantID, generation)
	}
	if result == "exists" {
		// SETNX did not prove that the existing value belongs to this Redis
		// generation. The caller must acquire the Postgres lock and Rehydrate.
		return errCapStateUntrusted
	}
	if result != "ok" {
		return fmt.Errorf("%w: initialize returned %q", ErrCapStateCorrupt, result)
	}
	return nil
}

func (b *RedisCapBackend) Rehydrate(ctx context.Context, tenantID string, cap int) error {
	if err := b.ready(); err != nil {
		return err
	}
	// EvalNamespacedString can reconnect and replay internally. Sampling on
	// both sides prevents a successful write on connection B from being
	// credited to validation begun on connection A. Retry only from this
	// caller-held Postgres critical section.
	for attempt := 0; attempt < 3; attempt++ {
		generation := b.store.ConnectionGeneration()
		if generation == 0 {
			return ErrCapCoordinationUnavailable
		}
		result, err := b.store.EvalNamespacedString(ctx, redisCapRehydrateScript,
			[]string{redisCapKeyPrefix + tenantID}, strconv.Itoa(normalizeCap(cap)))
		if err != nil {
			return fmt.Errorf("%w: rehydrate: %v", ErrCapCoordinationUnavailable, err)
		}
		if err := b.stableGeneration(generation); err != nil {
			continue
		}
		if result != "ok" {
			return fmt.Errorf("%w: rehydrate returned %q", ErrCapStateCorrupt, result)
		}
		if err := b.markValidated(tenantID, generation); err != nil {
			continue
		}
		return nil
	}
	return fmt.Errorf("%w: Redis connection changed during rehydration", ErrCapCoordinationUnavailable)
}

func (b *RedisCapBackend) Reserve(
	ctx context.Context,
	tenantID string,
	n int,
	window time.Duration,
	now time.Time,
) (CapReservation, error) {
	generation, err := b.trustedGeneration(tenantID)
	if err != nil {
		return CapReservation{}, err
	}
	seconds := int(math.Ceil(window.Seconds()))
	if seconds < 1 {
		seconds = 1
	}
	result, err := b.store.EvalNamespacedString(ctx, redisCapReserveScript,
		[]string{redisCapKeyPrefix + tenantID, redisSendCounterKey + tenantID},
		strconv.Itoa(n), strconv.Itoa(seconds),
		strconv.FormatInt(CapMutationFenceStaleAfter.Milliseconds(), 10))
	if err != nil {
		return CapReservation{}, fmt.Errorf("%w: reserve: %v", ErrCapCoordinationUnavailable, err)
	}
	if err := b.stableGeneration(generation); err != nil {
		return CapReservation{}, err
	}
	switch result {
	case "missing":
		return CapReservation{}, errCapStateMissing
	case "invalid":
		return CapReservation{}, ErrCapStateCorrupt
	case "uncapped":
		return CapReservation{Allowed: true, HasCap: false}, nil
	}
	if strings.HasPrefix(result, "stale:") {
		parts := strings.Split(result, ":")
		if len(parts) != 3 {
			return CapReservation{}, fmt.Errorf("%w: reserve returned %q", ErrCapStateCorrupt, result)
		}
		startedAtMS, parseErr := strconv.ParseInt(parts[2], 10, 64)
		if parseErr != nil || startedAtMS < 1 {
			return CapReservation{}, fmt.Errorf("%w: reserve returned %q", ErrCapStateCorrupt, result)
		}
		return CapReservation{}, &staleCapStateError{
			token:     parts[1],
			startedAt: time.UnixMilli(startedAtMS).UTC(),
		}
	}
	parts := strings.Split(result, ":")
	if len(parts) != 4 || parts[0] != "reserved" {
		return CapReservation{}, fmt.Errorf("%w: reserve returned %q", ErrCapStateCorrupt, result)
	}
	count, countErr := strconv.Atoi(parts[1])
	ttl, ttlErr := strconv.Atoi(parts[2])
	cap, capErr := strconv.Atoi(parts[3])
	if countErr != nil || ttlErr != nil || capErr != nil || count < 0 || ttl < 0 || cap < 1 {
		return CapReservation{}, fmt.Errorf("%w: reserve returned %q", ErrCapStateCorrupt, result)
	}
	return CapReservation{
		Allowed: count <= cap,
		HasCap:  true,
		Cap:     cap,
		Count:   count,
		RetryAt: now.Add(time.Duration(ttl) * time.Second),
	}, nil
}

func (b *RedisCapBackend) Inspect(
	ctx context.Context,
	tenantID string,
	_ time.Time,
) (CapCoordinationStatus, error) {
	generation, err := b.trustedGeneration(tenantID)
	if err != nil {
		return CapCoordinationStatus{State: CapCoordinationStateDown}, err
	}
	result, err := b.store.EvalNamespacedString(ctx, redisCapInspectScript,
		[]string{redisCapKeyPrefix + tenantID},
		strconv.FormatInt(CapMutationFenceStaleAfter.Milliseconds(), 10))
	if err != nil {
		return CapCoordinationStatus{State: CapCoordinationStateDown},
			fmt.Errorf("%w: inspect: %v", ErrCapCoordinationUnavailable, err)
	}
	if err := b.stableGeneration(generation); err != nil {
		return CapCoordinationStatus{State: CapCoordinationStateDown}, err
	}
	if result == "missing" {
		return CapCoordinationStatus{}, errCapStateMissing
	}
	if result == "invalid" {
		return CapCoordinationStatus{State: CapCoordinationStateDown}, ErrCapStateCorrupt
	}
	parts := strings.Split(result, ":")
	if len(parts) == 2 && parts[0] == "ready" {
		cap, parseErr := strconv.Atoi(parts[1])
		if parseErr != nil || cap < 0 {
			return CapCoordinationStatus{State: CapCoordinationStateDown}, ErrCapStateCorrupt
		}
		return CapCoordinationStatus{State: CapCoordinationStateReady, Cap: cap, HasCap: cap > 0}, nil
	}
	if len(parts) == 3 && parts[0] == "fenced" {
		cap, capErr := strconv.Atoi(parts[1])
		startedMS, timeErr := strconv.ParseInt(parts[2], 10, 64)
		if capErr != nil || timeErr != nil || cap < 0 || startedMS < 1 {
			return CapCoordinationStatus{State: CapCoordinationStateDown}, ErrCapStateCorrupt
		}
		started := time.UnixMilli(startedMS).UTC()
		return CapCoordinationStatus{
			State: CapCoordinationStateFenced, Cap: cap, HasCap: cap > 0, FenceStartedAt: &started,
		}, nil
	}
	if len(parts) == 3 && parts[0] == "stale" {
		startedMS, parseErr := strconv.ParseInt(parts[2], 10, 64)
		if parseErr != nil || startedMS < 1 {
			return CapCoordinationStatus{State: CapCoordinationStateDown}, ErrCapStateCorrupt
		}
		return CapCoordinationStatus{}, &staleCapStateError{
			token: parts[1], startedAt: time.UnixMilli(startedMS).UTC(),
		}
	}
	return CapCoordinationStatus{State: CapCoordinationStateDown},
		fmt.Errorf("%w: inspect returned %q", ErrCapStateCorrupt, result)
}

func (b *RedisCapBackend) Begin(
	ctx context.Context,
	tenantID, token string,
	currentCap, targetCap int,
	_ time.Time,
) error {
	if err := b.ready(); err != nil {
		return err
	}
	generation := b.store.ConnectionGeneration()
	if generation == 0 {
		return ErrCapCoordinationUnavailable
	}
	result, err := b.store.EvalNamespacedString(ctx, redisCapBeginScript,
		[]string{redisCapKeyPrefix + tenantID}, token,
		strconv.Itoa(normalizeCap(currentCap)), strconv.Itoa(normalizeCap(targetCap)),
		strconv.FormatInt(CapMutationFenceStaleAfter.Milliseconds(), 10))
	if err != nil {
		return fmt.Errorf("%w: begin: %v", ErrCapCoordinationUnavailable, err)
	}
	if err := b.stableGeneration(generation); err != nil {
		return err
	}
	switch result {
	case "ok":
		return b.markValidated(tenantID, generation)
	case "busy":
		return ErrCapChangeInProgress
	case "invalid":
		return ErrCapStateCorrupt
	default:
		if strings.HasPrefix(result, "stale:") {
			parts := strings.Split(result, ":")
			if len(parts) == 3 {
				startedMS, parseErr := strconv.ParseInt(parts[2], 10, 64)
				if parseErr == nil && startedMS > 0 {
					return &staleCapStateError{
						token: parts[1], startedAt: time.UnixMilli(startedMS).UTC(),
					}
				}
			}
		}
		return fmt.Errorf("%w: begin returned %q", ErrCapStateCorrupt, result)
	}
}

func (b *RedisCapBackend) Commit(ctx context.Context, lease CapChangeLease, committedCap int, _ time.Time) error {
	generation, err := b.trustedGeneration(lease.TenantID)
	if err != nil {
		return err
	}
	result, err := b.store.EvalNamespacedString(ctx, redisCapCommitScript,
		[]string{redisCapKeyPrefix + lease.TenantID}, lease.Token,
		strconv.Itoa(normalizeCap(committedCap)), strconv.Itoa(normalizeCap(lease.EffectiveCap)))
	if err != nil {
		return fmt.Errorf("%w: commit: %v", ErrCapCoordinationUnavailable, err)
	}
	if err := b.stableGeneration(generation); err != nil {
		return err
	}
	if result == "ok" {
		return nil
	}
	if result == "lost" {
		return fmt.Errorf("%w: cap fence ownership lost after durable commit", ErrCapCoordinationUnavailable)
	}
	return fmt.Errorf("%w: commit returned %q", ErrCapStateCorrupt, result)
}

func (b *RedisCapBackend) Abort(ctx context.Context, lease CapChangeLease, durableCap int) error {
	generation, err := b.trustedGeneration(lease.TenantID)
	if err != nil {
		return err
	}
	result, err := b.store.EvalNamespacedString(ctx, redisCapAbortScript,
		[]string{redisCapKeyPrefix + lease.TenantID}, lease.Token,
		strconv.Itoa(normalizeCap(durableCap)))
	if err != nil {
		return fmt.Errorf("%w: abort: %v", ErrCapCoordinationUnavailable, err)
	}
	if err := b.stableGeneration(generation); err != nil {
		return err
	}
	if result == "ok" {
		return nil
	}
	if result == "lost" {
		return fmt.Errorf("%w: cap fence ownership lost while aborting", ErrCapCoordinationUnavailable)
	}
	return fmt.Errorf("%w: abort returned %q", ErrCapStateCorrupt, result)
}

func (b *RedisCapBackend) ReconcileStale(
	ctx context.Context,
	tenantID, token string,
	startedAt time.Time,
	durableCap int,
) error {
	generation, err := b.trustedGeneration(tenantID)
	if err != nil {
		return err
	}
	result, err := b.store.EvalNamespacedString(ctx, redisCapReconcileStaleScript,
		[]string{redisCapKeyPrefix + tenantID}, token,
		strconv.FormatInt(startedAt.UnixMilli(), 10), strconv.Itoa(normalizeCap(durableCap)))
	if err != nil {
		return fmt.Errorf("%w: reconcile stale fence: %v", ErrCapCoordinationUnavailable, err)
	}
	if err := b.stableGeneration(generation); err != nil {
		return err
	}
	if result == "ok" || result == "changed" {
		return nil
	}
	return fmt.Errorf("%w: reconcile stale fence returned %q", ErrCapStateCorrupt, result)
}

func (b *RedisCapBackend) Close() error {
	if b == nil {
		return nil
	}
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return nil
	}
	b.closed = true
	b.started = false
	b.validated = nil
	store := b.store
	b.mu.Unlock()
	if store == nil {
		return nil
	}
	return store.Close()
}

var (
	errCapStateMissing   = errors.New("sending: shared cap state missing")
	errCapStateUntrusted = errors.New("sending: shared cap state is untrusted for this Redis connection")
)

type staleCapStateError struct {
	token     string
	startedAt time.Time
}

func (e *staleCapStateError) Error() string {
	return "sending: shared cap mutation fence is stale"
}

func normalizeCap(cap int) int {
	if cap < 1 {
		return 0
	}
	return cap
}

func stricterCap(a, b int) int {
	a = normalizeCap(a)
	b = normalizeCap(b)
	if a == 0 {
		return b
	}
	if b == 0 || a < b {
		return a
	}
	return b
}

func newCapLeaseToken() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("sending: cap lease token: %w", err)
	}
	return hex.EncodeToString(raw[:]), nil
}

// CapMutationReceiptDigest returns the non-secret correlation value persisted
// with a durable cap mutation. The random Redis owner token itself must never
// enter audit metadata or durable plaintext storage.
func CapMutationReceiptDigest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return fmt.Sprintf("%x", sum[:])
}

// RecordCapMutationReceipt writes the exact proof used to classify a client
// error from PostgreSQL COMMIT. It must run in the same transaction as the cap,
// its domain lifecycle row, and its canonical audit record.
func RecordCapMutationReceipt(
	ctx context.Context,
	tx pgx.Tx,
	lease CapChangeLease,
	committedCap *int,
	settingsUpdatedAt time.Time,
) error {
	if tx == nil || strings.TrimSpace(lease.TenantID) == "" || strings.TrimSpace(lease.Token) == "" ||
		settingsUpdatedAt.IsZero() {
		return errors.New("sending: invalid cap mutation receipt")
	}
	_, err := tx.Exec(ctx, `
INSERT INTO tenant_sending_cap_mutation_receipts
    (tenant_id, mutation_sha256, committed_cap, settings_updated_at)
VALUES ($1::uuid, $2, $3, $4)`,
		lease.TenantID, CapMutationReceiptDigest(lease.Token), committedCap, settingsUpdatedAt)
	if err != nil {
		return fmt.Errorf("sending: write cap mutation receipt: %w", err)
	}
	return nil
}

// CapMutationCommitted waits for the same tenant advisory lock as the
// uncertain writer before reading its exact receipt. Acquiring that lock proves
// the original server-side transaction has resolved; a readable absence can
// therefore be treated as rolled back without racing a late COMMIT.
func CapMutationCommitted(
	ctx context.Context,
	pool *db.Pool,
	tenantID, token string,
) (bool, error) {
	if pool == nil || strings.TrimSpace(tenantID) == "" || strings.TrimSpace(token) == "" {
		return false, errors.New("sending: cap mutation receipt lookup is unavailable")
	}
	tx, err := db.WithTenantOptions(ctx, pool, tenantID, CapMutationTxOptions())
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := LockCapMutation(ctx, tx, tenantID); err != nil {
		return false, err
	}
	var committed bool
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1
      FROM tenant_sending_cap_mutation_receipts
     WHERE tenant_id = $1::uuid
       AND mutation_sha256 = $2
)`, tenantID, CapMutationReceiptDigest(token)).Scan(&committed); err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return committed, nil
}

// CapMutationTxOptions pins every transaction participating in the
// Postgres-lock/Redis-CAS protocol to READ COMMITTED. db.WithTenant binds RLS
// with a SELECT before callers can take the advisory lock; under a connection
// whose default is REPEATABLE READ that SELECT would establish a pre-lock
// snapshot. A waiter could then acquire the lock after the prior writer commits
// yet still miss its exact receipt or rehydrate Redis from the older, wider cap.
func CapMutationTxOptions() pgx.TxOptions {
	return pgx.TxOptions{IsoLevel: pgx.ReadCommitted, AccessMode: pgx.ReadWrite}
}

// StartCapCoordination attaches and probes the shared authority before the
// limiter is exposed to send workers or settings routes. A started backend is
// retained after Close so late admissions fail closed instead of silently
// reverting to the legacy per-process cache.
func (t *TieredRateLimiter) StartCapCoordination(ctx context.Context, backend CapCoordinationBackend) error {
	if t == nil || backend == nil {
		return ErrCapCoordinationUnavailable
	}
	if err := backend.Start(ctx); err != nil {
		_ = backend.Close()
		return err
	}
	t.coordMu.Lock()
	defer t.coordMu.Unlock()
	if t.capCoord != nil {
		_ = backend.Close()
		return errors.New("sending: cap coordination already started")
	}
	t.capCoord = backend
	return nil
}

func (t *TieredRateLimiter) capCoordinator() CapCoordinationBackend {
	if t == nil {
		return nil
	}
	t.coordMu.RLock()
	defer t.coordMu.RUnlock()
	return t.capCoord
}

// LockCapMutation takes the tenant-scoped Postgres transaction lock shared by
// every durable max_sends_per_hour writer and stale-fence reconciliation. The
// Redis exact-token CAS must run while this lock is held; otherwise a paused
// writer could commit immediately after its fence was reclaimed.
func LockCapMutation(ctx context.Context, tx pgx.Tx, tenantID string) error {
	if tx == nil {
		return errors.New("sending: nil cap mutation transaction")
	}
	if _, err := tx.Exec(ctx, `
SELECT pg_advisory_xact_lock(hashtextextended($1::text, $2))`,
		tenantID, CapMutationAdvisoryLockSeed); err != nil {
		return fmt.Errorf("sending: acquire cap mutation lock: %w", err)
	}
	return nil
}

func (t *TieredRateLimiter) reconcileStaleCap(
	ctx context.Context,
	tenantID string,
	stale *staleCapStateError,
) error {
	coordinator := t.capCoordinator()
	if coordinator == nil || stale == nil {
		return ErrCapCoordinationUnavailable
	}
	if t.staleCapReconciler != nil {
		return t.staleCapReconciler(ctx, tenantID, stale, coordinator)
	}
	if t.Pool == nil {
		return fmt.Errorf("%w: stale-fence database is unavailable", ErrCapCoordinationUnavailable)
	}
	tx, err := db.WithTenantOptions(ctx, t.Pool, tenantID, CapMutationTxOptions())
	if err != nil {
		return fmt.Errorf("%w: begin stale-fence reconciliation: %v", ErrCapCoordinationUnavailable, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := LockCapMutation(ctx, tx, tenantID); err != nil {
		return err
	}
	var cap int
	var hasCap bool
	err = tx.QueryRow(ctx, `
SELECT COALESCE(max_sends_per_hour, 0), max_sends_per_hour IS NOT NULL
  FROM tenant_sending_settings
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&cap, &hasCap)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: read durable cap during reconciliation: %v", ErrCapCoordinationUnavailable, err)
	}
	if errors.Is(err, pgx.ErrNoRows) || !hasCap {
		cap = 0
	}
	// Keep the Postgres mutation lock through the exact Redis token+timestamp
	// CAS. A concurrent writer can neither be in its durable critical section
	// nor commit behind this reconciliation.
	if err := coordinator.ReconcileStale(ctx, tenantID, stale.token, stale.startedAt, cap); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("%w: commit stale-fence reconciliation: %v", ErrCapCoordinationUnavailable, err)
	}
	return nil
}

// initializeMissingCap rehydrates missing, corrupt, or connection-untrusted
// Redis authority state while holding the same tenant Postgres lock as every
// durable writer. It rechecks Redis after acquiring the lock: a state already
// validated by another waiter wins; otherwise the canonical cap read beneath
// this lock safely replaces any older ready/fenced/corrupt snapshot value.
func (t *TieredRateLimiter) initializeMissingCap(
	ctx context.Context,
	tenantID string,
	coordinator CapCoordinationBackend,
) error {
	if coordinator == nil {
		return ErrCapCoordinationUnavailable
	}
	if t.missingCapInitializer != nil {
		return t.missingCapInitializer(ctx, tenantID, coordinator)
	}
	if t.Pool == nil {
		return fmt.Errorf("%w: missing-state database is unavailable", ErrCapCoordinationUnavailable)
	}
	tx, err := db.WithTenantOptions(ctx, t.Pool, tenantID, CapMutationTxOptions())
	if err != nil {
		return fmt.Errorf("%w: begin missing-state rehydration: %v", ErrCapCoordinationUnavailable, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := LockCapMutation(ctx, tx, tenantID); err != nil {
		return err
	}

	_, inspectErr := coordinator.Inspect(ctx, tenantID, time.Now().UTC())
	if inspectErr == nil {
		return tx.Commit(ctx)
	}
	var stale *staleCapStateError
	if !errors.Is(inspectErr, errCapStateMissing) &&
		!errors.Is(inspectErr, errCapStateUntrusted) &&
		!errors.Is(inspectErr, ErrCapStateCorrupt) &&
		!errors.As(inspectErr, &stale) {
		return inspectErr
	}
	var cap int
	var hasCap bool
	err = tx.QueryRow(ctx, `
SELECT COALESCE(max_sends_per_hour, 0), max_sends_per_hour IS NOT NULL
  FROM tenant_sending_settings
 WHERE tenant_id = $1::uuid`, tenantID).Scan(&cap, &hasCap)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: read durable cap during rehydration: %v", ErrCapCoordinationUnavailable, err)
	}
	if errors.Is(err, pgx.ErrNoRows) || !hasCap {
		cap = 0
	}
	if err := coordinator.Rehydrate(ctx, tenantID, cap); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("%w: commit missing-state rehydration: %v", ErrCapCoordinationUnavailable, err)
	}
	return nil
}

// Close stops the shared cap authority. It is safe to call repeatedly. The
// limiter deliberately keeps the stopped backend attached so a late Try is
// denied rather than served from stale local state during shutdown.
func (t *TieredRateLimiter) Close() error {
	coordinator := t.capCoordinator()
	if coordinator == nil {
		return nil
	}
	return coordinator.Close()
}

// BeginCapChangeLocked is the only supported durable-writer entry point. The
// caller must read durable from this exact transaction after acquiring the
// tenant cap lock. Reusing the transaction also lets stale-fence recovery avoid
// a self-deadlock through a second connection.
func (t *TieredRateLimiter) BeginCapChangeLocked(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	durable, target *int,
) (CapChangeLease, error) {
	coordinator := t.capCoordinator()
	if coordinator == nil {
		return CapChangeLease{}, ErrCapCoordinationUnavailable
	}
	if err := LockCapMutation(ctx, tx, tenantID); err != nil {
		return CapChangeLease{}, err
	}
	token, err := newCapLeaseToken()
	if err != nil {
		return CapChangeLease{}, err
	}
	lease := CapChangeLease{
		TenantID: tenantID, Token: token,
		EffectiveCap: stricterCap(capPointerValue(durable), capPointerValue(target)),
	}
	for attempt := 0; attempt < 3; attempt++ {
		beginErr := coordinator.Begin(
			ctx, tenantID, token, capPointerValue(durable), capPointerValue(target), time.Now().UTC(),
		)
		var stale *staleCapStateError
		if errors.As(beginErr, &stale) {
			// tx still owns the shared tenant mutation lock and durable was read
			// beneath it, so the Redis CAS can safely reclaim this exact fence
			// without recursively opening another Postgres transaction.
			if reconcileErr := coordinator.ReconcileStale(
				ctx, tenantID, stale.token, stale.startedAt, capPointerValue(durable),
			); reconcileErr != nil {
				if !errors.Is(reconcileErr, errCapStateUntrusted) {
					return CapChangeLease{}, reconcileErr
				}
				// A stale value can be the first tenant state observed after
				// process start/reconnect. ReconcileStale correctly refuses an
				// unvalidated generation; because this transaction already owns
				// the Postgres lock, an unconditional canonical rehydrate is the
				// safe bootstrap and avoids recursively taking the same lock.
				if rehydrateErr := coordinator.Rehydrate(
					ctx, tenantID, capPointerValue(durable),
				); rehydrateErr != nil {
					return CapChangeLease{}, rehydrateErr
				}
			}
			continue
		}
		if errors.Is(beginErr, errCapStateUntrusted) || errors.Is(beginErr, ErrCapStateCorrupt) {
			// The caller already owns the tenant Postgres mutation lock and durable
			// was read beneath it. Repair in-place; opening initializeMissingCap
			// here would take the same advisory lock on a second connection and
			// self-deadlock.
			if rehydrateErr := coordinator.Rehydrate(
				ctx, tenantID, capPointerValue(durable),
			); rehydrateErr != nil {
				return CapChangeLease{}, rehydrateErr
			}
			continue
		}
		if beginErr != nil {
			return CapChangeLease{}, beginErr
		}
		return lease, nil
	}
	return CapChangeLease{}, ErrCapCoordinationUnavailable
}

// CommitCapChange publishes the canonical committed cap and releases the
// mutation fence. The backend contains the committed cap conservatively before
// returning any ambiguous ownership error.
func (t *TieredRateLimiter) CommitCapChange(
	ctx context.Context,
	lease CapChangeLease,
	committed *int,
) error {
	coordinator := t.capCoordinator()
	if coordinator == nil {
		return ErrCapCoordinationUnavailable
	}
	if err := coordinator.Commit(ctx, lease, capPointerValue(committed), time.Now().UTC()); err != nil {
		return err
	}
	t.InvalidateCapCache(lease.TenantID)
	return nil
}

// AbortCapChange restores the database's still-durable cap after a rejected or
// failed settings write. If the authoritative read or Redis restoration fails,
// the conservative in-flight fence remains active and callers receive an
// explicit coordination error.
func (t *TieredRateLimiter) AbortCapChange(ctx context.Context, lease CapChangeLease) error {
	coordinator := t.capCoordinator()
	if coordinator == nil {
		return ErrCapCoordinationUnavailable
	}
	durableCap, hasCap, err := t.resolveCap(ctx, lease.TenantID)
	if err != nil {
		return fmt.Errorf("%w: resolve abort cap: %v", ErrCapCoordinationUnavailable, err)
	}
	if !hasCap {
		durableCap = 0
	}
	return coordinator.Abort(ctx, lease, durableCap)
}

// InspectCapCoordination returns only a state read from the shared authority.
// A missing key is atomically initialized from the durable cap and inspected
// again; a stale fence is reconciled under the Postgres mutation lock first.
// Callers must still compare the returned explicit cap to their already-read
// durable settings row before declaring recovery.
func (t *TieredRateLimiter) InspectCapCoordination(
	ctx context.Context,
	tenantID string,
) (CapCoordinationStatus, error) {
	coordinator := t.capCoordinator()
	if coordinator == nil {
		return CapCoordinationStatus{State: CapCoordinationStateDown}, ErrCapCoordinationUnavailable
	}
	for attempt := 0; attempt < 3; attempt++ {
		status, err := coordinator.Inspect(ctx, tenantID, time.Now().UTC())
		if errors.Is(err, errCapStateMissing) ||
			errors.Is(err, errCapStateUntrusted) ||
			errors.Is(err, ErrCapStateCorrupt) {
			if initErr := t.initializeMissingCap(ctx, tenantID, coordinator); initErr != nil {
				return CapCoordinationStatus{State: CapCoordinationStateDown}, initErr
			}
			continue
		}
		var stale *staleCapStateError
		if errors.As(err, &stale) {
			if reconcileErr := t.reconcileStaleCap(ctx, tenantID, stale); reconcileErr != nil {
				return CapCoordinationStatus{State: CapCoordinationStateDown}, reconcileErr
			}
			continue
		}
		if err != nil {
			return CapCoordinationStatus{State: CapCoordinationStateDown}, err
		}
		return status, nil
	}
	return CapCoordinationStatus{State: CapCoordinationStateDown}, ErrCapCoordinationUnavailable
}

func capPointerValue(cap *int) int {
	if cap == nil {
		return 0
	}
	return normalizeCap(*cap)
}
