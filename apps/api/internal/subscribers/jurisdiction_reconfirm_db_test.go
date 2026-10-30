// SPDX-License-Identifier: AGPL-3.0-only
//
// PostgreSQL-backed proofs for the jurisdiction re-confirmation compliance
// transaction. They skip cleanly without DATABASE_URL, matching this package's
// established database-test convention.

package subscribers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/geolocation"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

func newJurisdictionReconfirmTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed jurisdiction re-confirmation tests")
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func jurisdictionReconfirmRepo(pool *pgxpool.Pool) *Repo {
	return &Repo{
		Pool:             pool,
		Jurisdiction:     geolocation.DriftAdapter{},
		Webhooks:         noOpChannelConsentWebhook{},
		EngineSyncOutbox: subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}},
	}
}

func seedJurisdictionReconfirmTenant(t *testing.T, pool *pgxpool.Pool, tenantID string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("tenant scope for seed: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'jurisdiction-reconfirm-test', 'jurisdiction-reconfirm-' || $1::text, 'studio')
ON CONFLICT (id) DO NOTHING`, tenantID); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit tenant seed: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		cleanupTx, cleanupErr := db.WithTenant(cleanupCtx, pool, tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanupTx.Rollback(cleanupCtx) }()
		_, _ = cleanupTx.Exec(cleanupCtx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
		_ = cleanupTx.Commit(cleanupCtx)
	})
}

func seedJurisdictionReconfirmSubscriber(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID, email, status, detected, region string,
	changedAt time.Time,
	required bool,
) string {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("subscriber seed scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	mailchimpStatus := mailchimpStatusFromListmonk(status)
	var id string
	if err := tx.QueryRow(ctx, `
INSERT INTO subscribers
       (tenant_id, email, status, mailchimp_status, consent_source,
        detected_jurisdiction, jurisdiction_changed_at,
        jurisdiction_reconfirm_required, region)
VALUES ($1::uuid, $2, $3, $4, 'api', $5, $6, $7, NULLIF($8, ''))
RETURNING id::text`,
		tenantID, email, status, mailchimpStatus, detected, changedAt, required, region,
	).Scan(&id); err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit subscriber seed: %v", err)
	}
	return id
}

func jurisdictionReconfirmDBInput(
	t *testing.T,
	pool *pgxpool.Pool,
	tenantID, subscriberID, decision, regime string,
	changedAt time.Time,
) JurisdictionReconfirmInput {
	t.Helper()
	subscriber, err := (&Repo{Pool: pool}).Get(
		context.Background(), tenantID, subscriberID,
	)
	if err != nil {
		t.Fatalf("read reviewed subscriber version: %v", err)
	}
	return JurisdictionReconfirmInput{
		Decision:                      decision,
		Regime:                        regime,
		PrivacyPolicyVersion:          "privacy-2026-07-19",
		CapturedText:                  "I agree to receive email marketing.\nWithdrawal remains available at any time.",
		ExpectedJurisdictionChangedAt: changedAt,
		ExpectedSubscriberVersion:     subscriber.Version,
	}
}

func jurisdictionEvidenceCounts(t *testing.T, pool *pgxpool.Pool, tenantID, subscriberID string) (receipts, events, audits int) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("evidence count scope: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM consent_receipts WHERE subscriber_id = $1::uuid AND source = 'jurisdiction_reconfirm'`, subscriberID).Scan(&receipts); err != nil {
		t.Fatalf("count receipts: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM consent_events
 WHERE preferences ->> 'subscriber_id' = $1
   AND preferences ->> 'operation' = 'jurisdiction_reconfirmation'`, subscriberID).Scan(&events); err != nil {
		t.Fatalf("count events: %v", err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE resource_id = $1 AND action = 'subscriber.jurisdiction_reconfirmed'`, subscriberID).Scan(&audits); err != nil {
		t.Fatalf("count audits: %v", err)
	}
	return receipts, events, audits
}

func TestJurisdictionReconfirmRequiresDurableDeliveryInfrastructure(t *testing.T) {
	pool := newJurisdictionReconfirmTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	tenantID := uuid.NewString()
	seedJurisdictionReconfirmTenant(t, pool, tenantID)
	changedAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	id := seedJurisdictionReconfirmSubscriber(
		t, pool, tenantID, "jurisdiction-infra-"+uuid.NewString()+"@example.test",
		StatusDisabled, "DE", "", changedAt, true,
	)
	in := jurisdictionReconfirmDBInput(
		t, pool, tenantID, id, "accepted", "gdpr", changedAt,
	)
	_, _, err := (&Repo{Pool: pool, Jurisdiction: geolocation.DriftAdapter{}}).
		ReconfirmJurisdiction(context.Background(), tenantID, id, in, db.AuditMeta{})
	if !errors.Is(err, ErrJurisdictionReconfirmationInfrastructureUnavailable) {
		t.Fatalf("unwired infrastructure error = %v", err)
	}
	if receipts, events, audits := jurisdictionEvidenceCounts(t, pool, tenantID, id); receipts != 0 || events != 0 || audits != 0 {
		t.Fatalf("unwired attempt wrote evidence: receipts=%d events=%d audits=%d",
			receipts, events, audits)
	}
}

func callJurisdictionReconfirmHandler(
	t *testing.T,
	repo *Repo,
	tenantID, subscriberID string,
	in JurisdictionReconfirmInput,
) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(in)
	if err != nil {
		t.Fatalf("marshal jurisdiction request: %v", err)
	}
	req := httptest.NewRequest(
		http.MethodPatch,
		"/api/v1/subscribers/"+subscriberID+"/jurisdiction-reconfirm",
		bytes.NewReader(body),
	)
	req.Header.Set("Content-Type", "application/json")
	routeCtx := chi.NewRouteContext()
	routeCtx.URLParams.Add("id", subscriberID)
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, routeCtx)
	ctx = middleware.WithTenant(ctx, &middleware.Tenant{ID: tenantID})
	req = req.WithContext(ctx)

	recorder := httptest.NewRecorder()
	(&Deps{Repo: repo}).JurisdictionReconfirm(recorder, req)
	return recorder
}

func TestJurisdictionReconfirmHandlerReturnsFreshVersionETagAndStableReplay(t *testing.T) {
	pool := newJurisdictionReconfirmTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	tenantID := uuid.NewString()
	seedJurisdictionReconfirmTenant(t, pool, tenantID)
	changedAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	id := seedJurisdictionReconfirmSubscriber(
		t, pool, tenantID, "jurisdiction-http-"+uuid.NewString()+"@example.test",
		StatusDisabled, "DE", "", changedAt, true,
	)
	in := jurisdictionReconfirmDBInput(
		t, pool, tenantID, id, "accepted", "gdpr", changedAt,
	)
	repo := jurisdictionReconfirmRepo(pool)

	first := callJurisdictionReconfirmHandler(t, repo, tenantID, id, in)
	if first.Code != http.StatusOK {
		t.Fatalf("first response = %d %s", first.Code, first.Body.String())
	}
	var committed Subscriber
	if err := json.Unmarshal(first.Body.Bytes(), &committed); err != nil {
		t.Fatalf("decode first response: %v", err)
	}
	if committed.ID != id || committed.JurisdictionReconfirmRequired {
		t.Fatalf("first response identity/state = id:%q required:%v", committed.ID, committed.JurisdictionReconfirmRequired)
	}
	if committed.Version == "" || committed.Version == in.ExpectedSubscriberVersion {
		t.Fatalf("first response version = %q, reviewed = %q", committed.Version, in.ExpectedSubscriberVersion)
	}
	if etag := first.Header().Get("ETag"); etag != committed.Version {
		t.Fatalf("first ETag = %q, body version = %q", etag, committed.Version)
	}

	replay := callJurisdictionReconfirmHandler(t, repo, tenantID, id, in)
	if replay.Code != http.StatusOK {
		t.Fatalf("replay response = %d %s", replay.Code, replay.Body.String())
	}
	var replayed Subscriber
	if err := json.Unmarshal(replay.Body.Bytes(), &replayed); err != nil {
		t.Fatalf("decode replay response: %v", err)
	}
	if replayed.ID != committed.ID || replayed.Version != committed.Version || replayed.JurisdictionReconfirmRequired {
		t.Fatalf("replay response = id:%q version:%q required:%v; first id:%q version:%q",
			replayed.ID, replayed.Version, replayed.JurisdictionReconfirmRequired,
			committed.ID, committed.Version,
		)
	}
	if etag := replay.Header().Get("ETag"); etag != replayed.Version {
		t.Fatalf("replay ETag = %q, body version = %q", etag, replayed.Version)
	}
	if receipts, events, audits := jurisdictionEvidenceCounts(t, pool, tenantID, id); receipts != 1 || events != 1 || audits != 1 {
		t.Fatalf("replay duplicated evidence: receipts=%d events=%d audits=%d", receipts, events, audits)
	}
}

func TestReconfirmJurisdictionAtomicAcceptedAndDeclined(t *testing.T) {
	pool := newJurisdictionReconfirmTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	tenantID := uuid.NewString()
	seedJurisdictionReconfirmTenant(t, pool, tenantID)
	repo := jurisdictionReconfirmRepo(pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	t.Run("accepted", func(t *testing.T) {
		changedAt := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Microsecond)
		email := "jurisdiction-accept-" + uuid.NewString() + "@example.test"
		id := seedJurisdictionReconfirmSubscriber(t, pool, tenantID, email, StatusDisabled, "DE", "", changedAt, true)
		in := jurisdictionReconfirmDBInput(t, pool, tenantID, id, "accepted", "gdpr", changedAt)
		got, applied, err := repo.ReconfirmJurisdiction(ctx, tenantID, id, in, db.AuditMeta{
			IP: "203.0.113.7", UserAgent: "jurisdiction-test/1.0",
		})
		if err != nil {
			t.Fatalf("reconfirm accepted: %v", err)
		}
		if !applied {
			t.Fatal("first accepted decision was classified as a replay")
		}
		if got.JurisdictionReconfirmRequired || got.Status != StatusEnabled || got.MailchimpStatus != "subscribed" {
			t.Fatalf("accepted projection = flag:%v status:%q mailchimp:%q", got.JurisdictionReconfirmRequired, got.Status, got.MailchimpStatus)
		}
		if got.ConsentEmailMarketingAt == nil || got.ConsentTimestamp == nil || got.ConsentSource != ConsentAPI {
			t.Fatalf("accepted consent projection incomplete: %+v", got)
		}
		if got.Version == "" || got.Version == in.ExpectedSubscriberVersion {
			t.Fatalf("accepted response version = %q, reviewed = %q", got.Version, in.ExpectedSubscriberVersion)
		}

		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		var receiptState, receiptSource, detail, policy, captured, ip, userAgent string
		if err := tx.QueryRow(ctx, `
SELECT new_state, source, source_detail, privacy_policy_version, captured_text,
       COALESCE(host(ip), ''), COALESCE(user_agent, '')
  FROM consent_receipts
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND source = 'jurisdiction_reconfirm'`, tenantID, id).Scan(
			&receiptState, &receiptSource, &detail, &policy, &captured, &ip, &userAgent,
		); err != nil {
			t.Fatalf("read receipt: %v", err)
		}
		if receiptState != "subscribed" || receiptSource != "jurisdiction_reconfirm" || policy != in.PrivacyPolicyVersion || captured != in.CapturedText || ip != "203.0.113.7" || userAgent != "jurisdiction-test/1.0" {
			t.Fatalf("receipt mismatch: state=%q source=%q policy=%q captured=%q ip=%q ua=%q", receiptState, receiptSource, policy, captured, ip, userAgent)
		}
		if !strings.Contains(detail, `"regime":"gdpr"`) ||
			!strings.Contains(detail, `"decision":"accepted"`) ||
			!strings.Contains(detail, `"subscriber_version":`+fmt.Sprintf("%q", in.ExpectedSubscriberVersion)) {
			t.Fatalf("receipt detail = %s", detail)
		}
		var addressID, addressStatus, addressReconciliation, terminalDecision string
		var addressSuppressed bool
		if err := tx.QueryRow(ctx, `
SELECT address.id::text, address.consent_status, address.suppressed,
       address.consent_reconciliation_state,
       public.subscriber_email_latest_decision(
           address.tenant_id, address.subscriber_id, address.id,
           address.email::text
       )
  FROM subscriber_emails AS address
 WHERE address.tenant_id = $1::uuid
   AND address.subscriber_id = $2::uuid
   AND lower(address.email::text) = lower($3)`, tenantID, id, email).Scan(
			&addressID, &addressStatus, &addressSuppressed,
			&addressReconciliation, &terminalDecision,
		); err != nil {
			t.Fatalf("read exact address projection: %v", err)
		}
		if addressStatus != "subscribed" || addressSuppressed ||
			addressReconciliation != "proven" || terminalDecision != "granted" {
			t.Fatalf("exact address = %q suppressed:%v reconciliation:%q terminal:%q",
				addressStatus, addressSuppressed, addressReconciliation, terminalDecision)
		}
		var eventID, eventSubject, eventEmail, eventSource, action, eventPolicy, proof string
		if err := tx.QueryRow(ctx, `
SELECT id::text, subject_id, subject_email::text, source, action,
       policy_version, proof_text
  FROM consent_events
	 WHERE tenant_id = $1::uuid
	   AND preferences ->> 'subscriber_id' = $2
	   AND preferences ->> 'operation' = 'jurisdiction_reconfirmation'`,
			tenantID, id).Scan(
			&eventID, &eventSubject, &eventEmail, &eventSource, &action,
			&eventPolicy, &proof,
		); err != nil {
			t.Fatalf("read canonical event: %v", err)
		}
		var recordID, recordStatus, recordSource, proofEventID, proofAddressID string
		if err := tx.QueryRow(ctx, `
SELECT id::text, consent_status, source, evidence ->> 'event_id',
       evidence ->> 'address_id'
  FROM consent_records
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND evidence ->> 'operation' = 'jurisdiction_reconfirmation'`,
			tenantID, id).Scan(
			&recordID, &recordStatus, &recordSource, &proofEventID,
			&proofAddressID,
		); err != nil {
			t.Fatalf("read canonical proof: %v", err)
		}
		var channelStatus, channelSource string
		if err := tx.QueryRow(ctx, `
SELECT status, consent_source
  FROM subscriber_channel_consents
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND channel = 'email'`, tenantID, id).Scan(&channelStatus, &channelSource); err != nil {
			t.Fatalf("read channel projection: %v", err)
		}
		if eventSubject != addressID ||
			normalizedJurisdictionEmail(eventEmail) != normalizedJurisdictionEmail(email) ||
			eventSource != "direct_request" || action != "granted" ||
			eventPolicy != in.PrivacyPolicyVersion ||
			!strings.HasPrefix(proof, "jurisdiction_reconfirm:consent_receipt:") ||
			recordStatus != "granted" || recordSource != "admin" ||
			proofEventID != eventID || proofAddressID != addressID ||
			channelStatus != "opted_in" || channelSource != "jurisdiction_reconfirm" {
			t.Fatalf("canonical pair = event:%q/%q/%q proof:%q/%q link:%q/%q channel:%q/%q",
				eventSubject, eventSource, action, recordID, recordStatus,
				proofEventID, proofAddressID, channelStatus, channelSource)
		}
		var auditReceipt, auditAddress, auditEvent, auditRecord, auditVersion string
		if err := tx.QueryRow(ctx, `
SELECT metadata ->> 'consent_receipt_id', metadata ->> 'email_address_id',
       metadata ->> 'canonical_consent_event_id',
       metadata ->> 'canonical_consent_record_id',
       metadata ->> 'reviewed_subscriber_version'
  FROM audit_log
 WHERE tenant_id = $1::uuid AND resource_id = $2
   AND action = 'subscriber.jurisdiction_reconfirmed'
		 ORDER BY created_at DESC LIMIT 1`, tenantID, id).Scan(
			&auditReceipt, &auditAddress, &auditEvent, &auditRecord, &auditVersion,
		); err != nil {
			t.Fatalf("read audit evidence links: %v", err)
		}
		if auditReceipt == "" || auditAddress != addressID || auditEvent != eventID ||
			auditRecord != recordID || auditVersion != in.ExpectedSubscriberVersion {
			t.Fatalf("audit evidence links: receipt=%q address=%q event=%q record=%q version=%q",
				auditReceipt, auditAddress, auditEvent, auditRecord, auditVersion)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		replayed, reapplied, err := repo.ReconfirmJurisdiction(
			ctx, tenantID, id, in, db.AuditMeta{},
		)
		if err != nil || reapplied || replayed.Version != got.Version {
			t.Fatalf("exact retry subscriber=%#v applied=%v err=%v, want version %q",
				replayed, reapplied, err, got.Version)
		}
		if receipts, events, audits := jurisdictionEvidenceCounts(t, pool, tenantID, id); receipts != 1 || events != 1 || audits != 1 {
			t.Fatalf("exact retry duplicated evidence: receipts=%d events=%d audits=%d",
				receipts, events, audits)
		}

		otherTenant := uuid.NewString()
		otherTx, err := db.WithTenant(ctx, pool, otherTenant)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = otherTx.Rollback(ctx) }()
		var visible int
		if err := otherTx.QueryRow(ctx, `SELECT count(*) FROM consent_receipts WHERE subscriber_id = $1::uuid`, id).Scan(&visible); err != nil {
			t.Fatal(err)
		}
		if visible != 0 {
			t.Fatalf("cross-tenant receipt visibility = %d, want 0", visible)
		}
		if _, _, err := repo.ReconfirmJurisdiction(ctx, otherTenant, id, in, db.AuditMeta{}); !errors.Is(err, ErrNotFound) {
			t.Fatalf("cross-tenant mutation error = %v, want ErrNotFound", err)
		}
	})

	t.Run("declined", func(t *testing.T) {
		changedAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
		email := "jurisdiction-decline-" + uuid.NewString() + "@example.test"
		id := seedJurisdictionReconfirmSubscriber(t, pool, tenantID, email, StatusEnabled, "CA", "", changedAt, true)
		in := jurisdictionReconfirmDBInput(t, pool, tenantID, id, "declined", "casl", changedAt)
		got, applied, err := repo.ReconfirmJurisdiction(ctx, tenantID, id, in, db.AuditMeta{})
		if err != nil {
			t.Fatalf("reconfirm declined: %v", err)
		}
		if !applied {
			t.Fatal("first declined decision was classified as a replay")
		}
		if got.JurisdictionReconfirmRequired || got.Status != StatusDisabled || got.MailchimpStatus != "unsubscribed" || got.ConsentEmailMarketingAt != nil {
			t.Fatalf("declined projection = flag:%v status:%q mailchimp:%q consent:%v", got.JurisdictionReconfirmRequired, got.Status, got.MailchimpStatus, got.ConsentEmailMarketingAt)
		}
		if got.Version == "" || got.Version == in.ExpectedSubscriberVersion {
			t.Fatalf("declined response version = %q, reviewed = %q", got.Version, in.ExpectedSubscriberVersion)
		}
		tx, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		var receiptState, action, channelStatus string
		if err := tx.QueryRow(ctx, `SELECT new_state FROM consent_receipts WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND source = 'jurisdiction_reconfirm'`, tenantID, id).Scan(&receiptState); err != nil {
			t.Fatal(err)
		}
		if err := tx.QueryRow(ctx, `SELECT action FROM consent_events WHERE tenant_id = $1::uuid AND preferences ->> 'subscriber_id' = $2 AND preferences ->> 'operation' = 'jurisdiction_reconfirmation'`, tenantID, id).Scan(&action); err != nil {
			t.Fatal(err)
		}
		if err := tx.QueryRow(ctx, `SELECT status FROM subscriber_channel_consents WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid AND channel = 'email'`, tenantID, id).Scan(&channelStatus); err != nil {
			t.Fatal(err)
		}
		var addressStatus, reconciliationState, recordStatus string
		var addressSuppressed, safetyHold bool
		if err := tx.QueryRow(ctx, `
SELECT consent_status, suppressed, consent_reconciliation_state
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND lower(email::text) = lower($3)`, tenantID, id, email).Scan(
			&addressStatus, &addressSuppressed, &reconciliationState,
		); err != nil {
			t.Fatal(err)
		}
		if err := tx.QueryRow(ctx, `
SELECT consent_status FROM consent_records
 WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
   AND evidence ->> 'operation' = 'jurisdiction_reconfirmation'`, tenantID, id).Scan(&recordStatus); err != nil {
			t.Fatal(err)
		}
		if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM subscriber_suppressions
     WHERE tenant_id = $1::uuid AND lower(email::text) = lower($2)
       AND metadata ->> 'operation' = 'jurisdiction_reconfirmation'
)`, tenantID, email).Scan(&safetyHold); err != nil {
			t.Fatal(err)
		}
		if receiptState != "unsubscribed" || action != "revoked" ||
			channelStatus != "opted_out" || addressStatus != "unsubscribed" ||
			!addressSuppressed || reconciliationState != "failed_closed" ||
			recordStatus != "withdrawn" || !safetyHold {
			t.Fatalf("declined evidence = receipt:%q event:%q channel:%q", receiptState, action, channelStatus)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	})
}

func TestReconfirmJurisdictionConflictsAndConcurrentExactOnce(t *testing.T) {
	pool := newJurisdictionReconfirmTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	tenantID := uuid.NewString()
	seedJurisdictionReconfirmTenant(t, pool, tenantID)
	repo := jurisdictionReconfirmRepo(pool)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	t.Run("stale timestamp", func(t *testing.T) {
		changedAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
		id := seedJurisdictionReconfirmSubscriber(t, pool, tenantID, "stale-"+uuid.NewString()+"@example.test", StatusDisabled, "DE", "", changedAt, true)
		in := jurisdictionReconfirmDBInput(t, pool, tenantID, id, "accepted", "gdpr", changedAt.Add(-time.Second))
		if _, _, err := repo.ReconfirmJurisdiction(ctx, tenantID, id, in, db.AuditMeta{}); !errors.Is(err, ErrJurisdictionReconfirmationStale) {
			t.Fatalf("error = %v, want stale", err)
		}
		if r, e, a := jurisdictionEvidenceCounts(t, pool, tenantID, id); r != 0 || e != 0 || a != 0 {
			t.Fatalf("stale attempt wrote evidence: receipts=%d events=%d audits=%d", r, e, a)
		}
	})

	t.Run("server regime mismatch", func(t *testing.T) {
		changedAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
		id := seedJurisdictionReconfirmSubscriber(t, pool, tenantID, "mismatch-"+uuid.NewString()+"@example.test", StatusDisabled, "CA", "", changedAt, true)
		in := jurisdictionReconfirmDBInput(t, pool, tenantID, id, "accepted", "gdpr", changedAt)
		if _, _, err := repo.ReconfirmJurisdiction(ctx, tenantID, id, in, db.AuditMeta{}); !errors.Is(err, ErrJurisdictionReconfirmationRegimeMismatch) {
			t.Fatalf("error = %v, want regime mismatch", err)
		}
		if r, e, a := jurisdictionEvidenceCounts(t, pool, tenantID, id); r != 0 || e != 0 || a != 0 {
			t.Fatalf("mismatch wrote evidence: receipts=%d events=%d audits=%d", r, e, a)
		}
	})

	t.Run("unclassifiable pending state", func(t *testing.T) {
		changedAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
		id := seedJurisdictionReconfirmSubscriber(t, pool, tenantID, "invalid-state-"+uuid.NewString()+"@example.test", StatusDisabled, "JP", "", changedAt, true)
		in := jurisdictionReconfirmDBInput(t, pool, tenantID, id, "accepted", "gdpr", changedAt)
		if _, _, err := repo.ReconfirmJurisdiction(ctx, tenantID, id, in, db.AuditMeta{}); !errors.Is(err, ErrJurisdictionReconfirmationStateInvalid) {
			t.Fatalf("error = %v, want invalid state", err)
		}
	})

	t.Run("accepted decision cannot bypass reviewed resubscribe", func(t *testing.T) {
		changedAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
		email := "blocklisted-reconfirm-" + uuid.NewString() + "@example.test"
		id := seedJurisdictionReconfirmSubscriber(
			t, pool, tenantID, email, StatusBlocklisted, "DE", "", changedAt, true,
		)
		seed, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("blocklisted hold tx: %v", err)
		}
		if _, err := seed.Exec(ctx, `
INSERT INTO subscriber_suppressions (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, 'manual_unsubscribe', 'api', '{"reviewed":true}'::jsonb)`, tenantID, email); err != nil {
			_ = seed.Rollback(ctx)
			t.Fatalf("seed blocklisted hold: %v", err)
		}
		if err := seed.Commit(ctx); err != nil {
			t.Fatalf("commit blocklisted hold: %v", err)
		}
		in := jurisdictionReconfirmDBInput(t, pool, tenantID, id, "accepted", "gdpr", changedAt)
		if _, _, err := repo.ReconfirmJurisdiction(
			ctx, tenantID, id, in, db.AuditMeta{},
		); !errors.Is(err, ErrJurisdictionReconfirmationStateInvalid) {
			t.Fatalf("blocklisted acceptance error = %v, want state invalid", err)
		}
		if receipts, events, audits := jurisdictionEvidenceCounts(t, pool, tenantID, id); receipts != 0 || events != 0 || audits != 0 {
			t.Fatalf("blocklisted attempt wrote evidence: receipts=%d events=%d audits=%d",
				receipts, events, audits)
		}
		verify, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("blocklisted verify tx: %v", err)
		}
		defer func() { _ = verify.Rollback(ctx) }()
		var required bool
		var status string
		var holds int
		if err := verify.QueryRow(ctx, `
SELECT jurisdiction_reconfirm_required, status,
       (SELECT count(*) FROM subscriber_suppressions
         WHERE tenant_id = $1::uuid AND lower(email::text) = lower($3))
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id, email).Scan(
			&required, &status, &holds,
		); err != nil {
			t.Fatalf("read blocklisted rollback: %v", err)
		}
		if !required || status != StatusBlocklisted || holds != 1 {
			t.Fatalf("blocklisted rollback required=%v status=%q holds=%d", required, status, holds)
		}
	})

	t.Run("canonical email rotation invalidates reviewed version", func(t *testing.T) {
		changedAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
		oldEmail := "versioned-address-before-" + uuid.NewString() + "@example.test"
		newEmail := "versioned-address-after-" + uuid.NewString() + "@example.test"
		id := seedJurisdictionReconfirmSubscriber(
			t, pool, tenantID, oldEmail, StatusDisabled, "DE", "", changedAt, true,
		)
		in := jurisdictionReconfirmDBInput(t, pool, tenantID, id, "accepted", "gdpr", changedAt)
		rotate, err := db.WithTenant(ctx, pool, tenantID)
		if err != nil {
			t.Fatalf("email rotation tx: %v", err)
		}
		if _, err := rotate.Exec(ctx, `
UPDATE subscribers
   SET email = $3, primary_email = $3, updated_at = clock_timestamp()
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id, newEmail); err != nil {
			_ = rotate.Rollback(ctx)
			t.Fatalf("rotate canonical email: %v", err)
		}
		if err := rotate.Commit(ctx); err != nil {
			t.Fatalf("commit canonical email rotation: %v", err)
		}
		if _, _, err := repo.ReconfirmJurisdiction(
			ctx, tenantID, id, in, db.AuditMeta{},
		); !errors.Is(err, ErrJurisdictionReconfirmationStale) {
			t.Fatalf("rotated-address decision error = %v, want stale", err)
		}
		if receipts, events, audits := jurisdictionEvidenceCounts(t, pool, tenantID, id); receipts != 0 || events != 0 || audits != 0 {
			t.Fatalf("rotated-address attempt wrote evidence: receipts=%d events=%d audits=%d",
				receipts, events, audits)
		}
		current, err := repo.Get(ctx, tenantID, id)
		if err != nil {
			t.Fatalf("read rotated subscriber: %v", err)
		}
		if normalizedJurisdictionEmail(current.Email) != normalizedJurisdictionEmail(newEmail) ||
			!current.JurisdictionReconfirmRequired || current.Version == in.ExpectedSubscriberVersion {
			t.Fatalf("rotated subscriber = %#v, reviewed version %q", current, in.ExpectedSubscriberVersion)
		}
	})

	t.Run("two writers produce one receipt", func(t *testing.T) {
		changedAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
		id := seedJurisdictionReconfirmSubscriber(t, pool, tenantID, "concurrent-"+uuid.NewString()+"@example.test", StatusDisabled, "DE", "", changedAt, true)
		in := jurisdictionReconfirmDBInput(t, pool, tenantID, id, "accepted", "gdpr", changedAt)
		start := make(chan struct{})
		type outcome struct {
			applied bool
			err     error
		}
		outcomes := make(chan outcome, 2)
		var wg sync.WaitGroup
		for range 2 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				_, applied, err := repo.ReconfirmJurisdiction(ctx, tenantID, id, in, db.AuditMeta{})
				outcomes <- outcome{applied: applied, err: err}
			}()
		}
		close(start)
		wg.Wait()
		close(outcomes)
		var applied, replayed int
		for outcome := range outcomes {
			switch {
			case outcome.err == nil && outcome.applied:
				applied++
			case outcome.err == nil && !outcome.applied:
				replayed++
			default:
				t.Fatalf("unexpected concurrent result: applied=%v err=%v", outcome.applied, outcome.err)
			}
		}
		if applied != 1 || replayed != 1 {
			t.Fatalf("concurrent outcomes = applied:%d replayed:%d", applied, replayed)
		}
		if r, e, a := jurisdictionEvidenceCounts(t, pool, tenantID, id); r != 1 || e != 1 || a != 1 {
			t.Fatalf("exact-once evidence = receipts:%d events:%d audits:%d", r, e, a)
		}
		conflicting := in
		conflicting.CapturedText = "Different consent copy must not become a replay."
		if _, _, err := repo.ReconfirmJurisdiction(ctx, tenantID, id, conflicting, db.AuditMeta{}); !errors.Is(err, ErrJurisdictionReconfirmationNotRequired) {
			t.Fatalf("conflicting retry error = %v, want not-required conflict", err)
		}
		if r, e, a := jurisdictionEvidenceCounts(t, pool, tenantID, id); r != 1 || e != 1 || a != 1 {
			t.Fatalf("conflicting retry changed evidence = receipts:%d events:%d audits:%d", r, e, a)
		}
	})
}

func TestJurisdictionReconfirmExactAddressBoundaryRejectsMismatches(t *testing.T) {
	pool := newJurisdictionReconfirmTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	tenantID := uuid.NewString()
	seedJurisdictionReconfirmTenant(t, pool, tenantID)
	changedAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	idA := seedJurisdictionReconfirmSubscriber(
		t, pool, tenantID, "jurisdiction-address-a-"+uuid.NewString()+"@example.test",
		StatusDisabled, "DE", "", changedAt, true,
	)
	idB := seedJurisdictionReconfirmSubscriber(
		t, pool, tenantID, "jurisdiction-address-b-"+uuid.NewString()+"@example.test",
		StatusDisabled, "DE", "", changedAt, true,
	)
	repo := jurisdictionReconfirmRepo(pool)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	subscriberA, err := repo.Get(ctx, tenantID, idA)
	if err != nil {
		t.Fatalf("read subscriber A: %v", err)
	}
	subscriberB, err := repo.Get(ctx, tenantID, idB)
	if err != nil {
		t.Fatalf("read subscriber B: %v", err)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("mismatch tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	wrongEmail, _, err := lockEmailConsentAddressForRepair(
		ctx, tx, tenantID, subscriberA.ID, subscriberB.Email,
	)
	if err != nil {
		t.Fatalf("resolve wrong email: %v", err)
	}
	if wrongEmail != nil {
		t.Fatalf("wrong email resolved address %#v", wrongEmail)
	}
	wrongSubscriber, _, err := lockEmailConsentAddressForRepair(
		ctx, tx, tenantID, subscriberB.ID, subscriberA.Email,
	)
	if err != nil {
		t.Fatalf("resolve mismatched subscriber: %v", err)
	}
	if wrongSubscriber != nil {
		t.Fatalf("mismatched subscriber resolved address %#v", wrongSubscriber)
	}
	addressB, _, err := lockEmailConsentAddressForRepair(
		ctx, tx, tenantID, subscriberB.ID, subscriberB.Email,
	)
	if err != nil || addressB == nil {
		t.Fatalf("resolve subscriber B address = %#v, %v", addressB, err)
	}
	if err := validateJurisdictionConsentAddress(subscriberA, addressB); !errors.Is(err, ErrJurisdictionReconfirmationStateInvalid) {
		t.Fatalf("cross-subscriber address validation = %v, want state invalid", err)
	}
	if _, _, _, err := recordJurisdictionConsentEvidence(
		ctx, tx, tenantID, subscriberA, addressB, 1,
		jurisdictionReconfirmDBInput(t, pool, tenantID, idA, "accepted", "gdpr", changedAt),
		time.Now().UTC(), db.AuditMeta{},
	); !errors.Is(err, ErrJurisdictionReconfirmationStateInvalid) {
		t.Fatalf("cross-subscriber evidence error = %v, want state invalid", err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatalf("rollback mismatch tx: %v", err)
	}
	if r, e, a := jurisdictionEvidenceCounts(t, pool, tenantID, idA); r != 0 || e != 0 || a != 0 {
		t.Fatalf("mismatch leaked evidence: receipts=%d events=%d audits=%d", r, e, a)
	}
}

func TestJurisdictionReconfirmRenewsGateHiddenExpiredAddress(t *testing.T) {
	pool := newJurisdictionReconfirmTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	tenantID := uuid.NewString()
	seedJurisdictionReconfirmTenant(t, pool, tenantID)
	changedAt := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Microsecond)
	id := seedJurisdictionReconfirmSubscriber(
		t, pool, tenantID, "jurisdiction-hidden-"+uuid.NewString()+"@example.test",
		StatusDisabled, "DE", "", changedAt, true,
	)
	repo := jurisdictionReconfirmRepo(pool)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	subscriber, err := repo.Get(ctx, tenantID, id)
	if err != nil {
		t.Fatalf("read hidden-row subscriber: %v", err)
	}
	address := migration1766AddressForSubscriber(t, pool, tenantID, subscriber)
	expiresAt := time.Now().UTC().Add(350 * time.Millisecond)
	appendMigration1766ExactGrant(
		t, pool, tenantID, address, time.Now().UTC().Add(-time.Hour), expiresAt,
		"privacy-before-jurisdiction", "jurisdiction-expired-prior-grant",
	)
	waitForConsentProofExpiry(t, expiresAt)
	assertConsentAddressHiddenFromApp(t, pool, tenantID, address)

	updated, applied, err := repo.ReconfirmJurisdiction(
		ctx, tenantID, id,
		jurisdictionReconfirmDBInput(t, pool, tenantID, id, "accepted", "gdpr", changedAt),
		db.AuditMeta{},
	)
	if err != nil {
		t.Fatalf("renew hidden exact address: %v", err)
	}
	if !applied || updated.Status != StatusEnabled || updated.ConsentEmailMarketingAt == nil {
		t.Fatalf("hidden renewal response applied=%v subscriber=%#v", applied, updated)
	}
	resolved := migration1766AddressForSubscriber(t, pool, tenantID, updated)
	if resolved.ID != address.ID {
		t.Fatalf("hidden renewal changed immutable address %q -> %q", address.ID, resolved.ID)
	}
	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("hidden renewal verify tx: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var status, reconciliation, terminal string
	if err := verify.QueryRow(ctx, `
SELECT consent_status, consent_reconciliation_state,
       public.subscriber_email_latest_decision(
           tenant_id, subscriber_id, id, email::text
       )
  FROM subscriber_emails
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, address.ID).Scan(
		&status, &reconciliation, &terminal,
	); err != nil {
		t.Fatalf("read hidden renewal terminal: %v", err)
	}
	if status != "subscribed" || reconciliation != "proven" || terminal != "granted" {
		t.Fatalf("hidden renewal terminal=%q/%q/%q", status, reconciliation, terminal)
	}
}

func TestJurisdictionReconfirmProtectedSuppressionRollsBack(t *testing.T) {
	pool := newJurisdictionReconfirmTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	tenantID := uuid.NewString()
	seedJurisdictionReconfirmTenant(t, pool, tenantID)
	changedAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	email := "jurisdiction-protected-" + uuid.NewString() + "@example.test"
	id := seedJurisdictionReconfirmSubscriber(
		t, pool, tenantID, email, StatusDisabled, "DE", "", changedAt, true,
	)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("protected hold tx: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, 'complaint', 'jurisdiction-test', '{}'::jsonb)`,
		tenantID, email); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed complaint hold: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit complaint hold: %v", err)
	}

	repo := jurisdictionReconfirmRepo(pool)
	_, _, err = repo.ReconfirmJurisdiction(
		ctx, tenantID, id,
		jurisdictionReconfirmDBInput(t, pool, tenantID, id, "accepted", "gdpr", changedAt),
		db.AuditMeta{},
	)
	if !errors.Is(err, ErrProtectedEmailSuppression) {
		t.Fatalf("protected acceptance error = %v, want protected suppression", err)
	}
	if r, e, a := jurisdictionEvidenceCounts(t, pool, tenantID, id); r != 0 || e != 0 || a != 0 {
		t.Fatalf("protected attempt leaked evidence: receipts=%d events=%d audits=%d", r, e, a)
	}
	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("protected verify tx: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var required, purposeGranted bool
	var status string
	var records, channels, holds int
	if err := verify.QueryRow(ctx, `
SELECT jurisdiction_reconfirm_required, status,
       consent_email_marketing_at IS NOT NULL
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id).Scan(
		&required, &status, &purposeGranted,
	); err != nil {
		t.Fatalf("read protected subscriber: %v", err)
	}
	if err := verify.QueryRow(ctx, `
SELECT (SELECT count(*) FROM consent_records
         WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid
           AND evidence ->> 'operation' = 'jurisdiction_reconfirmation'),
       (SELECT count(*) FROM subscriber_channel_consents
         WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid),
       (SELECT count(*) FROM email_suppressions
         WHERE tenant_id = $1::uuid AND lower(email::text) = lower($3)
           AND reason = 'complaint')`, tenantID, id, email).Scan(
		&records, &channels, &holds,
	); err != nil {
		t.Fatalf("read protected rollback state: %v", err)
	}
	if !required || status != StatusDisabled || purposeGranted ||
		records != 0 || channels != 0 || holds != 1 {
		t.Fatalf("protected rollback required=%v status=%q purpose=%v records=%d channels=%d holds=%d",
			required, status, purposeGranted, records, channels, holds)
	}
}

func TestJurisdictionReconfirmAcceptedClearsReviewedUnsubscribeHolds(t *testing.T) {
	pool := newJurisdictionReconfirmTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	tenantID := uuid.NewString()
	seedJurisdictionReconfirmTenant(t, pool, tenantID)
	changedAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	email := "jurisdiction-reviewed-holds-" + uuid.NewString() + "@example.test"
	id := seedJurisdictionReconfirmSubscriber(
		t, pool, tenantID, email, StatusDisabled, "DE", "", changedAt, true,
	)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("reviewed holds tx: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO subscriber_suppressions (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, 'manual_unsubscribe', 'api', '{"reviewed":true}'::jsonb)`, tenantID, email); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed subscriber suppression: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, 'manual_unsubscribe', 'api', '{"reviewed":true}'::jsonb)`, tenantID, email); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed email suppression: %v", err)
	}
	if _, err := seed.Exec(ctx, `
INSERT INTO suppressions (tenant_id, email, reason)
VALUES ($1::uuid, $2, 'manual_unsubscribe')`, tenantID, email); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed legacy suppression: %v", err)
	}
	if err := seed.Commit(ctx); err != nil {
		t.Fatalf("commit reviewed holds: %v", err)
	}

	repo := jurisdictionReconfirmRepo(pool)
	updated, applied, err := repo.ReconfirmJurisdiction(
		ctx, tenantID, id,
		jurisdictionReconfirmDBInput(t, pool, tenantID, id, "accepted", "gdpr", changedAt),
		db.AuditMeta{},
	)
	if err != nil {
		t.Fatalf("accept reviewed unsubscribe holds: %v", err)
	}
	if !applied || updated.Status != StatusEnabled || updated.ConsentEmailMarketingAt == nil {
		t.Fatalf("reviewed-hold response applied=%v subscriber=%#v", applied, updated)
	}
	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("reviewed holds verify tx: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var holds int
	if err := verify.QueryRow(ctx, `
SELECT count(*) FROM v_suppressions_unified
 WHERE tenant_id = $1::uuid AND lower(email) = lower($2)
   AND (expires_at IS NULL OR expires_at > now())`, tenantID, email).Scan(&holds); err != nil {
		t.Fatalf("read remaining reviewed holds: %v", err)
	}
	if holds != 0 {
		t.Fatalf("remaining reviewed holds = %d, want 0", holds)
	}
}

func TestJurisdictionReconfirmExactAddressLockContentionFailsBounded(t *testing.T) {
	pool := newJurisdictionReconfirmTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	tenantID := uuid.NewString()
	seedJurisdictionReconfirmTenant(t, pool, tenantID)
	changedAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	id := seedJurisdictionReconfirmSubscriber(
		t, pool, tenantID, "jurisdiction-contention-"+uuid.NewString()+"@example.test",
		StatusDisabled, "DE", "", changedAt, true,
	)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	subscriber, err := (&Repo{Pool: pool}).Get(ctx, tenantID, id)
	if err != nil {
		t.Fatalf("read contention subscriber: %v", err)
	}
	holder, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("lock-holder tx: %v", err)
	}
	defer func() { _ = holder.Rollback(context.Background()) }()
	if resolved, _, err := lockEmailConsentAddressForRepair(
		ctx, holder, tenantID, subscriber.ID, subscriber.Email,
	); err != nil || resolved == nil {
		t.Fatalf("hold exact-address lock resolved=%#v err=%v", resolved, err)
	}

	started := time.Now()
	_, _, err = jurisdictionReconfirmRepo(pool).
		ReconfirmJurisdiction(
			ctx, tenantID, id,
			jurisdictionReconfirmDBInput(t, pool, tenantID, id, "accepted", "gdpr", changedAt),
			db.AuditMeta{},
		)
	elapsed := time.Since(started)
	if !errors.Is(err, ErrConcurrentConsentDecision) {
		t.Fatalf("contending writer error = %v, want concurrent decision", err)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("bounded exact-address contention took %v", elapsed)
	}
	if err := holder.Rollback(ctx); err != nil {
		t.Fatalf("release exact-address lock: %v", err)
	}
	if r, e, a := jurisdictionEvidenceCounts(t, pool, tenantID, id); r != 0 || e != 0 || a != 0 {
		t.Fatalf("contending writer leaked evidence: receipts=%d events=%d audits=%d", r, e, a)
	}
}

func TestReconfirmJurisdictionLedgerFailureRollsBackEverything(t *testing.T) {
	pool := newJurisdictionReconfirmTestPool(t)
	requireMigration1766(t, pool)
	requireConsentRepairWriterAppRole(t, pool)
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_TEST_ADMIN_DATABASE_URL"))
	if adminURL == "" {
		t.Skip("POSTWAVE_TEST_ADMIN_DATABASE_URL not set; skipping forced ledger-failure proof")
	}
	admin, err := pgxpool.New(context.Background(), adminURL)
	if err != nil {
		t.Fatalf("connect admin: %v", err)
	}
	t.Cleanup(admin.Close)
	var appDB, adminDB string
	if err := pool.QueryRow(context.Background(), `SELECT current_database()`).Scan(&appDB); err != nil {
		t.Fatal(err)
	}
	if err := admin.QueryRow(context.Background(), `SELECT current_database()`).Scan(&adminDB); err != nil {
		t.Fatal(err)
	}
	if appDB != adminDB {
		t.Skipf("admin database %q does not match app database %q", adminDB, appDB)
	}

	tenantID := uuid.NewString()
	seedJurisdictionReconfirmTenant(t, pool, tenantID)
	changedAt := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	id := seedJurisdictionReconfirmSubscriber(t, pool, tenantID, "rollback-"+uuid.NewString()+"@example.test", StatusDisabled, "DE", "", changedAt, true)

	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	functionName := "jurisdiction_reconfirm_fail_" + suffix
	triggerName := "jurisdiction_reconfirm_fail_" + suffix
	functionIdent := pgx.Identifier{"public", functionName}.Sanitize()
	triggerIdent := pgx.Identifier{triggerName}.Sanitize()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := admin.Exec(ctx, fmt.Sprintf(`
CREATE FUNCTION %s() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
    IF NEW.tenant_id = '%s'::uuid AND
       NEW.preferences ->> 'operation' = 'jurisdiction_reconfirmation' THEN
        RAISE EXCEPTION 'forced jurisdiction consent event failure';
    END IF;
    RETURN NEW;
END
$fn$`, functionIdent, tenantID)); err != nil {
		t.Fatalf("create failure function: %v", err)
	}
	if _, err := admin.Exec(ctx, fmt.Sprintf(`
CREATE TRIGGER %s
BEFORE INSERT ON consent_events
FOR EACH ROW EXECUTE FUNCTION %s()`, triggerIdent, functionIdent)); err != nil {
		_, _ = admin.Exec(context.Background(), fmt.Sprintf(`DROP FUNCTION IF EXISTS %s()`, functionIdent))
		t.Fatalf("create failure trigger: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupCtx, fmt.Sprintf(`DROP TRIGGER IF EXISTS %s ON consent_events`, triggerIdent))
		_, _ = admin.Exec(cleanupCtx, fmt.Sprintf(`DROP FUNCTION IF EXISTS %s()`, functionIdent))
	})

	repo := jurisdictionReconfirmRepo(pool)
	in := jurisdictionReconfirmDBInput(t, pool, tenantID, id, "accepted", "gdpr", changedAt)
	if _, _, err := repo.ReconfirmJurisdiction(ctx, tenantID, id, in, db.AuditMeta{}); err == nil || !strings.Contains(err.Error(), "canonical jurisdiction consent evidence") {
		t.Fatalf("error = %v, want canonical event persistence failure", err)
	}
	if r, e, a := jurisdictionEvidenceCounts(t, pool, tenantID, id); r != 0 || e != 0 || a != 0 {
		t.Fatalf("failed tx leaked evidence: receipts=%d events=%d audits=%d", r, e, a)
	}
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var required bool
	var status string
	var consentAt *time.Time
	if err := tx.QueryRow(ctx, `
SELECT jurisdiction_reconfirm_required, status, consent_email_marketing_at
  FROM subscribers
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, id).Scan(&required, &status, &consentAt); err != nil {
		t.Fatal(err)
	}
	var channelRows int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM subscriber_channel_consents WHERE tenant_id = $1::uuid AND subscriber_id = $2::uuid`, tenantID, id).Scan(&channelRows); err != nil {
		t.Fatal(err)
	}
	if !required || status != StatusDisabled || consentAt != nil || channelRows != 0 {
		t.Fatalf("failed tx mutated subscriber: required=%v status=%q consent=%v channelRows=%d", required, status, consentAt, channelRows)
	}
}
