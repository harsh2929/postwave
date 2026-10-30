// SPDX-License-Identifier: AGPL-3.0-only
//
// surface_metrics_test.go — verifies the Phase 1a cross-cutting
// helpers register metrics under the standardized `pw_*` names with
// the correct labels and the RecordSurface middleware records both
// the counter and the histogram on every request.

package observability

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

// uniqueSurface keeps each test using a distinct surface label so
// tests don't collide on the global Prometheus registry — the helpers
// return the existing collector on duplicate registration, which is
// fine in production but makes test isolation easier when each test
// uses its own surface name.
func uniqueSurface(_ *testing.T, base, suffix string) string {
	clean := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			return r
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		default:
			return '_'
		}
	}, suffix)
	return base + "_" + clean
}

func TestMustRegisterSurfaceCounter_NameAndLabels(t *testing.T) {
	surface := uniqueSurface(t, "subs", t.Name())
	cv := MustRegisterSurfaceCounter(surface, "list")
	if cv == nil {
		t.Fatal("expected non-nil CounterVec")
	}
	// Increment with the mandatory labels to verify the cardinality
	// matches what the helper documented.
	cv.WithLabelValues("ok", "").Inc()

	want := "pw_" + surface + "_list_total"
	if !metricFamilyExists(t, want) {
		t.Fatalf("expected metric family %q to be registered", want)
	}
}

func TestMustRegisterSurfaceCounter_AcceptsExtraLabels(t *testing.T) {
	surface := uniqueSurface(t, "campaigns", t.Name())
	cv := MustRegisterSurfaceCounter(surface, "create", "channel")
	// Extra labels are appended after outcome+reason — verify the
	// order by calling WithLabelValues with three args.
	cv.WithLabelValues("ok", "", "email").Inc()

	// Calling with only two args should panic — the extra label is
	// required.
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic for missing extra label")
		}
	}()
	cv.WithLabelValues("ok", "").Inc()
}

func TestMustRegisterSurfaceCounter_DuplicateReturnsExisting(t *testing.T) {
	surface := uniqueSurface(t, "segments", t.Name())
	first := MustRegisterSurfaceCounter(surface, "evaluate")
	second := MustRegisterSurfaceCounter(surface, "evaluate")
	if first != second {
		t.Fatalf("expected duplicate registration to return same vector, got %p vs %p", first, second)
	}
}

func TestMustRegisterSurfaceCounter_InvalidNamePanics(t *testing.T) {
	cases := []struct {
		surface string
		action  string
		desc    string
	}{
		{"", "list", "empty surface"},
		{"subs", "", "empty action"},
		{"Subs", "list", "uppercase surface"},
		{"subs", "List", "uppercase action"},
		{"subs-v2", "list", "hyphen in surface"},
		{"subs.v2", "list", "dot in surface"},
		{"_subs", "list", "leading underscore"},
		{"subs", "list_", "trailing underscore"},
	}
	for _, tc := range cases {
		t.Run(tc.desc, func(t *testing.T) {
			defer func() {
				if r := recover(); r == nil {
					t.Fatalf("expected panic for %s (surface=%q action=%q)", tc.desc, tc.surface, tc.action)
				}
			}()
			MustRegisterSurfaceCounter(tc.surface, tc.action)
		})
	}
}

func TestMustRegisterSurfaceHistogram_NameAndBuckets(t *testing.T) {
	surface := uniqueSurface(t, "automations", t.Name())
	hv := MustRegisterSurfaceHistogram(surface, "enroll")
	if hv == nil {
		t.Fatal("expected non-nil HistogramVec")
	}
	hv.WithLabelValues("enroll").Observe(0.05)

	want := "pw_" + surface + "_duration_seconds"
	if !metricFamilyExists(t, want) {
		t.Fatalf("expected metric family %q to be registered", want)
	}

	// Calling again with a different handler must reuse the same
	// vector — one histogram per surface, multiplexed by handler.
	again := MustRegisterSurfaceHistogram(surface, "exit")
	if again != hv {
		t.Fatalf("expected duplicate surface registration to return same vector")
	}
	again.WithLabelValues("exit").Observe(0.1)
}

func TestMustRegisterSurfaceHistogram_InvalidNamePanics(t *testing.T) {
	cases := []struct {
		surface string
		handler string
		desc    string
	}{
		{"", "list", "empty surface"},
		{"subs", "", "empty handler"},
		{"Subs", "list", "uppercase surface"},
	}
	for _, tc := range cases {
		t.Run(tc.desc, func(t *testing.T) {
			defer func() {
				if r := recover(); r == nil {
					t.Fatalf("expected panic for %s", tc.desc)
				}
			}()
			MustRegisterSurfaceHistogram(tc.surface, tc.handler)
		})
	}
}

func TestRecordSurface_RecordsCounterAndHistogram_OK(t *testing.T) {
	surface := uniqueSurface(t, "subscribers", t.Name())
	handler := "list"

	called := false
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	})
	wrapped := RecordSurface(surface, handler, inner)

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rec := httptest.NewRecorder()
	wrapped.ServeHTTP(rec, req)

	if !called {
		t.Fatal("inner handler was not invoked")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d", rec.Code)
	}

	got := counterValue(t, "pw_"+surface+"_"+handler+"_total", map[string]string{"outcome": "ok", "reason": ""})
	if got != 1 {
		t.Fatalf("expected counter value 1, got %v", got)
	}

	if !histogramHasObservation(t, "pw_"+surface+"_duration_seconds", handler) {
		t.Fatalf("expected histogram to have at least one observation for handler=%q", handler)
	}
}

func TestRecordSurface_RecordsErrorOnNon2xx(t *testing.T) {
	surface := uniqueSurface(t, "campaigns", t.Name())
	handler := "send"

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})
	wrapped := RecordSurface(surface, handler, inner)

	req := httptest.NewRequest(http.MethodPost, "/test", nil)
	rec := httptest.NewRecorder()
	wrapped.ServeHTTP(rec, req)

	name := "pw_" + surface + "_" + handler + "_total"
	if got := counterValue(t, name, map[string]string{"outcome": "error", "reason": ""}); got != 1 {
		t.Fatalf("expected error counter to be 1, got %v", got)
	}
	if got := counterValue(t, name, map[string]string{"outcome": "ok", "reason": ""}); got != 0 {
		t.Fatalf("expected ok counter to be 0, got %v", got)
	}
}

func TestRecordSurface_4xxCountsAsError(t *testing.T) {
	surface := uniqueSurface(t, "segments", t.Name())
	handler := "delete"

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	})
	wrapped := RecordSurface(surface, handler, inner)

	req := httptest.NewRequest(http.MethodDelete, "/test", nil)
	rec := httptest.NewRecorder()
	wrapped.ServeHTTP(rec, req)

	name := "pw_" + surface + "_" + handler + "_total"
	if got := counterValue(t, name, map[string]string{"outcome": "error", "reason": ""}); got != 1 {
		t.Fatalf("expected error counter to be 1 for 404, got %v", got)
	}
}

func TestRecordSurfaceFunc_WrapsHandlerFunc(t *testing.T) {
	surface := uniqueSurface(t, "auditsink", t.Name())
	handler := "deliver"

	hf := RecordSurfaceFunc(surface, handler, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	})

	req := httptest.NewRequest(http.MethodPost, "/test", nil)
	rec := httptest.NewRecorder()
	hf(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected status 202, got %d", rec.Code)
	}

	name := "pw_" + surface + "_" + handler + "_total"
	if got := counterValue(t, name, map[string]string{"outcome": "ok", "reason": ""}); got != 1 {
		t.Fatalf("expected ok counter to be 1 for 202, got %v", got)
	}
}

// --- helpers ---

// metricFamilyExists returns true iff a metric family with the
// supplied name has been registered with the default Prometheus
// gatherer. Used to assert the helpers produced the documented
// `pw_<surface>_<...>` names.
func metricFamilyExists(t *testing.T, name string) bool {
	t.Helper()
	families, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, f := range families {
		if f.GetName() == name {
			return true
		}
	}
	return false
}

// counterValue returns the value of a single time series identified
// by metric name + label key-value pairs. Returns 0 if the series
// hasn't been observed (which the caller can distinguish from a
// genuine zero by knowing whether they incremented at all).
func counterValue(t *testing.T, name string, labels map[string]string) float64 {
	t.Helper()
	families, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, f := range families {
		if f.GetName() != name {
			continue
		}
		for _, m := range f.GetMetric() {
			if m.GetCounter() == nil {
				continue
			}
			if labelsMatch(m.GetLabel(), labels) {
				return m.GetCounter().GetValue()
			}
		}
	}
	return 0
}

// histogramHasObservation returns true iff at least one observation
// has been recorded on the histogram with the supplied `handler`
// label value.
func histogramHasObservation(t *testing.T, name, handler string) bool {
	t.Helper()
	families, err := prometheus.DefaultGatherer.Gather()
	if err != nil {
		t.Fatalf("gather: %v", err)
	}
	for _, f := range families {
		if f.GetName() != name {
			continue
		}
		for _, m := range f.GetMetric() {
			h := m.GetHistogram()
			if h == nil {
				continue
			}
			for _, lp := range m.GetLabel() {
				if lp.GetName() == "handler" && lp.GetValue() == handler && h.GetSampleCount() > 0 {
					return true
				}
			}
		}
	}
	return false
}

// labelsMatch compares all wanted label key-value pairs against the
// label pairs from a Prometheus metric. All wanted pairs must match;
// the metric may carry additional labels not in `want`.
func labelsMatch(have []*dto.LabelPair, want map[string]string) bool {
	for k, v := range want {
		found := false
		for _, lp := range have {
			if lp.GetName() == k && lp.GetValue() == v {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
