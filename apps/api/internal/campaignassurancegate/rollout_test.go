// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancegate

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/postwave/postwave/apps/api/internal/campaignassurance"
)

type observationRecorder struct {
	mu     sync.Mutex
	values []Observation
}

func (r *observationRecorder) ObserveCampaignAssuranceGate(_ context.Context, value Observation) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.values = append(r.values, value)
}

func (r *observationRecorder) snapshot() []Observation {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Observation(nil), r.values...)
}

type failingStore struct{ err error }

func (s failingStore) ListRuns(context.Context, string, string, int) ([]campaignassurance.Run, error) {
	return nil, s.err
}
func (s failingStore) GetRunManifest(context.Context, string, string) (*campaignassurance.ClaimedRun, error) {
	return nil, s.err
}
func (s failingStore) ListFindings(context.Context, string, string) ([]campaignassurance.Finding, error) {
	return nil, s.err
}
func (s failingStore) ListOverrides(context.Context, string, string) ([]campaignassurance.Override, error) {
	return nil, s.err
}

func TestRolloutModesAreDefaultOffAndOnlyBlockBinds(t *testing.T) {
	request, run, manifest := gateFixture()
	core := &Gate{Store: &fakeStore{runs: []campaignassurance.Run{run}, manifest: manifest}}
	tests := []struct {
		name       string
		mode       RolloutMode
		wantBound  bool
		wantAction Action
	}{
		{name: "zero value off", mode: "", wantAction: ActionObserve},
		{name: "off", mode: RolloutOff, wantAction: ActionObserve},
		{name: "shadow", mode: RolloutShadow, wantAction: ActionObserve},
		{name: "warn", mode: RolloutWarn, wantAction: ActionObserve},
		{name: "block", mode: RolloutBlock, wantBound: true, wantAction: ActionAllow},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := &observationRecorder{}
			rollout := &Rollout{Gate: core, Mode: test.mode, Observer: recorder}
			receipt, err := rollout.Authorize(t.Context(), request)
			if err != nil {
				t.Fatalf("authorize: %v", err)
			}
			if got := receipt.RunID != ""; got != test.wantBound {
				t.Fatalf("bound=%v receipt=%+v", got, receipt)
			}
			if test.mode == RolloutWarn {
				if receipt.RolloutMode != RolloutWarn || receipt.EvaluationStatus != StatusOK ||
					receipt.EvaluationReasonCode != ReasonAuthorized {
					t.Fatalf("warning mode did not return its unbound advisory: %+v", receipt)
				}
			} else if !test.wantBound && receipt.RolloutMode != "" {
				t.Fatalf("non-warning unbound mode leaked advisory metadata: %+v", receipt)
			}
			if test.wantBound && (receipt.RolloutMode != RolloutBlock ||
				receipt.EvaluationStatus != StatusOK ||
				receipt.EvaluationReasonCode != ReasonAuthorized) {
				t.Fatalf("block receipt omitted rollout evaluation: %+v", receipt)
			}
			values := recorder.snapshot()
			if rollout.RolloutMode() == RolloutOff {
				if len(values) != 0 {
					t.Fatalf("disabled rollout emitted queue telemetry: %+v", values)
				}
				return
			}
			if len(values) != 1 || values[0].Surface != SurfaceQueue || values[0].Action != test.wantAction || values[0].Status != StatusOK {
				t.Fatalf("observations=%+v", values)
			}
		})
	}
}

func TestRolloutShadowWarnObserveFailuresWhileBlockFailsClosed(t *testing.T) {
	request, _, _ := gateFixture()
	want := errors.New("database unavailable")
	for _, mode := range []RolloutMode{RolloutShadow, RolloutWarn, RolloutBlock} {
		t.Run(string(mode), func(t *testing.T) {
			recorder := &observationRecorder{}
			rollout := &Rollout{Gate: &Gate{Store: failingStore{err: want}}, Mode: mode, Observer: recorder}
			receipt, err := rollout.Authorize(t.Context(), request)
			if receipt.RunID != "" {
				t.Fatalf("failure returned binding: %+v", receipt)
			}
			if mode == RolloutBlock && !errors.Is(err, want) {
				t.Fatalf("block error=%v, want dependency error", err)
			}
			if mode != RolloutBlock && err != nil {
				t.Fatalf("%s should observe without enforcement: %v", mode, err)
			}
			if mode == RolloutWarn && (receipt.RolloutMode != RolloutWarn ||
				receipt.EvaluationStatus != StatusError ||
				receipt.EvaluationReasonCode != ReasonDependencyError) {
				t.Fatalf("warn failure advisory=%+v", receipt)
			}
			values := recorder.snapshot()
			wantAction := ActionObserve
			if mode == RolloutBlock {
				wantAction = ActionBlock
			}
			if len(values) != 1 || values[0].Status != StatusError || values[0].Action != wantAction {
				t.Fatalf("observations=%+v", values)
			}
		})
	}
}

func TestBoundReauthorizationRemainsStrictAfterRolloutDowngrade(t *testing.T) {
	request, run, manifest := gateFixture()
	run.State, manifest.Run.State = campaignassurance.StateStale, campaignassurance.StateStale
	recorder := &observationRecorder{}
	rollout := &Rollout{
		Gate: &Gate{Store: &fakeStore{runs: []campaignassurance.Run{run}, manifest: manifest}},
		Mode: RolloutOff, Observer: recorder,
	}
	if _, err := rollout.ReauthorizeBound(t.Context(), request); !errors.Is(err, ErrStale) {
		t.Fatalf("reauthorize error=%v, want stale", err)
	}
	values := recorder.snapshot()
	if len(values) != 1 || values[0].Mode != RolloutOff || values[0].Surface != SurfaceDispatch ||
		values[0].Status != StatusStale || values[0].Action != ActionBlock {
		t.Fatalf("observations=%+v", values)
	}
}

func TestPrometheusObserverHasClosedLabelsAndRejectsUnknownValues(t *testing.T) {
	registry := prometheus.NewRegistry()
	observer, err := NewPrometheusObserver(registry)
	if err != nil {
		t.Fatal(err)
	}
	observer.ObserveCampaignAssuranceGate(t.Context(), Observation{
		Mode: RolloutShadow, Surface: SurfacePreSend, Status: StatusWarn,
		Action: ActionObserve, Duration: 25 * time.Millisecond,
	})
	observer.ObserveCampaignAssuranceGate(t.Context(), Observation{
		Mode: "tenant-controlled-value", Surface: Surface("campaign-id"),
		Status: Status("arbitrary"), Action: Action("arbitrary"),
	})
	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	if len(families) != 2 {
		t.Fatalf("metric families=%d, want 2", len(families))
	}
	for _, family := range families {
		if len(family.Metric) != 1 {
			t.Fatalf("%s series=%d, want one accepted closed-label series", family.GetName(), len(family.Metric))
		}
		for _, label := range family.Metric[0].Label {
			switch label.GetName() {
			case "mode", "surface", "status", "action":
			default:
				t.Fatalf("unexpected metric label %q", label.GetName())
			}
		}
	}
}
