// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

func signupTestRepo(t *testing.T) (*Repo, *pgxpool.Pool, string) {
	t.Helper()
	repo, pool, tenantID := newWritePathTestRepo(t)
	requireApplicationRole(t, pool)
	repo.EngineSyncOutbox = subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}}
	return repo, pool, tenantID
}

// requireApplicationRole refuses a connection that bypasses row security:
// every assertion here would pass whatever the policies said.
func requireApplicationRole(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	var super, bypass bool
	if err := pool.QueryRow(context.Background(),
		`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`).Scan(&super, &bypass); err != nil {
		t.Fatalf("read role: %v", err)
	}
	if super || bypass {
		t.Fatal("DATABASE_URL connects as a role that bypasses RLS; use postwave_app")
	}
}

func singleOptInConsent(verified bool) *SignupConsent {
	return &SignupConsent{
		Source:          ConsentSingleOptIn,
		OccurredAt:      time.Now().UTC().Add(-time.Second),
		Evidence:        `The visitor ticked the consent checkbox "I agree to receive emails." and submitted the form "Weekly letter" (form f-1).`,
		Reason:          "Single opt-in signup through a form.",
		PolicyVersion:   "form-signup-consent-v1",
		MailboxVerified: verified,
	}
}

type signupRow struct {
	Status, ConsentSource, SignupSource, SourceID, SourcePlatform string
	SignupIP, FirstName, LastName, FullName                       string
	ConsentMarketing                                              *time.Time
}

func readSignupRow(t *testing.T, pool *pgxpool.Pool, tenantID, email string) signupRow {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("read tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var row signupRow
	if err := tx.QueryRow(ctx, `
SELECT status, consent_source, signup_source, COALESCE(source_id, ''), COALESCE(source_platform, ''),
       COALESCE(host(signup_ip), ''), first_name, last_name, full_name, consent_email_marketing_at
  FROM subscribers WHERE tenant_id = $1::uuid AND email = $2`, tenantID, email).Scan(
		&row.Status, &row.ConsentSource, &row.SignupSource, &row.SourceID, &row.SourcePlatform,
		&row.SignupIP, &row.FirstName, &row.LastName, &row.FullName, &row.ConsentMarketing); err != nil {
		t.Fatalf("read subscriber %s: %v", email, err)
	}
	return row
}

func countInTenant(t *testing.T, pool *pgxpool.Pool, tenantID, sql string, args ...any) int {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("count tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var n int
	if err := tx.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", sql, err)
	}
	return n
}

// A form signup for a new address becomes a real subscriber — unconfirmed,
// without consent, attributed to the form — with the canonical address row,
// the engine-sync intent and an audit row, like every other capture path.
func TestRecordSignupCreatesAnUnconfirmedSubscriberAttributedToTheForm(t *testing.T) {
	repo, pool, tenantID := signupTestRepo(t)
	formID := uuid.NewString()
	sub, err := repo.RecordSignup(context.Background(), tenantID, SignupCapture{
		Email: " New@Example.com ", Name: "  Ada   King Lovelace ", SignupSource: SignupSourceEmbeddedForm,
		SourceID: formID, SignupIP: "203.0.113.7", UserAgent: "browser",
	})
	if err != nil {
		t.Fatalf("RecordSignup: %v", err)
	}
	if sub.Email != "new@example.com" || sub.Status != StatusUnconfirmed {
		t.Fatalf("returned %s %s", sub.Email, sub.Status)
	}
	row := readSignupRow(t, pool, tenantID, "new@example.com")
	want := signupRow{
		Status: StatusUnconfirmed, ConsentSource: ConsentUnknown, SignupSource: SignupSourceEmbeddedForm,
		SourceID: formID, SourcePlatform: "form", SignupIP: "203.0.113.7",
		FirstName: "Ada", LastName: "King Lovelace", FullName: "Ada King Lovelace",
	}
	if row != want {
		t.Fatalf("stored %+v, want %+v", row, want)
	}
	if n := countInTenant(t, pool, tenantID, `SELECT count(*) FROM subscriber_emails WHERE subscriber_id = $1::uuid AND is_primary`, sub.ID); n != 1 {
		t.Fatalf("canonical address rows = %d, want 1", n)
	}
	if n := countInTenant(t, pool, tenantID, `SELECT count(*) FROM outbox_events WHERE kind = $1 AND payload ->> 'subscriber_id' = $2`,
		OutboxKindListmonkSync, sub.ID); n != 1 {
		t.Fatalf("engine-sync intents = %d, want 1", n)
	}
	if n := countInTenant(t, pool, tenantID, `
SELECT count(*) FROM audit_log
 WHERE action = 'subscriber.created' AND resource_type = 'subscriber' AND resource_id = $1
   AND actor_type = 'system' AND actor_label = 'form-signup' AND host(ip) = '203.0.113.7'`, sub.ID); n != 1 {
		t.Fatalf("creation audit rows = %d, want 1", n)
	}
}

// Upsert replaces custom fields, tags and names; a public form is not the
// owner's word on anybody's profile, so a signup for a known address leaves
// it exactly as it was.
func TestRecordSignupNeverEditsAnExistingProfile(t *testing.T) {
	repo, pool, tenantID := signupTestRepo(t)
	ctx := context.Background()
	if _, err := repo.Upsert(ctx, tenantID, CreateInput{
		Email: "known@example.com", Status: StatusUnconfirmed, FirstName: "Grace", LastName: "Hopper",
		Tags: []string{"vip"}, CustomFields: map[string]any{"plan": "pro"},
	}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	before := readSignupRow(t, pool, tenantID, "known@example.com")
	sub, err := repo.RecordSignup(ctx, tenantID, SignupCapture{
		Email: "known@example.com", Name: "Someone Else", SignupSource: SignupSourceHostedPage,
		SourceID: uuid.NewString(), SignupIP: "198.51.100.4",
	})
	if err != nil {
		t.Fatalf("RecordSignup: %v", err)
	}
	if after := readSignupRow(t, pool, tenantID, "known@example.com"); after != before {
		t.Fatalf("profile changed from %+v to %+v", before, after)
	}
	if len(sub.Tags) != 1 || sub.Tags[0] != "vip" || sub.CustomFields["plan"] != "pro" {
		t.Fatalf("returned profile = tags %v fields %v", sub.Tags, sub.CustomFields)
	}
}

// A single opt-in grant goes through the full consent path: the subscriber is
// enabled, the email-marketing purpose is projected, and the immutable
// consent event carries the form evidence.
func TestRecordSignupWithConsentEnablesTheSubscriberWithEvidence(t *testing.T) {
	repo, pool, tenantID := signupTestRepo(t)
	consent := singleOptInConsent(false)
	sub, err := repo.RecordSignup(context.Background(), tenantID, SignupCapture{
		Email: "soi@example.com", SignupSource: SignupSourceHostedPage, SourceID: uuid.NewString(),
		SignupIP: "203.0.113.9", UserAgent: "browser", Consent: consent,
	})
	if err != nil {
		t.Fatalf("RecordSignup: %v", err)
	}
	if sub.Status != StatusEnabled {
		t.Fatalf("status = %s, want enabled", sub.Status)
	}
	row := readSignupRow(t, pool, tenantID, "soi@example.com")
	if row.Status != StatusEnabled || row.ConsentSource != ConsentSingleOptIn || row.ConsentMarketing == nil {
		t.Fatalf("stored %+v, want enabled single_optin with the email-marketing purpose projected", row)
	}
	if n := countInTenant(t, pool, tenantID, `
SELECT count(*) FROM consent_events
 WHERE category = 'email_marketing' AND action = 'granted' AND source = 'single_optin' AND channel = 'web'
   AND proof_text = $1 AND policy_version = $2
   AND preferences ->> 'jurisdiction' = 'UNSPECIFIED' AND host(ip) = '203.0.113.9'`,
		consent.Evidence, consent.PolicyVersion); n != 1 {
		t.Fatalf("consent events with the form evidence = %d, want 1", n)
	}

	// A redelivered outbox event must not grant twice.
	if _, err := repo.RecordSignup(context.Background(), tenantID, SignupCapture{
		Email: "soi@example.com", SourceID: uuid.NewString(), Consent: singleOptInConsent(false),
	}); err != nil {
		t.Fatalf("repeat RecordSignup: %v", err)
	}
	if n := countInTenant(t, pool, tenantID, `SELECT count(*) FROM consent_events WHERE category = 'email_marketing' AND action = 'granted'`); n != 1 {
		t.Fatalf("consent grants after a repeat = %d, want 1", n)
	}
}

// An unauthenticated form POST naming someone's address must never reverse
// their opt-out. Clicking a double opt-in link (verified) may.
func TestAnUnverifiedSignupNeverReEnablesAnOptedOutSubscriber(t *testing.T) {
	for _, status := range []string{StatusBlocklisted, StatusDisabled} {
		t.Run(status, func(t *testing.T) {
			repo, pool, tenantID := signupTestRepo(t)
			ctx := context.Background()
			if _, err := repo.Upsert(ctx, tenantID, CreateInput{Email: "out@example.com", Status: status}); err != nil {
				t.Fatalf("seed: %v", err)
			}
			sub, err := repo.RecordSignup(ctx, tenantID, SignupCapture{Email: "out@example.com", Consent: singleOptInConsent(false)})
			if err != nil {
				t.Fatalf("unverified RecordSignup: %v", err)
			}
			if sub.Status != status || readSignupRow(t, pool, tenantID, "out@example.com").Status != status {
				t.Fatalf("an unverified signup changed %s to %s", status, sub.Status)
			}
			if n := countInTenant(t, pool, tenantID, `SELECT count(*) FROM consent_events WHERE action = 'granted'`); n != 0 {
				t.Fatalf("consent grants = %d, want none", n)
			}

			verified := singleOptInConsent(true)
			verified.Source = ConsentDoubleOptIn
			sub, err = repo.RecordSignup(ctx, tenantID, SignupCapture{Email: "out@example.com", Consent: verified})
			if err != nil {
				t.Fatalf("verified RecordSignup: %v", err)
			}
			if sub.Status != StatusEnabled || readSignupRow(t, pool, tenantID, "out@example.com").ConsentSource != ConsentDoubleOptIn {
				t.Fatalf("a verified signup left the subscriber %s", sub.Status)
			}
		})
	}
}

func TestRecordSignupRefusesAnErasedAddress(t *testing.T) {
	repo, pool, tenantID := signupTestRepo(t)
	ctx := context.Background()
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("seed tx: %v", err)
	}
	if _, err = seed.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id,email,reason,source,metadata,scope)
VALUES ($1::uuid,'erased@example.com','dsar_deletion','system','{"gdpr_erasure":true}'::jsonb,'all')`, tenantID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed erasure: %v", err)
	}
	if err = seed.Commit(ctx); err != nil {
		t.Fatalf("commit erasure: %v", err)
	}
	_, err = repo.RecordSignup(ctx, tenantID, SignupCapture{Email: "erased@example.com", Consent: singleOptInConsent(false)})
	if !errors.Is(err, ErrErasureBlocked) {
		t.Fatalf("err = %v, want ErrErasureBlocked", err)
	}
	if n := countInTenant(t, pool, tenantID, `SELECT count(*) FROM subscribers WHERE email = 'erased@example.com'`); n != 0 {
		t.Fatalf("an erased address was re-created (%d rows)", n)
	}
}
