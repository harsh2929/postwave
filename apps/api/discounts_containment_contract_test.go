package main

import (
	"strings"
	"testing"
)

func TestDiscountCouponAllocationCompositionIsGated(t *testing.T) {
	root := readAPICompositionRoot(t)

	if got := strings.Count(root.main, "if discounts.CouponAllocationAvailable {"); got < 5 {
		t.Fatalf("coupon availability gates = %d, want at least 5 composition guards", got)
	}
	for _, forbidden := range []string{
		"CouponAssigner: onsiteCouponAssigner{",
		"CouponResolver:    discountCouponResolver{",
		"outboxRegistry.Register(discounts.AutomationCouponKind, automationCouponHandler.Handle)\n\t// Startup",
	} {
		if strings.Contains(root.all, forbidden) {
			t.Fatalf("found ungated coupon allocation composition: %q", forbidden)
		}
	}
}
