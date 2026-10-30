// SPDX-License-Identifier: AGPL-3.0-only

package sending

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
	"github.com/postwave/postwave/apps/api/internal/verification"
)

func recipientHealthDBExec(t *testing.T, pool *db.Pool, tenantID, query string, args ...any) {
	t.Helper()
	tx, err := db.WithTenant(t.Context(), pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	if _, err := tx.Exec(t.Context(), query, args...); err != nil {
		t.Fatalf("recipient-health fixture: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatalf("commit recipient-health fixture: %v", err)
	}
}

func seedClassifiedRecipientEvent(
	t *testing.T,
	pool *db.Pool,
	tenantID, email, classification string,
	at time.Time,
) {
	t.Helper()
	ctx := t.Context()
	tx, err := db.WithTenantWorker(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin classifier fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('app.engagement_classifier_worker', 'true', true)`); err != nil {
		t.Fatalf("bind classifier fixture scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
WITH methodology AS (
    INSERT INTO engagement_classifier_methodology_versions (
        classifier_version, methodology_version, registry_version,
        configuration_hash, rollout_mode, configuration, release_note
    ) VALUES (
        'send-health-test.v1', 'send-health-test.v1', 'postwave.machine-source-registry.v2',
        encode(digest(convert_to($2 || $3 || $4::timestamptz::text, 'UTF8'), 'sha256'), 'hex'),
        'shadow', '{}'::jsonb, 'Send-time health classified-click fixture.'
    )
    RETURNING classifier_version, methodology_version, registry_version,
              configuration_hash
), event_row AS (
    INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type, at)
    VALUES ($1::uuid, $2, 'clicked', $4::timestamptz)
    RETURNING id, at
), observation AS (
    INSERT INTO subscriber_event_observations (
        tenant_id, subscriber_event_id, subscriber_event_at, source,
        idempotency_key, event_schema_version, event_type, occurred_at,
        privacy_expiry_at, observation_fingerprint
    )
    SELECT $1::uuid, event_row.id, event_row.at, 'send-health-test',
           'send-health-test:' || event_row.id::text, 'send-health-test.v1',
           'clicked', event_row.at, event_row.at + interval '1 day',
           encode(digest(convert_to('send-health-test:' || event_row.id::text, 'UTF8'), 'sha256'), 'hex')
      FROM event_row
    RETURNING id
)
INSERT INTO event_classifications (
    tenant_id, subscriber_event_id, subscriber_event_at, classification,
    machine_subtype, human_confidence, calibration_band, stable_reason,
    rules_fired, evidence, conflicts, observation_ids,
    classifier_version, methodology_version, registry_version,
    configuration_hash, shadow_mode, classified_at,
    classification_fingerprint
)
SELECT $1::uuid, event_row.id, event_row.at, $3,
       CASE WHEN $3 = 'machine' THEN 'unknown_bot' ELSE NULL END,
       CASE WHEN $3 = 'human' THEN 0.9900 ELSE 0 END,
       CASE WHEN $3 = 'human' THEN 'calibrated_human'
            WHEN $3 = 'machine' THEN 'deterministic_machine'
            ELSE 'ambiguous' END,
       CASE WHEN $3 = 'human' THEN 'R_SEND_HEALTH_TEST_HUMAN'
            WHEN $3 = 'machine' THEN 'R_SEND_HEALTH_TEST_MACHINE'
            ELSE 'R_SEND_HEALTH_TEST_UNKNOWN' END,
       ARRAY['R_SEND_HEALTH_TEST_FIXTURE'],
       jsonb_build_array(jsonb_build_object('source', 'send-health-test')),
       '[]'::jsonb, ARRAY[observation.id],
       methodology.classifier_version, methodology.methodology_version,
       methodology.registry_version, methodology.configuration_hash,
       true, $4::timestamptz,
       encode(digest(convert_to(event_row.id::text || $3, 'UTF8'), 'sha256'), 'hex')
  FROM event_row CROSS JOIN methodology CROSS JOIN observation`, tenantID, email, classification, at); err != nil {
		t.Fatalf("insert classified recipient event: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit classified recipient event: %v", err)
	}
}

// recipientHealthFixtureNow anchors the lookup fixtures to the real clock.
//
// The lookup under test takes an injected clock, but these rows live in tables
// that verification.Store.PurgeExpired sweeps across every tenant. That sweep
// judges expiry and retention by the database's now(), not by the injected
// clock. Anchored to a fixed past date, a row these tests mean to be live, such
// as revalidated@'s trusted-valid cache fact "expiring in 29 days", was already
// expired in real time. Any sweep that ran mid-test deleted it, and the
// retained terminal snapshot then blocked an address the test asserts was
// recovered. On the real clock every fixture has the same standing for the
// sweep as for the lookup. A fixture that is live or inside retention for one
// is live or inside retention for the other. The one exception is deliberate:
// see recipientHealthSweepMargin.
func recipientHealthFixtureNow() time.Time {
	return time.Now().UTC().Truncate(time.Second)
}

// recipientHealthSweepMargin is how far ahead of the database's clock the
// retention test runs its lookup. The lookup and PurgeExpired both stop
// honoring address evidence recipientHealthEvidenceRetention after it was
// recorded: the lookup by its injected clock, the sweep by now(). On one clock,
// evidence the lookup must ignore is exactly evidence a concurrent sweep may
// already have deleted, and the test would then pass without the lookup ever
// having that evidence to ignore. With the lookup this far ahead, evidence can
// be past retention for the lookup and still inside it for the sweep.
const recipientHealthSweepMargin = 30 * 24 * time.Hour

func seedVerificationCacheFact(
	t *testing.T,
	pool *db.Pool,
	tenantID, email, status string,
	checkedAt, expiresAt time.Time,
) {
	t.Helper()
	tx, err := db.WithTenant(t.Context(), pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	if _, err := tx.Exec(t.Context(), `
INSERT INTO verification_cache (
  tenant_id, email, status, provider, checked_at, expires_at
) VALUES ($1::uuid, $2, $3, 'kickbox', $4, $5)
ON CONFLICT (tenant_id, email) DO UPDATE
SET status = EXCLUDED.status,
    provider = EXCLUDED.provider,
    checked_at = EXCLUDED.checked_at,
    expires_at = EXCLUDED.expires_at`,
		tenantID, normalizeSuppressionEmail(email), status, checkedAt, expiresAt,
	); err != nil {
		t.Fatalf("seed verification cache: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatalf("commit verification cache: %v", err)
	}
}

func seedHealthSnapshot(
	t *testing.T,
	pool *db.Pool,
	tenantID, email, grade, recommendation, verificationStatus string,
	verificationCheckedAt *time.Time,
	hardStop bool,
	computedAt time.Time,
	evidence []healthSnapshotEvidence,
) {
	t.Helper()
	if evidence == nil {
		evidence = []healthSnapshotEvidence{}
	}
	rawEvidence, err := json.Marshal(evidence)
	if err != nil {
		t.Fatalf("marshal evidence: %v", err)
	}
	tx, err := db.WithTenant(t.Context(), pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	if _, err := tx.Exec(t.Context(), `
INSERT INTO email_health_snapshots (
  tenant_id, email, grade, recommendation, hard_stop, reason_codes,
  evidence, verification_status, verification_provider,
  verification_checked_at, computed_at
) VALUES (
  $1::uuid, $2, $3, $4, $5, ARRAY['sending_gate_test']::text[],
  $6::jsonb, NULLIF($7, ''),
  CASE WHEN NULLIF($7, '') IS NULL THEN NULL ELSE 'kickbox' END,
  $8, $9
)
ON CONFLICT (tenant_id, email) DO UPDATE
SET grade = EXCLUDED.grade,
    recommendation = EXCLUDED.recommendation,
    hard_stop = EXCLUDED.hard_stop,
    reason_codes = EXCLUDED.reason_codes,
    evidence = EXCLUDED.evidence,
    verification_status = EXCLUDED.verification_status,
    verification_provider = EXCLUDED.verification_provider,
    verification_checked_at = EXCLUDED.verification_checked_at,
    computed_at = EXCLUDED.computed_at`,
		tenantID, normalizeSuppressionEmail(email), grade, recommendation, hardStop,
		rawEvidence, verificationStatus, verificationCheckedAt, computedAt,
	); err != nil {
		t.Fatalf("seed health snapshot: %v", err)
	}
	if err := tx.Commit(t.Context()); err != nil {
		t.Fatalf("commit health snapshot: %v", err)
	}
}

func TestDBRecipientHealthLookupTerminalCacheSurvivesExpiryAndIsTenantScoped(t *testing.T) {
	pool := requireDB(t)
	tenantID, _ := fixtureTenant(t, pool, 0, nil, "", "", "")
	otherTenantID, _ := fixtureTenant(t, pool, 0, nil, "", "", "")
	now := recipientHealthFixtureNow()

	seedVerificationCacheFact(t, pool, tenantID, "invalid@example.com", "invalid", now.Add(-90*24*time.Hour), now.Add(-60*24*time.Hour))
	seedVerificationCacheFact(t, pool, tenantID, "valid@example.com", "valid", now.Add(-90*24*time.Hour), now.Add(-60*24*time.Hour))
	seedVerificationCacheFact(t, pool, tenantID, "catchall@example.com", "catch_all", now, now.Add(24*time.Hour))
	seedVerificationCacheFact(t, pool, tenantID, "unknown@example.com", "unknown", now, now.Add(24*time.Hour))
	seedVerificationCacheFact(t, pool, otherTenantID, "other-only@example.com", "spamtrap", now, now.Add(24*time.Hour))

	lookup := &postgresRecipientHealthLookup{Pool: pool, Now: func() time.Time { return now }}
	got, err := lookup.Lookup(t.Context(), tenantID, []string{
		"invalid@example.com", "valid@example.com", "catchall@example.com",
		"unknown@example.com", "other-only@example.com", "no-data@example.com",
	})
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if decision := got["invalid@example.com"]; !decision.Blocked || decision.Reason != "verification_invalid" {
		t.Fatalf("expired terminal cache decision = %+v", decision)
	}
	for _, email := range []string{
		"valid@example.com", "catchall@example.com", "unknown@example.com",
		"other-only@example.com", "no-data@example.com",
	} {
		if got[email].Blocked {
			t.Fatalf("eligible/cross-tenant address %s blocked: %+v", email, got[email])
		}
	}
	if len(got) != 6 {
		t.Fatalf("decision map length = %d, want 6", len(got))
	}
}

func TestDBRecipientHealthLookupDoesNotExtendExpiredAddressEvidenceRetention(t *testing.T) {
	pool := requireDB(t)
	tenantID, _ := fixtureTenant(t, pool, 0, nil, "", "", "")
	seededAt := recipientHealthFixtureNow()
	now := seededAt.Add(recipientHealthSweepMargin)
	// A day past retention for the lookup, and recipientHealthSweepMargin less
	// a day inside it for PurgeExpired, which therefore retains all three rows.
	ancient := now.Add(-recipientHealthEvidenceRetention - 24*time.Hour)

	seedVerificationCacheFact(t, pool, tenantID, "ancient-cache@example.com", "invalid", ancient, ancient.Add(time.Hour))
	seedHealthSnapshot(t, pool, tenantID, "ancient-snapshot@example.com", "F", "blocked", "spamtrap", &ancient, false, ancient, nil)
	// A recently recomputed legacy snapshot must not launder an ancient terminal
	// verification timestamp into a new 365-day send block.
	seedHealthSnapshot(t, pool, tenantID, "refreshed-ancient@example.com", "F", "blocked", "invalid", &ancient, false, seededAt, nil)

	lookup := &postgresRecipientHealthLookup{Pool: pool, Now: func() time.Time { return now }}
	got, err := lookup.Lookup(t.Context(), tenantID, []string{
		"ancient-cache@example.com", "ancient-snapshot@example.com", "refreshed-ancient@example.com",
	})
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	for email, decision := range got {
		if decision.Blocked {
			t.Fatalf("expired address evidence blocked %s: %+v", email, decision)
		}
	}

	// Every fixture row outlived the lookup, so the lookup had each piece of
	// ancient evidence in front of it and still declined to block. Without
	// this, a row deleted before the lookup would pass the loop above unseen.
	tx, err := db.WithTenant(t.Context(), pool, tenantID)
	if err != nil {
		t.Fatalf("begin fixture presence check: %v", err)
	}
	defer func() { _ = tx.Rollback(t.Context()) }()
	var cacheRows, snapshotRows int
	if err := tx.QueryRow(t.Context(), `
SELECT (SELECT count(*) FROM verification_cache
         WHERE tenant_id = $1::uuid AND email = 'ancient-cache@example.com'),
       (SELECT count(*) FROM email_health_snapshots
         WHERE tenant_id = $1::uuid
           AND email IN ('ancient-snapshot@example.com', 'refreshed-ancient@example.com'))`,
		tenantID).Scan(&cacheRows, &snapshotRows); err != nil {
		t.Fatalf("count fixture rows: %v", err)
	}
	if cacheRows != 1 || snapshotRows != 2 {
		t.Fatalf("fixture rows after lookup: cache=%d snapshots=%d, want 1 and 2", cacheRows, snapshotRows)
	}
}

func TestDBRecipientHealthLookupSnapshotFreshnessAndAuthority(t *testing.T) {
	pool := requireDB(t)
	tenantID, _ := fixtureTenant(t, pool, 0, nil, "", "", "")
	now := recipientHealthFixtureNow()
	old := now.Add(-180 * 24 * time.Hour)
	recent := now.Add(-24 * time.Hour)

	terminalAt := now.Add(-60 * 24 * time.Hour)
	seedHealthSnapshot(t, pool, tenantID, "terminal@example.com", "F", "blocked", "invalid", &terminalAt, false, terminalAt, nil)
	seedHealthSnapshot(t, pool, tenantID, "hard-evidence@example.com", "F", "blocked", "", nil, false, old,
		[]healthSnapshotEvidence{{Kind: "complaint", At: old}})
	seedHealthSnapshot(t, pool, tenantID, "hard-stop-only@example.com", "F", "blocked", "", nil, true, recent,
		[]healthSnapshotEvidence{{Kind: "hard_stop", At: recent}})
	seedHealthSnapshot(t, pool, tenantID, "recent-d@example.com", "D", "do_not_send", "", nil, false, now,
		[]healthSnapshotEvidence{{Kind: "soft_bounce", At: recent}})
	seedHealthSnapshot(t, pool, tenantID, "recent-hard-d@example.com", "D", "do_not_send", "", nil, false, now,
		[]healthSnapshotEvidence{{Kind: "hard_bounce", At: recent}})
	seedHealthSnapshot(t, pool, tenantID, "stale-d@example.com", "D", "do_not_send", "", nil, false, now,
		[]healthSnapshotEvidence{{Kind: "soft_bounce", At: now.Add(-31 * 24 * time.Hour)}})
	// A legacy pre-policy snapshot may still say F for an old historical hard
	// bounce. Dispatch derives recoverability from dated evidence, not the stale
	// letter, so this must not become a permanent send block.
	seedHealthSnapshot(t, pool, tenantID, "stale-hard@example.com", "F", "blocked", "", nil, false, now,
		[]healthSnapshotEvidence{{Kind: "hard_bounce", At: now.Add(-31 * 24 * time.Hour)}})
	seedHealthSnapshot(t, pool, tenantID, "retired-hard@example.com", "B", "send", "", nil, false, now,
		[]healthSnapshotEvidence{
			{Kind: "hard_bounce", At: now.Add(-48 * time.Hour)},
			{Kind: "delivered", At: now.Add(-time.Hour)},
		})
	seedHealthSnapshot(t, pool, tenantID, "catchall@example.com", "C", "caution", "catch_all", &recent, false, now, nil)
	seedHealthSnapshot(t, pool, tenantID, "unknown@example.com", "U", "caution", "unknown", &recent, false, now, nil)

	olderTerminal := now.Add(-10 * 24 * time.Hour)
	seedHealthSnapshot(t, pool, tenantID, "revalidated@example.com", "F", "blocked", "invalid", &olderTerminal, false, olderTerminal, nil)
	seedVerificationCacheFact(t, pool, tenantID, "revalidated@example.com", "valid", now.Add(-time.Hour), now.Add(29*24*time.Hour))
	seedHealthSnapshot(t, pool, tenantID, "unknown-newer@example.com", "F", "blocked", "invalid", &olderTerminal, false, olderTerminal, nil)
	seedVerificationCacheFact(t, pool, tenantID, "unknown-newer@example.com", "unknown", now.Add(-time.Hour), now.Add(29*24*time.Hour))
	seedHealthSnapshot(t, pool, tenantID, "catchall-newer@example.com", "F", "blocked", "spamtrap", &olderTerminal, false, olderTerminal, nil)
	seedVerificationCacheFact(t, pool, tenantID, "catchall-newer@example.com", "catch_all", now.Add(-time.Hour), now.Add(29*24*time.Hour))

	newerTerminal := now.Add(-time.Hour)
	seedHealthSnapshot(t, pool, tenantID, "terminal-newer@example.com", "F", "blocked", "invalid", &newerTerminal, false, newerTerminal, nil)
	seedVerificationCacheFact(t, pool, tenantID, "terminal-newer@example.com", "valid", now.Add(-24*time.Hour), now.Add(29*24*time.Hour))

	emails := []string{
		"terminal@example.com", "hard-evidence@example.com", "hard-stop-only@example.com",
		"recent-d@example.com", "recent-hard-d@example.com", "stale-d@example.com", "stale-hard@example.com",
		"retired-hard@example.com", "catchall@example.com",
		"unknown@example.com", "revalidated@example.com", "terminal-newer@example.com",
		"unknown-newer@example.com", "catchall-newer@example.com",
	}
	lookup := &postgresRecipientHealthLookup{Pool: pool, Now: func() time.Time { return now }}
	got, err := lookup.Lookup(t.Context(), tenantID, emails)
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	for email, wantReason := range map[string]string{
		"terminal@example.com":       "verification_invalid",
		"hard-evidence@example.com":  "hard_complaint",
		"recent-d@example.com":       "recent_negative",
		"recent-hard-d@example.com":  "recent_negative",
		"terminal-newer@example.com": "verification_invalid",
		"unknown-newer@example.com":  "verification_invalid",
		"catchall-newer@example.com": "verification_spamtrap",
	} {
		if decision := got[email]; !decision.Blocked || decision.Reason != wantReason {
			t.Errorf("%s decision = %+v, want blocked reason %s", email, decision, wantReason)
		}
	}
	for _, email := range []string{
		"hard-stop-only@example.com", "stale-d@example.com", "stale-hard@example.com",
		"retired-hard@example.com", "catchall@example.com",
		"unknown@example.com", "revalidated@example.com",
	} {
		if decision := got[email]; decision.Blocked {
			t.Errorf("%s must remain caution/eligible: %+v", email, decision)
		}
	}
	if decision := got["recent-hard-d@example.com"]; decision.SuppressionReason != "hard_bounce" {
		t.Fatalf("recent hard bounce taxonomy = %+v, want hard_bounce", decision)
	}
}

func TestDBRecipientHealthLookupUntrustedSnapshotValidCannotRetireBounce(t *testing.T) {
	pool := requireDB(t)
	tenantID, _ := fixtureTenant(t, pool, 0, nil, "", "", "")
	now := time.Now().UTC().Truncate(time.Second)
	checkedAt := now.Add(-time.Hour)
	const email = "forged-local-valid@example.com"
	seedHealthSnapshot(
		t, pool, tenantID, email, "U", "caution", "valid", &checkedAt,
		false, now,
		[]healthSnapshotEvidence{{Kind: "hard_bounce", At: now.Add(-2 * time.Hour)}},
	)
	// email_health_snapshots intentionally remains compatible with historical
	// rows. Simulate a forged legacy local-valid row that the runtime boundary
	// must never treat as affirmative recovery.
	recipientHealthDBExec(t, pool, tenantID, `
UPDATE email_health_snapshots
   SET verification_provider = 'local'
 WHERE tenant_id = $1::uuid AND email = $2`, tenantID, email)

	lookup := &postgresRecipientHealthLookup{Pool: pool, Now: func() time.Time { return now }}
	got, err := lookup.Lookup(t.Context(), tenantID, []string{email})
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if decision := got[email]; !decision.Blocked || decision.Reason != "recent_negative" {
		t.Fatalf("forged local valid retired historical bounce: %+v", decision)
	}
}

func TestDBRecipientHealthLookupEnforcesLiveEventsWithoutSnapshot(t *testing.T) {
	pool := requireDB(t)
	tenantID, _ := fixtureTenant(t, pool, 0, nil, "", "", "")
	now := time.Now().UTC().Truncate(time.Second)

	recipientHealthDBExec(t, pool, tenantID, `
INSERT INTO subscriber_events (
    tenant_id, subscriber_email, event_type, bounce_type, at
) VALUES
    ($1::uuid, 'soft-live@example.com', 'bounced', 'soft', $2),
    ($1::uuid, 'delivered-live@example.com', 'bounced', 'soft', $2),
    ($1::uuid, 'machine-live@example.com', 'bounced', 'soft', $2),
    ($1::uuid, 'human-live@example.com', 'bounced', 'hard', $2),
    ($1::uuid, 'stale-live@example.com', 'bounced', 'hard', $3),
    ($1::uuid, 'future-live@example.com', 'bounced', 'soft', $4),
    ($1::uuid, 'delivered-live@example.com', 'delivered', NULL, $5),
    ($1::uuid, 'complaint-live@example.com', 'complained', NULL, $6),
    ($1::uuid, 'complaint-live@example.com', 'delivered', NULL, $5)`,
		tenantID, now.Add(-2*time.Hour), now.Add(-31*24*time.Hour),
		now.Add(recipientHealthFutureTolerance+time.Minute), now.Add(-time.Hour),
		now.Add(-120*24*time.Hour))
	seedClassifiedRecipientEvent(t, pool, tenantID, "machine-live@example.com", "machine", now.Add(-time.Hour))
	seedClassifiedRecipientEvent(t, pool, tenantID, "human-live@example.com", "human", now.Add(-time.Hour))

	emails := []string{
		"soft-live@example.com", "delivered-live@example.com",
		"machine-live@example.com", "human-live@example.com",
		"complaint-live@example.com", "stale-live@example.com",
		"future-live@example.com",
	}
	lookup := &postgresRecipientHealthLookup{Pool: pool, Now: func() time.Time { return now }}
	got, err := lookup.Lookup(t.Context(), tenantID, emails)
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	for _, email := range []string{"soft-live@example.com", "machine-live@example.com"} {
		if decision := got[email]; !decision.Blocked || decision.Reason != "recent_negative" {
			t.Errorf("%s decision = %+v, want live recent-negative block", email, decision)
		}
	}
	if decision := got["complaint-live@example.com"]; !decision.Blocked || decision.Reason != "hard_complaint" {
		t.Errorf("complaint decision = %+v, want terminal complaint block", decision)
	}
	for _, email := range []string{
		"delivered-live@example.com", "human-live@example.com",
		"stale-live@example.com", "future-live@example.com",
	} {
		if decision := got[email]; decision.Blocked {
			t.Errorf("%s should be eligible from live chronology: %+v", email, decision)
		}
	}
}

func TestDBCacheInvalidationPreservesTerminalSendEvidenceUntilTrustedRevalidation(t *testing.T) {
	pool := requireDB(t)
	tenantID, _ := fixtureTenant(t, pool, 0, nil, "", "", "")
	now := time.Now().UTC().Truncate(time.Second)
	checkedAt := now.Add(-time.Hour)
	const email = "invalidate-terminal@example.com"
	seedVerificationCacheFact(t, pool, tenantID, email, "invalid", checkedAt, now.Add(29*24*time.Hour))
	seedHealthSnapshot(t, pool, tenantID, email, "F", "blocked", "invalid", &checkedAt, false, checkedAt, nil)

	cache := &verification.TenantCache{
		Store: &verification.Store{Pool: pool}, TenantID: tenantID,
		Now: func() time.Time { return now },
	}
	before, err := cache.Get(t.Context(), []string{email})
	if err != nil || len(before) != 1 {
		t.Fatalf("initial cache Get = %v, %v; want one hit", before, err)
	}
	removed, err := cache.Invalidate(t.Context(), []string{email})
	if err != nil || removed != 1 {
		t.Fatalf("Invalidate removed=%d err=%v, want 1 nil", removed, err)
	}
	after, err := cache.Get(t.Context(), []string{email})
	if err != nil || len(after) != 0 {
		t.Fatalf("cache after invalidation = %v, %v; want miss so chain can reverify", after, err)
	}

	lookup := &postgresRecipientHealthLookup{Pool: pool, Now: func() time.Time { return now }}
	decisions, err := lookup.Lookup(t.Context(), tenantID, []string{email})
	if err != nil {
		t.Fatalf("Lookup after invalidation: %v", err)
	}
	if decision := decisions[email]; !decision.Blocked || decision.Reason != "verification_invalid" {
		t.Fatalf("terminal snapshot was not retained after invalidation: %+v", decision)
	}

	if err := cache.Put(t.Context(), []verification.Result{{
		Email: email, Status: verification.StatusValid,
		Provider: verification.ProviderKickbox, CheckedAt: now,
	}}); err != nil {
		t.Fatalf("Put trusted superseding validation: %v", err)
	}
	decisions, err = lookup.Lookup(t.Context(), tenantID, []string{email})
	if err != nil {
		t.Fatalf("Lookup after trusted revalidation: %v", err)
	}
	if decision := decisions[email]; decision.Blocked {
		t.Fatalf("newer trusted validation did not retire terminal snapshot: %+v", decision)
	}
}

func TestDBTerminalCacheHistorySurvivesMutationWithoutHealthRead(t *testing.T) {
	pool := requireDB(t)
	tenantID, _ := fixtureTenant(t, pool, 0, nil, "", "", "")
	now := time.Now().UTC().Truncate(time.Second)
	cache := &verification.TenantCache{
		Store: &verification.Store{Pool: pool}, TenantID: tenantID,
		Now: func() time.Time { return now },
	}
	lookup := &postgresRecipientHealthLookup{Pool: pool, Now: func() time.Time { return now }}

	const overwritten = "terminal-overwritten@example.com"
	if err := cache.Put(t.Context(), []verification.Result{{
		Email: overwritten, Status: verification.StatusInvalid,
		Provider: verification.ProviderKickbox, CheckedAt: now.Add(-2 * time.Hour),
	}}); err != nil {
		t.Fatalf("Put initial terminal result: %v", err)
	}
	// No health Resolve occurs between these writes. Unknown is newer but is not
	// trusted recovery, so replacing the reusable cache row must retain F.
	if err := cache.Put(t.Context(), []verification.Result{{
		Email: overwritten, Status: verification.StatusUnknown,
		Provider: verification.ProviderKickbox, CheckedAt: now.Add(-time.Hour),
	}}); err != nil {
		t.Fatalf("Put newer unknown result: %v", err)
	}
	decisions, err := lookup.Lookup(t.Context(), tenantID, []string{overwritten})
	if err != nil {
		t.Fatalf("Lookup overwritten terminal history: %v", err)
	}
	if decision := decisions[overwritten]; !decision.Blocked || decision.Reason != "verification_invalid" {
		t.Fatalf("Unknown erased terminal history without health read: %+v", decision)
	}

	const invalidated = "terminal-invalidated@example.com"
	if err := cache.Put(t.Context(), []verification.Result{{
		Email: invalidated, Status: verification.StatusSpamtrap,
		Provider: verification.ProviderZeroBounce, CheckedAt: now.Add(-2 * time.Hour),
	}}); err != nil {
		t.Fatalf("Put terminal result before invalidation: %v", err)
	}
	removed, err := cache.Invalidate(t.Context(), []string{invalidated})
	if err != nil || removed != 1 {
		t.Fatalf("Invalidate terminal result removed=%d err=%v, want 1 nil", removed, err)
	}
	if err := cache.Put(t.Context(), []verification.Result{{
		Email: invalidated, Status: verification.StatusUnknown,
		Provider: verification.ProviderZeroBounce, CheckedAt: now.Add(-time.Hour),
	}}); err != nil {
		t.Fatalf("Put Unknown after invalidation: %v", err)
	}
	decisions, err = lookup.Lookup(t.Context(), tenantID, []string{invalidated})
	if err != nil {
		t.Fatalf("Lookup invalidated terminal history: %v", err)
	}
	if decision := decisions[invalidated]; !decision.Blocked || decision.Reason != "verification_spamtrap" {
		t.Fatalf("invalidation erased terminal history without health read: %+v", decision)
	}

	// Local checks can disprove a mailbox but cannot prove one. Reject a forged
	// local Valid at the cache boundary and retain the terminal snapshot.
	if err := cache.Put(t.Context(), []verification.Result{{
		Email: overwritten, Status: verification.StatusValid,
		Provider: verification.ProviderLocal, CheckedAt: now,
	}}); err == nil {
		t.Fatal("forged local valid was accepted by cache Put")
	}
	decisions, err = lookup.Lookup(t.Context(), tenantID, []string{overwritten})
	if err != nil {
		t.Fatalf("Lookup after forged local valid: %v", err)
	}
	if decision := decisions[overwritten]; !decision.Blocked || decision.Reason != "verification_invalid" {
		t.Fatalf("forged local valid retired terminal history: %+v", decision)
	}

	// A genuinely newer provider-valid result is the only cache fact allowed to
	// retire either retained terminal snapshot.
	for _, email := range []string{overwritten, invalidated} {
		if err := cache.Put(t.Context(), []verification.Result{{
			Email: email, Status: verification.StatusValid,
			Provider: verification.ProviderKickbox, CheckedAt: now,
		}}); err != nil {
			t.Fatalf("Put trusted recovery for %s: %v", email, err)
		}
	}
	decisions, err = lookup.Lookup(t.Context(), tenantID, []string{overwritten, invalidated})
	if err != nil {
		t.Fatalf("Lookup trusted recovery: %v", err)
	}
	for _, email := range []string{overwritten, invalidated} {
		if decision := decisions[email]; decision.Blocked {
			t.Errorf("newer valid did not retire %s terminal history: %+v", email, decision)
		}
	}

	// Trusted recovery is itself durable chronology. Removing the reusable
	// cache row after the revalidation must not resurrect the older F snapshot.
	removed, err = cache.Invalidate(t.Context(), []string{overwritten, invalidated})
	if err != nil || removed != 2 {
		t.Fatalf("Invalidate trusted recoveries removed=%d err=%v, want 2 nil", removed, err)
	}
	if err := cache.Put(t.Context(), []verification.Result{{
		Email: overwritten, Status: verification.StatusInvalid,
		Provider: verification.ProviderKickbox, CheckedAt: now.Add(-3 * time.Hour),
	}}); err != nil {
		t.Fatalf("Put stale terminal after trusted recovery: %v", err)
	}
	decisions, err = lookup.Lookup(t.Context(), tenantID, []string{overwritten, invalidated})
	if err != nil {
		t.Fatalf("Lookup after trusted cache expiry simulation: %v", err)
	}
	for _, email := range []string{overwritten, invalidated} {
		if decision := decisions[email]; decision.Blocked {
			t.Errorf("expired recovery/stale result resurrected %s terminal history: %+v", email, decision)
		}
	}

	healthService := &verification.PostgresHealthService{
		Store: &verification.Store{Pool: pool}, Now: func() time.Time { return now },
	}
	health, err := healthService.Resolve(t.Context(), tenantID, []string{overwritten, invalidated})
	if err != nil {
		t.Fatalf("Resolve after trusted cache expiry simulation: %v", err)
	}
	for _, item := range health {
		if item.Grade != verification.HealthGradeA || !item.SendEligible {
			t.Errorf("expired trusted recovery health = %+v, want eligible A", item)
		}
	}
}

func TestDBRunOnceSkipsExpiredTerminalVerification(t *testing.T) {
	pool := requireDB(t)
	tenantID, campaignID := fixtureTenant(t, pool, 1, nil, "", "", "")
	email := campaignRecipientEmail(t, pool, tenantID, campaignID)
	now := time.Now().UTC()
	seedVerificationCacheFact(t, pool, tenantID, email, "spamtrap", now.Add(-60*24*time.Hour), now.Add(-30*24*time.Hour))

	base := NewSuppressionConvergerAdapter(suppressions.NewConverger(&suppressions.Store{Pool: pool}, nil))
	gate := NewRecipientSafetyGate(pool, base)
	sender := &mockListmonk{}
	n, err := suppressionTestGuard(pool, sender, gate).RunOnce(t.Context(), tenantID)
	if err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if n != 0 || sender.count() != 0 {
		t.Fatalf("attempted=%d sends=%d, want 0/0", n, sender.count())
	}
	if got := countByStatus(t, pool, tenantID, campaignID); got["skipped"] != 1 || len(got) != 1 {
		t.Fatalf("status counts = %v, want skipped=1", got)
	}
}

type batchThenBlockingRecipientHealth struct {
	delegate recipientHealthLookup
	mu       sync.Mutex
	calls    int
	started  chan struct{}
	release  chan struct{}
}

func (b *batchThenBlockingRecipientHealth) Lookup(ctx context.Context, tenantID string, emails []string) (map[string]recipientHealthDecision, error) {
	b.mu.Lock()
	b.calls++
	call := b.calls
	b.mu.Unlock()
	if call == 2 {
		close(b.started)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-b.release:
		}
	}
	return b.delegate.Lookup(ctx, tenantID, emails)
}

func TestDBRunOnceHealthAddedAfterBatchSnapshotIsCaughtByScalarRecheck(t *testing.T) {
	pool := requireDB(t)
	tenantID, campaignID := fixtureTenant(t, pool, 1, nil, "", "", "")
	email := campaignRecipientEmail(t, pool, tenantID, campaignID)
	base := NewSuppressionConvergerAdapter(suppressions.NewConverger(&suppressions.Store{Pool: pool}, nil))
	blocking := &batchThenBlockingRecipientHealth{
		delegate: &postgresRecipientHealthLookup{Pool: pool},
		started:  make(chan struct{}),
		release:  make(chan struct{}),
	}
	gate := &RecipientSafetyGate{Suppressions: base, health: blocking}
	sender := &mockListmonk{}

	type runResult struct {
		n   int
		err error
	}
	resultCh := make(chan runResult, 1)
	go func() {
		n, err := suppressionTestGuard(pool, sender, gate).RunOnce(context.Background(), tenantID)
		resultCh <- runResult{n: n, err: err}
	}()

	select {
	case <-blocking.started:
	case <-time.After(5 * time.Second):
		t.Fatal("send loop did not reach scalar recipient-health recheck")
	}
	released := false
	defer func() {
		if !released {
			close(blocking.release)
		}
	}()
	now := time.Now().UTC()
	seedVerificationCacheFact(t, pool, tenantID, email, "invalid", now, now.Add(30*24*time.Hour))
	close(blocking.release)
	released = true

	select {
	case result := <-resultCh:
		if result.err != nil {
			t.Fatalf("RunOnce: %v", result.err)
		}
		if result.n != 0 {
			t.Fatalf("attempted=%d, want 0", result.n)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("send loop did not finish after health recheck was released")
	}
	if sender.count() != 0 {
		t.Fatalf("upstream sends=%d, want 0", sender.count())
	}
	if got := countByStatus(t, pool, tenantID, campaignID); got["skipped"] != 1 || len(got) != 1 {
		t.Fatalf("status counts = %v, want skipped=1", got)
	}
}

func TestDBRecipientHealthLookupReturnsTotalNormalizedMap(t *testing.T) {
	pool := requireDB(t)
	tenantID, _ := fixtureTenant(t, pool, 0, nil, "", "", "")
	lookup := &postgresRecipientHealthLookup{Pool: pool}
	got, err := lookup.Lookup(t.Context(), tenantID, []string{
		" Person@Example.com ", "person@example.com", "second@example.com",
	})
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}
	if gotLen, want := len(got), 2; gotLen != want {
		t.Fatalf("map length=%d, want %d: %s", gotLen, want, fmt.Sprint(got))
	}
	if _, ok := got["person@example.com"]; !ok {
		t.Fatal("normalized person key omitted")
	}
	if _, ok := got["second@example.com"]; !ok {
		t.Fatal("second key omitted")
	}
}
