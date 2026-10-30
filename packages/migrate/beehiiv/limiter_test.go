// SPDX-License-Identifier: MIT

package beehiiv

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	adapter "github.com/postwave/migrate/adapter"
	"github.com/postwave/migrate/canonical"
)

func TestBeehiivLimiterDoesNotAllocateForUnverifiedCredentials(t *testing.T) {
	registry := newBeehiivLimiterRegistry(2, time.Minute)
	first := registry.forSession(adapter.Session{AccessToken: "rejected-one", Source: canonical.SourceBeehiiv})
	second := registry.forSession(adapter.Session{AccessToken: "rejected-two", Source: canonical.SourceBeehiiv})
	require.Same(t, first, second)
	require.Empty(t, registry.entries)
}

func TestBeehiivLimiterSharesWorkspaceAndBoundsRegistry(t *testing.T) {
	registry := newBeehiivLimiterRegistry(2, time.Hour)
	first := registry.forWorkspace("work_one")
	require.Same(t, first, registry.forWorkspace("work_one"))
	second := registry.forWorkspace("work_two")
	require.NotSame(t, first, second)
	require.Same(t, registry.overflow, registry.forWorkspace("work_three"))
	require.Len(t, registry.entries, 2)
	for key := range registry.entries {
		require.Len(t, key, sha256HexLength)
		require.NotContains(t, key, "work_")
	}
}

func TestBeehiivLimiterExpiresIdleWorkspaceEntries(t *testing.T) {
	registry := newBeehiivLimiterRegistry(1, time.Minute)
	now := time.Unix(1_700_000_000, 0).UTC()
	registry.now = func() time.Time { return now }
	first := registry.forWorkspace("work_old")
	require.Len(t, registry.entries, 1)

	now = now.Add(time.Minute)
	second := registry.forWorkspace("work_new")
	require.NotSame(t, first, second)
	require.Len(t, registry.entries, 1)
	_, oldPresent := registry.entries[hashBeehiivLimiterIdentity("work_old")]
	require.False(t, oldPresent)
}

func TestBeehiivLimiterChargesIdentifyAgainstRevealedWorkspace(t *testing.T) {
	registry := newBeehiivLimiterRegistry(2, time.Minute)
	require.NoError(t, registry.chargeIdentifiedWorkspace("work_one"))
	bucket := registry.forWorkspace("work_one")
	for i := 0; i < requestBurst-1; i++ {
		require.NoError(t, bucket.Wait(context.Background()))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	require.ErrorIs(t, bucket.Wait(ctx), context.DeadlineExceeded)
	require.ErrorIs(t, registry.chargeIdentifiedWorkspace(""), adapter.ErrAuth)
}

func TestBeehiivLimiterRecordsIdentifyDebtWithoutWaiting(t *testing.T) {
	registry := newBeehiivLimiterRegistry(2, time.Minute)
	bucket := registry.forWorkspace("work_one")
	for i := 0; i < requestBurst; i++ {
		require.NoError(t, bucket.Wait(context.Background()))
	}

	// The provider request has already happened, so accounting must complete
	// even though no token is presently available. Future requests remain
	// blocked until both the empty balance and this new debt are refilled.
	require.NoError(t, registry.chargeIdentifiedWorkspace("work_one"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel()
	require.ErrorIs(t, bucket.Wait(ctx), context.DeadlineExceeded)
}

const sha256HexLength = 64
