// SPDX-License-Identifier: AGPL-3.0-only
//
// metrics.go — prometheus counters for the consolidated retention
// sweeper. Each per-class sweep increments rowsPurgedTotal by the
// number of rows it removed (or NULLed-out, for the inbound-email
// body scrub); iterationsTotal tracks ticks per class so the
// dashboard can show "engagement sweep ran with no errors today".

package retention

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var rowsPurgedTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "retention_rows_purged_total",
		Help: "Rows deleted (or content NULLed) by the consolidated retention sweeper, partitioned by tenant and data class.",
	},
	[]string{"tenant", "class"},
)

var iterationsTotal = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "retention_sweep_iterations_total",
		Help: "Retention sweeper iterations partitioned by data class and outcome (ok|error).",
	},
	[]string{"class", "outcome"},
)
