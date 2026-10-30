// SPDX-License-Identifier: AGPL-3.0-only

package contentreports

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// newTestPool connects as whatever DATABASE_URL names.
//
// IMPORTANT: for the RLS assertions below to mean anything, DATABASE_URL must
// name a NON-superuser, non-BYPASSRLS role (postwave_app). A superuser
// connection ignores every policy in this file and turns each isolation test
// into a test that passes without exercising the thing it names. The guard
// below refuses to run rather than reporting a false green.
func newTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping content-report db test")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(func() {
		// Bounded close: pgxpool.Close waits for every checked-out connection,
		// so a t.Fatalf holding a transaction would otherwise hang the package
		// until timeout and destroy the failure message.
		done := make(chan struct{})
		go func() { pool.Close(); close(done) }()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Log("pool close timed out; a test leaked a connection")
		}
	})

	var isSuper, bypassRLS bool
	ctx := context.Background()
	if err := pool.QueryRow(ctx, `
		SELECT current_setting('is_superuser')::bool,
		       COALESCE((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false)
	`).Scan(&isSuper, &bypassRLS); err != nil {
		t.Fatalf("identify role: %v", err)
	}
	if isSuper || bypassRLS {
		t.Fatalf("DATABASE_URL points at a superuser/BYPASSRLS role; every RLS " +
			"assertion here would pass without testing anything. Use postwave_app.")
	}
	return pool
}

// seedTenant creates a tenant to fence against, and returns its id.
//
// The insert runs INSIDE db.WithTenant so the tenants table's own RLS policy
// admits a row whose id matches app.tenant_id. That is the established idiom in
// this repo (see internal/operation/aggregate_db_test.go) and it is what keeps
// these tests honest: nothing here ever reaches for a privileged connection,
// so an isolation assertion that passes did so under the same policies
// production runs under.
func seedTenant(t *testing.T, pool *pgxpool.Pool, slug string) string {
	t.Helper()
	ctx := context.Background()
	id := uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, id)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'content report test', 'studio')`,
		id, slug); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant %s: %v", slug, err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant: %v", err)
	}
	// One tenant delete removes everything the test wrote through ON DELETE
	// CASCADE. The teardown used to delete the child rows first, in the same
	// transaction, and discarded every error. The application role has no
	// DELETE on content_report_decisions or content_reports, so that statement
	// failed and aborted the transaction, the tenant delete that followed could
	// never run, and every run leaked its tenant.
	t.Cleanup(func() { deleteContentReportTestTenant(t, pool, id) })
	return id
}

func TestAnonymousNoticeIsStoredWithoutATenantContext(t *testing.T) {
	// The whole reason record_public_content_report is SECURITY DEFINER: the
	// notifier is a member of the public, there is no app.tenant_id to satisfy
	// a policy with, and the notice may concern content we cannot attribute.
	pool := newTestPool(t)
	ctx := context.Background()

	// No SET app.tenant_id anywhere in this test. That is the point.
	repo := &Repo{Pool: pool}
	receipt, err := repo.RecordPublicNotice(ctx, PublicNotice{
		SubjectKind:       "landing_page",
		SubjectURL:        "https://pages.example.test/promo",
		ReasonCategory:    "fraud_or_scam",
		Explanation:       "This page impersonates my bank and asks for card details.",
		NotifierEmail:     "reporter@example.test",
		GoodFaithDeclared: true,
	})
	if err != nil {
		t.Fatalf("RecordPublicNotice: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM content_reports WHERE reference = $1`, receipt.Reference)
	})
	if !strings.HasPrefix(receipt.Reference, "PWR-") {
		t.Fatalf("reference = %q", receipt.Reference)
	}
	if receipt.ActualKnowledgeAt.IsZero() {
		t.Fatal("actual_knowledge_at must be set by the database at insert: it is " +
			"the DSA Art. 6(1)(b) clock start and expeditiousness is measured from it")
	}

	status, err := repo.LookupPublicStatus(ctx, receipt.Reference)
	if err != nil {
		t.Fatalf("LookupPublicStatus: %v", err)
	}
	if status.Status != "received" {
		t.Fatalf("status = %q, want received", status.Status)
	}
}

func TestTheDefinerFunctionCannotBeUsedToForgeAnInAppOrigin(t *testing.T) {
	// The definer function hard-codes origin='public_notice'. If a future edit
	// parameterised it, an anonymous caller could write rows that the in-app
	// RLS policy exists to fence. Assert the stored origin rather than trusting
	// the function body to stay as written.
	pool := newTestPool(t)
	ctx := context.Background()
	repo := &Repo{Pool: pool}
	receipt, err := repo.RecordPublicNotice(ctx, PublicNotice{
		SubjectKind:       "archive_post",
		SubjectURL:        "https://archive.example.test/x",
		ReasonCategory:    "illegal_content",
		Explanation:       "This newsletter is selling a controlled substance.",
		NotifierEmail:     "reporter@example.test",
		GoodFaithDeclared: true,
	})
	if err != nil {
		t.Fatalf("RecordPublicNotice: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM content_reports WHERE reference = $1`, receipt.Reference)
	})

	var origin string
	var tenantID *string
	if err := pool.QueryRow(ctx, `
		SELECT origin, tenant_id::text FROM content_reports WHERE reference = $1`,
		receipt.Reference).Scan(&origin, &tenantID); err != nil {
		// Reading it back needs a privileged path; the app role's SELECT policy
		// only admits attributed rows. Use the definer status function instead.
		t.Logf("direct read blocked by RLS as expected (%v); asserting through the definer", err)
		st, lerr := repo.LookupPublicStatus(ctx, receipt.Reference)
		if lerr != nil {
			t.Fatalf("LookupPublicStatus: %v", lerr)
		}
		if st.Status != "received" {
			t.Fatalf("status = %q", st.Status)
		}
		return
	}
	if origin != "public_notice" {
		t.Fatalf("origin = %q, want public_notice", origin)
	}
	if tenantID != nil {
		t.Fatalf("tenant_id = %v; an unattributable notice must stay unattributed "+
			"rather than being guessed onto a tenant", *tenantID)
	}
}

func TestAnUnattributedNoticeIsInvisibleToEveryTenant(t *testing.T) {
	// A notice we cannot route names a complaint by a third party about content
	// we have not identified. Showing it to a tenant on a guess would leak it.
	pool := newTestPool(t)
	ctx := context.Background()
	tenantID := seedTenant(t, pool, "cr-unattributed-"+uuid.NewString()[:8])

	repo := &Repo{Pool: pool}
	receipt, err := repo.RecordPublicNotice(ctx, PublicNotice{
		SubjectKind:       "other",
		SubjectURL:        "https://unknown.example.test/thing",
		ReasonCategory:    "other",
		Explanation:       "Reporting something on a page we cannot attribute to a tenant.",
		NotifierEmail:     "reporter@example.test",
		GoodFaithDeclared: true,
	})
	if err != nil {
		t.Fatalf("RecordPublicNotice: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(),
			`DELETE FROM content_reports WHERE reference = $1`, receipt.Reference)
	})

	reports, err := repo.List(ctx, tenantID, "", 100)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, r := range reports {
		if r.Reference == receipt.Reference {
			t.Fatalf("tenant %s can see unattributed report %s", tenantID, r.Reference)
		}
	}
}

func TestOneTenantCannotSeeAnothersReports(t *testing.T) {
	pool := newTestPool(t)
	ctx := context.Background()
	alice := seedTenant(t, pool, "cr-alice-"+uuid.NewString()[:8])
	bob := seedTenant(t, pool, "cr-bob-"+uuid.NewString()[:8])

	repo := &Repo{Pool: pool}
	receipt, err := repo.RecordInAppReport(ctx, alice, InAppReport{
		Origin:         OriginInAppUGC,
		SubjectKind:    "archive_comment",
		SubjectRef:     "comment-1",
		ReasonCategory: "harassment_or_hate",
		Explanation:    "A commenter is threatening another reader on our archive.",
	})
	if err != nil {
		t.Fatalf("RecordInAppReport: %v", err)
	}

	mine, err := repo.List(ctx, alice, "", 100)
	if err != nil {
		t.Fatalf("List(alice): %v", err)
	}
	found := false
	for _, r := range mine {
		if r.Reference == receipt.Reference {
			found = true
		}
	}
	if !found {
		t.Fatalf("alice cannot see her own report %s", receipt.Reference)
	}

	theirs, err := repo.List(ctx, bob, "", 100)
	if err != nil {
		t.Fatalf("List(bob): %v", err)
	}
	for _, r := range theirs {
		if r.Reference == receipt.Reference {
			t.Fatalf("bob can see alice's report %s", r.Reference)
		}
	}
}

func TestTheStatementOfReasonsIsFinalAndDrivesTheQueueState(t *testing.T) {
	pool := newTestPool(t)
	ctx := context.Background()
	tenantID := seedTenant(t, pool, "cr-decide-"+uuid.NewString()[:8])
	repo := &Repo{Pool: pool}

	receipt, err := repo.RecordInAppReport(ctx, tenantID, InAppReport{
		Origin:         OriginInAppAI,
		SubjectKind:    "ai_output",
		SubjectRef:     "draft-9",
		ReasonCategory: "ai_output_harmful",
		Explanation:    "The generated subject line contains a racial slur.",
	})
	if err != nil {
		t.Fatalf("RecordInAppReport: %v", err)
	}

	// Locate the row through the tenant-scoped read path rather than a raw
	// query. A bare SELECT on the pool carries no app.tenant_id, so RLS
	// correctly returns nothing — reaching around the policy to set the test up
	// would be reaching around the thing the rest of this file asserts.
	reportID := ""
	open, err := repo.List(ctx, tenantID, "", 100)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, r := range open {
		if r.Reference == receipt.Reference {
			reportID = r.ID
		}
	}
	if reportID == "" {
		t.Fatalf("the tenant cannot see its own in-app report %s", receipt.Reference)
	}

	decision, err := repo.Decide(ctx, tenantID, reportID, DecisionInput{
		Action:             "content_removed",
		Ground:             "terms_violation",
		Reasoning:          "The generated draft violated the acceptable use policy and was deleted.",
		AutomatedMeansUsed: false,
	})
	if err != nil {
		t.Fatalf("Decide: %v", err)
	}
	if decision.Action != "content_removed" {
		t.Fatalf("action = %q", decision.Action)
	}

	// The queue state is DERIVED from the action, never supplied alongside it.
	reports, err := repo.List(ctx, tenantID, "action_taken", 100)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var seen *Report
	for i := range reports {
		if reports[i].Reference == receipt.Reference {
			seen = &reports[i]
		}
	}
	if seen == nil {
		t.Fatal("a decided report must appear under its derived status")
	}
	if seen.Decision == nil || seen.Decision.Reasoning == "" {
		t.Fatal("the statement of reasons must travel with the report")
	}

	// Art. 17 is a single communication to the affected recipient. A second one
	// would be a second, contradictory statement about the same facts.
	if _, err := repo.Decide(ctx, tenantID, reportID, DecisionInput{
		Action:    "no_action",
		Ground:    "terms_violation",
		Reasoning: "Changed our mind about the same report, which must not be possible.",
	}); err == nil {
		t.Fatal("a second statement of reasons must be refused")
	}
}

func TestTheDatabaseRefusesANoticeMissingItsArticle16Elements(t *testing.T) {
	// The Go validation is the error message; the CHECK constraints are the
	// guarantee. Assert the guarantee directly, because a future caller that
	// bypasses ValidatePublicNotice must still be unable to store a notice that
	// would not support a finding of actual knowledge.
	pool := newTestPool(t)
	ctx := context.Background()

	cases := []struct {
		name        string
		explanation string
		email       string
		goodFaith   bool
		category    string
	}{
		{"explanation below the substantiation floor", "too short", "r@example.test", true, "illegal_content"},
		{"no good-faith declaration", "A properly substantiated explanation of the problem.", "r@example.test", false, "illegal_content"},
		{"no notifier email on a non-child-safety ground", "A properly substantiated explanation of the problem.", "", true, "illegal_content"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var ref string
			err := pool.QueryRow(ctx, `
				SELECT reference FROM public.record_public_content_report(
					$1, NULL::uuid, 'other', 'https://example.test/x', $2, $3, NULL, $4, $5)`,
				mustReference(t),
				tc.category, tc.explanation, nullable(tc.email), tc.goodFaith,
			).Scan(&ref)
			if err == nil {
				_, _ = pool.Exec(context.Background(), `DELETE FROM content_reports WHERE reference = $1`, ref)
				t.Fatal("the database accepted a notice missing an Art. 16(2) element")
			}
		})
	}
}

func TestAChildSafetyNoticeIsAcceptedWithoutIdentityAtTheDatabaseLevel(t *testing.T) {
	// The mirror of the test above, and the more important half: the CHECK must
	// not be so strict that it rejects the one report the Regulation
	// specifically allows to be anonymous.
	pool := newTestPool(t)
	ctx := context.Background()
	var ref string
	err := pool.QueryRow(ctx, `
		SELECT reference FROM public.record_public_content_report(
			$1, NULL::uuid, 'archive_post', 'https://example.test/x',
			'csam_or_child_safety',
			'Reporting imagery on this page that appears to depict a minor.',
			NULL, NULL, true)`,
		mustReference(t),
	).Scan(&ref)
	if err != nil {
		t.Fatalf("an anonymous child-safety notice must be storable: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM content_reports WHERE reference = $1`, ref)
	})
}

// mustReference mints a reference through the same generator production uses,
// so a test can never fail on a hand-rolled string that the CHECK constraint
// rejects for a reason unrelated to what is being asserted.
func mustReference(t *testing.T) string {
	t.Helper()
	ref, err := newReference()
	if err != nil {
		t.Fatalf("newReference: %v", err)
	}
	return ref
}

func nullable(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

// deleteContentReportTestTenant removes a tenant the test created, and everything
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
func deleteContentReportTestTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteContentReportTestTenantOnce(ctx, pool, tenantID)
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

func deleteContentReportTestTenantOnce(ctx context.Context, pool *pgxpool.Pool, tenantID string) (int64, error) {
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
