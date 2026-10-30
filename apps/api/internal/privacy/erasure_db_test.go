// SPDX-License-Identifier: AGPL-3.0-only

package privacy

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func newErasureTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed repeat-erasure test")
	}
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatalf("connect to PostgreSQL: %v", err)
	}
	// A BOUNDED close, because the unbounded one turns any leak into silence.
	//
	// pgxpool.Close waits for every checked-out connection to be returned. A
	// test that calls t.Fatalf while holding a transaction never releases it —
	// runtime.Goexit skips the rest of the function but runs deferred and
	// cleanup functions, so Close runs and blocks forever. The observable
	// result is a ten-minute package timeout with NO failure message: the
	// reason the test failed is destroyed by the hang that follows it.
	//
	// This is not a hypothetical. This package timed out at both 300s and 600s
	// with three lines of output, and the goroutine dump showed exactly this:
	// t.Fatalf -> Goexit -> t.Cleanup -> pgxpool.Close -> puddle's
	// WaitGroup.Wait.
	//
	// Bounding it costs nothing when the test is clean and converts a silent
	// hang into a named failure when it is not.
	t.Cleanup(func() {
		done := make(chan struct{})
		go func() {
			pool.Close()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Errorf("the connection pool did not close within 10s: a test left a " +
				"transaction checked out, almost certainly by calling t.Fatalf " +
				"while holding one. Add `defer func() { _ = tx.Rollback(ctx) }()` " +
				"at the point the transaction is opened.")
		}
	})
	return pool
}

func seedErasureTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open tenant seed transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	slug := "privacy-erasure-" + strings.ReplaceAll(tenantID, "-", "")
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'privacy-erasure-test', $2, 'studio')`, tenantID, slug); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
}

func cleanupErasureTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Logf("cleanup tenant scope %s: %v", tenantID, err)
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID); err != nil {
		t.Logf("cleanup tenant %s: %v", tenantID, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		t.Logf("commit cleanup tenant %s: %v", tenantID, err)
	}
}

func seedErasureSubscriber(
	t *testing.T,
	tx pgx.Tx,
	tenantID, email, name, phone string,
	seedSatellites bool,
) string {
	t.Helper()
	ctx := context.Background()
	var subscriberID string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (
    tenant_id, email, primary_email, status, consent_source,
    custom_fields, merge_fields, tags, groups, gdpr_permissions,
    signup_ip, unsubscribe_reason, activity_summary,
    source_id, source_platform, first_name, last_name, full_name, display_name,
    timezone, locale, language, country, region, external_id, phone_e164
)
VALUES (
    $1::uuid, $2::citext, $2::citext, 'enabled', 'api',
    -- $3 and $4 are cast explicitly. jsonb_build_object is variadic "any", so
    -- an untyped parameter inside it gives Postgres nothing to infer from and
    -- the whole statement fails with 42P08, "could not determine data type of
    -- parameter $3". That error was invisible for as long as this test existed,
    -- because the t.Fatalf reporting it leaked a transaction and the pool close
    -- that followed hung the package before any output was printed.
    jsonb_build_object('contact_name', $3::text, 'phone', $4::text, 'email', $2::text),
    jsonb_build_object('FNAME', $3::text, 'PHONE', $4::text),
    ARRAY['vip', $3::text]::text[],
    jsonb_build_array(jsonb_build_object('name', $3::text)),
    jsonb_build_array(jsonb_build_object('purpose', 'marketing', 'name', $3::text)),
    '203.0.113.25'::inet, $3::text,
    jsonb_build_object('last_contact', $3::text, 'email', $2::text),
    'source-' || $3::text, 'integration-' || $3::text,
    $3::text, 'Erasure', $3::text || ' Erasure', $3::text,
    'Europe/London', 'en-GB', 'en', 'GB', 'London',
    'external-' || gen_random_uuid()::text, $4::text
)
RETURNING id::text`, tenantID, email, name, phone).Scan(&subscriberID); err != nil {
		t.Fatalf("seed subscriber %s: %v", email, err)
	}

	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_emails (
    tenant_id, subscriber_id, email, is_primary, consent_status, suppressed
)
VALUES ($1::uuid, $2::uuid, $3::citext, true, 'never_subscribed', false)
ON CONFLICT DO NOTHING`, tenantID, subscriberID, email); err != nil {
		t.Fatalf("seed subscriber email: %v", err)
	}
	if !seedSatellites {
		return subscriberID
	}

	statements := []struct {
		name string
		sql  string
		args []any
	}{
		{"attribute history", `INSERT INTO subscriber_attribute_history (tenant_id, subscriber_id, field_name, old_value, new_value) VALUES ($1::uuid, $2::uuid, 'first_name', NULL, $3)`, []any{tenantID, subscriberID, name}},
		{"profile alias", `INSERT INTO profile_aliases (tenant_id, subscriber_id, alias_type, alias_value, provenance) VALUES ($1::uuid, $2::uuid, 'phone', $3::text, jsonb_build_object('name',$4::text))`, []any{tenantID, subscriberID, phone, name}},
		{"computed trait", `INSERT INTO subscriber_computed_traits (tenant_id, subscriber_id, key, value, value_type) VALUES ($1::uuid, $2::uuid, 'customer_profile', jsonb_build_object('name',$3::text,'phone',$4::text), 'json')`, []any{tenantID, subscriberID, name, phone}},
		{"prediction metadata", `INSERT INTO subscriber_prediction_metadata (tenant_id, subscriber_id, score_type, features) VALUES ($1::uuid, $2::uuid, 'churn', jsonb_build_object('name',$3::text,'phone',$4::text))`, []any{tenantID, subscriberID, name, phone}},
		{"canonical suppression", `INSERT INTO subscriber_suppressions (tenant_id, email, reason, source, metadata) VALUES ($1::uuid, $2::citext, 'list_manual', 'manual', jsonb_build_object('name',$3::text,'phone',$4::text)) ON CONFLICT (tenant_id,email) DO UPDATE SET metadata=EXCLUDED.metadata`, []any{tenantID, email, name, phone}},
		{"legacy suppression", `INSERT INTO suppressions (tenant_id, email, reason) VALUES ($1::uuid, $2::citext, 'manual_unsubscribe') ON CONFLICT (tenant_id,email) DO UPDATE SET reason=EXCLUDED.reason`, []any{tenantID, email}},
		{"mailchimp suppression", `INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata) VALUES ($1::uuid, $2::citext, 'manual', 'privacy-test', jsonb_build_object('name',$3::text,'phone',$4::text)) ON CONFLICT (tenant_id,email,reason) DO UPDATE SET metadata=EXCLUDED.metadata`, []any{tenantID, email, name, phone}},
	}
	for _, statement := range statements {
		if _, err := tx.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatalf("seed %s: %v", statement.name, err)
		}
	}
	return subscriberID
}

func TestEraseSubscriberData_PostgresRepeatReimportErasure(t *testing.T) {
	pool := newErasureTestPool(t)
	tenantID := uuid.NewString()
	otherTenantID := uuid.NewString()
	seedErasureTenant(t, pool, tenantID)
	seedErasureTenant(t, pool, otherTenantID)
	t.Cleanup(func() {
		cleanupErasureTenant(t, pool, tenantID)
		cleanupErasureTenant(t, pool, otherTenantID)
	})

	const (
		email = "repeat-erasure@example.test"
		name  = "PrivacyCanaryName"
		phone = "+447700900123"
	)
	ctx := context.Background()

	// The same address in another tenant is a canary for both the explicit
	// tenant predicates and FORCE-RLS scope.
	otherTx, err := db.WithTenant(ctx, pool, otherTenantID)
	if err != nil {
		t.Fatalf("other tenant transaction: %v", err)
	}
	seedErasureSubscriber(t, otherTx, otherTenantID, email, name, phone, false)
	if _, err := otherTx.Exec(ctx, `
INSERT INTO frequency_cap_events (
    tenant_id, subscriber_email, channel, message_type
) VALUES ($1::uuid, $2, 'email', 'campaign')`, otherTenantID, email); err != nil {
		t.Fatalf("seed other-tenant frequency-cap event: %v", err)
	}
	if err := otherTx.Commit(ctx); err != nil {
		t.Fatalf("commit other tenant seed: %v", err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("erasure tenant transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	firstID := seedErasureSubscriber(t, tx, tenantID, email, name, phone, true)
	if _, err := tx.Exec(ctx, `
INSERT INTO frequency_cap_events (
    tenant_id, subscriber_email, channel, message_type
) VALUES ($1::uuid, $2, 'email', 'campaign')`, tenantID,
		"  RePeAt-Erasure@Example.Test  "); err != nil {
		t.Fatalf("seed first frequency-cap event: %v", err)
	}
	first, err := eraseSubscriberDataWithEntropy(
		ctx, tx, tenantID, email,
		bytes.NewReader(bytes.Repeat([]byte{0x71}, erasureNonceBytes)),
	)
	if err != nil {
		t.Fatalf("first erasure: %v", err)
	}
	if first.SubscribersAnonymized != 1 {
		t.Fatalf("first erasure anonymized %d subscriber rows, want 1", first.SubscribersAnonymized)
	}
	if first.FrequencyCapEventsDeleted != 1 {
		t.Fatalf("first erasure deleted %d frequency-cap events, want 1",
			first.FrequencyCapEventsDeleted)
	}

	// A direct import is intentional here: this recreates the exact production
	// uniqueness failure that the old deterministic placeholder caused.
	secondID := seedErasureSubscriber(t, tx, tenantID, email, name, phone, true)
	if _, err := tx.Exec(ctx, `
INSERT INTO frequency_cap_events (
    tenant_id, subscriber_email, channel, message_type
) VALUES ($1::uuid, $2, 'email', 'campaign')`, tenantID, email); err != nil {
		t.Fatalf("seed second frequency-cap event: %v", err)
	}
	second, err := eraseSubscriberDataWithEntropy(
		ctx, tx, tenantID, email,
		bytes.NewReader(bytes.Repeat([]byte{0x72}, erasureNonceBytes)),
	)
	if err != nil {
		t.Fatalf("second erasure after re-import: %v", err)
	}
	if second.SubscribersAnonymized != 1 {
		t.Fatalf("second erasure anonymized %d subscriber rows, want 1", second.SubscribersAnonymized)
	}
	if second.FrequencyCapEventsDeleted != 1 {
		t.Fatalf("second erasure deleted %d frequency-cap events, want 1",
			second.FrequencyCapEventsDeleted)
	}
	if first.Placeholder == second.Placeholder {
		t.Fatalf("repeat erasure reused placeholder %q", first.Placeholder)
	}

	rows, err := tx.Query(ctx, `
SELECT email::text, COALESCE(primary_email::text, ''), first_name,
       COALESCE(phone_e164, ''), custom_fields::text, merge_fields::text
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[])
 ORDER BY id`, tenantID, []string{firstID, secondID})
	if err != nil {
		t.Fatalf("read erased subscribers: %v", err)
	}
	var placeholders []string
	for rows.Next() {
		var gotEmail, primaryEmail, firstName, gotPhone, customFields, mergeFields string
		if err := rows.Scan(&gotEmail, &primaryEmail, &firstName, &gotPhone, &customFields, &mergeFields); err != nil {
			rows.Close()
			t.Fatalf("scan erased subscriber: %v", err)
		}
		placeholders = append(placeholders, gotEmail)
		if gotEmail != primaryEmail || !strings.HasSuffix(gotEmail, "@"+erasedEmailDomain) {
			t.Fatalf("subscriber identity was not replaced consistently: email=%q primary=%q", gotEmail, primaryEmail)
		}
		joined := strings.ToLower(strings.Join([]string{firstName, gotPhone, customFields, mergeFields}, " "))
		for _, forbidden := range []string{strings.ToLower(name), strings.ToLower(phone), strings.ToLower(email)} {
			if strings.Contains(joined, forbidden) {
				t.Fatalf("erased subscriber retained %q in %q", forbidden, joined)
			}
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatalf("iterate erased subscribers: %v", err)
	}
	rows.Close()
	sort.Strings(placeholders)
	wantPlaceholders := []string{first.Placeholder, second.Placeholder}
	sort.Strings(wantPlaceholders)
	if fmt.Sprint(placeholders) != fmt.Sprint(wantPlaceholders) {
		t.Fatalf("stored placeholders = %v, want %v", placeholders, wantPlaceholders)
	}

	var leakedAddresses, satelliteRows, frequencyCapEvents, canonicalTombstones, legacyTombstones int
	if err := tx.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM subscriber_emails WHERE tenant_id=$1::uuid AND lower(email::text)=lower($2)) +
  (SELECT count(*) FROM subscriber_suppressions WHERE tenant_id=$1::uuid AND lower(email::text)=lower($2)) +
  (SELECT count(*) FROM suppressions WHERE tenant_id=$1::uuid AND lower(email::text)=lower($2)) +
  (SELECT count(*) FROM email_suppressions WHERE tenant_id=$1::uuid AND lower(email::text)=lower($2)),
  (SELECT count(*) FROM subscriber_attribute_history WHERE tenant_id=$1::uuid AND subscriber_id=ANY($3::uuid[])) +
  (SELECT count(*) FROM profile_aliases WHERE tenant_id=$1::uuid AND subscriber_id=ANY($3::uuid[])) +
  (SELECT count(*) FROM subscriber_computed_traits WHERE tenant_id=$1::uuid AND subscriber_id=ANY($3::uuid[])) +
  (SELECT count(*) FROM subscriber_prediction_metadata WHERE tenant_id=$1::uuid AND subscriber_id=ANY($3::uuid[])),
  (SELECT count(*) FROM frequency_cap_events WHERE tenant_id=$1::uuid AND lower(subscriber_email)=lower($2)),
  (SELECT count(*) FROM subscriber_suppressions WHERE tenant_id=$1::uuid AND email_sha256=encode(digest(lower($2),'sha256'),'hex')),
  (SELECT count(*) FROM suppressions WHERE tenant_id=$1::uuid AND email_sha256=encode(digest(lower($2),'sha256'),'hex'))`,
		tenantID, email, []string{firstID, secondID}).Scan(
		&leakedAddresses, &satelliteRows, &frequencyCapEvents,
		&canonicalTombstones, &legacyTombstones,
	); err != nil {
		t.Fatalf("verify erasure invariants: %v", err)
	}
	if leakedAddresses != 0 || satelliteRows != 0 || frequencyCapEvents != 0 {
		t.Fatalf("erasure left plaintext_addresses=%d profile_satellites=%d frequency_cap_events=%d",
			leakedAddresses, satelliteRows, frequencyCapEvents)
	}
	if canonicalTombstones != 1 || legacyTombstones != 1 {
		t.Fatalf("hash tombstones canonical=%d legacy=%d, want 1/1", canonicalTombstones, legacyTombstones)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit repeat erasure: %v", err)
	}

	otherTx, err = db.WithTenant(ctx, pool, otherTenantID)
	if err != nil {
		t.Fatalf("other tenant verification transaction: %v", err)
	}
	defer func() { _ = otherTx.Rollback(ctx) }()
	var otherEmail, otherName, otherPhone string
	if err := otherTx.QueryRow(ctx, `
SELECT email::text, first_name, COALESCE(phone_e164, '')
  FROM subscribers
 WHERE tenant_id=$1::uuid AND lower(email::text)=lower($2)`, otherTenantID, email).Scan(
		&otherEmail, &otherName, &otherPhone,
	); err != nil {
		t.Fatalf("read cross-tenant canary: %v", err)
	}
	if otherEmail != email || otherName != name || otherPhone != phone {
		t.Fatalf("cross-tenant subscriber was mutated: email=%q name=%q phone=%q", otherEmail, otherName, otherPhone)
	}
	var otherFrequencyCapEvents int
	if err := otherTx.QueryRow(ctx, `
SELECT count(*) FROM frequency_cap_events
 WHERE tenant_id=$1::uuid AND subscriber_email=$2`, otherTenantID, email).Scan(
		&otherFrequencyCapEvents,
	); err != nil {
		t.Fatalf("read cross-tenant frequency-cap event: %v", err)
	}
	if otherFrequencyCapEvents != 1 {
		t.Fatalf("cross-tenant frequency-cap events = %d, want 1", otherFrequencyCapEvents)
	}
	if err := otherTx.Commit(ctx); err != nil {
		t.Fatalf("commit cross-tenant verification: %v", err)
	}
}
