// SPDX-License-Identifier: AGPL-3.0-only

package verification

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func healthDBExec(t *testing.T, pool *db.Pool, tenantID, query string, args ...any) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, query, args...); err != nil {
		t.Fatalf("health fixture: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit health fixture: %v", err)
	}
}

func healthDBInsertClassifiedEvent(
	t *testing.T,
	pool *db.Pool,
	tenantID, email, eventType string,
	at time.Time,
	classification string,
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
        'health-test.v1', 'health-test.v1', 'postwave.machine-source-registry.v2',
        encode(digest(convert_to($2 || $3 || $4::timestamptz::text, 'UTF8'), 'sha256'), 'hex'),
        'shadow', '{}'::jsonb, 'Email-health classified-event regression fixture.'
    )
    RETURNING classifier_version, methodology_version, registry_version,
              configuration_hash
), event_row AS (
    INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type, at)
    VALUES ($1::uuid, $2, $3, $4::timestamptz)
    RETURNING id, at
), observation AS (
    INSERT INTO subscriber_event_observations (
        tenant_id, subscriber_event_id, subscriber_event_at, source,
        idempotency_key, event_schema_version, event_type, occurred_at,
        privacy_expiry_at, observation_fingerprint
    )
    SELECT $1::uuid, event_row.id, event_row.at, 'health-test',
           'health-test:' || event_row.id::text, 'health-test.v1', $3,
           event_row.at, event_row.at + interval '1 day',
           encode(digest(convert_to('health-test:' || event_row.id::text, 'UTF8'), 'sha256'), 'hex')
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
SELECT $1::uuid, event_row.id, event_row.at, $5,
       CASE WHEN $5 = 'machine' THEN 'unknown_bot' ELSE NULL END,
       CASE WHEN $5 = 'human' THEN 0.9900 ELSE 0 END,
       CASE WHEN $5 = 'human' THEN 'calibrated_human'
            WHEN $5 = 'machine' THEN 'deterministic_machine'
            ELSE 'ambiguous' END,
       CASE WHEN $5 = 'human' THEN 'R_HEALTH_TEST_HUMAN'
            WHEN $5 = 'machine' THEN 'R_HEALTH_TEST_MACHINE'
            ELSE 'R_HEALTH_TEST_UNKNOWN' END,
       ARRAY['R_HEALTH_TEST_FIXTURE'],
       jsonb_build_array(jsonb_build_object('source', 'health-test')),
       '[]'::jsonb, ARRAY[observation.id],
       methodology.classifier_version, methodology.methodology_version,
       methodology.registry_version, methodology.configuration_hash,
       true, $4::timestamptz,
       encode(digest(convert_to(event_row.id::text || $5, 'UTF8'), 'sha256'), 'hex')
  FROM event_row CROSS JOIN methodology CROSS JOIN observation`,
		tenantID, email, eventType, at, classification); err != nil {
		t.Fatalf("insert classified health event: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit classified health event: %v", err)
	}
}

func TestDBEmailHealthResolveMaterializesAndUpsertsSnapshot(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	now := time.Now().UTC().Truncate(time.Second)
	healthDBExec(t, pool, tenantID, `
INSERT INTO verification_cache (
    tenant_id, email, status, provider, checked_at, expires_at
) VALUES ($1::uuid, 'person@example.com', 'valid', 'kickbox', $2, $3)`,
		tenantID, now.Add(-2*time.Hour), now.Add(28*24*time.Hour))

	service := &PostgresHealthService{
		Store: newStore(t, pool, nil), Now: func() time.Time { return now },
	}
	results, err := service.Resolve(context.Background(), tenantID, []string{"Person@Example.COM"})
	if err != nil {
		t.Fatalf("Resolve A: %v", err)
	}
	if len(results) != 1 || results[0].Grade != HealthGradeA {
		t.Fatalf("results = %+v, want one A", results)
	}

	// A classified human reply is retained as evidence while the fresh
	// validation keeps A precedence. ON CONFLICT must update the one snapshot.
	healthDBExec(t, pool, tenantID, `
INSERT INTO campaign_replies (
    tenant_id, recipient_email, source, received_at, classification, classified_at
) VALUES ($1::uuid, 'person@example.com', 'manual', $2, 'human_reply', $2)`,
		tenantID, now.Add(-time.Hour))
	results, err = service.Resolve(context.Background(), tenantID, []string{"person@example.com"})
	if err != nil {
		t.Fatalf("Resolve B: %v", err)
	}
	if results[0].Grade != HealthGradeA || results[0].ReasonCodes[0] != "verification_valid_30d" {
		t.Fatalf("fresh validation must retain A precedence over reply activity: %+v", results[0])
	}

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin snapshot read: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var count int
	var grade, model, status, provider string
	var hardStop bool
	var checkedAt time.Time
	if err := tx.QueryRow(ctx, `
SELECT count(*) OVER (), grade, model_version, hard_stop,
       verification_status, verification_provider, verification_checked_at
  FROM email_health_snapshots
 WHERE tenant_id = $1::uuid AND email = 'person@example.com'`, tenantID).
		Scan(&count, &grade, &model, &hardStop, &status, &provider, &checkedAt); err != nil {
		t.Fatalf("read snapshot: %v", err)
	}
	if count != 1 || grade != "A" || model != HealthModelVersion || hardStop ||
		status != string(StatusValid) || provider != ProviderKickbox || !checkedAt.Equal(now.Add(-2*time.Hour)) {
		t.Fatalf("snapshot count=%d grade=%q model=%q hard=%v status=%q provider=%q checked=%v",
			count, grade, model, hardStop, status, provider, checkedAt)
	}
}

func TestDBEmailHealthReadDoesNotMaterializeUnbackedAddresses(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	now := time.Now().UTC().Truncate(time.Second)
	service := &PostgresHealthService{
		Store: newStore(t, pool, nil), Now: func() time.Time { return now },
	}

	results, err := service.Resolve(context.Background(), tenantID, []string{
		"never-seen@example.com", "not-an-email",
	})
	if err != nil {
		t.Fatalf("Resolve unbacked addresses: %v", err)
	}
	if len(results) != 2 || results[0].Grade != HealthGradeU || results[1].Grade != HealthGradeF {
		t.Fatalf("unbacked response semantics = %+v, want U then synthetic F", results)
	}

	ctx := t.Context()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin snapshot count: %v", err)
	}
	var count int
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM email_health_snapshots
 WHERE tenant_id = $1::uuid
   AND email = ANY($2::text[])`, tenantID,
		[]string{"never-seen@example.com", "not-an-email"}).Scan(&count); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("count unbacked snapshots: %v", err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("rollback snapshot count: %v", err)
	}
	if count != 0 {
		t.Fatalf("unbacked health lookup materialized %d snapshots, want 0", count)
	}

	// A real tenant-owned cache fact remains eligible for materialization.
	healthDBExec(t, pool, tenantID, `
INSERT INTO verification_cache (
    tenant_id, email, status, provider, checked_at, expires_at
) VALUES ($1::uuid, 'backed@example.com', 'valid', 'kickbox', $2, $3)`,
		tenantID, now.Add(-time.Hour), now.Add(29*24*time.Hour))
	results, err = service.Resolve(context.Background(), tenantID, []string{"backed@example.com"})
	if err != nil {
		t.Fatalf("Resolve backed address: %v", err)
	}
	if len(results) != 1 || results[0].Grade != HealthGradeA {
		t.Fatalf("backed result = %+v, want A", results)
	}
	tx, err = db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin backed snapshot count: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM email_health_snapshots
 WHERE tenant_id = $1::uuid AND email = 'backed@example.com'`, tenantID).Scan(&count); err != nil {
		t.Fatalf("count backed snapshot: %v", err)
	}
	if count != 1 {
		t.Fatalf("backed health lookup materialized %d snapshots, want 1", count)
	}
}

func TestDBEmailHealthRejectsMalformedLegacyVerificationWithoutEchoingIt(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	now := time.Now().UTC().Truncate(time.Second)
	const email = "private-forged-local-valid@example.com"
	// Snapshot storage predates the canonical provider/status constraint and
	// can therefore contain legacy combinations. Runtime reads must fail closed:
	// a local DNS result can never manufacture a mailbox-valid A.
	healthDBExec(t, pool, tenantID, `
INSERT INTO email_health_snapshots (
    tenant_id, email, grade, recommendation, hard_stop, reason_codes,
    evidence, verification_status, verification_provider,
    verification_checked_at, model_version, computed_at
) VALUES (
    $1::uuid, $2, 'A', 'send', false, ARRAY['legacy_forged'],
    '[]'::jsonb, 'valid', 'local', $3, $4, $3
)`, tenantID, email, now, HealthModelVersion)

	service := &PostgresHealthService{
		Store: newStore(t, pool, nil), Now: func() time.Time { return now },
	}
	results, err := service.Resolve(t.Context(), tenantID, []string{email})
	if err == nil || len(results) != 0 {
		t.Fatalf("malformed legacy verification results=%+v err=%v, want closed error", results, err)
	}
	if err.Error() != errStoredHealthVerificationInvalid.Error() ||
		strings.Contains(err.Error(), email) || strings.Contains(err.Error(), "local") {
		t.Fatalf("malformed legacy error exposed stored detail: %q", err)
	}
}

func TestDBEmailHealthActiveSuppressionCannotBeOverriddenByPositiveEvidence(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	now := time.Now().UTC().Truncate(time.Second)
	healthDBExec(t, pool, tenantID, `
INSERT INTO verification_cache (
    tenant_id, email, status, provider, checked_at, expires_at
) VALUES ($1::uuid, 'blocked@example.com', 'valid', 'zerobounce', $2, $3)`,
		tenantID, now.Add(-time.Hour), now.Add(29*24*time.Hour))
	healthDBExec(t, pool, tenantID, `
INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type, at)
VALUES ($1::uuid, 'blocked@example.com', 'clicked', $2)`,
		tenantID, now.Add(-time.Hour))
	healthDBExec(t, pool, tenantID, `
INSERT INTO subscriber_suppressions (
    tenant_id, email, reason, source, source_event_id, created_at
) VALUES (
    $1::uuid, 'blocked@example.com', 'hard_bounce', 'manual', 'health-hard-stop', $2
)`, tenantID, now.Add(-time.Hour))

	service := &PostgresHealthService{
		Store: newStore(t, pool, nil), Now: func() time.Time { return now },
	}
	results, err := service.Resolve(context.Background(), tenantID, []string{"blocked@example.com"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	got := results[0]
	if got.Grade != HealthGradeF || got.Recommendation != HealthRecommendationBlocked ||
		!got.HardStop || got.SendEligible {
		t.Fatalf("active suppression was overridden: %+v", got)
	}
}

func TestDBEmailHealthRecentSoftBounceUsesChronology(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	now := time.Now().UTC().Truncate(time.Second)
	healthDBExec(t, pool, tenantID, `
INSERT INTO subscriber_events (
    tenant_id, subscriber_email, event_type, bounce_type, at
) VALUES ($1::uuid, 'chronology@example.com', 'bounced', 'soft', $2)`,
		tenantID, now.Add(-2*time.Hour))

	service := &PostgresHealthService{
		Store: newStore(t, pool, nil), Now: func() time.Time { return now },
	}
	results, err := service.Resolve(context.Background(), tenantID, []string{"chronology@example.com"})
	if err != nil {
		t.Fatalf("Resolve D: %v", err)
	}
	if results[0].Grade != HealthGradeD {
		t.Fatalf("soft bounce = %+v, want D", results[0])
	}

	// A genuinely later high-confidence click can retire a non-active soft
	// warning. If another negative arrives after it, resolver tests prove D wins.
	healthDBInsertClassifiedEvent(t, pool, tenantID, "chronology@example.com",
		"clicked", now.Add(-time.Hour), "human")
	results, err = service.Resolve(context.Background(), tenantID, []string{"chronology@example.com"})
	if err != nil {
		t.Fatalf("Resolve B: %v", err)
	}
	if results[0].Grade != HealthGradeB {
		t.Fatalf("newer click = %+v, want B", results[0])
	}
}

func TestDBEmailHealthOnlyExplicitHumanClicksEarnB(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	now := time.Now().UTC().Truncate(time.Second)
	tests := []struct {
		email, eventType, classification string
		want                             HealthGrade
	}{
		{"human-click@example.com", "clicked", "human", HealthGradeB},
		{"machine-click@example.com", "clicked", "machine", HealthGradeU},
		{"unknown-click@example.com", "clicked", "unknown", HealthGradeU},
		{"human-open@example.com", "opened", "human", HealthGradeU},
		{"machine-open@example.com", "opened", "machine", HealthGradeU},
	}
	emails := make([]string, 0, len(tests)+1)
	for _, tt := range tests {
		healthDBInsertClassifiedEvent(t, pool, tenantID, tt.email, tt.eventType,
			now.Add(-time.Hour), tt.classification)
		emails = append(emails, tt.email)
	}
	// Missing classification is projected as unknown by the canonical shadow
	// view and must be no more trusted than an explicit unknown decision.
	const unclassified = "unclassified-click@example.com"
	healthDBExec(t, pool, tenantID, `
INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type, at)
VALUES ($1::uuid, $2, 'clicked', $3)`, tenantID, unclassified, now.Add(-time.Hour))
	emails = append(emails, unclassified)

	service := &PostgresHealthService{
		Store: newStore(t, pool, nil), Now: func() time.Time { return now },
	}
	results, err := service.Resolve(context.Background(), tenantID, emails)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	byEmail := make(map[string]EmailHealth, len(results))
	for _, result := range results {
		byEmail[result.Email] = result
	}
	for _, tt := range tests {
		if got := byEmail[tt.email]; got.Grade != tt.want {
			t.Errorf("%s/%s = %+v, want %s", tt.eventType, tt.classification, got, tt.want)
		}
	}
	if got := byEmail[unclassified]; got.Grade != HealthGradeU {
		t.Fatalf("unclassified click = %+v, want U", got)
	}
}

func TestDBEmailHealthEventWindowPreservesHistoricalComplaints(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	now := time.Now().UTC().Truncate(time.Second)
	healthDBExec(t, pool, tenantID, `
INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type, at)
VALUES
    ($1::uuid, 'old-complaint@example.com', 'complained', $2),
    ($1::uuid, 'old-delivery@example.com', 'delivered', $2),
	($1::uuid, 'old-bounce@example.com', 'bounced', $4),
    ($1::uuid, 'future-complaint@example.com', 'complained', $3)`,
		tenantID, now.Add(-120*24*time.Hour),
		now.Add(healthFutureClockTolerance+time.Minute), now.Add(-31*24*time.Hour))

	service := &PostgresHealthService{
		Store: newStore(t, pool, nil), Now: func() time.Time { return now },
	}
	results, err := service.Resolve(context.Background(), tenantID, []string{
		"old-complaint@example.com", "old-delivery@example.com",
		"old-bounce@example.com", "future-complaint@example.com",
	})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	byEmail := make(map[string]EmailHealth, len(results))
	for _, result := range results {
		byEmail[result.Email] = result
	}
	if got := byEmail["old-complaint@example.com"]; got.Grade != HealthGradeF {
		t.Fatalf("historical complaint = %+v, want F", got)
	}
	for _, email := range []string{
		"old-delivery@example.com", "old-bounce@example.com",
		"future-complaint@example.com",
	} {
		if got := byEmail[email]; got.Grade != HealthGradeU {
			t.Errorf("out-of-window %s = %+v, want U", email, got)
		}
	}
	if got := byEmail["old-bounce@example.com"]; len(got.Evidence) != 0 {
		t.Fatalf("out-of-window bounce evidence = %+v, want bounded query omission", got.Evidence)
	}
}

func TestDBEmailHealthRecentHardBounceUsesSameRecoverableChronology(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	now := time.Now().UTC().Truncate(time.Second)
	healthDBExec(t, pool, tenantID, `
INSERT INTO subscriber_events (
    tenant_id, subscriber_email, event_type, bounce_type, at
) VALUES ($1::uuid, 'hard-chronology@example.com', 'bounced', 'hard', $2)`,
		tenantID, now.Add(-2*time.Hour))

	service := &PostgresHealthService{
		Store: newStore(t, pool, nil), Now: func() time.Time { return now },
	}
	results, err := service.Resolve(context.Background(), tenantID, []string{"hard-chronology@example.com"})
	if err != nil {
		t.Fatalf("Resolve D: %v", err)
	}
	if results[0].Grade != HealthGradeD || results[0].Recommendation != HealthRecommendationDoNotSend || results[0].SendEligible {
		t.Fatalf("recent historical hard bounce = %+v, want non-sendable D", results[0])
	}

	healthDBExec(t, pool, tenantID, `
INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type, at)
VALUES ($1::uuid, 'hard-chronology@example.com', 'delivered', $2)`,
		tenantID, now.Add(-time.Hour))
	results, err = service.Resolve(context.Background(), tenantID, []string{"hard-chronology@example.com"})
	if err != nil {
		t.Fatalf("Resolve B: %v", err)
	}
	if results[0].Grade != HealthGradeB || !results[0].SendEligible {
		t.Fatalf("newer delivery did not retire historical hard bounce: %+v", results[0])
	}
}

func TestDBEmailHealthExpiredHardBounceSuppressionRetainsRecoverableHistory(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	now := time.Now().UTC().Truncate(time.Second)
	const email = "expired-hard-bounce@example.com"
	healthDBExec(t, pool, tenantID, `
INSERT INTO subscriber_suppressions (
    tenant_id, email, reason, source, source_event_id, created_at, expires_at
) VALUES ($1::uuid, $2, 'hard_bounce', 'manual', 'expired-health-hard-stop', $3, $4)`,
		tenantID, email, now.Add(-2*time.Hour), now.Add(-time.Hour))

	service := &PostgresHealthService{
		Store: newStore(t, pool, nil), Now: func() time.Time { return now },
	}
	results, err := service.Resolve(context.Background(), tenantID, []string{email})
	if err != nil {
		t.Fatalf("Resolve D: %v", err)
	}
	if got := results[0]; got.Grade != HealthGradeD || got.HardStop || got.SendEligible {
		t.Fatalf("expired hard-bounce suppression = %+v, want recoverable D", got)
	}

	// A later provider validation is itself trusted chronology, not merely a
	// static A badge: it retires the older non-active bounce warning.
	healthDBExec(t, pool, tenantID, `
INSERT INTO verification_cache (
    tenant_id, email, status, provider, checked_at, expires_at
) VALUES ($1::uuid, $2, 'valid', 'kickbox', $3, $4)`, tenantID, email,
		now.Add(-30*time.Minute), now.Add(30*24*time.Hour))
	results, err = service.Resolve(context.Background(), tenantID, []string{email})
	if err != nil {
		t.Fatalf("Resolve A: %v", err)
	}
	if got := results[0]; got.Grade != HealthGradeA || got.HardStop || !got.SendEligible {
		t.Fatalf("newer provider validation did not retire expired suppression: %+v", got)
	}
}

func TestDBEmailHealthHiddenSecondaryWithSuppressionLastSourceStillFailsClosed(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	const primary = "hidden-secondary-primary@example.com"
	const secondary = "hidden-secondary@example.com"
	assertSQLState := func(label string, err error, want string) {
		t.Helper()
		var sqlState interface{ SQLState() string }
		if !errors.As(err, &sqlState) || sqlState.SQLState() != want {
			t.Fatalf("%s error=%v SQLSTATE, want %s", label, err, want)
		}
	}

	healthDBExec(t, pool, tenantID, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'unknown')`, tenantID, primary)
	healthDBExec(t, pool, tenantID, `
INSERT INTO subscriber_emails (
    tenant_id, subscriber_id, email, is_primary, consent_status
)
SELECT $1::uuid, subscriber.id, $3, false, 'unknown'
  FROM subscribers AS subscriber
 WHERE subscriber.tenant_id = $1::uuid
   AND lower(subscriber.email::text) = $2`, tenantID, primary, secondary)

	// Establish a real paired grant so this is not a forged positive fixture.
	// The proof then expires by time alone: no subscriber_emails mutation runs,
	// so the positive row remains stored but becomes invisible to postwave_app.
	proofAt := time.Now().UTC().Truncate(time.Microsecond)
	proofExpiresAt := proofAt.Add(5 * time.Second)
	healthDBExec(t, pool, tenantID, `
WITH target AS (
    SELECT subscriber.id AS subscriber_id, address.id AS address_id,
           lower(address.email::text) AS email
      FROM subscribers AS subscriber
      JOIN subscriber_emails AS address
        ON address.tenant_id = subscriber.tenant_id
       AND address.subscriber_id = subscriber.id
     WHERE subscriber.tenant_id = $1::uuid
       AND lower(address.email::text) = $2
), grant_event AS (
    INSERT INTO consent_events (
        tenant_id, subject_type, subject_id, subject_email, channel, category,
        action, source, policy_version, preferences, proof_text, created_at
    )
    SELECT $1::uuid, 'subscriber', target.address_id::text, target.email,
           'api', 'email_marketing', 'granted', 'direct_request',
           'health-hidden-secondary-v1',
           jsonb_build_object(
               'subscriber_id', target.subscriber_id::text,
               'address_id', target.address_id::text,
               'consent_status', 'subscribed',
               'legal_basis', 'consent',
               'jurisdiction', 'IN',
               'reason', 'hidden secondary health regression'
           ),
           'health-test:hidden-secondary-reviewed-grant', $3
      FROM target
    RETURNING id
)
INSERT INTO consent_records (
    tenant_id, subscriber_id, email, channel, consent_status, source,
    captured_at, expires_at, evidence
)
SELECT $1::uuid, target.subscriber_id, target.email, 'email', 'granted',
       'admin', $3, $4,
       jsonb_build_object(
           'event_id', grant_event.id::text,
           'address_id', target.address_id::text,
           'legal_basis', 'consent',
           'jurisdiction', 'IN',
           'reason', 'hidden secondary health regression',
           'policy_version', 'health-hidden-secondary-v1',
           'evidence', 'health-test:hidden-secondary-reviewed-grant'
       )
  FROM target CROSS JOIN grant_event`, tenantID, secondary, proofAt, proofExpiresAt)

	ctx := t.Context()
	visibleTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin pre-expiry visibility check: %v", err)
	}
	var beforeExpiry int
	if err := visibleTx.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid
   AND lower(email::text) = $2
   AND consent_status = 'subscribed'`, tenantID, secondary).Scan(&beforeExpiry); err != nil {
		_ = visibleTx.Rollback(ctx)
		t.Fatalf("read secondary before proof expiry: %v", err)
	}
	if err := visibleTx.Rollback(ctx); err != nil {
		t.Fatalf("rollback pre-expiry visibility check: %v", err)
	}
	if beforeExpiry != 1 {
		t.Fatalf("reviewed secondary visible before expiry=%d, want 1", beforeExpiry)
	}

	if delay := time.Until(proofExpiresAt.Add(300 * time.Millisecond)); delay > 0 {
		timer := time.NewTimer(delay)
		select {
		case <-timer.C:
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			t.Fatalf("wait for consent proof expiry: %v", ctx.Err())
		}
	}

	healthNow := time.Now().UTC().Truncate(time.Second)
	healthDBExec(t, pool, tenantID, `
INSERT INTO subscriber_suppressions (
    tenant_id, email, reason, source, source_event_id, created_at, expires_at
) VALUES (
    $1::uuid, $2, 'hard_bounce', 'manual',
    'hidden-secondary-expired-suppression', $3, $4
)`, tenantID, secondary, healthNow.Add(-2*time.Hour), healthNow.Add(-time.Hour))

	checkTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin hidden identity check: %v", err)
	}
	var visibleAfterExpiry int
	var sourceTable string
	var identityExists, missingExists bool
	if err := checkTx.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND lower(email::text) = $2`,
		tenantID, secondary).Scan(&visibleAfterExpiry); err != nil {
		_ = checkTx.Rollback(ctx)
		t.Fatalf("read secondary after proof expiry: %v", err)
	}
	if err := checkTx.QueryRow(ctx, `
SELECT last_source_table
  FROM subscriber_email_consent_address_state
 WHERE tenant_id = $1::uuid AND normalized_email = $2`,
		tenantID, secondary).Scan(&sourceTable); err != nil {
		_ = checkTx.Rollback(ctx)
		t.Fatalf("read secondary address state: %v", err)
	}
	if err := checkTx.QueryRow(ctx, `
SELECT public.verification_subscriber_email_identity_exists($1::uuid, $2)`,
		tenantID, secondary).Scan(&identityExists); err != nil {
		_ = checkTx.Rollback(ctx)
		t.Fatalf("resolve hidden secondary identity: %v", err)
	}
	if err := checkTx.QueryRow(ctx, `
SELECT public.verification_subscriber_email_identity_exists($1::uuid, $2)`,
		tenantID, "missing-hidden-secondary@example.com").Scan(&missingExists); err != nil {
		_ = checkTx.Rollback(ctx)
		t.Fatalf("resolve missing secondary identity: %v", err)
	}
	if err := checkTx.Rollback(ctx); err != nil {
		t.Fatalf("rollback hidden identity check: %v", err)
	}
	if visibleAfterExpiry != 0 || sourceTable != "subscriber_suppressions" ||
		!identityExists || missingExists {
		t.Fatalf("hidden identity boundary visible=%d source=%q exists=%v missing=%v",
			visibleAfterExpiry, sourceTable, identityExists, missingExists)
	}
	for _, invalid := range []string{
		"a", "ab", strings.Repeat("a", 321),
		" hidden-secondary@example.com", "Hidden-Secondary@example.com",
	} {
		invalidTx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("begin invalid identity check: %v", err)
		}
		scanErr := invalidTx.QueryRow(ctx, `
SELECT public.verification_subscriber_email_identity_exists($1::uuid, $2)`,
			tenantID, invalid).Scan(&identityExists)
		if scanErr == nil {
			_ = invalidTx.Rollback(ctx)
			t.Fatalf("identity predicate accepted noncanonical input of %d bytes", len(invalid))
		}
		assertSQLState("noncanonical identity", scanErr, "22023")
		_ = invalidTx.Rollback(ctx)
	}

	wrongScopeTx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin wrong-scope identity check: %v", err)
	}
	wrongScopeErr := wrongScopeTx.QueryRow(ctx, `
SELECT public.verification_subscriber_email_identity_exists(
    '00000000-0000-4000-8000-000000000001'::uuid, $1
)`, secondary).Scan(&identityExists)
	if wrongScopeErr == nil {
		_ = wrongScopeTx.Rollback(ctx)
		t.Fatal("identity predicate accepted a tenant argument outside app.tenant_id")
	}
	assertSQLState("wrong-scope identity", wrongScopeErr, "42501")
	_ = wrongScopeTx.Rollback(ctx)
	missingScopeErr := pool.QueryRow(ctx, `
SELECT public.verification_subscriber_email_identity_exists($1::uuid, $2)`,
		tenantID, secondary).Scan(&identityExists)
	if missingScopeErr == nil {
		t.Fatal("identity predicate ran without a transaction-bound tenant")
	}
	assertSQLState("missing-scope identity", missingScopeErr, "42501")

	service := &PostgresHealthService{
		Store: newStore(t, pool, nil), Now: func() time.Time { return healthNow },
	}
	results, err := service.Resolve(ctx, tenantID, []string{secondary})
	if err != nil {
		t.Fatalf("Resolve hidden secondary: %v", err)
	}
	if len(results) != 1 || results[0].Grade != HealthGradeF ||
		!results[0].HardStop || results[0].SendEligible ||
		results[0].Recommendation != HealthRecommendationBlocked {
		t.Fatalf("hidden secondary did not fail closed: %+v", results)
	}
	foundConsentStop := false
	for _, code := range results[0].ReasonCodes {
		if code == "consent_not_proven" {
			foundConsentStop = true
			break
		}
	}
	if !foundConsentStop {
		t.Fatalf("hidden secondary reason codes=%v, want consent_not_proven", results[0].ReasonCodes)
	}
}

func TestDBEmailHealthHistoricalUnsubscribeDefersToCurrentCanonicalConsent(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	now := time.Now().UTC().Truncate(time.Second)
	const email = "reconsented@example.com"

	// A new canonical identity begins fail-closed. The exact event+record pair
	// then moves the address to the reviewed subscribed state through the same
	// database projection used by production consent writers.
	healthDBExec(t, pool, tenantID, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'unknown')`, tenantID, email)
	healthDBExec(t, pool, tenantID, `
WITH target AS (
    SELECT subscriber.id AS subscriber_id, address.id AS address_id,
           lower(address.email::text) AS email
      FROM subscribers AS subscriber
      JOIN subscriber_emails AS address
        ON address.tenant_id = subscriber.tenant_id
       AND address.subscriber_id = subscriber.id
     WHERE subscriber.tenant_id = $1::uuid
       AND lower(address.email::text) = $2
), grant_event AS (
    INSERT INTO consent_events (
        tenant_id, subject_type, subject_id, subject_email, channel, category,
        action, source, policy_version, preferences, proof_text, created_at
    )
    SELECT $1::uuid, 'subscriber', target.address_id::text, target.email,
           'api', 'email_marketing', 'granted', 'direct_request', 'health-test-v1',
           jsonb_build_object(
               'subscriber_id', target.subscriber_id::text,
               'address_id', target.address_id::text,
               'consent_status', 'subscribed',
               'legal_basis', 'consent',
               'jurisdiction', 'IN',
               'reason', 'health chronology regression'
           ),
           'health-test:reviewed-reconsent', $3
      FROM target
    RETURNING id, subject_id
)
INSERT INTO consent_records (
    tenant_id, subscriber_id, email, channel, consent_status, source,
    captured_at, expires_at, evidence
)
SELECT $1::uuid, target.subscriber_id, target.email, 'email', 'granted',
       'admin', $3, $4,
       jsonb_build_object(
           'event_id', grant_event.id::text,
           'address_id', target.address_id::text,
           'legal_basis', 'consent',
           'jurisdiction', 'IN',
           'reason', 'health chronology regression',
           'policy_version', 'health-test-v1',
           'evidence', 'health-test:reviewed-reconsent'
       )
  FROM target CROSS JOIN grant_event`,
		tenantID, email, now.Add(-time.Hour), now.Add(24*time.Hour))
	healthDBExec(t, pool, tenantID, `
INSERT INTO subscriber_events (tenant_id, subscriber_email, event_type, at)
VALUES ($1::uuid, $2, 'unsubscribed', $3)`, tenantID, email, now.Add(-2*time.Hour))

	service := &PostgresHealthService{
		Store: newStore(t, pool, nil), Now: func() time.Time { return now },
	}
	results, err := service.Resolve(context.Background(), tenantID, []string{email})
	if err != nil {
		t.Fatalf("Resolve current subscribed: %v", err)
	}
	if len(results) != 1 || results[0].HardStop || results[0].Recommendation == HealthRecommendationBlocked {
		t.Fatalf("historical unsubscribe overrode current subscribed state: %+v", results)
	}
	for _, code := range results[0].ReasonCodes {
		if code == "consent_unsubscribed_event" {
			t.Fatalf("historical unsubscribe leaked into current authority: %+v", results[0])
		}
	}

	// A current canonical withdrawal remains authoritative even though the
	// historical activity ledger itself no longer manufactures a hard stop.
	healthDBExec(t, pool, tenantID, `
UPDATE subscriber_emails
   SET consent_status = 'unsubscribed', updated_at = $3
 WHERE tenant_id = $1::uuid AND lower(email::text) = $2`, tenantID, email, now)
	results, err = service.Resolve(context.Background(), tenantID, []string{email})
	if err != nil {
		t.Fatalf("Resolve current unsubscribed: %v", err)
	}
	if len(results) != 1 || !results[0].HardStop || results[0].Grade != HealthGradeF ||
		results[0].Recommendation != HealthRecommendationBlocked || results[0].SendEligible {
		t.Fatalf("current canonical unsubscribe was not enforced: %+v", results)
	}
}

func TestDBEmailHealthIsTenantIsolated(t *testing.T) {
	pool := verificationDB(t)
	tenantA := newTenant(t, pool)
	tenantB := newTenant(t, pool)
	now := time.Now().UTC().Truncate(time.Second)
	healthDBExec(t, pool, tenantA, `
INSERT INTO verification_cache (
    tenant_id, email, status, provider, checked_at, expires_at
) VALUES ($1::uuid, 'shared@example.com', 'invalid', 'zerobounce', $2, $3)`,
		tenantA, now, now.Add(30*24*time.Hour))

	service := &PostgresHealthService{
		Store: newStore(t, pool, nil), Now: func() time.Time { return now },
	}
	results, err := service.Resolve(context.Background(), tenantB, []string{"shared@example.com"})
	if err != nil {
		t.Fatalf("Resolve tenant B: %v", err)
	}
	if results[0].Grade != HealthGradeU {
		t.Fatalf("tenant B saw tenant A evidence: %+v", results[0])
	}

	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantB)
	if err != nil {
		t.Fatalf("begin tenant B snapshot read: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var count int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM email_health_snapshots
 WHERE tenant_id = $1::uuid AND email = 'shared@example.com'`, tenantA).Scan(&count); err != nil {
		t.Fatalf("cross-tenant snapshot read: %v", err)
	}
	if count != 0 {
		t.Fatalf("tenant B can read %d tenant A snapshot(s)", count)
	}
}

func TestDBEmailHealthDisabledSubscriberIsAConsentHardStop(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	now := time.Now().UTC().Truncate(time.Second)
	healthDBExec(t, pool, tenantID, `
INSERT INTO subscribers (
    tenant_id, email, status, consent_source
) VALUES ($1::uuid, 'disabled@example.com', 'disabled', 'unknown')`, tenantID)
	healthDBExec(t, pool, tenantID, `
INSERT INTO verification_cache (
    tenant_id, email, status, provider, checked_at, expires_at
) VALUES ($1::uuid, 'disabled@example.com', 'valid', 'kickbox', $2, $3)`,
		tenantID, now, now.Add(30*24*time.Hour))

	service := &PostgresHealthService{
		Store: newStore(t, pool, nil), Now: func() time.Time { return now },
	}
	results, err := service.Resolve(context.Background(), tenantID, []string{"disabled@example.com"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	got := results[0]
	if got.Grade != HealthGradeF || !got.HardStop || got.SendEligible ||
		got.Recommendation != HealthRecommendationBlocked {
		t.Fatalf("disabled subscriber was not blocked: %+v", got)
	}
}

func TestDBEmailHealthTerminalVerificationSurvivesCachePurge(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	now := time.Now().UTC().Truncate(time.Second)
	healthDBExec(t, pool, tenantID, `
INSERT INTO verification_cache (
    tenant_id, email, status, sub_status, provider, checked_at, expires_at
) VALUES ($1::uuid, 'trap@example.com', 'spamtrap', 'possible_trap',
          'zerobounce', $2, $3)`, tenantID, now.Add(-48*time.Hour), now.Add(-time.Hour))

	service := &PostgresHealthService{
		Store: newStore(t, pool, nil), Now: func() time.Time { return now },
	}
	results, err := service.Resolve(context.Background(), tenantID, []string{"trap@example.com"})
	if err != nil {
		t.Fatalf("Resolve before purge: %v", err)
	}
	if len(results) != 1 || results[0].Grade != HealthGradeF || results[0].SendEligible {
		t.Fatalf("terminal result before purge = %+v, want non-sendable F", results)
	}

	healthDBExec(t, pool, tenantID, `
DELETE FROM verification_cache
 WHERE tenant_id = $1::uuid AND email = 'trap@example.com'`, tenantID)
	results, err = service.Resolve(context.Background(), tenantID, []string{"trap@example.com"})
	if err != nil {
		t.Fatalf("Resolve after purge: %v", err)
	}
	if len(results) != 1 || results[0].Status != StatusSpamtrap ||
		results[0].Grade != HealthGradeF || results[0].SendEligible {
		t.Fatalf("terminal snapshot fallback = %+v, want persisted non-sendable spamtrap F", results)
	}
}

func TestDBEmailHealthAmbiguousCacheCannotRetireTerminalSnapshot(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	now := time.Now().UTC().Truncate(time.Second)
	terminalAt := now.Add(-2 * time.Hour)
	for _, email := range []string{"unknown-over-invalid@example.com", "catchall-over-spamtrap@example.com"} {
		status := "invalid"
		if email == "catchall-over-spamtrap@example.com" {
			status = "spamtrap"
		}
		healthDBExec(t, pool, tenantID, `
INSERT INTO email_health_snapshots (
    tenant_id, email, grade, recommendation, hard_stop, reason_codes,
    evidence, verification_status, verification_provider,
    verification_checked_at, model_version, computed_at
) VALUES ($1::uuid, $2, 'F', 'blocked', false,
          ARRAY['terminal_snapshot'], '[]'::jsonb, $3,
          'zerobounce', $4, $5, $4)`, tenantID, email, status, terminalAt, HealthModelVersion)
	}
	healthDBExec(t, pool, tenantID, `
INSERT INTO verification_cache (
    tenant_id, email, status, provider, checked_at, expires_at
) VALUES
    ($1::uuid, 'unknown-over-invalid@example.com', 'unknown', 'local', $2, $3),
    ($1::uuid, 'catchall-over-spamtrap@example.com', 'catch_all', 'kickbox', $2, $3)`,
		tenantID, now.Add(-time.Hour), now.Add(29*24*time.Hour))

	service := &PostgresHealthService{
		Store: newStore(t, pool, nil), Now: func() time.Time { return now },
	}
	results, err := service.Resolve(context.Background(), tenantID, []string{
		"unknown-over-invalid@example.com", "catchall-over-spamtrap@example.com",
	})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if results[0].Grade != HealthGradeF || results[0].Status != StatusInvalid {
		t.Fatalf("unknown cache retired invalid snapshot: %+v", results[0])
	}
	if results[1].Grade != HealthGradeF || results[1].Status != StatusSpamtrap {
		t.Fatalf("catch-all cache retired spamtrap snapshot: %+v", results[1])
	}
}

func TestDBEmailHealthExpiredTerminalSnapshotCannotRefreshItsOwnRetention(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	now := time.Now().UTC().Truncate(time.Second)
	ancient := now.Add(-VerificationEvidenceRetention - 24*time.Hour)
	healthDBExec(t, pool, tenantID, `
INSERT INTO email_health_snapshots (
    tenant_id, email, grade, recommendation, hard_stop, reason_codes,
    evidence, verification_status, verification_provider,
    verification_checked_at, model_version, computed_at
) VALUES ($1::uuid, 'ancient-trap@example.com', 'F', 'blocked', false,
          ARRAY['verification_spamtrap'], '[]'::jsonb, 'spamtrap',
          'zerobounce', $2, $3, $2)`, tenantID, ancient, HealthModelVersion)

	service := &PostgresHealthService{
		Store: newStore(t, pool, nil), Now: func() time.Time { return now },
	}
	results, err := service.Resolve(context.Background(), tenantID, []string{"ancient-trap@example.com"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(results) != 1 || results[0].Grade != HealthGradeU || results[0].Status != "" {
		t.Fatalf("expired snapshot reintroduced terminal evidence: %+v", results)
	}

	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("begin snapshot assertion: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var status string
	var computedAt time.Time
	if err := tx.QueryRow(context.Background(), `
SELECT verification_status, computed_at FROM email_health_snapshots
	 WHERE tenant_id=$1::uuid AND email='ancient-trap@example.com'`, tenantID).Scan(&status, &computedAt); err != nil {
		t.Fatalf("read retained ancient snapshot: %v", err)
	}
	if status != string(StatusSpamtrap) || !computedAt.Equal(ancient) {
		t.Fatalf("ancient snapshot was rewritten: status=%q computed_at=%s", status, computedAt)
	}
}

func TestDBEmailHealthExpiredTerminalCacheCannotRefreshDerivedRetention(t *testing.T) {
	pool := verificationDB(t)
	tenantID := newTenant(t, pool)
	now := time.Now().UTC().Truncate(time.Second)
	ancient := now.Add(-VerificationEvidenceRetention - 24*time.Hour)
	healthDBExec(t, pool, tenantID, `
INSERT INTO verification_cache (
    tenant_id, email, status, sub_status, provider, checked_at, expires_at
) VALUES ($1::uuid, 'ancient-cache-trap@example.com', 'spamtrap',
          'possible_trap', 'zerobounce', $2, $3)`, tenantID, ancient, ancient.Add(time.Hour))

	service := &PostgresHealthService{
		Store: newStore(t, pool, nil), Now: func() time.Time { return now },
	}
	results, err := service.Resolve(context.Background(), tenantID, []string{"ancient-cache-trap@example.com"})
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(results) != 1 || results[0].Grade != HealthGradeU || results[0].Status != "" {
		t.Fatalf("expired cache reintroduced terminal evidence: %+v", results)
	}

	tx, err := db.WithTenant(context.Background(), pool, tenantID)
	if err != nil {
		t.Fatalf("begin snapshot assertion: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var snapshots int
	if err := tx.QueryRow(context.Background(), `
SELECT count(*) FROM email_health_snapshots
	 WHERE tenant_id=$1::uuid AND email='ancient-cache-trap@example.com'`, tenantID).Scan(&snapshots); err != nil {
		t.Fatalf("count derived snapshots: %v", err)
	}
	if snapshots != 0 {
		t.Fatalf("expired cache created %d derived snapshot(s)", snapshots)
	}
}
