// SPDX-License-Identifier: AGPL-3.0-only
//
// clv_bgnbd_fallback_test.go — why the BG/NBD fit was not used reaches every
// caller: FitTenantBGNBD's result, PredictBatchBGNBD's caller,
// RunPredictionBatch's summary, a recompute run's metrics and its log. Each
// fallback must keep ComputePrediction's heuristic untouched, so recording
// the reason changes nothing about which prediction a customer gets.
// recompute_bgnbd_db_test.go runs the same record through Repo.Recompute
// against a real database.
package predictive

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/apps/api/internal/predictive_clv"
)

// singleOrderSignals builds n scorable customers who each placed exactly one
// order, so the base has no repeat purchase at all.
func singleOrderSignals(n int) []ProfileSignals {
	out := make([]ProfileSignals, 0, n)
	for i := 0; i < n; i++ {
		first := weeksAgo(float64(5 + i%40))
		out = append(out, ProfileSignals{
			Email:            fmt.Sprintf("single-%d@example.test", i),
			OrderCount:       1,
			FirstOrderAt:     first,
			LastOrderAt:      first,
			HistoricCLVCents: 4000,
		})
	}
	return out
}

// unscorableSignals builds n customers SignalToSummary cannot score: no
// orders, no first-order time, or a first order after bgnbdNow.
func unscorableSignals(n int) []ProfileSignals {
	future := bgnbdNow.Add(time.Hour)
	out := make([]ProfileSignals, 0, n)
	for i := 0; i < n; i++ {
		s := ProfileSignals{Email: fmt.Sprintf("unscorable-%d@example.test", i)}
		switch i % 3 {
		case 0: // a subscriber who never ordered
		case 1:
			s.OrderCount = 2 // orders without a first-order time
		default:
			s.OrderCount, s.FirstOrderAt, s.LastOrderAt = 1, &future, &future
		}
		out = append(out, s)
	}
	return out
}

// fallbackCase is one way FitTenantBGNBD keeps the heuristic, produced by the
// real bridge and the real fitter. opts reach FitBGNBD, which is how a test
// drives the fitter into its outcome rejections.
type fallbackCase struct {
	name      string
	signals   []ProfileSignals
	opts      predictive_clv.FitOptions
	reason    string
	customers int
	// dataCannotSupportFit is true when the tenant's data cannot support a
	// fit at all, an ordinary state logged at debug level; false when the
	// fit broke down, logged as a warning.
	dataCannotSupportFit bool
	// mention is a fragment the error must carry.
	mention string
}

func fallbackCases() []fallbackCase {
	tinyAlpha := predictive_clv.Params{R: 0.5, Alpha: 1e-300, A: 1, B: 1}
	hugeR := predictive_clv.Params{R: 1e308, Alpha: 1, A: 1, B: 1}
	return []fallbackCase{
		{
			name:    "too few customers",
			signals: makeSignals(MinCustomersForBGNBD - 1), reason: BGNBDFallbackTooFewCustomers,
			customers: MinCustomersForBGNBD - 1, dataCannotSupportFit: true,
			mention: fmt.Sprintf("%d scorable customers, %d needed", MinCustomersForBGNBD-1, MinCustomersForBGNBD),
		},
		{
			// 65 signals, but only the 45 scorable ones count toward the
			// threshold and the reported size.
			name:    "too few scorable customers",
			signals: append(makeSignals(45), unscorableSignals(20)...), reason: BGNBDFallbackTooFewCustomers,
			customers: 45, dataCannotSupportFit: true,
			mention: fmt.Sprintf("45 scorable customers, %d needed", MinCustomersForBGNBD),
		},
		{
			name:    "no repeat purchases",
			signals: singleOrderSignals(60), reason: string(predictive_clv.RejectNoRepeatTransactions),
			customers: 60, dataCannotSupportFit: true, mention: "none of the 60 summaries",
		},
		{
			name:    "search stopped while climbing",
			signals: makeSignals(120), opts: predictive_clv.FitOptions{MaxIterations: 5},
			reason: string(predictive_clv.RejectNotConverged), customers: 120, mention: "all 5 iterations",
		},
		{
			name:    "parameters beyond float64 resolution",
			signals: makeSignals(120), opts: predictive_clv.FitOptions{Seed: &tinyAlpha, MaxIterations: 1},
			reason: string(predictive_clv.RejectParamsOutOfRange), customers: 120, mention: "ln(alpha/tau)",
		},
		{
			name:    "likelihood never finite",
			signals: makeSignals(120), opts: predictive_clv.FitOptions{Seed: &hugeR},
			reason: string(predictive_clv.RejectNonFiniteLikelihood), customers: 120, mention: "at the fitted params",
		},
	}
}

// requireFallback fails the test unless fit is tc's fallback: not fitted, no
// parameters, tc's size, reason and class, and an error that says why.
func requireFallback(t *testing.T, tc fallbackCase, fit BGNBDFit) {
	t.Helper()
	if fit.Fitted() || fit.Err == nil {
		t.Fatalf("fit = %+v, want a fallback with reason %q", fit, tc.reason)
	}
	if got := fit.FallbackReason(); got != tc.reason {
		t.Errorf("FallbackReason() = %q, want %q (err: %v)", got, tc.reason, fit.Err)
	}
	if fit.Params != (predictive_clv.Params{}) {
		t.Errorf("a fallback carries params %+v; a rejected fit's params must not reach a forecast", fit.Params)
	}
	if fit.Customers != tc.customers {
		t.Errorf("Customers = %d, want %d", fit.Customers, tc.customers)
	}
	if got := fit.dataCannotSupportFit(); got != tc.dataCannotSupportFit {
		t.Errorf("dataCannotSupportFit() = %v, want %v", got, tc.dataCannotSupportFit)
	}
	if !strings.Contains(fit.Err.Error(), tc.mention) {
		t.Errorf("error %q does not mention %q", fit.Err, tc.mention)
	}
}

// TestFitTenantBGNBD_ReportsWhyTheModelWasNotFitted drives the real bridge
// and fitter into each fallback it can reach. A base too small to fit wraps
// ErrTooFewCustomersForBGNBD. Every other fallback is FitBGNBD's own
// rejection, passed through unchanged: the same reason and the same detail
// FitBGNBD gives for the summaries the bridge built.
func TestFitTenantBGNBD_ReportsWhyTheModelWasNotFitted(t *testing.T) {
	for _, tc := range fallbackCases() {
		t.Run(tc.name, func(t *testing.T) {
			fit := fitTenantBGNBD(tc.signals, bgnbdNow, tc.opts)
			requireFallback(t, tc, fit)

			if tc.reason == BGNBDFallbackTooFewCustomers {
				if !errors.Is(fit.Err, ErrTooFewCustomersForBGNBD) || errors.Is(fit.Err, predictive_clv.ErrFitRejected) {
					t.Errorf("error %v, want one wrapping ErrTooFewCustomersForBGNBD and not a fit rejection", fit.Err)
				}
				return
			}
			if errors.Is(fit.Err, ErrTooFewCustomersForBGNBD) {
				t.Errorf("error %v wraps ErrTooFewCustomersForBGNBD for a base of %d", fit.Err, fit.Customers)
			}
			var got *predictive_clv.FitError
			if !errors.As(fit.Err, &got) || !errors.Is(fit.Err, predictive_clv.ErrFitRejected) {
				t.Fatalf("error %v, want FitBGNBD's *FitError", fit.Err)
			}
			summaries := make([]predictive_clv.CustomerSummary, 0, len(tc.signals))
			for _, s := range tc.signals {
				if sum, ok := SignalToSummary(s, bgnbdNow); ok {
					summaries = append(summaries, sum)
				}
			}
			_, direct := predictive_clv.FitBGNBD(summaries, tc.opts)
			var want *predictive_clv.FitError
			if !errors.As(direct, &want) {
				t.Fatalf("precondition: FitBGNBD accepted the summaries the bridge rejected: %v", direct)
			}
			if *got != *want {
				t.Errorf("the bridge reported %+v, want FitBGNBD's rejection %+v", *got, *want)
			}
		})
	}
}

// TestPredictBatchBGNBD_ReturnsWhyTheModelWasNotFitted: the reason reaches
// PredictBatchBGNBD's caller, and every customer keeps exactly the
// heuristic prediction, so recording it changes no prediction.
func TestPredictBatchBGNBD_ReturnsWhyTheModelWasNotFitted(t *testing.T) {
	for _, tc := range fallbackCases() {
		t.Run(tc.name, func(t *testing.T) {
			var preds []Prediction
			var fit BGNBDFit
			if tc.opts == (predictive_clv.FitOptions{}) {
				preds, fit = PredictBatchBGNBD(tc.signals, bgnbdNow)
			} else {
				preds, fit = predictBatchBGNBD(tc.signals, bgnbdNow, tc.opts)
			}
			requireFallback(t, tc, fit)
			if want := fitTenantBGNBD(tc.signals, bgnbdNow, tc.opts); fit.Err.Error() != want.Err.Error() {
				t.Errorf("PredictBatchBGNBD reported %q, want FitTenantBGNBD's %q", fit.Err, want.Err)
			}
			if len(preds) != len(tc.signals) {
				t.Fatalf("got %d predictions, want %d", len(preds), len(tc.signals))
			}
			for i, s := range tc.signals {
				if want := ComputePrediction(s, bgnbdNow); !reflect.DeepEqual(preds[i], want) {
					t.Fatalf("prediction %d = %+v, want the heuristic's %+v", i, preds[i], want)
				}
			}
		})
	}
}

// RunPredictionBatch reports each processed tenant that kept the heuristic,
// with its reason. A tenant the model fitted, and a tenant that failed before
// scoring, are not in the map.
func TestRunPredictionBatch_RecordsEachTenantsFallbackReason(t *testing.T) {
	src := fakeSignalSource{
		byTenant: map[string][]ProfileSignals{
			"fitted":    makeSignals(120),
			"small":     makeSignals(3),
			"no-repeat": singleOrderSignals(60),
		},
		errOn: "fetch-fails",
	}
	sink := &fakeSink{}
	res, err := RunPredictionBatch(context.Background(), []string{"fitted", "small", "no-repeat", "fetch-fails"}, src, sink, bgnbdNow)
	if err == nil || res.TenantsProcessed != 3 || res.TenantsFailed != 1 {
		t.Fatalf("result = %+v, err = %v; want 3 processed, 1 failed", res, err)
	}
	want := map[string]string{
		"small":     BGNBDFallbackTooFewCustomers,
		"no-repeat": string(predictive_clv.RejectNoRepeatTransactions),
	}
	if !reflect.DeepEqual(res.BGNBDFallbacks, want) {
		t.Errorf("BGNBDFallbacks = %v, want %v", res.BGNBDFallbacks, want)
	}
	if got := sink.got["fitted"][1].Explanation["model"]; got != clvModelBGNBD {
		t.Errorf("the fitted tenant's repeat customer is scored by %v, want %s", got, clvModelBGNBD)
	}
}

// FallbackReason names every FitBGNBD rejection by its FitRejectReason, found
// through any wrapping, including the ones the bridge cannot produce because
// SignalToSummary only builds valid summaries with a positive recency behind
// every repeat purchase. Only too few customers and no repeat purchases are
// ordinary states of a tenant's data.
func TestBGNBDFit_FallbackReasonNamesEveryRejection(t *testing.T) {
	ordinary := map[predictive_clv.FitRejectReason]bool{predictive_clv.RejectNoRepeatTransactions: true}
	seen := map[string]bool{BGNBDFallbackTooFewCustomers: true}
	for _, reason := range []predictive_clv.FitRejectReason{
		predictive_clv.RejectInvalidInput,
		predictive_clv.RejectUnboundedLikelihood,
		predictive_clv.RejectNoRepeatTransactions,
		predictive_clv.RejectNonFiniteLikelihood,
		predictive_clv.RejectParamsOutOfRange,
		predictive_clv.RejectImpossibleLikelihood,
		predictive_clv.RejectNotConverged,
	} {
		if reason == "" || seen[string(reason)] {
			t.Fatalf("reason %q is empty or collides with another label", reason)
		}
		seen[string(reason)] = true
		fitErr := &predictive_clv.FitError{Reason: reason, Detail: "detail"}
		for _, err := range []error{fitErr, fmt.Errorf("recompute: %w", fitErr)} {
			fit := BGNBDFit{Customers: 70, Err: err}
			if got := fit.FallbackReason(); got != string(reason) {
				t.Errorf("FallbackReason() for %v = %q, want %q", err, got, reason)
			}
			if got := fit.dataCannotSupportFit(); got != ordinary[reason] {
				t.Errorf("dataCannotSupportFit() for %q = %v, want %v", reason, got, ordinary[reason])
			}
		}
	}

	for _, tc := range []struct {
		fit      BGNBDFit
		reason   string
		ordinary bool
	}{
		{BGNBDFit{}, "", false},
		{BGNBDFit{Err: fmt.Errorf("recompute: %w", ErrTooFewCustomersForBGNBD)}, BGNBDFallbackTooFewCustomers, true},
		// An error that is neither, which FitTenantBGNBD never produces, still
		// names a fallback, and one an operator should look into.
		{BGNBDFit{Err: errors.New("boom")}, bgnbdFallbackUnclassified, false},
	} {
		if got := tc.fit.FallbackReason(); got != tc.reason {
			t.Errorf("FallbackReason() for %v = %q, want %q", tc.fit.Err, got, tc.reason)
		}
		if got := tc.fit.dataCannotSupportFit(); got != tc.ordinary {
			t.Errorf("dataCannotSupportFit() for %v = %v, want %v", tc.fit.Err, got, tc.ordinary)
		}
	}
}

// A recompute run's metrics name the model its CLV forecasts came from, how
// many customers the fit saw and, when the heuristic was kept, why.
func TestBGNBDRunMetrics_RecordTheModelAndTheReason(t *testing.T) {
	fitted := FitTenantBGNBD(makeSignals(120), bgnbdNow)
	if !fitted.Fitted() {
		t.Fatalf("precondition: 120 customers fit: %v", fitted.Err)
	}
	if got, want := bgnbdRunMetrics(fitted), map[string]any{"clv_model": clvModelBGNBD, "bgnbd_customers": 120}; !reflect.DeepEqual(got, want) {
		t.Errorf("fitted run metrics = %v, want %v", got, want)
	}
	for _, tc := range fallbackCases() {
		fit := fitTenantBGNBD(tc.signals, bgnbdNow, tc.opts)
		want := map[string]any{
			"clv_model":             clvModelHeuristic,
			"bgnbd_customers":       tc.customers,
			"bgnbd_fallback_reason": tc.reason,
			"bgnbd_fallback_error":  fit.Err.Error(),
		}
		if got := bgnbdRunMetrics(fit); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: run metrics = %v, want %v", tc.name, got, want)
		}
	}
}

// Every fallback is logged with the tenant, the run and the reason. Data
// that cannot support a fit logs at debug level, and a fit that broke down
// as a warning. A fitted run logs nothing.
func TestRepoLogBGNBDFallback_LogsTheTenantAndTheReason(t *testing.T) {
	const tenantID, runID = "7d1e4b52-2f0c-4c7e-9a51-0c5b8e0f6a11", "c0f3a9e2-51d4-4b0e-8f67-3a9d2b7e4c10"
	logger, records := newRecordingLogger()
	repo := &Repo{Logger: logger}

	fitted := FitTenantBGNBD(makeSignals(120), bgnbdNow)
	if !fitted.Fitted() {
		t.Fatalf("precondition: 120 customers fit: %v", fitted.Err)
	}
	repo.logBGNBDFallback(context.Background(), tenantID, runID, fitted)
	if got := records(); len(got) != 0 {
		t.Fatalf("a fitted run logged %+v, want nothing", got)
	}

	for _, tc := range fallbackCases() {
		t.Run(tc.name, func(t *testing.T) {
			logger, records := newRecordingLogger()
			fit := fitTenantBGNBD(tc.signals, bgnbdNow, tc.opts)
			(&Repo{Logger: logger}).logBGNBDFallback(context.Background(), tenantID, runID, fit)
			got := records()
			if len(got) != 1 {
				t.Fatalf("logged %d records, want 1: %+v", len(got), got)
			}
			wantLevel := slog.LevelWarn
			if tc.dataCannotSupportFit {
				wantLevel = slog.LevelDebug
			}
			requireFallbackLog(t, got[0], wantLevel, map[string]any{
				"tenant_id": tenantID,
				"run_id":    runID,
				"reason":    tc.reason,
				"customers": int64(tc.customers),
				"err":       fit.Err.Error(),
			})
		})
	}
}

// requireFallbackLog fails the test unless rec is a logBGNBDFallback record at
// level with exactly the attributes want.
func requireFallbackLog(t *testing.T, rec recordedLog, level slog.Level, want map[string]any) {
	t.Helper()
	if rec.level != level {
		t.Errorf("level = %v, want %v", rec.level, level)
	}
	if !strings.Contains(rec.msg, clvModelHeuristic) {
		t.Errorf("message %q does not name the model the forecasts stay on", rec.msg)
	}
	if !reflect.DeepEqual(rec.attrs, want) {
		t.Errorf("attrs = %v, want %v", rec.attrs, want)
	}
}

// recordedLog is one record a recordingHandler saw.
type recordedLog struct {
	level slog.Level
	msg   string
	attrs map[string]any
}

// recordingHandler is a slog.Handler that keeps every record, at every
// level, with its attributes resolved.
type recordingHandler struct {
	mu      *sync.Mutex
	records *[]recordedLog
	preset  []slog.Attr
}

func newRecordingLogger() (*slog.Logger, func() []recordedLog) {
	h := recordingHandler{mu: &sync.Mutex{}, records: &[]recordedLog{}}
	return slog.New(h), func() []recordedLog {
		h.mu.Lock()
		defer h.mu.Unlock()
		return append([]recordedLog(nil), *h.records...)
	}
}

func (h recordingHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h recordingHandler) Handle(_ context.Context, r slog.Record) error {
	attrs := map[string]any{}
	add := func(a slog.Attr) bool {
		attrs[a.Key] = a.Value.Resolve().Any()
		return true
	}
	for _, a := range h.preset {
		add(a)
	}
	r.Attrs(add)
	h.mu.Lock()
	defer h.mu.Unlock()
	*h.records = append(*h.records, recordedLog{level: r.Level, msg: r.Message, attrs: attrs})
	return nil
}

func (h recordingHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	h.preset = append(append([]slog.Attr(nil), h.preset...), attrs...)
	return h
}

// WithGroup is unused by the code under test; the recorder keeps attributes
// flat.
func (h recordingHandler) WithGroup(string) slog.Handler { return h }
