// SPDX-License-Identifier: AGPL-3.0-only

package sending

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type fakeRedisCapScriptStore struct {
	mu                sync.Mutex
	result            string
	results           []string
	err               error
	scripts           []string
	keys              [][]string
	args              [][]string
	closed            int
	generation        uint64
	advanceGeneration bool
}

type replayingCommitStore struct {
	state string
}

func (s *replayingCommitStore) EvalNamespacedString(
	_ context.Context,
	script string,
	_ []string,
	args ...string,
) (string, error) {
	if script != redisCapCommitScript || len(args) != 3 {
		return "", errors.New("unexpected replaying commit store call")
	}
	token, committed, effective := args[0], args[1], args[2]
	desired := "r:" + committed
	if s.state == desired {
		return "ok", nil
	}
	if strings.HasPrefix(s.state, "u:"+token+":") {
		s.state = desired
		return "ok", nil
	}
	if strings.HasPrefix(s.state, "c:"+token+":") {
		return "lost", nil
	}
	if s.state == "" {
		s.state = "c:" + token + ":" + effective + ":1"
		return "lost", nil
	}
	if strings.HasPrefix(s.state, "r:") || strings.HasPrefix(s.state, "u:") ||
		strings.HasPrefix(s.state, "c:") {
		return "lost", nil
	}
	return "invalid", nil
}

func (*replayingCommitStore) Close() error { return nil }

func (*replayingCommitStore) ConnectionGeneration() uint64 { return 1 }

func (s *fakeRedisCapScriptStore) EvalNamespacedString(
	_ context.Context,
	script string,
	keys []string,
	args ...string,
) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.scripts = append(s.scripts, script)
	s.keys = append(s.keys, append([]string(nil), keys...))
	s.args = append(s.args, append([]string(nil), args...))
	if s.advanceGeneration {
		s.generation++
		s.advanceGeneration = false
	}
	result := s.result
	if len(s.results) != 0 {
		result = s.results[0]
		s.results = s.results[1:]
	}
	return result, s.err
}

func (s *fakeRedisCapScriptStore) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed++
	return nil
}

func (s *fakeRedisCapScriptStore) ConnectionGeneration() uint64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation == 0 {
		return 1
	}
	return s.generation
}

type fakeSharedCapHub struct {
	mu          sync.Mutex
	states      map[string]fakeSharedCapState
	counters    map[string]fakeSharedCounter
	unavailable bool
}

type fakeSharedCapState struct {
	cap       int
	token     string
	startedAt time.Time
	corrupt   bool
}

type fakeSharedCounter struct {
	count   int
	resetAt time.Time
}

type fakeSharedCapClient struct {
	hub            *fakeSharedCapHub
	mu             sync.Mutex
	started        bool
	closed         bool
	initializeErr  error
	beginHook      func()
	rehydrateCalls int
}

// fakeCapMutationTx embeds the remaining pgx.Tx surface and implements only
// the advisory-lock Exec used by BeginCapChangeLocked. A wait channel lets the
// ordering test model a writer queued behind another transaction's tenant
// guard without needing a live database.
type fakeCapMutationTx struct {
	pgx.Tx
	onLock func()
	wait   <-chan struct{}
}

func (tx *fakeCapMutationTx) Exec(
	_ context.Context,
	_ string,
	_ ...any,
) (pgconn.CommandTag, error) {
	if tx.onLock != nil {
		tx.onLock()
	}
	if tx.wait != nil {
		<-tx.wait
	}
	return pgconn.NewCommandTag("SELECT 1"), nil
}

func newFakeSharedCapClient(hub *fakeSharedCapHub) *fakeSharedCapClient {
	return &fakeSharedCapClient{hub: hub}
}

func (c *fakeSharedCapClient) Start(context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed || c.hub == nil {
		return ErrCapCoordinationUnavailable
	}
	c.started = true
	return nil
}

func (c *fakeSharedCapClient) check() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.started || c.closed || c.hub == nil {
		return ErrCapCoordinationUnavailable
	}
	return nil
}

func (c *fakeSharedCapClient) Initialize(_ context.Context, tenantID string, cap int) error {
	if err := c.check(); err != nil {
		return err
	}
	if c.initializeErr != nil {
		return c.initializeErr
	}
	c.hub.mu.Lock()
	defer c.hub.mu.Unlock()
	if c.hub.unavailable {
		return ErrCapCoordinationUnavailable
	}
	if c.hub.states == nil {
		c.hub.states = make(map[string]fakeSharedCapState)
	}
	if _, exists := c.hub.states[tenantID]; !exists {
		c.hub.states[tenantID] = fakeSharedCapState{cap: normalizeCap(cap)}
	}
	return nil
}

func (c *fakeSharedCapClient) Rehydrate(_ context.Context, tenantID string, cap int) error {
	if err := c.check(); err != nil {
		return err
	}
	if c.initializeErr != nil {
		return c.initializeErr
	}
	c.mu.Lock()
	c.rehydrateCalls++
	c.mu.Unlock()
	c.hub.mu.Lock()
	defer c.hub.mu.Unlock()
	if c.hub.unavailable {
		return ErrCapCoordinationUnavailable
	}
	if c.hub.states == nil {
		c.hub.states = make(map[string]fakeSharedCapState)
	}
	c.hub.states[tenantID] = fakeSharedCapState{cap: normalizeCap(cap)}
	return nil
}

func (c *fakeSharedCapClient) Reserve(
	_ context.Context,
	tenantID string,
	n int,
	window time.Duration,
	now time.Time,
) (CapReservation, error) {
	if err := c.check(); err != nil {
		return CapReservation{}, err
	}
	c.hub.mu.Lock()
	defer c.hub.mu.Unlock()
	if c.hub.unavailable {
		return CapReservation{}, ErrCapCoordinationUnavailable
	}
	state, exists := c.hub.states[tenantID]
	if !exists {
		return CapReservation{}, errCapStateMissing
	}
	if state.corrupt {
		return CapReservation{}, ErrCapStateCorrupt
	}
	if state.token != "" && now.Sub(state.startedAt) >= CapMutationFenceStaleAfter {
		return CapReservation{}, &staleCapStateError{token: state.token, startedAt: state.startedAt}
	}
	if state.cap == 0 {
		return CapReservation{Allowed: true}, nil
	}
	if c.hub.counters == nil {
		c.hub.counters = make(map[string]fakeSharedCounter)
	}
	counter := c.hub.counters[tenantID]
	if counter.resetAt.IsZero() || !now.Before(counter.resetAt) {
		counter = fakeSharedCounter{resetAt: now.Add(window)}
	}
	counter.count += n
	c.hub.counters[tenantID] = counter
	return CapReservation{
		Allowed: counter.count <= state.cap,
		HasCap:  true,
		Cap:     state.cap,
		Count:   counter.count,
		RetryAt: counter.resetAt,
	}, nil
}

func (c *fakeSharedCapClient) Inspect(_ context.Context, tenantID string, now time.Time) (CapCoordinationStatus, error) {
	if err := c.check(); err != nil {
		return CapCoordinationStatus{State: CapCoordinationStateDown}, err
	}
	c.hub.mu.Lock()
	defer c.hub.mu.Unlock()
	if c.hub.unavailable {
		return CapCoordinationStatus{State: CapCoordinationStateDown}, ErrCapCoordinationUnavailable
	}
	state, exists := c.hub.states[tenantID]
	if !exists {
		return CapCoordinationStatus{}, errCapStateMissing
	}
	if state.corrupt {
		return CapCoordinationStatus{State: CapCoordinationStateDown}, ErrCapStateCorrupt
	}
	if state.token != "" && now.Sub(state.startedAt) >= CapMutationFenceStaleAfter {
		return CapCoordinationStatus{}, &staleCapStateError{token: state.token, startedAt: state.startedAt}
	}
	if state.token == "" {
		return CapCoordinationStatus{State: CapCoordinationStateReady, Cap: state.cap, HasCap: state.cap > 0}, nil
	}
	started := state.startedAt
	return CapCoordinationStatus{
		State: CapCoordinationStateFenced, Cap: state.cap, HasCap: state.cap > 0, FenceStartedAt: &started,
	}, nil
}

func (c *fakeSharedCapClient) Begin(
	_ context.Context,
	tenantID, token string,
	currentCap, targetCap int,
	now time.Time,
) error {
	if err := c.check(); err != nil {
		return err
	}
	if c.beginHook != nil {
		c.beginHook()
	}
	c.hub.mu.Lock()
	defer c.hub.mu.Unlock()
	if c.hub.unavailable {
		return ErrCapCoordinationUnavailable
	}
	if c.hub.states == nil {
		c.hub.states = make(map[string]fakeSharedCapState)
	}
	state, exists := c.hub.states[tenantID]
	if !exists {
		state.cap = normalizeCap(currentCap)
	}
	if state.token != "" && state.token != token {
		if now.Sub(state.startedAt) >= CapMutationFenceStaleAfter {
			return &staleCapStateError{token: state.token, startedAt: state.startedAt}
		}
		return ErrCapChangeInProgress
	}
	state.cap = stricterFakeCap(
		stricterFakeCap(state.cap, normalizeCap(currentCap)),
		normalizeCap(targetCap),
	)
	state.token = token
	state.startedAt = now
	c.hub.states[tenantID] = state
	return nil
}

func (c *fakeSharedCapClient) Commit(_ context.Context, lease CapChangeLease, committedCap int, _ time.Time) error {
	if err := c.check(); err != nil {
		return err
	}
	c.hub.mu.Lock()
	defer c.hub.mu.Unlock()
	if c.hub.unavailable {
		return ErrCapCoordinationUnavailable
	}
	state := c.hub.states[lease.TenantID]
	if state.token != lease.Token {
		return ErrCapCoordinationUnavailable
	}
	c.hub.states[lease.TenantID] = fakeSharedCapState{cap: normalizeCap(committedCap)}
	return nil
}

func (c *fakeSharedCapClient) Abort(_ context.Context, lease CapChangeLease, durableCap int) error {
	if err := c.check(); err != nil {
		return err
	}
	c.hub.mu.Lock()
	defer c.hub.mu.Unlock()
	if c.hub.unavailable {
		return ErrCapCoordinationUnavailable
	}
	state := c.hub.states[lease.TenantID]
	if state.token != lease.Token {
		return ErrCapCoordinationUnavailable
	}
	c.hub.states[lease.TenantID] = fakeSharedCapState{cap: normalizeCap(durableCap)}
	return nil
}

func (c *fakeSharedCapClient) ReconcileStale(
	_ context.Context,
	tenantID, token string,
	startedAt time.Time,
	durableCap int,
) error {
	if err := c.check(); err != nil {
		return err
	}
	c.hub.mu.Lock()
	defer c.hub.mu.Unlock()
	if c.hub.unavailable {
		return ErrCapCoordinationUnavailable
	}
	state := c.hub.states[tenantID]
	if state.token != token || !state.startedAt.Equal(startedAt) {
		return nil
	}
	c.hub.states[tenantID] = fakeSharedCapState{cap: normalizeCap(durableCap)}
	return nil
}

func (c *fakeSharedCapClient) Close() error {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	c.started = false
	return nil
}

func stricterFakeCap(a, b int) int {
	if a == 0 {
		return b
	}
	if b == 0 || a < b {
		return a
	}
	return b
}

type fakeDurableCaps struct {
	mu   sync.Mutex
	caps map[string]int
	err  error
}

func (d *fakeDurableCaps) resolve(_ context.Context, tenantID string) (int, bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.err != nil {
		return 0, false, d.err
	}
	cap, ok := d.caps[tenantID]
	return cap, ok && cap > 0, nil
}

func (d *fakeDurableCaps) set(tenantID string, cap int) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.caps == nil {
		d.caps = make(map[string]int)
	}
	d.caps[tenantID] = cap
}

func coordinatedTestLimiter(t *testing.T, caps *fakeDurableCaps, backend CapCoordinationBackend) *TieredRateLimiter {
	t.Helper()
	limiter := &TieredRateLimiter{
		Window:      time.Hour,
		capCache:    make(map[string]capEntry),
		capResolver: caps.resolve,
		lru: middleware.NewBoundedBuckets[*tieredBucket](
			"coordinated_test", 100, time.Hour,
		),
	}
	limiter.missingCapInitializer = func(
		ctx context.Context,
		tenantID string,
		coordinator CapCoordinationBackend,
	) error {
		cap, hasCap, err := caps.resolve(ctx, tenantID)
		if err != nil {
			return err
		}
		if !hasCap {
			cap = 0
		}
		return coordinator.Rehydrate(ctx, tenantID, cap)
	}
	// Prime a deliberately stale local "uncapped" value. The coordinated path
	// must ignore it on every replica.
	stubCapLookup(limiter, "tenant-shared", 0)
	if err := limiter.StartCapCoordination(context.Background(), backend); err != nil {
		t.Fatalf("start cap coordination: %v", err)
	}
	return limiter
}

func beginLockedForTest(
	limiter *TieredRateLimiter,
	tenantID string,
	durable, target *int,
) (CapChangeLease, error) {
	return limiter.BeginCapChangeLocked(
		context.Background(), &fakeCapMutationTx{}, tenantID, durable, target,
	)
}

func TestDistributedCapCoordinationTighteningFencesEveryReplicaBeforeCommit(t *testing.T) {
	hub := &fakeSharedCapHub{}
	durable := &fakeDurableCaps{caps: map[string]int{}}
	first := coordinatedTestLimiter(t, durable, newFakeSharedCapClient(hub))
	second := coordinatedTestLimiter(t, durable, newFakeSharedCapClient(hub))

	// Cold shared state is explicitly initialized as uncapped. Neither replica's
	// stale local cap cache is authoritative.
	if ok, _, err := second.Try(context.Background(), "tenant-shared", 1); err != nil || !ok {
		t.Fatalf("initial uncapped admission = ok:%v err:%v", ok, err)
	}

	target := 1
	lease, err := beginLockedForTest(first, "tenant-shared", nil, &target)
	if err != nil {
		t.Fatalf("begin tightening: %v", err)
	}
	// The conservative fence is visible before the database commit. This closes
	// the old GET/commit/reserve race as well as the 30-second cache window.
	if ok, _, err := second.Try(context.Background(), "tenant-shared", 1); err != nil || !ok {
		t.Fatalf("first fenced admission = ok:%v err:%v", ok, err)
	}
	if ok, _, err := second.Try(context.Background(), "tenant-shared", 1); err != nil || ok {
		t.Fatalf("second fenced admission = ok:%v err:%v, want cap denial", ok, err)
	}

	durable.set("tenant-shared", target)
	if err := first.CommitCapChange(context.Background(), lease, &target); err != nil {
		t.Fatalf("commit shared cap: %v", err)
	}
	if ok, _, err := second.Try(context.Background(), "tenant-shared", 1); err != nil || ok {
		t.Fatalf("post-commit replica admission = ok:%v err:%v, want denial", ok, err)
	}
}

func TestDistributedCapCoordinationFailureAndStopFailClosed(t *testing.T) {
	hub := &fakeSharedCapHub{}
	durable := &fakeDurableCaps{caps: map[string]int{"tenant-shared": 5}}
	limiter := coordinatedTestLimiter(t, durable, newFakeSharedCapClient(hub))
	if ok, _, err := limiter.Try(context.Background(), "tenant-shared", 1); err != nil || !ok {
		t.Fatalf("initial admission = ok:%v err:%v", ok, err)
	}

	hub.mu.Lock()
	hub.unavailable = true
	hub.mu.Unlock()
	if ok, _, err := limiter.Try(context.Background(), "tenant-shared", 1); ok || !errors.Is(err, ErrCapCoordinationUnavailable) {
		t.Fatalf("unavailable authority = ok:%v err:%v", ok, err)
	}

	hub.mu.Lock()
	hub.unavailable = false
	hub.mu.Unlock()
	if err := limiter.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	if err := limiter.Close(); err != nil {
		t.Fatalf("second close: %v", err)
	}
	if ok, _, err := limiter.Try(context.Background(), "tenant-shared", 1); ok || !errors.Is(err, ErrCapCoordinationUnavailable) {
		t.Fatalf("post-stop admission = ok:%v err:%v", ok, err)
	}
}

func TestDistributedCapColdStartResolverFailureFailsClosed(t *testing.T) {
	hub := &fakeSharedCapHub{}
	durable := &fakeDurableCaps{err: errors.New("database unavailable")}
	limiter := coordinatedTestLimiter(t, durable, newFakeSharedCapClient(hub))

	if ok, _, err := limiter.Try(context.Background(), "tenant-shared", 1); ok || err == nil {
		t.Fatalf("resolver failure = ok:%v err:%v", ok, err)
	}
	hub.mu.Lock()
	_, initialized := hub.states["tenant-shared"]
	hub.mu.Unlock()
	if initialized {
		t.Fatal("resolver failure initialized shared state as uncapped")
	}
}

func TestCorruptCapStateIsCanonicallyRehydratedBeforeAdmission(t *testing.T) {
	hub := &fakeSharedCapHub{states: map[string]fakeSharedCapState{
		"tenant-shared": {cap: 100, corrupt: true},
	}}
	durable := &fakeDurableCaps{caps: map[string]int{"tenant-shared": 5}}
	client := newFakeSharedCapClient(hub)
	limiter := coordinatedTestLimiter(t, durable, client)

	if ok, _, err := limiter.Try(context.Background(), "tenant-shared", 1); err != nil || !ok {
		t.Fatalf("admission after locked canonical repair = ok:%v err:%v", ok, err)
	}
	client.mu.Lock()
	rehydrates := client.rehydrateCalls
	client.mu.Unlock()
	hub.mu.Lock()
	state := hub.states["tenant-shared"]
	hub.mu.Unlock()
	if rehydrates != 1 || state.corrupt || state.token != "" || state.cap != 5 {
		t.Fatalf("rehydration calls=%d state=%+v, want one canonical r:5 repair", rehydrates, state)
	}
}

func TestCorruptCapStateRepairFailureDeniesWithoutLocalFallback(t *testing.T) {
	hub := &fakeSharedCapHub{states: map[string]fakeSharedCapState{
		"tenant-shared": {cap: 100, corrupt: true},
	}}
	durable := &fakeDurableCaps{caps: map[string]int{"tenant-shared": 5}}
	client := newFakeSharedCapClient(hub)
	client.initializeErr = ErrCapCoordinationUnavailable
	limiter := coordinatedTestLimiter(t, durable, client)

	if ok, _, err := limiter.Try(context.Background(), "tenant-shared", 1); ok ||
		!errors.Is(err, ErrCapCoordinationUnavailable) {
		t.Fatalf("failed corrupt-state repair = ok:%v err:%v, want closed denial", ok, err)
	}
}

func TestMissingCapRehydrationRechecksSharedStateUnderMutationLock(t *testing.T) {
	hub := &fakeSharedCapHub{}
	durable := &fakeDurableCaps{caps: map[string]int{"tenant-shared": 100}}
	client := newFakeSharedCapClient(hub)
	limiter := coordinatedTestLimiter(t, durable, client)
	initializerCalls := 0
	limiter.missingCapInitializer = func(
		_ context.Context,
		tenantID string,
		coordinator CapCoordinationBackend,
	) error {
		initializerCalls++
		// Model a writer which installed a tighter fence while rehydration
		// waited for the shared Postgres mutation lock. The locked Redis
		// re-inspection must preserve that state instead of restoring r:100.
		hub.mu.Lock()
		if hub.states == nil {
			hub.states = make(map[string]fakeSharedCapState)
		}
		hub.states[tenantID] = fakeSharedCapState{
			cap: 1, token: "writer-fence", startedAt: time.Now().UTC(),
		}
		hub.mu.Unlock()
		status, err := coordinator.Inspect(context.Background(), tenantID, time.Now().UTC())
		if err != nil {
			return err
		}
		if status.State != CapCoordinationStateFenced {
			return errors.New("locked reinspection did not observe writer fence")
		}
		return nil
	}

	if ok, _, err := limiter.Try(context.Background(), "tenant-shared", 1); err != nil || !ok {
		t.Fatalf("first fenced admission = ok:%v err:%v", ok, err)
	}
	if ok, _, err := limiter.Try(context.Background(), "tenant-shared", 1); err != nil || ok {
		t.Fatalf("rehydration overwrote tighter fence: ok:%v err:%v", ok, err)
	}
	if initializerCalls != 1 {
		t.Fatalf("missing-state initializer calls = %d, want 1", initializerCalls)
	}
	hub.mu.Lock()
	state := hub.states["tenant-shared"]
	hub.mu.Unlock()
	if state.token != "writer-fence" || state.cap != 1 {
		t.Fatalf("shared state = %+v, want preserved writer fence", state)
	}
}

func TestWriterCannotInstallRedisFenceBeforeTenantMutationLockIsGranted(t *testing.T) {
	hub := &fakeSharedCapHub{states: map[string]fakeSharedCapState{
		"tenant-shared": {cap: 100},
	}}
	durable := &fakeDurableCaps{caps: map[string]int{"tenant-shared": 100}}
	client := newFakeSharedCapClient(hub)
	limiter := coordinatedTestLimiter(t, durable, client)

	lockAttempted := make(chan struct{})
	lockGranted := make(chan struct{})
	redisBegin := make(chan struct{})
	var lockOnce, beginOnce sync.Once
	tx := &fakeCapMutationTx{
		onLock: func() { lockOnce.Do(func() { close(lockAttempted) }) },
		wait:   lockGranted,
	}
	client.beginHook = func() { beginOnce.Do(func() { close(redisBegin) }) }

	durableCap, target := 100, 1
	done := make(chan error, 1)
	go func() {
		_, err := limiter.BeginCapChangeLocked(
			context.Background(), tx, "tenant-shared", &durableCap, &target,
		)
		done <- err
	}()

	select {
	case <-lockAttempted:
	case <-time.After(time.Second):
		t.Fatal("writer never attempted the tenant mutation lock")
	}
	select {
	case <-redisBegin:
		t.Fatal("writer installed a Redis fence while still waiting for the Postgres tenant lock")
	default:
	}

	// A missing-key rehydrator that already owns the same lock may publish the
	// old durable cap here. The queued writer still cannot have installed u:new;
	// once it receives the lock it begins against that ready value and tightens
	// it before any durable write.
	close(lockGranted)
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("locked begin: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("writer did not finish after the tenant lock was granted")
	}
	select {
	case <-redisBegin:
	default:
		t.Fatal("writer never installed its Redis fence after receiving the tenant lock")
	}
	hub.mu.Lock()
	state := hub.states["tenant-shared"]
	hub.mu.Unlock()
	if state.token == "" || state.cap != 1 {
		t.Fatalf("post-lock shared state = %+v, want a tight cap-1 fence", state)
	}
}

func TestBeginCapChangeNeverTrustsALooserReadyKeyOverCanonicalDurableCap(t *testing.T) {
	hub := &fakeSharedCapHub{states: map[string]fakeSharedCapState{
		// Model Redis restored from an older snapshot while Postgres still has the
		// tighter canonical cap. The mutation fence must preserve the tighter
		// durable value before any SQL write is allowed to run.
		"tenant-shared": {cap: 100},
	}}
	durable := &fakeDurableCaps{caps: map[string]int{"tenant-shared": 5}}
	limiter := coordinatedTestLimiter(t, durable, newFakeSharedCapClient(hub))

	oldCap, target := 5, 50
	lease, err := beginLockedForTest(limiter, "tenant-shared", &oldCap, &target)
	if err != nil {
		t.Fatalf("begin against divergent ready state: %v", err)
	}
	hub.mu.Lock()
	state := hub.states["tenant-shared"]
	hub.mu.Unlock()
	if lease.EffectiveCap != 5 || state.cap != 5 || state.token != lease.Token {
		t.Fatalf("lease=%+v state=%+v, want owner-bound cap-5 fence", lease, state)
	}

	for _, required := range []string{
		"stricter(tonumber(current), tonumber(ARGV[2]))",
		"tonumber(ARGV[3])",
	} {
		if !strings.Contains(redisCapBeginScript, required) {
			t.Fatalf("Redis Begin does not bind the fence to canonical old + target caps; missing %q:\n%s",
				required, redisCapBeginScript)
		}
	}
}

func TestCapMutationTransactionsExplicitlyUseReadCommitted(t *testing.T) {
	options := CapMutationTxOptions()
	if options.IsoLevel != pgx.ReadCommitted || options.AccessMode != pgx.ReadWrite {
		t.Fatalf("cap mutation transaction options = %+v, want explicit read committed/read write", options)
	}
}

func TestCapMutationReceiptMigrationAcceptsLegacyDurableCapDomain(t *testing.T) {
	raw, err := os.ReadFile("../../../../infra/migrations/2034_sending_cap_mutation_receipts.sql")
	if err != nil {
		t.Fatalf("read receipt migration: %v", err)
	}
	sql := strings.ToLower(string(raw))
	if !strings.Contains(sql, "committed_cap          integer,") {
		t.Fatal("receipt migration does not preserve the exact durable integer cap")
	}
	if strings.Contains(sql, "committed_cap          integer check") {
		t.Fatal("receipt evidence constrains legacy caps and can roll back an otherwise valid clear")
	}
}

func TestStaleCapFenceIsReconciledUnderDurableLockAfterWriterCrash(t *testing.T) {
	hub := &fakeSharedCapHub{}
	durable := &fakeDurableCaps{caps: map[string]int{"tenant-shared": 10}}
	limiter := coordinatedTestLimiter(t, durable, newFakeSharedCapClient(hub))
	limiter.staleCapReconciler = func(
		ctx context.Context,
		tenantID string,
		stale *staleCapStateError,
		coordinator CapCoordinationBackend,
	) error {
		// This mutex models the same tenant advisory lock production holds while
		// reading Postgres and applying the exact Redis token+timestamp CAS.
		durable.mu.Lock()
		defer durable.mu.Unlock()
		cap := durable.caps[tenantID]
		return coordinator.ReconcileStale(ctx, tenantID, stale.token, stale.startedAt, cap)
	}

	target := 5
	durableCap := 10
	if _, err := beginLockedForTest(limiter, "tenant-shared", &durableCap, &target); err != nil {
		t.Fatalf("begin abandoned cap change: %v", err)
	}
	// Simulate a process dying after Begin but before its database transaction.
	// No Abort/Commit can run, so the shared fence ages past the reclaim bound.
	hub.mu.Lock()
	state := hub.states["tenant-shared"]
	state.startedAt = time.Now().Add(-CapMutationFenceStaleAfter - time.Second).UTC()
	hub.states["tenant-shared"] = state
	hub.mu.Unlock()

	if ok, _, err := limiter.Try(context.Background(), "tenant-shared", 1); err != nil || !ok {
		t.Fatalf("post-crash reconciled admission = ok:%v err:%v", ok, err)
	}
	hub.mu.Lock()
	reconciled := hub.states["tenant-shared"]
	hub.mu.Unlock()
	if reconciled.token != "" || reconciled.cap != 10 {
		t.Fatalf("reconciled state = %+v, want durable ready cap 10", reconciled)
	}
}

func TestStaleCapFenceReconciliationCannotOverwriteNewOwner(t *testing.T) {
	hub := &fakeSharedCapHub{}
	durable := &fakeDurableCaps{caps: map[string]int{"tenant-shared": 10}}
	client := newFakeSharedCapClient(hub)
	limiter := coordinatedTestLimiter(t, durable, client)

	target := 5
	durableCap := 10
	lease, err := beginLockedForTest(limiter, "tenant-shared", &durableCap, &target)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	hub.mu.Lock()
	old := hub.states["tenant-shared"]
	hub.states["tenant-shared"] = fakeSharedCapState{
		cap: 3, token: "new-owner", startedAt: time.Now().UTC(),
	}
	hub.mu.Unlock()
	if err := client.ReconcileStale(context.Background(), "tenant-shared", lease.Token, old.startedAt, 10); err != nil {
		t.Fatalf("reconcile old owner: %v", err)
	}
	hub.mu.Lock()
	current := hub.states["tenant-shared"]
	hub.mu.Unlock()
	if current.token != "new-owner" || current.cap != 3 {
		t.Fatalf("old owner overwrote current fence: %+v", current)
	}
}

func TestInspectCapCoordinationInitializesMissingExplicitUncappedState(t *testing.T) {
	hub := &fakeSharedCapHub{}
	durable := &fakeDurableCaps{caps: map[string]int{}}
	limiter := coordinatedTestLimiter(t, durable, newFakeSharedCapClient(hub))

	status, err := limiter.InspectCapCoordination(context.Background(), "tenant-inspect")
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if status.State != CapCoordinationStateReady || status.HasCap || status.Cap != 0 {
		t.Fatalf("explicit uncapped status = %+v", status)
	}
	hub.mu.Lock()
	stored, ok := hub.states["tenant-inspect"]
	hub.mu.Unlock()
	if !ok || stored.token != "" || stored.cap != 0 {
		t.Fatalf("initialized shared state = %+v, exists=%v", stored, ok)
	}
}

func TestInspectCapCoordinationReportsUnavailableWhenMissingInitializationFails(t *testing.T) {
	hub := &fakeSharedCapHub{}
	durable := &fakeDurableCaps{caps: map[string]int{"tenant-inspect": 7}}
	client := newFakeSharedCapClient(hub)
	client.initializeErr = ErrCapCoordinationUnavailable
	limiter := coordinatedTestLimiter(t, durable, client)

	status, err := limiter.InspectCapCoordination(context.Background(), "tenant-inspect")
	if !errors.Is(err, ErrCapCoordinationUnavailable) || status.State != CapCoordinationStateDown {
		t.Fatalf("failed initialization status = %+v err=%v", status, err)
	}
}

func TestBeginCapChangeReclaimsForeignStaleFenceBeforeNewMutation(t *testing.T) {
	hub := &fakeSharedCapHub{}
	durable := &fakeDurableCaps{caps: map[string]int{"tenant-shared": 10}}
	limiter := coordinatedTestLimiter(t, durable, newFakeSharedCapClient(hub))
	limiter.staleCapReconciler = func(
		ctx context.Context,
		tenantID string,
		stale *staleCapStateError,
		coordinator CapCoordinationBackend,
	) error {
		durable.mu.Lock()
		defer durable.mu.Unlock()
		return coordinator.ReconcileStale(ctx, tenantID, stale.token, stale.startedAt, durable.caps[tenantID])
	}
	hub.mu.Lock()
	hub.states = map[string]fakeSharedCapState{
		"tenant-shared": {
			cap: 5, token: "abandoned", startedAt: time.Now().Add(-CapMutationFenceStaleAfter - time.Second).UTC(),
		},
	}
	hub.mu.Unlock()

	target := 8
	durableCap := 10
	lease, err := beginLockedForTest(limiter, "tenant-shared", &durableCap, &target)
	if err != nil {
		t.Fatalf("begin after stale owner: %v", err)
	}
	hub.mu.Lock()
	current := hub.states["tenant-shared"]
	hub.mu.Unlock()
	if lease.Token == "" || current.token != lease.Token || current.cap != 8 {
		t.Fatalf("replacement lease=%+v state=%+v", lease, current)
	}
}

func TestFirstCapMutationAfterStartupRehydratesUntrustedStaleFenceWithoutNestedLock(t *testing.T) {
	foreignToken := strings.Repeat("b", 32)
	store := &fakeRedisCapScriptStore{
		generation: 1,
		results: []string{
			"ok", // Start probe.
			"stale:" + foreignToken + ":1000",
			"ok", // Locked unconditional Rehydrate.
			"ok", // Retried Begin owns the new fence.
		},
	}
	backend := NewRedisCapBackend(store)
	limiter := &TieredRateLimiter{}
	if err := limiter.StartCapCoordination(context.Background(), backend); err != nil {
		t.Fatalf("start: %v", err)
	}
	durable, target := 10, 8
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	lease, err := limiter.BeginCapChangeLocked(
		ctx, &fakeCapMutationTx{}, "tenant", &durable, &target,
	)
	if err != nil || lease.Token == "" || lease.EffectiveCap != 8 {
		t.Fatalf("first mutation lease=%+v err=%v", lease, err)
	}

	store.mu.Lock()
	scripts := append([]string(nil), store.scripts...)
	store.mu.Unlock()
	if len(scripts) != 4 || scripts[0] != redisCapStartScript ||
		scripts[1] != redisCapBeginScript || scripts[2] != redisCapRehydrateScript ||
		scripts[3] != redisCapBeginScript {
		t.Fatalf("startup stale recovery script order = %#v", scripts)
	}
	for _, script := range scripts {
		if script == redisCapReconcileStaleScript {
			t.Fatal("untrusted stale recovery executed CAS instead of locked canonical rehydrate")
		}
	}
}

func TestRedisCapLeaseAgeUsesOnlyRedisServerTime(t *testing.T) {
	for name, script := range map[string]string{
		"begin":   redisCapBeginScript,
		"reserve": redisCapReserveScript,
		"inspect": redisCapInspectScript,
		"commit":  redisCapCommitScript,
	} {
		t.Run(name, func(t *testing.T) {
			if !strings.Contains(script, "redis.call('TIME')") {
				t.Fatalf("script does not use the shared Redis clock:\n%s", script)
			}
		})
	}
	if strings.Contains(redisCapBeginScript, "ARGV[5]") ||
		strings.Contains(redisCapReserveScript, "ARGV[4]") ||
		strings.Contains(redisCapInspectScript, "ARGV[2]") {
		t.Fatal("a cap lease script still accepts a gateway wall-clock argument")
	}
}

func TestRedisCommitLostContainmentIsStableAcrossAmbiguousReplyReplay(t *testing.T) {
	// The middleware store retries EVAL once when the first reply is lost. A
	// containment fence therefore needs a phase distinct from the original
	// update owner: only u may finalize, while replay against c returns lost.
	for _, required := range []string{
		"^u:([0-9a-f]+):%d+:%d+$",
		"^c:([0-9a-f]+):%d+:%d+$",
		"if containment_owner == ARGV[1] then return 'lost' end",
		"'c:' .. ARGV[1]",
	} {
		if !strings.Contains(redisCapCommitScript, required) {
			t.Fatalf("commit script lacks replay-stable containment %q:\n%s", required, redisCapCommitScript)
		}
	}
	if strings.Contains(redisCapCommitScript,
		"string.match(state, '^[uc]:([0-9a-f]+):%d+:%d+$')") {
		t.Fatal("commit script allows a containment owner to finalize a ready cap")
	}
	for name, script := range map[string]string{
		"reserve":   redisCapReserveScript,
		"inspect":   redisCapInspectScript,
		"begin":     redisCapBeginScript,
		"reconcile": redisCapReconcileStaleScript,
		"abort":     redisCapAbortScript,
	} {
		if !strings.Contains(script, "[uc]") {
			t.Fatalf("%s script cannot conservatively serve/recover c containment", name)
		}
	}
}

func TestDelayedOldCommitNeverOverwritesNewerMutationOrReadyState(t *testing.T) {
	oldToken := strings.Repeat("a", 32)
	newToken := strings.Repeat("b", 32)
	for _, test := range []struct {
		name  string
		state string
	}{
		{name: "newer mutation owner", state: "u:" + newToken + ":2:1000"},
		{name: "newer ready cap", state: "r:2"},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &replayingCommitStore{state: test.state}
			backend := &RedisCapBackend{
				store: store, started: true, validated: map[string]uint64{"tenant": 1},
			}
			lease := CapChangeLease{TenantID: "tenant", Token: oldToken, EffectiveCap: 5}
			for attempt := 0; attempt < 2; attempt++ {
				err := backend.Commit(context.Background(), lease, 10, time.Now())
				if !errors.Is(err, ErrCapCoordinationUnavailable) {
					t.Fatalf("delayed commit attempt %d error = %v, want lost ownership", attempt+1, err)
				}
				if store.state != test.state {
					t.Fatalf("delayed commit attempt %d changed newer state %q to %q",
						attempt+1, test.state, store.state)
				}
			}
		})
	}
}

func TestMissingCommitContainmentCannotFinalizeOnReplyLossReplay(t *testing.T) {
	token := strings.Repeat("a", 32)
	store := &replayingCommitStore{}
	backend := &RedisCapBackend{
		store: store, started: true, validated: map[string]uint64{"tenant": 1},
	}
	lease := CapChangeLease{TenantID: "tenant", Token: token, EffectiveCap: 5}
	for attempt := 0; attempt < 2; attempt++ {
		err := backend.Commit(context.Background(), lease, 10, time.Now())
		if !errors.Is(err, ErrCapCoordinationUnavailable) {
			t.Fatalf("containment attempt %d error = %v, want pending/lost", attempt+1, err)
		}
		if store.state != "c:"+token+":5:1" {
			t.Fatalf("containment attempt %d state = %q", attempt+1, store.state)
		}
	}
}

func TestRedisCapStartupProbeExercisesAuthorityPermissionsAndCleansUp(t *testing.T) {
	store := &fakeRedisCapScriptStore{result: "ok"}
	backend := NewRedisCapBackend(store)
	if err := backend.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}
	if err := backend.ready(); err != nil {
		t.Fatalf("backend was not marked ready: %v", err)
	}

	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.scripts) != 1 || len(store.keys) != 1 || len(store.args) != 1 {
		t.Fatalf("probe calls scripts=%d keys=%d args=%d", len(store.scripts), len(store.keys), len(store.args))
	}
	for _, command := range []string{"'TIME'", "'SET'", "'GET'", "'INCRBY'", "'EXPIRE'", "'TTL'", "'DEL'"} {
		if !strings.Contains(store.scripts[0], command) {
			t.Errorf("startup probe does not exercise %s", command)
		}
	}
	if len(store.keys[0]) != 2 || store.keys[0][0] == store.keys[0][1] {
		t.Fatalf("probe keys = %#v, want two unique disposable keys", store.keys[0])
	}
	for _, key := range store.keys[0] {
		if !strings.HasPrefix(key, redisCapLifecycleKey) {
			t.Errorf("probe key %q is outside lifecycle namespace", key)
		}
	}
	if len(store.args[0]) != 1 || store.args[0][0] == "" ||
		!strings.Contains(store.keys[0][0], store.args[0][0]) ||
		!strings.Contains(store.keys[0][1], store.args[0][0]) {
		t.Fatalf("probe token/key binding = keys %#v args %#v", store.keys[0], store.args[0])
	}
}

func TestRedisCapTrustIsBoundToOneStableConnectionGeneration(t *testing.T) {
	store := &fakeRedisCapScriptStore{result: "ok", generation: 1}
	backend := NewRedisCapBackend(store)
	if err := backend.Start(context.Background()); err != nil {
		t.Fatalf("start: %v", err)
	}

	store.mu.Lock()
	store.result = "reserved:1:60:5"
	startupCalls := len(store.scripts)
	store.mu.Unlock()
	if _, err := backend.Reserve(context.Background(), "tenant", 1, time.Hour, time.Now()); !errors.Is(err, errCapStateUntrusted) {
		t.Fatalf("unvalidated startup reserve error = %v, want untrusted", err)
	}
	store.mu.Lock()
	if calls := len(store.scripts); calls != startupCalls {
		store.mu.Unlock()
		t.Fatalf("untrusted reserve executed Redis script: calls=%d want=%d", calls, startupCalls)
	}
	store.result = "ok"
	store.mu.Unlock()
	if err := backend.Rehydrate(context.Background(), "tenant", 5); err != nil {
		t.Fatalf("rehydrate generation 1: %v", err)
	}

	store.mu.Lock()
	store.result = "reserved:1:60:5"
	store.mu.Unlock()
	reservation, err := backend.Reserve(context.Background(), "tenant", 1, time.Hour, time.Now())
	if err != nil || !reservation.Allowed || reservation.Cap != 5 {
		t.Fatalf("validated reserve = %+v err=%v", reservation, err)
	}

	store.mu.Lock()
	store.generation = 2
	beforeReconnectReserve := len(store.scripts)
	store.mu.Unlock()
	if _, err := backend.Reserve(context.Background(), "tenant", 1, time.Hour, time.Now()); !errors.Is(err, errCapStateUntrusted) {
		t.Fatalf("post-reconnect reserve error = %v, want untrusted", err)
	}
	store.mu.Lock()
	if calls := len(store.scripts); calls != beforeReconnectReserve {
		store.mu.Unlock()
		t.Fatalf("post-reconnect untrusted reserve executed script: calls=%d want=%d",
			calls, beforeReconnectReserve)
	}
	store.result = "ok"
	store.mu.Unlock()
	if err := backend.Rehydrate(context.Background(), "tenant", 5); err != nil {
		t.Fatalf("rehydrate generation 2: %v", err)
	}

	// Model EvalNamespacedString losing its first connection, reconnecting, and
	// replaying internally. Even a syntactically valid reservation reply from
	// that call must be discarded because validation belonged to generation 2.
	store.mu.Lock()
	store.result = "reserved:2:60:5"
	store.advanceGeneration = true
	store.mu.Unlock()
	if _, err := backend.Reserve(context.Background(), "tenant", 1, time.Hour, time.Now()); !errors.Is(err, errCapStateUntrusted) {
		t.Fatalf("cross-generation reply error = %v, want discarded/untrusted", err)
	}
}

func TestRedisCapStartupProbeFailsClosedOnReadOnlyOrRestrictedACL(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
	}{
		{name: "read_only_replica", err: errors.New("READONLY You can't write against a read only replica")},
		{name: "restricted_acl", err: errors.New("NOPERM this user has no permissions to run the 'expire' command")},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &fakeRedisCapScriptStore{err: test.err}
			backend := NewRedisCapBackend(store)
			limiter := &TieredRateLimiter{}
			err := limiter.StartCapCoordination(context.Background(), backend)
			if !errors.Is(err, ErrCapCoordinationUnavailable) {
				t.Fatalf("Start error = %v, want coordination unavailable", err)
			}
			if err := backend.ready(); !errors.Is(err, ErrCapCoordinationUnavailable) {
				t.Fatalf("backend became ready after failed probe: %v", err)
			}
			store.mu.Lock()
			closed := store.closed
			store.mu.Unlock()
			if closed != 1 {
				t.Fatalf("failed startup closed store %d times, want 1", closed)
			}
		})
	}
}

func TestCapMutationDeadlineIsStrictlyShorterThanFenceStaleAge(t *testing.T) {
	if CapMutationMaxDuration >= CapMutationFenceStaleAfter {
		t.Fatalf("mutation max %s must be less than stale age %s",
			CapMutationMaxDuration, CapMutationFenceStaleAfter)
	}
	started := time.Now()
	ctx, cancel := WithCapMutationDeadline(context.Background())
	defer cancel()
	deadline, ok := ctx.Deadline()
	if !ok {
		t.Fatal("bounded cap mutation context has no deadline")
	}
	remaining := deadline.Sub(started)
	if remaining <= 0 || remaining > CapMutationMaxDuration+time.Millisecond {
		t.Fatalf("mutation deadline remaining = %s, want (0,%s]", remaining, CapMutationMaxDuration)
	}
}
