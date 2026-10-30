// SPDX-License-Identifier: MIT

package mailchimp

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
)

func TestMailchimpRequestLimiterKeyPrefersAuthenticatedAccountFingerprint(t *testing.T) {
	t.Parallel()

	first := adapter.Session{
		AccessToken: "first-secret-token",
		AccountID:   "us1",
		Extra: map[string]string{
			AccountFingerprintExtraKey: "ABCDEF1234",
		},
	}
	second := adapter.Session{
		AccessToken: "rotated-secret-token",
		AccountID:   "us99",
		Extra: map[string]string{
			AccountFingerprintExtraKey: "abcdef1234",
		},
	}

	firstKey := mailchimpRequestLimiterKey(first)
	secondKey := mailchimpRequestLimiterKey(second)
	require.Equal(t, firstKey, secondKey, "one authenticated account must share a limiter across credentials and data centers")
	require.NotContains(t, firstKey, first.AccessToken)
	require.NotContains(t, secondKey, second.AccessToken)
	require.Len(t, firstKey, sha256HexLength)

	fallbackA := mailchimpRequestLimiterKey(adapter.Session{AccessToken: "fallback-secret", AccountID: "US21"})
	fallbackB := mailchimpRequestLimiterKey(adapter.Session{AccessToken: "fallback-secret", AccountID: "us21"})
	require.Equal(t, fallbackA, fallbackB)
	require.NotContains(t, fallbackA, "fallback-secret")
	require.NotEqual(t, fallbackA, mailchimpRequestLimiterKey(adapter.Session{AccessToken: "different-secret", AccountID: "us21"}))
	require.NotEqual(t, firstKey, fallbackA, "authenticated and fallback identity namespaces must not collide")
}

func TestMailchimpConcurrencyLimiterIsSharedAcrossAdapterInstances(t *testing.T) {
	t.Parallel()

	const requestCount = 30
	entered := make(chan struct{}, requestCount)
	releaseRequests := make(chan struct{})
	var closeRelease sync.Once
	releaseAll := func() { closeRelease.Do(func() { close(releaseRequests) }) }

	var active atomic.Int64
	var maximum atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		current := active.Add(1)
		updateMaximum(&maximum, current)
		entered <- struct{}{}
		<-releaseRequests
		active.Add(-1)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	defer releaseAll()

	adapters := []*Adapter{New(), New(), New()}
	for _, a := range adapters {
		a.BaseURL = server.URL
	}
	sessions := []adapter.Session{
		mailchimpLimiterTestSession("token-one", "us1", "shared-account-fingerprint"),
		mailchimpLimiterTestSession("token-two", "us2", "shared-account-fingerprint"),
		mailchimpLimiterTestSession("token-three", "us3", "shared-account-fingerprint"),
	}

	errs := make(chan error, requestCount)
	var wg sync.WaitGroup
	for i := 0; i < requestCount; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var out map[string]interface{}
			errs <- adapters[i%len(adapters)].do(context.Background(), sessions[i%len(sessions)], http.MethodGet, "/ping", nil, &out)
		}(i)
	}

	for i := 0; i < mailchimpMaxConcurrentRequests; i++ {
		select {
		case <-entered:
		case <-time.After(2 * time.Second):
			t.Fatalf("only %d of %d shared-account requests entered the server", i, mailchimpMaxConcurrentRequests)
		}
	}
	select {
	case <-entered:
		t.Fatal("more than ten requests for one account entered concurrently")
	case <-time.After(100 * time.Millisecond):
	}
	require.Equal(t, int64(mailchimpMaxConcurrentRequests), maximum.Load())

	releaseAll()
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	require.LessOrEqual(t, maximum.Load(), int64(mailchimpMaxConcurrentRequests))
	requireLimiterEntryIdle(t, mailchimpRequestLimiterKey(sessions[0]))
}

func TestMailchimpConcurrencyLimiterKeepsDistinctAccountsIndependent(t *testing.T) {
	t.Parallel()

	enteredA := make(chan struct{}, mailchimpMaxConcurrentRequests)
	enteredB := make(chan struct{}, mailchimpMaxConcurrentRequests)
	releaseA := make(chan struct{})
	var closeRelease sync.Once
	releaseAllA := func() { closeRelease.Do(func() { close(releaseA) }) }

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/account-a":
			enteredA <- struct{}{}
			<-releaseA
		case "/account-b":
			enteredB <- struct{}{}
		default:
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()
	defer releaseAllA()

	first := New()
	second := New()
	first.BaseURL = server.URL
	second.BaseURL = server.URL
	sessA := mailchimpLimiterTestSession("account-a-token", "us1", "independent-account-a")
	sessB := mailchimpLimiterTestSession("account-b-token", "us1", "independent-account-b")

	errsA := make(chan error, mailchimpMaxConcurrentRequests)
	var wg sync.WaitGroup
	for i := 0; i < mailchimpMaxConcurrentRequests; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var out map[string]interface{}
			current := first
			if i%2 == 1 {
				current = second
			}
			errsA <- current.do(context.Background(), sessA, http.MethodGet, "/account-a", nil, &out)
		}(i)
	}
	for i := 0; i < mailchimpMaxConcurrentRequests; i++ {
		select {
		case <-enteredA:
		case <-time.After(2 * time.Second):
			t.Fatalf("only %d account-A requests entered the server", i)
		}
	}

	errsB := make(chan error, mailchimpMaxConcurrentRequests)
	var wgB sync.WaitGroup
	for i := 0; i < mailchimpMaxConcurrentRequests; i++ {
		wgB.Add(1)
		go func(i int) {
			defer wgB.Done()
			var out map[string]interface{}
			current := first
			if i%2 == 1 {
				current = second
			}
			errsB <- current.do(context.Background(), sessB, http.MethodGet, "/account-b", nil, &out)
		}(i)
	}
	for i := 0; i < mailchimpMaxConcurrentRequests; i++ {
		select {
		case <-enteredB:
		case <-time.After(500 * time.Millisecond):
			t.Fatalf("saturated account A blocked account-B request %d", i+1)
		}
	}
	wgB.Wait()
	close(errsB)
	for err := range errsB {
		require.NoError(t, err)
	}

	releaseAllA()
	wg.Wait()
	close(errsA)
	for err := range errsA {
		require.NoError(t, err)
	}
	requireLimiterEntryIdle(t, mailchimpRequestLimiterKey(sessA))
	requireLimiterEntryIdle(t, mailchimpRequestLimiterKey(sessB))
}

func TestMailchimpConcurrencyLimiterBindsLiveFallbackToVerifiedAccount(t *testing.T) {
	t.Parallel()

	registry := requestLimiterRegistry{idleTTL: time.Hour}
	fallbackKey := hashMailchimpLimiterIdentity("credential-dc", "binding-fallback")
	accountKey := hashMailchimpLimiterIdentity("account", "binding-account")
	releases := make([]func(), 0, mailchimpMaxConcurrentRequests)
	for i := 0; i < mailchimpMaxConcurrentRequests; i++ {
		release, err := registry.acquire(context.Background(), fallbackKey)
		require.NoError(t, err)
		releases = append(releases, release)
	}

	registry.bind(fallbackKey, accountKey)
	blockedCtx, cancelBlocked := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancelBlocked()
	release, err := registry.acquire(blockedCtx, accountKey)
	require.Nil(t, release)
	require.ErrorIs(t, err, context.DeadlineExceeded, "verified requests must not receive a second allowance while fallback requests are live")

	releases[0]()
	accountRelease, err := registry.acquire(context.Background(), accountKey)
	require.NoError(t, err)
	accountRelease()
	for _, release := range releases[1:] {
		release()
	}
	requireRegistryGroupIdle(t, &registry, accountKey)
}

func TestMailchimpConcurrencyLimiterMergesAlreadyActiveIdentityGroups(t *testing.T) {
	t.Parallel()

	registry := requestLimiterRegistry{idleTTL: time.Hour}
	fallbackKey := hashMailchimpLimiterIdentity("credential-dc", "active-fallback")
	accountKey := hashMailchimpLimiterIdentity("account", "active-account")
	var fallbackReleases []func()
	var accountReleases []func()
	for i := 0; i < 6; i++ {
		release, err := registry.acquire(context.Background(), fallbackKey)
		require.NoError(t, err)
		fallbackReleases = append(fallbackReleases, release)
		release, err = registry.acquire(context.Background(), accountKey)
		require.NoError(t, err)
		accountReleases = append(accountReleases, release)
	}

	registry.bind(fallbackKey, accountKey)
	acquired := make(chan func(), 1)
	errCh := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	go func() {
		release, err := registry.acquire(ctx, accountKey)
		if err != nil {
			errCh <- err
			return
		}
		acquired <- release
	}()

	// The merged group starts at 12 active requests. It remains saturated at
	// ten after two releases and admits the waiter only after the third.
	fallbackReleases[0]()
	accountReleases[0]()
	select {
	case release := <-acquired:
		release()
		t.Fatal("merged limiter admitted a request while ten requests were active")
	case err := <-errCh:
		require.NoError(t, err)
	case <-time.After(50 * time.Millisecond):
	}
	fallbackReleases[1]()

	var waiterRelease func()
	select {
	case waiterRelease = <-acquired:
	case err := <-errCh:
		require.NoError(t, err)
	case <-time.After(time.Second):
		t.Fatal("merged limiter did not admit a waiter after activity fell below ten")
	}
	waiterRelease()
	for _, release := range fallbackReleases[2:] {
		release()
	}
	for _, release := range accountReleases[1:] {
		release()
	}
	requireRegistryGroupIdle(t, &registry, fallbackKey)
	requireRegistryGroupIdle(t, &registry, accountKey)
}

func TestMailchimpConcurrencyLimiterCancellationAndIdleCleanup(t *testing.T) {
	t.Parallel()

	registry := requestLimiterRegistry{}
	key := hashMailchimpLimiterIdentity("test", t.Name())
	releases := make([]func(), 0, mailchimpMaxConcurrentRequests)
	for i := 0; i < mailchimpMaxConcurrentRequests; i++ {
		release, err := registry.acquire(context.Background(), key)
		require.NoError(t, err)
		releases = append(releases, release)
	}

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		release, err := registry.acquire(ctx, key)
		if release != nil {
			release()
		}
		result <- err
	}()
	require.Eventually(t, func() bool {
		registry.mu.Lock()
		defer registry.mu.Unlock()
		entry := registry.entries[key]
		return entry != nil && entry.refs == mailchimpMaxConcurrentRequests+1
	}, time.Second, time.Millisecond)
	cancel()
	require.ErrorIs(t, <-result, context.Canceled)

	var wg sync.WaitGroup
	for _, release := range releases {
		wg.Add(1)
		go func(release func()) {
			defer wg.Done()
			release()
			release() // release functions are deliberately idempotent.
		}(release)
	}
	wg.Wait()

	registry.mu.Lock()
	defer registry.mu.Unlock()
	require.Empty(t, registry.entries, "idle limiter entries must not accumulate")
}

func TestMailchimpConcurrencyLimiterExpiresIdleVerifiedAliases(t *testing.T) {
	t.Parallel()

	registry := requestLimiterRegistry{idleTTL: 5 * time.Millisecond}
	fallbackKey := hashMailchimpLimiterIdentity("credential-dc", "expiring-fallback")
	accountKey := hashMailchimpLimiterIdentity("account", "expiring-account")
	release, err := registry.acquire(context.Background(), fallbackKey)
	require.NoError(t, err)
	release()

	// Binding must safely replace the fallback cleanup timer and keep both
	// hashed aliases alive as one group until the merged group becomes idle.
	registry.bind(fallbackKey, accountKey)
	release, err = registry.acquire(context.Background(), accountKey)
	require.NoError(t, err)
	release()
	require.Eventually(t, func() bool {
		registry.mu.Lock()
		defer registry.mu.Unlock()
		return len(registry.entries) == 0
	}, time.Second, time.Millisecond, "idle fallback/account aliases were not cleaned")
}

func TestMailchimpConcurrencyLimiterRestartsIdleTTLAfterReactivation(t *testing.T) {
	t.Parallel()

	const idleTTL = 200 * time.Millisecond
	registry := requestLimiterRegistry{idleTTL: idleTTL}
	key := hashMailchimpLimiterIdentity("account", "reactivated-account")
	release, err := registry.acquire(context.Background(), key)
	require.NoError(t, err)
	release()

	time.Sleep(idleTTL / 2)
	release, err = registry.acquire(context.Background(), key)
	require.NoError(t, err)
	release()

	// This is after the original expiry but comfortably before a full idle TTL
	// has elapsed since the second release.
	time.Sleep(130 * time.Millisecond)
	registry.mu.Lock()
	_, stillPresent := registry.entries[key]
	registry.mu.Unlock()
	require.True(t, stillPresent, "reactivation did not restart the idle cleanup window")

	require.Eventually(t, func() bool {
		registry.mu.Lock()
		defer registry.mu.Unlock()
		return registry.entries[key] == nil
	}, time.Second, time.Millisecond)
}

const sha256HexLength = 64

func mailchimpLimiterTestSession(token, dc, fingerprint string) adapter.Session {
	return adapter.Session{
		AccessToken: token,
		AccountID:   dc,
		Extra: map[string]string{
			AccountFingerprintExtraKey: fingerprint,
		},
	}
}

func updateMaximum(maximum *atomic.Int64, current int64) {
	for {
		previous := maximum.Load()
		if current <= previous || maximum.CompareAndSwap(previous, current) {
			return
		}
	}
}

func requireLimiterEntryIdle(t *testing.T, key string) {
	t.Helper()
	mailchimpRequestLimiters.mu.Lock()
	defer mailchimpRequestLimiters.mu.Unlock()
	group := mailchimpRequestLimiters.entries[key]
	require.NotNil(t, group)
	group = mailchimpRequestLimiters.rootLocked(group)
	require.Zero(t, group.active)
	require.Zero(t, group.refs)
}

func requireRegistryGroupIdle(t *testing.T, registry *requestLimiterRegistry, key string) {
	t.Helper()
	registry.mu.Lock()
	defer registry.mu.Unlock()
	group := registry.entries[key]
	require.NotNil(t, group)
	group = registry.rootLocked(group)
	require.Zero(t, group.active)
	require.Zero(t, group.refs)
}

func TestMailchimpConcurrencyLimiterRejectsAlreadyCancelledContextWithoutAllocating(t *testing.T) {
	t.Parallel()

	registry := requestLimiterRegistry{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	release, err := registry.acquire(ctx, "cancelled")
	require.Nil(t, release)
	require.True(t, errors.Is(err, context.Canceled))
	registry.mu.Lock()
	defer registry.mu.Unlock()
	require.Empty(t, registry.entries)
}
