// SPDX-License-Identifier: AGPL-3.0-only

package discounts

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

type couponFixture struct {
	ctx      context.Context
	pool     *db.Pool
	repo     *Repo
	tenantID string
	poolID   string
	codes    []string
}

func newCouponFixture(t *testing.T, in CouponPoolInput, codeCount int) *couponFixture {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping coupon allocation safety DB test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	t.Cleanup(cancel)

	pgPool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pgPool.Close)

	tenantID := seedDiscountTenant(t, ctx, pgPool)
	repo := &Repo{Pool: pgPool}

	tag := strings.ToUpper(randHex4Disc(t))
	if in.Name == "" {
		in.Name = "F04 pool " + tag
	}
	if in.CodeType == "" {
		in.CodeType = CouponPoolImported
	}
	created, err := repo.UpsertCouponPool(ctx, tenantID, in)
	if err != nil {
		t.Fatalf("UpsertCouponPool: %v", err)
	}

	fx := &couponFixture{ctx: ctx, pool: pgPool, repo: repo, tenantID: tenantID, poolID: created.ID}
	if codeCount > 0 {
		codes := make([]string, 0, codeCount)
		for i := 0; i < codeCount; i++ {
			codes = append(codes, "F04"+tag+strings.ToUpper(randHex4Disc(t)))
		}
		summary, err := repo.ImportCouponCodes(ctx, tenantID, created.ID, CouponCodeImportInput{Codes: codes}, time.Now().UTC())
		if err != nil {
			t.Fatalf("ImportCouponCodes: %v", err)
		}
		if summary.Imported != codeCount {
			t.Fatalf("imported %d codes, want %d", summary.Imported, codeCount)
		}
		fx.codes = codes
	}
	return fx
}

func (fx *couponFixture) codeRow(t *testing.T, codeID string) (status, subscriberEmail, contextKey string, reservedUntil *time.Time) {
	t.Helper()
	tx, err := db.WithTenant(fx.ctx, fx.pool, fx.tenantID)
	if err != nil {
		t.Fatalf("codeRow tx: %v", err)
	}
	defer func() { _ = tx.Rollback(fx.ctx) }()
	if err := tx.QueryRow(fx.ctx, `
SELECT status, subscriber_email, context_key, reserved_until
  FROM coupon_codes
 WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		fx.tenantID, codeID).Scan(&status, &subscriberEmail, &contextKey, &reservedUntil); err != nil {
		t.Fatalf("read coupon_codes %s: %v", codeID, err)
	}
	return status, subscriberEmail, contextKey, reservedUntil
}

func (fx *couponFixture) assignmentStatus(t *testing.T, assignmentID string) string {
	t.Helper()
	tx, err := db.WithTenant(fx.ctx, fx.pool, fx.tenantID)
	if err != nil {
		t.Fatalf("assignmentStatus tx: %v", err)
	}
	defer func() { _ = tx.Rollback(fx.ctx) }()
	var status string
	if err := tx.QueryRow(fx.ctx, `
SELECT status FROM coupon_assignments
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, fx.tenantID, assignmentID).Scan(&status); err != nil {
		t.Fatalf("read coupon_assignments %s: %v", assignmentID, err)
	}
	return status
}

func (fx *couponFixture) receipts(t *testing.T, filter CouponEntitlementFilter) []CouponEntitlementEvent {
	t.Helper()
	page, err := fx.repo.ListCouponEntitlementEvents(fx.ctx, fx.tenantID, fx.poolID, filter, 100, 0)
	if err != nil {
		t.Fatalf("ListCouponEntitlementEvents: %v", err)
	}
	return page.Items
}

// poolSnapshot is every mutable field reconciliation could be tempted to
// "helpfully" repair. Comparing it before and after a report is what makes
// "reports, never corrects" an assertion instead of a comment.
func (fx *couponFixture) poolSnapshot(t *testing.T) string {
	t.Helper()
	tx, err := db.WithTenant(fx.ctx, fx.pool, fx.tenantID)
	if err != nil {
		t.Fatalf("snapshot tx: %v", err)
	}
	defer func() { _ = tx.Rollback(fx.ctx) }()
	var snapshot string
	if err := tx.QueryRow(fx.ctx, `
SELECT COALESCE(
         (SELECT string_agg(row_repr, '|' ORDER BY row_repr) FROM (
             SELECT 'code:' || id::text || ':' || status || ':' || subscriber_email || ':' ||
                    context_key || ':' || COALESCE(reserved_until::text, '-') AS row_repr
               FROM coupon_codes WHERE tenant_id = $1::uuid AND pool_id = $2::uuid
             UNION ALL
             SELECT 'assignment:' || id::text || ':' || status || ':' || subscriber_email || ':' ||
                    context_key || ':' || COALESCE(reserved_until::text, '-') AS row_repr
               FROM coupon_assignments WHERE tenant_id = $1::uuid AND pool_id = $2::uuid
             UNION ALL
             SELECT 'receipt:' || id::text || ':' || to_status AS row_repr
               FROM coupon_entitlement_events WHERE tenant_id = $1::uuid AND pool_id = $2::uuid
         ) rows), '')`, fx.tenantID, fx.poolID).Scan(&snapshot); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	return snapshot
}

func sqlState(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code
	}
	return ""
}

// ---------------------------------------------------------------------------
// 1. Reservation expiry / release
// ---------------------------------------------------------------------------

// A reserved code that is never released is inventory destroyed: the recipient
// never got a code and nobody else can be given it. The whole point of
// reserved_until is that something reads it.
func TestExpiredReservationReturnsCodeToPool(t *testing.T) {
	fx := newCouponFixture(t, CouponPoolInput{MaxCodesPerSubscriber: intp(2)}, 2)

	reservedAt := time.Now().UTC().Add(-2 * time.Hour)
	result, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail:       "reserve@example.com",
		ContextKey:            "welcome",
		RenderKey:             "render-" + randHex4Disc(t),
		ReservationTTLSeconds: 60,
	}, reservedAt)
	if err != nil {
		t.Fatalf("AssignCoupon: %v", err)
	}
	if result.Assignment.Status != CouponAssignmentReserved {
		t.Fatalf("assignment status = %q, want reserved", result.Assignment.Status)
	}
	codeID := result.Assignment.CodeID
	if codeID == "" {
		t.Fatal("expected an imported code to be reserved")
	}
	if status, _, _, _ := fx.codeRow(t, codeID); status != string(CouponCodeReserved) {
		t.Fatalf("code status after reserve = %q, want reserved", status)
	}

	sweep, err := fx.repo.ExpireCouponReservations(fx.ctx, fx.tenantID, fx.poolID, time.Now().UTC())
	if err != nil {
		t.Fatalf("ExpireCouponReservations: %v", err)
	}
	if sweep.AssignmentsExpired != 1 || sweep.CodesReturnedToPool != 1 {
		t.Fatalf("sweep = %+v, want 1 assignment expired and 1 code returned", sweep)
	}
	if sweep.RenderReservationsRemoved != 1 {
		t.Fatalf("render reservations removed = %d, want 1 (a stale render key pins the code)",
			sweep.RenderReservationsRemoved)
	}

	status, email, contextKey, reservedUntil := fx.codeRow(t, codeID)
	if status != string(CouponCodeAvailable) {
		t.Fatalf("code status after expiry = %q, want available — the code is lost inventory", status)
	}
	if email != "" || contextKey != "" || reservedUntil != nil {
		t.Fatalf("expired code still carries the old holder: email=%q context=%q reserved_until=%v",
			email, contextKey, reservedUntil)
	}
	if got := fx.assignmentStatus(t, result.Assignment.ID); got != string(CouponAssignmentExpired) {
		t.Fatalf("assignment status after expiry = %q, want expired", got)
	}

	// The pool must actually be able to hand the code out again.
	after, err := fx.repo.GetCouponPool(fx.ctx, fx.tenantID, fx.poolID)
	if err != nil {
		t.Fatalf("GetCouponPool: %v", err)
	}
	if after.AvailableCodes != 2 {
		t.Fatalf("available codes after expiry = %d, want 2", after.AvailableCodes)
	}

	// Idempotence: a second sweep is a no-op, not a second release.
	before := len(fx.receipts(t, CouponEntitlementFilter{}))
	again, err := fx.repo.ExpireCouponReservations(fx.ctx, fx.tenantID, fx.poolID, time.Now().UTC())
	if err != nil {
		t.Fatalf("second ExpireCouponReservations: %v", err)
	}
	if again.AssignmentsExpired != 0 || again.CodesReturnedToPool != 0 || again.OrphanCodesReturned != 0 {
		t.Fatalf("second sweep was not a no-op: %+v", again)
	}
	if after := len(fx.receipts(t, CouponEntitlementFilter{})); after != before {
		t.Fatalf("second sweep wrote %d extra receipts; a no-op must leave no trail", after-before)
	}
}

// The tenant-wide sweep (empty pool id) is the form a scheduler will actually
// call. It exercises the optional-uuid predicate, which must not attempt to cast
// an empty string to uuid — that raises, and it raises only when the planner
// chooses to evaluate that arm, which is to say in production and not in a test
// with three rows.
func TestTenantWideSweepReclaimsAcrossPools(t *testing.T) {
	fx := newCouponFixture(t, CouponPoolInput{}, 1)

	second, err := fx.repo.UpsertCouponPool(fx.ctx, fx.tenantID, CouponPoolInput{
		Name:     "F04 second " + randHex4Disc(t),
		CodeType: CouponPoolImported,
	})
	if err != nil {
		t.Fatalf("UpsertCouponPool (second): %v", err)
	}
	if _, err := fx.repo.ImportCouponCodes(fx.ctx, fx.tenantID, second.ID,
		CouponCodeImportInput{Codes: []string{"F04SECOND" + strings.ToUpper(randHex4Disc(t))}},
		time.Now().UTC()); err != nil {
		t.Fatalf("ImportCouponCodes (second): %v", err)
	}

	reservedAt := time.Now().UTC().Add(-2 * time.Hour)
	for _, poolID := range []string{fx.poolID, second.ID} {
		if _, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, poolID, CouponAssignmentInput{
			SubscriberEmail:       "wide@example.com",
			ContextKey:            "ctx-wide",
			ReservationTTLSeconds: 60,
		}, reservedAt); err != nil {
			t.Fatalf("AssignCoupon in pool %s: %v", poolID, err)
		}
	}

	sweep, err := fx.repo.ExpireCouponReservations(fx.ctx, fx.tenantID, "", time.Now().UTC())
	if err != nil {
		t.Fatalf("tenant-wide ExpireCouponReservations: %v", err)
	}
	if sweep.AssignmentsExpired != 2 || sweep.CodesReturnedToPool != 2 {
		t.Fatalf("tenant-wide sweep = %+v, want 2 assignments expired and 2 codes returned", sweep)
	}
}

// A code redeemed after its reservation deadline must never be reclaimed:
// reclaiming it hands a spent discount to a second recipient.
func TestSweepLeavesRedeemedCodeAlone(t *testing.T) {
	fx := newCouponFixture(t, CouponPoolInput{}, 1)

	reservedAt := time.Now().UTC().Add(-2 * time.Hour)
	result, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail:       "late@example.com",
		ContextKey:            "welcome",
		ReservationTTLSeconds: 60,
	}, reservedAt)
	if err != nil {
		t.Fatalf("AssignCoupon: %v", err)
	}
	if _, err := fx.repo.Redeem(fx.ctx, fx.tenantID, result.Assignment.Code, CouponRedemptionInput{
		SubscriberEmail: "late@example.com",
	}, time.Now().UTC()); err != nil {
		t.Fatalf("Redeem: %v", err)
	}

	sweep, err := fx.repo.ExpireCouponReservations(fx.ctx, fx.tenantID, fx.poolID, time.Now().UTC())
	if err != nil {
		t.Fatalf("ExpireCouponReservations: %v", err)
	}
	if sweep.AssignmentsExpired != 0 || sweep.CodesReturnedToPool != 0 || sweep.OrphanCodesReturned != 0 {
		t.Fatalf("sweep touched a redeemed reservation: %+v", sweep)
	}
	if status, _, _, _ := fx.codeRow(t, result.Assignment.CodeID); status != string(CouponCodeRedeemed) {
		t.Fatalf("redeemed code status = %q, want redeemed", status)
	}
}

func TestReleaseIsIdempotentAndNeverUnredeems(t *testing.T) {
	fx := newCouponFixture(t, CouponPoolInput{MaxCodesPerSubscriber: intp(4)}, 3)

	assigned, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail: "release@example.com",
		ContextKey:      "ctx-release",
	}, time.Now().UTC())
	if err != nil {
		t.Fatalf("AssignCoupon: %v", err)
	}

	first, err := fx.repo.ReleaseCouponAssignment(fx.ctx, fx.tenantID, assigned.Assignment.ID, "send_failed", time.Now().UTC())
	if err != nil {
		t.Fatalf("ReleaseCouponAssignment: %v", err)
	}
	if !first.Released || !first.CodeReturned {
		t.Fatalf("first release = %+v, want released with the code returned", first)
	}
	if status, _, _, _ := fx.codeRow(t, assigned.Assignment.CodeID); status != string(CouponCodeAvailable) {
		t.Fatalf("released code status = %q, want available", status)
	}

	receiptsAfterFirst := len(fx.receipts(t, CouponEntitlementFilter{}))
	second, err := fx.repo.ReleaseCouponAssignment(fx.ctx, fx.tenantID, assigned.Assignment.ID, "send_failed", time.Now().UTC())
	if err != nil {
		t.Fatalf("second ReleaseCouponAssignment: %v", err)
	}
	if second.Released {
		t.Fatal("second release reported success; release must be idempotent")
	}
	if second.Reason != "already_released" {
		t.Fatalf("second release reason = %q, want already_released", second.Reason)
	}
	if got := len(fx.receipts(t, CouponEntitlementFilter{})); got != receiptsAfterFirst {
		t.Fatalf("second release wrote %d extra receipts", got-receiptsAfterFirst)
	}

	// A redeemed assignment is never released: the discount was spent.
	spent, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail: "spent@example.com",
		ContextKey:      "ctx-spent",
	}, time.Now().UTC())
	if err != nil {
		t.Fatalf("AssignCoupon (spent): %v", err)
	}
	if _, err := fx.repo.Redeem(fx.ctx, fx.tenantID, spent.Assignment.Code, CouponRedemptionInput{
		SubscriberEmail: "spent@example.com",
	}, time.Now().UTC()); err != nil {
		t.Fatalf("Redeem: %v", err)
	}
	out, err := fx.repo.ReleaseCouponAssignment(fx.ctx, fx.tenantID, spent.Assignment.ID, "oops", time.Now().UTC())
	if err != nil {
		t.Fatalf("ReleaseCouponAssignment (redeemed): %v", err)
	}
	if out.Released || out.Reason != "already_redeemed" {
		t.Fatalf("release of a redeemed assignment = %+v, want refused as already_redeemed", out)
	}
	if status, _, _, _ := fx.codeRow(t, spent.Assignment.CodeID); status != string(CouponCodeRedeemed) {
		t.Fatalf("redeemed code was disturbed: status = %q", status)
	}
}

// Reserve -> confirm is the pair that makes a reservation safe. Without confirm
// a reservation can only expire, so reserving is a way to lose inventory.
func TestConfirmPromotesReservationAndRefusesAfterDeadline(t *testing.T) {
	fx := newCouponFixture(t, CouponPoolInput{MaxCodesPerSubscriber: intp(4)}, 3)

	live, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail:       "confirm@example.com",
		ContextKey:            "ctx-confirm",
		ReservationTTLSeconds: 3600,
	}, time.Now().UTC())
	if err != nil {
		t.Fatalf("AssignCoupon: %v", err)
	}
	confirmed, err := fx.repo.ConfirmCouponReservation(fx.ctx, fx.tenantID, live.Assignment.ID, time.Now().UTC())
	if err != nil {
		t.Fatalf("ConfirmCouponReservation: %v", err)
	}
	if !confirmed.Confirmed {
		t.Fatalf("confirm = %+v, want confirmed", confirmed)
	}
	if got := fx.assignmentStatus(t, live.Assignment.ID); got != string(CouponAssignmentAssigned) {
		t.Fatalf("assignment status after confirm = %q, want assigned", got)
	}
	if status, _, _, reservedUntil := fx.codeRow(t, live.Assignment.CodeID); status != string(CouponCodeAssigned) || reservedUntil != nil {
		t.Fatalf("code after confirm: status=%q reserved_until=%v, want assigned with no deadline", status, reservedUntil)
	}
	repeat, err := fx.repo.ConfirmCouponReservation(fx.ctx, fx.tenantID, live.Assignment.ID, time.Now().UTC())
	if err != nil {
		t.Fatalf("repeat ConfirmCouponReservation: %v", err)
	}
	if repeat.Confirmed || repeat.Reason != "already_assigned" {
		t.Fatalf("repeat confirm = %+v, want an idempotent no-op", repeat)
	}

	// A reservation past its deadline is never resurrected: the sweeper may
	// already have handed that code to somebody else.
	stale, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail:       "stale@example.com",
		ContextKey:            "ctx-stale",
		ReservationTTLSeconds: 60,
	}, time.Now().UTC().Add(-2*time.Hour))
	if err != nil {
		t.Fatalf("AssignCoupon (stale): %v", err)
	}
	out, err := fx.repo.ConfirmCouponReservation(fx.ctx, fx.tenantID, stale.Assignment.ID, time.Now().UTC())
	if err != nil {
		t.Fatalf("ConfirmCouponReservation (stale): %v", err)
	}
	if out.Confirmed || out.Reason != CouponReasonReservationExpired {
		t.Fatalf("confirm of an expired reservation = %+v, want refusal", out)
	}
	if got := fx.assignmentStatus(t, stale.Assignment.ID); got != string(CouponAssignmentReserved) {
		t.Fatalf("refused confirm changed the assignment to %q", got)
	}
}

func TestReservationTTLCeilingRefusesUnboundedHold(t *testing.T) {
	fx := newCouponFixture(t, CouponPoolInput{MaxReservationTTLSeconds: intp(120)}, 1)

	_, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail:       "long@example.com",
		ContextKey:            "ctx-long",
		ReservationTTLSeconds: 86400,
	}, time.Now().UTC())
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("AssignCoupon with an over-ceiling TTL: err = %v, want ErrInvalidInput", err)
	}
	after, err := fx.repo.GetCouponPool(fx.ctx, fx.tenantID, fx.poolID)
	if err != nil {
		t.Fatalf("GetCouponPool: %v", err)
	}
	if after.AvailableCodes != 1 {
		t.Fatalf("refused allocation still consumed inventory: available = %d, want 1", after.AvailableCodes)
	}
}

// ---------------------------------------------------------------------------
// 2. Durable entitlement auditing
// ---------------------------------------------------------------------------

// Every transition must leave an append-only receipt naming who got what and
// when. Nothing in Go writes these; migration 1970's triggers do, so a code path
// that forgets cannot exist.
func TestEveryTransitionLeavesAnAppendOnlyReceipt(t *testing.T) {
	fx := newCouponFixture(t, CouponPoolInput{MaxCodesPerSubscriber: intp(4)}, 3)

	res, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail:       "audit@example.com",
		ContextKey:            "ctx-audit",
		ReservationTTLSeconds: 3600,
	}, time.Now().UTC())
	if err != nil {
		t.Fatalf("AssignCoupon: %v", err)
	}
	if _, err := fx.repo.ConfirmCouponReservation(fx.ctx, fx.tenantID, res.Assignment.ID, time.Now().UTC()); err != nil {
		t.Fatalf("ConfirmCouponReservation: %v", err)
	}
	if _, err := fx.repo.Redeem(fx.ctx, fx.tenantID, res.Assignment.Code, CouponRedemptionInput{
		SubscriberEmail: "audit@example.com",
	}, time.Now().UTC()); err != nil {
		t.Fatalf("Redeem: %v", err)
	}

	assignmentTrail := transitions(fx.receipts(t, CouponEntitlementFilter{AssignmentID: res.Assignment.ID}))
	for _, want := range []string{"->reserved", "reserved->assigned", "assigned->redeemed"} {
		if !assignmentTrail[want] {
			t.Fatalf("assignment receipt %q missing; trail = %v", want, assignmentTrail)
		}
	}
	codeTrail := transitions(fx.receipts(t, CouponEntitlementFilter{CodeID: res.Assignment.CodeID}))
	for _, want := range []string{"->reserved", "reserved->assigned", "assigned->redeemed"} {
		if !codeTrail[want] {
			t.Fatalf("code receipt %q missing; trail = %v", want, codeTrail)
		}
	}

	// "Who got what" — the receipt must name the recipient and the code, not
	// just the fact that something happened.
	for _, ev := range fx.receipts(t, CouponEntitlementFilter{AssignmentID: res.Assignment.ID}) {
		if ev.SubscriberEmail != "audit@example.com" {
			t.Fatalf("receipt %d does not name the recipient: %+v", ev.ID, ev)
		}
		if ev.Code != res.Assignment.Code {
			t.Fatalf("receipt %d does not name the code (%q != %q)", ev.ID, ev.Code, res.Assignment.Code)
		}
		if ev.Actor == "" || ev.Actor == "unattributed" {
			t.Fatalf("receipt %d has no actor: %+v", ev.ID, ev)
		}
		if ev.OccurredAt.IsZero() {
			t.Fatalf("receipt %d has no time: %+v", ev.ID, ev)
		}
	}

	// A release also leaves a receipt, and it says 'released' rather than
	// quietly reverting the trail to 'available' with no explanation.
	other, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail: "audit2@example.com",
		ContextKey:      "ctx-audit2",
	}, time.Now().UTC())
	if err != nil {
		t.Fatalf("AssignCoupon (release trail): %v", err)
	}
	if _, err := fx.repo.ReleaseCouponAssignment(fx.ctx, fx.tenantID, other.Assignment.ID, "operator_withdrew", time.Now().UTC()); err != nil {
		t.Fatalf("ReleaseCouponAssignment: %v", err)
	}
	releaseTrail := transitions(fx.receipts(t, CouponEntitlementFilter{AssignmentID: other.Assignment.ID}))
	if !releaseTrail["assigned->released"] {
		t.Fatalf("release receipt missing; trail = %v", releaseTrail)
	}
	codeReturnTrail := transitions(fx.receipts(t, CouponEntitlementFilter{CodeID: other.Assignment.CodeID}))
	if !codeReturnTrail["assigned->available"] {
		t.Fatalf("code-return receipt missing; trail = %v", codeReturnTrail)
	}
	var sawReason bool
	for _, ev := range fx.receipts(t, CouponEntitlementFilter{AssignmentID: other.Assignment.ID}) {
		if ev.ToStatus == string(CouponAssignmentReleased) && ev.Reason == "operator_withdrew" {
			sawReason = true
		}
	}
	if !sawReason {
		t.Fatal("release receipt did not record why the code was taken back")
	}
}

func TestEntitlementReceiptsCannotBeForgedOrRewritten(t *testing.T) {
	fx, ownerProofURL := newOwnerProofCouponFixture(t, CouponPoolInput{}, 1)

	res, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail: "immutable@example.com",
		ContextKey:      "ctx-immutable",
	}, time.Now().UTC())
	if err != nil {
		t.Fatalf("AssignCoupon: %v", err)
	}
	existing := fx.receipts(t, CouponEntitlementFilter{AssignmentID: res.Assignment.ID})
	if len(existing) == 0 {
		t.Fatal("no receipt to test immutability against")
	}

	// Forgery: a direct INSERT by the application role is refused even though
	// the role holds INSERT (it holds it only so the triggers can run).
	forgeErr := fx.exec(t, `
INSERT INTO coupon_entitlement_events
    (tenant_id, pool_id, subject_kind, assignment_id, code, to_status, actor)
VALUES ($1::uuid, $2::uuid, 'assignment', $3::uuid, 'FORGED', 'redeemed', 'attacker')`,
		fx.tenantID, fx.poolID, res.Assignment.ID)
	if forgeErr == nil {
		t.Fatal("a caller forged an entitlement receipt")
	}
	if state := sqlState(forgeErr); state != sqlStateLedgerForged && state != "42501" {
		t.Fatalf("forged insert failed with SQLSTATE %q (%v); want the ledger write guard or a privilege refusal",
			state, forgeErr)
	}

	// Rewrite and erase: both refused, and the row survives.
	if err := fx.exec(t, `
UPDATE coupon_entitlement_events SET to_status = 'available'
 WHERE tenant_id = $1::uuid AND id = $2`, fx.tenantID, existing[0].ID); err == nil {
		t.Fatal("an entitlement receipt was rewritten")
	}
	if err := fx.exec(t, `
DELETE FROM coupon_entitlement_events
 WHERE tenant_id = $1::uuid AND id = $2`, fx.tenantID, existing[0].ID); err == nil {
		t.Fatal("an entitlement receipt was deleted")
	}
	still := fx.receipts(t, CouponEntitlementFilter{AssignmentID: res.Assignment.ID})
	if len(still) != len(existing) {
		t.Fatalf("receipt count changed from %d to %d after refused mutations", len(existing), len(still))
	}

	// The privilege refusals above bind the application role. The trigger is
	// what binds the table owner, which privileges alone never do.
	adminURL := ownerProofURL
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL (or POSTWAVE_ADMIN_DATABASE_URL) not set; the application-role " +
			"refusals above ran, the owner-level append-only proof did not")
	}
	t.Setenv("POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE", "1")
	adminPool, err := db.New(fx.ctx, adminURL)
	if err != nil {
		t.Fatalf("db.New(admin): %v", err)
	}
	defer adminPool.Close()
	if _, err := adminPool.Exec(fx.ctx,
		`UPDATE coupon_entitlement_events SET to_status = 'available' WHERE id = $1`,
		existing[0].ID); err == nil {
		t.Fatal("a privileged role rewrote an entitlement receipt")
	} else if state := sqlState(err); state != sqlStateLedgerMutation {
		t.Fatalf("privileged UPDATE failed with SQLSTATE %q (%v); want %s", state, err, sqlStateLedgerMutation)
	}
	if _, err := adminPool.Exec(fx.ctx,
		`DELETE FROM coupon_entitlement_events WHERE id = $1`, existing[0].ID); err == nil {
		t.Fatal("a privileged role deleted an entitlement receipt")
	} else if state := sqlState(err); state != sqlStateLedgerMutation {
		t.Fatalf("privileged DELETE failed with SQLSTATE %q (%v); want %s", state, err, sqlStateLedgerMutation)
	}

	// TRUNCATE, which the row-level guard could not see.
	//
	// A FOR EACH ROW trigger cannot fire on TRUNCATE — there are no rows to fire
	// per — and REVOKE TRUNCATE binds only the application role. So the ledger
	// that refused UPDATE and DELETE above was erased in full by one ordinary
	// statement, with no guard-disabling gesture and no error. It is asserted
	// here because the original claim of "append-only three independent ways"
	// tested the two verbs that were covered and not the one that was not.
	if err := truncateLedgerInPrivateDatabase(t, fx.ctx, adminPool); err == nil {
		t.Fatal("a privileged role TRUNCATEd the entitlement ledger; the audit " +
			"trail a chargeback depends on can be erased by one statement")
	} else if state := sqlState(err); state != sqlStateLedgerMutation {
		t.Fatalf("privileged TRUNCATE failed with SQLSTATE %q (%v); want %s",
			state, err, sqlStateLedgerMutation)
	}
	// Guard the guard: the receipts must still be there.
	if survivors := fx.receipts(t, CouponEntitlementFilter{}); len(survivors) == 0 {
		t.Fatal("the ledger is empty after a refused TRUNCATE")
	}
}

// A reserved row must carry its expiry deadline, enforced by the SCHEMA.
//
// Both legs of the expiry sweeper and the past-deadline drift check all require
// reserved_until IS NOT NULL. A 'reserved' row without one is therefore held
// forever, never swept, and invisible to every drift kind — reconciliation
// reports Healthy while the code is permanently lost inventory, which is exactly
// the failure the reservation prerequisite exists to close.
//
// The invariant used to rest on one Go call site remembering to set the
// deadline. That is the thing this work deliberately refused to rely on
// elsewhere: a bound that exists only in one caller is not a bound.
func TestAReservedRowCannotExistWithoutADeadline(t *testing.T) {
	fx := newCouponFixture(t, CouponPoolInput{}, 1)

	// A reservation must EXIST before this can mean anything. An UPDATE matching
	// zero rows succeeds and violates nothing, so without the row-count guard
	// below this test would "pass" on an empty tenant and prove exactly nothing —
	// the same zero-rows trap that makes an unscoped RLS write look successful.
	if _, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail: "deadline@example.com",
		ContextKey:      "ctx-deadline",
	}, time.Now().UTC()); err != nil {
		t.Fatalf("AssignCoupon: %v", err)
	}

	for _, table := range []string{"coupon_codes", "coupon_assignments"} {
		// Through WithTenant, because these tables carry FORCED RLS. An unscoped
		// pool matches ZERO rows and the UPDATE reports success having changed
		// nothing — so a constraint test run that way passes whether or not the
		// constraint exists.
		tx, err := db.WithTenant(fx.ctx, fx.pool, fx.tenantID)
		if err != nil {
			t.Fatalf("WithTenant: %v", err)
		}

		// Prove the statement can actually reach a row before asserting on a
		// refusal. Without this the refusal below is indistinguishable from an
		// empty table.
		probe, err := tx.Exec(fx.ctx,
			`UPDATE `+table+` SET updated_at = now() WHERE tenant_id = $1::uuid`,
			fx.tenantID)
		if err != nil {
			_ = tx.Rollback(fx.ctx)
			t.Fatalf("%s probe update: %v", table, err)
		}
		if probe.RowsAffected() == 0 {
			_ = tx.Rollback(fx.ctx)
			t.Fatalf("%s has no rows for this tenant; the assertion below would be vacuous", table)
		}

		_, err = tx.Exec(fx.ctx,
			`UPDATE `+table+` SET status = 'reserved', reserved_until = NULL
			  WHERE tenant_id = $1::uuid`, fx.tenantID)
		_ = tx.Rollback(fx.ctx)
		if err == nil {
			t.Fatalf("%s accepted a reserved row with no deadline; it would be "+
				"held forever and no drift check would report it", table)
		}
		if !strings.Contains(err.Error(), "reserved_has_deadline") {
			t.Fatalf("%s rejected the write for the wrong reason: %v", table, err)
		}
	}
}

// An append-only guard that also blocks the tenant cascade would make tenant
// deletion fail with a foreign-key error — turning "receipts survive" into
// "tenants cannot be removed". The allowance is narrow (nested inside the RI
// trigger of this table's only foreign key) and this is what proves it is wide
// enough.
func TestTenantDeletionStillReclaimsReceipts(t *testing.T) {
	fx := newCouponFixture(t, CouponPoolInput{}, 1)

	if _, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail: "purge@example.com",
		ContextKey:      "ctx-purge",
	}, time.Now().UTC()); err != nil {
		t.Fatalf("AssignCoupon: %v", err)
	}
	if len(fx.receipts(t, CouponEntitlementFilter{})) == 0 {
		t.Fatal("no receipts to purge")
	}

	if err := fx.exec(t, `DELETE FROM tenants WHERE id = $1::uuid`, fx.tenantID); err != nil {
		t.Fatalf("tenant deletion was blocked by the append-only guard: %v", err)
	}

	tx, err := db.WithTenant(fx.ctx, fx.pool, fx.tenantID)
	if err != nil {
		t.Fatalf("verify tx: %v", err)
	}
	defer func() { _ = tx.Rollback(fx.ctx) }()
	var remaining int
	if err := tx.QueryRow(fx.ctx, `
SELECT count(*)::int FROM coupon_entitlement_events WHERE tenant_id = $1::uuid`,
		fx.tenantID).Scan(&remaining); err != nil {
		t.Fatalf("count receipts: %v", err)
	}
	if remaining != 0 {
		t.Fatalf("%d receipts survived their tenant", remaining)
	}
}

// ---------------------------------------------------------------------------
// 3. Abuse controls
// ---------------------------------------------------------------------------

// Without a bound, a loop or a replayed webhook that varies context_key drains a
// pool and the first sign is a finance report. The existing partial unique
// indexes do not help: they only dedup a replay that reuses the same key.
func TestPerSubscriberBoundRefusesExtraDraw(t *testing.T) {
	fx := newCouponFixture(t, CouponPoolInput{MaxCodesPerSubscriber: intp(1)}, 5)

	if _, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail: "greedy@example.com",
		ContextKey:      "loop-0",
	}, time.Now().UTC()); err != nil {
		t.Fatalf("first AssignCoupon: %v", err)
	}

	// Same subscriber, a different context key each time — the shape a replay
	// loop actually has.
	for i := 1; i < 4; i++ {
		_, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
			SubscriberEmail: "greedy@example.com",
			ContextKey:      "loop-" + string(rune('0'+i)),
		}, time.Now().UTC())
		if !errors.Is(err, ErrCouponQuotaExceeded) {
			t.Fatalf("draw %d: err = %v, want ErrCouponQuotaExceeded", i, err)
		}
	}

	after, err := fx.repo.GetCouponPool(fx.ctx, fx.tenantID, fx.poolID)
	if err != nil {
		t.Fatalf("GetCouponPool: %v", err)
	}
	if after.AvailableCodes != 4 || after.AssignedCodes != 1 {
		t.Fatalf("pool drained past the bound: available=%d assigned=%d, want 4/1",
			after.AvailableCodes, after.AssignedCodes)
	}

	// A released code is given back, so it must stop counting against the
	// recipient — otherwise a failed send permanently consumes an entitlement.
	page, err := fx.repo.ListCouponAssignments(fx.ctx, fx.tenantID, fx.poolID, "assigned", 10, 0)
	if err != nil {
		t.Fatalf("ListCouponAssignments: %v", err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("assignments = %d, want 1", len(page.Items))
	}
	if _, err := fx.repo.ReleaseCouponAssignment(fx.ctx, fx.tenantID, page.Items[0].ID, "send_failed", time.Now().UTC()); err != nil {
		t.Fatalf("ReleaseCouponAssignment: %v", err)
	}
	if _, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail: "greedy@example.com",
		ContextKey:      "loop-retry",
	}, time.Now().UTC()); err != nil {
		t.Fatalf("re-draw after release: %v", err)
	}
}

// The bound must not live only in this package: coupon_assignments has other
// writers, and a bound one caller enforces is not a bound.
func TestQuotaGuardRefusesADirectInsertThatBypassesTheRepo(t *testing.T) {
	fx := newCouponFixture(t, CouponPoolInput{MaxCodesPerSubscriber: intp(1)}, 3)

	if _, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail: "bypass@example.com",
		ContextKey:      "ctx-bypass",
	}, time.Now().UTC()); err != nil {
		t.Fatalf("AssignCoupon: %v", err)
	}

	err := fx.exec(t, `
INSERT INTO coupon_assignments
    (tenant_id, pool_id, static_code, subscriber_email, context_key, status)
VALUES ($1::uuid, $2::uuid, 'SIDEDOOR', 'bypass@example.com', 'ctx-sidedoor', 'assigned')`,
		fx.tenantID, fx.poolID)
	if err == nil {
		t.Fatal("a direct INSERT drew a second code past the per-subscriber bound")
	}
	if state := sqlState(err); state != sqlStateSubscriberQuota {
		t.Fatalf("direct INSERT failed with SQLSTATE %q (%v); want %s", state, err, sqlStateSubscriberQuota)
	}

	// A redemption receipt for an already-issued code is deliberately exempt:
	// refusing it would break redemption of a code the recipient legitimately
	// holds.
	if err := fx.exec(t, `
INSERT INTO coupon_assignments
    (tenant_id, pool_id, static_code, subscriber_email, context_key, status, redeemed_at)
VALUES ($1::uuid, $2::uuid, 'SIDEDOOR', 'bypass@example.com', 'ctx-redeemed', 'redeemed', now())`,
		fx.tenantID, fx.poolID); err != nil {
		t.Fatalf("materialising a redemption was refused by the allocation bound: %v", err)
	}
}

func TestPerCampaignBoundRefusesOverdraw(t *testing.T) {
	fx := newCouponFixture(t, CouponPoolInput{
		MaxCodesPerSubscriber: intp(5),
		MaxCodesPerCampaign:   intp(2),
	}, 6)

	campaignID := fx.seedCampaign(t)
	for i := 0; i < 2; i++ {
		if _, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
			SubscriberEmail: "buyer" + string(rune('a'+i)) + "@example.com",
			ContextKey:      "blast",
			CampaignID:      campaignID,
		}, time.Now().UTC()); err != nil {
			t.Fatalf("draw %d: %v", i, err)
		}
	}
	_, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail: "buyerz@example.com",
		ContextKey:      "blast",
		CampaignID:      campaignID,
	}, time.Now().UTC())
	if !errors.Is(err, ErrCouponQuotaExceeded) {
		t.Fatalf("third draw for one campaign: err = %v, want ErrCouponQuotaExceeded", err)
	}
	after, err := fx.repo.GetCouponPool(fx.ctx, fx.tenantID, fx.poolID)
	if err != nil {
		t.Fatalf("GetCouponPool: %v", err)
	}
	if after.AssignedCodes != 2 {
		t.Fatalf("campaign drew %d codes past a bound of 2", after.AssignedCodes)
	}
}

// ---------------------------------------------------------------------------
// 4. Reconciliation
// ---------------------------------------------------------------------------

// Reconciliation must REPORT drift and change nothing. Silent correction
// destroys the evidence that something went wrong, so the second occurrence
// looks like the first.
func TestReconciliationReportsDriftAndCorrectsNothing(t *testing.T) {
	fx := newCouponFixture(t, CouponPoolInput{MaxCodesPerSubscriber: intp(4)}, 3)

	res, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail: "drift@example.com",
		ContextKey:      "ctx-drift",
	}, time.Now().UTC())
	if err != nil {
		t.Fatalf("AssignCoupon: %v", err)
	}

	healthy, err := fx.repo.ReconcileCouponPool(fx.ctx, fx.tenantID, fx.poolID, time.Now().UTC())
	if err != nil {
		t.Fatalf("ReconcileCouponPool: %v", err)
	}
	if !healthy.Healthy {
		t.Fatalf("a freshly allocated pool reported drift: %+v", healthy.Drift)
	}
	if healthy.Codes.Assigned != 1 || healthy.Assignments.Assigned != 1 || healthy.ReceiptCount == 0 {
		t.Fatalf("reconciliation counters look wrong: %+v", healthy)
	}

	// Manufacture the exact failure that matters: the ledger says a recipient
	// holds this code, inventory says it is free. The same code can now be
	// handed to a second person.
	if err := fx.exec(t, `
UPDATE coupon_codes SET status = 'available', subscriber_email = '', context_key = ''
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, fx.tenantID, res.Assignment.CodeID); err != nil {
		t.Fatalf("manufacture drift: %v", err)
	}

	before := fx.poolSnapshot(t)
	report, err := fx.repo.ReconcileCouponPool(fx.ctx, fx.tenantID, fx.poolID, time.Now().UTC())
	if err != nil {
		t.Fatalf("ReconcileCouponPool (drifted): %v", err)
	}
	if report.Healthy || report.DriftCount == 0 {
		t.Fatalf("reconciliation reported a healthy pool while inventory and entitlement disagree: %+v", report)
	}
	var sawKind bool
	for _, d := range report.Drift {
		if d.Kind == CouponDriftAssignmentWithoutHeldCode && d.AssignmentID == res.Assignment.ID {
			sawKind = true
			if d.Detail == "" || d.Observed == "" {
				t.Fatalf("drift finding is unactionable: %+v", d)
			}
		}
	}
	if !sawKind {
		t.Fatalf("expected %s for assignment %s; got %+v",
			CouponDriftAssignmentWithoutHeldCode, res.Assignment.ID, report.Drift)
	}

	if after := fx.poolSnapshot(t); after != before {
		t.Fatalf("reconciliation modified state.\nbefore: %s\nafter:  %s", before, after)
	}

	// Running it again must produce the same finding rather than a clean bill of
	// health, because nothing repaired anything.
	repeat, err := fx.repo.ReconcileCouponPool(fx.ctx, fx.tenantID, fx.poolID, time.Now().UTC())
	if err != nil {
		t.Fatalf("repeat ReconcileCouponPool: %v", err)
	}
	if repeat.Healthy || repeat.DriftCount != report.DriftCount {
		t.Fatalf("second report disagrees with the first: %d vs %d findings (healthy=%v)",
			repeat.DriftCount, report.DriftCount, repeat.Healthy)
	}
	if after := fx.poolSnapshot(t); after != before {
		t.Fatal("the second reconciliation modified state")
	}
}

func TestReconciliationReportsAStalledSweeper(t *testing.T) {
	fx := newCouponFixture(t, CouponPoolInput{}, 2)

	if _, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
		SubscriberEmail:       "stalled@example.com",
		ContextKey:            "ctx-stalled",
		ReservationTTLSeconds: 60,
	}, time.Now().UTC().Add(-6*time.Hour)); err != nil {
		t.Fatalf("AssignCoupon: %v", err)
	}

	report, err := fx.repo.ReconcileCouponPool(fx.ctx, fx.tenantID, fx.poolID, time.Now().UTC())
	if err != nil {
		t.Fatalf("ReconcileCouponPool: %v", err)
	}
	var sawDeadline bool
	for _, d := range report.Drift {
		if d.Kind == CouponDriftReservationPastDeadline {
			sawDeadline = true
		}
	}
	if !sawDeadline {
		t.Fatalf("a reservation six hours past its deadline was not reported: %+v", report.Drift)
	}

	// After the sweeper runs, the same pool reconciles clean — the report tracks
	// reality rather than accumulating.
	if _, err := fx.repo.ExpireCouponReservations(fx.ctx, fx.tenantID, fx.poolID, time.Now().UTC()); err != nil {
		t.Fatalf("ExpireCouponReservations: %v", err)
	}
	swept, err := fx.repo.ReconcileCouponPool(fx.ctx, fx.tenantID, fx.poolID, time.Now().UTC())
	if err != nil {
		t.Fatalf("ReconcileCouponPool after sweep: %v", err)
	}
	for _, d := range swept.Drift {
		if d.Kind == CouponDriftReservationPastDeadline {
			t.Fatalf("reservation still reported past deadline after a sweep: %+v", d)
		}
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func (fx *couponFixture) exec(t *testing.T, sql string, args ...any) error {
	t.Helper()
	tx, err := db.WithTenant(fx.ctx, fx.pool, fx.tenantID)
	if err != nil {
		t.Fatalf("exec tx: %v", err)
	}
	defer func() { _ = tx.Rollback(fx.ctx) }()
	if _, err := tx.Exec(fx.ctx, sql, args...); err != nil {
		return err
	}
	return tx.Commit(fx.ctx)
}

func (fx *couponFixture) seedCampaign(t *testing.T) string {
	t.Helper()
	tx, err := db.WithTenant(fx.ctx, fx.pool, fx.tenantID)
	if err != nil {
		t.Fatalf("seedCampaign tx: %v", err)
	}
	defer func() { _ = tx.Rollback(fx.ctx) }()
	var id string
	if err := tx.QueryRow(fx.ctx, `
INSERT INTO campaigns (tenant_id, name, subject)
VALUES ($1::uuid, $2, $2)
RETURNING id::text`, fx.tenantID, "F04 campaign "+randHex4Disc(t)).Scan(&id); err != nil {
		t.Fatalf("seed campaign: %v", err)
	}
	if err := tx.Commit(fx.ctx); err != nil {
		t.Fatalf("commit campaign: %v", err)
	}
	return id
}

func transitions(events []CouponEntitlementEvent) map[string]bool {
	out := map[string]bool{}
	for _, ev := range events {
		out[ev.FromStatus+"->"+ev.ToStatus] = true
	}
	return out
}

// Reconciliation must report an un-evidenced transition on EITHER table.
//
// The missing-receipt check had only an assignment leg, so a code that reached a
// live status with no receipt produced no drift finding at all. The existing
// proof did not catch it because it disabled BOTH receipt triggers at once and
// what fired was the assignment leg — a mutation that "passes" while only half
// the rule exists.
//
// Each trigger is therefore disabled INDEPENDENTLY here. coupon_codes is the
// table carrying the inventory state a reconciliation exists to account for, so
// a status it reached with nothing recording how is precisely the un-evidenced
// transition the ledger was built to make impossible.
func TestReconciliationReportsAnUnevidencedTransitionOnEitherTable(t *testing.T) {
	for _, tc := range []struct{ name, trigger string }{
		{"assignment receipts missing", "coupon_assignments_entitlement_receipt"},
		{"code receipts missing", "coupon_codes_entitlement_receipt"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Disabling a trigger is table-wide and outlives the statement, and
			// ALTER TABLE queues every tenant deletion (each one cascades into
			// both tables) behind its SHARE ROW EXCLUSIVE lock. So this proof
			// runs only in the private database; see ledger_isolation_db_test.go.
			isolated := requirePrivateCouponDatabase(t)
			fx := isolated.fixture(t, CouponPoolInput{}, 1)
			admin := adminExec(t, isolated)

			admin(t, "ALTER TABLE "+triggerTable(tc.trigger)+" DISABLE TRIGGER "+tc.trigger)
			t.Cleanup(func() {
				admin(t, "ALTER TABLE "+triggerTable(tc.trigger)+" ENABLE TRIGGER "+tc.trigger)
			})

			if _, err := fx.repo.AssignCoupon(fx.ctx, fx.tenantID, fx.poolID, CouponAssignmentInput{
				SubscriberEmail: "unevidenced@example.com", ContextKey: "ctx-unevidenced",
			}, time.Now().UTC()); err != nil {
				t.Fatalf("AssignCoupon: %v", err)
			}

			report, err := fx.repo.ReconcileCouponPool(fx.ctx, fx.tenantID, fx.poolID, time.Now().UTC())
			if err != nil {
				t.Fatalf("ReconcileCouponPool: %v", err)
			}
			found := false
			for _, drift := range report.Drift {
				if drift.Kind == CouponDriftMissingReceipt {
					found = true
				}
			}
			if !found {
				t.Fatalf("a transition with no %s receipt produced no drift: %+v",
					tc.name, report.Drift)
			}
			if report.Healthy {
				t.Fatal("reconciliation reported Healthy with an un-evidenced transition")
			}
		})
	}
}

func triggerTable(trigger string) string {
	if strings.HasPrefix(trigger, "coupon_codes") {
		return "coupon_codes"
	}
	return "coupon_assignments"
}

// adminExec returns a helper that runs privileged DDL in the private database,
// after proving its pool is connected there rather than to a shared one.
func adminExec(t *testing.T, isolated privateCouponDatabase) func(*testing.T, string) {
	t.Helper()
	t.Setenv("POSTWAVE_ALLOW_PRIVILEGED_DB_ROLE", "1")
	pool, err := db.New(context.Background(), isolated.adminURL)
	if err != nil {
		t.Fatalf("db.New(admin): %v", err)
	}
	t.Cleanup(pool.Close)
	isolated.requireConnected(t, context.Background(), pool)
	return func(t *testing.T, statement string) {
		t.Helper()
		if _, err := pool.Exec(context.Background(), statement); err != nil {
			t.Fatalf("admin exec %q: %v", statement, err)
		}
	}
}
