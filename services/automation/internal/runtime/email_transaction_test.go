package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type emailTxCall struct {
	sql  string
	args []any
}

type emailTestTx struct {
	calls         []emailTxCall
	failExecAt    int
	execErr       error
	commitErr     error
	commitCalls   int
	rollbackCalls int
}

func (t *emailTestTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	t.calls = append(t.calls, emailTxCall{sql: sql, args: append([]any(nil), args...)})
	if t.failExecAt > 0 && len(t.calls) == t.failExecAt {
		return pgconn.CommandTag{}, t.execErr
	}
	return pgconn.NewCommandTag("INSERT 0 1"), nil
}

func (t *emailTestTx) Commit(context.Context) error {
	t.commitCalls++
	return t.commitErr
}

func (t *emailTestTx) Rollback(context.Context) error {
	t.rollbackCalls++
	return nil
}

var _ emailOutboxTx = (*emailTestTx)(nil)

func TestEmitEmailOutboxBindsTenantAndCommits(t *testing.T) {
	tx := &emailTestTx{}
	req := EmailSendRequest{
		SubscriberEmail: "recipient@example.test",
		TemplateID:      "template-1",
		AutomationID:    "automation-1",
		NodeID:          "email-1",
		RunID:           "run-1",
	}
	err := emitEmailOutbox(context.Background(), "tenant-1", req,
		func(context.Context, pgx.TxOptions) (emailOutboxTx, error) { return tx, nil })
	if err != nil {
		t.Fatalf("emit email outbox: %v", err)
	}
	if len(tx.calls) != 2 {
		t.Fatalf("exec calls = %d, want tenant bind + insert", len(tx.calls))
	}
	if !strings.Contains(tx.calls[0].sql, "set_config('app.tenant_id', $1, true)") {
		t.Fatalf("first statement did not bind transaction-local tenant scope: %q", tx.calls[0].sql)
	}
	if got := tx.calls[0].args[0]; got != "tenant-1" {
		t.Fatalf("tenant bind argument = %v", got)
	}
	if !strings.Contains(tx.calls[1].sql, "INSERT INTO outbox_events") {
		t.Fatalf("second statement is not outbox insert: %q", tx.calls[1].sql)
	}
	if tx.calls[1].args[0] != "tenant-1" || tx.calls[1].args[1] != emailKind {
		t.Fatalf("outbox tenant/kind args = %#v", tx.calls[1].args[:2])
	}
	var payload EmailSendRequest
	if err := json.Unmarshal([]byte(tx.calls[1].args[2].(string)), &payload); err != nil {
		t.Fatalf("decode outbox payload: %v", err)
	}
	if payload.RunID != req.RunID || payload.SubscriberEmail != req.SubscriberEmail {
		t.Fatalf("outbox payload = %+v, want %+v", payload, req)
	}
	if tx.commitCalls != 1 || tx.rollbackCalls != 1 {
		t.Fatalf("commit/rollback calls = %d/%d, want 1/1", tx.commitCalls, tx.rollbackCalls)
	}
}

func TestEmitEmailOutboxRollsBackBeforeCommitOnInsertFailure(t *testing.T) {
	insertErr := errors.New("forced outbox insert failure")
	tx := &emailTestTx{failExecAt: 2, execErr: insertErr}
	err := emitEmailOutbox(context.Background(), "tenant-1", EmailSendRequest{},
		func(context.Context, pgx.TxOptions) (emailOutboxTx, error) { return tx, nil })
	if !errors.Is(err, insertErr) {
		t.Fatalf("error = %v, want wrapped %v", err, insertErr)
	}
	if tx.commitCalls != 0 || tx.rollbackCalls != 1 {
		t.Fatalf("commit/rollback calls = %d/%d, want 0/1", tx.commitCalls, tx.rollbackCalls)
	}
}
