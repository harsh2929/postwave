// SPDX-License-Identifier: AGPL-3.0-only

package checks

import (
	"context"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/ops"
)

// A probe that has only ever been exercised against a fake proves the fake
// works. These run the real SQL against real Postgres, which is the only thing
// that can catch a renamed column, a changed status vocabulary, or a function
// that was never granted to postwave_ops -- three failures that all present at
// runtime as a permanently RED check nobody can explain.
func TestCoverageProbes_RunAgainstRealPostgres(t *testing.T) {
	pool := testPool(t)
	env := &ops.Env{Pool: pool}
	ctx := context.Background()

	for name, probe := range map[string]ops.ProbeFunc{
		"sending.pipeline-stalled":  probeSendPipeline,
		"webhooks.delivery-backlog": probeWebhookDelivery,
		"flows.run-backlog":         probeFlowRuns,
		"identity.session-reaper":   probeSessionReaper,
		"growth.signup-pulse":       probeGrowthPulse,
	} {
		t.Run(name, func(t *testing.T) {
			status, detail, err := probe(ctx, env)
			if err != nil {
				t.Fatalf("probe returned an error against a healthy empty database: %v", err)
			}
			if status != ops.StatusOK {
				// An empty database is a quiet one, not a broken one. A probe
				// that reds here would red on the day it shipped and be
				// snoozed within the week.
				t.Fatalf("an empty database must not be red or warning; got %s: %s", status, detail)
			}
			if strings.TrimSpace(detail) == "" {
				t.Fatal("a probe must always return a detail line; an empty one tells an operator nothing")
			}
		})
	}
}

// The boundary these probes rely on: postwave_ops may EXECUTE the aggregates
// and may not read the tables behind them. If that ever inverts, the return
// type stops being the security boundary.
func TestCoverageAggregates_AreReachableOnlyAsFunctions(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()

	for _, fn := range []string{
		"SELECT * FROM ops_send_pipeline_health()",
		"SELECT * FROM ops_webhook_delivery_health()",
		"SELECT * FROM ops_flow_run_health()",
		"SELECT * FROM ops_session_health()",
		"SELECT * FROM ops_growth_snapshot()",
	} {
		if _, err := pool.Exec(ctx, "SET ROLE postwave_ops"); err != nil {
			t.Fatalf("SET ROLE postwave_ops: %v", err)
		}
		_, err := pool.Exec(ctx, fn)
		if err != nil {
			t.Errorf("postwave_ops must be able to execute %q: %v", fn, err)
		}
		if _, err := pool.Exec(ctx, "RESET ROLE"); err != nil {
			t.Fatalf("RESET ROLE: %v", err)
		}
	}

	for _, table := range []string{
		"outbound_webhook_deliveries", "flow_runs", "auth_sessions", "subscribers",
		"campaign_recipients",
	} {
		if _, err := pool.Exec(ctx, "SET ROLE postwave_ops"); err != nil {
			t.Fatalf("SET ROLE postwave_ops: %v", err)
		}
		_, err := pool.Exec(ctx, "SELECT 1 FROM "+table+" LIMIT 1")
		if _, resetErr := pool.Exec(ctx, "RESET ROLE"); resetErr != nil {
			t.Fatalf("RESET ROLE: %v", resetErr)
		}
		if err == nil {
			t.Errorf("postwave_ops must NOT be able to read %s directly; the aggregate's return type is the security boundary", table)
		}
	}
}

// Every new check must name a registered domain and carry an owner. Register
// panics on both, but a compile-time list is easy to extend and a test that
// re-states the rule is what makes the panic discoverable.
func TestCoverageChecks_AreRegisteredWithOwnersAndDomains(t *testing.T) {
	for _, id := range []string{
		"sending.pipeline-stalled", "webhooks.delivery-backlog", "flows.run-backlog",
		"identity.session-reaper", "growth.signup-pulse",
	} {
		c, ok := ops.Get(id)
		if !ok {
			t.Errorf("%s is not registered", id)
			continue
		}
		if _, known := ops.GetDomain(c.Domain); !known {
			t.Errorf("%s names unregistered domain %q", id, c.Domain)
		}
		if c.Owner == "" || c.Why == "" || c.Remediation == "" {
			t.Errorf("%s is missing an owner, a why, or a remediation", id)
		}
	}
}
