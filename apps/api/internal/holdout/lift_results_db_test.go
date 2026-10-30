// SPDX-License-Identifier: AGPL-3.0-only

package holdout

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type liftFixtureRecipient struct {
	ID    string
	Email string
}

type liftFixture struct {
	TenantID      string
	CampaignID    string
	Metric        string
	WindowStart   time.Time
	WindowEnd     time.Time
	MinimumEffect float64
	AssignmentSHA string
	Treatment     []liftFixtureRecipient
	Control       []liftFixtureRecipient
}

func TestFinalizedLiftCountsSuppressedControlsAndReplaysIdentically_DB(t *testing.T) {
	pool := holdoutDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	now := normalizeLiftTime(time.Now().UTC())
	fixture := seedFrozenLiftFixture(t, pool, ctx, 20, 20,
		now.Add(-8*24*time.Hour), 7, "purchase", 0.10)
	seedPoweredLiftConversions(t, pool, ctx, fixture)

	store := NewLiftResultStore(pool)
	store.now = func() time.Time { return now }
	result, err := store.CloseConfiguredWindow(ctx, fixture.TenantID, fixture.CampaignID)
	if err != nil {
		t.Fatalf("close configured lift window: %v", err)
	}
	if !result.Powered() {
		t.Fatalf("decisive result was suppressed: %+v", result)
	}
	if result.NTreatment != 20 || result.NControl != 20 ||
		result.ConversionsTreatment != 20 || result.ConversionsControl != 1 {
		t.Fatalf("fixed populations/conversions = treatment %d/%d control %d/%d, want 20/20 and 1/20",
			result.ConversionsTreatment, result.NTreatment,
			result.ConversionsControl, result.NControl)
	}
	if result.AbsoluteLift == nil || result.IncrementalConversions == nil ||
		result.CILow == nil || result.CIHigh == nil {
		t.Fatalf("powered result lacks estimates: %+v", result)
	}
	if !validLiftSHA256(result.ConversionSetSHA256) ||
		!validLiftSHA256(result.EvidenceSHA256) {
		t.Fatalf("invalid durable evidence hashes: %+v", result)
	}

	// The control conversion above has no campaign_id and its recipient has no
	// campaign_recipients row. It still counts because incrementality measures
	// outcomes in the assigned control population, not attributed sends.
	assertSuppressedControlWasCounted(t, pool, ctx, fixture, result)

	// Add an in-window conversion after finalization. A replay must return the
	// published evidence identity rather than recomputing a different history.
	seedLiftEmailConversion(t, pool, ctx, fixture.TenantID,
		fixture.Control[1].Email, fixture.Metric, fixture.WindowStart.Add(2*time.Hour))
	replayed, err := store.CloseConfiguredWindow(ctx, fixture.TenantID, fixture.CampaignID)
	if err != nil {
		t.Fatalf("replay finalized result: %v", err)
	}
	if replayed.ID != result.ID || replayed.EvidenceSHA256 != result.EvidenceSHA256 ||
		replayed.ConversionSetSHA256 != result.ConversionSetSHA256 ||
		replayed.ConversionsControl != result.ConversionsControl ||
		!replayed.GeneratedAt.Equal(result.GeneratedAt) {
		t.Fatalf("replay changed immutable result: first=%+v replay=%+v", result, replayed)
	}

	read, err := store.PoweredResultFor(ctx, PoweredLiftQuery{
		TenantID: fixture.TenantID, CampaignID: fixture.CampaignID,
		Since: fixture.WindowStart.Add(-time.Minute),
		Until: fixture.WindowEnd.Add(time.Minute),
	})
	if err != nil || read == nil || read.ID != result.ID {
		t.Fatalf("powered contained reader = %+v, err=%v", read, err)
	}
	notContained, err := store.PoweredResultFor(ctx, PoweredLiftQuery{
		TenantID: fixture.TenantID, CampaignID: fixture.CampaignID,
		Since: fixture.WindowStart, Until: fixture.WindowEnd.Add(-time.Microsecond),
	})
	if err != nil || notContained != nil {
		t.Fatalf("reader surfaced result outside fixed window: %+v, err=%v", notContained, err)
	}
}

func TestUnderpoweredResultPersistsWithoutLiftAndPoweredReaderSuppressesIt_DB(t *testing.T) {
	pool := holdoutDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	now := normalizeLiftTime(time.Now().UTC())
	fixture := seedFrozenLiftFixture(t, pool, ctx, 2, 2,
		now.Add(-8*24*time.Hour), 7, "purchase", 0.10)
	seedLiftEmailConversion(t, pool, ctx, fixture.TenantID,
		fixture.Treatment[0].Email, fixture.Metric, fixture.WindowStart.Add(time.Hour))

	store := NewLiftResultStore(pool)
	store.now = func() time.Time { return now }
	result, err := store.CloseConfiguredWindow(ctx, fixture.TenantID, fixture.CampaignID)
	if err != nil {
		t.Fatalf("close underpowered window: %v", err)
	}
	if result.Powered() || result.AbsoluteLift != nil || result.RelativeLift != nil ||
		result.IncrementalConversions != nil || result.CILow != nil || result.CIHigh != nil {
		t.Fatalf("underpowered result leaked a lift estimate: %+v", result)
	}
	if result.UnderpoweredReason == "" {
		t.Fatal("underpowered result has no durable explanation")
	}
	read, err := store.PoweredResultFor(ctx, PoweredLiftQuery{
		TenantID: fixture.TenantID, CampaignID: fixture.CampaignID,
		Since: fixture.WindowStart.Add(-time.Minute),
		Until: fixture.WindowEnd.Add(time.Minute),
	})
	if err != nil || read != nil {
		t.Fatalf("powered reader surfaced underpowered evidence: %+v, err=%v", read, err)
	}

	tx, err := db.WithTenant(ctx, pool, fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var status string
	var absolute, relative, incremental, ciLow, ciHigh *float64
	if err := tx.QueryRow(ctx, `
SELECT status, absolute_lift, relative_lift, incremental_conversions,
       ci_low, ci_high
  FROM campaign_holdout_lift_results
 WHERE tenant_id=$1::uuid AND campaign_id=$2::uuid`,
		fixture.TenantID, fixture.CampaignID).Scan(
		&status, &absolute, &relative, &incremental, &ciLow, &ciHigh,
	); err != nil {
		t.Fatal(err)
	}
	if status != "underpowered" || absolute != nil || relative != nil ||
		incremental != nil || ciLow != nil || ciHigh != nil {
		t.Fatalf("persisted underpowered shape is unsafe: %s %v %v %v %v %v",
			status, absolute, relative, incremental, ciLow, ciHigh)
	}
}

func TestLiftFinalizationEnforcesClosedWindowAndTenantRLS_DB(t *testing.T) {
	pool := holdoutDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	now := normalizeLiftTime(time.Now().UTC())
	fixture := seedFrozenLiftFixture(t, pool, ctx, 1, 1,
		now.Add(-time.Hour), 1, "any_conversion", 0.10)
	store := NewLiftResultStore(pool)
	store.now = func() time.Time { return now }
	if _, err := store.CloseConfiguredWindow(ctx, fixture.TenantID, fixture.CampaignID); !errors.Is(err, ErrLiftWindowOpen) {
		t.Fatalf("open window finalization error = %v, want ErrLiftWindowOpen", err)
	}

	// The database remains the final clock authority even if a caller bypasses
	// the service and sets the scoped writer GUC directly.
	tx, err := db.WithTenant(ctx, pool, fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.holdout_result_writer', 'true', true)`); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `
INSERT INTO campaign_holdout_lift_results (
    tenant_id, campaign_id, result_version, methodology_version, metric,
    window_start, window_end, n_treatment, n_control,
    conversions_treatment, conversions_control, rate_treatment, rate_control,
    status, p_value, minimum_detectable_effect, minimum_relative_effect,
    underpowered_reason, assignment_set_sha256, conversion_set_sha256,
    evidence_sha256, methodology_statement
) VALUES (
    $1::uuid, $2::uuid, $3, $4, $5, $6, $7, 1, 1, 0, 0, 0, 0,
    'underpowered', 1, 0, $8, 'window is open', $9, $10, $11, $12
)`, fixture.TenantID, fixture.CampaignID, LiftResultVersion,
		LiftMethodologyVersion, fixture.Metric, fixture.WindowStart,
		fixture.WindowEnd, fixture.MinimumEffect, fixture.AssignmentSHA,
		strings.Repeat("c", 64), strings.Repeat("d", 64), LiftMethodologyStatement)
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) || pgErr.Code != "22007" {
		_ = tx.Rollback(ctx)
		t.Fatalf("direct open-window insert error = %v, want SQLSTATE 22007", err)
	}
	_ = tx.Rollback(ctx)

	otherTenant := createHoldoutTenant(t, pool, ctx)
	readTx, err := db.WithTenant(ctx, pool, otherTenant)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = readTx.Rollback(ctx) }()
	var visible int
	if err := readTx.QueryRow(ctx, `
SELECT count(*) FROM campaign_holdout_assignments
 WHERE campaign_id=$1::uuid`, fixture.CampaignID).Scan(&visible); err != nil {
		t.Fatal(err)
	}
	if visible != 0 {
		t.Fatalf("foreign tenant saw %d assignment evidence rows", visible)
	}

	foreign, err := store.PoweredResultFor(ctx, PoweredLiftQuery{
		TenantID: otherTenant, CampaignID: fixture.CampaignID,
		Since: fixture.WindowStart.Add(-time.Minute),
		Until: fixture.WindowEnd.Add(time.Minute),
	})
	if err != nil || foreign != nil {
		t.Fatalf("foreign tenant powered reader = %+v, err=%v", foreign, err)
	}
}

func seedFrozenLiftFixture(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	nTreatment, nControl int,
	windowStart time.Time,
	windowDays int,
	metric string,
	minimumEffect float64,
) liftFixture {
	t.Helper()
	windowStart = normalizeLiftTime(windowStart)
	fixture := liftFixture{
		TenantID: createHoldoutTenant(t, pool, ctx),
		Metric:   metric, WindowStart: windowStart,
		WindowEnd:     normalizeLiftTime(windowStart.Add(time.Duration(windowDays) * 24 * time.Hour)),
		MinimumEffect: minimumEffect,
		Treatment:     make([]liftFixtureRecipient, 0, nTreatment),
		Control:       make([]liftFixtureRecipient, 0, nControl),
	}
	fixture.CampaignID = createHoldoutCampaign(t, pool, ctx, fixture.TenantID)
	seed := "lift-result-" + randHex(t)
	seedDigest := sha256.Sum256([]byte(seed))
	seedSHA := hex.EncodeToString(seedDigest[:])

	tx, err := db.WithTenant(ctx, pool, fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO campaign_holdouts (
    campaign_id, tenant_id, percent, seed, outcome_metric,
    conversion_window_days, minimum_relative_effect
) VALUES ($1::uuid, $2::uuid, 50, $3, $4, $5, $6)`,
		fixture.CampaignID, fixture.TenantID, seed, metric, windowDays,
		minimumEffect); err != nil {
		t.Fatalf("insert configured holdout: %v", err)
	}
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.holdout_assignment_writer', 'true', true)`); err != nil {
		t.Fatal(err)
	}

	insertRecipient := func(index int, arm string, bucket int) liftFixtureRecipient {
		recipient := liftFixtureRecipient{
			ID:    uuid.NewString(),
			Email: fmt.Sprintf("lift-%s-%03d-%s@example.test", randHex(t), index, arm),
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO subscribers (id, tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2::uuid, $3, 'enabled', 'api')`,
			recipient.ID, fixture.TenantID, recipient.Email); err != nil {
			t.Fatalf("insert %s subscriber: %v", arm, err)
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO campaign_holdout_assignments (
    tenant_id, campaign_id, recipient_id, arm, bucket, assignment_reason,
    holdout_percent, seed_sha256, exposure_window_start,
    prior_assignments_90d, prior_control_90d, assignment_version, assigned_at
) VALUES (
    $1::uuid, $2::uuid, $3::uuid, $4, $5, 'deterministic',
    50, $6, $7, 0, 0, $8, $9
)`, fixture.TenantID, fixture.CampaignID, recipient.ID, arm, bucket,
			seedSHA, windowStart.Add(-90*24*time.Hour), AssignmentVersion,
			windowStart); err != nil {
			t.Fatalf("insert %s assignment: %v", arm, err)
		}
		return recipient
	}
	for i := 0; i < nTreatment; i++ {
		fixture.Treatment = append(fixture.Treatment, insertRecipient(i, "treatment", 99))
	}
	for i := 0; i < nControl; i++ {
		fixture.Control = append(fixture.Control, insertRecipient(i, "control", 0))
	}
	if err := tx.QueryRow(ctx, `
SELECT campaign_holdout_assignment_set_sha256($1::uuid, $2::uuid)`,
		fixture.TenantID, fixture.CampaignID).Scan(&fixture.AssignmentSHA); err != nil {
		t.Fatalf("hash assignment fixture: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE campaign_holdouts
   SET decided_at=$3, held_out_count=$4, sent_count=$5,
       assignment_ledger_version=$6, assignment_ledger_sha256=$7,
       updated_at=$3
 WHERE tenant_id=$1::uuid AND campaign_id=$2::uuid`,
		fixture.TenantID, fixture.CampaignID, fixture.WindowStart,
		nControl, nTreatment, AssignmentVersion, fixture.AssignmentSHA); err != nil {
		t.Fatalf("freeze assignment fixture: %v", err)
	}
	for _, recipient := range fixture.Treatment {
		if _, err := tx.Exec(ctx, `
INSERT INTO campaign_recipients (
    campaign_id, tenant_id, subscriber_email, status, sent_at
) VALUES ($1::uuid, $2::uuid, $3, 'sent', $4)`,
			fixture.CampaignID, fixture.TenantID, recipient.Email,
			fixture.WindowStart.Add(time.Minute)); err != nil {
			t.Fatalf("insert treatment send ledger: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit frozen lift fixture: %v", err)
	}
	return fixture
}

func seedPoweredLiftConversions(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	fixture liftFixture,
) {
	t.Helper()
	seedLiftEmailConversion(t, pool, ctx, fixture.TenantID,
		fixture.Control[0].Email, fixture.Metric, fixture.WindowStart.Add(time.Hour))
	tx, err := db.WithTenant(ctx, pool, fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for index, recipient := range fixture.Treatment {
		externalID := fmt.Sprintf("lift-external-%s-%d", fixture.CampaignID, index)
		var conversionID int64
		if err := tx.QueryRow(ctx, `
INSERT INTO conversions (
    tenant_id, event_name, external_id, occurred_at, attributed_via
) VALUES ($1::uuid, $2, $3, $4, 'none')
RETURNING id`, fixture.TenantID, fixture.Metric, externalID,
			fixture.WindowStart.Add(time.Duration(index+1)*time.Minute)).Scan(&conversionID); err != nil {
			t.Fatalf("insert identity conversion: %v", err)
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO conversion_attribution_touches (
    tenant_id, conversion_id, touch_kind, identity_kind, identity_value,
    resolution_rank, subscriber_id, is_winner
) VALUES ($1::uuid, $2, 'identity', 'external_id', $3, 3, $4::uuid, true)`,
			fixture.TenantID, conversionID, externalID, recipient.ID); err != nil {
			t.Fatalf("insert winning identity touch: %v", err)
		}
	}
	// A second conversion by one treatment recipient proves that counts are
	// unique recipients while the conversion-set hash still covers every input.
	var duplicateConversion int64
	if err := tx.QueryRow(ctx, `
INSERT INTO conversions (tenant_id, event_name, external_id, occurred_at, attributed_via)
VALUES ($1::uuid, $2, 'duplicate-touch-evidence', $3, 'none') RETURNING id`,
		fixture.TenantID, fixture.Metric,
		fixture.WindowStart.Add(2*time.Hour)).Scan(&duplicateConversion); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO conversion_attribution_touches (
    tenant_id, conversion_id, touch_kind, identity_kind, identity_value,
    resolution_rank, subscriber_id, is_winner
) VALUES ($1::uuid, $2, 'identity', 'external_id', 'duplicate-touch-evidence',
          3, $3::uuid, true)`, fixture.TenantID, duplicateConversion,
		fixture.Treatment[0].ID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func seedLiftEmailConversion(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID, email, metric string,
	occurredAt time.Time,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO conversions (
    tenant_id, subscriber_email, event_name, occurred_at, attributed_via
) VALUES ($1::uuid, $2, $3, $4, 'none')`,
		tenantID, email, metric, occurredAt); err != nil {
		t.Fatalf("insert email conversion: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

func assertSuppressedControlWasCounted(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	fixture liftFixture,
	result *LiftResult,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, fixture.TenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var sends, unattributedConversions int64
	if err := tx.QueryRow(ctx, `
SELECT (SELECT count(*) FROM campaign_recipients
         WHERE tenant_id=$1::uuid AND campaign_id=$2::uuid
           AND subscriber_email=$3),
       (SELECT count(*) FROM conversions
         WHERE tenant_id=$1::uuid AND subscriber_email=$3
           AND campaign_id IS NULL AND occurred_at >= $4 AND occurred_at < $5)`,
		fixture.TenantID, fixture.CampaignID, fixture.Control[0].Email,
		fixture.WindowStart, fixture.WindowEnd).Scan(&sends, &unattributedConversions); err != nil {
		t.Fatal(err)
	}
	if sends != 0 || unattributedConversions != 1 || result.ConversionsControl != 1 {
		t.Fatalf("suppressed control evidence sends=%d unattributed_conversions=%d counted=%d",
			sends, unattributedConversions, result.ConversionsControl)
	}
}
