package runtime

import (
	"testing"

	"github.com/postwave/postwave/services/automation/internal/canonical"
)

// Once predictions are hydrated onto custom fields (hydratePredictionFields),
// the existing custom.<name> condition machinery drives Klaviyo-style predictive
// flows: "churn_risk > 0.8 -> win-back", "high CLV -> VIP", "RFM champions -> ...".
func TestEvaluatePredictiveConditions(t *testing.T) {
	scored := canonical.Subscriber{
		Email: "vip@x.com",
		CustomFields: map[string]interface{}{
			"predicted_churn_risk": float64(0.85),
			"predicted_clv_cents":  124000,
			"rfm_segment":          "champions",
		},
	}
	unscored := canonical.Subscriber{Email: "new@x.com", CustomFields: map[string]interface{}{}}

	cases := []struct {
		name string
		sub  canonical.Subscriber
		cond canonical.SegmentCondition
		want bool
	}{
		{"high churn triggers", scored, canonical.SegmentCondition{Field: "custom.predicted_churn_risk", Comparator: "gt", Value: float64(0.8)}, true},
		{"churn below threshold", scored, canonical.SegmentCondition{Field: "custom.predicted_churn_risk", Comparator: "gt", Value: float64(0.9)}, false},
		{"high-value CLV", scored, canonical.SegmentCondition{Field: "custom.predicted_clv_cents", Comparator: "gte", Value: float64(100000)}, true},
		{"RFM champions match", scored, canonical.SegmentCondition{Field: "custom.rfm_segment", Comparator: "eq", Value: "champions"}, true},
		// A subscriber with no prediction yet takes the false leg (documented).
		{"unscored -> false", unscored, canonical.SegmentCondition{Field: "custom.predicted_churn_risk", Comparator: "gt", Value: float64(0.5)}, false},
		{"unscored exists false", unscored, canonical.SegmentCondition{Field: "custom.predicted_churn_risk", Comparator: "exists"}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Evaluate(c.cond, c.sub); got != c.want {
				t.Fatalf("Evaluate(%+v) = %v, want %v", c.cond, got, c.want)
			}
		})
	}
}
