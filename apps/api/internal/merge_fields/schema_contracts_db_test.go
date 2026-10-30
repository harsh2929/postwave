// SPDX-License-Identifier: AGPL-3.0-only

package merge_fields

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func seedSchemaContractTenant(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seed: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'merge-field-contract-test', $2, 'studio')`,
		tenantID, "merge-field-contract-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), mergeFieldFixtureCleanupTimeout)
		defer cleanupCancel()
		cleanupTx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			t.Errorf("cleanup tenant scope: %v", cleanupErr)
			return
		}
		defer func() { _ = cleanupTx.Rollback(cleanupCtx) }()
		if _, cleanupErr = cleanupTx.Exec(cleanupCtx,
			`SELECT set_config('app.tenant_cascade_delete', 'on', true)`); cleanupErr != nil {
			t.Errorf("mark tenant cascade cleanup: %v", cleanupErr)
			return
		}
		if _, cleanupErr = cleanupTx.Exec(cleanupCtx,
			`DELETE FROM tenants WHERE id = $1::uuid`, tenantID); cleanupErr != nil {
			t.Errorf("cleanup tenant: %v", cleanupErr)
			return
		}
		if cleanupErr = cleanupTx.Commit(cleanupCtx); cleanupErr != nil {
			t.Errorf("commit tenant cleanup: %v", cleanupErr)
		}
	})
	return tenantID
}

func TestCreateSchemaEnforcesConcurrentTenantCap(t *testing.T) {
	pool := newMergeFieldsTestPool(t)
	tenantID := seedSchemaContractTenant(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for catalog seed: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO merge_field_schema (tenant_id, key, label, type, position)
SELECT $1::uuid,
       'FIELD_' || lpad(series::text, 2, '0'),
       'Field ' || series::text,
       'text',
       series
  FROM generate_series(1, $2::int) AS series`, tenantID, MaxSchemaFields-1); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed catalog boundary: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit catalog boundary: %v", err)
	}

	repo := &Repo{Pool: pool}
	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for index, key := range []string{"LAST_A", "LAST_B"} {
		index, key := index, key
		creatorTenantID := tenantID
		if index == 1 {
			// UUID text is case-insensitive. The lock must use PostgreSQL's
			// canonical UUID rendering so equivalent caller spellings serialize.
			creatorTenantID = strings.ToUpper(tenantID)
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, createErr := repo.CreateSchema(ctx, creatorTenantID, SchemaInput{
				Key: key, Label: "Last field", Type: "text", Position: MaxSchemaFields + index,
			})
			errs <- createErr
		}()
	}
	close(start)
	wg.Wait()
	close(errs)

	var succeeded, limited int
	for createErr := range errs {
		switch {
		case createErr == nil:
			succeeded++
		case errors.Is(createErr, ErrSchemaLimit):
			limited++
		default:
			t.Fatalf("concurrent create error = %v; want nil or ErrSchemaLimit", createErr)
		}
	}
	if succeeded != 1 || limited != 1 {
		t.Fatalf("concurrent results: succeeded=%d limited=%d; want 1/1", succeeded, limited)
	}

	verifyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for count: %v", err)
	}
	var count int
	if err := verifyTx.QueryRow(ctx, `
SELECT count(*)::int FROM merge_field_schema WHERE tenant_id = $1::uuid`, tenantID).Scan(&count); err != nil {
		_ = verifyTx.Rollback(ctx)
		t.Fatalf("count catalog: %v", err)
	}
	if err := verifyTx.Commit(ctx); err != nil {
		t.Fatalf("commit catalog count: %v", err)
	}
	if count != MaxSchemaFields {
		t.Fatalf("catalog count = %d; want %d", count, MaxSchemaFields)
	}
	if _, err := repo.CreateSchema(ctx, tenantID, SchemaInput{
		Key: "FIELD_01", Label: "Duplicate at limit", Type: "text",
	}); !errors.Is(err, ErrKeyConflict) {
		t.Fatalf("full-catalog duplicate error = %v; want ErrKeyConflict", err)
	}
	if _, err := repo.CreateSchema(ctx, tenantID, SchemaInput{
		Key: "OVER_LIMIT", Label: "Over limit", Type: "text",
	}); !errors.Is(err, ErrSchemaLimit) {
		t.Fatalf("full-catalog create error = %v; want ErrSchemaLimit", err)
	}
}

func TestMergeFieldStorageContractsRejectInvalidAppRoleWrites(t *testing.T) {
	pool := newMergeFieldsTestPool(t)
	tenantID := seedSchemaContractTenant(t, pool)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for subscriber seed: %v", err)
	}
	var subscriberID string
	if err := seedTx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'unconfirmed', 'api')
RETURNING id::text`, tenantID, fmt.Sprintf("merge-field-contract-%s@example.test", tenantID[:8])).Scan(&subscriberID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	maxKey := "K" + strings.Repeat("A", MaxKeyLength-1)
	if _, err := seedTx.Exec(ctx, `
INSERT INTO merge_field_schema
       (tenant_id, key, label, type, default_value, position)
VALUES ($1::uuid, $2, $3, 'text', $4, $5),
       ($1::uuid, 'MIN_POSITION', 'Minimum position', 'text', '', $6),
       ($1::uuid, 'NUMBER_VALUE', 'Number value', 'number', '42', 0)`,
		tenantID,
		maxKey,
		strings.Repeat("界", MaxLabelLength),
		strings.Repeat("x", MaxValueLength),
		MaxPosition,
		MinPosition,
	); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("insert valid schema boundaries: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO merge_field_values (tenant_id, subscriber_id, key, value)
VALUES ($1::uuid, $2::uuid, $3, $4)`,
		tenantID, subscriberID, maxKey, strings.Repeat("v", MaxValueLength)); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("insert valid value boundary: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit valid boundaries: %v", err)
	}

	schemaCases := []struct {
		name       string
		key        string
		label      string
		typ        string
		defaultVal string
		position   int
		code       string
		constraint string
	}{
		{name: "lowercase key", key: "lowercase", label: "Lowercase", typ: "text", code: "23514", constraint: "merge_field_schema_key_contract_check"},
		{name: "oversized key", key: "K" + strings.Repeat("A", MaxKeyLength), label: "Oversized key", typ: "text", code: "23514", constraint: "merge_field_schema_key_contract_check"},
		{name: "unicode whitespace label", key: "BLANK_LABEL", label: "\u00a0\u2003\ufeff", typ: "text", code: "23514", constraint: "merge_field_schema_label_contract_check"},
		{name: "oversized label", key: "LONG_LABEL", label: strings.Repeat("界", MaxLabelLength+1), typ: "text", code: "23514", constraint: "merge_field_schema_label_contract_check"},
		{name: "position overflow", key: "BAD_POSITION", label: "Bad position", typ: "text", position: MaxPosition + 1, code: "23514", constraint: "merge_field_schema_position_contract_check"},
		{name: "unnormalized default", key: "PADDED_DEFAULT", label: "Padded default", typ: "text", defaultVal: "\u00a0padded\u2003", code: "23514", constraint: "merge_field_schema_default_contract_check"},
		{name: "invalid typed default", key: "BAD_NUMBER_DEFAULT", label: "Bad number", typ: "number", defaultVal: "not-a-number", code: "PW001"},
		{name: "oversized default", key: "LONG_DEFAULT", label: "Long default", typ: "text", defaultVal: strings.Repeat("x", MaxValueLength+1), code: "PW001"},
	}
	for _, test := range schemaCases {
		t.Run(test.name, func(t *testing.T) {
			expectMergeFieldDirectWriteRejected(t, pool, tenantID, test.code, test.constraint, `
INSERT INTO merge_field_schema
       (tenant_id, key, label, type, default_value, position)
VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
				tenantID, test.key, test.label, test.typ, test.defaultVal, test.position)
		})
	}

	valueCases := []struct {
		name       string
		value      string
		code       string
		constraint string
	}{
		{name: "padded", value: "\u00a042\u2003", code: "23514", constraint: "merge_field_values_value_contract_check"},
		{name: "oversized", value: strings.Repeat("1", MaxValueLength+1), code: "23514", constraint: "merge_field_values_value_contract_check"},
		{name: "invalid typed", value: "not-a-number", code: "PW001"},
	}
	for index, test := range valueCases {
		t.Run("value "+test.name, func(t *testing.T) {
			expectMergeFieldDirectWriteRejected(t, pool, tenantID, test.code, test.constraint, `
INSERT INTO merge_field_values (tenant_id, subscriber_id, key, value)
VALUES ($1::uuid, $2::uuid, 'NUMBER_VALUE', $3)
ON CONFLICT (tenant_id, subscriber_id, key) DO UPDATE
SET value = EXCLUDED.value, updated_at = now() + ($4::int * interval '1 microsecond')`,
				tenantID, subscriberID, test.value, index)
		})
	}

	constraintTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for constraint attestation: %v", err)
	}
	var validated int
	if err := constraintTx.QueryRow(ctx, `
SELECT count(*)::int
  FROM pg_constraint
 WHERE conname IN (
       'merge_field_schema_key_contract_check',
       'merge_field_schema_label_contract_check',
       'merge_field_schema_position_contract_check',
       'merge_field_schema_default_contract_check',
       'merge_field_values_value_contract_check'
   )
   AND convalidated`).Scan(&validated); err != nil {
		_ = constraintTx.Rollback(ctx)
		t.Fatalf("read constraint attestation: %v", err)
	}
	if err := constraintTx.Commit(ctx); err != nil {
		t.Fatalf("commit constraint attestation: %v", err)
	}
	if validated != 5 {
		t.Fatalf("validated merge-field constraints = %d; want 5", validated)
	}
}

func expectMergeFieldDirectWriteRejected(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID, wantCode, wantConstraint, statement string,
	args ...any,
) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for rejected write: %v", err)
	}
	_, writeErr := tx.Exec(ctx, statement, args...)
	_ = tx.Rollback(ctx)
	if writeErr == nil {
		t.Fatal("invalid direct write unexpectedly succeeded")
	}
	var pgErr *pgconn.PgError
	if !errors.As(writeErr, &pgErr) {
		t.Fatalf("direct write error = %v; want PostgreSQL error", writeErr)
	}
	if pgErr.Code != wantCode {
		t.Fatalf("direct write SQLSTATE = %s (%v); want %s", pgErr.Code, writeErr, wantCode)
	}
	if wantConstraint != "" && pgErr.ConstraintName != wantConstraint {
		t.Fatalf("direct write constraint = %q (%v); want %q", pgErr.ConstraintName, writeErr, wantConstraint)
	}
}
