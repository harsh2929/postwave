// SPDX-License-Identifier: AGPL-3.0-only
package forms

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A double-opt-in confirmation link must stop granting consent.
//
// The confirm path was `WHERE confirmation_token = $1 AND status = 'pending'`
// with no time predicate, so the link worked forever: a DOI email forwarded,
// archived, or recovered from a breach years later still granted marketing
// consent, and the consent record was dated to the click rather than to
// anything the subscriber had recently done.
//
// The divergence sits inside one product. `preference_tokens` has `expires_at`,
// a dedicated `ErrTokenExpired`, and a rendered expired page — this codebase had
// already decided a consent-bearing link must age out, and applied that decision
// to one of its two consent-bearing links.

func newFormsExpiryPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedPendingSubmission creates a pending DOI submission whose window is either
// still open or already closed.
// seedFormOnly creates a tenant and a published double-opt-in form.
func seedFormOnly(t *testing.T, pool *db.Pool) (tenantID, formID string) {
	t.Helper()
	ctx := context.Background()
	tenantID = uuid.NewString()
	formID = uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	for _, st := range []struct {
		q    string
		args []any
	}{
		{`INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'forms expiry', 'studio')`,
			[]any{tenantID, "forms-exp-" + tenantID[:8]}},
		{`INSERT INTO forms (id, tenant_id, name, slug, status, opt_in_mode) VALUES ($1::uuid, $2::uuid, 'f', $3, 'published', 'double')`,
			[]any{formID, tenantID, "f-" + formID[:8]}},
	} {
		if _, err := tx.Exec(ctx, st.q, st.args...); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	// One tenant delete removes the form, its submissions and any consent
	// events through ON DELETE CASCADE. The teardown used to delete those
	// child rows first and give up silently on the first error, so a refused
	// child delete (the application role cannot delete consent_events) stopped
	// it before the tenant delete ran, and the tenant leaked without a word.
	t.Cleanup(func() { deleteFormsTestTenant(t, pool, tenantID) })
	return tenantID, formID
}

func seedPendingSubmission(t *testing.T, pool *db.Pool, expired bool) (tenantID, token string) {
	t.Helper()
	ctx := context.Background()
	tenantID = uuid.NewString()
	token = "tok-" + uuid.NewString()
	formID := uuid.NewString()

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	for _, st := range []struct {
		q    string
		args []any
	}{
		{`INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'forms expiry', 'studio')`,
			[]any{tenantID, "forms-exp-" + tenantID[:8]}},
		{`INSERT INTO forms (id, tenant_id, name, slug, status, opt_in_mode) VALUES ($1::uuid, $2::uuid, 'f', $3, 'published', 'double')`,
			[]any{formID, tenantID, "f-" + formID[:8]}},
	} {
		if _, err := tx.Exec(ctx, st.q, st.args...); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed: %v", err)
		}
	}
	window := "now() + interval '30 days'"
	if expired {
		window = "now() - interval '1 day'"
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO form_submissions (form_id, tenant_id, email, confirmation_token, status, confirmation_expires_at)
		VALUES ($1::uuid, $2::uuid, $3, $4, 'pending', `+window+`)`,
		formID, tenantID, "doi-"+tenantID[:8]+"@example.test", token); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed submission: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	// See seedFormOnly: one tenant delete, reported if it fails.
	t.Cleanup(func() { deleteFormsTestTenant(t, pool, tenantID) })
	return tenantID, token
}

func TestAnExpiredConfirmationLinkDoesNotGrantConsent(t *testing.T) {
	pool := newFormsExpiryPool(t)
	_, token := seedPendingSubmission(t, pool, true)

	_, _, _, err := (&Repo{Pool: pool}).ConfirmByToken(context.Background(), token)
	if err == nil {
		t.Fatal("an expired confirmation link granted consent. A DOI email " +
			"forwarded or recovered years later must not still subscribe someone.")
	}
	if !errors.Is(err, ErrConfirmationExpired) {
		t.Fatalf("err = %v, want ErrConfirmationExpired. An expired link is a real "+
			"submission the person can repeat; reporting it as a missing token is "+
			"wrong and leaves them with nothing to do.", err)
	}
}

func TestAConfirmationLinkInsideItsWindowStillWorks(t *testing.T) {
	// The control. Without it an expiry that rejected everything would pass.
	pool := newFormsExpiryPool(t)
	_, token := seedPendingSubmission(t, pool, false)

	_, _, email, err := (&Repo{Pool: pool}).ConfirmByToken(context.Background(), token)
	if err != nil {
		t.Fatalf("a link inside its window was refused: %v", err)
	}
	if email == "" {
		t.Error("confirm returned no email")
	}
}

func TestAnUnknownTokenIsStillNotFound(t *testing.T) {
	// Expired and missing must stay distinguishable — they need different pages.
	pool := newFormsExpiryPool(t)
	_, _, _, err := (&Repo{Pool: pool}).ConfirmByToken(context.Background(), "tok-does-not-exist")
	if errors.Is(err, ErrConfirmationExpired) {
		t.Fatal("a nonexistent token was reported as expired")
	}
	if err == nil {
		t.Fatal("a nonexistent token confirmed something")
	}
}

func TestTheProductionInsertPathSetsTheWindow(t *testing.T) {
	// The gap a review found: every test above hand-writes
	// `confirmation_expires_at` in raw SQL, so replacing the CASE in
	// `InsertSubmission` with a literal NULL — which makes every FUTURE link
	// immortal, i.e. neutralises the change entirely — left the whole package
	// green. The behaviour was correct; nothing held it there.
	pool := newFormsExpiryPool(t)
	ctx := context.Background()
	tenantID, formID := seedFormOnly(t, pool)
	repo := &Repo{Pool: pool}

	tok, err := NewConfirmationToken()
	if err != nil {
		t.Fatalf("token: %v", err)
	}
	withToken, err := repo.InsertSubmission(ctx, tenantID, formID, Submission{
		FormID: formID, Email: "doi-window@example.test",
		Status: SubmissionPending, ConfirmationToken: tok,
	})
	if err != nil {
		t.Fatalf("insert with token: %v", err)
	}
	// And a single-opt-in row, which has no token and must get no window.
	noToken, err := repo.InsertSubmission(ctx, tenantID, formID, Submission{
		FormID: formID, Email: "single-optin@example.test", Status: SubmissionConfirmed,
	})
	if err != nil {
		t.Fatalf("insert without token: %v", err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var expires *string
	if err := tx.QueryRow(ctx, `
		SELECT confirmation_expires_at::text FROM form_submissions WHERE id = $1::uuid`,
		withToken).Scan(&expires); err != nil {
		t.Fatalf("read with-token row: %v", err)
	}
	if expires == nil {
		t.Error("a submission created WITH a confirmation token got no expiry. " +
			"Every new double-opt-in link is immortal, which is the whole defect.")
	}
	if err := tx.QueryRow(ctx, `
		SELECT confirmation_expires_at::text FROM form_submissions WHERE id = $1::uuid`,
		noToken).Scan(&expires); err != nil {
		t.Fatalf("read no-token row: %v", err)
	}
	if expires != nil {
		t.Errorf("a submission with NO token got an expiry (%s). There is no link "+
			"to expire, and a stamped window invites a later rule to act on it.", *expires)
	}
}

func TestAnUnsubscribedSubmissionIsNotReportedAsExpired(t *testing.T) {
	// The re-read only special-cased `confirmed`, so an unsubscribed row past
	// its window came back as ErrConfirmationExpired — telling someone who opted
	// OUT to "sign up again", and re-subscribing them if they followed it.
	pool := newFormsExpiryPool(t)
	ctx := context.Background()
	tenantID, token := seedPendingSubmission(t, pool, true)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE form_submissions SET status = 'unsubscribed' WHERE confirmation_token = $1`,
		token); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("unsubscribe: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	_, _, _, err = (&Repo{Pool: pool}).ConfirmByToken(ctx, token)
	if errors.Is(err, ErrConfirmationExpired) {
		t.Fatal("an UNSUBSCRIBED submission was reported as an expired link. The " +
			"advice that follows is \"sign up again\", which would re-subscribe " +
			"someone who deliberately opted out.")
	}
	if err == nil {
		t.Fatal("an unsubscribed submission confirmed")
	}
}

func TestResendReopensTheWindowBeforeMailing(t *testing.T) {
	// A resend reuses the SAME token, so without re-opening the window an
	// operator clicking "resend confirmation" on a 40-day-old pending submission
	// mails a link that is already dead — and is told `{"ok":true}`. It is the
	// only remedy the product offers besides re-submitting the form.
	pool := newFormsExpiryPool(t)
	ctx := context.Background()
	tenantID, token := seedPendingSubmission(t, pool, true)
	repo := &Repo{Pool: pool}

	// Precondition: the link is dead.
	if _, _, _, err := repo.ConfirmByToken(ctx, token); !errors.Is(err, ErrConfirmationExpired) {
		t.Fatalf("precondition: want an expired link, got %v", err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	var subID string
	if err := tx.QueryRow(ctx, `
		SELECT id::text FROM form_submissions WHERE confirmation_token = $1`, token).Scan(&subID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("find submission: %v", err)
	}
	_ = tx.Rollback(ctx)

	if err := repo.RefreshConfirmationWindow(ctx, tenantID, subID); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if _, _, _, err := repo.ConfirmByToken(ctx, token); err != nil {
		t.Fatalf("after a resend the link is still dead: %v. The operator was told "+
			"the confirmation was sent.", err)
	}
}

func TestRefreshingAWindowCannotReviveAConfirmedSubmission(t *testing.T) {
	// Scoped to `pending` so a resend cannot re-open a link for someone who has
	// already confirmed or unsubscribed.
	pool := newFormsExpiryPool(t)
	ctx := context.Background()
	tenantID, token := seedPendingSubmission(t, pool, true)
	repo := &Repo{Pool: pool}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	var subID string
	if err := tx.QueryRow(ctx, `
		SELECT id::text FROM form_submissions WHERE confirmation_token = $1`, token).Scan(&subID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("find: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE form_submissions SET status = 'unsubscribed' WHERE id = $1::uuid`, subID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("unsubscribe: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}

	if err := repo.RefreshConfirmationWindow(ctx, tenantID, subID); err != nil {
		t.Fatalf("refresh: %v", err)
	}

	// Asserted on the COLUMN, not on ConfirmByToken's error.
	//
	// Confirming an unsubscribed row fails anyway — the UPDATE's own
	// `status = 'pending'` predicate blocks it — so an error tells us nothing
	// about whether the window moved. A mutation removing the scope from
	// RefreshConfirmationWindow passed green until this checked the state
	// directly.
	tx2, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant tx: %v", err)
	}
	defer func() { _ = tx2.Rollback(ctx) }()
	var stillExpired bool
	if err := tx2.QueryRow(ctx, `
		SELECT confirmation_expires_at <= now() FROM form_submissions WHERE id = $1::uuid`,
		subID).Scan(&stillExpired); err != nil {
		t.Fatalf("read window: %v", err)
	}
	if !stillExpired {
		t.Fatal("a resend re-opened the confirmation window on an UNSUBSCRIBED " +
			"submission. The decision to opt out is closed; a resend must not " +
			"quietly make that person confirmable again.")
	}
}

// deleteFormsTestTenant removes a tenant the test created, and everything
// that cascades from it, in a transaction bound to that tenant. The tenants
// DELETE policy sees only the row whose id equals app.tenant_id, so a DELETE
// issued without that binding matches nothing and reports no error.
//
// It retries the whole transaction when Postgres reports its shared lock table
// full (SQLSTATE 53200) or picks it as a deadlock victim (40P01). One tenant
// delete cascades through every foreign key that references tenants(id), about
// 735 at migration head, and holds a lock on each of those tables and their
// indexes until commit. So a few concurrent deletes from other packages sharing
// the database can briefly exhaust the lock table, and one can deadlock with
// another package's DDL on a shared table (the consent tracking test's
// CREATE/DROP TRIGGER on audit_log, for one). Both clear on their own. Any other
// failure, or a delete that removes no row, fails the test, so a leaked tenant
// cannot go unnoticed.
func deleteFormsTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteFormsTestTenantOnce(ctx, pool, tenantID)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && (pgErr.Code == "53200" || pgErr.Code == "40P01") && ctx.Err() == nil {
			t.Logf("cleanup of tenant %s: %s (SQLSTATE %s), retrying in %v", tenantID, pgErr.Message, pgErr.Code, wait)
			time.Sleep(wait)
			continue
		}
		if err != nil {
			t.Errorf("cleanup of tenant %s: %v", tenantID, err)
		} else if removed != 1 {
			t.Errorf("cleanup of tenant %s removed %d tenant rows, want 1", tenantID, removed)
		}
		return
	}
}

func deleteFormsTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tag, err := tx.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), tx.Commit(ctx)
}
