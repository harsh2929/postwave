// SPDX-License-Identifier: AGPL-3.0-only
package integration_writeback

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/consent"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/segments"
)

// Writeback is a continuous PII EGRESS to a third party, and it did not ask
// whether the contact still consented.
//
// `ResolveAudience` read `segment_subscribers` — a materialized cache written
// under the DEFINITION population, which legitimately holds unsubscribed and
// archived people because "who matches this definition" is a different question
// from "who may we contact" — and filtered it on nothing but `s.email <> ''`.
// No status check, no consent gate, no archived exclusion. The scheduler runs
// targets on a one-minute tick, so every unsubscribed contact in a synced
// segment was re-exported to HubSpot/Salesforce/Klaviyo/Shopify indefinitely.
//
// What makes it a divergence rather than an oversight: the SAME repo resolves
// the SAME question correctly a few files away.
// `audience_destinations/sync_runner.go:525-529` explicitly refuses the cache —
// "Destination sync is an explicit export; serving a potentially stale
// materialized cache would be worse than failing the bounded run" — and compiles
// the live population predicate instead. Two implementations of one rule, built
// in the same codebase for the same purpose, and only one of them is right.

func newWritebackAudienceTestPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set; skipping writeback audience tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("connect to migrated test database: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

type writebackAudienceFixture struct {
	tenantID  string
	segmentID string
	consented string // enabled + genuinely consented — MUST be exported
	withdrawn string // blocklisted, consent cleared — must NOT be exported
	archived  string // archived — must NOT be exported
}

// seed builds a segment whose materialized cache contains all three people.
// That cache is CORRECT: it is written under the definition population, which
// includes people who no longer consent. The bug is reading it as if it were an
// activation audience.
func seedWritebackAudience(t *testing.T, pool *db.Pool) writebackAudienceFixture {
	t.Helper()
	ctx := context.Background()
	f := writebackAudienceFixture{
		tenantID:  uuid.NewString(),
		segmentID: uuid.NewString(),
		consented: "wb-ok-" + uuid.NewString()[:8] + "@example.test",
		withdrawn: "wb-gone-" + uuid.NewString()[:8] + "@example.test",
		archived:  "wb-arch-" + uuid.NewString()[:8] + "@example.test",
	}

	tx, err := db.WithTenant(ctx, pool, f.tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
		INSERT INTO tenants (id, name, slug, tier)
		VALUES ($1::uuid, 'wb-audience-test', 'wb-audience-' || $1::text, 'studio')`,
		f.tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}

	// A segment matching everyone, so the ONLY thing that can exclude a member
	// is the population scope — not the definition.
	ast := json.RawMessage(`{"op":"and","children":[{"op":"condition","field":"email","comparator":"is_not_null"}]}`)
	if _, err := tx.Exec(ctx, `
		INSERT INTO segments (id, tenant_id, name, query_ast)
		VALUES ($1::uuid, $2::uuid, 'wb-audience', $3::jsonb)`,
		f.segmentID, f.tenantID, string(ast)); err != nil {
		t.Fatalf("seed segment: %v", err)
	}

	type person struct {
		email      string
		status     string
		consent    bool
		isArchived bool
	}
	for _, p := range []person{
		{f.consented, "enabled", true, false},
		{f.withdrawn, "blocklisted", false, false},
		{f.archived, "enabled", true, true},
	} {
		var id string
		if err := tx.QueryRow(ctx, `
			INSERT INTO subscribers (tenant_id, email, primary_email, status,
			                         mailchimp_status, consent_source, archived_at)
			VALUES ($1::uuid, $2::citext, $2::citext, $3,
			        CASE WHEN $4 THEN 'subscribed' ELSE 'unsubscribed' END, 'api',
			        CASE WHEN $5 THEN now() END)
			RETURNING id::text`,
			f.tenantID, p.email, p.status, p.consent, p.isArchived).Scan(&id); err != nil {
			t.Fatalf("seed subscriber %s: %v", p.email, err)
		}
		// A REAL grant, through the production consent chain.
		//
		// An earlier version of this fixture granted consent to nobody, on the
		// stated grounds that migration 1766 made the column unreachable from a
		// test. That was false — `internal/segments/consent_fixture_test.go` does
		// it in one transaction — and the false claim was load-bearing: with
		// nobody consenting, the activation population was empty, BOTH comparison
		// loops iterated zero times, and a review proved the tests stayed green
		// with the query body replaced by `WHERE false`. They could detect an
		// audience that was too big and not one that was empty, which is the
		// total-outage regression this rewrite is most likely to cause.
		seedWritebackConsent(t, ctx, tx, f.tenantID, id, p.email, p.consent)
		if _, err := tx.Exec(ctx, `
			INSERT INTO segment_subscribers (tenant_id, segment_id, subscriber_id, computed_at)
			VALUES ($1::uuid, $2::uuid, $3::uuid, now())`,
			f.tenantID, f.segmentID, id); err != nil {
			t.Fatalf("materialize %s: %v", p.email, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit fixture: %v", err)
	}
	// One tenant delete removes everything the fixture wrote through ON DELETE
	// CASCADE. The teardown used to delete the child rows first and give up
	// silently on the first error, so any child delete the application role
	// is not granted (or a guard refuses) stopped it before the tenant delete
	// ran, and the tenant leaked without a word.
	t.Cleanup(func() { deleteWritebackTestTenant(t, pool, f.tenantID) })
	return f
}

func emailsOf(members []AudienceMember) map[string]bool {
	out := map[string]bool{}
	for _, m := range members {
		out[strings.ToLower(m.Email)] = true
	}
	return out
}

// activationMembers computes the audience the way the implementation that gets
// this right already does — `audience_destinations/sync_runner.go:546` — by
// compiling the segment's live definition under the activation population
// instead of reading the materialized cache.
func activationMembers(t *testing.T, pool *db.Pool, tenantID, segmentID string) map[string]bool {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var ast json.RawMessage
	if err := tx.QueryRow(ctx, `
		SELECT query_ast FROM segments WHERE tenant_id = $1::uuid AND id = $2::uuid`,
		tenantID, segmentID).Scan(&ast); err != nil {
		t.Fatalf("load segment: %v", err)
	}
	predicate, err := segments.CompilePopulation(ctx, ast, tenantID,
		segments.TransactionSegmentResolver{Queryer: tx},
		segments.ActivationPopulation(segments.ActivationChannelEmail))
	if err != nil {
		t.Fatalf("compile activation population: %v", err)
	}
	rows, err := tx.Query(ctx,
		`SELECT email::text FROM subscribers WHERE `+predicate.SQL, predicate.Args...)
	if err != nil {
		t.Fatalf("resolve activation members: %v", err)
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out[strings.ToLower(email)] = true
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate: %v", err)
	}
	return out
}

func cachedMemberCount(t *testing.T, pool *db.Pool, tenantID, segmentID string) int {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM segment_subscribers
		 WHERE tenant_id = $1::uuid AND segment_id = $2::uuid`,
		tenantID, segmentID).Scan(&n); err != nil {
		t.Fatalf("count cache: %v", err)
	}
	return n
}

func TestWritebackAgreesWithTheImplementationThatGetsThisRight(t *testing.T) {
	// The whole finding in one assertion. `integration_writeback.ResolveAudience`
	// and `audience_destinations`' sync runner answer the same question — who may
	// we export to a third party — and they answered it differently: one compiled
	// the live activation population, the other read `segment_subscribers` raw and
	// filtered on `s.email <> ''`.
	//
	// This needs no consent grant in the fixture, which is what makes it robust:
	// it asserts the two implementations agree on whatever the population rules
	// currently are, so it keeps holding when those rules change.
	pool := newWritebackAudienceTestPool(t)
	f := seedWritebackAudience(t, pool)

	members, err := (&Repo{Pool: pool}).ResolveAudience(context.Background(), f.tenantID, &Target{
		ID: uuid.NewString(), TenantID: f.tenantID, Provider: "hubspot",
		Settings: map[string]any{"source_segment_id": f.segmentID},
	})
	if err != nil {
		t.Fatalf("resolve audience: %v", err)
	}
	got := emailsOf(members)
	want := activationMembers(t, pool, f.tenantID, f.segmentID)

	for email := range got {
		if !want[email] {
			t.Errorf("writeback would export %s, whom the activation population "+
				"excludes. This is a continuous third-party PII egress of a contact "+
				"who may not be contacted, repeated on every scheduler tick.", email)
		}
	}
	for email := range want {
		if !got[email] {
			t.Errorf("writeback withheld %s, whom the activation population includes. "+
				"Over-withholding is a quieter bug than over-sending but still a "+
				"disagreement between two implementations of one rule.", email)
		}
	}

	// Anti-vacuous: the cache genuinely holds people the audience must not. If
	// these were equal the agreement above would be satisfiable by any two
	// implementations that both returned everything.
	if cached := cachedMemberCount(t, pool, f.tenantID, f.segmentID); cached <= len(got) {
		t.Fatalf("the materialized cache holds %d rows and the audience %d — the "+
			"fixture no longer contains anyone the gate must exclude, so this test "+
			"can no longer detect an ungated read", cached, len(got))
	}
}

func TestWritebackExcludesBlocklistedAndArchivedContacts(t *testing.T) {
	// The named exclusions, asserted individually so a failure says WHICH rule
	// stopped being applied rather than only that two sets differ.
	pool := newWritebackAudienceTestPool(t)
	f := seedWritebackAudience(t, pool)

	members, err := (&Repo{Pool: pool}).ResolveAudience(context.Background(), f.tenantID, &Target{
		ID: uuid.NewString(), TenantID: f.tenantID, Provider: "hubspot",
		Settings: map[string]any{"source_segment_id": f.segmentID},
	})
	if err != nil {
		t.Fatalf("resolve audience: %v", err)
	}
	got := emailsOf(members)

	if got[strings.ToLower(f.withdrawn)] {
		t.Errorf("writeback exported %s, who is blocklisted. The materialized cache "+
			"legitimately holds them — definition membership is not eligibility — "+
			"and reading it as an audience is what makes this an egress bug.",
			f.withdrawn)
	}
	if got[strings.ToLower(f.archived)] {
		t.Errorf("writeback exported %s, who is archived. Archived profiles are "+
			"excluded from every activation population by contract.", f.archived)
	}
	// The positive control, and the anti-vacuous guard. Without it this test
	// passes over an audience that returns NOTHING — a review proved the earlier
	// version stayed green with the query body replaced by `WHERE false`, so it
	// could detect an over-export and never the total outage this rewrite is most
	// likely to cause.
	if !got[strings.ToLower(f.consented)] {
		t.Fatalf("writeback withheld %s, who is enabled, unarchived and holds a "+
			"proven email-marketing grant. Gating is only correct if it still lets "+
			"the eligible through; a gate that withholds everyone is an outage.",
			f.consented)
	}
}

// seedWritebackConsent grants email-marketing consent through the same chain the
// production writer uses: an address projection, a consent event, and a paired
// consent record carrying the event id as evidence.
//
// Migration 1766 rejects a direct write to `consent_email_marketing_at`, and an
// event alone is not enough — `subscriber_email_latest_decision_detail` treats an
// unpaired grant as invalid and fails closed. Only the full chain reaches
// `consent_reconciliation_state = 'proven'`, which is what the activation gate
// requires.
func seedWritebackConsent(t *testing.T, ctx context.Context, tx pgx.Tx,
	tenantID, subscriberID, email string, granted bool) {
	t.Helper()
	// Always inserted as `never_subscribed`. RLS
	// (`subscriber_emails_nonexpired_positive_visibility`) rejects writing
	// `subscribed` directly — the address is PROMOTED by the consent chain
	// below, which is the whole point of migration 1766's hardening.
	var addressID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO subscriber_emails
		       (tenant_id, subscriber_id, email, is_primary, consent_status, suppressed)
		VALUES ($1::uuid, $2::uuid, $3::citext, true, 'never_subscribed', false)
		RETURNING id::text`,
		tenantID, subscriberID, email).Scan(&addressID); err != nil {
		t.Fatalf("seed address %s: %v", email, err)
	}
	if !granted {
		return
	}
	occurredAt := time.Now().UTC().Truncate(time.Microsecond)
	const policy = "writeback-audience-test-v1"
	const proof = "Reviewed exact-address grant for writeback audience testing."
	eventID, err := consent.RecordEventInTx(ctx, tx, consent.EventInput{
		TenantID: tenantID, SubjectType: "subscriber", SubjectID: addressID,
		SubjectEmail: email, Channel: "email", Category: "email_marketing",
		Action: "granted", Source: "double_optin", PolicyVersion: policy,
		ProofText: proof,
		Preferences: map[string]any{
			"legal_basis": "consent", "jurisdiction": "US",
			"reason": "Writeback audience database fixture", "operation": "writeback_audience_fixture",
			"subscriber_id": subscriberID, "address_id": addressID,
			"consent_status": "subscribed",
		},
		OccurredAt: &occurredAt,
	})
	if err != nil {
		t.Fatalf("seed consent event %s: %v", email, err)
	}
	evidence, err := json.Marshal(map[string]any{
		"event_id": eventID, "address_id": addressID,
		"operation": "writeback_audience_fixture", "legal_basis": "consent",
		"jurisdiction": "US", "reason": "Writeback audience database fixture",
		"policy_version": policy, "evidence": proof,
	})
	if err != nil {
		t.Fatalf("encode proof: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO consent_records
		       (tenant_id, subscriber_id, email, channel, consent_status, source,
		        captured_at, evidence)
		VALUES ($1::uuid, $2::uuid, $3::citext, 'email', 'granted', 'double_optin',
		        $4::timestamptz, $5::jsonb)`,
		tenantID, subscriberID, email, occurredAt, string(evidence)); err != nil {
		t.Fatalf("seed consent record %s: %v", email, err)
	}
}

// deleteWritebackTestTenant removes a tenant the test created, and everything
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
func deleteWritebackTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteWritebackTestTenantOnce(ctx, pool, tenantID)
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

func deleteWritebackTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
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
