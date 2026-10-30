// SPDX-License-Identifier: AGPL-3.0-only

package checks

import (
	"context"
	"fmt"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/ops"
)

const (
	actionRunStaleAfter     = 2 * time.Minute
	actionRunInventoryLimit = 20
	actionRunTokenRunes     = 96
)

func init() {
	ops.Register(ops.Check{
		ID:       "ops.action-runs-stuck",
		Domain:   "console",
		Owner:    "platform",
		Group:    "Ops",
		Title:    "Ambiguous operator actions",
		Why:      "An operator action left running after its bounded lifecycle may have reached an external system before the process or connection failed. Hiding it invites a duplicate retry; auto-retrying it can repeat a payment, replay, or mute.",
		Kind:     ops.KindEvaluated,
		Severity: ops.SevCritical,
		Interval: time.Minute,
		Probe:    probeStaleActionRuns,
		Remediation: "Do not retry these actions automatically. Inspect the listed ops_action_runs IDs and the target system, reconcile the actual side effect, then record a deliberate new operator intent only when its safety is known. " +
			"A same-payload browser retry must keep the original idempotency key and can only replay this ledger row.",
		Runbook: "docs/runbooks/incident-response.md",
	})
}

type staleActionRun struct {
	ID        string
	CheckID   string
	ActionID  string
	StartedAt time.Time
}

// probeStaleActionRuns is an inventory, never a recovery worker. It performs
// one bounded read of stale durable intents and deliberately has no runner or
// mutation dependency, so observing an ambiguous action cannot repeat it.
func probeStaleActionRuns(ctx context.Context, env *ops.Env) (ops.Status, string, error) {
	if env == nil || env.Pool == nil {
		return ops.StatusRed, "", fmt.Errorf("ops action-run inventory has no database")
	}

	cutoff := time.Now().UTC().Add(-actionRunStaleAfter)
	rows, err := env.Pool.Query(ctx, `
SELECT id::text, check_id, action_id, started_at, count(*) OVER ()
  FROM ops_action_runs
 WHERE status = 'running'
   AND started_at < $1
 ORDER BY started_at ASC, id ASC
 LIMIT $2`, cutoff, actionRunInventoryLimit)
	if err != nil {
		return ops.StatusRed, "", err
	}
	defer rows.Close()

	runs := make([]staleActionRun, 0, actionRunInventoryLimit)
	var total int64
	for rows.Next() {
		var run staleActionRun
		if err := rows.Scan(&run.ID, &run.CheckID, &run.ActionID, &run.StartedAt, &total); err != nil {
			return ops.StatusRed, "", err
		}
		runs = append(runs, run)
	}
	if err := rows.Err(); err != nil {
		return ops.StatusRed, "", err
	}
	if len(runs) == 0 {
		return ops.StatusOK, "no operator action has exceeded its bounded running lifecycle", nil
	}

	items := make([]string, 0, len(runs))
	for _, run := range runs {
		items = append(items, fmt.Sprintf(
			"%s check=%q action=%q started=%s",
			run.ID,
			boundActionRunToken(run.CheckID),
			boundActionRunToken(run.ActionID),
			run.StartedAt.UTC().Format(time.RFC3339),
		))
	}
	detail := fmt.Sprintf(
		"%d operator action(s) have remained running for more than %s; NEVER auto-retry an ambiguous action. Oldest inventory: %s",
		total, actionRunStaleAfter, strings.Join(items, "; "),
	)
	if total > int64(len(runs)) {
		detail += fmt.Sprintf("; showing %d of %d", len(runs), total)
	}
	return ops.StatusRed, detail, nil
}

func boundActionRunToken(value string) string {
	value = strings.TrimSpace(strings.ToValidUTF8(value, "�"))
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return '�'
		}
		return r
	}, value)
	if utf8.RuneCountInString(value) <= actionRunTokenRunes {
		return value
	}
	runes := []rune(value)
	return string(runes[:actionRunTokenRunes-1]) + "…"
}
