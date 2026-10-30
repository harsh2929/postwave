package discounts

import (
	"strings"
	"testing"
	"time"
)

func TestCouponNotRedeemableReason(t *testing.T) {
	now := time.Date(2026, 6, 2, 12, 0, 0, 0, time.UTC)
	past := now.Add(-time.Hour)
	future := now.Add(time.Hour)
	exactlyNow := now

	cases := []struct {
		name                string
		assignmentStatus    string
		codeStatus          string
		assignmentExpiresAt *time.Time
		codeExpiresAt       *time.Time
		want                string
	}{
		{name: "all_clear", assignmentStatus: "issued", codeStatus: "issued", want: ""},
		{name: "code_redeemed_dominates", assignmentStatus: "issued", codeStatus: string(CouponCodeRedeemed), want: "already_redeemed"},
		{name: "assignment_redeemed_dominates", assignmentStatus: string(CouponAssignmentRedeemed), codeStatus: "issued", want: "already_redeemed"},
		{name: "both_redeemed_still_already_redeemed", assignmentStatus: string(CouponAssignmentRedeemed), codeStatus: string(CouponCodeRedeemed), want: "already_redeemed"},
		{name: "code_disabled", assignmentStatus: "issued", codeStatus: string(CouponCodeDisabled), want: "coupon_disabled"},
		{name: "assignment_released", assignmentStatus: string(CouponAssignmentReleased), codeStatus: "issued", want: "coupon_released"},
		{name: "code_expired_by_status", assignmentStatus: "issued", codeStatus: string(CouponCodeExpired), want: "expired"},
		{name: "assignment_expired_by_status", assignmentStatus: string(CouponAssignmentExpired), codeStatus: "issued", want: "expired"},
		{name: "assignment_expired_by_time", assignmentStatus: "issued", codeStatus: "issued", assignmentExpiresAt: &past, want: "expired"},
		{name: "code_expired_by_time", assignmentStatus: "issued", codeStatus: "issued", codeExpiresAt: &past, want: "expired"},
		{name: "future_expiry_is_clear", assignmentStatus: "issued", codeStatus: "issued", assignmentExpiresAt: &future, codeExpiresAt: &future, want: ""},
		{name: "expiry_equal_to_now_counts_as_expired", assignmentStatus: "issued", codeStatus: "issued", assignmentExpiresAt: &exactlyNow, want: "expired"},
		// Priority check: redeemed should still win over expired-by-time.
		{name: "redeemed_beats_expired_time", assignmentStatus: "issued", codeStatus: string(CouponCodeRedeemed), assignmentExpiresAt: &past, codeExpiresAt: &past, want: "already_redeemed"},
		// Priority check: disabled should still win over expired-by-time.
		{name: "disabled_beats_expired_time", assignmentStatus: "issued", codeStatus: string(CouponCodeDisabled), assignmentExpiresAt: &past, want: "coupon_disabled"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := couponNotRedeemableReason(tc.assignmentStatus, tc.codeStatus, tc.assignmentExpiresAt, tc.codeExpiresAt, now)
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCompactStatus(t *testing.T) {
	cases := []struct {
		name             string
		assignmentStatus string
		codeStatus       string
		want             string
	}{
		{name: "both_empty", want: ""},
		{name: "assignment_only", assignmentStatus: "issued", want: "assignment:issued"},
		{name: "code_only", codeStatus: "redeemed", want: "code:redeemed"},
		{name: "both_present_preserves_order", assignmentStatus: "issued", codeStatus: "redeemed", want: "assignment:issued,code:redeemed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := compactStatus(tc.assignmentStatus, tc.codeStatus)
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
			// Sanity: when both are present, the result must contain both halves.
			if tc.assignmentStatus != "" && tc.codeStatus != "" {
				if !strings.Contains(got, "assignment:") || !strings.Contains(got, "code:") {
					t.Fatalf("expected both prefixes in %q", got)
				}
			}
		})
	}
}
