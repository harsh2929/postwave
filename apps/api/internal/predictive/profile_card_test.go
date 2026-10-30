// SPDX-License-Identifier: AGPL-3.0-only
//
// profile_card_test.go — SUB-126 (per-subscriber RFM report + profile card).
// The backend for SUB-126 reuses the existing GET /api/v1/predictive/
// profiles/{email} endpoint, which returns a ProfileAnalytics (CLV
// prediction joined with the RFM score). These tests pin the JSON contract
// the per-subscriber RFM profile card depends on, plus the GetProfile
// handler's 404 path for an unknown email.

package predictive

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestProfileAnalytics_RFMCardJSONShape pins the wire shape the SUB-126
// profile card reads: prediction.* CLV/churn fields plus the full RFM
// block (recency/frequency/monetary scores, rfm_score, segment_key,
// confidence). A drift in any json tag here would break the card.
func TestProfileAnalytics_RFMCardJSONShape(t *testing.T) {
	now := time.Date(2026, 6, 15, 0, 0, 0, 0, time.UTC)
	recency := 12
	pa := ProfileAnalytics{
		Prediction: Prediction{
			Email:             "buyer@example.com",
			SubscriberID:      "sub-1",
			HistoricCLVCents:  30000,
			PredictedCLVCents: 12000,
			TotalCLVCents:     42000,
			ChurnRisk:         0.2,
			Confidence:        0.65,
			DataSufficiency:   "sufficient",
			CalculatedAt:      now,
		},
		RFM: RFMScore{
			Email:          "buyer@example.com",
			SubscriberID:   "sub-1",
			RecencyDays:    &recency,
			Frequency:      4,
			MonetaryCents:  30000,
			RecencyScore:   5,
			FrequencyScore: 4,
			MonetaryScore:  4,
			RFMScore:       "544",
			SegmentKey:     "champions",
			CalculatedAt:   now,
		},
	}
	raw, err := json.Marshal(pa)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{
		`"prediction"`, `"rfm"`, `"total_clv_cents":42000`,
		`"churn_risk":0.2`, `"confidence":0.65`, `"segment_key":"champions"`,
		`"rfm_score":"544"`, `"recency_score":5`, `"frequency_score":4`,
		`"monetary_score":4`, `"recency_days":12`,
	} {
		if !strings.Contains(string(raw), key) {
			t.Errorf("ProfileAnalytics JSON missing %s; raw=%s", key, raw)
		}
	}
}

// TestGetProfile_UnknownEmailIs404 exercises the handler error path so the
// per-subscriber card renders an empty/none state (not a 500) when no
// snapshot exists for the subscriber yet. Uses a nil-pool Repo: GetProfile
// hits db.WithTenant first, which fails fast without a connection, so we
// instead assert the no-tenant guard returns 401 (the reachable branch
// without a DB). The 404 mapping itself is covered by writeRepoError unit
// coverage below.
func TestGetProfile_NoTenantIs401(t *testing.T) {
	d := &Deps{Repo: &Repo{}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/predictive/profiles/x@y.com", nil)
	rec := httptest.NewRecorder()
	d.GetProfile(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (no tenant in context)", rec.Code)
	}
}

// TestWriteRepoError_NotFoundMaps404 pins that an ErrNotFound from the
// profile repo surfaces as a 404 (the SUB-126 "no predictive snapshot for
// this subscriber yet" case), not a 500.
func TestWriteRepoError_NotFoundMaps404(t *testing.T) {
	d := &Deps{Repo: &Repo{}}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/predictive/profiles/x@y.com", nil)
	rec := httptest.NewRecorder()
	d.writeRepoError(rec, req, ErrNotFound)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 for ErrNotFound", rec.Code)
	}
}
