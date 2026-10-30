package onsite_growth

import (
	"strings"
	"testing"
)

func TestValidateExperimentCapsVariantsAndWeights(t *testing.T) {
	variants := make([]Variant, 0, 8)
	for i := 0; i < 8; i++ {
		variants = append(variants, Variant{
			Key:                      "variant-" + string(rune('a'+i)),
			Name:                     "Variant",
			Status:                   "active",
			TrafficWeightBasisPoints: 1000,
		})
	}
	out := Validate(ValidationRequest{Experiment: &Experiment{
		Key:            "welcome",
		Name:           "Welcome",
		Status:         "running",
		AllocationMode: "adaptive",
		WinnerMetric:   "confirmed_submissions",
		Variants:       variants,
	}})
	if out.Valid {
		t.Fatal("expected validation failure")
	}
	joined := strings.Join(out.Errors, "\n")
	if !strings.Contains(joined, "at most seven variants") {
		t.Fatalf("errors = %v, want seven variant cap", out.Errors)
	}
	if !strings.Contains(joined, "weights must total 10000") {
		t.Fatalf("errors = %v, want weight total validation", out.Errors)
	}
	if len(out.Warnings) == 0 {
		t.Fatal("expected adaptive/control warnings")
	}
}

func TestValidateRunningExperimentWithSevenVariants(t *testing.T) {
	variants := []Variant{
		{Key: "a", Name: "A", Status: "active", TrafficWeightBasisPoints: 2000, IsControl: true},
		{Key: "b", Name: "B", Status: "active", TrafficWeightBasisPoints: 1500},
		{Key: "c", Name: "C", Status: "active", TrafficWeightBasisPoints: 1500},
		{Key: "d", Name: "D", Status: "active", TrafficWeightBasisPoints: 1500},
		{Key: "e", Name: "E", Status: "active", TrafficWeightBasisPoints: 1500},
		{Key: "f", Name: "F", Status: "active", TrafficWeightBasisPoints: 1000},
		{Key: "g", Name: "G", Status: "active", TrafficWeightBasisPoints: 1000},
	}
	out := Validate(ValidationRequest{Experiment: &Experiment{
		Key:            "offer",
		Name:           "Offer",
		Status:         "running",
		AllocationMode: "manual",
		WinnerMetric:   "conversion_rate",
		Variants:       variants,
	}})
	if !out.Valid {
		t.Fatalf("Validate() errors = %v", out.Errors)
	}
}

func TestValidateSpinRewardsRequiresCouponPoolAndFullWheel(t *testing.T) {
	out := Validate(ValidationRequest{SpinRewards: []SpinReward{
		{Key: "ten", Label: "10%", RewardType: "coupon_pool", WeightBasisPoints: 5000},
		{Key: "try-again", Label: "Try again", RewardType: "none", WeightBasisPoints: 4000},
	}})
	if out.Valid {
		t.Fatal("expected validation failure")
	}
	joined := strings.Join(out.Errors, "\n")
	if !strings.Contains(joined, "coupon_pool_id is required") {
		t.Fatalf("errors = %v, want coupon_pool_id requirement", out.Errors)
	}
	if !strings.Contains(joined, "weights must total 10000") {
		t.Fatalf("errors = %v, want full wheel validation", out.Errors)
	}
}

func TestSelectSpinRewardUsesBasisPointWeights(t *testing.T) {
	rewards := []SpinReward{
		{Key: "small", Label: "Small", Status: "active", WeightBasisPoints: 2500},
		{Key: "medium", Label: "Medium", Status: "active", WeightBasisPoints: 2500},
		{Key: "large", Label: "Large", Status: "active", WeightBasisPoints: 5000},
	}
	cases := map[int]string{
		0:    "small",
		2499: "small",
		2500: "medium",
		4999: "medium",
		5000: "large",
		9999: "large",
	}
	for entropy, want := range cases {
		got, err := SelectSpinReward(rewards, entropy)
		if err != nil {
			t.Fatalf("SelectSpinReward(%d): %v", entropy, err)
		}
		if got.Key != want {
			t.Fatalf("SelectSpinReward(%d) = %q, want %q", entropy, got.Key, want)
		}
	}
}

func TestCatalogIncludesKlaviyoParityControls(t *testing.T) {
	catalog := Catalog()
	if catalog.SchemaVersion == "" {
		t.Fatal("missing schema version")
	}
	if !catalogHas(catalog.TriggerTypes, "exit_intent") {
		t.Fatal("catalog missing exit_intent trigger")
	}
	if !catalogHas(catalog.ExperimentModes, "adaptive") {
		t.Fatal("catalog missing adaptive experiment mode")
	}
	if !catalogHas(catalog.SpinRewardTypes, "coupon_pool") {
		t.Fatal("catalog missing coupon_pool reward")
	}
	for _, key := range []string{"static_coupon", "coupon_pool"} {
		if got := catalogStatus(catalog.SpinRewardTypes, key); got != "unavailable" {
			t.Fatalf("%s runtime status = %q, want unavailable", key, got)
		}
	}
	if CouponRewardDeliveryAvailable {
		t.Fatal("coupon-bearing spin rewards must remain release-contained")
	}
	if !spinRewardRequiresCouponDelivery(&SpinReward{RewardType: "static_coupon", StaticCode: "LIVE20"}) {
		t.Fatal("static coupon must require disabled coupon delivery")
	}
	if !spinRewardRequiresCouponDelivery(&SpinReward{RewardType: "coupon_pool", CouponPoolID: "pool-1"}) {
		t.Fatal("coupon pool reward must require disabled coupon delivery")
	}
	redacted := redactUnavailableCouponRewards([]SpinReward{{
		RewardType: "static_coupon",
		StaticCode: "LIVE-COUPON-SECRET",
	}})
	if len(redacted) != 1 || redacted[0].StaticCode != "" {
		t.Fatalf("redacted rewards = %#v, want no static code", redacted)
	}
}

func catalogHas(items []CatalogItem, key string) bool {
	for _, item := range items {
		if item.Key == key {
			return true
		}
	}
	return false
}

func catalogStatus(items []CatalogItem, key string) string {
	for _, item := range items {
		if item.Key == key {
			return item.RuntimeStatus
		}
	}
	return ""
}
