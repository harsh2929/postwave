// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/migrationrunner"
	"github.com/postwave/postwave/apps/api/internal/testsupport/privatedb"
)

// TestRoute42OverlayMigrationHistoricalAndMixedVersionContract runs the real
// ordered migration chain around 1994. It proves that an old schema rejects
// new overlay-aware writers transactionally, historical expired non-manual
// authority becomes an active review hold, and old writers remain safe and
// available after the schema lands.
func TestRoute42OverlayMigrationHistoricalAndMixedVersionContract(t *testing.T) {
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		adminURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL or DATABASE_URL is required")
	}

	files, err := privatedb.History()
	if err != nil {
		t.Fatal(err)
	}
	baseline := make([]migrationrunner.MigrationFile, 0, len(files))
	var target migrationrunner.MigrationFile
	for _, file := range files {
		if file.Version == "1994_sms_suppression_manual_overlay" {
			target = file
			break
		}
		baseline = append(baseline, file)
	}
	if target.Version == "" || len(baseline) == 0 {
		t.Fatalf("migration 1994 not found after an ordered baseline (%d earlier migrations)", len(baseline))
	}
	// The database stops at 1993, the complete ordered baseline, so the old
	// schema can be exercised before this test applies 1994 itself. It is
	// dropped when the test ends, after the pool below closes.
	private := privatedb.ForTest(t, adminURL, privatedb.Spec{
		Prefix:     "postwave_1994_sms_overlay_",
		Label:      "migration 1994 database",
		Migrations: baseline,
		Check:      privatedb.Applied(baseline[len(baseline)-1].Version),
	})
	pool := private.Connect(t, adminURL, "administrative")

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	store := &Store{Pool: pool}
	tenantID := uuid.NewString()
	manualPhone := "+14155550101"
	expiredPhone := "+14155550102"
	preSchemaAddPhone := "+14155550103"
	preSchemaSTOPPhone := "+14155550104"
	oldFreshSTOPPhone := "+14155550105"
	var historicalQuietID string
	var historicalQuietVersion time.Time
	var disabledHistoricalQuietID string
	var disabledHistoricalQuietVersion time.Time
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO tenants (id,name,slug,tier)
		VALUES ($1::uuid,'route42 migration contract','route42-1994-' || $1::text,'studio')`, tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed migration tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO sms_suppressions
			(tenant_id,phone_e164,phone,reason,source,source_event_id,metadata,expires_at)
		VALUES
			($1::uuid,$2,$2,'manual','manual',NULL,$4::jsonb,NULL),
			($1::uuid,$3,$3,'stop_keyword','twilio','historical-expired-stop','{}'::jsonb,clock_timestamp()-interval '1 day')`,
		tenantID, manualPhone, expiredPhone, `{"phone":"`+manualPhone+`","secret":"historical-manual-pii"}`); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed pre-1994 suppression rows: %v", err)
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO sms_quiet_hours
			(tenant_id,label,country_code,start_local,end_local,days,timezone,enabled)
		VALUES ($1::uuid,'historical scoped rule','US',time '21:00',time '09:00',ARRAY[1]::int[],'UTC',true)
		RETURNING id::text,updated_at`, tenantID).Scan(&historicalQuietID, &historicalQuietVersion); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed pre-1994 country-scoped quiet-hours row: %v", err)
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO sms_quiet_hours
			(tenant_id,label,country_code,start_local,end_local,days,timezone,enabled)
		VALUES ($1::uuid,'disabled historical scoped rule','CA',time '21:00',time '09:00',ARRAY[1]::int[],'UTC',false)
		RETURNING id::text,updated_at`, tenantID).Scan(&disabledHistoricalQuietID, &disabledHistoricalQuietVersion); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed pre-1994 disabled country-scoped quiet-hours row: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	// Deployment must be schema-first. Both overlay-aware writers fail inside
	// their tenant transaction against 1993, leaving no partial authority or
	// inbound/evidence rows for an old schema to misinterpret.
	if _, err := store.AddSuppression(ctx, tenantID, preSchemaAddPhone, "manual", nil); err == nil || !strings.Contains(err.Error(), "manual_overlay_state") {
		t.Fatalf("new AddSuppression against old schema error = %v, want missing overlay column", err)
	}
	if _, _, _, err := store.RecordInbound(ctx, tenantID, "", ProviderTwilio, preSchemaSTOPPhone, "STOP", "pre-schema-stop", nil); err == nil || !strings.Contains(err.Error(), "manual_overlay_state") {
		t.Fatalf("new STOP writer against old schema error = %v, want missing overlay column", err)
	}
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var partialRows int
	if err := tx.QueryRow(ctx, `SELECT
		(SELECT count(*) FROM sms_suppressions WHERE tenant_id=$1::uuid AND phone_e164 IN ($2,$3)) +
		(SELECT count(*) FROM sms_messages WHERE tenant_id=$1::uuid AND phone_e164=$3) +
		(SELECT count(*) FROM sms_consent_events WHERE tenant_id=$1::uuid AND phone_e164=$3)`,
		tenantID, preSchemaAddPhone, preSchemaSTOPPhone).Scan(&partialRows); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("read old-schema rollback state: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if partialRows != 0 {
		t.Fatalf("new writers left %d partial rows on the old schema", partialRows)
	}

	allThroughTarget := append(append([]migrationrunner.MigrationFile{}, baseline...), target)
	if err = migrationrunner.RunWithOptions(ctx, pool, allThroughTarget, logger, migrationrunner.RunOptions{AllowUnsafe: true}); err != nil {
		t.Fatalf("apply ordered migration 1994: %v", err)
	}

	// The migration preserves historical rows but gives mixed-version and raw
	// SQL writers the same reconciliation boundary as the Route42 handler. A
	// country-only clear cannot widen an enabled scoped row into a tenant-global
	// rule, and no post-migration write may retain or create unsupported scope.
	assertCountryWriteHeld := func(name, statement string, args ...any) {
		t.Helper()
		guardTx, guardErr := db.WithTenant(ctx, pool, tenantID)
		if guardErr != nil {
			t.Fatal(guardErr)
		}
		_, guardErr = guardTx.Exec(ctx, statement, args...)
		_ = guardTx.Rollback(ctx)
		var pgErr *pgconn.PgError
		if !errors.As(guardErr, &pgErr) || pgErr.Code != "23514" ||
			pgErr.ConstraintName != "sms_quiet_hours_country_scope_write_guard" {
			t.Fatalf("%s error = %v, want country-scope write guard", name, guardErr)
		}
	}
	assertCountryWriteHeld("country-only clear", `UPDATE sms_quiet_hours
		SET country_code='' WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, historicalQuietID)
	assertCountryWriteHeld("retained scoped mutation", `UPDATE sms_quiet_hours
		SET label='old writer mutation' WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, historicalQuietID)
	assertCountryWriteHeld("disabled scoped row clear-and-enable", `UPDATE sms_quiet_hours
		SET country_code='',enabled=true WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, disabledHistoricalQuietID)
	assertCountryWriteHeld("new scoped insert", `INSERT INTO sms_quiet_hours
		(tenant_id,label,country_code,start_local,end_local,days,timezone,enabled)
		VALUES ($1::uuid,'new scoped row','CA',time '21:00',time '09:00',ARRAY[1]::int[],'UTC',false)`, tenantID)
	historicalQuiet, err := store.GetQuietHours(ctx, tenantID, historicalQuietID)
	if err != nil || historicalQuiet.CountryCode != "US" || !historicalQuiet.Enabled ||
		!historicalQuiet.UpdatedAt.Equal(historicalQuietVersion) || historicalQuiet.Label != "historical scoped rule" {
		t.Fatalf("rejected historical quiet-hours writes changed row: %#v err=%v", historicalQuiet, err)
	}
	disabledHistoricalQuiet, err := store.GetQuietHours(ctx, tenantID, disabledHistoricalQuietID)
	if err != nil || disabledHistoricalQuiet.CountryCode != "CA" || disabledHistoricalQuiet.Enabled ||
		!disabledHistoricalQuiet.UpdatedAt.Equal(disabledHistoricalQuietVersion) ||
		disabledHistoricalQuiet.Label != "disabled historical scoped rule" {
		t.Fatalf("rejected disabled historical quiet-hours write changed row: %#v err=%v", disabledHistoricalQuiet, err)
	}
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var repairedQuietVersion time.Time
	if err := tx.QueryRow(ctx, `UPDATE sms_quiet_hours
		SET country_code='',enabled=false
		WHERE tenant_id=$1::uuid AND id=$2::uuid
		RETURNING updated_at`, tenantID, historicalQuietID).Scan(&repairedQuietVersion); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("atomic historical quiet-hours repair: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit historical quiet-hours repair: %v", err)
	}
	if !repairedQuietVersion.After(historicalQuietVersion) {
		t.Fatalf("historical quiet-hours repair version did not advance: old=%v new=%v", historicalQuietVersion, repairedQuietVersion)
	}
	historicalQuiet, err = store.GetQuietHours(ctx, tenantID, historicalQuietID)
	if err != nil || historicalQuiet.CountryCode != "" || historicalQuiet.Enabled ||
		!historicalQuiet.UpdatedAt.Equal(repairedQuietVersion) {
		t.Fatalf("atomic historical quiet-hours repair state: %#v err=%v", historicalQuiet, err)
	}

	// SQL cannot distinguish an omitted enabled column from an explicit write
	// of the same false value. The all-writer boundary enforces the security
	// invariant (a scoped row cannot transition to enabled), while the HTTP
	// validator pins explicit disable-and-clear intent.
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var disabledRepairVersion time.Time
	if err := tx.QueryRow(ctx, `UPDATE sms_quiet_hours
		SET country_code='',enabled=false
		WHERE tenant_id=$1::uuid AND id=$2::uuid
		RETURNING updated_at`, tenantID, disabledHistoricalQuietID).Scan(&disabledRepairVersion); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("atomic disabled historical quiet-hours repair: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit disabled historical quiet-hours repair: %v", err)
	}
	if !disabledRepairVersion.After(disabledHistoricalQuietVersion) {
		t.Fatalf("disabled historical quiet-hours repair version did not advance: old=%v new=%v", disabledHistoricalQuietVersion, disabledRepairVersion)
	}

	// The policy version token must advance for every write, including two old-
	// binary updates in one transaction. The legacy shared trigger used now()
	// (transaction-start time), which would return the same updated_at twice and
	// let a stale client token remain valid.
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var quietID, keywordID string
	var quietVersion, keywordVersion time.Time
	if err := tx.QueryRow(ctx, `
		INSERT INTO sms_quiet_hours
			(tenant_id,label,country_code,start_local,end_local,days,timezone,enabled)
		VALUES ($1::uuid,'version proof','',time '21:00',time '09:00',ARRAY[1]::int[],'UTC',true)
		RETURNING id::text, updated_at`, tenantID).Scan(&quietID, &quietVersion); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed quiet-hours monotonic version proof: %v", err)
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO sms_keyword_responses
			(tenant_id,keyword,response_body,action,enabled)
		VALUES ($1::uuid,'VERSIONPROOF','version proof','reply_only',true)
		RETURNING id::text, updated_at`, tenantID).Scan(&keywordID, &keywordVersion); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed keyword monotonic version proof: %v", err)
	}
	for sequence := 1; sequence <= 2; sequence++ {
		var next time.Time
		if err := tx.QueryRow(ctx, `UPDATE sms_quiet_hours SET label=$3
			WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING updated_at`, tenantID, quietID, "version proof "+string(rune('A'+sequence-1))).Scan(&next); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("old-writer quiet update %d: %v", sequence, err)
		}
		if !next.After(quietVersion) {
			_ = tx.Rollback(ctx)
			t.Fatalf("quiet version did not advance in one transaction: old=%v next=%v", quietVersion, next)
		}
		quietVersion = next

		if err := tx.QueryRow(ctx, `UPDATE sms_keyword_responses SET response_body=$3
			WHERE tenant_id=$1::uuid AND id=$2::uuid RETURNING updated_at`, tenantID, keywordID, "version proof "+string(rune('A'+sequence-1))).Scan(&next); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("old-writer keyword update %d: %v", sequence, err)
		}
		if !next.After(keywordVersion) {
			_ = tx.Rollback(ctx)
			t.Fatalf("keyword version did not advance in one transaction: old=%v next=%v", keywordVersion, next)
		}
		keywordVersion = next
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit monotonic policy version proof: %v", err)
	}

	manualState, ok := readSuppressionAuthorityState(t, pool, tenantID, manualPhone)
	if !ok || manualState.Overlay != "none" {
		t.Fatalf("historical manual row backfill = %#v", manualState)
	}
	expiredState, ok := readSuppressionAuthorityState(t, pool, tenantID, expiredPhone)
	if !ok || expiredState.Overlay != "legacy_unknown" || expiredState.ExpiresAt != nil {
		t.Fatalf("expired historical non-manual row did not become an active ambiguity hold: %#v", expiredState)
	}
	_, decision, err := store.Gate(ctx, tenantID, SenderProfile{RegistrationStatus: RegistrationApproved}, "", expiredPhone, "migration gate proof", 1)
	if err != nil || decision.Allowed || decision.Reason != "recipient_suppressed" {
		t.Fatalf("migrated historical ambiguity failed open: decision=%#v err=%v", decision, err)
	}
	if _, err := store.AddSuppression(ctx, tenantID, expiredPhone, "manual", nil); !errors.Is(err, ErrSuppressionLocked) {
		t.Fatalf("manual add cleared migrated historical ambiguity: %v", err)
	}
	recordProviderKeyword(t, store, tenantID, ProviderTwilio, expiredPhone, "START", "historical-start")
	if state, exists := readSuppressionAuthorityState(t, pool, tenantID, expiredPhone); !exists || state.Overlay != "legacy_unknown" {
		t.Fatalf("START cleared migrated historical ambiguity: %#v", state)
	}

	// An old writer after 1994 omits the new column. A true INSERT receives the
	// `none` default and remains normally clearable; it is not mislabeled as a
	// permanent historical ambiguity.
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO sms_suppressions
		(tenant_id,phone_e164,phone,reason,source,source_event_id,metadata)
		VALUES ($1::uuid,$2,$2,'stop_keyword','twilio','old-fresh-stop','{}'::jsonb)`, tenantID, oldFreshSTOPPhone); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("old writer fresh STOP after new schema: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	freshState, ok := readSuppressionAuthorityState(t, pool, tenantID, oldFreshSTOPPhone)
	if !ok || freshState.Overlay != "none" {
		t.Fatalf("old writer fresh STOP was needlessly review-held: %#v", freshState)
	}
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	deleteTag, err := tx.Exec(ctx, `DELETE FROM sms_suppressions
		WHERE tenant_id=$1::uuid AND phone_e164=$2 AND reason='stop_keyword' AND source='twilio'`, tenantID, oldFreshSTOPPhone)
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("old writer START after new schema: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if deleteTag.RowsAffected() != 1 {
		t.Fatalf("old writer START deleted %d fresh known rows, want 1", deleteTag.RowsAffected())
	}

	// The same old writer updating a historical manual row is protected by the
	// trigger. Its old START cannot erase the preserved hold; a verified new
	// START restores the exact row identity and minimizes legacy metadata.
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE sms_suppressions SET
		reason='stop_keyword', source='twilio', source_event_id='old-overlay-stop',
		metadata='{}'::jsonb, expires_at=NULL
		WHERE tenant_id=$1::uuid AND phone_e164=$2`, tenantID, manualPhone); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("old writer overlay historical manual row: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	preservedState, ok := readSuppressionAuthorityState(t, pool, tenantID, manualPhone)
	if !ok || preservedState.ID != manualState.ID || preservedState.Overlay != "preserved" || preservedState.Metadata != "{}" {
		t.Fatalf("old writer did not safely preserve historical manual state: %#v", preservedState)
	}
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	deleteTag, err = tx.Exec(ctx, `DELETE FROM sms_suppressions
		WHERE tenant_id=$1::uuid AND phone_e164=$2 AND reason='stop_keyword' AND source='twilio'`, tenantID, manualPhone)
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("old START against preserved manual row: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if deleteTag.RowsAffected() != 0 {
		t.Fatalf("old START erased %d preserved manual rows", deleteTag.RowsAffected())
	}
	recordProviderKeyword(t, store, tenantID, ProviderTwilio, manualPhone, "START", "new-restoring-start")
	restoredState, ok := readSuppressionAuthorityState(t, pool, tenantID, manualPhone)
	if !ok || restoredState.ID != manualState.ID || restoredState.Reason != "manual" || restoredState.Source != "manual" ||
		restoredState.Overlay != "none" || restoredState.Metadata != "{}" {
		t.Fatalf("new START did not restore minimized historical manual state: %#v", restoredState)
	}

	// Tenant erasure may run from an admin/control-plane connection without an
	// app.tenant_id GUC. Parent absence identifies the actual FK cascade; the
	// delete guard must permit it while the unrelated nested-trigger regression
	// separately proves that trigger depth alone has no authority.
	adminCascadeTenantID := uuid.NewString()
	var tenantSetting *string
	if err := pool.QueryRow(ctx, `SELECT current_setting('app.tenant_id', true)`).Scan(&tenantSetting); err != nil {
		t.Fatalf("read admin cascade tenant GUC: %v", err)
	}
	if tenantSetting != nil && *tenantSetting != "" {
		t.Fatalf("admin cascade unexpectedly inherited app.tenant_id=%q", *tenantSetting)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO tenants (id,name,slug,tier)
		VALUES ($1::uuid,'route42 admin cascade','route42-admin-cascade-' || $1::text,'studio')`, adminCascadeTenantID); err != nil {
		t.Fatalf("seed no-GUC admin cascade tenant: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sms_suppressions (
			tenant_id, phone_e164, phone, reason, source, metadata,
			manual_overlay_state
		) VALUES
			($1::uuid,'+14155550106','+14155550106','stop_keyword','twilio','{}'::jsonb,'preserved'),
			($1::uuid,'+14155550107','+14155550107','stop_keyword','twilio','{}'::jsonb,'legacy_unknown')`, adminCascadeTenantID); err != nil {
		t.Fatalf("seed no-GUC admin cascade rows: %v", err)
	}
	adminDeleteTag, err := pool.Exec(ctx, `DELETE FROM tenants WHERE id=$1::uuid`, adminCascadeTenantID)
	if err != nil {
		t.Fatalf("no-GUC admin tenant cascade blocked by suppression guard: %v", err)
	}
	if adminDeleteTag.RowsAffected() != 1 {
		t.Fatalf("no-GUC admin tenant rows deleted = %d, want 1", adminDeleteTag.RowsAffected())
	}
	var adminChildren int
	if err := pool.QueryRow(ctx, `SELECT count(*)::int FROM sms_suppressions WHERE tenant_id=$1::uuid`, adminCascadeTenantID).Scan(&adminChildren); err != nil {
		t.Fatalf("read no-GUC admin cascade children: %v", err)
	}
	if adminChildren != 0 {
		t.Fatalf("no-GUC admin cascade left %d protected suppression rows", adminChildren)
	}

	// Exercise the production role, not the database owner: FORCE RLS must hide
	// another tenant's registry and reject a cross-tenant write even when the
	// SQL supplies that foreign tenant id explicitly.
	foreignTenantID := uuid.NewString()
	if _, err := pool.Exec(ctx, `
		INSERT INTO tenants (id,name,slug,tier)
		VALUES ($1::uuid,'route42 foreign tenant','route42-foreign-' || $1::text,'studio')`, foreignTenantID); err != nil {
		t.Fatalf("seed RLS foreign tenant: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO sms_suppressions (
			tenant_id, phone_e164, phone, reason, source, metadata,
			manual_overlay_state
		) VALUES ($1::uuid,'+14155550108','+14155550108','manual','manual','{}'::jsonb,'none')`, foreignTenantID); err != nil {
		t.Fatalf("seed RLS foreign suppression: %v", err)
	}
	appTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin production-role RLS proof: %v", err)
	}
	defer func() { _ = appTx.Rollback(context.Background()) }()
	if _, err := appTx.Exec(ctx, `SET LOCAL ROLE postwave_app`); err != nil {
		t.Fatalf("assume production database role: %v", err)
	}
	if _, err := appTx.Exec(ctx, `SELECT set_config('app.tenant_id',$1,true)`, tenantID); err != nil {
		t.Fatalf("set production tenant scope: %v", err)
	}
	var visibleForeign int
	if err := appTx.QueryRow(ctx, `SELECT count(*)::int FROM sms_suppressions WHERE tenant_id=$1::uuid`, foreignTenantID).Scan(&visibleForeign); err != nil {
		t.Fatalf("read cross-tenant suppression under production role: %v", err)
	}
	if visibleForeign != 0 {
		t.Fatalf("production role saw %d foreign suppression rows", visibleForeign)
	}
	if _, err := appTx.Exec(ctx, `
		INSERT INTO sms_suppressions (tenant_id,phone_e164,phone,reason,source,metadata)
		VALUES ($1::uuid,'+14155550109','+14155550109','manual','manual','{}'::jsonb)`, foreignTenantID); err == nil {
		t.Fatal("production role inserted a suppression for a foreign tenant")
	}
	_ = appTx.Rollback(ctx)
	if _, err := pool.Exec(ctx, `DELETE FROM tenants WHERE id=$1::uuid`, foreignTenantID); err != nil {
		t.Fatalf("cleanup RLS foreign tenant: %v", err)
	}
}
