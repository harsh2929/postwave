// SPDX-License-Identifier: AGPL-3.0-only

package checks

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/postwave/postwave/apps/api/internal/ops"
)

// LaunchReadiness is the narrow view of the production readiness report this
// check needs. main.go adapts internal/readiness, so this package imports
// neither readiness nor config -- the same seam the ops package uses for
// SessionResolver.
type LaunchReadiness struct {
	// Status is the report's own verdict: "ok", "warning" or "blocked".
	Status string
	// Blocking counts REQUIRED gates that are failing; Failing counts all of
	// them. The distinction is the whole point of the report: an optional gate
	// failing is a note, a required one is a launch date moving.
	Blocking int
	Failing  int
	Total    int
	// Environment names which deployment answered, so a green report from a
	// staging task cannot be mistaken for a green production one.
	Environment string
}

// LaunchReadinessCheckID is declared at compile time; only its probe, which
// needs the loaded config, is bound at wiring time.
//
// The report is CONFIGURATION, not code: live keys, approvals, quotas,
// sidecar contracts. No test suite can speak to any of it, which is why it is
// the one category reliably discovered at 3am on launch day. It has been
// served behind the operator gate since the console was built with nothing
// reading it.
const LaunchReadinessCheckID = "launch.production-readiness"

var bindLaunchOnce sync.Once

func init() {
	{
		ops.Register(ops.Check{
			ID:       LaunchReadinessCheckID,
			Group:    "Releases",
			Domain:   "launch",
			Owner:    "founder",
			Title:    "Production readiness gates",
			Severity: ops.SevCritical,
			Why: "Launch gates are configuration rather than code — live Stripe keys, the billing launch approval, auth providers, sidecar origins. " +
				"A green test suite says nothing about any of them, so without this row the first evidence that a required gate is unset is a customer hitting it.",
			Kind:         ops.KindEvaluated,
			Interval:     5 * time.Minute,
			RuntimeProbe: true,
			Remediation: "Open Launch in the console for the per-gate detail: every failing gate carries the exact variable to set and what it unblocks. " +
				"Required gates block the launch; optional ones do not. Note that this check reads the environment the API task itself is running in, " +
				"so a green row here is only a statement about THAT deployment.",
			Runbook: "docs/runbooks/incident-response.md",
		})
	}
}

// BindLaunchReadinessProbe attaches the probe to the loaded configuration.
func BindLaunchReadinessProbe(evaluate func(context.Context) (LaunchReadiness, error)) {
	bindLaunchOnce.Do(func() {
		ops.BindProbe(LaunchReadinessCheckID, func(ctx context.Context, _ *ops.Env) (ops.Status, string, error) {
			report, err := evaluate(ctx)
			if err != nil {
				return ops.StatusRed, "", err
			}
			detail := fmt.Sprintf("env=%s %d/%d gates pass, %d blocking",
				report.Environment, report.Total-report.Failing, report.Total, report.Blocking)
			switch report.Status {
			case "blocked":
				return ops.StatusRed, detail, nil
			case "warning":
				return ops.StatusWarn, detail, nil
			case "ok":
				return ops.StatusOK, detail, nil
			default:
				// An unrecognised verdict is not a passing one. If the report
				// grows a status this check does not know, the honest answer
				// is "I cannot read this", and unknown is not green.
				return ops.StatusRed, detail + "; unrecognised report status " + report.Status, nil
			}
		})
	})
}
