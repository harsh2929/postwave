// SPDX-License-Identifier: AGPL-3.0-only

package coderedemption

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

func codesDB(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping code redemption test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

type fixture struct {
	TenantID     string
	CampaignID   string
	SubscriberID string
	Email        string
	Code         string
}

// seedAssignedCode creates a campaign that issued one per-recipient code, and
// deliberately records NO click event for that subscriber.
func seedAssignedCode(t *testing.T, pool *db.Pool, expiresAt *time.Time) fixture {
	t.Helper()
	ctx := context.Background()
	f := fixture{
		TenantID: uuid.NewString(),
		Email:    "reader-" + uuid.NewString()[:8] + "@example.test",
		Code:     "SPRING-" + uuid.NewString()[:8],
	}
	tx, err := db.WithTenant(ctx, pool, f.TenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'code-attr-test', $2, 'studio')`,
		f.TenantID, "codeattr-"+f.TenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO campaigns (tenant_id, name, subject, campaign_type, status)
VALUES ($1::uuid, 'Spring sale', 'Spring sale', 'regular', 'sent')
RETURNING id::text`, f.TenantID).Scan(&f.CampaignID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed campaign: %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'enabled', 'api') RETURNING id::text`,
		f.TenantID, f.Email).Scan(&f.SubscriberID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	var discountID string
	if err := tx.QueryRow(ctx, `
INSERT INTO discounts (tenant_id, code, applies_to, percent_off)
VALUES ($1::uuid, 'SPRINGBASE'||substr($2,1,6), 'first_payment', 20)
RETURNING id::text`, f.TenantID, uuid.NewString()).Scan(&discountID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed discount: %v", err)
	}
	var poolID string
	if err := tx.QueryRow(ctx, `
INSERT INTO coupon_pools (tenant_id, discount_id, name, provider, code_type, status, campaign_id)
VALUES ($1::uuid, $2::uuid, 'spring pool', 'postwave', 'generated', 'active', $3::uuid)
RETURNING id::text`, f.TenantID, discountID, f.CampaignID).Scan(&poolID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed pool: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO coupon_assignments
    (tenant_id, pool_id, static_code, subscriber_id, subscriber_email, status,
     assigned_at, expires_at, campaign_id, render_key)
VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, 'assigned', now(), $6, $7::uuid, $8)`,
		f.TenantID, poolID, f.Code, f.SubscriberID, f.Email, expiresAt,
		f.CampaignID, "render-"+uuid.NewString()[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed assignment: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		admin, err := db.WithTenant(context.Background(), pool, f.TenantID)
		if err != nil {
			return
		}
		_, _ = admin.Exec(context.Background(), `DELETE FROM tenants WHERE id=$1::uuid`, f.TenantID)
		_ = admin.Commit(context.Background())
	})
	return f
}

// THE acceptance criterion: a redemption with NO preceding click attributes to
// the campaign.
//
// This is the population the PRD says grows under AI mediation — people who read
// the message and go to the site directly. Last-touch never sees them, so before
// this the campaign that caused the purchase received no credit and the revenue
// was real but unattributable.
func TestARedemptionWithNoClickStillAttributesToTheCampaign(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	f := seedAssignedCode(t, pool, nil)

	// Assert the premise: this subscriber has clicked nothing.
	read, err := db.WithTenant(ctx, pool, f.TenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	var clicks int
	if err := read.QueryRow(ctx, `
SELECT count(*) FROM subscriber_events
 WHERE tenant_id = $1::uuid AND event_type = 'clicked'`, f.TenantID).Scan(&clicks); err != nil {
		t.Fatalf("count clicks: %v", err)
	}
	_ = read.Rollback(ctx)
	if clicks != 0 {
		t.Fatalf("fixture has %d clicks; the test would not prove the criterion", clicks)
	}

	amount := int64(4900)
	result, err := (&Repo{Pool: pool}).Record(ctx, f.TenantID, Redemption{
		Code: f.Code, AmountCents: &amount, Currency: "usd", Source: "commerce_webhook",
	})
	if err != nil {
		t.Fatalf("Record: %v", err)
	}

	if result.CampaignID != f.CampaignID {
		t.Fatalf("campaign = %q, want %q — the redemption did not attribute to the "+
			"campaign that issued the code", result.CampaignID, f.CampaignID)
	}
	if !result.LinkedWithoutRecordedAssignmentClick {
		t.Error("LinkedWithoutRecordedAssignmentClick is false although the assignment had no clicks")
	}
	if result.AttributionScope != AttributionScopeCampaignAssignment {
		t.Fatalf("attribution scope = %q, want %q", result.AttributionScope, AttributionScopeCampaignAssignment)
	}
	if result.ConversionID == 0 {
		t.Fatal("no conversion was written, so the revenue is attributed nowhere a " +
			"report can read")
	}
	// And the conversion says HOW it was attributed. `explicit` would claim a
	// caller asserted the campaign; this evidence is stronger and different.
	verify, err := db.WithTenant(ctx, pool, f.TenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var storedNoClick *bool
	if err := verify.QueryRow(ctx, `
SELECT linked_without_recorded_assignment_click
  FROM discount_redemptions
 WHERE tenant_id = $1::uuid AND assignment_id = $2::uuid`,
		f.TenantID, result.AssignmentID).Scan(&storedNoClick); err != nil {
		t.Fatalf("read stored no-click evidence: %v", err)
	}
	if storedNoClick == nil || !*storedNoClick {
		t.Fatalf("stored no-click evidence = %v, want true", storedNoClick)
	}
	var via, campaign string
	var cents int64
	if err := verify.QueryRow(ctx, `
SELECT attributed_via, campaign_id::text, amount_cents
  FROM conversions WHERE id = $1`, result.ConversionID).Scan(&via, &campaign, &cents); err != nil {
		t.Fatalf("read conversion: %v", err)
	}
	if via != AttributedViaCodeRedemption {
		t.Errorf("attributed_via = %q, want %q", via, AttributedViaCodeRedemption)
	}
	if campaign != f.CampaignID || cents != amount {
		t.Errorf("conversion = campaign %q / %d cents, want %q / %d",
			campaign, cents, f.CampaignID, amount)
	}
}

func TestCampaignEvidenceRegisterIsIdentityMinimizedAndAuthoritative(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	f := seedAssignedCode(t, pool, nil)
	amount := int64(4900)
	result, err := (&Repo{Pool: pool}).Record(ctx, f.TenantID, Redemption{
		Code: f.Code, AmountCents: &amount, Currency: "USD",
	})
	if err != nil {
		t.Fatalf("Record: %v", err)
	}

	page, err := (&Repo{Pool: pool}).ListCampaignEvidence(ctx, f.TenantID, f.CampaignID,
		CampaignEvidenceInput{Limit: 1})
	if err != nil {
		t.Fatalf("ListCampaignEvidence: %v", err)
	}
	if page.CampaignID != f.CampaignID || len(page.Items) != 1 {
		t.Fatalf("page = %+v", page)
	}
	if page.Summary.CodeAllocations != 1 || page.Summary.CodeRedemptions != 1 ||
		page.Summary.CodeLinkedOutcomes != 1 ||
		page.Summary.NoClickRedemptions != 1 || page.Summary.ClickEvidenceUnavailable != 0 {
		t.Fatalf("summary = %+v", page.Summary)
	}
	item := page.Items[0]
	if item.Kind != "code_allocation" || item.EvidenceID != result.AssignmentID ||
		item.ConversionID == nil || *item.ConversionID != result.ConversionID ||
		item.LinkedWithoutRecordedAssignmentClick == nil || !*item.LinkedWithoutRecordedAssignmentClick ||
		item.ReadershipProven || item.AttributionScope != AttributionScopeCampaignAssignment ||
		item.Currency != "USD" {
		t.Fatalf("item = %+v", item)
	}
	// The public type has no field capable of carrying these identities. JSON is
	// checked too so a future custom serializer cannot quietly add one.
	encoded, err := json.Marshal(page)
	if err != nil {
		t.Fatalf("marshal page: %v", err)
	}
	for _, forbidden := range []string{f.Email, f.Code, f.SubscriberID, f.TenantID,
		`"subscriber_id"`, `"subscriber_email"`, `"code"`, `"tenant_id"`,
		`"code_revenue_cents"`, `"vanity_revenue_cents"`} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("evidence register leaked %q: %s", forbidden, encoded)
		}
	}

	// Legacy direct writes were not protected by the HTTP currency validator.
	// An invalid historical unit becomes explicitly unavailable, never a made-up
	// currency and never part of a cross-currency summary.
	legacy := seedAssignedCode(t, pool, nil)
	legacyAmount := int64(1200)
	if _, err := (&Repo{Pool: pool}).Record(ctx, legacy.TenantID, Redemption{
		Code: legacy.Code, AmountCents: &legacyAmount, Currency: "not-a-currency",
	}); err != nil {
		t.Fatalf("record legacy-currency evidence: %v", err)
	}
	legacyPage, err := (&Repo{Pool: pool}).ListCampaignEvidence(
		ctx, legacy.TenantID, legacy.CampaignID, CampaignEvidenceInput{Limit: 1},
	)
	if err != nil {
		t.Fatalf("list legacy-currency evidence: %v", err)
	}
	if len(legacyPage.Items) != 1 || legacyPage.Items[0].Currency != "" {
		t.Fatalf("legacy invalid currency was not unavailable: %+v", legacyPage.Items)
	}
}

func TestMissingOrTenantForeignCampaignIsNotReportedAsZeroEvidence(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	mine := seedAssignedCode(t, pool, nil)
	theirs := seedAssignedCode(t, pool, nil)
	repo := &Repo{Pool: pool}

	for name, campaignID := range map[string]string{
		"missing":        uuid.NewString(),
		"tenant foreign": theirs.CampaignID,
	} {
		t.Run(name, func(t *testing.T) {
			page, err := repo.ListCampaignEvidence(
				ctx, mine.TenantID, campaignID, CampaignEvidenceInput{Limit: 25},
			)
			if page != nil || !errors.Is(err, ErrEvidenceNotFound) {
				t.Fatalf("page=%+v err=%v, want nil ErrEvidenceNotFound", page, err)
			}
		})
	}
}

// A single-use code cannot be redeemed twice.
func TestASingleUseCodeCannotBeRedeemedTwice(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	f := seedAssignedCode(t, pool, nil)
	repo := &Repo{Pool: pool}
	amount := int64(1000)

	if _, err := repo.Record(ctx, f.TenantID, Redemption{Code: f.Code, AmountCents: &amount}); err != nil {
		t.Fatalf("first redemption: %v", err)
	}
	_, err := repo.Record(ctx, f.TenantID, Redemption{Code: f.Code, AmountCents: &amount})
	if !errors.Is(err, ErrAlreadyRedeemed) {
		t.Fatalf("err = %v, want ErrAlreadyRedeemed — the same code credited the "+
			"campaign twice", err)
	}
}

// An expired code is refused, with expiry reported rather than "unknown code".
func TestAnExpiredCodeIsRefused(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	past := time.Now().UTC().Add(-time.Hour)
	f := seedAssignedCode(t, pool, &past)

	amount := int64(1000)
	_, err := (&Repo{Pool: pool}).Record(ctx, f.TenantID, Redemption{
		Code: f.Code, AmountCents: &amount,
	})
	if !errors.Is(err, ErrCodeExpired) {
		t.Fatalf("err = %v, want ErrCodeExpired — an expired code either credited "+
			"a campaign or reported the wrong reason", err)
	}
}

// An unknown code is refused.
func TestAnUnknownCodeIsRefused(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	f := seedAssignedCode(t, pool, nil)

	amount := int64(1000)
	if _, err := (&Repo{Pool: pool}).Record(ctx, f.TenantID, Redemption{
		Code: "NOT-A-REAL-CODE", AmountCents: &amount,
	}); !errors.Is(err, ErrUnknownCode) {
		t.Fatalf("err = %v, want ErrUnknownCode", err)
	}
}

// A redemption reported without a value is still attributed.
//
// Refusing an unpriced redemption would discard the attribution along with the
// missing number — and the attribution is the scarce thing.
func TestAnUnpricedRedemptionIsStillAttributed(t *testing.T) {
	pool := codesDB(t)
	ctx := context.Background()
	f := seedAssignedCode(t, pool, nil)

	result, err := (&Repo{Pool: pool}).Record(ctx, f.TenantID, Redemption{Code: f.Code})
	if err != nil {
		t.Fatalf("Record: %v", err)
	}
	if result.CampaignID != f.CampaignID {
		t.Errorf("an unpriced redemption lost its campaign attribution")
	}
	if result.ConversionID != 0 {
		t.Error("a conversion was written with no amount; a zero-value revenue row " +
			"would dilute every average that reads it")
	}
}
