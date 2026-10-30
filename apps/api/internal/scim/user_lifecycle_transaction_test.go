// SPDX-License-Identifier: AGPL-3.0-only

package scim

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

type scimLifecycleTestRow struct {
	scan func(...any) error
}

func (r scimLifecycleTestRow) Scan(dest ...any) error {
	if r.scan == nil {
		return nil
	}
	return r.scan(dest...)
}

type scimLifecycleExecResult struct {
	contains string
	tag      pgconn.CommandTag
	err      error
}

type scimLifecycleTestTx struct {
	rows          []pgx.Row
	execResults   []scimLifecycleExecResult
	queries       []string
	execs         []string
	execArgs      [][]any
	commitErr     error
	commitCalls   int
	rollbackCalls int
}

func (t *scimLifecycleTestTx) QueryRow(_ context.Context, sql string, _ ...any) pgx.Row {
	t.queries = append(t.queries, sql)
	if len(t.rows) == 0 {
		return scimLifecycleTestRow{scan: func(...any) error {
			return errors.New("unexpected SCIM lifecycle query")
		}}
	}
	row := t.rows[0]
	t.rows = t.rows[1:]
	return row
}

func (t *scimLifecycleTestTx) Exec(_ context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	t.execs = append(t.execs, sql)
	t.execArgs = append(t.execArgs, args)
	for _, result := range t.execResults {
		if strings.Contains(sql, result.contains) {
			return result.tag, result.err
		}
	}
	return pgconn.NewCommandTag("UPDATE 1"), nil
}

func (t *scimLifecycleTestTx) Commit(context.Context) error {
	t.commitCalls++
	return t.commitErr
}

func (t *scimLifecycleTestTx) Rollback(context.Context) error {
	t.rollbackCalls++
	return nil
}

var _ scimUserTx = (*scimLifecycleTestTx)(nil)
var _ pgx.Row = scimLifecycleTestRow{}

func scimUserUpdateRow(at time.Time) pgx.Row {
	return scimLifecycleTestRow{scan: func(dest ...any) error {
		if len(dest) != 2 {
			return fmt.Errorf("SCIM update scan destinations = %d, want 2", len(dest))
		}
		*dest[0].(*time.Time) = at
		*dest[1].(*time.Time) = at
		return nil
	}}
}

func scimLinkedUserRow(linkedUserID *string) pgx.Row {
	return scimLifecycleTestRow{scan: func(dest ...any) error {
		if len(dest) != 1 {
			return fmt.Errorf("SCIM delete scan destinations = %d, want 1", len(dest))
		}
		if linkedUserID == nil {
			*dest[0].(**string) = nil
			return nil
		}
		id := *linkedUserID
		*dest[0].(**string) = &id
		return nil
	}}
}

func scimRoleRow(role string, err error) pgx.Row {
	return scimLifecycleTestRow{scan: func(dest ...any) error {
		if err != nil {
			return err
		}
		*dest[0].(*string) = role
		return nil
	}}
}

func scimLifecycleUser(active bool) *User {
	return &User{
		ID:         "22222222-2222-4222-8222-222222222222",
		ExternalID: "idp-user-1",
		UserName:   "person@example.test",
		Active:     active,
	}
}

func TestUpdateAndSyncUserInTxRollsBackStatusFailure(t *testing.T) {
	statusErr := errors.New("forced linked status update failure")
	tx := &scimLifecycleTestTx{
		rows: []pgx.Row{scimUserUpdateRow(time.Now().UTC())},
		execResults: []scimLifecycleExecResult{{
			contains: "UPDATE users SET status",
			err:      statusErr,
		}},
	}

	_, err := (&Deps{}).updateAndSyncUserInTx(
		context.Background(), tx, "11111111-1111-4111-8111-111111111111",
		scimLifecycleUser(false), []byte(`{"active":false}`),
	)
	if !errors.Is(err, statusErr) {
		t.Fatalf("error = %v, want wrapped %v", err, statusErr)
	}
	if tx.commitCalls != 0 || tx.rollbackCalls != 1 {
		t.Fatalf("commit/rollback calls = %d/%d, want 0/1", tx.commitCalls, tx.rollbackCalls)
	}
}

func TestUpdateAndSyncUserInTxSurfacesRoleFailures(t *testing.T) {
	t.Run("role lookup", func(t *testing.T) {
		lookupErr := errors.New("forced role lookup failure")
		tx := &scimLifecycleTestTx{rows: []pgx.Row{
			scimUserUpdateRow(time.Now().UTC()),
			scimRoleRow("", lookupErr),
		}}

		_, err := (&Deps{}).updateAndSyncUserInTx(
			context.Background(), tx, "11111111-1111-4111-8111-111111111111",
			scimLifecycleUser(true), []byte(`{"active":true}`),
		)
		if !errors.Is(err, lookupErr) {
			t.Fatalf("error = %v, want wrapped %v", err, lookupErr)
		}
		if tx.commitCalls != 0 || tx.rollbackCalls != 1 {
			t.Fatalf("commit/rollback calls = %d/%d, want 0/1", tx.commitCalls, tx.rollbackCalls)
		}
		if len(tx.execs) != 1 || !strings.Contains(tx.execs[0], "UPDATE users SET status") {
			t.Fatalf("writes before lookup failure = %#v, want status update only", tx.execs)
		}
	})

	t.Run("role update", func(t *testing.T) {
		roleErr := errors.New("forced role update failure")
		tx := &scimLifecycleTestTx{
			rows: []pgx.Row{
				scimUserUpdateRow(time.Now().UTC()),
				scimRoleRow("admin", nil),
			},
			execResults: []scimLifecycleExecResult{{
				contains: "UPDATE users SET role",
				err:      roleErr,
			}},
		}

		_, err := (&Deps{}).updateAndSyncUserInTx(
			context.Background(), tx, "11111111-1111-4111-8111-111111111111",
			scimLifecycleUser(true), []byte(`{"active":true}`),
		)
		if !errors.Is(err, roleErr) {
			t.Fatalf("error = %v, want wrapped %v", err, roleErr)
		}
		if tx.commitCalls != 0 || tx.rollbackCalls != 1 {
			t.Fatalf("commit/rollback calls = %d/%d, want 0/1", tx.commitCalls, tx.rollbackCalls)
		}
	})
}

func TestUpdateAndSyncUserInTxSurfacesCommitFailure(t *testing.T) {
	commitErr := errors.New("forced lifecycle commit failure")
	tx := &scimLifecycleTestTx{
		rows:      []pgx.Row{scimUserUpdateRow(time.Now().UTC())},
		commitErr: commitErr,
	}

	_, err := (&Deps{}).updateAndSyncUserInTx(
		context.Background(), tx, "11111111-1111-4111-8111-111111111111",
		scimLifecycleUser(false), []byte(`{"active":false}`),
	)
	if !errors.Is(err, commitErr) {
		t.Fatalf("error = %v, want wrapped %v", err, commitErr)
	}
	if tx.commitCalls != 1 || tx.rollbackCalls != 1 {
		t.Fatalf("commit/rollback calls = %d/%d, want 1/1", tx.commitCalls, tx.rollbackCalls)
	}
}

func TestDeactivateSCIMUserInTxRollsBackLinkedUserFailures(t *testing.T) {
	linkedID := "33333333-3333-4333-8333-333333333333"

	t.Run("statement failure", func(t *testing.T) {
		statusErr := errors.New("forced delete cascade failure")
		tx := &scimLifecycleTestTx{
			rows: []pgx.Row{scimLinkedUserRow(&linkedID)},
			execResults: []scimLifecycleExecResult{{
				contains: "UPDATE users SET status",
				err:      statusErr,
			}},
		}

		err := deactivateSCIMUserInTx(
			context.Background(), tx, "11111111-1111-4111-8111-111111111111",
			"22222222-2222-4222-8222-222222222222",
		)
		if !errors.Is(err, statusErr) {
			t.Fatalf("error = %v, want wrapped %v", err, statusErr)
		}
		if tx.commitCalls != 0 || tx.rollbackCalls != 1 {
			t.Fatalf("commit/rollback calls = %d/%d, want 0/1", tx.commitCalls, tx.rollbackCalls)
		}
	})

	t.Run("linked row missing", func(t *testing.T) {
		tx := &scimLifecycleTestTx{
			rows: []pgx.Row{scimLinkedUserRow(&linkedID)},
			execResults: []scimLifecycleExecResult{{
				contains: "UPDATE users SET status",
				tag:      pgconn.NewCommandTag("UPDATE 0"),
			}},
		}

		err := deactivateSCIMUserInTx(
			context.Background(), tx, "11111111-1111-4111-8111-111111111111",
			"22222222-2222-4222-8222-222222222222",
		)
		if err == nil || !strings.Contains(err.Error(), "expected one row") {
			t.Fatalf("error = %v, want linked-row invariant failure", err)
		}
		if tx.commitCalls != 0 || tx.rollbackCalls != 1 {
			t.Fatalf("commit/rollback calls = %d/%d, want 0/1", tx.commitCalls, tx.rollbackCalls)
		}
	})
}

func TestDeactivateSCIMUserInTxSurfacesCommitFailure(t *testing.T) {
	commitErr := errors.New("forced delete commit failure")
	tx := &scimLifecycleTestTx{
		rows:      []pgx.Row{scimLinkedUserRow(nil)},
		commitErr: commitErr,
	}

	err := deactivateSCIMUserInTx(
		context.Background(), tx, "11111111-1111-4111-8111-111111111111",
		"22222222-2222-4222-8222-222222222222",
	)
	if !errors.Is(err, commitErr) {
		t.Fatalf("error = %v, want wrapped %v", err, commitErr)
	}
	if tx.commitCalls != 1 || tx.rollbackCalls != 1 {
		t.Fatalf("commit/rollback calls = %d/%d, want 1/1", tx.commitCalls, tx.rollbackCalls)
	}
}

type scimFailAfterStatusExecTx struct {
	scimUserTx
	err error
}

func (t *scimFailAfterStatusExecTx) Exec(
	ctx context.Context,
	sql string,
	args ...any,
) (pgconn.CommandTag, error) {
	tag, err := t.scimUserTx.Exec(ctx, sql, args...)
	if err != nil {
		return tag, err
	}
	if strings.Contains(sql, "UPDATE users SET status") {
		return tag, t.err
	}
	return tag, nil
}

// This live-database proof complements the narrow fake tests above. The
// injected failure is returned only after PostgreSQL has executed the linked
// users.status write, so the deferred rollback must undo both that write and
// the earlier scim_users mutation.
func TestSCIMUserLifecycleDatabaseRollbackIsAtomic(t *testing.T) {
	pool := newSCIMTestPool(t)
	tenantID, cleanupTenant := seedSCIMTenant(t, pool)
	defer cleanupTenant()

	ctx := context.Background()
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open seed transaction: %v", err)
	}
	var userID, scimUserID string
	originalEmail := "scim-lifecycle-" + randHex(t) + "@example.test"
	if err := seed.QueryRow(ctx, `
INSERT INTO users (tenant_id, email, role, status)
VALUES ($1::uuid, $2, 'viewer', 'active')
RETURNING id::text`, tenantID, originalEmail).Scan(&userID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed linked Moosewave user: %v", err)
	}
	if err := seed.QueryRow(ctx, `
INSERT INTO scim_users
    (tenant_id, external_id, user_id, user_name, active, raw)
VALUES ($1::uuid, $2, $3::uuid, $4, true, '{}'::jsonb)
RETURNING id::text`, tenantID, "idp-"+randHex(t), userID, originalEmail).Scan(&scimUserID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed SCIM user: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit SCIM lifecycle fixture: %v", err)
	}
	defer func() {
		cleanupCtx := context.Background()
		cleanup, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			return
		}
		_, _ = cleanup.Exec(cleanupCtx, `DELETE FROM scim_users WHERE id::text = $1`, scimUserID)
		_, _ = cleanup.Exec(cleanupCtx, `DELETE FROM users WHERE id::text = $1`, userID)
		_ = cleanup.Commit(cleanupCtx)
	}()

	assertOriginalState := func(t *testing.T) {
		t.Helper()
		verify, verifyErr := db.WithTenant(ctx, pool, tenantID)
		if verifyErr != nil {
			t.Fatalf("open verification transaction: %v", verifyErr)
		}
		defer func() { _ = verify.Rollback(ctx) }()
		var gotEmail, gotStatus string
		var gotActive bool
		if err := verify.QueryRow(ctx, `
SELECT s.user_name, s.active, u.status
  FROM scim_users s
  JOIN users u ON u.id = s.user_id
 WHERE s.tenant_id = $1::uuid AND s.id::text = $2`, tenantID, scimUserID).
			Scan(&gotEmail, &gotActive, &gotStatus); err != nil {
			t.Fatalf("read SCIM lifecycle state: %v", err)
		}
		if gotEmail != originalEmail || !gotActive || gotStatus != "active" {
			t.Fatalf("failed transaction leaked state: email=%q active=%v status=%q", gotEmail, gotActive, gotStatus)
		}
	}

	t.Run("replace or patch", func(t *testing.T) {
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("open lifecycle transaction: %v", err)
		}
		forcedErr := errors.New("forced post-status lifecycle failure")
		failingTx := &scimFailAfterStatusExecTx{scimUserTx: tx, err: forcedErr}
		u := &User{
			ID:         scimUserID,
			ExternalID: "idp-update",
			UserName:   "changed-" + originalEmail,
			Active:     false,
		}
		if _, err := (&Deps{}).updateAndSyncUserInTx(
			ctx, failingTx, tenantID, u, []byte(`{"active":false}`),
		); !errors.Is(err, forcedErr) {
			t.Fatalf("error = %v, want wrapped %v", err, forcedErr)
		}
		assertOriginalState(t)
	})

	t.Run("delete", func(t *testing.T) {
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("open delete transaction: %v", err)
		}
		forcedErr := errors.New("forced post-status delete failure")
		failingTx := &scimFailAfterStatusExecTx{scimUserTx: tx, err: forcedErr}
		if err := deactivateSCIMUserInTx(ctx, failingTx, tenantID, scimUserID); !errors.Is(err, forcedErr) {
			t.Fatalf("error = %v, want wrapped %v", err, forcedErr)
		}
		assertOriginalState(t)
	})
}
