// SPDX-License-Identifier: AGPL-3.0-only

// The push canary: the one check that watches the alerting pipeline itself.
//
// Every other check in this package trusts that a RED result reaches a
// human. This one distrusts that assumption. A dead alert pipeline must not
// present as a quiet board — it must present as its own RED row, because
// every silent failure in the 2026-07 audit had exactly that shape: the
// thing that broke was fine right up until the moment nobody could tell it
// wasn't.
//
// The check is declared in init() like every other, but unlike most its
// probe is bound at wiring time (ops_console_wiring.go calls
// BindPushCanaryProbe) once the runtime channels and the push loop's
// PushStateStore exist — a probe that watches "are my channels configured
// and reachable, and is the push loop still ticking" needs those live
// handles, not a compile-time closure over nothing.
package checks

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/postwave/postwave/apps/api/internal/ops"
)

// pushLoopStaleAfter is the freshness budget for the '__push_loop__'
// heartbeat. The pusher ticks roughly once a minute (see ops.Pusher.Tick /
// Reconciler's defaultTick), so five minutes is several missed ticks of
// slack before this check cries wolf.
const pushLoopStaleAfter = 5 * time.Minute

// PushCanaryCheckID is declared at compile time; only the probe, which needs
// the live channels and push-loop state store main.go builds, is bound later.
// Registering the whole check at runtime kept it out of the compiled registry,
// so the coverage number CI printed disagreed with the running board.
const PushCanaryCheckID = "ops.push-canary"

var bindPushCanaryOnce sync.Once

func init() {
	{
		ops.Register(ops.Check{
			ID:     PushCanaryCheckID,
			Group:  "Ops",
			Domain: "console",
			Owner:  "platform",
			Title:  "Push alert pipeline",
			Why: "an alerting channel that dies silently reads as all-clear; every silent failure " +
				"in the 2026-07 audit had this shape",
			Kind:         ops.KindEvaluated,
			Severity:     ops.SevHigh,
			Interval:     24 * time.Hour,
			RuntimeProbe: true,
			Remediation: "check OPS_SLACK_WEBHOOK_URL / OPS_ALERT_EMAIL and the ops-push worker; " +
				"a red canary means pushes are NOT reaching you",

			// DangerSafe: the whole point is that an operator can prove the
			// alert path works without breaking something to trigger it, and a
			// confirmation modal in front of "send me a test message" is
			// ceremony that would stop people from ever checking. The runner
			// (checks.SendTestPushRunner) is bound in main.go against this
			// same channel slice.
			Action: &ops.ActionMeta{
				ID:     "send-test-push",
				Label:  "Send test push",
				Danger: ops.DangerSafe,
			},
		})
	}
}

// BindPushCanaryProbe attaches the probe to the live channel slice and
// push-loop state store main.go wires up for the Pusher itself.
//
// sync.Once keeps a second call (a test, or main.go wired twice during a
// refactor) a safe no-op rather than a boot-time panic on a double bind. The
// first call therefore wins for the life of the process: the board runs its
// channels and store until exit, so they must live as long as the process.
func BindPushCanaryProbe(channels []ops.Channel, loopState *ops.PushStateStore) {
	bindPushCanaryOnce.Do(func() {
		ops.BindProbe(PushCanaryCheckID, pushCanaryProbe(channels, loopState))
	})
}

// pushCanaryProbe builds the probe as a plain function of its inputs so the
// branch logic is testable without going through the process-wide,
// once-only probe binding (ops.BindProbe panics on a double bind, so
// re-deriving this closure per test case — the only way to exercise every
// channels/loopState combination — cannot go through BindPushCanaryProbe
// itself).
//
// Order of checks matters only for which detail line a human sees when more
// than one thing is wrong at once — every branch below independently
// returns RED (or, for zero channels in a non-production env, WARN), so no
// combination is ever misreported as healthy:
//
//  1. any configured channel's canary send fails → RED naming it
//  2. the push loop's heartbeat is stale or absent → RED "push loop dead"
//  3. zero channels configured:
//     - production (per ops.IsProductionEnv, the same detector main.go's
//     boot check uses — POSTWAVE_ENV/ENVIRONMENT/NODE_ENV set to
//     "production" or "prod") → RED (alerts have nowhere to go)
//     - anywhere else → WARN (nothing is wired yet, but nothing has failed)
func pushCanaryProbe(channels []ops.Channel, loopState *ops.PushStateStore) ops.ProbeFunc {
	return func(ctx context.Context, _ *ops.Env) (ops.Status, string, error) {
		canary := ops.PushMessage{Kind: ops.PushCanary, Title: "ops push canary", Body: "push path alive"}
		for _, ch := range channels {
			if err := ch.Send(ctx, canary); err != nil {
				return ops.StatusRed,
					fmt.Sprintf("%s channel canary send failed: %v", ch.Name(), err), nil
			}
		}

		age, present, err := loopState.LoopHeartbeatAge(ctx)
		if err != nil {
			return ops.StatusRed, "", err
		}
		if !present || age > pushLoopStaleAfter {
			return ops.StatusRed, "push loop dead — alerts are not being sent", nil
		}

		if len(channels) == 0 {
			// Same detector as main.go's boot check (which delegates to
			// ops.IsProductionEnv): any env spelling that earns the boot
			// error must also earn a RED canary, or the unwired alert
			// pipeline hides in the board's green lane.
			if ops.IsProductionEnv() {
				return ops.StatusRed, "zero push channels configured in production — alerts have nowhere to go", nil
			}
			return ops.StatusWarn, "zero push channels configured (non-production)", nil
		}

		return ops.StatusOK, "push channels reachable and the push loop is alive", nil
	}
}
