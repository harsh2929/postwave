// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

type bulkUnsubscribeTerminalState struct {
	profileStatus      string
	mailchimpStatus    string
	addressConsent     string
	addressSuppressed  bool
	marketingGranted   bool
	revokeEvents       int
	withdrawalProofs   int
	manualSuppressions int
	audits             int
}

func seedBulkUnsubscribeReviewedAddress(
	t *testing.T,
	tenantID string,
	email string,
	expiresAt time.Time,
) (*Repo, migration1766Address) {
	t.Helper()
	return seedBulkUnsubscribeReviewedAddressIn(t, newBulkVerbsTestPool(t), tenantID, email, expiresAt)
}

func seedBulkUnsubscribeReviewedAddressIn(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID string,
	email string,
	expiresAt time.Time,
) (*Repo, migration1766Address) {
	t.Helper()
	seedBulkVerbsTenant(t, pool, tenantID)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	address := createMigration1766Subscriber(t, pool, tenantID, email)
	appendMigration1766ExactGrant(
		t,
		pool,
		tenantID,
		address,
		time.Now().UTC().Add(-time.Hour),
		expiresAt,
		"privacy-2026-07",
		"bulk-unsubscribe-reviewed:"+uuid.NewString(),
	)
	return &Repo{Pool: pool}, address
}

func readBulkUnsubscribeTerminalState(
	t *testing.T,
	repo *Repo,
	tenantID string,
	address migration1766Address,
) bulkUnsubscribeTerminalState {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.WithTenant(ctx, repo.Pool, tenantID)
	if err != nil {
		t.Fatalf("bulk unsubscribe verification tx: %v", err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var state bulkUnsubscribeTerminalState
	if err := tx.QueryRow(ctx, `
SELECT subscriber.status,
       subscriber.mailchimp_status,
       subscriber.consent_email_marketing_at IS NOT NULL,
       email.consent_status,
       email.suppressed
  FROM subscribers AS subscriber
  JOIN subscriber_emails AS email
    ON email.tenant_id = subscriber.tenant_id
   AND email.subscriber_id = subscriber.id
   AND email.id = $3::uuid
 WHERE subscriber.tenant_id = $1::uuid
   AND subscriber.id = $2::uuid`,
		tenantID, address.SubscriberID, address.ID).Scan(
		&state.profileStatus,
		&state.mailchimpStatus,
		&state.marketingGranted,
		&state.addressConsent,
		&state.addressSuppressed,
	); err != nil {
		t.Fatalf("read bulk unsubscribe terminal projection: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT
    (SELECT count(*)
       FROM consent_events
      WHERE tenant_id = $1::uuid
        AND subject_id = $2
        AND subject_email = $3
        AND category = 'email_marketing'
        AND action = 'revoked'
        AND source = 'direct_request'
        AND policy_version = 'operator-bulk-unsubscribe-v1'),
    (SELECT count(*)
       FROM consent_records
      WHERE tenant_id = $1::uuid
        AND subscriber_id = $4::uuid
        AND email = $3
        AND channel = 'email'
        AND consent_status = 'withdrawn'
        AND source = 'admin'
        AND evidence ->> 'operation' = 'bulk_unsubscribe'),
    (SELECT count(*)
       FROM subscriber_suppressions
      WHERE tenant_id = $1::uuid
        AND email = $3
        AND reason = 'manual_unsubscribe'
        AND source = 'api'
        AND metadata ->> 'operation' = 'bulk_unsubscribe'),
    (SELECT count(*)
       FROM audit_log
      WHERE tenant_id = $1::uuid
        AND action = 'subscriber.bulk_unsubscribed'
        AND metadata ->> 'operation_id' <> '')`,
		tenantID, address.ID, address.Email, address.SubscriberID).Scan(
		&state.revokeEvents,
		&state.withdrawalProofs,
		&state.manualSuppressions,
		&state.audits,
	); err != nil {
		t.Fatalf("read bulk unsubscribe evidence: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit bulk unsubscribe verification: %v", err)
	}
	return state
}

func requireSuccessfulBulkUnsubscribe(
	t *testing.T,
	d *Deps,
	tenantID string,
	address migration1766Address,
) {
	t.Helper()
	w := httptest.NewRecorder()
	d.BulkUnsubscribe(
		w,
		bulkVerbsRequest(
			tenantID,
			"/api/v1/subscribers/bulk/unsubscribe",
			fmt.Sprintf(`{"subscriber_ids":[%q]}`, address.SubscriberID),
		),
	)
	result := decodeBulkResult(t, w)
	if result.Affected != 1 || result.Skipped != 0 ||
		result.RecoveryToken != "" || result.RecoveryUntil != "" {
		t.Fatalf("bulk unsubscribe response = %+v, want one terminal change without undo", result)
	}
}

func assertBulkUnsubscribeCommitted(
	t *testing.T,
	state bulkUnsubscribeTerminalState,
) {
	t.Helper()
	if state.profileStatus != StatusBlocklisted ||
		state.mailchimpStatus != "unsubscribed" ||
		state.addressConsent != "unsubscribed" ||
		!state.addressSuppressed ||
		state.marketingGranted ||
		state.revokeEvents != 1 ||
		state.withdrawalProofs != 1 ||
		state.manualSuppressions != 1 ||
		state.audits != 1 {
		t.Fatalf("incomplete terminal unsubscribe state = %+v", state)
	}
}

func assertBulkUnsubscribeRolledBack(
	t *testing.T,
	state bulkUnsubscribeTerminalState,
) {
	t.Helper()
	if state.profileStatus == StatusBlocklisted ||
		state.mailchimpStatus == "unsubscribed" ||
		state.addressConsent != "subscribed" ||
		state.addressSuppressed ||
		state.revokeEvents != 0 ||
		state.withdrawalProofs != 0 ||
		state.manualSuppressions != 0 ||
		state.audits != 0 {
		t.Fatalf("partial bulk unsubscribe escaped rollback = %+v", state)
	}
}

func TestBulkUnsubscribeRevokesPositiveHiddenByReleaseGate(t *testing.T) {
	// Blocking the deployment-wide gate hides subscribed rows in every
	// tenant, so it happens only in the isolated database.
	gate := isolatedReleaseGateDatabase(t)
	tenantID := uuid.NewString()
	repo, address := seedBulkUnsubscribeReviewedAddressIn(
		t,
		gate.appPool(t),
		tenantID,
		fmt.Sprintf("bulk-gate-hidden-%d@example.test", time.Now().UnixNano()),
		time.Now().UTC().Add(24*time.Hour),
	)
	gate.block(t)

	assertConsentAddressHiddenFromApp(t, repo.Pool, tenantID, address)
	requireSuccessfulBulkUnsubscribe(t, &Deps{Repo: repo}, tenantID, address)
	assertBulkUnsubscribeCommitted(
		t,
		readBulkUnsubscribeTerminalState(t, repo, tenantID, address),
	)
}

func TestBulkUnsubscribeRevokesPositiveHiddenByProofExpiry(t *testing.T) {
	tenantID := uuid.NewString()
	expiresAt := time.Now().UTC().Add(500 * time.Millisecond)
	repo, address := seedBulkUnsubscribeReviewedAddress(
		t,
		tenantID,
		fmt.Sprintf("bulk-expired-hidden-%d@example.test", time.Now().UnixNano()),
		expiresAt,
	)
	waitForConsentProofExpiry(t, expiresAt)
	assertConsentAddressHiddenFromApp(t, repo.Pool, tenantID, address)

	requireSuccessfulBulkUnsubscribe(t, &Deps{Repo: repo}, tenantID, address)
	assertBulkUnsubscribeCommitted(
		t,
		readBulkUnsubscribeTerminalState(t, repo, tenantID, address),
	)
}

func TestBulkUnsubscribeLockTimeoutIsRetryableAndAtomic(t *testing.T) {
	tenantID := uuid.NewString()
	repo, address := seedBulkUnsubscribeReviewedAddress(
		t,
		tenantID,
		fmt.Sprintf("bulk-lock-hostile-%d@example.test", time.Now().UnixNano()),
		time.Now().UTC().Add(24*time.Hour),
	)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	lockTx, err := db.WithTenant(ctx, repo.Pool, tenantID)
	if err != nil {
		t.Fatalf("open hostile exact-address lock: %v", err)
	}
	defer func() { _ = lockTx.Rollback(context.Background()) }()
	locked, _, err := lockEmailConsentAddressForRepair(
		ctx, lockTx, tenantID, address.SubscriberID, address.Email,
	)
	if err != nil {
		t.Fatalf("hold hostile exact-address lock: %v", err)
	}
	if locked == nil || locked.ID != address.ID {
		t.Fatalf("hostile exact-address resolver = %#v", locked)
	}

	w := httptest.NewRecorder()
	(&Deps{Repo: repo}).BulkUnsubscribe(
		w,
		bulkVerbsRequest(
			tenantID,
			"/api/v1/subscribers/bulk/unsubscribe",
			fmt.Sprintf(`{"subscriber_ids":[%q]}`, address.SubscriberID),
		),
	)
	if w.Code != http.StatusConflict || w.Header().Get("Retry-After") != "1" {
		t.Fatalf("lock timeout response status=%d retry=%q body=%s",
			w.Code, w.Header().Get("Retry-After"), w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "concurrent_consent_change") {
		t.Fatalf("lock timeout body = %s", w.Body.String())
	}
	if err := lockTx.Rollback(ctx); err != nil {
		t.Fatalf("release hostile exact-address lock: %v", err)
	}
	assertBulkUnsubscribeRolledBack(
		t,
		readBulkUnsubscribeTerminalState(t, repo, tenantID, address),
	)
}

func TestBulkUnsubscribeDownstreamFailuresRollBackAllTerminalEvidence(t *testing.T) {
	for _, test := range []struct {
		name      string
		configure func(*Repo)
		decorate  func(*http.Request) *http.Request
	}{
		{
			name: "webhook append",
			configure: func(repo *Repo) {
				repo.Webhooks = failingAddressConsentWebhook{
					err: errors.New("injected bulk unsubscribe webhook failure"),
				}
			},
			decorate: func(request *http.Request) *http.Request { return request },
		},
		{
			name: "engine outbox append",
			configure: func(repo *Repo) {
				repo.EngineSyncOutbox = subscriberOutboxTestAdapter{
					err: errors.New("injected bulk unsubscribe outbox failure"),
				}
			},
			decorate: func(request *http.Request) *http.Request { return request },
		},
		{
			name:      "final audit append",
			configure: func(*Repo) {},
			decorate: func(request *http.Request) *http.Request {
				return request.WithContext(middleware.WithActor(
					request.Context(), "invalid-audit-actor", "bulk-audit-failure-test",
				))
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			tenantID := uuid.NewString()
			repo, address := seedBulkUnsubscribeReviewedAddress(
				t,
				tenantID,
				fmt.Sprintf("bulk-rollback-%s@example.test", uuid.NewString()),
				time.Now().UTC().Add(24*time.Hour),
			)
			test.configure(repo)
			request := bulkVerbsRequest(
				tenantID,
				"/api/v1/subscribers/bulk/unsubscribe",
				fmt.Sprintf(`{"subscriber_ids":[%q]}`, address.SubscriberID),
			)
			w := httptest.NewRecorder()
			(&Deps{Repo: repo}).BulkUnsubscribe(w, test.decorate(request))
			if w.Code != http.StatusInternalServerError {
				t.Fatalf("downstream failure status=%d body=%s", w.Code, w.Body.String())
			}
			assertBulkUnsubscribeRolledBack(
				t,
				readBulkUnsubscribeTerminalState(t, repo, tenantID, address),
			)
		})
	}
}

type bulkUnsubscribeSQLStateError struct{ state string }

func (e bulkUnsubscribeSQLStateError) Error() string    { return "postgres " + e.state }
func (e bulkUnsubscribeSQLStateError) SQLState() string { return e.state }

func TestBulkUnsubscribeRetryableSQLStatesReturnConflict(t *testing.T) {
	for _, state := range []string{"55P03", "40001", "40P01"} {
		t.Run(state, func(t *testing.T) {
			const tenantID = "00000000-0000-4000-8000-0099a2c41784"
			w := httptest.NewRecorder()
			request := bulkVerbsRequest(
				tenantID,
				"/api/v1/subscribers/bulk/unsubscribe",
				`{"subscriber_ids":["00000000-0000-4000-8000-000000000001"]}`,
			)
			(&Deps{}).writeBulkUnsubscribeErr(
				w,
				request,
				fmt.Errorf("commit bulk unsubscribe: %w", bulkUnsubscribeSQLStateError{state: state}),
			)
			if w.Code != http.StatusConflict || w.Header().Get("Retry-After") != "1" ||
				!strings.Contains(w.Body.String(), "concurrent_consent_change") {
				t.Fatalf("SQLSTATE %s response status=%d retry=%q body=%s",
					state, w.Code, w.Header().Get("Retry-After"), w.Body.String())
			}
		})
	}
}
