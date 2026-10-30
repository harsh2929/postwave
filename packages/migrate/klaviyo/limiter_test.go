package klaviyo

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
)

func TestKlaviyoLimiterRegistryIsAccountScopedAndBounded(t *testing.T) {
	now := time.Date(2026, 7, 18, 0, 0, 0, 0, time.UTC)
	registry := newKlaviyoLimiterRegistry(1, time.Hour)
	registry.now = func() time.Time { return now }
	first := registry.forSession(adapter.Session{AccountID: "account_one"})
	require.Same(t, first, registry.forSession(adapter.Session{AccountID: "account_one"}))
	second := registry.forSession(adapter.Session{AccountID: "account_two"})
	require.Same(t, registry.overflow, second)
	require.Len(t, registry.entries, 1)
	require.NotContains(t, registry.entries, "account_one", "raw provider account IDs must never be registry keys")

	now = now.Add(2 * time.Hour)
	third := registry.forSession(adapter.Session{AccountID: "account_three"})
	require.NotSame(t, registry.overflow, third)
	require.Len(t, registry.entries, 1)
}

func TestKlaviyoPredictiveProfileLimiterStaysBelowSpecialEndpointBurst(t *testing.T) {
	bucket := newKlaviyoLimiterSet().profiles
	for i := 0; i < 9; i++ {
		require.NoError(t, bucket.Wait(context.Background()))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	require.ErrorIs(t, bucket.Wait(ctx), context.DeadlineExceeded, "the predictive_analytics profile path must not admit a tenth immediate request")
}

func TestKlaviyoLimiterSelectsDocumentedEndpointBuckets(t *testing.T) {
	registry := newKlaviyoLimiterRegistry(4, time.Hour)
	sess := adapter.Session{AccountID: "account"}
	set := registry.forSession(sess)
	require.Same(t, set.accounts, registry.forRequest(sess, "/accounts"))
	require.Same(t, set.slow, registry.forRequest(sess, "/flows?additional-fields[flow]=definition"))
	require.Same(t, set.slow, registry.forRequest(sess, "/forms"))
	require.Same(t, set.profiles, registry.forRequest(sess, "/profiles?additional-fields%5Bprofile%5D=subscriptions%2Cpredictive_analytics"))
	require.Same(t, set.medium, registry.forRequest(sess, "/campaigns"))
	require.Same(t, set.defaultAPI, registry.forRequest(sess, "/lists"))
}
