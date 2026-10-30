// SPDX-License-Identifier: AGPL-3.0-only

package checks

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/postwave/postwave/apps/api/internal/billing/webhook_retry"
	"github.com/postwave/postwave/apps/api/internal/ops"
)

// ---------------------------------------------------------------------------
// billing.dlq-depth → replay-dead-lettered
// ---------------------------------------------------------------------------

// fakeDLQStore records what the runner asked for. It deliberately implements
// only the two methods the action needs (DLQStore), which is the whole point
// of the narrow interface: the runner cannot reach past listing and replaying.
type fakeDLQStore struct {
	dead       []webhook_retry.Attempt
	listStatus webhook_retry.AttemptStatus
	listLimit  int
	listErr    error

	replayed  []string          // attempt ids, in call order
	replayErr map[string]error  // per-id failures
	newIDs    map[string]string // id -> replay row id
}

func (f *fakeDLQStore) ListByStatus(_ context.Context, status webhook_retry.AttemptStatus, limit int) ([]webhook_retry.Attempt, error) {
	f.listStatus, f.listLimit = status, limit
	if f.listErr != nil {
		return nil, f.listErr
	}
	if limit < len(f.dead) {
		return f.dead[:limit], nil
	}
	return f.dead, nil
}

func (f *fakeDLQStore) Replay(_ context.Context, attemptID string) (string, error) {
	if err := f.replayErr[attemptID]; err != nil {
		return "", err
	}
	f.replayed = append(f.replayed, attemptID)
	if id, ok := f.newIDs[attemptID]; ok {
		return id, nil
	}
	return "new-" + attemptID, nil
}

func deadAttempts(n int) []webhook_retry.Attempt {
	out := make([]webhook_retry.Attempt, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, webhook_retry.Attempt{
			ID:      fmt.Sprintf("att-%02d", i),
			EventID: fmt.Sprintf("evt_%02d", i),
			Status:  webhook_retry.StatusDeadLettered,
		})
	}
	return out
}

func TestBillingDLQCheck_DeclaresTheReplayAction(t *testing.T) {
	c, ok := ops.Get("billing.dlq-depth")
	if !ok {
		t.Fatal(`ops.Get("billing.dlq-depth"): check not registered`)
	}
	if c.Action == nil {
		t.Fatal("billing.dlq-depth declares no ActionMeta — the board would render no button")
	}
	if c.Action.ID != "replay-dead-lettered" {
		t.Errorf("action ID = %q, want %q", c.Action.ID, "replay-dead-lettered")
	}
	if c.Action.Label != "Replay dead-lettered" {
		t.Errorf("action Label = %q, want %q", c.Action.Label, "Replay dead-lettered")
	}
	// Replaying money events is not a one-click action: the UI must ask.
	if c.Action.Danger != ops.DangerConfirm {
		t.Errorf("action Danger = %q, want %q", c.Action.Danger, ops.DangerConfirm)
	}
	if c.Action.InputHint == "" {
		t.Error("action InputHint must tell the operator what the input box means")
	}
}

func TestDLQReplayRunner_EmptyInput_ReplaysEveryDeadLetteredRow(t *testing.T) {
	store := &fakeDLQStore{dead: deadAttempts(3)}
	run := DLQReplayRunner(store)

	result, err := run(context.Background(), "  ")
	if err != nil {
		t.Fatalf("runner error = %v", err)
	}
	if store.listStatus != webhook_retry.StatusDeadLettered {
		t.Errorf("listed status %q, want %q", store.listStatus, webhook_retry.StatusDeadLettered)
	}
	if got, want := store.replayed, []string{"att-00", "att-01", "att-02"}; !equalIDs(got, want) {
		t.Errorf("replayed %v, want %v", got, want)
	}
	if !strings.Contains(result, "3") {
		t.Errorf("result %q must name the count of rows replayed", result)
	}
}

func TestDLQReplayRunner_EmptyInput_CapsAtFifty(t *testing.T) {
	store := &fakeDLQStore{dead: deadAttempts(90)}
	run := DLQReplayRunner(store)

	result, err := run(context.Background(), "")
	if err != nil {
		t.Fatalf("runner error = %v", err)
	}
	if store.listLimit != 50 {
		t.Errorf("listed with limit %d, want 50 — an unbounded replay is a stampede", store.listLimit)
	}
	if len(store.replayed) != 50 {
		t.Fatalf("replayed %d attempts, want 50", len(store.replayed))
	}
	if !strings.Contains(result, "50") {
		t.Errorf("result %q must name the count of rows replayed", result)
	}
}

func TestDLQReplayRunner_EmptyInput_NothingDead(t *testing.T) {
	store := &fakeDLQStore{}
	run := DLQReplayRunner(store)

	result, err := run(context.Background(), "")
	if err != nil {
		t.Fatalf("runner error = %v", err)
	}
	if len(store.replayed) != 0 {
		t.Fatalf("replayed %v with nothing dead-lettered", store.replayed)
	}
	if !strings.Contains(result, "no dead-lettered") {
		t.Errorf("result = %q, want it to say nothing was dead-lettered", result)
	}
}

func TestDLQReplayRunner_SpecificID_ReplaysExactlyThatRow(t *testing.T) {
	store := &fakeDLQStore{
		dead:   deadAttempts(3),
		newIDs: map[string]string{"att-01": "fresh-1"},
	}
	run := DLQReplayRunner(store)

	result, err := run(context.Background(), " att-01 ")
	if err != nil {
		t.Fatalf("runner error = %v", err)
	}
	if got, want := store.replayed, []string{"att-01"}; !equalIDs(got, want) {
		t.Fatalf("replayed %v, want %v", got, want)
	}
	if store.listLimit != 0 {
		t.Error("a targeted replay must not list the queue at all")
	}
	if !strings.Contains(result, "att-01") || !strings.Contains(result, "fresh-1") {
		t.Errorf("result %q must name the source attempt and the new row", result)
	}
}

func TestDLQReplayRunner_SpecificID_NotDeadLettered(t *testing.T) {
	store := &fakeDLQStore{replayErr: map[string]error{"att-09": errors.New("not found or not dead-lettered")}}
	run := DLQReplayRunner(store)

	if _, err := run(context.Background(), "att-09"); err == nil {
		t.Fatal("replaying a row that is not dead-lettered must be an error, not a silent success")
	}
}

// A store that fails halfway must not report success for the rows that never
// replayed: the executor writes the runner's error onto the run row, so a
// swallowed error here is a green button over a still-dead queue.
func TestDLQReplayRunner_PartialFailure_ReportsBothCounts(t *testing.T) {
	store := &fakeDLQStore{
		dead:      deadAttempts(3),
		replayErr: map[string]error{"att-01": errors.New("deadlock detected")},
	}
	run := DLQReplayRunner(store)

	_, err := run(context.Background(), "")
	if err == nil {
		t.Fatal("a partially failed replay must return an error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "2") || !strings.Contains(msg, "3") {
		t.Errorf("error %q must state how many of how many replayed", msg)
	}
	if !strings.Contains(msg, "deadlock detected") {
		t.Errorf("error %q must carry the underlying failure", msg)
	}
	// The rows that could replay still did.
	if got, want := store.replayed, []string{"att-00", "att-02"}; !equalIDs(got, want) {
		t.Errorf("replayed %v, want %v — a mid-queue failure must not abort the rest", got, want)
	}
}

func TestDLQReplayRunner_ListFailure(t *testing.T) {
	store := &fakeDLQStore{listErr: errors.New("connection refused")}
	run := DLQReplayRunner(store)

	if _, err := run(context.Background(), ""); err == nil {
		t.Fatal("a failed list must be an error, not an empty-queue success")
	}
}

// ---------------------------------------------------------------------------
// ops.push-canary → send-test-push
// ---------------------------------------------------------------------------

func TestSendTestPushRunner_SendsThroughEveryChannel(t *testing.T) {
	slack := &recordingChannel{name: "slack"}
	email := &recordingChannel{name: "email"}
	run := SendTestPushRunner([]ops.Channel{slack, email})

	result, err := run(context.Background(), "")
	if err != nil {
		t.Fatalf("runner error = %v", err)
	}
	if len(slack.sent) != 1 || len(email.sent) != 1 {
		t.Fatalf("sent slack=%d email=%d, want 1 each", len(slack.sent), len(email.sent))
	}
	if slack.sent[0].Kind != ops.PushCanary {
		t.Errorf("test push Kind = %q, want %q", slack.sent[0].Kind, ops.PushCanary)
	}
	if !strings.Contains(result, "slack") || !strings.Contains(result, "email") {
		t.Errorf("result %q must name the channels it reached", result)
	}
}

// One broken channel must not hide a working one, and must not be reported as
// success: the operator clicked this button precisely to find out.
func TestSendTestPushRunner_OneChannelFails(t *testing.T) {
	slack := &recordingChannel{name: "slack", err: errors.New("webhook 404")}
	email := &recordingChannel{name: "email"}
	run := SendTestPushRunner([]ops.Channel{slack, email})

	_, err := run(context.Background(), "")
	if err == nil {
		t.Fatal("a failed channel send must return an error")
	}
	if !strings.Contains(err.Error(), "slack") || !strings.Contains(err.Error(), "webhook 404") {
		t.Errorf("error %q must name the broken channel and why", err)
	}
	if len(email.sent) != 1 {
		t.Error("a broken channel must not stop the working ones from being tested")
	}
}

func TestSendTestPushRunner_NoChannels(t *testing.T) {
	run := SendTestPushRunner(nil)

	if _, err := run(context.Background(), ""); err == nil {
		t.Fatal("with zero channels the test push has nowhere to go; that is a failure, not a success")
	}
}

// recordingChannel captures the messages sent through it. (fakeCanaryChannel
// in pushcanary_test.go only reports pass/fail; the action tests need the
// message itself.)
type recordingChannel struct {
	name string
	err  error
	sent []ops.PushMessage
}

func (c *recordingChannel) Name() string { return c.name }

func (c *recordingChannel) Send(_ context.Context, m ops.PushMessage) error {
	if c.err != nil {
		return c.err
	}
	c.sent = append(c.sent, m)
	return nil
}

func equalIDs(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}
