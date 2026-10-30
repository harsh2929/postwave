// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type suppressionAuthorityState struct {
	ID        string
	Reason    string
	Source    string
	EventID   string
	Overlay   string
	Metadata  string
	CreatedAt time.Time
	ExpiresAt *time.Time
}

func readSuppressionAuthorityState(t *testing.T, pool *db.Pool, tenantID, phone string) (suppressionAuthorityState, bool) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var out suppressionAuthorityState
	err = tx.QueryRow(ctx, `
		SELECT id::text, reason, source, COALESCE(source_event_id, ''),
		       manual_overlay_state, metadata::text, created_at, expires_at
		  FROM sms_suppressions
		 WHERE tenant_id = $1::uuid AND phone_e164 = $2`, tenantID, phone).Scan(
		&out.ID, &out.Reason, &out.Source, &out.EventID, &out.Overlay, &out.Metadata, &out.CreatedAt, &out.ExpiresAt,
	)
	if isNoRows(err) {
		return suppressionAuthorityState{}, false
	}
	if err != nil {
		t.Fatalf("read suppression: %v", err)
	}
	return out, true
}

func recordProviderKeyword(t *testing.T, store *Store, tenantID, provider, phone, keyword, eventID string) {
	t.Helper()
	if _, _, _, err := store.RecordInbound(context.Background(), tenantID, "", provider, phone, keyword, eventID, nil); err != nil {
		t.Fatalf("record %s %s (%s): %v", provider, keyword, eventID, err)
	}
}

func TestManualSuppressionCarrierOverlayRestoresGateStateWithoutLegacyMetadata(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()

	manual, err := store.AddSuppression(ctx, f.tenantID, f.phone, "manual", nil)
	if err != nil {
		t.Fatalf("manual add: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatal(err)
	}
	hostileMetadata := `{"phone":"` + f.phone + `","secret":"legacy-manual-pii"}`
	if _, err := tx.Exec(ctx, `
		UPDATE sms_suppressions SET metadata = $3::jsonb
		 WHERE tenant_id = $1::uuid AND id = $2::uuid`, f.tenantID, manual.ID, hostileMetadata); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed hostile legacy metadata: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	stop1 := "stop-" + uuid.NewString()
	recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "STOP", stop1)
	afterStop, ok := readSuppressionAuthorityState(t, pool, f.tenantID, f.phone)
	if !ok || afterStop.ID != manual.ID || afterStop.Reason != "stop_keyword" || afterStop.Source != ProviderTwilio || afterStop.Overlay != "preserved" {
		t.Fatalf("manual -> STOP state = %#v, want same row with preserved Twilio overlay", afterStop)
	}
	if strings.Contains(afterStop.Metadata, "legacy-manual-pii") || strings.Contains(afterStop.Metadata, f.phone) {
		t.Fatalf("STOP duplicated hostile manual metadata: %s", afterStop.Metadata)
	}

	// Same-authority STOP may refresh evidence without losing the marker. A
	// replay of the older immutable provider event cannot move it backwards.
	stop2 := "stop-" + uuid.NewString()
	recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "STOP", stop2)
	recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "STOP", stop1)
	afterReplay, ok := readSuppressionAuthorityState(t, pool, f.tenantID, f.phone)
	if !ok || afterReplay.EventID != stop2 || afterReplay.Overlay != "preserved" {
		t.Fatalf("provider replay reordered suppression authority: %#v", afterReplay)
	}

	recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "START", "start-"+uuid.NewString())
	restored, ok := readSuppressionAuthorityState(t, pool, f.tenantID, f.phone)
	if !ok || restored.ID != manual.ID || restored.Reason != "manual" || restored.Source != "manual" || restored.Overlay != "none" {
		t.Fatalf("START did not restore the manual gate state in place: %#v", restored)
	}
	if !restored.CreatedAt.Equal(afterStop.CreatedAt) || restored.Metadata != "{}" || strings.Contains(restored.Metadata, "legacy-manual-pii") {
		t.Fatalf("restored state retained legacy PII or changed identity/time: %#v", restored)
	}
}

func TestSuppressionSourceEventReplaysCannotReorderAuthority(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	manual, err := store.AddSuppression(context.Background(), f.tenantID, f.phone, "manual", nil)
	if err != nil {
		t.Fatalf("manual add: %v", err)
	}

	// A provider retry runs consent/suppression logic only on the first
	// content-bound event insertion. Replaying an earlier START after a newer
	// STOP cannot clear the STOP overlay.
	earlyStartID := "early-start-" + uuid.NewString()
	recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "START", earlyStartID)
	stopID := "ordered-stop-" + uuid.NewString()
	recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "STOP", stopID)
	recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "START", earlyStartID)
	afterOldStartReplay, ok := readSuppressionAuthorityState(t, pool, f.tenantID, f.phone)
	if !ok || afterOldStartReplay.ID != manual.ID || afterOldStartReplay.Overlay != "preserved" || afterOldStartReplay.EventID != stopID {
		t.Fatalf("older START replay reordered STOP authority: %#v", afterOldStartReplay)
	}

	// Conversely, replaying the old STOP after a fresh verified START cannot
	// recreate the cleared provider overlay.
	recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "START", "fresh-start-"+uuid.NewString())
	recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "STOP", stopID)
	afterOldStopReplay, ok := readSuppressionAuthorityState(t, pool, f.tenantID, f.phone)
	if !ok || afterOldStopReplay.ID != manual.ID || afterOldStopReplay.Reason != "manual" ||
		afterOldStopReplay.Source != "manual" || afterOldStopReplay.Overlay != "none" {
		t.Fatalf("older STOP replay recreated provider authority: %#v", afterOldStopReplay)
	}
}

func TestIndependentSuppressionAuthoritiesPromoteToAmbiguousAndNeverAutoClear(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}

	t.Run("operator revoke then provider", func(t *testing.T) {
		f := seedSMSConsentFixture(t, pool)
		if err := store.RecordConsent(context.Background(), f.tenantID, ConsentInput{
			PhoneE164: f.phone, Action: ConsentRevoked, Source: "manual",
		}); err != nil {
			t.Fatalf("operator revoke: %v", err)
		}
		recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "STOP", "stop-"+uuid.NewString())
		state, ok := readSuppressionAuthorityState(t, pool, f.tenantID, f.phone)
		if !ok || state.Source != "manual" || state.Reason != "stop_keyword" || state.Overlay != "legacy_unknown" {
			t.Fatalf("independent operator/provider authority was overwritten: %#v", state)
		}
		recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "START", "start-"+uuid.NewString())
		if state, ok = readSuppressionAuthorityState(t, pool, f.tenantID, f.phone); !ok || state.Overlay != "legacy_unknown" {
			t.Fatalf("provider START cleared an operator-revocation collision: %#v", state)
		}
	})

	t.Run("manual hold then operator revoke then provider", func(t *testing.T) {
		f := seedSMSConsentFixture(t, pool)
		manual, err := store.AddSuppression(context.Background(), f.tenantID, f.phone, "manual", nil)
		if err != nil {
			t.Fatalf("manual hold: %v", err)
		}
		if err := store.RecordConsent(context.Background(), f.tenantID, ConsentInput{
			PhoneE164: f.phone, Action: ConsentRevoked, Source: "manual",
		}); err != nil {
			t.Fatalf("operator revoke: %v", err)
		}
		afterOperator, ok := readSuppressionAuthorityState(t, pool, f.tenantID, f.phone)
		if !ok || afterOperator.ID != manual.ID || afterOperator.Reason != "stop_keyword" ||
			afterOperator.Source != "manual" || afterOperator.Overlay != "preserved" {
			t.Fatalf("operator revoke did not retain the prior manual safety marker: %#v", afterOperator)
		}
		recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "STOP", "stop-"+uuid.NewString())
		afterProvider, ok := readSuppressionAuthorityState(t, pool, f.tenantID, f.phone)
		if !ok || afterProvider.ID != manual.ID || afterProvider.Reason != "stop_keyword" ||
			afterProvider.Source != "manual" || afterProvider.Overlay != "legacy_unknown" {
			t.Fatalf("provider collision discarded newer operator authority: %#v", afterProvider)
		}
		recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "START", "start-"+uuid.NewString())
		if state, ok := readSuppressionAuthorityState(t, pool, f.tenantID, f.phone); !ok || state.Overlay != "legacy_unknown" || state.Source != "manual" {
			t.Fatalf("provider START cleared a manual/operator/provider authority collision: %#v", state)
		}
	})

	t.Run("provider A then provider B", func(t *testing.T) {
		f := seedSMSConsentFixture(t, pool)
		recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "STOP", "tw-stop-"+uuid.NewString())
		recordProviderKeyword(t, store, f.tenantID, ProviderBandwidth, f.phone, "STOP", "bw-stop-"+uuid.NewString())
		state, ok := readSuppressionAuthorityState(t, pool, f.tenantID, f.phone)
		if !ok || state.Source != ProviderTwilio || state.Overlay != "legacy_unknown" {
			t.Fatalf("cross-provider STOP collision was not review-held: %#v", state)
		}
		recordProviderKeyword(t, store, f.tenantID, ProviderBandwidth, f.phone, "START", "bw-start-"+uuid.NewString())
		recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "START", "tw-start-"+uuid.NewString())
		if state, ok = readSuppressionAuthorityState(t, pool, f.tenantID, f.phone); !ok || state.Overlay != "legacy_unknown" {
			t.Fatalf("provider START cleared a cross-authority collision: %#v", state)
		}
	})
}

func TestMixedVersionSuppressionWritersRemainFailClosed(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()

	oldStop := func(phone, eventID string) {
		tx, err := db.WithTenant(ctx, pool, f.tenantID)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if _, err := tx.Exec(ctx, `
			INSERT INTO sms_suppressions (tenant_id, phone_e164, reason, source, source_event_id, metadata)
			VALUES ($1::uuid, $2, 'stop_keyword', 'twilio', $3, '{}'::jsonb)
			ON CONFLICT (tenant_id, phone_e164) DO UPDATE SET
				reason = EXCLUDED.reason, source = EXCLUDED.source,
				source_event_id = EXCLUDED.source_event_id,
				metadata = EXCLUDED.metadata, expires_at = NULL
			WHERE (sms_suppressions.expires_at IS NOT NULL AND sms_suppressions.expires_at <= now())
			   OR sms_suppressions.reason NOT IN ('carrier_block', 'complaint')`, f.tenantID, phone, eventID); err != nil {
			t.Fatalf("old STOP: %v", err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	}

	// A true old-binary INSERT is fresh and must remain normally clearable.
	oldStop(f.phone, "old-fresh-"+uuid.NewString())
	if state, ok := readSuppressionAuthorityState(t, pool, f.tenantID, f.phone); !ok || state.Overlay != "none" {
		t.Fatalf("old fresh STOP was needlessly made ambiguous: %#v", state)
	}
	recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "START", "old-fresh-start-"+uuid.NewString())
	if _, ok := readSuppressionAuthorityState(t, pool, f.tenantID, f.phone); ok {
		t.Fatal("same-provider START did not clear a provenance-known old fresh STOP")
	}

	// A reviewed historical import may explicitly say provenance is unknown.
	// The INSERT trigger must not reinterpret that marker as a fresh authority.
	ambiguousPhone := "+1555" + randomDigits(t)
	tx, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO sms_suppressions (
			tenant_id, phone_e164, reason, source, source_event_id, metadata,
			expires_at, manual_overlay_state
		) VALUES ($1::uuid, $2, 'stop_keyword', 'twilio', $3, '{}'::jsonb,
		          clock_timestamp() - interval '1 day', 'legacy_unknown')`,
		f.tenantID, ambiguousPhone, "historical-"+uuid.NewString()); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("explicit historical insert: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	state, ok := readSuppressionAuthorityState(t, pool, f.tenantID, ambiguousPhone)
	if !ok || state.Overlay != "legacy_unknown" || state.ExpiresAt != nil {
		t.Fatalf("explicit ambiguous insert was downgraded: %#v", state)
	}
	_, decision, err := store.Gate(ctx, f.tenantID, SenderProfile{RegistrationStatus: RegistrationApproved}, "", ambiguousPhone, "compliance gate proof", 1)
	if err != nil || decision.Allowed || decision.Reason != "recipient_suppressed" {
		t.Fatalf("expired historical ambiguity failed open: decision=%#v err=%v", decision, err)
	}
	dbNow, err := store.InboxDatabaseNow(ctx, f.tenantID)
	if err != nil {
		t.Fatal(err)
	}
	page, err := store.ListSuppressions(ctx, f.tenantID, "", "", []byte("0123456789abcdef0123456789abcdef"), inboxCursorPosition{SnapshotAt: dbNow}, "historical-ambiguity", 100)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, item := range page.Items {
		found = found || item.PhoneE164 == ambiguousPhone
	}
	if !found {
		t.Fatalf("sticky historical ambiguity was omitted from suppression inventory: %#v", page.Items)
	}
	if _, err := store.AddSuppression(ctx, f.tenantID, ambiguousPhone, "manual", nil); !errors.Is(err, ErrSuppressionLocked) {
		t.Fatalf("manual add cleared sticky historical ambiguity: %v", err)
	}
	if deleted, err := store.DeleteSuppression(ctx, f.tenantID, state.ID, nil); !errors.Is(err, ErrSuppressionLocked) || deleted {
		t.Fatalf("operator delete cleared sticky historical ambiguity: deleted=%v err=%v", deleted, err)
	}
	recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, ambiguousPhone, "START", "historical-start-"+uuid.NewString())
	if state, ok := readSuppressionAuthorityState(t, pool, f.tenantID, ambiguousPhone); !ok || state.Overlay != "legacy_unknown" {
		t.Fatalf("START cleared explicitly ambiguous historical authority: %#v", state)
	}

	manual, err := store.AddSuppression(ctx, f.tenantID, f.phone, "manual", nil)
	if err != nil {
		t.Fatal(err)
	}
	oldStop(f.phone, "old-overlay-"+uuid.NewString())
	state, ok = readSuppressionAuthorityState(t, pool, f.tenantID, f.phone)
	if !ok || state.ID != manual.ID || state.Overlay != "preserved" {
		t.Fatalf("old writer erased a manual hold: %#v", state)
	}
	// The old START SQL sees zero affected rows because the delete guard blocks
	// it; the row and gate remain intact for the new binary to restore.
	tx, err = db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatal(err)
	}
	tag, err := tx.Exec(ctx, `
		DELETE FROM sms_suppressions
		 WHERE tenant_id = $1::uuid AND phone_e164 = $2
		   AND reason = 'stop_keyword' AND source = 'twilio'`, f.tenantID, f.phone)
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if tag.RowsAffected() != 0 {
		_ = tx.Rollback(ctx)
		t.Fatalf("old START deleted %d preserved rows", tag.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	// Baseline old AddSuppression is allowed to refresh manual/expired rows only;
	// it cannot turn an active ambiguous system row into reversible manual state.
	tx, err = db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `UPDATE sms_suppressions SET manual_overlay_state = 'legacy_unknown' WHERE tenant_id=$1::uuid AND phone_e164=$2`, f.tenantID, f.phone); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	var oldAddID string
	err = tx.QueryRow(ctx, `
		INSERT INTO sms_suppressions (tenant_id, phone_e164, phone, reason, source)
		VALUES ($1::uuid, $2, $2, 'manual', 'manual')
		ON CONFLICT (tenant_id, phone_e164) DO UPDATE SET
			reason='manual', source='manual', phone=EXCLUDED.phone,
			source_event_id=NULL, expires_at=NULL
		WHERE (sms_suppressions.reason='manual' AND sms_suppressions.source='manual')
		   OR sms_suppressions.expires_at <= clock_timestamp()
		RETURNING id::text`, f.tenantID, f.phone).Scan(&oldAddID)
	if !isNoRows(err) {
		_ = tx.Rollback(ctx)
		t.Fatalf("old AddSuppression changed active ambiguous row: id=%q err=%v", oldAddID, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if state, ok = readSuppressionAuthorityState(t, pool, f.tenantID, f.phone); !ok || state.Overlay != "legacy_unknown" || state.Reason != "stop_keyword" {
		t.Fatalf("active ambiguous row became reversible: %#v", state)
	}
}

func TestSuppressionManualAndProviderRaceNeverLosesAcknowledgedHold(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	start := make(chan struct{})
	var wg sync.WaitGroup
	var manualErr, stopErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		_, manualErr = store.AddSuppression(context.Background(), f.tenantID, f.phone, "manual", nil)
	}()
	go func() {
		defer wg.Done()
		<-start
		_, _, _, stopErr = store.RecordInbound(context.Background(), f.tenantID, "", ProviderTwilio, f.phone, "STOP", "race-stop-"+uuid.NewString(), nil)
	}()
	close(start)
	wg.Wait()
	if stopErr != nil {
		t.Fatalf("provider STOP failed: %v", stopErr)
	}
	if manualErr != nil && !errors.Is(manualErr, ErrSuppressionLocked) {
		t.Fatalf("manual add returned unexpected error: %v", manualErr)
	}

	recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "START", "race-start-"+uuid.NewString())
	state, exists := readSuppressionAuthorityState(t, pool, f.tenantID, f.phone)
	if manualErr == nil {
		if !exists || state.Reason != "manual" || state.Source != "manual" {
			t.Fatalf("acknowledged concurrent manual hold was lost after START: %#v exists=%v", state, exists)
		}
	} else if exists {
		t.Fatalf("manual add was rejected but fresh STOP remained after verified START: %#v", state)
	}
}

func TestSuppressionWritesSupportCanonicalLegacyTenantUUIDVersions(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	ctx := context.Background()
	legacyTenantID := uuid.NewMD5(uuid.NameSpaceOID, []byte(uuid.NewString())).String() // canonical UUIDv3
	phone := "+1555" + randomDigits(t)
	tx, err := db.WithTenant(ctx, pool, legacyTenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO tenants (id, name, slug, tier)
		VALUES ($1::uuid, 'legacy-uuid-suppression-test', 'legacy-uuid-' || $1::text, 'studio')`, legacyTenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed non-v4 tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cleanupTx, err := db.WithTenant(cleanupCtx, pool, legacyTenantID)
		if err == nil {
			_, _ = cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id=$1::uuid`, legacyTenantID)
			_ = cleanupTx.Commit(cleanupCtx)
		}
	})

	row, err := store.AddSuppression(ctx, legacyTenantID, phone, "manual", nil)
	if err != nil {
		t.Fatalf("canonical non-v4 tenant manual add failed: %v", err)
	}
	if !validCanonicalUUIDV4(row.ID) || row.PhoneE164 != phone {
		t.Fatalf("non-v4 tenant suppression projection invalid: %#v", row)
	}
	if deleted, err := store.DeleteSuppression(ctx, legacyTenantID, row.ID, nil); err != nil || !deleted {
		t.Fatalf("canonical non-v4 tenant delete: deleted=%v err=%v", deleted, err)
	}
}

func TestSuppressionDeleteGuardDoesNotBlockTenantCascade(t *testing.T) {
	pool := newSMSConsentTestPool(t)
	store := &Store{Pool: pool}
	f := seedSMSConsentFixture(t, pool)
	ctx := context.Background()
	if _, err := store.AddSuppression(ctx, f.tenantID, f.phone, "manual", nil); err != nil {
		t.Fatal(err)
	}
	recordProviderKeyword(t, store, f.tenantID, ProviderTwilio, f.phone, "STOP", "cascade-stop-"+uuid.NewString())
	if state, ok := readSuppressionAuthorityState(t, pool, f.tenantID, f.phone); !ok || state.Overlay != "preserved" {
		t.Fatalf("cascade precondition missing preserved row: %#v", state)
	}

	tx, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
		CREATE TEMP TABLE suppression_nested_delete_probe (
			tenant_id uuid NOT NULL,
			suppression_id uuid NOT NULL
		) ON COMMIT DROP;
		CREATE OR REPLACE FUNCTION pg_temp.try_nested_suppression_delete()
		RETURNS trigger LANGUAGE plpgsql AS $fn$
		BEGIN
			DELETE FROM public.sms_suppressions
			 WHERE tenant_id=NEW.tenant_id AND id=NEW.suppression_id;
			RETURN NEW;
		END
		$fn$;
		CREATE TRIGGER suppression_nested_delete_probe_trg
		AFTER INSERT ON suppression_nested_delete_probe
		FOR EACH ROW EXECUTE FUNCTION pg_temp.try_nested_suppression_delete()`); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("create unrelated nested-delete probe: %v", err)
	}
	for _, overlay := range []string{"preserved", "legacy_unknown"} {
		if overlay == "legacy_unknown" {
			if _, err := tx.Exec(ctx, `
				UPDATE sms_suppressions
				   SET manual_overlay_state='legacy_unknown'
				 WHERE tenant_id=$1::uuid AND phone_e164=$2`, f.tenantID, f.phone); err != nil {
				_ = tx.Rollback(ctx)
				t.Fatalf("promote nested-delete fixture to legacy ambiguity: %v", err)
			}
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO suppression_nested_delete_probe (tenant_id, suppression_id)
			SELECT tenant_id, id FROM sms_suppressions
			 WHERE tenant_id=$1::uuid AND phone_e164=$2`, f.tenantID, f.phone); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("run unrelated nested delete against %s row: %v", overlay, err)
		}
		var stillPresent bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (
			SELECT 1 FROM sms_suppressions WHERE tenant_id=$1::uuid AND phone_e164=$2
		)`, f.tenantID, f.phone).Scan(&stillPresent); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("read %s row after unrelated nested delete: %v", overlay, err)
		}
		if !stillPresent {
			_ = tx.Rollback(ctx)
			t.Fatalf("unrelated nested trigger erased %s suppression authority", overlay)
		}
	}
	tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id=$1::uuid`, f.tenantID)
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("tenant cascade blocked by suppression delete guard: %v", err)
	}
	if tag.RowsAffected() != 1 {
		_ = tx.Rollback(ctx)
		t.Fatalf("tenant rows deleted = %d, want 1", tag.RowsAffected())
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	checkTx, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = checkTx.Rollback(ctx) }()
	var childCount int
	if err := checkTx.QueryRow(ctx, `SELECT count(*)::int FROM sms_suppressions WHERE tenant_id=$1::uuid`, f.tenantID).Scan(&childCount); err != nil {
		t.Fatal(err)
	}
	if childCount != 0 {
		t.Fatalf("suppression rows survived tenant cascade: %d", childCount)
	}
}
