// SPDX-License-Identifier: AGPL-3.0-only
package approvals

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type approvalWebhookTestRow struct {
	scan func(...any) error
}

func (r approvalWebhookTestRow) Scan(dest ...any) error {
	if r.scan == nil {
		return nil
	}
	return r.scan(dest...)
}

type approvalWebhookTestTx struct {
	pgx.Tx
	queryRow      func(string, []any) pgx.Row
	commitCalls   int
	rollbackCalls int
}

func (t *approvalWebhookTestTx) QueryRow(_ context.Context, query string, args ...any) pgx.Row {
	if t.queryRow == nil {
		return approvalWebhookTestRow{}
	}
	return t.queryRow(query, args)
}

func (t *approvalWebhookTestTx) Commit(context.Context) error {
	t.commitCalls++
	return nil
}

func (t *approvalWebhookTestTx) Rollback(context.Context) error {
	t.rollbackCalls++
	return nil
}

type recordingApprovalWebhookFanout struct {
	calls int
	tx    pgx.Tx
	event TransactionalWebhookEvent
	err   error
}

func (f *recordingApprovalWebhookFanout) FanoutApprovalEvent(
	_ context.Context,
	tx pgx.Tx,
	event TransactionalWebhookEvent,
) error {
	f.calls++
	f.tx = tx
	f.event = event
	return f.err
}

func TestInsertCreatesRequestedWebhookIntentInApprovalTransaction(t *testing.T) {
	t.Parallel()
	requestedAt := time.Date(2031, 2, 3, 4, 5, 6, 700, time.UTC)
	expiresAt := requestedAt.Add(DefaultTTL)
	tx := &approvalWebhookTestTx{
		queryRow: func(query string, _ []any) pgx.Row {
			if !strings.Contains(query, "INSERT INTO approvals") {
				t.Fatalf("unexpected query: %s", query)
			}
			return approvalWebhookTestRow{scan: func(dest ...any) error {
				*dest[0].(*string) = "approval-123"
				*dest[1].(*time.Time) = requestedAt
				*dest[2].(*time.Time) = expiresAt
				return nil
			}}
		},
	}
	fanout := &recordingApprovalWebhookFanout{}
	repo := &Repo{
		TransactionalWebhookFanout: fanout,
		beginTenantTx: func(_ context.Context, tenantID string) (pgx.Tx, error) {
			if tenantID != "tenant-123" {
				t.Fatalf("tenant transaction = %q", tenantID)
			}
			return tx, nil
		},
	}
	approval := &Approval{
		TenantID:              "tenant-123",
		ResourceType:          string(ResourceCampaign),
		ResourceID:            "campaign-123",
		RequestedByActorType:  "user",
		RequestedByActorLabel: "owner@example.com",
		Status:                StatusPending,
		RequestedAt:           requestedAt,
		ExpiresAt:             expiresAt,
	}

	if err := repo.Insert(context.Background(), approval); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	if fanout.calls != 1 {
		t.Fatalf("fanout calls = %d, want 1", fanout.calls)
	}
	if fanout.tx != tx {
		t.Fatal("fanout did not receive the approval insert transaction")
	}
	if tx.commitCalls != 1 {
		t.Fatalf("commit calls = %d, want 1", tx.commitCalls)
	}
	event := fanout.event
	if event.EventType != "approval.requested" ||
		event.SourceEventID != "approval.requested:approval-123:pending" ||
		event.TenantID != "tenant-123" ||
		!event.OccurredAt.Equal(requestedAt) {
		t.Fatalf("requested event identity = %#v", event)
	}
	wantBody := map[string]any{
		"approval_id":             "approval-123",
		"resource_type":           "campaign",
		"resource_id":             "campaign-123",
		"status":                  "pending",
		"requested_at":            requestedAt.Format(time.RFC3339Nano),
		"expires_at":              expiresAt.Format(time.RFC3339Nano),
		"requested_by":            "owner@example.com",
		"requested_by_actor_type": "user",
	}
	for key, want := range wantBody {
		if got := event.Body[key]; got != want {
			t.Errorf("event body[%q] = %#v, want %#v", key, got, want)
		}
	}
}

func TestUpdateStatusCreatesDecidedWebhookIntentInDecisionTransaction(t *testing.T) {
	t.Parallel()
	decidedAt := time.Date(2031, 3, 4, 5, 6, 7, 800, time.UTC)
	tx := &approvalWebhookTestTx{
		queryRow: func(query string, _ []any) pgx.Row {
			if !strings.Contains(query, "UPDATE approvals SET status") ||
				!strings.Contains(query, "RETURNING tenant_id::text") {
				t.Fatalf("unexpected query: %s", query)
			}
			return approvalWebhookTestRow{scan: func(dest ...any) error {
				*dest[0].(*string) = "tenant-456"
				*dest[1].(*string) = "sequence"
				*dest[2].(*string) = "sequence-456"
				return nil
			}}
		},
	}
	fanout := &recordingApprovalWebhookFanout{}
	repo := &Repo{
		TransactionalWebhookFanout: fanout,
		beginTenantTx: func(context.Context, string) (pgx.Tx, error) {
			return tx, nil
		},
	}

	err := repo.UpdateStatus(
		context.Background(),
		"tenant-456",
		"approval-456",
		StatusApproved,
		"user-456",
		"ready",
		decidedAt,
	)
	if err != nil {
		t.Fatalf("UpdateStatus: %v", err)
	}
	if fanout.calls != 1 || fanout.tx != tx {
		t.Fatalf("fanout calls/tx = %d/%v, want 1/same tx", fanout.calls, fanout.tx == tx)
	}
	if tx.commitCalls != 1 {
		t.Fatalf("commit calls = %d, want 1", tx.commitCalls)
	}
	event := fanout.event
	if event.EventType != "approval.decided" ||
		event.SourceEventID != "approval.decided:approval-456:approved" ||
		event.TenantID != "tenant-456" ||
		!event.OccurredAt.Equal(decidedAt) {
		t.Fatalf("decided event identity = %#v", event)
	}
	wantBody := map[string]any{
		"approval_id":   "approval-456",
		"resource_type": "sequence",
		"resource_id":   "sequence-456",
		"decision":      "approved",
		"status":        "approved",
		"decided_by":    "user-456",
		"decided_at":    decidedAt.Format(time.RFC3339Nano),
	}
	for key, want := range wantBody {
		if got := event.Body[key]; got != want {
			t.Errorf("event body[%q] = %#v, want %#v", key, got, want)
		}
	}
}

func TestApprovalWebhookFanoutFailureAbortsBusinessTransaction(t *testing.T) {
	t.Parallel()
	fanoutErr := errors.New("delivery intent unavailable")
	requestedAt := time.Date(2031, 4, 5, 6, 7, 8, 0, time.UTC)
	tx := &approvalWebhookTestTx{
		queryRow: func(_ string, _ []any) pgx.Row {
			return approvalWebhookTestRow{scan: func(dest ...any) error {
				*dest[0].(*string) = "approval-fail"
				*dest[1].(*time.Time) = requestedAt
				*dest[2].(*time.Time) = requestedAt.Add(DefaultTTL)
				return nil
			}}
		},
	}
	fanout := &recordingApprovalWebhookFanout{err: fanoutErr}
	repo := &Repo{
		TransactionalWebhookFanout: fanout,
		beginTenantTx: func(context.Context, string) (pgx.Tx, error) {
			return tx, nil
		},
	}
	approval := &Approval{
		TenantID:     "tenant-fail",
		ResourceType: string(ResourceCampaign),
		ResourceID:   "campaign-fail",
		Status:       StatusPending,
		RequestedAt:  requestedAt,
		ExpiresAt:    requestedAt.Add(DefaultTTL),
	}

	err := repo.Insert(context.Background(), approval)
	if !errors.Is(err, fanoutErr) {
		t.Fatalf("Insert error = %v, want wrapped fanout error", err)
	}
	if tx.commitCalls != 0 {
		t.Fatalf("commit calls = %d, want 0", tx.commitCalls)
	}
	if tx.rollbackCalls != 1 {
		t.Fatalf("rollback calls = %d, want 1", tx.rollbackCalls)
	}
}

func TestDecisionWebhookFanoutFailureAbortsDecisionTransaction(t *testing.T) {
	t.Parallel()
	fanoutErr := errors.New("delivery intent unavailable")
	tx := &approvalWebhookTestTx{
		queryRow: func(_ string, _ []any) pgx.Row {
			return approvalWebhookTestRow{scan: func(dest ...any) error {
				*dest[0].(*string) = "tenant-fail"
				*dest[1].(*string) = "campaign"
				*dest[2].(*string) = "campaign-fail"
				return nil
			}}
		},
	}
	fanout := &recordingApprovalWebhookFanout{err: fanoutErr}
	repo := &Repo{
		TransactionalWebhookFanout: fanout,
		beginTenantTx: func(context.Context, string) (pgx.Tx, error) {
			return tx, nil
		},
	}

	err := repo.UpdateStatus(
		context.Background(),
		"tenant-fail",
		"approval-fail",
		StatusRejected,
		"user-fail",
		"",
		time.Now().UTC(),
	)
	if !errors.Is(err, fanoutErr) {
		t.Fatalf("UpdateStatus error = %v, want wrapped fanout error", err)
	}
	if fanout.calls != 1 || tx.commitCalls != 0 || tx.rollbackCalls != 1 {
		t.Fatalf(
			"calls/commit/rollback = %d/%d/%d, want 1/0/1",
			fanout.calls,
			tx.commitCalls,
			tx.rollbackCalls,
		)
	}
}

func TestDecisionWebhookNotCreatedForFailedOrNonDecisionMutation(t *testing.T) {
	t.Parallel()
	t.Run("database mutation failed", func(t *testing.T) {
		mutationErr := errors.New("update unavailable")
		tx := &approvalWebhookTestTx{
			queryRow: func(_ string, _ []any) pgx.Row {
				return approvalWebhookTestRow{scan: func(...any) error {
					return mutationErr
				}}
			},
		}
		fanout := &recordingApprovalWebhookFanout{}
		repo := &Repo{
			TransactionalWebhookFanout: fanout,
			beginTenantTx: func(context.Context, string) (pgx.Tx, error) {
				return tx, nil
			},
		}

		err := repo.UpdateStatus(
			context.Background(),
			"tenant-failed",
			"approval-failed",
			StatusApproved,
			"user-failed",
			"",
			time.Now().UTC(),
		)
		if !errors.Is(err, mutationErr) {
			t.Fatalf("UpdateStatus = %v, want mutation failure", err)
		}
		if fanout.calls != 0 || tx.commitCalls != 0 {
			t.Fatalf("fanout/commit calls = %d/%d, want 0/0", fanout.calls, tx.commitCalls)
		}
	})

	t.Run("no pending row", func(t *testing.T) {
		tx := &approvalWebhookTestTx{
			queryRow: func(_ string, _ []any) pgx.Row {
				return approvalWebhookTestRow{scan: func(...any) error {
					return pgx.ErrNoRows
				}}
			},
		}
		fanout := &recordingApprovalWebhookFanout{}
		repo := &Repo{
			TransactionalWebhookFanout: fanout,
			beginTenantTx: func(context.Context, string) (pgx.Tx, error) {
				return tx, nil
			},
		}

		err := repo.UpdateStatus(
			context.Background(),
			"tenant-noop",
			"approval-noop",
			StatusApproved,
			"user-noop",
			"",
			time.Now().UTC(),
		)
		if !errors.Is(err, ErrNotFound) {
			t.Fatalf("UpdateStatus = %v, want ErrNotFound", err)
		}
		if fanout.calls != 0 || tx.commitCalls != 0 {
			t.Fatalf("fanout/commit calls = %d/%d, want 0/0", fanout.calls, tx.commitCalls)
		}
	})

	t.Run("expiry is not a decision event", func(t *testing.T) {
		tx := &approvalWebhookTestTx{
			queryRow: func(_ string, _ []any) pgx.Row {
				return approvalWebhookTestRow{scan: func(dest ...any) error {
					*dest[0].(*string) = "tenant-expired"
					*dest[1].(*string) = "campaign"
					*dest[2].(*string) = "campaign-expired"
					return nil
				}}
			},
		}
		fanout := &recordingApprovalWebhookFanout{}
		repo := &Repo{
			TransactionalWebhookFanout: fanout,
			beginTenantTx: func(context.Context, string) (pgx.Tx, error) {
				return tx, nil
			},
		}

		if err := repo.UpdateStatus(
			context.Background(),
			"tenant-expired",
			"approval-expired",
			StatusExpired,
			"",
			"",
			time.Now().UTC(),
		); err != nil {
			t.Fatalf("UpdateStatus: %v", err)
		}
		if fanout.calls != 0 || tx.commitCalls != 1 {
			t.Fatalf("fanout/commit calls = %d/%d, want 0/1", fanout.calls, tx.commitCalls)
		}
	})
}
