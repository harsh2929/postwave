// SPDX-License-Identifier: AGPL-3.0-only

package feedback

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/transactional"
)

// A transactional sender must be able to learn that their message failed.
//
// Before this, a receipt that hard-bounced left `transactional_emails.status`
// reading `sent` forever: the feedback pipeline resolved the tenant from
// `provider_message_id`, suppressed the address, and threw away which message
// the event was about. `GET /api/v1/emails/{id}` reported a success that did
// not happen, and no webhook said otherwise.

func outcomePool(t *testing.T) *db.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping transactional outcome test")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("db.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedTransactional creates a tenant and one transactional_emails row already
// marked sent, with the provider's message id — the state every one of these
// events arrives to find.
func seedTransactional(t *testing.T, pool *db.Pool, providerMessageID, recipient string) (tenantID, emailID string) {
	t.Helper()
	ctx := context.Background()
	tenantID = uuid.NewString()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier) VALUES ($1::uuid, $2, 'txo', 'studio')`,
		tenantID, "txo-"+tenantID[:8]); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.QueryRow(ctx, `
INSERT INTO transactional_emails
    (tenant_id, from_addr, to_addrs, subject, status, provider_message_id, sent_at)
VALUES ($1::uuid, 'billing@shop.test', ARRAY[$2], 'Your receipt', 'sent', $3, now())
RETURNING id::text`, tenantID, recipient, providerMessageID).Scan(&emailID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed transactional email: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit seed: %v", err)
	}
	// One tenant delete removes everything the test wrote through ON DELETE
	// CASCADE. The teardown used to delete the child rows first, in the same
	// transaction, and discarded every error. The application role has no
	// DELETE on bounce_events, so that statement failed and aborted the
	// transaction, the tenant delete that followed could never run, and every
	// run leaked its tenant.
	t.Cleanup(func() { deleteOutcomeTestTenant(t, pool, tenantID) })
	return tenantID, emailID
}

func outcomesFor(t *testing.T, pool *db.Pool, tenantID, emailID string) map[string]string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("WithTenant: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT outcome, recipient FROM transactional_email_outcomes
 WHERE tenant_id = $1::uuid AND email_id = $2::uuid`, tenantID, emailID)
	if err != nil {
		t.Fatalf("query outcomes: %v", err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var outcome, recipient string
		if err := rows.Scan(&outcome, &recipient); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out[outcome] = recipient
	}
	return out
}

func TestAHardBounceTellsTheMessageItFailed(t *testing.T) {
	pool := outcomePool(t)
	ctx := context.Background()
	const espID = "0100018f-hardbounce-0001"
	const recipient = "gone@example.test"
	tenantID, emailID := seedTransactional(t, pool, espID, recipient)
	repo := &Repo{Pool: pool}

	if err := repo.RecordBounce(ctx, tenantID, BounceEvent{
		SubscriberEmail: recipient,
		BounceType:      "hard",
		ESP:             "ses",
		ESPMessageID:    espID,
		Raw:             json.RawMessage(`{"diagnostic_code":"5.1.1 no such user"}`),
		ReceivedAt:      time.Now().UTC(),
	}); err != nil {
		t.Fatalf("RecordBounce: %v", err)
	}

	got := outcomesFor(t, pool, tenantID, emailID)
	if got["bounced"] != recipient {
		t.Fatalf("outcomes = %v; the bounce did not reach the message it was about, "+
			"so GET /api/v1/emails/%s still reports this send as successful", got, emailID)
	}
}

// A soft bounce is `deferred`, not `bounced`. Reporting a full mailbox as a
// permanent failure would have senders purging addresses that work.
func TestASoftBounceIsRecordedAsDeferredNotFailed(t *testing.T) {
	pool := outcomePool(t)
	ctx := context.Background()
	const espID = "0100018f-softbounce-0001"
	const recipient = "full@example.test"
	tenantID, emailID := seedTransactional(t, pool, espID, recipient)
	repo := &Repo{Pool: pool}

	if err := repo.RecordBounce(ctx, tenantID, BounceEvent{
		SubscriberEmail: recipient,
		BounceType:      "soft",
		ESP:             "ses",
		ESPMessageID:    espID,
		Raw:             json.RawMessage(`{"diagnostic_code":"4.2.2 mailbox full"}`),
		ReceivedAt:      time.Now().UTC(),
	}); err != nil {
		t.Fatalf("RecordBounce: %v", err)
	}

	got := outcomesFor(t, pool, tenantID, emailID)
	if _, bounced := got["bounced"]; bounced {
		t.Fatal("a soft bounce was recorded as a permanent failure; a sender acting " +
			"on this would delete an address whose mailbox was merely full")
	}
	if got["deferred"] != recipient {
		t.Fatalf("outcomes = %v, want a deferred entry — a single soft bounce "+
			"suppresses nothing, and it is still why this message did not arrive", got)
	}
}

func TestAComplaintReachesTheMessage(t *testing.T) {
	pool := outcomePool(t)
	ctx := context.Background()
	const espID = "0100018f-complaint-0001"
	const recipient = "annoyed@example.test"
	tenantID, emailID := seedTransactional(t, pool, espID, recipient)
	repo := &Repo{Pool: pool}

	if err := repo.RecordComplaint(ctx, tenantID, ComplaintEvent{
		SubscriberEmail: recipient,
		ComplaintType:   "spam",
		ESP:             "ses",
		ESPMessageID:    espID,
		ReceivedAt:      time.Now().UTC(),
	}); err != nil {
		t.Fatalf("RecordComplaint: %v", err)
	}
	if got := outcomesFor(t, pool, tenantID, emailID); got["complained"] != recipient {
		t.Fatalf("outcomes = %v, want a complained entry", got)
	}
}

// The overwhelmingly common case: feedback about a CAMPAIGN send, which owns
// its own per-recipient records. It must pass through without error — an
// unmatched ESP id is normal, not a failure.
func TestFeedbackAboutSomethingElseStillSucceeds(t *testing.T) {
	pool := outcomePool(t)
	ctx := context.Background()
	tenantID, emailID := seedTransactional(t, pool, "0100018f-unrelated-0001", "someone@example.test")
	repo := &Repo{Pool: pool}

	if err := repo.RecordBounce(ctx, tenantID, BounceEvent{
		SubscriberEmail: "campaign-recipient@example.test",
		BounceType:      "hard",
		ESP:             "ses",
		ESPMessageID:    "an-id-belonging-to-a-campaign-send",
		ReceivedAt:      time.Now().UTC(),
	}); err != nil {
		t.Fatalf("a bounce that matches no transactional message must still record: %v", err)
	}
	if got := outcomesFor(t, pool, tenantID, emailID); len(got) != 0 {
		t.Fatalf("outcomes = %v; an unrelated bounce was projected onto a message "+
			"it had nothing to do with", got)
	}
}

// Providers redeliver. The first time we heard about a failure is the fact
// worth keeping, so a repeat must not rewrite it — and must not double-report.
func TestARedeliveredBounceDoesNotDuplicateTheOutcome(t *testing.T) {
	pool := outcomePool(t)
	ctx := context.Background()
	const espID = "0100018f-redelivered-0001"
	const recipient = "gone@example.test"
	tenantID, emailID := seedTransactional(t, pool, espID, recipient)
	repo := &Repo{Pool: pool}

	first := time.Now().UTC().Add(-time.Hour)
	ev := BounceEvent{
		SubscriberEmail: recipient,
		BounceType:      "hard",
		ESP:             "ses",
		ESPMessageID:    espID,
		ReceivedAt:      first,
	}
	if err := repo.RecordBounce(ctx, tenantID, ev); err != nil {
		t.Fatalf("first: %v", err)
	}
	ev.ReceivedAt = time.Now().UTC()
	if err := repo.RecordBounce(ctx, tenantID, ev); err != nil {
		t.Fatalf("redelivery: %v", err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	var occurredAt time.Time
	if err := tx.QueryRow(ctx, `
SELECT count(*), min(occurred_at) FROM transactional_email_outcomes
 WHERE tenant_id = $1::uuid AND email_id = $2::uuid`, tenantID, emailID).Scan(&n, &occurredAt); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Fatalf("%d outcome rows after one redelivered bounce; the integrator "+
			"receives the same failure twice", n)
	}
	if occurredAt.Sub(first).Abs() > time.Second {
		t.Fatalf("occurred_at moved to the redelivery time (%v, want ~%v); when the "+
			"failure was first observed is the fact this column exists to hold",
			occurredAt, first)
	}
}

// The API must actually SAY it. A projection nothing surfaces is a table.
//
// This crosses the package boundary on purpose: the outcome is written by
// feedback and read by transactional, and a test on either side alone passes
// while the two disagree about the table.
func TestTheApiReportsTheBounceOnTheMessage(t *testing.T) {
	pool := outcomePool(t)
	ctx := context.Background()
	const espID = "0100018f-readback-0001"
	const recipient = "gone@example.test"
	tenantID, emailID := seedTransactional(t, pool, espID, recipient)

	if err := (&Repo{Pool: pool}).RecordBounce(ctx, tenantID, BounceEvent{
		SubscriberEmail: recipient,
		BounceType:      "hard",
		ESP:             "ses",
		ESPMessageID:    espID,
		Raw:             json.RawMessage(`{"diagnostic_code":"5.1.1 no such user"}`),
		ReceivedAt:      time.Now().UTC(),
	}); err != nil {
		t.Fatalf("RecordBounce: %v", err)
	}

	rec, err := (&transactional.Repo{Pool: pool}).Get(ctx, tenantID, emailID)
	if err != nil {
		t.Fatalf("transactional Get: %v", err)
	}
	// The submission still succeeded, and the response must keep saying so —
	// overwriting status would lose the fact that we did send it.
	if rec.Status != "sent" {
		t.Fatalf("status = %q, want it unchanged at \"sent\"; the outcome describes "+
			"the mailbox, not our submission", rec.Status)
	}
	if len(rec.Outcomes) != 1 {
		t.Fatalf("outcomes = %+v; GET /api/v1/emails/{id} still reports this send "+
			"as an unqualified success", rec.Outcomes)
	}
	got := rec.Outcomes[0]
	if got.Outcome != "bounced" || got.Recipient != recipient {
		t.Fatalf("outcome = %+v, want bounced for %s", got, recipient)
	}
	if got.Reason == "" {
		t.Fatal("no reason surfaced; an operator reading a support ticket gets " +
			"\"it bounced\" with no way to tell a dead mailbox from a blocked domain")
	}
}

func TestDeliveryProjectionCommitsOutcomeAndWebhookReceiptExactlyOnce(t *testing.T) {
	pool := outcomePool(t)
	ctx := context.Background()
	const providerMessageID = "0100018f-delivered-0001"
	const recipient = "arrived@example.test"
	tenantID, emailID := seedTransactional(t, pool, providerMessageID, recipient)
	repo := &Repo{Pool: pool}
	first := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)

	project := func(at time.Time) {
		t.Helper()
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("WithTenant: %v", err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if err := repo.ProjectTransactionalOutcome(ctx, tx, tenantID, TransactionalProviderOutcome{
			ProviderMessageID: providerMessageID,
			Recipients:        []string{recipient, " " + recipient + " "},
			Outcome:           "delivered",
			Reason:            "250 2.0.0 accepted",
			ESP:               "ses",
			OccurredAt:        at,
		}); err != nil {
			t.Fatalf("ProjectTransactionalOutcome: %v", err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatalf("commit projection: %v", err)
		}
	}

	project(first)
	project(first.Add(time.Hour)) // provider retry must be a no-op

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var (
		outcomes int
		receipts int
		storedAt time.Time
	)
	if err := tx.QueryRow(ctx, `
SELECT count(*), min(occurred_at)
  FROM transactional_email_outcomes
 WHERE tenant_id=$1::uuid AND email_id=$2::uuid AND outcome='delivered'`,
		tenantID, emailID).Scan(&outcomes, &storedAt); err != nil {
		t.Fatalf("read delivered outcome: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*)
  FROM outbound_webhook_event_receipts
 WHERE tenant_id=$1::uuid AND event_type='email.delivered'`, tenantID).Scan(&receipts); err != nil {
		t.Fatalf("read delivered fanout receipt: %v", err)
	}
	if outcomes != 1 || receipts != 1 {
		t.Fatalf("outcomes/receipts = %d/%d, want 1/1", outcomes, receipts)
	}
	if !storedAt.Equal(first) {
		t.Fatalf("occurred_at = %v, want first provider occurrence %v", storedAt, first)
	}
}

func TestDeliveryProjectionRollsBackOutcomeAndFanoutTogether(t *testing.T) {
	pool := outcomePool(t)
	ctx := context.Background()
	const providerMessageID = "0100018f-delivery-rollback-0001"
	const recipient = "rollback@example.test"
	tenantID, emailID := seedTransactional(t, pool, providerMessageID, recipient)

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if err := (&Repo{Pool: pool}).ProjectTransactionalOutcome(ctx, tx, tenantID, TransactionalProviderOutcome{
		ProviderMessageID: providerMessageID,
		Recipients:        []string{recipient},
		Outcome:           "delivered",
		OccurredAt:        time.Now().UTC(),
	}); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("ProjectTransactionalOutcome: %v", err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("rollback: %v", err)
	}

	check, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = check.Rollback(ctx) }()
	var outcomes, receipts int
	if err := check.QueryRow(ctx, `
SELECT count(*) FROM transactional_email_outcomes
 WHERE tenant_id=$1::uuid AND email_id=$2::uuid`, tenantID, emailID).Scan(&outcomes); err != nil {
		t.Fatal(err)
	}
	if err := check.QueryRow(ctx, `
SELECT count(*) FROM outbound_webhook_event_receipts
 WHERE tenant_id=$1::uuid AND event_type='email.delivered'`, tenantID).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if outcomes != 0 || receipts != 0 {
		t.Fatalf("rolled-back outcomes/receipts = %d/%d, want 0/0", outcomes, receipts)
	}
}

func TestAmbiguousProviderMessageIDFailsClosed(t *testing.T) {
	pool := outcomePool(t)
	ctx := context.Background()
	const providerMessageID = "0100018f-ambiguous-0001"
	const recipient = "ambiguous@example.test"
	tenantID, _ := seedTransactional(t, pool, providerMessageID, recipient)

	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO transactional_emails
    (tenant_id, from_addr, to_addrs, subject, status, provider_message_id, sent_at)
VALUES ($1::uuid, 'billing@shop.test', ARRAY[$2], 'Duplicate receipt', 'sent', $3, now())`,
		tenantID, recipient, providerMessageID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed duplicate message identity: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	err = (&Repo{Pool: pool}).ProjectTransactionalOutcome(ctx, tx, tenantID, TransactionalProviderOutcome{
		ProviderMessageID: providerMessageID,
		Recipients:        []string{recipient},
		Outcome:           "delivered",
	})
	_ = tx.Rollback(ctx)
	if !errors.Is(err, errAmbiguousProviderMessageID) {
		t.Fatalf("ambiguous projection error = %v, want %v", err, errAmbiguousProviderMessageID)
	}
}

func TestProviderMessageTenantResolutionRequiresOneDistinctOwner(t *testing.T) {
	pool := outcomePool(t)
	ctx := context.Background()
	providerMessageID := "0100018f-cross-tenant-" + uuid.NewString()
	firstTenant, _ := seedTransactional(t, pool, providerMessageID, "first@example.test")
	repo := &Repo{Pool: pool}

	resolved, err := repo.LookupTenantByESPMessageID(ctx, providerMessageID)
	if err != nil {
		t.Fatalf("resolve one owner: %v", err)
	}
	if resolved != firstTenant {
		t.Fatalf("one-owner resolution = %q, want %q", resolved, firstTenant)
	}

	secondTenant, _ := seedTransactional(t, pool, providerMessageID, "second@example.test")
	if secondTenant == firstTenant {
		t.Fatal("fixture produced duplicate tenant ids")
	}
	resolved, err = repo.LookupTenantByESPMessageID(ctx, providerMessageID)
	if err != nil {
		t.Fatalf("resolve ambiguous owner: %v", err)
	}
	if resolved != "" {
		t.Fatalf("cross-tenant ambiguous provider id resolved to %q", resolved)
	}
}

func TestCampaignProviderMessageIsNotTreatedAsPendingTransactional(t *testing.T) {
	pool := outcomePool(t)
	ctx := context.Background()
	campaignProviderID := "campaign-provider-" + uuid.NewString()
	tenantID, _ := seedTransactional(
		t, pool, "unrelated-transactional-"+uuid.NewString(), "receipt@example.test",
	)
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO outbox_events (tenant_id, kind, payload)
VALUES ($1::uuid, 'test.campaign.send', jsonb_build_object('esp_message_id', $2::text))`,
		tenantID, campaignProviderID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatal(err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := (&Repo{Pool: pool}).ProjectTransactionalOutcome(
		ctx, tx, tenantID, TransactionalProviderOutcome{
			ProviderMessageID: campaignProviderID,
			Recipients:        []string{"campaign-reader@example.test"},
			Outcome:           "delivered",
		},
	); err != nil {
		t.Fatalf("campaign evidence returned transactional retry: %v", err)
	}
	var outcomes int
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM transactional_email_outcomes WHERE tenant_id=$1::uuid`, tenantID).Scan(&outcomes); err != nil {
		t.Fatal(err)
	}
	if outcomes != 0 {
		t.Fatalf("campaign delivery created %d transactional outcomes", outcomes)
	}
}

// deleteOutcomeTestTenant removes a tenant the test created, and everything
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
func deleteOutcomeTestTenant(t *testing.T, pool *db.Pool, tenantID string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for wait := 50 * time.Millisecond; ; wait = min(2*wait, 2*time.Second) {
		removed, err := deleteOutcomeTestTenantOnce(ctx, pool, tenantID)
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

func deleteOutcomeTestTenantOnce(ctx context.Context, pool *db.Pool, tenantID string) (int64, error) {
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
