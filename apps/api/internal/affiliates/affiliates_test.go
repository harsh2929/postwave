package affiliates

import (
	"testing"
)

// TestCommissionFor_LTD verifies the flat $50 LTD commission across the
// real launch prices (Studio LTD $349, AppSumo $249, hypothetical $499).
func TestCommissionFor_LTD(t *testing.T) {
	cases := []struct {
		name        string
		amountCents int64
		wantComm    int64
	}{
		{"studio_full_price_34900", 34900, 5000},
		{"appsumo_24900", 24900, 5000},
		{"premium_49900", 49900, 5000},
		{"tiny_5000_still_50", 5000, 5000},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rate, comm := CommissionFor(KindLTDPurchase, c.amountCents)
			if comm != c.wantComm {
				t.Errorf("CommissionFor(LTD, %d) commission = %d, want %d",
					c.amountCents, comm, c.wantComm)
			}
			// Effective rate = commission / amount * 100.
			wantRate := float64(c.wantComm) * 100 / float64(c.amountCents)
			if !floatNear(rate, wantRate, 0.01) {
				t.Errorf("rate = %v, want ~%v", rate, wantRate)
			}
		})
	}
}

// TestCommissionFor_Sending verifies 30% on the Sending tier across the
// real launch price ($29/mo) and overage-bumped invoices.
func TestCommissionFor_Sending(t *testing.T) {
	cases := []struct {
		amountCents int64
		want        int64
	}{
		{2900, 870},   // $29 → $8.70
		{5800, 1740},  // $58 (mid-month upgrade)
		{10000, 3000}, // $100 invoice
		{1, 0},        // floor — 30% of 1 cent = 0
	}
	for _, c := range cases {
		rate, comm := CommissionFor(KindSendingSubscription, c.amountCents)
		if comm != c.want {
			t.Errorf("CommissionFor(Sending, %d) = %d, want %d", c.amountCents, comm, c.want)
		}
		if rate != SendingRatePct {
			t.Errorf("rate = %v, want %v", rate, SendingRatePct)
		}
	}
}

// TestCommissionFor_Pro verifies 25% on the Pro tier ($79/mo).
func TestCommissionFor_Pro(t *testing.T) {
	cases := []struct {
		amountCents int64
		want        int64
	}{
		{7900, 1975},  // $79 → $19.75
		{15800, 3950}, // $158 invoice (overage)
		{100000, 25000},
	}
	for _, c := range cases {
		_, comm := CommissionFor(KindProSubscription, c.amountCents)
		if comm != c.want {
			t.Errorf("CommissionFor(Pro, %d) = %d, want %d", c.amountCents, comm, c.want)
		}
	}
}

// TestCommissionFor_Edge covers zero, negative, and unknown kinds.
func TestCommissionFor_Edge(t *testing.T) {
	if _, c := CommissionFor(KindLTDPurchase, 0); c != 0 {
		t.Errorf("zero amount → commission %d, want 0", c)
	}
	if _, c := CommissionFor(KindSendingSubscription, -100); c != 0 {
		t.Errorf("negative amount → commission %d, want 0", c)
	}
	if _, c := CommissionFor(Kind("unknown"), 10000); c != 0 {
		t.Errorf("unknown kind → commission %d, want 0", c)
	}
}

// TestCommissionFor_Year1Sanity validates the headline pitch:
// "100 customers refer Sending tier in year 1" → $10,440 commission.
func TestCommissionFor_Year1Sanity(t *testing.T) {
	const customers = 100
	const months = 12
	const monthlyCents int64 = 2900
	var total int64
	for i := 0; i < customers; i++ {
		_, c := CommissionFor(KindSendingSubscription, monthlyCents)
		total += c * months
	}
	want := int64(100 * 870 * 12) // $10,440 = 1,044,000 cents
	if total != want {
		t.Errorf("year-1 total = %d cents, want %d cents", total, want)
	}
	if total != 1044000 {
		t.Errorf("expected $10,440 in cents = 1,044,000, got %d", total)
	}
}

func floatNear(a, b, eps float64) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d <= eps
}

func TestSlugify(t *testing.T) {
	cases := map[string]string{
		"Jane Doe":       "jane-doe",
		"  Acme   Co!  ": "acme-co",
		"O'Brien & Sons": "obrien-sons",
		"héllo":          "h-llo",
		"":               "",
	}
	for in, want := range cases {
		if got := slugify(in); got != want {
			t.Errorf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestKindFromLookupKey(t *testing.T) {
	cases := []struct {
		key  string
		want Kind
		ok   bool
	}{
		{"studio_ltd", KindLTDPurchase, true},
		{"sending_monthly", KindSendingSubscription, true},
		{"pro_sending_monthly", KindProSubscription, true},
		{"random_unknown", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		got, ok := kindFromLookupKey(c.key)
		if ok != c.ok || got != c.want {
			t.Errorf("kindFromLookupKey(%q) = (%q, %v), want (%q, %v)",
				c.key, got, ok, c.want, c.ok)
		}
	}
}
