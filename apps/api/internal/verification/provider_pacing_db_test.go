// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"sort"
	"sync"
	"testing"
	"time"
)

func TestDBZeroBounceBatchReservationsSerializeAcrossReplicas(t *testing.T) {
	pool := verificationDB(t)
	tenant := newTenant(t, pool)
	store := newStore(t, pool, nil)

	const reservations = 4
	waits := make([]time.Duration, reservations)
	errs := make([]error, reservations)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < reservations; i++ {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			waits[index], errs[index] = store.reserveProviderBatchSlot(
				context.Background(), tenant, ProviderZeroBounce, zeroBounceBatchInterval)
		}(i)
	}
	close(start)
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatalf("reserveProviderBatchSlot: %v", err)
		}
	}
	sort.Slice(waits, func(i, j int) bool { return waits[i] < waits[j] })
	if waits[0] > 500*time.Millisecond {
		t.Fatalf("first reservation wait = %s, want an immediately usable slot", waits[0])
	}
	for i := 1; i < len(waits); i++ {
		if gap := waits[i] - waits[i-1]; gap < zeroBounceBatchInterval-250*time.Millisecond {
			t.Fatalf("reservation waits = %v; adjacent gap %s is below durable pacing", waits, gap)
		}
	}

	otherTenant := newTenant(t, pool)
	independent, err := store.reserveProviderBatchSlot(
		context.Background(), otherTenant, ProviderZeroBounce, zeroBounceBatchInterval)
	if err != nil {
		t.Fatalf("other tenant reservation: %v", err)
	}
	if independent > 500*time.Millisecond {
		t.Fatalf("other tenant was incorrectly throttled for %s", independent)
	}
}
