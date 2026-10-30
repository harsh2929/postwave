// SPDX-License-Identifier: AGPL-3.0-only

package merge_fields

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Tenant deletion traverses the fully migrated privacy schema. Keep its bounded
// cleanup budget separate from the short deadlines that assert product behavior.
const mergeFieldFixtureCleanupTimeout = 90 * time.Second

func newMergeFieldsTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed merge-field schema test")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestSchemaMutationsProtectStoredValues(t *testing.T) {
	pool := newMergeFieldsTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	tenantID := uuid.NewString()
	slug := "merge-fields-" + tenantID[:8]

	seedTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seeding: %v", err)
	}
	if _, err := seedTx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'merge-fields-test', $2, 'studio')`, tenantID, slug); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	var subscriberID string
	if err := seedTx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'unconfirmed', 'api')
RETURNING id::text`, tenantID, fmt.Sprintf("merge-field-%s@example.test", tenantID[:8])).Scan(&subscriberID); err != nil {
		_ = seedTx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	if err := seedTx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), mergeFieldFixtureCleanupTimeout)
		defer cleanupCancel()
		cleanupTx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			t.Errorf("cleanup scope: %v", cleanupErr)
			return
		}
		defer func() { _ = cleanupTx.Rollback(cleanupCtx) }()
		if _, cleanupErr = cleanupTx.Exec(cleanupCtx, `SELECT set_config('app.tenant_cascade_delete', 'on', true)`); cleanupErr != nil {
			t.Errorf("mark tenant cleanup: %v", cleanupErr)
			return
		}
		if _, cleanupErr = cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); cleanupErr != nil {
			t.Errorf("cleanup tenant: %v", cleanupErr)
			return
		}
		if cleanupErr = cleanupTx.Commit(cleanupCtx); cleanupErr != nil {
			t.Errorf("cleanup commit: %v", cleanupErr)
		}
	})

	repo := &Repo{Pool: pool}
	created, err := repo.CreateSchema(ctx, tenantID, SchemaInput{
		Key: "FNAME", Label: "First name", Type: "text", DefaultValue: "Friend", Position: 1,
	})
	if err != nil {
		t.Fatalf("create schema: %v", err)
	}
	if created.ValueCount != 0 {
		t.Fatalf("created value_count = %d; want 0", created.ValueCount)
	}

	// Simulate a pre-change application instance that still writes only the
	// sidecar. The reverse compatibility trigger must populate canonical JSONB
	// before a new instance can read it.
	legacyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for legacy fixture: %v", err)
	}
	if _, err := legacyTx.Exec(ctx, `
INSERT INTO merge_field_values (tenant_id, subscriber_id, key, value)
VALUES ($1::uuid, $2::uuid, 'FNAME', 'Legacy')`, tenantID, subscriberID); err != nil {
		_ = legacyTx.Rollback(ctx)
		t.Fatalf("seed legacy sidecar value: %v", err)
	}
	var legacyCanonical string
	if err := legacyTx.QueryRow(ctx, `
SELECT merge_fields ->> 'FNAME'
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID).Scan(&legacyCanonical); err != nil {
		_ = legacyTx.Rollback(ctx)
		t.Fatalf("read reverse-synchronized canonical value: %v", err)
	}
	if legacyCanonical != "Legacy" {
		_ = legacyTx.Rollback(ctx)
		t.Fatalf("reverse-synchronized FNAME = %q; want Legacy", legacyCanonical)
	}
	if err := legacyTx.Commit(ctx); err != nil {
		t.Fatalf("commit legacy fixture: %v", err)
	}

	// subscribers.merge_fields is the compatibility source used by imports,
	// search, exports, and message rendering. A canonical-only writer must also
	// update the sidecar so rolling versions cannot diverge.
	canonicalTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for canonical fixture: %v", err)
	}
	if _, err := canonicalTx.Exec(ctx, `
UPDATE subscribers
   SET merge_fields = jsonb_build_object('FNAME', 'Grace')
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID); err != nil {
		_ = canonicalTx.Rollback(ctx)
		t.Fatalf("seed canonical merge field: %v", err)
	}
	if err := canonicalTx.Commit(ctx); err != nil {
		t.Fatalf("commit canonical fixture: %v", err)
	}
	forwardVerifyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for forward-sync verification: %v", err)
	}
	var forwardSidecar string
	if err := forwardVerifyTx.QueryRow(ctx, `
SELECT value
  FROM merge_field_values
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND key = 'FNAME'`,
		tenantID, subscriberID).Scan(&forwardSidecar); err != nil {
		_ = forwardVerifyTx.Rollback(ctx)
		t.Fatalf("read forward-synchronized sidecar: %v", err)
	}
	if forwardSidecar != "Grace" {
		_ = forwardVerifyTx.Rollback(ctx)
		t.Fatalf("forward-synchronized sidecar = %q; want Grace", forwardSidecar)
	}
	if err := forwardVerifyTx.Commit(ctx); err != nil {
		t.Fatalf("commit forward-sync verification: %v", err)
	}

	// A rolling old writer owns the sidecar tuple before its AFTER trigger
	// reaches canonical storage. A concurrent canonical writer must not form a
	// subscriber↔sidecar deadlock: the old transaction fails retryably and the
	// canonical transaction commits both stores.
	legacyRaceTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for legacy race: %v", err)
	}
	if _, err := legacyRaceTx.Exec(ctx, `
SELECT value
  FROM merge_field_values
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND key = 'FNAME'
 FOR UPDATE`, tenantID, subscriberID); err != nil {
		_ = legacyRaceTx.Rollback(ctx)
		t.Fatalf("lock legacy sidecar row: %v", err)
	}
	canonicalRaceResult := make(chan error, 1)
	go func() {
		raceTx, raceErr := db.WithTenant(ctx, pool, tenantID)
		if raceErr != nil {
			canonicalRaceResult <- raceErr
			return
		}
		defer func() { _ = raceTx.Rollback(ctx) }()
		if _, raceErr = raceTx.Exec(ctx, `
UPDATE subscribers
   SET merge_fields = jsonb_build_object('FNAME', 'RaceCanonical')
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID); raceErr != nil {
			canonicalRaceResult <- raceErr
			return
		}
		canonicalRaceResult <- raceTx.Commit(ctx)
	}()
	time.Sleep(150 * time.Millisecond)
	_, legacyRaceErr := legacyRaceTx.Exec(ctx, `
UPDATE merge_field_values
   SET value = 'RaceLegacy'
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND key = 'FNAME'`, tenantID, subscriberID)
	var serializationErr *pgconn.PgError
	if !errors.As(legacyRaceErr, &serializationErr) || serializationErr.Code != "40001" {
		_ = legacyRaceTx.Rollback(ctx)
		t.Fatalf("legacy race error = %v; want SQLSTATE 40001", legacyRaceErr)
	}
	_ = legacyRaceTx.Rollback(ctx)
	select {
	case raceErr := <-canonicalRaceResult:
		if raceErr != nil {
			t.Fatalf("canonical race write: %v", raceErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("canonical race writer did not settle after old writer rollback")
	}
	raceVerifyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for race verification: %v", err)
	}
	var raceCanonical, raceSidecar string
	if err := raceVerifyTx.QueryRow(ctx, `
SELECT subscriber.merge_fields ->> 'FNAME', value.value
  FROM subscribers subscriber
  JOIN merge_field_values value
    ON value.tenant_id = subscriber.tenant_id
   AND value.subscriber_id = subscriber.id
   AND value.key = 'FNAME'
 WHERE subscriber.tenant_id = $1::uuid AND subscriber.id = $2::uuid`,
		tenantID, subscriberID).Scan(&raceCanonical, &raceSidecar); err != nil {
		_ = raceVerifyTx.Rollback(ctx)
		t.Fatalf("read race result: %v", err)
	}
	if raceCanonical != "RaceCanonical" || raceSidecar != "RaceCanonical" {
		_ = raceVerifyTx.Rollback(ctx)
		t.Fatalf("race result = %q/%q; want RaceCanonical/RaceCanonical", raceCanonical, raceSidecar)
	}
	if err := raceVerifyTx.Commit(ctx); err != nil {
		t.Fatalf("commit race verification: %v", err)
	}

	listed, err := repo.ListSchema(ctx, tenantID)
	if err != nil {
		t.Fatalf("list schema: %v", err)
	}
	if len(listed) != 1 || listed[0].ValueCount != 1 {
		t.Fatalf("list = %#v; want one field with value_count=1", listed)
	}
	values, err := repo.GetSubscriberValues(ctx, tenantID, subscriberID)
	if err != nil {
		t.Fatalf("get canonical subscriber value: %v", err)
	}
	if got := values["FNAME"]; got != "RaceCanonical" {
		t.Fatalf("canonical FNAME = %#v; want RaceCanonical", got)
	}

	// Editor writes must update both stores atomically so legacy sidecar readers
	// and the canonical application paths cannot diverge.
	values, err = repo.PatchSubscriberValues(ctx, tenantID, subscriberID, map[string]any{"FNAME": "Ada"})
	if err != nil {
		t.Fatalf("set subscriber value: %v", err)
	}
	if got := values["FNAME"]; got != "Ada" {
		t.Fatalf("patched FNAME = %#v; want Ada", got)
	}
	verifyTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for dual-write verification: %v", err)
	}
	var canonicalValue, sidecarValue string
	if err := verifyTx.QueryRow(ctx, `
SELECT subscriber.merge_fields ->> 'FNAME', value.value
  FROM subscribers subscriber
  JOIN merge_field_values value
    ON value.tenant_id = subscriber.tenant_id
   AND value.subscriber_id = subscriber.id
   AND value.key = 'FNAME'
 WHERE subscriber.tenant_id = $1::uuid AND subscriber.id = $2::uuid`,
		tenantID, subscriberID).Scan(&canonicalValue, &sidecarValue); err != nil {
		_ = verifyTx.Rollback(ctx)
		t.Fatalf("verify dual write: %v", err)
	}
	if canonicalValue != "Ada" || sidecarValue != "Ada" {
		_ = verifyTx.Rollback(ctx)
		t.Fatalf("dual write = canonical %q, sidecar %q; want Ada/Ada", canonicalValue, sidecarValue)
	}
	if err := verifyTx.Commit(ctx); err != nil {
		t.Fatalf("commit dual-write verification: %v", err)
	}

	// The sidecar tuple identifies the exact canonical JSON location. Legacy
	// writers may update its value, but must not move a row and strand the OLD
	// canonical key behind.
	if _, err := repo.CreateSchema(ctx, tenantID, SchemaInput{
		Key: "MOVED", Label: "Moved destination", Type: "text", Position: 2,
	}); err != nil {
		t.Fatalf("create valid sidecar identity destination: %v", err)
	}
	identityTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for sidecar identity guard: %v", err)
	}
	_, identityErr := identityTx.Exec(ctx, `
UPDATE merge_field_values
   SET key = 'MOVED'
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND key = 'FNAME'`, tenantID, subscriberID)
	_ = identityTx.Rollback(ctx)
	var identityPGErr *pgconn.PgError
	if !errors.As(identityErr, &identityPGErr) || identityPGErr.Code != "PW001" {
		t.Fatalf("sidecar identity update error = %v; want PW001", identityErr)
	}
	if err := repo.DeleteSchema(ctx, tenantID, "MOVED"); err != nil {
		t.Fatalf("delete sidecar identity destination: %v", err)
	}

	numberType := "number"
	if _, err := repo.PatchSchema(ctx, tenantID, "FNAME", SchemaPatch{Type: &numberType}); !errors.Is(err, ErrFieldInUse) {
		t.Fatalf("type change error = %v; want ErrFieldInUse", err)
	}
	if err := repo.DeleteSchema(ctx, tenantID, "FNAME"); !errors.Is(err, ErrFieldInUse) {
		t.Fatalf("delete error = %v; want ErrFieldInUse", err)
	}

	updatedLabel := "Given name"
	required := true
	updated, err := repo.PatchSchema(ctx, tenantID, "FNAME", SchemaPatch{
		Label: &updatedLabel, Required: &required,
	})
	if err != nil {
		t.Fatalf("safe label patch: %v", err)
	}
	if updated.Label != updatedLabel || updated.ValueCount != 1 {
		t.Fatalf("updated = %#v; want label and value_count=1", updated)
	}
	for name, statement := range map[string]string{
		"empty update": `UPDATE merge_field_values SET value = ''
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND key = 'FNAME'`,
		"delete": `DELETE FROM merge_field_values
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND key = 'FNAME'`,
	} {
		name, statement := name, statement
		t.Run("legacy required clear "+name, func(t *testing.T) {
			legacyClearTx, scopeErr := db.WithTenant(ctx, pool, tenantID)
			if scopeErr != nil {
				t.Fatalf("tenant scope: %v", scopeErr)
			}
			_, clearErr := legacyClearTx.Exec(ctx, statement, tenantID, subscriberID)
			_ = legacyClearTx.Rollback(ctx)
			var pgErr *pgconn.PgError
			if !errors.As(clearErr, &pgErr) || pgErr.Code != "PW001" {
				t.Fatalf("error = %v; want PW001", clearErr)
			}
		})
	}
	if _, err := repo.PatchSubscriberValues(ctx, tenantID, subscriberID, map[string]any{"FNAME": ""}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("clear required value error = %v; want ErrInvalidInput", err)
	}
	required = false
	if _, err := repo.PatchSchema(ctx, tenantID, "FNAME", SchemaPatch{Required: &required}); err != nil {
		t.Fatalf("make field optional: %v", err)
	}
	canonicalClearCases := []struct {
		name       string
		expression string
	}{
		{name: "empty string", expression: `jsonb_build_object('FNAME', '')`},
		{name: "json null", expression: `jsonb_build_object('FNAME', null)`},
	}
	for index, testCase := range canonicalClearCases {
		name, expression := testCase.name, testCase.expression
		canonicalClearTx, scopeErr := db.WithTenant(ctx, pool, tenantID)
		if scopeErr != nil {
			t.Fatalf("tenant scope for canonical %s clear: %v", name, scopeErr)
		}
		if _, scopeErr = canonicalClearTx.Exec(ctx, `
UPDATE subscribers SET merge_fields = `+expression+`
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID); scopeErr != nil {
			_ = canonicalClearTx.Rollback(ctx)
			t.Fatalf("canonical %s clear: %v", name, scopeErr)
		}
		var hasCanonicalKey bool
		var remainingSidecars int
		if scopeErr = canonicalClearTx.QueryRow(ctx, `
SELECT COALESCE(subscriber.merge_fields, '{}'::jsonb) ? 'FNAME',
       (SELECT count(*) FROM merge_field_values value
         WHERE value.tenant_id = subscriber.tenant_id
           AND value.subscriber_id = subscriber.id
           AND value.key = 'FNAME')
  FROM subscribers subscriber
 WHERE subscriber.tenant_id = $1::uuid AND subscriber.id = $2::uuid`,
			tenantID, subscriberID).Scan(&hasCanonicalKey, &remainingSidecars); scopeErr != nil {
			_ = canonicalClearTx.Rollback(ctx)
			t.Fatalf("verify canonical %s clear: %v", name, scopeErr)
		}
		if hasCanonicalKey || remainingSidecars != 0 {
			_ = canonicalClearTx.Rollback(ctx)
			t.Fatalf("canonical %s clear left key=%t sidecars=%d", name, hasCanonicalKey, remainingSidecars)
		}
		if scopeErr = canonicalClearTx.Commit(ctx); scopeErr != nil {
			t.Fatalf("commit canonical %s clear: %v", name, scopeErr)
		}
		if index < len(canonicalClearCases)-1 {
			if _, err := repo.PatchSubscriberValues(ctx, tenantID, subscriberID, map[string]any{"FNAME": "Ada"}); err != nil {
				t.Fatalf("restore FNAME between canonical clear cases: %v", err)
			}
		}
	}

	if _, err := repo.PatchSubscriberValues(ctx, tenantID, subscriberID, map[string]any{"FNAME": ""}); err != nil {
		t.Fatalf("clear subscriber value: %v", err)
	}
	clearTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for clear verification: %v", err)
	}
	var canonicalHasKey bool
	var sidecarCount int
	if err := clearTx.QueryRow(ctx, `
SELECT COALESCE(merge_fields, '{}'::jsonb) ? 'FNAME'
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID).Scan(&canonicalHasKey); err != nil {
		_ = clearTx.Rollback(ctx)
		t.Fatalf("verify canonical clear: %v", err)
	}
	if err := clearTx.QueryRow(ctx, `
SELECT count(*)
  FROM merge_field_values
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND key = 'FNAME'`,
		tenantID, subscriberID).Scan(&sidecarCount); err != nil {
		_ = clearTx.Rollback(ctx)
		t.Fatalf("verify sidecar clear: %v", err)
	}
	if canonicalHasKey || sidecarCount != 0 {
		_ = clearTx.Rollback(ctx)
		t.Fatalf("clear left canonical=%t sidecar_count=%d; want false/0", canonicalHasKey, sidecarCount)
	}
	if err := clearTx.Commit(ctx); err != nil {
		t.Fatalf("commit clear verification: %v", err)
	}

	// A writer that has already changed canonical JSON holds a shared schema
	// lock through the forward trigger. Delete must wait, take a fresh snapshot
	// after that writer commits, and reject rather than deleting the schema.
	writerTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for concurrent writer: %v", err)
	}
	if _, err := writerTx.Exec(ctx, `
UPDATE subscribers
   SET merge_fields = jsonb_build_object('FNAME', 'Concurrent')
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID); err != nil {
		_ = writerTx.Rollback(ctx)
		t.Fatalf("stage concurrent canonical write: %v", err)
	}
	deleteResult := make(chan error, 1)
	go func() {
		deleteResult <- repo.DeleteSchema(ctx, tenantID, "FNAME")
	}()
	select {
	case early := <-deleteResult:
		_ = writerTx.Rollback(ctx)
		t.Fatalf("delete completed before writer settlement: %v", early)
	case <-time.After(150 * time.Millisecond):
	}
	if err := writerTx.Commit(ctx); err != nil {
		t.Fatalf("commit concurrent writer: %v", err)
	}
	select {
	case deleteErr := <-deleteResult:
		if !errors.Is(deleteErr, ErrFieldInUse) {
			t.Fatalf("post-writer delete error = %v; want ErrFieldInUse", deleteErr)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("delete did not settle after concurrent writer committed")
	}
	if _, err := repo.PatchSubscriberValues(ctx, tenantID, subscriberID, map[string]any{"FNAME": ""}); err != nil {
		t.Fatalf("clear concurrent subscriber value: %v", err)
	}

	if err := repo.DeleteSchema(ctx, tenantID, "FNAME"); err != nil {
		t.Fatalf("delete unused field: %v", err)
	}
	listed, err = repo.ListSchema(ctx, tenantID)
	if err != nil {
		t.Fatalf("list after delete: %v", err)
	}
	if len(listed) != 0 {
		t.Fatalf("list after delete = %#v; want empty", listed)
	}

	// Schema creation must inspect canonical values that predate the schema,
	// reject an incompatible declaration, and return truthful usage when valid.
	preexistingTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for preexisting value: %v", err)
	}
	if _, err := preexistingTx.Exec(ctx, `
UPDATE subscribers
   SET merge_fields = jsonb_build_object('AGE', 'not-a-number')
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID); err != nil {
		_ = preexistingTx.Rollback(ctx)
		t.Fatalf("seed preexisting canonical value: %v", err)
	}
	if err := preexistingTx.Commit(ctx); err != nil {
		t.Fatalf("commit preexisting canonical value: %v", err)
	}
	if _, err := repo.CreateSchema(ctx, tenantID, SchemaInput{
		Key: "AGE", Label: "Age", Type: "number",
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("incompatible schema create error = %v; want ErrInvalidInput", err)
	}
	ageField, err := repo.CreateSchema(ctx, tenantID, SchemaInput{
		Key: "AGE", Label: "Age", Type: "text",
	})
	if err != nil {
		t.Fatalf("create compatible schema over canonical value: %v", err)
	}
	if ageField.ValueCount != 1 {
		t.Fatalf("created AGE value_count = %d; want 1", ageField.ValueCount)
	}
	backfillTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for schema-create backfill: %v", err)
	}
	var backfilledAge string
	if err := backfillTx.QueryRow(ctx, `
SELECT value
  FROM merge_field_values
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND key = 'AGE'`,
		tenantID, subscriberID).Scan(&backfilledAge); err != nil {
		_ = backfillTx.Rollback(ctx)
		t.Fatalf("read schema-create sidecar backfill: %v", err)
	}
	if backfilledAge != "not-a-number" {
		_ = backfillTx.Rollback(ctx)
		t.Fatalf("backfilled AGE = %q; want not-a-number", backfilledAge)
	}
	if err := backfillTx.Commit(ctx); err != nil {
		t.Fatalf("commit schema-create backfill verification: %v", err)
	}
	if _, err := repo.PatchSubscriberValues(ctx, tenantID, subscriberID, map[string]any{"AGE": ""}); err != nil {
		t.Fatalf("clear AGE: %v", err)
	}
	if err := repo.DeleteSchema(ctx, tenantID, "AGE"); err != nil {
		t.Fatalf("delete AGE: %v", err)
	}

	invalidDefaultTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for direct invalid default insert: %v", err)
	}
	_, invalidDefaultErr := invalidDefaultTx.Exec(ctx, `
INSERT INTO merge_field_schema
    (tenant_id, key, label, type, default_value)
VALUES ($1::uuid, 'BADDEFAULT', 'Bad default', 'number', 'not-a-number')`, tenantID)
	_ = invalidDefaultTx.Rollback(ctx)
	var invalidDefaultPGErr *pgconn.PgError
	if !errors.As(invalidDefaultErr, &invalidDefaultPGErr) || invalidDefaultPGErr.Code != "PW001" {
		t.Fatalf("direct invalid default insert error = %v; want PW001", invalidDefaultErr)
	}
	if _, err := repo.CreateSchema(ctx, tenantID, SchemaInput{
		Key: "GOODDEFAULT", Label: "Good default", Type: "number", DefaultValue: "1",
	}); err != nil {
		t.Fatalf("create schema for direct default update: %v", err)
	}
	invalidUpdateTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for direct invalid default update: %v", err)
	}
	_, invalidUpdateErr := invalidUpdateTx.Exec(ctx, `
UPDATE merge_field_schema
   SET default_value = 'NaN'
 WHERE tenant_id = $1::uuid AND key = 'GOODDEFAULT'`, tenantID)
	_ = invalidUpdateTx.Rollback(ctx)
	invalidDefaultPGErr = nil
	if !errors.As(invalidUpdateErr, &invalidDefaultPGErr) || invalidDefaultPGErr.Code != "PW001" {
		t.Fatalf("direct invalid default update error = %v; want PW001", invalidUpdateErr)
	}
	if err := repo.DeleteSchema(ctx, tenantID, "GOODDEFAULT"); err != nil {
		t.Fatalf("delete GOODDEFAULT: %v", err)
	}

	constraintTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for constraint validation check: %v", err)
	}
	var validatedConstraintCount int
	if err := constraintTx.QueryRow(ctx, `
SELECT count(*)
  FROM pg_constraint
 WHERE conname IN (
           'subscribers_merge_fields_object_check',
           'merge_field_values_tenant_subscriber_fkey'
       )
   AND convalidated`).Scan(&validatedConstraintCount); err != nil {
		_ = constraintTx.Rollback(ctx)
		t.Fatalf("read merge-field constraint validation: %v", err)
	}
	if validatedConstraintCount != 2 {
		_ = constraintTx.Rollback(ctx)
		t.Fatalf("validated constraints = %d; want 2", validatedConstraintCount)
	}
	if err := constraintTx.Commit(ctx); err != nil {
		t.Fatalf("commit constraint validation check: %v", err)
	}

	// The now-validated object constraint protects every new write and proves
	// the pre-rollout population was clean.
	shapeTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for object-shape check: %v", err)
	}
	if _, err := shapeTx.Exec(ctx, `
UPDATE subscribers SET merge_fields = '[]'::jsonb
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, subscriberID); err == nil {
		_ = shapeTx.Rollback(ctx)
		t.Fatal("non-object merge_fields update unexpectedly succeeded")
	}
	_ = shapeTx.Rollback(ctx)

	// The sidecar's composite FK must reject a row whose tenant and subscriber
	// independently exist but belong to different workspaces.
	otherTenantID := uuid.NewString()
	otherTx, err := db.WithTenant(ctx, pool, otherTenantID)
	if err != nil {
		t.Fatalf("tenant scope for cross-tenant fixture: %v", err)
	}
	if _, err := otherTx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'merge-fields-other', $2, 'studio')`, otherTenantID, "merge-fields-other-"+otherTenantID[:8]); err != nil {
		_ = otherTx.Rollback(ctx)
		t.Fatalf("seed other tenant: %v", err)
	}
	var otherSubscriberID string
	if err := otherTx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'unconfirmed', 'api')
RETURNING id::text`, otherTenantID, fmt.Sprintf("merge-field-other-%s@example.test", otherTenantID[:8])).Scan(&otherSubscriberID); err != nil {
		_ = otherTx.Rollback(ctx)
		t.Fatalf("seed other subscriber: %v", err)
	}
	if err := otherTx.Commit(ctx); err != nil {
		t.Fatalf("commit other tenant fixture: %v", err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), mergeFieldFixtureCleanupTimeout)
		defer cleanupCancel()
		cleanupTx, cleanupErr := db.WithTenant(cleanupCtx, pool, otherTenantID)
		if cleanupErr != nil {
			t.Errorf("other cleanup scope: %v", cleanupErr)
			return
		}
		defer func() { _ = cleanupTx.Rollback(cleanupCtx) }()
		if _, cleanupErr = cleanupTx.Exec(cleanupCtx, `SELECT set_config('app.tenant_cascade_delete', 'on', true)`); cleanupErr != nil {
			t.Errorf("mark other tenant cleanup: %v", cleanupErr)
			return
		}
		if _, cleanupErr = cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, otherTenantID); cleanupErr != nil {
			t.Errorf("cleanup other tenant: %v", cleanupErr)
			return
		}
		if cleanupErr = cleanupTx.Commit(cleanupCtx); cleanupErr != nil {
			t.Errorf("commit other cleanup: %v", cleanupErr)
		}
	}()
	if _, err := repo.CreateSchema(ctx, tenantID, SchemaInput{
		Key: "CROSS", Label: "Cross-tenant guard", Type: "text",
	}); err != nil {
		t.Fatalf("create cross-tenant guard schema: %v", err)
	}
	crossTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for cross-tenant write: %v", err)
	}
	_, crossErr := crossTx.Exec(ctx, `
INSERT INTO merge_field_values (tenant_id, subscriber_id, key, value)
VALUES ($1::uuid, $2::uuid, 'CROSS', 'blocked')`, tenantID, otherSubscriberID)
	_ = crossTx.Rollback(ctx)
	if crossErr == nil {
		t.Fatal("cross-tenant sidecar reference unexpectedly succeeded")
	}
	if err := repo.DeleteSchema(ctx, tenantID, "CROSS"); err != nil {
		t.Fatalf("delete cross-tenant guard schema: %v", err)
	}

	missingSubscriberID := uuid.NewString()
	if _, err := repo.GetSubscriberValues(ctx, tenantID, missingSubscriberID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get missing subscriber error = %v; want ErrNotFound", err)
	}
	if _, err := repo.PatchSubscriberValues(ctx, tenantID, missingSubscriberID, map[string]any{"FNAME": "Nope"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("patch missing subscriber error = %v; want ErrNotFound", err)
	}
}

func TestCreateSchemaRejectsInvalidTypedDefaultBeforeWrite(t *testing.T) {
	repo := &Repo{}
	if _, err := repo.CreateSchema(context.Background(), uuid.NewString(), SchemaInput{
		Key: "BIRTHDAY", Label: "Birthday", Type: "date", DefaultValue: "2026-02-31",
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("error = %v; want ErrInvalidInput", err)
	}
}
