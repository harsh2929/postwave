// SPDX-License-Identifier: AGPL-3.0-only

package inbound_webhooks

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A redelivered webhook must be recognised as a duplicate, not error.
//
// Duplicate detection inserts with ON CONFLICT DO NOTHING and, when no row comes
// back, reads the existing one `FOR SHARE`. `postwave_app` deliberately lacks
// UPDATE on this append-only log — and PostgreSQL requires UPDATE privilege for
// a row-locking clause, so that read raised "permission denied for table
// inbound_events" while the plain SELECT on the same rows worked.
//
// Webhook providers deliver at least once and retry aggressively, so the second
// delivery of any event carrying a source_event_id is normal traffic. Migration
// 1901 grants UPDATE for the lock and blocks real writes with a RESTRICTIVE
// `WITH CHECK (false)` policy: lockable, not writable.
func TestTheDuplicateDetectionPathCanLockTheExistingEvent(t *testing.T) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping duplicate-delivery test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := db.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	tenantID := uuid.NewString()

	tx, txErr := db.WithTenant(ctx, pool, tenantID)
	if txErr != nil {
		t.Fatalf("WithTenant: %v", txErr)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'dup-probe', 'dup-probe-' || right($1::text, 12), 'studio')`, tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	var endpointID string
	if err := tx.QueryRow(ctx, `
INSERT INTO inbound_webhook_endpoints (tenant_id, slug, secret, name, enabled)
VALUES ($1::uuid, 'dup-ep-' || right($1::text, 8), 'secret', 'dup', true)
RETURNING id::text`, tenantID).Scan(&endpointID); err != nil {
		t.Fatalf("seed endpoint: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO inbound_events (tenant_id, endpoint_id, headers, body_bytes, signature_valid, source_event_id)
VALUES ($1::uuid, $2::uuid, '{}'::jsonb, 'body'::bytea, true, 'evt-1')`,
		tenantID, endpointID); err != nil {
		t.Fatalf("seed event: %v", err)
	}

	// The exact read the duplicate path performs.
	var id int64
	if err := tx.QueryRow(ctx, `
SELECT id FROM inbound_events
 WHERE endpoint_id = $1::uuid AND source_event_id = $2
 ORDER BY id DESC LIMIT 1 FOR SHARE`, endpointID, "evt-1").Scan(&id); err != nil {
		t.Fatalf("the duplicate path cannot lock the existing event: %v\n"+
			"Every redelivery of an already-recorded webhook fails, and "+
			"redelivery is normal provider behaviour.", err)
	}

	// And the log must still be append-only.
	if _, err := tx.Exec(ctx,
		`UPDATE inbound_events SET signature_valid = false WHERE tenant_id = $1::uuid`,
		tenantID); err == nil {
		t.Fatal("an inbound event was UPDATED. The grant added for row locking " +
			"has become a write capability and the log is no longer append-only.")
	}
}
