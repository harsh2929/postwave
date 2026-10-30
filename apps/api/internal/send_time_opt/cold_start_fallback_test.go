// SPDX-License-Identifier: AGPL-3.0-only
//
// sto-cold-start-fallback-hierarchy (P1) tests for the resolver leaf.
// The DB-backed integration lives in campaigns/sto_fallback.go; these
// tests exercise the pure-Go selection logic (nil resolver, errors,
// out-of-range hours).

package send_time_opt

import (
	"context"
	"errors"
	"testing"
)

// stubResolver is an in-memory FallbackResolver for tests. Returning
// `boom` lets us assert that the error path degrades to the global
// default rather than propagating.
type stubResolver struct {
	out  TenantFallback
	boom error
}

func (s stubResolver) ResolveTenantFallback(_ context.Context, _ string) (TenantFallback, error) {
	return s.out, s.boom
}

func TestResolveTenantFallback_NilResolver_Defaults(t *testing.T) {
	tf := resolveTenantFallback(context.Background(), nil, "ten1")
	if tf.Hour != GlobalDefaultHour {
		t.Fatalf("nil resolver: want hour=%d, got %d", GlobalDefaultHour, tf.Hour)
	}
	if tf.Confidence != ConfidenceGlobalDefault {
		t.Fatalf("nil resolver: want confidence=%s, got %s",
			ConfidenceGlobalDefault, tf.Confidence)
	}
}

func TestResolveTenantFallback_Error_FallsBackToGlobalDefault(t *testing.T) {
	r := stubResolver{
		out:  TenantFallback{Hour: 42, Confidence: ConfidenceTenantOverride},
		boom: errors.New("db down"),
	}
	tf := resolveTenantFallback(context.Background(), r, "ten1")
	if tf.Hour != GlobalDefaultHour {
		t.Fatalf("error path: want hour=%d, got %d", GlobalDefaultHour, tf.Hour)
	}
	if tf.Confidence != ConfidenceGlobalDefault {
		t.Fatalf("error path: want confidence=%s, got %s",
			ConfidenceGlobalDefault, tf.Confidence)
	}
}

func TestResolveTenantFallback_OverridePreferred(t *testing.T) {
	r := stubResolver{out: TenantFallback{Hour: 14, Confidence: ConfidenceTenantOverride}}
	tf := resolveTenantFallback(context.Background(), r, "ten1")
	if tf.Hour != 14 || tf.Confidence != ConfidenceTenantOverride {
		t.Fatalf("override: %+v", tf)
	}
}

func TestResolveTenantFallback_AggregatePassesSampleSize(t *testing.T) {
	r := stubResolver{out: TenantFallback{
		Hour:       33,
		Confidence: ConfidenceTenantFallback,
		SampleSize: 1234,
	}}
	tf := resolveTenantFallback(context.Background(), r, "ten1")
	if tf.SampleSize != 1234 {
		t.Fatalf("want sample_size=1234, got %d", tf.SampleSize)
	}
	if tf.Confidence != ConfidenceTenantFallback {
		t.Fatalf("want confidence=%s, got %s",
			ConfidenceTenantFallback, tf.Confidence)
	}
}

func TestResolveTenantFallback_OutOfRangeDowngrades(t *testing.T) {
	// An impl that hands back hour=200 (past 167) must NOT corrupt
	// downstream HourOfWeek invariants — the resolver clamps to
	// global default + downgrades the label so callers can tell.
	r := stubResolver{out: TenantFallback{Hour: 200, Confidence: ConfidenceTenantOverride}}
	tf := resolveTenantFallback(context.Background(), r, "ten1")
	if tf.Hour != GlobalDefaultHour {
		t.Fatalf("oor: want hour=%d, got %d", GlobalDefaultHour, tf.Hour)
	}
	if tf.Confidence != ConfidenceGlobalDefault {
		t.Fatalf("oor: want downgraded label, got %s", tf.Confidence)
	}

	rNeg := stubResolver{out: TenantFallback{Hour: -5, Confidence: ConfidenceTenantFallback}}
	tfNeg := resolveTenantFallback(context.Background(), rNeg, "ten1")
	if tfNeg.Hour != GlobalDefaultHour || tfNeg.Confidence != ConfidenceGlobalDefault {
		t.Fatalf("negative hour: %+v", tfNeg)
	}
}

func TestResolveTenantFallback_BoundaryHoursAccepted(t *testing.T) {
	// 0 and 167 are valid (Sunday 00:00 UTC and Saturday 23:00 UTC).
	// Earlier impls clamped 0 because they treated it as "unset"; the
	// resolver must NOT do that — a marketer pinning the override to
	// Sunday-midnight UTC is a legitimate (if unusual) choice.
	for _, h := range []int{0, 167} {
		r := stubResolver{out: TenantFallback{Hour: h, Confidence: ConfidenceTenantOverride}}
		tf := resolveTenantFallback(context.Background(), r, "ten1")
		if tf.Hour != h {
			t.Fatalf("boundary hour=%d: got %d", h, tf.Hour)
		}
		if tf.Confidence != ConfidenceTenantOverride {
			t.Fatalf("boundary hour=%d: confidence=%s", h, tf.Confidence)
		}
	}
}

func TestResolveTenantFallback_EmptyConfidence_DefaultsToGlobal(t *testing.T) {
	// An impl that returns an empty confidence label must not leak to
	// callers — the resolver normalises to ConfidenceGlobalDefault.
	r := stubResolver{out: TenantFallback{Hour: 12, Confidence: ""}}
	tf := resolveTenantFallback(context.Background(), r, "ten1")
	if tf.Confidence != ConfidenceGlobalDefault {
		t.Fatalf("empty confidence: got %s", tf.Confidence)
	}
	if tf.Hour != 12 {
		t.Fatalf("empty confidence: hour preserved? got %d", tf.Hour)
	}
}
