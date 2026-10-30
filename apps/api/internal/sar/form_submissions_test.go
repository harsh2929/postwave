// SPDX-License-Identifier: AGPL-3.0-only

package sar

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// This is a real-Postgres disclosure contract. It proves that the fully
// migrated form_submissions shape survives the complete HTTP SAR path and that
// both subject and tenant boundaries are applied before the bundle is stored.
func TestCreateAccessIncludesCompleteFormSubmission(t *testing.T) {
	pool := erasureTestPool(t)
	tenantID, email := seedSubject(t, pool)
	otherTenantID, _ := seedSubject(t, pool)
	ctx := context.Background()

	wantID, confirmationToken := seedFormSubmissionForSAR(t, pool, tenantID, email, true)
	seedFormSubmissionForSAR(t, pool, tenantID, "other.subject@example.test", false)
	seedFormSubmissionForSAR(t, pool, otherTenantID, email, false)

	d := &Deps{Pool: pool, Logger: slog.Default()}
	rec := postSAR(t, d, tenantID, `{"email":"`+strings.ToUpper(email)+`","kind":"access"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("access request: got %d, body %s", rec.Code, rec.Body.String())
	}

	var rawBundle []byte
	if err := pool.QueryRow(ctx, `
SELECT bundle::text::bytea
  FROM sar_bundles
 WHERE tenant_id = $1::uuid
 ORDER BY requested_at DESC
 LIMIT 1`, tenantID).Scan(&rawBundle); err != nil {
		t.Fatalf("read stored SAR bundle: %v", err)
	}
	var bundle map[string]any
	if err := json.Unmarshal(rawBundle, &bundle); err != nil {
		t.Fatalf("decode stored SAR bundle: %v", err)
	}

	rows, ok := bundle["form_submissions"].([]any)
	if !ok || len(rows) != 1 {
		t.Fatalf("form_submissions = %T %#v, want exactly the scoped subject row", bundle["form_submissions"], bundle["form_submissions"])
	}
	submission, ok := rows[0].(map[string]any)
	if !ok {
		t.Fatalf("form submission = %T %#v", rows[0], rows[0])
	}
	assertFormSubmissionDisclosure(t, submission, wantID, email)

	serialized, err := json.Marshal(submission)
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"tenant_id", "confirmation_token", confirmationToken} {
		if strings.Contains(string(serialized), forbidden) {
			t.Fatalf("form disclosure leaked isolation key or bearer secret %q: %s", forbidden, serialized)
		}
	}
}

func seedFormSubmissionForSAR(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID string,
	email string,
	withConsent bool,
) (string, string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open form fixture transaction: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var formID string
	if err := tx.QueryRow(ctx, `
INSERT INTO forms (tenant_id, slug, name, opt_in_mode, status)
VALUES ($1::uuid, 'sar-' || substr(md5(random()::text), 1, 16),
        'SAR disclosure form', 'double', 'published')
RETURNING id::text`, tenantID).Scan(&formID); err != nil {
		t.Fatalf("seed form: %v", err)
	}

	confirmationToken := "sar-confirmation-" + strings.ReplaceAll(formID, "-", "")
	var submissionID string
	if err := tx.QueryRow(ctx, `
INSERT INTO form_submissions
       (form_id, tenant_id, email, custom_fields, confirmation_token, status,
        ip, user_agent, submitted_at, confirmed_at, metadata,
        name, signup_source, target_list_ids)
VALUES ($1::uuid, $2::uuid, $3::citext,
        '{"first_name":"Alice","company":"Moosewave"}'::jsonb,
        $4, 'confirmed', '203.0.113.42'::inet, 'Moosewave SAR contract agent',
        '2026-07-20T10:11:12Z'::timestamptz,
        '2026-07-20T10:12:13Z'::timestamptz,
        '{"utm_source":"sar-contract","referral_code":"subject-private"}'::jsonb,
        'Alice Subject', 'embedded_form', ARRAY['7c1c1b2e-0000-4000-8000-000000000001']::uuid[])
RETURNING id::text`, formID, tenantID, email, confirmationToken).Scan(&submissionID); err != nil {
		t.Fatalf("seed form submission: %v", err)
	}

	if withConsent {
		preferences, err := json.Marshal(map[string]any{
			"form_id":       formID,
			"submission_id": submissionID,
			"consent_value": "yes",
			"status":        "confirmed",
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx, `
INSERT INTO consent_events
       (tenant_id, subject_type, subject_id, subject_email, channel, category,
        action, source, policy_version, preferences, proof_text, ip, user_agent,
        created_at)
VALUES ($1::uuid, 'subscriber', $2, $3::citext, 'web', 'email_marketing',
        'granted', 'public_form', 'v1', $4::jsonb,
        'Public form consent captured for SAR contract', '203.0.113.42'::inet,
        'Moosewave SAR contract agent', '2026-07-20T10:11:12Z'::timestamptz)`,
			tenantID, submissionID, email, string(preferences)); err != nil {
			t.Fatalf("seed form consent evidence: %v", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit form fixture: %v", err)
	}
	return submissionID, confirmationToken
}

func assertFormSubmissionDisclosure(t *testing.T, got map[string]any, wantID, wantEmail string) {
	t.Helper()
	for key, want := range map[string]string{
		"id":            wantID,
		"email":         wantEmail,
		"name":          "Alice Subject",
		"signup_source": "embedded_form",
		"status":        "confirmed",
		"ip":            "203.0.113.42",
		"user_agent":    "Moosewave SAR contract agent",
	} {
		if value, _ := got[key].(string); value != want {
			t.Errorf("%s = %#v, want %q", key, got[key], want)
		}
	}
	if got["form_id"] == "" || got["submitted_at"] == nil || got["confirmed_at"] == nil {
		t.Errorf("form identity/chronology is incomplete: %#v", got)
	}
	if lists, _ := got["target_list_ids"].([]any); len(lists) != 1 || lists[0] != "7c1c1b2e-0000-4000-8000-000000000001" {
		t.Errorf("target_list_ids = %#v, want the list the submission joined", got["target_list_ids"])
	}
	customFields, _ := got["custom_fields"].(map[string]any)
	if customFields["first_name"] != "Alice" || customFields["company"] != "Moosewave" {
		t.Errorf("custom_fields = %#v", got["custom_fields"])
	}
	metadata, _ := got["metadata"].(map[string]any)
	if metadata["utm_source"] != "sar-contract" || metadata["referral_code"] != "subject-private" {
		t.Errorf("metadata = %#v", got["metadata"])
	}
	consentEvents, _ := got["consent_events"].([]any)
	if len(consentEvents) != 1 {
		t.Fatalf("consent_events = %#v, want exact submission evidence", got["consent_events"])
	}
	consent, _ := consentEvents[0].(map[string]any)
	preferences, _ := consent["preferences"].(map[string]any)
	if consent["action"] != "granted" || consent["source"] != "public_form" ||
		preferences["consent_value"] != "yes" || consent["occurred_at"] == nil ||
		consent["recorded_at"] == nil {
		t.Errorf("consent evidence is incomplete: %#v", consent)
	}
}

type formSubmissionSARTx struct {
	pgx.Tx
	rows      pgx.Rows
	queryErr  error
	query     string
	queryArgs []any
}

func (tx *formSubmissionSARTx) Query(_ context.Context, query string, args ...any) (pgx.Rows, error) {
	tx.query = query
	tx.queryArgs = append([]any(nil), args...)
	return tx.rows, tx.queryErr
}

type formSubmissionSARRows struct {
	pgx.Rows
	err error
}

func (rows *formSubmissionSARRows) Close() {}
func (rows *formSubmissionSARRows) Err() error {
	return rows.err
}
func (rows *formSubmissionSARRows) Next() bool { return false }

func TestLoadFormSubmissionsPropagatesQueryFailures(t *testing.T) {
	ctx := context.Background()
	wantTenant := "00000000-0000-0000-0000-000000000001"
	wantEmail := "subject@example.test"

	t.Run("immediate query error", func(t *testing.T) {
		want := errors.New("form submissions unavailable")
		tx := &formSubmissionSARTx{queryErr: want}
		rows, err := loadFormSubmissions(ctx, tx, wantTenant, wantEmail)
		if rows != nil || !errors.Is(err, want) {
			t.Fatalf("result/error = %#v / %v, want nil and propagated query error", rows, err)
		}
		assertFormSubmissionQueryScope(t, tx, wantTenant, wantEmail)
	})

	t.Run("deferred PostgreSQL error", func(t *testing.T) {
		want := &pgconn.PgError{Code: "42703", Message: "column does not exist"}
		tx := &formSubmissionSARTx{rows: &formSubmissionSARRows{err: want}}
		rows, err := loadFormSubmissions(ctx, tx, wantTenant, wantEmail)
		if rows != nil {
			t.Fatalf("rows = %#v, want nil when iteration fails", rows)
		}
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != want.Code {
			t.Fatalf("error = %v, want propagated SQLSTATE %s", err, want.Code)
		}
		assertFormSubmissionQueryScope(t, tx, wantTenant, wantEmail)
	})
}

func assertFormSubmissionQueryScope(
	t *testing.T,
	tx *formSubmissionSARTx,
	wantTenant string,
	wantEmail string,
) {
	t.Helper()
	if len(tx.queryArgs) != 2 || tx.queryArgs[0] != wantTenant || tx.queryArgs[1] != wantEmail {
		t.Fatalf("query args = %#v, want explicit tenant and subject", tx.queryArgs)
	}
	normalized := strings.ToLower(tx.query)
	for _, fragment := range []string{
		"s.tenant_id = $1::uuid",
		"lower(s.email::text) = lower($2)",
		"'custom_fields', s.custom_fields",
		"'metadata', s.metadata",
		"'consent_events'",
	} {
		if !strings.Contains(normalized, fragment) {
			t.Errorf("form SAR query is missing %q", fragment)
		}
	}
	for _, forbidden := range []string{"subscriber_email", "payload", "limit 500", "confirmation_token"} {
		if strings.Contains(normalized, forbidden) {
			t.Errorf("form SAR query still references forbidden/obsolete fragment %q", forbidden)
		}
	}
}
