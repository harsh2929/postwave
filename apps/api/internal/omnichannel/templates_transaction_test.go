// SPDX-License-Identifier: AGPL-3.0-only
package omnichannel

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type templateTestRow struct {
	template MessageTemplate
	err      error
}

func (r templateTestRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) != 14 {
		return errors.New("unexpected template scan destination count")
	}
	*dest[0].(*string) = r.template.ID
	*dest[1].(*string) = r.template.TenantID
	*dest[2].(*string) = r.template.Channel
	*dest[3].(*string) = r.template.Name
	*dest[4].(*string) = r.template.Status
	*dest[5].(*string) = r.template.Subject
	*dest[6].(*string) = r.template.BodyText
	*dest[7].(*string) = r.template.BodyHTML
	*dest[8].(*[]byte) = []byte(`{"asset":"hero"}`)
	*dest[9].(*[]byte) = []byte(`["first_name"]`)
	*dest[10].(*string) = r.template.ProviderTemplateID
	*dest[11].(*string) = r.template.ApprovalStatus
	*dest[12].(*time.Time) = r.template.CreatedAt
	*dest[13].(*time.Time) = r.template.UpdatedAt
	return nil
}

type templateTestTx struct {
	row           pgx.Row
	commitErr     error
	commitCalls   int
	rollbackCalls int
}

func (t *templateTestTx) QueryRow(context.Context, string, ...any) pgx.Row { return t.row }
func (t *templateTestTx) Commit(context.Context) error {
	t.commitCalls++
	return t.commitErr
}
func (t *templateTestTx) Rollback(context.Context) error {
	t.rollbackCalls++
	return nil
}

// The following methods are deliberately absent: templateTx is intentionally
// narrow. This assertion prevents a future widening from making the transaction
// lifecycle difficult to exercise without a database.
var _ templateTx = (*templateTestTx)(nil)
var _ pgx.Row = templateTestRow{}

func TestUpsertTemplateInTxCommitsReturnedRow(t *testing.T) {
	now := time.Date(2026, 7, 21, 12, 0, 0, 0, time.UTC)
	tx := &templateTestTx{row: templateTestRow{template: MessageTemplate{
		ID: "template-1", TenantID: "tenant-1", Channel: "email", Name: "Welcome",
		Status: "ready", ApprovalStatus: "not_required", CreatedAt: now, UpdatedAt: now,
	}}}

	out, err := upsertTemplateInTx(context.Background(), tx, "tenant-1", MessageTemplate{
		Channel: "email", Name: "Welcome", Status: "ready", ApprovalStatus: "not_required",
	}, []byte(`{"asset":"hero"}`), []byte(`["first_name"]`))
	if err != nil {
		t.Fatalf("upsert template: %v", err)
	}
	if out.ID != "template-1" || out.Media["asset"] != "hero" || len(out.Variables) != 1 {
		t.Fatalf("returned template = %+v", out)
	}
	if tx.commitCalls != 1 {
		t.Fatalf("commit calls = %d, want 1", tx.commitCalls)
	}
	if tx.rollbackCalls != 1 {
		t.Fatalf("deferred safe rollback calls = %d, want 1", tx.rollbackCalls)
	}
}

func TestUpsertTemplateInTxRollsBackScanAndCommitFailures(t *testing.T) {
	scanErr := errors.New("forced scan failure")
	t.Run("scan failure", func(t *testing.T) {
		tx := &templateTestTx{row: templateTestRow{err: scanErr}}
		if _, err := upsertTemplateInTx(context.Background(), tx, "tenant-1", MessageTemplate{}, nil, nil); !errors.Is(err, scanErr) {
			t.Fatalf("error = %v, want %v", err, scanErr)
		}
		if tx.commitCalls != 0 || tx.rollbackCalls != 1 {
			t.Fatalf("commit/rollback calls = %d/%d, want 0/1", tx.commitCalls, tx.rollbackCalls)
		}
	})

	commitErr := errors.New("forced commit failure")
	t.Run("commit failure", func(t *testing.T) {
		tx := &templateTestTx{
			row:       templateTestRow{template: MessageTemplate{}},
			commitErr: commitErr,
		}
		if _, err := upsertTemplateInTx(context.Background(), tx, "tenant-1", MessageTemplate{}, nil, nil); !errors.Is(err, commitErr) {
			t.Fatalf("error = %v, want wrapped %v", err, commitErr)
		}
		if tx.commitCalls != 1 || tx.rollbackCalls != 1 {
			t.Fatalf("commit/rollback calls = %d/%d, want 1/1", tx.commitCalls, tx.rollbackCalls)
		}
	})
}
