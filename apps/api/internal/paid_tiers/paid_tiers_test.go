package paid_tiers

// Tests for paid_tiers. The Repo methods write to postgres, so we lean
// on the validation branches that fire BEFORE any DB call. Stripe is
// mocked via the StripeBridge interface so we never hit a network.

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// recBridge satisfies StripeBridge by recording calls and never erroring.
// Also captures the Stripe-side Idempotency-Key passed by the Repo so
// tests can assert it is deterministic across retries of the same
// (tenant, subscriber, plan) tuple.
type recBridge struct {
	subCalls    []PaidSubCreateInput
	giftCalls   []GiftSubCreateInput
	subIdemKeys []string
	giftIdemKey []string
	updateCalls []SubscriptionPatch
	subErr      error
	giftErr     error
	updateErr   error
	periodEnd   time.Time
}

func (r *recBridge) CreateSubscription(_ context.Context, _, idemKey string, in PaidSubCreateInput) (string, string, time.Time, error) {
	if r.subErr != nil {
		return "", "", time.Time{}, r.subErr
	}
	r.subCalls = append(r.subCalls, in)
	r.subIdemKeys = append(r.subIdemKeys, idemKey)
	return "sub_test", "cus_test", r.periodEnd, nil
}
func (r *recBridge) CreateGiftInvoice(_ context.Context, _, idemKey string, in GiftSubCreateInput) (string, string, error) {
	if r.giftErr != nil {
		return "", "", r.giftErr
	}
	r.giftCalls = append(r.giftCalls, in)
	r.giftIdemKey = append(r.giftIdemKey, idemKey)
	return "in_test", "https://pay.stripe/test", nil
}
func (r *recBridge) UpdateSubscription(_ context.Context, _, _, _ string, patch SubscriptionPatch) error {
	if r.updateErr != nil {
		return r.updateErr
	}
	r.updateCalls = append(r.updateCalls, patch)
	return nil
}

func TestPaidMutationsFailClosedWithoutStripeBridge(t *testing.T) {
	repo := &Repo{}
	if _, err := repo.CreatePaidSub(context.Background(), "t", PaidSubCreateInput{
		SubscriberEmail: "buyer@example.com",
		PlanID:          "plan",
	}); !errors.Is(err, ErrStripeBridgeUnavailable) {
		t.Fatalf("CreatePaidSub error = %v, want ErrStripeBridgeUnavailable", err)
	}
	if _, err := repo.CreateGift(context.Background(), "t", GiftSubCreateInput{
		PurchaserEmail: "buyer@example.com",
		RecipientEmail: "recipient@example.com",
		PlanID:         "plan",
		DurationMonths: 12,
	}); !errors.Is(err, ErrStripeBridgeUnavailable) {
		t.Fatalf("CreateGift error = %v, want ErrStripeBridgeUnavailable", err)
	}
	if err := repo.SetInterval(context.Background(), "t", "id", IntervalMonth); !errors.Is(err, ErrStripeBridgeUnavailable) {
		t.Fatalf("SetInterval error = %v, want ErrStripeBridgeUnavailable", err)
	}
	if err := repo.MarkFounding(context.Background(), "t", "id", 0); !errors.Is(err, ErrStripeBridgeUnavailable) {
		t.Fatalf("MarkFounding error = %v, want ErrStripeBridgeUnavailable", err)
	}
}

// TestDerivePaidSubIdempotencyKey asserts the Stripe-side idempotency
// key is stable across retries of the same input — a non-stable key
// would defeat outbound dedup at Stripe (audit finding C1).
func TestDerivePaidSubIdempotencyKey_Stable(t *testing.T) {
	in := PaidSubCreateInput{
		SubscriberEmail: "Alice@Example.com",
		PlanID:          "pro_yearly",
		Interval:        IntervalYear,
		TrialDays:       14,
	}
	k1 := derivePaidSubIdempotencyKey("tenant-1", in)
	k2 := derivePaidSubIdempotencyKey("tenant-1", in)
	if k1 != k2 {
		t.Errorf("not deterministic: %q vs %q", k1, k2)
	}
	// Case-insensitive on the email — "alice@..." and "Alice@..." must
	// produce the same key so a client retry that re-cases the email
	// doesn't mint a second Stripe subscription.
	in2 := in
	in2.SubscriberEmail = "alice@example.com"
	if derivePaidSubIdempotencyKey("tenant-1", in2) != k1 {
		t.Error("email case sensitivity broke idempotency key stability")
	}
	// Different tenant → different key (no cross-tenant collision).
	if derivePaidSubIdempotencyKey("tenant-2", in) == k1 {
		t.Error("idempotency key collides across tenants")
	}
}

// TestCreatePaidSub_RejectsMissingFields — empty email or plan_id
// must surface a validation error before hitting the bridge. We use
// a recording bridge that would record every call to prove it isn't
// touched.
func TestCreatePaidSub_RejectsMissingFields(t *testing.T) {
	bridge := &recBridge{}
	repo := &Repo{Pool: nil, Bridge: bridge}
	_, err := repo.CreatePaidSub(context.Background(), "t",
		PaidSubCreateInput{SubscriberEmail: "", PlanID: "p"})
	if err == nil {
		t.Fatal("expected validation error for missing email")
	}
	if len(bridge.subCalls) != 0 {
		t.Errorf("bridge was called %d times before validation; expected 0", len(bridge.subCalls))
	}

	_, err = repo.CreatePaidSub(context.Background(), "t",
		PaidSubCreateInput{SubscriberEmail: "x@y.co", PlanID: ""})
	if err == nil {
		t.Fatal("expected validation error for missing plan_id")
	}
}

// TestCreatePaidSub_RejectsBadInterval — only month|year accepted.
func TestCreatePaidSub_RejectsBadInterval(t *testing.T) {
	repo := &Repo{Pool: nil, Bridge: &recBridge{}}
	_, err := repo.CreatePaidSub(context.Background(), "t",
		PaidSubCreateInput{SubscriberEmail: "x@y.co", PlanID: "p", Interval: "weekly"})
	if err == nil || !strings.Contains(err.Error(), "interval") {
		t.Errorf("got %v, want interval error", err)
	}
}

// TestCreatePaidSub_RejectsNegativeExtra — extra_amount_cents must
// be >= 0.
func TestCreatePaidSub_RejectsNegativeExtra(t *testing.T) {
	repo := &Repo{Pool: nil, Bridge: &recBridge{}}
	_, err := repo.CreatePaidSub(context.Background(), "t",
		PaidSubCreateInput{SubscriberEmail: "x@y.co", PlanID: "p", ExtraAmountCents: -1})
	if err == nil || !strings.Contains(err.Error(), "extra_amount_cents") {
		t.Errorf("got %v, want extra_amount_cents error", err)
	}
}

// TestCreatePaidSub_BridgeErrorPropagates — a bridge failure aborts
// before any DB write.
func TestCreatePaidSub_BridgeErrorPropagates(t *testing.T) {
	bridge := &recBridge{subErr: errors.New("stripe boom")}
	repo := &Repo{Pool: nil, Bridge: bridge}
	_, err := repo.CreatePaidSub(context.Background(), "t",
		PaidSubCreateInput{SubscriberEmail: "x@y.co", PlanID: "p"})
	if err == nil || !strings.Contains(err.Error(), "stripe bridge") {
		t.Errorf("got %v, want bridge error", err)
	}
}

// TestCreateGift_RejectsMissingFields — purchaser/recipient/plan
// required.
func TestCreateGift_RejectsMissingFields(t *testing.T) {
	repo := &Repo{Pool: nil, Bridge: &recBridge{}}
	cases := []GiftSubCreateInput{
		{RecipientEmail: "r@x", PlanID: "p", DurationMonths: 1},
		{PurchaserEmail: "p@x", PlanID: "p", DurationMonths: 1},
		{PurchaserEmail: "p@x", RecipientEmail: "r@x", DurationMonths: 1},
	}
	for _, in := range cases {
		if _, err := repo.CreateGift(context.Background(), "t", in); err == nil {
			t.Errorf("input %+v should error", in)
		}
	}
}

// TestCreateGift_RejectsBadDuration — must be in [1,60].
func TestCreateGift_RejectsBadDuration(t *testing.T) {
	repo := &Repo{Pool: nil, Bridge: &recBridge{}}
	for _, dm := range []int{0, -1, 61, 1000} {
		_, err := repo.CreateGift(context.Background(), "t",
			GiftSubCreateInput{PurchaserEmail: "p@x", RecipientEmail: "r@x",
				PlanID: "p", DurationMonths: dm})
		if err == nil || !strings.Contains(err.Error(), "duration_months") {
			t.Errorf("dm=%d got %v, want duration_months error", dm, err)
		}
	}
}

// TestSetInterval_RejectsBadInterval — value must be month|year.
func TestSetInterval_RejectsBadInterval(t *testing.T) {
	repo := &Repo{Pool: nil}
	if err := repo.SetInterval(context.Background(), "t", "id", "weekly"); err == nil {
		t.Error("expected error for bad interval")
	}
}

// TestMarkFounding_RejectsNegative — extra_amount_cents must be >= 0.
func TestMarkFounding_RejectsNegative(t *testing.T) {
	repo := &Repo{Pool: nil}
	if err := repo.MarkFounding(context.Background(), "t", "id", -10); err == nil {
		t.Error("expected error for negative extra")
	}
}

// TestCreatePaidSub_HandlerRequiresTenant exercises the handler.
func TestCreatePaidSub_HandlerRequiresTenant(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil, Bridge: &recBridge{}}}
	r := httptest.NewRequest("POST", "/api/v1/paid-subs",
		strings.NewReader(`{"subscriber_email":"x@y.co","plan_id":"p"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	d.CreatePaidSub(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", w.Code)
	}
}

func TestCreateGift_HandlerRejectsBadJSON(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil, Bridge: &recBridge{}}}
	r := httptest.NewRequest("POST", "/api/v1/gift-subscriptions", strings.NewReader("xx"))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.CreateGift(w, r)
	if w.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", w.Code)
	}
}

func TestCreatePaidSub_HandlerRejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil, Bridge: &recBridge{}}}
	body := `{"subscriber_email":"` + strings.Repeat("a", int(paidTierJSONMaxBodyBytes)+1) + `"}`
	r := httptest.NewRequest("POST", "/api/v1/paid-subs", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.CreatePaidSub(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413", w.Code)
	}
}

func TestMarkFounding_HandlerRejectsOversizedBody(t *testing.T) {
	d := &Deps{Repo: &Repo{Pool: nil, Bridge: &recBridge{}}}
	body := `{"extra_amount_cents":1,"notes":"` + strings.Repeat("a", int(paidTierJSONMaxBodyBytes)+1) + `"}`
	r := httptest.NewRequest("POST", "/api/v1/paid-subs/ps1/founding", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r = r.WithContext(middleware.WithTenant(r.Context(), &middleware.Tenant{ID: "t1"}))
	w := httptest.NewRecorder()
	d.MarkFounding(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want 413", w.Code)
	}
}
