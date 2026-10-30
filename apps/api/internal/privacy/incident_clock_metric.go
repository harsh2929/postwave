// SPDX-License-Identifier: AGPL-3.0-only
//
// incident_clock_metric.go — Prometheus gauge surfacing privacy
// incidents whose legacy 72h operational target has elapsed without an
// audience notification having been recorded. This is a conservative ops
// signal, not a legal conclusion; the current schema does not encode the
// awareness/risk/role facts needed to determine a statutory deadline.

package privacy

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"

	"github.com/postwave/postwave/apps/api/internal/db"
)

var overdueIncidents = promauto.NewGaugeVec(prometheus.GaugeOpts{
	Name: "postwave_privacy_incident_overdue",
	Help: "Count of privacy_incidents past the legacy 72-hour operational target whose audience packet has not been recorded, including incidents marked closed. Labeled by audience (authority | customer | data_subject). This conservative signal does not determine whether a statutory notification duty exists.",
}, []string{"audience"})

var incidentClockAvailable = promauto.NewGauge(prometheus.GaugeOpts{
	Name: "postwave_privacy_incident_clock_available",
	Help: "Whether the privacy incident clock has a verified database-enforced scan capability (1 available, 0 release-held).",
})

var errIncidentClockReleaseHeld = errors.New("privacy incident clock is release-held until a dedicated least-privilege cross-tenant read capability and restricted-role integration proof exist")

// IncidentClockWorker owns the intended overdue-scan lifecycle. Its Run method
// is release-held until a database-enforced cross-tenant read path exists.
type IncidentClockWorker struct {
	Pool     *db.Pool
	Interval time.Duration
	Logger   *slog.Logger
}

// Run is statically release-held. The request-role pool is subject to FORCE
// RLS and no dedicated privacy-clock policy exists, so a cross-tenant query can
// succeed while seeing zero rows. Running that scan would publish a false
// all-clear. Do not replace this boundary with an application-set custom GUC;
// the release gate requires a database-enforced least-privilege capability.
func (w *IncidentClockWorker) Run(ctx context.Context) {
	if w == nil {
		return
	}
	_ = ctx              // retained in the signature for the future cancellable worker.
	_ = overdueIncidents // keep the descriptor registered without publishing label samples.
	incidentClockAvailable.Set(0)
	w.warn("release_hold", errIncidentClockReleaseHeld)
}

func (w *IncidentClockWorker) warn(stage string, err error) {
	if w.Logger != nil {
		w.Logger.Warn("privacy incident clock worker", "stage", stage, "err", err.Error())
	}
}
