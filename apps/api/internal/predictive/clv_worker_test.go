// SPDX-License-Identifier: AGPL-3.0-only
package predictive

import (
	"context"
	"errors"
	"testing"
)

type fakeSignalSource struct {
	byTenant map[string][]ProfileSignals
	errOn    string
}

func (f fakeSignalSource) SignalsForTenant(_ context.Context, tenantID string) ([]ProfileSignals, error) {
	if tenantID == f.errOn {
		return nil, errors.New("signal fetch failed")
	}
	return f.byTenant[tenantID], nil
}

type fakeSink struct {
	got   map[string][]Prediction
	errOn string
}

func (f *fakeSink) UpsertPredictions(_ context.Context, tenantID string, preds []Prediction) error {
	if tenantID == f.errOn {
		return errors.New("upsert failed")
	}
	if f.got == nil {
		f.got = map[string][]Prediction{}
	}
	f.got[tenantID] = preds
	return nil
}

func TestRunPredictionBatch_ComputesAndPersistsPerTenant(t *testing.T) {
	src := fakeSignalSource{byTenant: map[string][]ProfileSignals{
		"t1": makeSignals(120), // above the fit threshold → model runs
		"t2": makeSignals(3),   // below → heuristic fallback
	}}
	sink := &fakeSink{}

	res, err := RunPredictionBatch(context.Background(), []string{"t1", "t2"}, src, sink, bgnbdNow)
	if err != nil {
		t.Fatalf("RunPredictionBatch: %v", err)
	}
	if res.TenantsProcessed != 2 || res.TenantsFailed != 0 {
		t.Fatalf("result = %+v, want 2 processed / 0 failed", res)
	}
	if len(sink.got["t1"]) != 120 || len(sink.got["t2"]) != 3 {
		t.Fatalf("persisted counts wrong: t1=%d t2=%d", len(sink.got["t1"]), len(sink.got["t2"]))
	}
	if res.PredictionsWritten != 123 {
		t.Errorf("PredictionsWritten = %d, want 123", res.PredictionsWritten)
	}
	// t1 (fitted) predictions should be model-tagged; t2 (fallback) heuristic.
	if sink.got["t1"][0].Explanation["model"] != "bgnbd-v1" {
		t.Errorf("fitted tenant should be model-tagged, got %v", sink.got["t1"][0].Explanation["model"])
	}
	if sink.got["t2"][0].Explanation["model"] != "heuristic-v1" {
		t.Errorf("below-threshold tenant should stay heuristic, got %v", sink.got["t2"][0].Explanation["model"])
	}
}

func TestRunPredictionBatch_ContinuesPastPerTenantError(t *testing.T) {
	src := fakeSignalSource{
		byTenant: map[string][]ProfileSignals{"good": makeSignals(3)},
		errOn:    "bad-fetch",
	}
	sink := &fakeSink{errOn: "bad-upsert"}
	// bad-fetch fails at fetch; bad-upsert fails at upsert; good succeeds.
	src.byTenant["bad-upsert"] = makeSignals(3)

	res, err := RunPredictionBatch(context.Background(), []string{"bad-fetch", "bad-upsert", "good"}, src, sink, bgnbdNow)
	if err == nil {
		t.Fatal("expected the first per-tenant error to be returned")
	}
	if res.TenantsFailed != 2 || res.TenantsProcessed != 1 {
		t.Fatalf("result = %+v, want 1 processed / 2 failed (run continued past errors)", res)
	}
	if _, ok := sink.got["good"]; !ok {
		t.Error("the healthy tenant should still have been persisted despite others failing")
	}
}

func TestRunPredictionBatch_StopsOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	src := fakeSignalSource{byTenant: map[string][]ProfileSignals{"t1": makeSignals(3)}}
	res, err := RunPredictionBatch(ctx, []string{"t1"}, src, &fakeSink{}, bgnbdNow)
	if err == nil {
		t.Error("a cancelled context should stop the batch")
	}
	if res.TenantsProcessed != 0 {
		t.Errorf("no tenants should process under a cancelled context, got %d", res.TenantsProcessed)
	}
}
