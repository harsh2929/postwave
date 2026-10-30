// SPDX-License-Identifier: AGPL-3.0-only

package consent

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// TestConsentReceiptsRejectGenericWorkerBypass proves the post-1979 database
// boundary under the actual non-bypass application role. The generic
// app.outbox_worker GUC is intentionally insufficient; a tenant-bound worker
// sees only its tenant and cannot insert evidence for another tenant.
func TestConsentReceiptsRejectGenericWorkerBypass(t *testing.T) {
	pool := newTrackingTestPool(t)
	ctx := context.Background()
	var (
		role       string
		bypassesRL bool
	)
	if err := pool.QueryRow(ctx, `
SELECT current_user,
       COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false)
`).Scan(&role, &bypassesRL); err != nil {
		t.Fatalf("inspect database role: %v", err)
	}
	if role != "postwave_app" || bypassesRL {
		t.Skipf("DATABASE_URL must use non-bypass postwave_app; got user=%q bypassrls=%v", role, bypassesRL)
	}

	tenantA := uuid.NewString()
	tenantB := uuid.NewString()
	seedTrackingTenant(t, pool, tenantA)
	seedTrackingTenant(t, pool, tenantB)
	for tenantID, email := range map[string]string{
		tenantA: "tenant-a@example.test",
		tenantB: "tenant-b@example.test",
	} {
		if _, err := Record(ctx, pool, RecordInput{
			TenantID: tenantID, SubscriberEmail: email,
			NewState: "subscribed", Source: "api:/test",
		}); err != nil {
			t.Fatalf("seed receipt for %s: %v", tenantID, err)
		}
	}

	workerTx, err := db.WithWorkerScope(ctx, pool)
	if err != nil {
		t.Fatalf("open generic worker scope: %v", err)
	}
	defer func() { _ = workerTx.Rollback(ctx) }()
	var visible int
	if err := workerTx.QueryRow(ctx, `SELECT count(*)::int FROM consent_receipts`).Scan(&visible); err != nil {
		t.Fatalf("generic worker receipt read: %v", err)
	}
	if visible != 0 {
		t.Fatalf("generic outbox worker saw %d consent receipts without a tenant, want 0", visible)
	}
	if _, err := workerTx.Exec(ctx, `
INSERT INTO consent_receipts
       (tenant_id, subscriber_email, new_state, source)
VALUES ($1::uuid, 'forged@example.test', 'subscribed', 'worker')`, tenantA); err == nil {
		t.Fatal("generic outbox worker inserted tenant evidence without tenant scope")
	}
	_ = workerTx.Rollback(ctx)

	tenantWorkerTx, err := db.WithTenantWorker(ctx, pool, tenantA)
	if err != nil {
		t.Fatalf("open tenant worker scope: %v", err)
	}
	defer func() { _ = tenantWorkerTx.Rollback(ctx) }()
	if err := tenantWorkerTx.QueryRow(ctx, `SELECT count(*)::int FROM consent_receipts`).Scan(&visible); err != nil {
		t.Fatalf("tenant worker receipt read: %v", err)
	}
	if visible != 1 {
		t.Fatalf("tenant-A worker saw %d receipts, want only tenant A's one row", visible)
	}
	if _, err := tenantWorkerTx.Exec(ctx, `
INSERT INTO consent_receipts
       (tenant_id, subscriber_email, new_state, source)
VALUES ($1::uuid, 'cross-tenant@example.test', 'subscribed', 'worker')`, tenantB); err == nil {
		t.Fatal("tenant-A worker inserted tenant-B consent evidence")
	}
}

func TestConsentEvidenceDatabaseBoundsRejectRawWriterPoison(t *testing.T) {
	pool := newTrackingTestPool(t)
	ctx := context.Background()
	tenantID := uuid.NewString()
	seedTrackingTenant(t, pool, tenantID)

	tests := []struct {
		name       string
		constraint string
		insert     string
		args       []any
	}{
		{
			name: "event user agent", constraint: "consent_events_read_contract_bounds",
			insert: `INSERT INTO consent_events
  (tenant_id, subject_type, subject_id, channel, category, action, source,
   policy_version, preferences, user_agent)
VALUES ($1::uuid, 'visitor', '0123456789abcdef', 'web', 'analytics', 'denied',
        'cookie_banner', 'v1', '{}'::jsonb, $2)`,
			args: []any{tenantID, strings.Repeat("a", maxConsentUserAgentBytes+1)},
		},
		{
			name: "event preferences scalar", constraint: "consent_events_read_contract_bounds",
			insert: `INSERT INTO consent_events
  (tenant_id, subject_type, subject_id, channel, category, action, source,
   policy_version, preferences)
VALUES ($1::uuid, 'visitor', '0123456789abcdef', 'web', 'analytics', 'denied',
        'cookie_banner', 'v1', '[]'::jsonb)`,
			args: []any{tenantID},
		},
		{
			name: "event missing subject identity", constraint: "consent_events_read_contract_bounds",
			insert: `INSERT INTO consent_events
  (tenant_id, subject_type, channel, category, action, source,
   policy_version, preferences)
VALUES ($1::uuid, 'visitor', 'web', 'analytics', 'denied',
        'cookie_banner', 'v1', '{}'::jsonb)`,
			args: []any{tenantID},
		},
		{
			name: "event nil identity", constraint: "consent_events_read_contract_bounds",
			insert: `INSERT INTO consent_events
  (id, tenant_id, subject_type, subject_id, channel, category, action, source,
   policy_version, preferences)
VALUES ('00000000-0000-0000-0000-000000000000'::uuid, $1::uuid,
        'visitor', '0123456789abcdef', 'web', 'analytics', 'denied',
        'cookie_banner', 'v1', '{}'::jsonb)`,
			args: []any{tenantID},
		},
		{
			name: "event unassigned UUID version", constraint: "consent_events_read_contract_bounds",
			insert: `INSERT INTO consent_events
  (id, tenant_id, subject_type, subject_id, channel, category, action, source,
   policy_version, preferences)
VALUES ('00000000-0000-9000-8000-000000000001'::uuid, $1::uuid,
        'visitor', '0123456789abcdef', 'web', 'analytics', 'denied',
        'cookie_banner', 'v1', '{}'::jsonb)`,
			args: []any{tenantID},
		},
		{
			name: "event nil decision identity", constraint: "consent_events_read_contract_bounds",
			insert: `INSERT INTO consent_events
  (tenant_id, subject_type, subject_id, channel, category, action, source,
   policy_version, preferences, decision_id, request_fingerprint)
VALUES ($1::uuid, 'visitor', '0123456789abcdef', 'web', 'analytics', 'denied',
        'cookie_banner', 'v1', '{}'::jsonb,
        '00000000-0000-0000-0000-000000000000'::uuid, repeat('a', 64))`,
			args: []any{tenantID},
		},
		{
			name: "event decision non-RFC UUID variant", constraint: "consent_events_read_contract_bounds",
			insert: `INSERT INTO consent_events
  (tenant_id, subject_type, subject_id, channel, category, action, source,
   policy_version, preferences, decision_id, request_fingerprint)
VALUES ($1::uuid, 'visitor', '0123456789abcdef', 'web', 'analytics', 'denied',
        'cookie_banner', 'v1', '{}'::jsonb,
        '00000000-0000-8000-7000-000000000001'::uuid, repeat('a', 64))`,
			args: []any{tenantID},
		},
		{
			name: "event infinite chronology", constraint: "consent_events_read_contract_bounds",
			insert: `INSERT INTO consent_events
  (tenant_id, subject_type, subject_id, channel, category, action, source,
   policy_version, preferences, created_at)
VALUES ($1::uuid, 'visitor', '0123456789abcdef', 'web', 'analytics', 'denied',
        'cookie_banner', 'v1', '{}'::jsonb, 'infinity'::timestamptz)`,
			args: []any{tenantID},
		},
		{
			name: "event chronology beyond JSON year", constraint: "consent_events_read_contract_bounds",
			insert: `INSERT INTO consent_events
  (tenant_id, subject_type, subject_id, channel, category, action, source,
   policy_version, preferences, created_at)
VALUES ($1::uuid, 'visitor', '0123456789abcdef', 'web', 'analytics', 'denied',
        'cookie_banner', 'v1', '{}'::jsonb, '10000-01-01 00:00:00+00'::timestamptz)`,
			args: []any{tenantID},
		},
		{
			name: "receipt nonpositive identity", constraint: "consent_receipts_read_contract_bounds",
			insert: `INSERT INTO consent_receipts
  (id, tenant_id, subscriber_email, new_state, source)
VALUES (0, $1::uuid, 'bounded@example.test', 'subscribed', 'api')`,
			args: []any{tenantID},
		},
		{
			name: "receipt source control", constraint: "consent_receipts_read_contract_bounds",
			insert: `INSERT INTO consent_receipts
  (tenant_id, subscriber_email, new_state, source)
VALUES ($1::uuid, 'bounded@example.test', 'subscribed', $2)`,
			args: []any{tenantID, "api\nforged"},
		},
		{
			name: "receipt unicode-spaced source", constraint: "consent_receipts_read_contract_bounds",
			insert: `INSERT INTO consent_receipts
  (tenant_id, subscriber_email, new_state, source)
VALUES ($1::uuid, 'bounded@example.test', 'subscribed', $2)`,
			args: []any{tenantID, "\u00a0api"},
		},
		{
			name: "receipt email with byte-order mark", constraint: "consent_receipts_read_contract_bounds",
			insert: `INSERT INTO consent_receipts
  (tenant_id, subscriber_email, new_state, source)
VALUES ($1::uuid, $2, 'subscribed', 'api')`,
			args: []any{tenantID, "\ufeffbounded@example.test"},
		},
		{
			name: "receipt unicode-whitespace narrative", constraint: "consent_receipts_read_contract_bounds",
			insert: `INSERT INTO consent_receipts
  (tenant_id, subscriber_email, new_state, source, source_detail)
VALUES ($1::uuid, 'bounded@example.test', 'subscribed', 'api', $2)`,
			args: []any{tenantID, "\u00a0"},
		},
		{
			name: "receipt reserved bidi source", constraint: "consent_receipts_read_contract_bounds",
			insert: `INSERT INTO consent_receipts
  (tenant_id, subscriber_email, new_state, source)
VALUES ($1::uuid, 'bounded@example.test', 'subscribed', $2)`,
			args: []any{tenantID, "api\u206a"},
		},
		{
			name: "receipt reserved bidi narrative", constraint: "consent_receipts_read_contract_bounds",
			insert: `INSERT INTO consent_receipts
  (tenant_id, subscriber_email, new_state, source, source_detail)
VALUES ($1::uuid, 'bounded@example.test', 'subscribed', 'api', $2)`,
			args: []any{tenantID, "proof\u206a"},
		},
		{
			name: "receipt byte-order-mark narrative", constraint: "consent_receipts_read_contract_bounds",
			insert: `INSERT INTO consent_receipts
  (tenant_id, subscriber_email, new_state, source, source_detail)
VALUES ($1::uuid, 'bounded@example.test', 'subscribed', 'api', $2)`,
			args: []any{tenantID, "\ufeff"},
		},
		{
			name: "receipt infinite chronology", constraint: "consent_receipts_read_contract_bounds",
			insert: `INSERT INTO consent_receipts
  (tenant_id, subscriber_email, new_state, source, at)
VALUES ($1::uuid, 'bounded@example.test', 'subscribed', 'api', 'infinity'::timestamptz)`,
			args: []any{tenantID},
		},
		{
			name: "receipt Go zero chronology", constraint: "consent_receipts_read_contract_bounds",
			insert: `INSERT INTO consent_receipts
  (tenant_id, subscriber_email, new_state, source, at)
VALUES ($1::uuid, 'bounded@example.test', 'subscribed', 'api',
        '0001-01-01 00:00:00+00'::timestamptz)`,
			args: []any{tenantID},
		},
		{
			name: "proof nil identity", constraint: "consent_records_read_contract_bounds",
			insert: `INSERT INTO consent_records
  (id, tenant_id, email, channel, consent_status, source, evidence)
VALUES ('00000000-0000-0000-0000-000000000000'::uuid, $1::uuid,
        'bounded@example.test', 'email', 'granted', 'api', '{}'::jsonb)`,
			args: []any{tenantID},
		},
		{
			name: "proof non-RFC UUID variant", constraint: "consent_records_read_contract_bounds",
			insert: `INSERT INTO consent_records
  (id, tenant_id, email, channel, consent_status, source, evidence)
VALUES ('00000000-0000-4000-7000-000000000001'::uuid, $1::uuid,
        'bounded@example.test', 'email', 'granted', 'api', '{}'::jsonb)`,
			args: []any{tenantID},
		},
		{
			name: "proof evidence bytes", constraint: "consent_records_read_contract_bounds",
			insert: `INSERT INTO consent_records
  (tenant_id, email, channel, consent_status, source, evidence)
VALUES ($1::uuid, 'bounded@example.test', 'email', 'granted', 'api',
        jsonb_build_object('payload', $2::text))`,
			args: []any{tenantID, strings.Repeat("x", maxConsentPreferencesBytes)},
		},
		{
			name: "proof infinite chronology", constraint: "consent_records_read_contract_bounds",
			insert: `INSERT INTO consent_records
  (tenant_id, email, channel, consent_status, source, evidence, captured_at)
VALUES ($1::uuid, 'bounded@example.test', 'email', 'granted', 'api',
        '{}'::jsonb, 'infinity'::timestamptz)`,
			args: []any{tenantID},
		},
		{
			name: "proof chronology before RFC3339 range", constraint: "consent_records_read_contract_bounds",
			insert: `INSERT INTO consent_records
  (tenant_id, email, channel, consent_status, source, evidence, captured_at)
VALUES ($1::uuid, 'bounded@example.test', 'email', 'granted', 'api',
        '{}'::jsonb, '0001-01-01 00:00:00+00'::timestamptz)`,
			args: []any{tenantID},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			tx, err := db.WithTenant(ctx, pool, tenantID)
			if err != nil {
				t.Fatalf("open tenant transaction: %v", err)
			}
			defer func() { _ = tx.Rollback(ctx) }()
			_, err = tx.Exec(ctx, test.insert, test.args...)
			if err == nil {
				t.Fatal("raw poison row unexpectedly inserted")
			}
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || pgErr.ConstraintName != test.constraint {
				t.Fatalf("error=%v, want constraint %s", err, test.constraint)
			}
		})
	}
}
