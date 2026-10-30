// predictive.go — GAP-LS-075: predictive predicates (CLV / churn
// risk / EDNO / RFM bucket).
//
// The actual heuristic engine lives in apps/api/internal/predictive
// and writes to profile_predictions + profile_rfm_scores. The base
// compiler in compile.go already routes predictive.* and rfm.*
// fields to those tables — see predictiveField / rfmField. This
// file is a thin convenience layer that exposes the canonical
// field keys + their comparator catalog so the registry response
// and the AI suggester can ask "what predictive predicates are
// available?" without re-implementing the schema.

package predicates

// PredictiveFieldKey is one of the canonical predictive predicate
// keys.
type PredictiveFieldKey string

const (
	PredictivePredictedCLV        PredictiveFieldKey = "predictive.predicted_clv_cents"
	PredictiveTotalCLV            PredictiveFieldKey = "predictive.total_clv_cents"
	PredictiveHistoricCLV         PredictiveFieldKey = "predictive.historic_clv_cents"
	PredictiveChurnRisk           PredictiveFieldKey = "predictive.churn_risk"
	PredictivePredictedOrderCount PredictiveFieldKey = "predictive.predicted_order_count"
	PredictiveAverageDaysBetween  PredictiveFieldKey = "predictive.average_days_between_orders"
	PredictiveDataSufficiency     PredictiveFieldKey = "predictive.data_sufficiency"
	RFMSegmentKey                 PredictiveFieldKey = "rfm.segment_key"
	RFMRecencyScore               PredictiveFieldKey = "rfm.recency_score"
	RFMFrequencyScore             PredictiveFieldKey = "rfm.frequency_score"
	RFMMonetaryScore              PredictiveFieldKey = "rfm.monetary_score"
)

// All returns every canonical predictive predicate key. The
// registry assembler iterates this to surface the predicate
// catalog response.
func All() []PredictiveFieldKey {
	return []PredictiveFieldKey{
		PredictivePredictedCLV,
		PredictiveTotalCLV,
		PredictiveHistoricCLV,
		PredictiveChurnRisk,
		PredictivePredictedOrderCount,
		PredictiveAverageDaysBetween,
		PredictiveDataSufficiency,
		RFMSegmentKey,
		RFMRecencyScore,
		RFMFrequencyScore,
		RFMMonetaryScore,
	}
}
