// SPDX-License-Identifier: AGPL-3.0-only
package inbound_email

import (
	"context"
	"errors"
	"sync"
	"testing"
)

func TestInsertIdempotentClaimsReplayIdentity(t *testing.T) {
	pool := newRoutesTestPool(t)
	tenantID, cleanup := seedRoutesTenant(t, pool)
	defer cleanup()
	repo := &Repo{Pool: pool}
	email := Email{From: "sender@example.com", To: "inbox@example.com", Subject: "reply"}
	key, err := inboundEmailReplayKey("provider-event-" + randHex(t))
	if err != nil {
		t.Fatal(err)
	}
	bodyHashA := inboundEmailBodyHash([]byte("body-a"))
	bodyHashB := inboundEmailBodyHash([]byte("body-b"))

	firstID, duplicate, err := repo.InsertIdempotent(context.Background(), tenantID, email, key, bodyHashA)
	if err != nil || duplicate || firstID == 0 {
		t.Fatalf("first insert = id %d duplicate %v err %v", firstID, duplicate, err)
	}
	secondID, duplicate, err := repo.InsertIdempotent(context.Background(), tenantID, email, key, bodyHashA)
	if err != nil || !duplicate || secondID != firstID {
		t.Fatalf("exact retry = id %d duplicate %v err %v; want id %d", secondID, duplicate, err, firstID)
	}
	if _, _, err := repo.InsertIdempotent(context.Background(), tenantID, email, key, bodyHashB); !errors.Is(err, ErrReplayConflict) {
		t.Fatalf("identity reuse error = %v, want ErrReplayConflict", err)
	}
}

func TestInsertIdempotentConcurrentRetriesCreateOneRow(t *testing.T) {
	pool := newRoutesTestPool(t)
	tenantID, cleanup := seedRoutesTenant(t, pool)
	defer cleanup()
	repo := &Repo{Pool: pool}
	key, err := inboundEmailReplayKey("concurrent-provider-event-" + randHex(t))
	if err != nil {
		t.Fatal(err)
	}
	bodyHash := inboundEmailBodyHash([]byte("same-body"))
	email := Email{From: "sender@example.com", To: "inbox@example.com", Subject: "reply"}

	const workers = 8
	ids := make(chan int64, workers)
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, _, err := repo.InsertIdempotent(context.Background(), tenantID, email, key, bodyHash)
			if err != nil {
				errs <- err
				return
			}
			ids <- id
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		t.Errorf("concurrent insert: %v", err)
	}
	var want int64
	count := 0
	for id := range ids {
		count++
		if want == 0 {
			want = id
		} else if id != want {
			t.Errorf("concurrent retry ids differ: got %d, want %d", id, want)
		}
	}
	if count != workers {
		t.Fatalf("successful workers = %d, want %d (claimed id %d)", count, workers, want)
	}
}
