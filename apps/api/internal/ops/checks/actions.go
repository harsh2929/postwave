// SPDX-License-Identifier: AGPL-3.0-only
//
// actions.go — the RUNNERS behind the buttons declared as ActionMeta on the
// checks in this package.
//
// Runners live here rather than as closures in main.go for one reason: a
// closure in main.go cannot be tested. Every runner below is a plain function
// of its dependencies (a narrow store interface, a channel slice), so the
// branch that matters — "empty input replays the whole dead-letter queue" — is
// exercised against a fake rather than trusted to a code review.
//
// Runners proxy EXISTING machinery and never reimplement it: replay is
// webhook_retry.PgStore.Replay, the same transaction the admin DLQ endpoint
// and the retry worker already use. The ops console adds the audit trail, the
// idempotency key, and the timeout (see ops/actions.go) — not a second,
// subtly different replay path.

package checks

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/billing/webhook_retry"
	"github.com/postwave/postwave/apps/api/internal/ops"
)

// dlqReplayMax bounds a blanket replay. An operator who clicks "replay
// everything" on a 4,000-row queue would otherwise stampede the retry worker
// (and Stripe) in one click; 50 is a batch a human can watch land, and the
// button can simply be clicked again.
const dlqReplayMax = 50

// DLQStore is the narrow slice of webhook_retry.Store the replay action needs.
// *webhook_retry.PgStore satisfies it. Narrow on purpose: an action bound to
// the ops console can list dead rows and replay them, and cannot reach any
// other part of the retry queue.
type DLQStore interface {
	ListByStatus(ctx context.Context, status webhook_retry.AttemptStatus, limit int) ([]webhook_retry.Attempt, error)
	Replay(ctx context.Context, attemptID string) (string, error)
}

// DLQReplayRunner is the runner for billing.dlq-depth's "replay-dead-lettered"
// action. main.go binds it: ops.BindAction("billing.dlq-depth", ...).
//
// Empty input replays every dead-lettered attempt, up to dlqReplayMax; a
// non-empty input replays exactly that attempt id. A single row that refuses
// to replay does NOT abort the batch — the other rows are still money that
// never landed — but it does make the whole run FAIL, because a partial replay
// reported as success is a green button over a still-dead queue.
func DLQReplayRunner(store DLQStore) ops.ActionRunner {
	return func(ctx context.Context, input string) (string, error) {
		if id := strings.TrimSpace(input); id != "" {
			newID, err := store.Replay(ctx, id)
			if err != nil {
				return "", fmt.Errorf("replay %s: %w", id, err)
			}
			return fmt.Sprintf("replayed attempt %s as %s", id, newID), nil
		}

		dead, err := store.ListByStatus(ctx, webhook_retry.StatusDeadLettered, dlqReplayMax)
		if err != nil {
			return "", fmt.Errorf("list dead-lettered: %w", err)
		}
		if len(dead) == 0 {
			return "no dead-lettered attempts to replay", nil
		}

		var (
			replayed int
			firstErr error
		)
		for _, a := range dead {
			if err := ctx.Err(); err != nil {
				firstErr = fmt.Errorf("aborted after %d attempt(s): %w", replayed, err)
				break
			}
			if _, err := store.Replay(ctx, a.ID); err != nil {
				if firstErr == nil {
					firstErr = fmt.Errorf("replay %s (event %s): %w", a.ID, a.EventID, err)
				}
				continue
			}
			replayed++
		}
		if firstErr != nil {
			return "", fmt.Errorf("replayed %d of %d dead-lettered attempt(s); %d failed, first failure: %w",
				replayed, len(dead), len(dead)-replayed, firstErr)
		}
		return fmt.Sprintf("replayed %d of %d dead-lettered attempt(s)", replayed, len(dead)), nil
	}
}

// SendTestPushRunner is the runner for ops.push-canary's "send-test-push"
// action: one message through every wired channel, right now, on demand.
//
// It is the human-triggered twin of the canary probe, and it exists because
// "is the alert pipeline actually reaching me?" is a question an operator
// should be able to answer in one click instead of by breaking something.
//
// Unlike the probe (which fails fast — it only needs to know THAT something is
// broken), this sends to every channel before reporting, so one dead Slack
// webhook does not hide a working email path. Any failure fails the run:
// success here means "this message is in your Slack", nothing weaker.
func SendTestPushRunner(channels []ops.Channel) ops.ActionRunner {
	return func(ctx context.Context, _ string) (string, error) {
		if len(channels) == 0 {
			return "", errors.New("no push channels configured — a test push has nowhere to go " +
				"(set OPS_SLACK_WEBHOOK_URL and/or OPS_ALERT_EMAIL)")
		}

		msg := ops.PushMessage{
			Kind:  ops.PushCanary,
			Title: "ops test push",
			Body:  "operator-triggered test push from the ops console — the alert path is alive",
		}

		var reached, failures []string
		for _, ch := range channels {
			if err := ch.Send(ctx, msg); err != nil {
				failures = append(failures, fmt.Sprintf("%s: %v", ch.Name(), err))
				continue
			}
			reached = append(reached, ch.Name())
		}

		if len(failures) > 0 {
			return "", fmt.Errorf("test push failed on %d of %d channel(s): %s (reached: %s)",
				len(failures), len(channels), strings.Join(failures, "; "),
				orNone(strings.Join(reached, ", ")))
		}
		return fmt.Sprintf("test push sent to %d channel(s): %s",
			len(reached), strings.Join(reached, ", ")), nil
	}
}

func orNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}
