// SPDX-License-Identifier: AGPL-3.0-only
package subscribers

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// A consent receipt must not assert a grant it cannot evidence.
//
// `buildConsentReceipt` emits an `sms_marketing` service with
// `active: true` whenever `subscribers.consent_sms_marketing_at` is set, while
// the receipt's History block comes from `consent_receipts` (migration 0140) —
// which the SMS path never writes. SMS evidence lives in `sms_consent_events`.
//
// While the column was permanently NULL this was invisible: `active` was always
// false and nothing was claimed. Projecting the column (migrations 1861/1862)
// made every SMS-consenting subscriber's receipt assert an explicit grant with
// an EMPTY evidence chain. An ISO 27560 receipt is a compliance artifact whose
// entire purpose is to be the evidence; one that asserts consent it cannot
// substantiate is worse than one that reports no consent at all.

func newReceiptSMSTestPool(t *testing.T) *db.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		t.Skip("TEST_DATABASE_URL or DATABASE_URL not set; skipping SMS receipt tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := db.New(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func TestConsentReceiptCarriesSMSEvidenceForAnSMSGrant(t *testing.T) {
	pool := newReceiptSMSTestPool(t)
	ctx := context.Background()
	tenantID := uuid.NewString()
	email := "receipt-sms-" + uuid.NewString()[:8] + "@example.test"
	phone := "+15552300001"

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO tenants (id, name, slug, tier)
		VALUES ($1::uuid, 'receipt-sms', 'receipt-sms-' || $1::text, 'studio')`,
		tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO subscribers (tenant_id, email, status, consent_source)
		VALUES ($1::uuid, $2::citext, 'enabled', 'api')`, tenantID, email); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	// The SMS consent trail, exactly as internal/sms writes it.
	if _, err := tx.Exec(ctx, `
		INSERT INTO sms_consent_events
		       (tenant_id, phone_e164, subscriber_email, action, source,
		        proof_text, provider)
		VALUES ($1::uuid, $2, $3::citext, 'granted', 'form',
		        'Checked the SMS opt-in box on the signup form', 'product')`,
		tenantID, phone, email); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed sms consent event: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		cctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		c, err := db.WithTenant(cctx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(cctx) }()
		for _, stmt := range []string{
			`DELETE FROM sms_consent_events WHERE tenant_id = $1::uuid`,
			`DELETE FROM subscribers WHERE tenant_id = $1::uuid`,
			`DELETE FROM tenants WHERE id = $1::uuid`,
		} {
			if _, err := c.Exec(cctx, stmt, tenantID); err != nil {
				return
			}
		}
		_ = c.Commit(cctx)
	})

	repo := &Repo{Pool: pool}
	_, history, err := repo.LoadConsentReceiptContext(ctx, tenantID, email)
	if err != nil {
		t.Fatalf("load receipt context: %v", err)
	}

	// Matched on the `sms:` PREFIX the loader guarantees, not on a substring.
	// `consent_receipts.source` is free text with no CHECK, so an email row whose
	// source merely contains "sms" satisfied the old filter — a review proved
	// this test passed with the SMS loader deleted entirely.
	var smsEntries []ConsentReceiptHistoryEntry
	for _, h := range history {
		if strings.HasPrefix(h.Source, "sms:") {
			smsEntries = append(smsEntries, h)
		}
	}
	if len(smsEntries) == 0 {
		t.Fatalf("the subscriber has an SMS consent grant in sms_consent_events and "+
			"the receipt history has no SMS entry at all (%d entries total). The "+
			"receipt would assert `sms_marketing active:true` with nothing behind "+
			"it — a compliance artifact claiming evidence it does not hold.",
			len(history))
	}
	got := smsEntries[0]
	if got.NewState == "" {
		t.Error("SMS history entry has no newState")
	}
	if got.CapturedText == "" {
		t.Error("SMS history entry dropped the proof text, which is the evidence")
	}
	if got.At.IsZero() {
		t.Error("SMS history entry has no timestamp")
	}
}

func TestConsentReceiptSMSHistoryRecordsWithdrawal(t *testing.T) {
	// A receipt that shows only grants is a selective record. The withdrawal is
	// the more consequential half — it is what proves a STOP was honoured.
	pool := newReceiptSMSTestPool(t)
	ctx := context.Background()
	tenantID := uuid.NewString()
	email := "receipt-stop-" + uuid.NewString()[:8] + "@example.test"

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO tenants (id, name, slug, tier)
		VALUES ($1::uuid, 'receipt-stop', 'receipt-stop-' || $1::text, 'studio')`,
		tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed tenant: %v", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO subscribers (tenant_id, email, status, consent_source)
		VALUES ($1::uuid, $2::citext, 'enabled', 'api')`, tenantID, email); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed subscriber: %v", err)
	}
	for index, action := range []string{"granted", "revoked"} {
		if _, err := tx.Exec(ctx, `
			INSERT INTO sms_consent_events
			       (tenant_id, phone_e164, subscriber_email, action, source,
			        provider, provider_event_id)
			VALUES ($1::uuid, '+15552300002', $2::citext, $3, 'keyword',
			        'twilio', $4)`,
			tenantID, email, action, "SMreceipt"+string(rune('a'+index))); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed %s: %v", action, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		cctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		c, err := db.WithTenant(cctx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(cctx) }()
		for _, stmt := range []string{
			`DELETE FROM sms_consent_events WHERE tenant_id = $1::uuid`,
			`DELETE FROM subscribers WHERE tenant_id = $1::uuid`,
			`DELETE FROM tenants WHERE id = $1::uuid`,
		} {
			if _, err := c.Exec(cctx, stmt, tenantID); err != nil {
				return
			}
		}
		_ = c.Commit(cctx)
	})

	_, history, err := (&Repo{Pool: pool}).LoadConsentReceiptContext(ctx, tenantID, email)
	if err != nil {
		t.Fatalf("load receipt context: %v", err)
	}
	var sawWithdrawal bool
	for _, h := range history {
		if strings.HasPrefix(h.Source, "sms:") && h.NewState == "withdrawn" {
			sawWithdrawal = true
		}
	}
	if !sawWithdrawal {
		t.Fatalf("the SMS trail contains a revocation and the receipt history does "+
			"not record it (%d entries). A receipt showing only grants cannot "+
			"evidence that a STOP was honoured.", len(history))
	}
}

func TestConsentReceiptFindsAnInboundStopThatCarriesNoEmail(t *testing.T) {
	// The case the first version of this merge missed entirely, and the most
	// consequential one.
	//
	// `sms.recordConsentTx` — what the carrier webhook and the Twilio keyword
	// handler call when a subscriber texts STOP — inserts into
	// `sms_consent_events` WITHOUT `subscriber_email`. An email-keyed history
	// query never matches those rows, so the receipt showed the grant and not the
	// opt-out: precisely the thing a consent receipt exists to prove.
	//
	// The earlier tests could not catch this because they hand-wrote
	// `subscriber_email` while claiming to seed the trail "exactly as internal/sms
	// writes it". This one seeds it the way the STOP writer actually does — phone
	// only, email NULL.
	pool := newReceiptSMSTestPool(t)
	ctx := context.Background()
	tenantID := uuid.NewString()
	email := "receipt-inbound-" + uuid.NewString()[:8] + "@example.test"
	phone := "+15552300003"
	listID := uuid.NewString()

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope: %v", err)
	}
	seed := []struct {
		q    string
		args []any
	}{
		{`INSERT INTO tenants (id, name, slug, tier)
		  VALUES ($1::uuid, 'receipt-inbound', 'receipt-inbound-' || $1::text, 'studio')`,
			[]any{tenantID}},
		{`INSERT INTO subscribers (tenant_id, email, status, consent_source)
		  VALUES ($1::uuid, $2::citext, 'enabled', 'api')`, []any{tenantID, email}},
		{`INSERT INTO sms_lists (id, tenant_id, name) VALUES ($1::uuid, $2::uuid, 'inbound')`,
			[]any{listID, tenantID}},
		// The grant, as the product path writes it (email present). It precedes
		// the mutable projection because send eligibility requires this matching
		// immutable evidence row.
		{`INSERT INTO sms_consent_events
		         (tenant_id, list_id, phone_e164, subscriber_email, action,
		          source, proof_text, provider, metadata)
		  VALUES ($1::uuid, $2::uuid, $3, $4::citext, 'granted', 'form',
		          'Checked the SMS opt-in box on the signup form', 'product',
		          '{"evidence_type":"web_form","evidence_id":"receipt-inbound-grant"}'::jsonb)`,
			[]any{tenantID, listID, phone, email}},
		// The binding between phone and subscriber: an opted-in subscription
		// carrying the exact same evidence tuple as the immutable grant.
		{`INSERT INTO sms_subscriptions
		         (tenant_id, list_id, phone_e164, subscriber_email, status,
		          consent_source, consent_text, consent_at, proof)
		  VALUES ($1::uuid, $2::uuid, $3, $4::citext, 'opted_in', 'form',
		          'Checked the SMS opt-in box on the signup form', clock_timestamp(),
		          '{"evidence_type":"web_form","evidence_id":"receipt-inbound-grant"}'::jsonb)`,
			[]any{tenantID, listID, phone, email}},
		// The STOP, as recordConsentTx writes it: NO subscriber_email.
		{`INSERT INTO sms_consent_events
		         (tenant_id, phone_e164, action, source, proof_text, provider,
		          provider_event_id)
		  VALUES ($1::uuid, $2, 'revoked', 'keyword', 'STOP', 'twilio',
		          'SMreceiptinboundstop')`,
			[]any{tenantID, phone}},
	}
	for _, s := range seed {
		if _, err := tx.Exec(ctx, s.q, s.args...); err != nil {
			_ = tx.Rollback(ctx)
			t.Fatalf("seed: %v", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit: %v", err)
	}
	t.Cleanup(func() {
		cctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		c, err := db.WithTenant(cctx, pool, tenantID)
		if err != nil {
			return
		}
		defer func() { _ = c.Rollback(cctx) }()
		for _, stmt := range []string{
			`DELETE FROM sms_consent_events WHERE tenant_id = $1::uuid`,
			`DELETE FROM sms_subscriptions WHERE tenant_id = $1::uuid`,
			`DELETE FROM sms_lists WHERE tenant_id = $1::uuid`,
			`DELETE FROM subscribers WHERE tenant_id = $1::uuid`,
			`DELETE FROM tenants WHERE id = $1::uuid`,
		} {
			if _, err := c.Exec(cctx, stmt, tenantID); err != nil {
				return
			}
		}
		_ = c.Commit(cctx)
	})

	_, history, err := (&Repo{Pool: pool}).LoadConsentReceiptContext(ctx, tenantID, email)
	if err != nil {
		t.Fatalf("load receipt context: %v", err)
	}
	var sawGrant, sawWithdrawal bool
	for _, h := range history {
		if !strings.HasPrefix(h.Source, "sms:") {
			continue
		}
		switch h.NewState {
		case "subscribed":
			sawGrant = true
		case "withdrawn":
			sawWithdrawal = true
		}
	}
	if !sawGrant {
		t.Error("the SMS grant is missing from the receipt history")
	}
	if !sawWithdrawal {
		t.Fatal("the subscriber texted STOP and the receipt history does not record " +
			"it. `recordConsentTx` writes that row with a NULL subscriber_email, so " +
			"an email-keyed lookup misses every inbound opt-out — the receipt shows " +
			"the grant and not the withdrawal, which is the one thing it must never do.")
	}
}
