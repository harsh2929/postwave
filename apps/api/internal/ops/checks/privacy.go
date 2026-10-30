// SPDX-License-Identifier: AGPL-3.0-only

package checks

import (
	"context"
	"fmt"
	"time"

	"github.com/postwave/postwave/apps/api/internal/ops"
)

func init() {
	ops.Register(ops.Check{
		ID:       "privacy.erasure-integrity",
		Domain:   "privacy",
		Owner:    "legal",
		Group:    "Legal",
		Title:    "Art. 17 erasures actually erase",
		Why:      "An erasure request that deleted zero rows means we told a data subject their data was erased while still holding it. That is an Art. 17 breach, and it is silent: the operator saw a success message.",
		Kind:     ops.KindEvaluated,
		Severity: ops.SevCritical,
		Interval: time.Hour,
		Probe:    probeErasureIntegrity,
		Remediation: "Inspect the erase rows: SELECT id, requested_at, requested_by FROM sar_bundles " +
			"WHERE kind = 'erase' AND coalesce(rows_deleted, 0) = 0. Re-run each erasure via " +
			"POST /api/v1/sar/requests {\"kind\":\"erase\"}. A zero-row erasure usually means the " +
			"subject was already erased (benign, re-run is idempotent) or the subject email never " +
			"matched a subscriber (check for a typo before telling the regulator it was fulfilled).",
		Runbook: "docs/runbooks/customer-data-export.md",
	})
}

// probeErasureIntegrity reads through the SECURITY DEFINER aggregate, so the
// postwave_ops role never touches sar_bundles and the return type -- a bare
// count -- cannot carry a subject out of the tenant boundary.
func probeErasureIntegrity(ctx context.Context, env *ops.Env) (ops.Status, string, error) {
	var unerased int64
	if err := env.Pool.QueryRow(ctx,
		`SELECT unerased_fulfilled FROM ops_erasure_integrity()`).Scan(&unerased); err != nil {
		return ops.StatusRed, "", err
	}

	if unerased == 0 {
		return ops.StatusOK, "every erasure in the last 30d deleted rows", nil
	}
	return ops.StatusRed, fmt.Sprintf(
		"%d erasure request(s) in the last 30d were marked fulfilled having deleted ZERO rows", unerased), nil
}
