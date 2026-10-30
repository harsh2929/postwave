// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancegate

import (
	"context"
	"errors"

	"github.com/prometheus/client_golang/prometheus"
)

// PrometheusObserver exports only closed labels. Exact identities belong in
// audit receipts/logs, never metric dimensions.
type PrometheusObserver struct {
	decisions *prometheus.CounterVec
	duration  *prometheus.HistogramVec
}

func NewPrometheusObserver(registerer prometheus.Registerer) (*PrometheusObserver, error) {
	if registerer == nil {
		return nil, errors.New("campaign assurance gate telemetry registerer is required")
	}
	observer := &PrometheusObserver{
		decisions: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "postwave_campaign_assurance_gate_decisions_total",
			Help: "Campaign Assurance decisions by closed rollout, surface, status, and action.",
		}, []string{"mode", "surface", "status", "action"}),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "postwave_campaign_assurance_gate_duration_seconds",
			Help:    "Cached Campaign Assurance evaluation latency by closed surface and status.",
			Buckets: []float64{0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5},
		}, []string{"surface", "status"}),
	}
	if err := registerer.Register(observer.decisions); err != nil {
		return nil, err
	}
	if err := registerer.Register(observer.duration); err != nil {
		registerer.Unregister(observer.decisions)
		return nil, err
	}
	return observer, nil
}

func (o *PrometheusObserver) ObserveCampaignAssuranceGate(_ context.Context, observation Observation) {
	if o == nil || o.decisions == nil || o.duration == nil || !validObservation(observation) {
		return
	}
	o.decisions.WithLabelValues(
		string(observation.Mode), string(observation.Surface),
		string(observation.Status), string(observation.Action),
	).Inc()
	o.duration.WithLabelValues(string(observation.Surface), string(observation.Status)).
		Observe(nonNegativeDuration(observation.Duration).Seconds())
}

func validObservation(observation Observation) bool {
	if !validRolloutMode(observation.Mode) {
		return false
	}
	switch observation.Surface {
	case SurfacePreSend, SurfaceQueue, SurfaceDispatch:
	default:
		return false
	}
	switch observation.Status {
	case StatusOK, StatusWarn, StatusCritical, StatusPending, StatusStale,
		StatusUnavailable, StatusError:
	default:
		return false
	}
	switch observation.Action {
	case ActionObserve, ActionAllow, ActionBlock:
		return true
	default:
		return false
	}
}
