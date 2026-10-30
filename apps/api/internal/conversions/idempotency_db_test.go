// SPDX-License-Identifier: AGPL-3.0-only

package conversions

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A retried request returns the ORIGINAL result, and does not do the work twice.
//
// The PRD asks for both halves and they are separable. Storing a marker and
// returning a fresh acknowledgement would stop the double-count and still break
// the client: a caller reconciling ids against its own records would see a
// different response from the one it is retrying and conclude the first attempt
// had failed. So the response body itself is stored and replayed.
func TestARetriedRequestReplaysTheOriginalResponse(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)

	repo := &Repo{Pool: pool}
	body := []byte(`{"event_name":"purchase","value":129}`)
	digest := RequestDigest(body)
	key := "idem-" + uuid.NewString()

	first, err := repo.RememberIdempotentResponse(ctx, tenantID, key, digest, 201,
		[]byte(`{"id":"conv_1","status":"recorded"}`))
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	if first.StatusCode != 201 {
		t.Fatalf("first status = %d, want 201", first.StatusCode)
	}

	// The retry carries a DIFFERENT would-be response, as a real second
	// execution would: a new id, a new timestamp. It must not be stored.
	second, err := repo.RememberIdempotentResponse(ctx, tenantID, key, digest, 201,
		[]byte(`{"id":"conv_2","status":"recorded"}`))
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if string(second.Body) != `{"id": "conv_1", "status": "recorded"}` &&
		string(second.Body) != `{"id":"conv_1","status":"recorded"}` {
		t.Fatalf("retry returned %s, want the ORIGINAL response — a client "+
			"reconciling ids would treat this as a failed first attempt",
			second.Body)
	}
}

// The same key with a DIFFERENT body is a conflict, not a retry.
//
// This is the dangerous case. Replaying the stored response would silently
// discard the new data and tell the caller it succeeded; accepting it would let
// one authorised request stand in for another.
func TestTheSameKeyWithADifferentBodyIsRefused(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)

	repo := &Repo{Pool: pool}
	key := "idem-" + uuid.NewString()

	if _, err := repo.RememberIdempotentResponse(ctx, tenantID, key,
		RequestDigest([]byte(`{"value":129}`)), 201, []byte(`{"id":"conv_1"}`)); err != nil {
		t.Fatalf("first call: %v", err)
	}

	_, err := repo.RememberIdempotentResponse(ctx, tenantID, key,
		RequestDigest([]byte(`{"value":12900}`)), 201, []byte(`{"id":"conv_2"}`))
	if !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("err = %v, want ErrIdempotencyConflict — a 129 conversion and a "+
			"12900 one shared a key and one of them vanished silently", err)
	}
}

// A missing key is refused outright.
//
// The PRD makes the header REQUIRED. Optional idempotency double-counts on the
// first network retry, and network retries are the normal case.
func TestAMissingIdempotencyKeyIsRefused(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	tenantID := createAttributionTenant(t, pool, ctx)

	for _, key := range []string{"", "   "} {
		_, err := repo(pool).RememberIdempotentResponse(ctx, tenantID, key,
			RequestDigest([]byte(`{}`)), 201, []byte(`{}`))
		if !errors.Is(err, ErrIdempotencyKeyRequired) {
			t.Errorf("key %q: err = %v, want ErrIdempotencyKeyRequired", key, err)
		}
	}
}

// One tenant's key does not collide with another's.
func TestIdempotencyKeysAreTenantScoped(t *testing.T) {
	pool := attributionDB(t)
	ctx := context.Background()
	mine := createAttributionTenant(t, pool, ctx)
	theirs := createAttributionTenant(t, pool, ctx)

	shared := "order-1001"
	if _, err := repo(pool).RememberIdempotentResponse(ctx, mine, shared,
		RequestDigest([]byte(`{"v":1}`)), 201, []byte(`{"id":"mine"}`)); err != nil {
		t.Fatalf("mine: %v", err)
	}
	// A different tenant using the same natural key (an order number) must not
	// be told it is a duplicate, and must not read my response.
	stored, err := repo(pool).RememberIdempotentResponse(ctx, theirs, shared,
		RequestDigest([]byte(`{"v":2}`)), 201, []byte(`{"id":"theirs"}`))
	if err != nil {
		t.Fatalf("theirs: %v — a shared natural key across tenants was treated as "+
			"a conflict", err)
	}
	if string(stored.Body) == `{"id":"mine"}` {
		t.Fatal("one tenant read another tenant's stored response")
	}

	// And the rows really are separate.
	tx, err := db.WithTenant(ctx, pool, mine)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var visible int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM conversion_ingest_idempotency WHERE idempotency_key = $1`,
		shared).Scan(&visible); err != nil {
		t.Fatalf("count: %v", err)
	}
	if visible != 1 {
		t.Fatalf("tenant sees %d rows for a shared key, want 1", visible)
	}
}

func repo(pool *db.Pool) *Repo { return &Repo{Pool: pool} }
