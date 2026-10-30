// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

type noOpChannelConsentWebhook struct{}

func (noOpChannelConsentWebhook) Fire(context.Context, pgx.Tx, WebhookFireInput) (int, error) {
	return 1, nil
}

func channelConsentDecision(status string, at time.Time) UpdateChannelConsentInput {
	source := "direct_request"
	channel := "desktop"
	basis := "consent"
	evidence := "reviewed-ticket:channel-consent"
	jurisdiction := "GB"
	reason := "subscriber decision reviewed by an authorized operator"
	policy := "privacy-2026-07"
	return UpdateChannelConsentInput{
		Status: &status, ConsentSource: &source, ConsentTimestamp: &at,
		EvidenceChannel: &channel, LegalBasis: &basis, Evidence: &evidence,
		Jurisdiction: &jurisdiction, Reason: &reason, PolicyVersion: &policy,
	}
}

func channelConsentRepo(pool *db.Pool) *Repo {
	return &Repo{
		Pool:             pool,
		Webhooks:         noOpChannelConsentWebhook{},
		EngineSyncOutbox: subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}},
	}
}

func seedChannelConsentSubscriber(t *testing.T, pool *db.Pool, tenantID string) *Subscriber {
	t.Helper()
	seedPrimaryEmailTenant(t, pool, tenantID)
	email := fmt.Sprintf("channel-consent-%d@example.test", time.Now().UnixNano())
	subscriber, err := (&Repo{Pool: pool}).Upsert(context.Background(), tenantID, CreateInput{
		Email: email, Status: StatusUnconfirmed, ConsentSource: ConsentUnknown,
	})
	if err != nil {
		t.Fatalf("seed subscriber: %v", err)
	}
	return subscriber
}

func TestEmailChannelConsentGrantAndRevokeConvergeDeliveryState(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41201"
	subscriber := seedChannelConsentSubscriber(t, pool, tenantID)
	repo := channelConsentRepo(pool)

	grant := channelConsentDecision("opted_in", time.Now().UTC().Add(-2*time.Hour).Truncate(time.Microsecond))
	grant.IfMatchToken = subscriber.Version
	granted, err := repo.SetChannelConsentWithAudit(ctx, tenantID, subscriber.ID, "email", grant, multiEmailAuditMeta(tenantID))
	if err != nil {
		t.Fatalf("grant email channel consent: %v", err)
	}
	if granted.Status != "opted_in" || granted.SubscriberVersion == "" || granted.SubscriberVersion == subscriber.Version {
		t.Fatalf("grant response = %#v", granted)
	}

	revoke := channelConsentDecision("opted_out", time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond))
	revoke.IfMatchToken = granted.SubscriberVersion
	revoked, err := repo.SetChannelConsentWithAudit(ctx, tenantID, subscriber.ID, "email", revoke, multiEmailAuditMeta(tenantID))
	if err != nil {
		t.Fatalf("revoke email channel consent: %v", err)
	}
	if revoked.Status != "opted_out" || revoked.SubscriberVersion == granted.SubscriberVersion {
		t.Fatalf("revoke response = %#v", revoked)
	}

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("verification tx: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var profileStatus, mailchimpStatus, addressStatus, channelStatus string
	var purposeGranted, addressSuppressed, campaignEligible bool
	var grants, withdrawals, proofs, audits, syncIntents int
	if err := tx.QueryRow(ctx, `
SELECT status, mailchimp_status, consent_email_marketing_at IS NOT NULL
  FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, subscriber.ID).
		Scan(&profileStatus, &mailchimpStatus, &purposeGranted); err != nil {
		t.Fatalf("read subscriber projection: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT consent_status, suppressed FROM subscriber_emails
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid
   AND lower(email::text)=lower($3)`, tenantID, subscriber.ID, subscriber.Email).
		Scan(&addressStatus, &addressSuppressed); err != nil {
		t.Fatalf("read address projection: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT status FROM subscriber_channel_consents
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid AND channel='email'`, tenantID, subscriber.ID).
		Scan(&channelStatus); err != nil {
		t.Fatalf("read channel projection: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT EXISTS (
    SELECT 1 FROM subscribers
     WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='enabled'
       AND consent_email_marketing_at IS NOT NULL
       AND EXISTS (
           SELECT 1 FROM subscriber_emails AS address
            WHERE address.tenant_id=subscribers.tenant_id
              AND address.subscriber_id=subscribers.id
              AND lower(address.email::text)=lower(subscribers.email::text)
              AND address.consent_status='subscribed' AND NOT address.suppressed
       )
)`, tenantID, subscriber.ID).Scan(&campaignEligible); err != nil {
		t.Fatalf("read campaign eligibility: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FILTER (WHERE action='granted'),
       count(*) FILTER (WHERE action='revoked')
  FROM consent_events
 WHERE tenant_id=$1::uuid AND subject_email=$2
   AND category='email_marketing'`, tenantID, subscriber.Email).Scan(&grants, &withdrawals); err != nil {
		t.Fatalf("read consent events: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM consent_records
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid AND email=$3
   AND consent_status IN ('granted','withdrawn')`, tenantID, subscriber.ID, subscriber.Email).Scan(&proofs); err != nil {
		t.Fatalf("read consent proofs: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM audit_log
 WHERE tenant_id=$1::uuid AND resource_id=$2
   AND action='subscriber.channel_consent_updated'`, tenantID, subscriber.ID).Scan(&audits); err != nil {
		t.Fatalf("read channel audits: %v", err)
	}
	if err := tx.QueryRow(ctx, `
SELECT count(*) FROM outbox_events
 WHERE tenant_id=$1::uuid AND kind=$2
   AND payload->>'subscriber_id'=$3`, tenantID, OutboxKindListmonkSync, subscriber.ID).Scan(&syncIntents); err != nil {
		t.Fatalf("read engine intents: %v", err)
	}
	if profileStatus != StatusBlocklisted || mailchimpStatus != "unsubscribed" || purposeGranted ||
		addressStatus != "unsubscribed" || !addressSuppressed || channelStatus != "opted_out" || campaignEligible ||
		grants != 1 || withdrawals != 1 || proofs != 2 || audits != 2 || syncIntents != 2 {
		t.Fatalf("non-converged withdrawal profile=%q mailchimp=%q purpose=%v address=%q/%v channel=%q eligible=%v events=%d/%d proofs=%d audits=%d sync=%d",
			profileStatus, mailchimpStatus, purposeGranted, addressStatus, addressSuppressed,
			channelStatus, campaignEligible, grants, withdrawals, proofs, audits, syncIntents)
	}
}

func TestEmailChannelConsentHandlerReturnsAndEnforcesFreshParentETag(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41202"
	subscriber := seedChannelConsentSubscriber(t, pool, tenantID)
	decision := channelConsentDecision("opted_in", time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond))
	body, err := json.Marshal(decision)
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}
	d := &Deps{Repo: channelConsentRepo(pool)}
	request := func(version string) *http.Request {
		req := httptest.NewRequestWithContext(ctx, http.MethodPatch,
			"/api/v1/subscribers/"+subscriber.ID+"/channel-consents/email",
			strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("If-Match", version)
		route := chi.NewRouteContext()
		route.URLParams.Add("id", subscriber.ID)
		route.URLParams.Add("channel", "email")
		requestContext := context.WithValue(req.Context(), chi.RouteCtxKey, route)
		requestContext = middleware.WithTenant(requestContext, &middleware.Tenant{ID: tenantID})
		return req.WithContext(requestContext)
	}

	recorder := httptest.NewRecorder()
	d.SetChannelConsent(recorder, request(subscriber.Version))
	if recorder.Code != http.StatusOK {
		t.Fatalf("grant status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var response ChannelConsent
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.SubscriberVersion == "" || response.SubscriberVersion != recorder.Header().Get("ETag") {
		t.Fatalf("body/header revisions = %q/%q", response.SubscriberVersion, recorder.Header().Get("ETag"))
	}

	stale := httptest.NewRecorder()
	d.SetChannelConsent(stale, request(subscriber.Version))
	if stale.Code != http.StatusPreconditionFailed {
		t.Fatalf("stale status=%d body=%s, want 412", stale.Code, stale.Body.String())
	}
}

func TestEmailChannelGrantCannotClearProtectedHolds(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for index, reason := range []string{"complaint", "hard_bounce", "dsar_deletion"} {
		t.Run(reason, func(t *testing.T) {
			tenantID := fmt.Sprintf("00000000-0000-4000-8000-%012d", 999999241210+index)
			subscriber := seedChannelConsentSubscriber(t, pool, tenantID)
			seed, err := db.WithTenant(ctx, pool, tenantID)
			if err != nil {
				t.Fatalf("suppression tx: %v", err)
			}
			if _, err := seed.Exec(ctx, `
INSERT INTO email_suppressions (tenant_id,email,reason,source,metadata)
VALUES ($1::uuid,$2,$3,'test',jsonb_build_object('gdpr_erasure',$3='dsar_deletion'))`,
				tenantID, subscriber.Email, reason); err != nil {
				_ = seed.Rollback(ctx)
				t.Fatalf("seed protected hold: %v", err)
			}
			if err := seed.Commit(ctx); err != nil {
				t.Fatalf("commit protected hold: %v", err)
			}

			grant := channelConsentDecision("opted_in", time.Now().UTC().Add(-time.Hour))
			grant.IfMatchToken = subscriber.Version
			_, err = channelConsentRepo(pool).SetChannelConsentWithAudit(ctx, tenantID, subscriber.ID, "email", grant, multiEmailAuditMeta(tenantID))
			if !errors.Is(err, ErrProtectedEmailSuppression) {
				t.Fatalf("grant error = %v, want protected suppression", err)
			}
			verify, err := db.WithTenant(ctx, pool, tenantID)
			if err != nil {
				t.Fatalf("verify tx: %v", err)
			}
			defer func() { _ = verify.Rollback(ctx) }()
			var holds, evidence, audits, outboxRows int
			var status string
			if err := verify.QueryRow(ctx, `SELECT count(*) FROM email_suppressions
 WHERE tenant_id=$1::uuid AND email=$2 AND reason=$3`, tenantID, subscriber.Email, reason).Scan(&holds); err != nil {
				t.Fatalf("read hold: %v", err)
			}
			if err := verify.QueryRow(ctx, `SELECT count(*) FROM consent_events
 WHERE tenant_id=$1::uuid AND subject_email=$2`, tenantID, subscriber.Email).Scan(&evidence); err != nil {
				t.Fatalf("read rolled-back evidence: %v", err)
			}
			if err := verify.QueryRow(ctx, `SELECT count(*) FROM audit_log
 WHERE tenant_id=$1::uuid AND resource_id=$2
   AND action='subscriber.channel_consent_updated'`, tenantID, subscriber.ID).Scan(&audits); err != nil {
				t.Fatalf("read rolled-back audit: %v", err)
			}
			if err := verify.QueryRow(ctx, `SELECT count(*) FROM outbox_events
 WHERE tenant_id=$1::uuid AND kind=$2 AND payload->>'subscriber_id'=$3`, tenantID, OutboxKindListmonkSync, subscriber.ID).Scan(&outboxRows); err != nil {
				t.Fatalf("read rolled-back outbox: %v", err)
			}
			if err := verify.QueryRow(ctx, `SELECT status FROM subscribers
 WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, subscriber.ID).Scan(&status); err != nil {
				t.Fatalf("read subscriber: %v", err)
			}
			if holds != 1 || evidence != 0 || audits != 0 || outboxRows != 0 || status == StatusEnabled {
				t.Fatalf("protected hold escaped atomicity holds=%d evidence=%d audits=%d outbox=%d status=%q",
					holds, evidence, audits, outboxRows, status)
			}
		})
	}
}

func TestEmailChannelConsentConcurrentExactRevisionAllowsOneDecision(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41220"
	subscriber := seedChannelConsentSubscriber(t, pool, tenantID)
	repo := channelConsentRepo(pool)
	inputs := []UpdateChannelConsentInput{
		channelConsentDecision("opted_in", time.Now().UTC().Add(-2*time.Hour)),
		channelConsentDecision("opted_out", time.Now().UTC().Add(-time.Hour)),
	}
	for index := range inputs {
		inputs[index].IfMatchToken = subscriber.Version
	}
	start := make(chan struct{})
	errs := make([]error, len(inputs))
	var wg sync.WaitGroup
	for index := range inputs {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			<-start
			_, errs[index] = repo.SetChannelConsentWithAudit(ctx, tenantID, subscriber.ID, "email", inputs[index], multiEmailAuditMeta(tenantID))
		}(index)
	}
	close(start)
	wg.Wait()
	succeeded, stale := 0, 0
	for _, err := range errs {
		switch {
		case err == nil:
			succeeded++
		case errors.Is(err, ErrPreconditionFailed):
			stale++
		default:
			t.Fatalf("unexpected racing result: %v", err)
		}
	}
	if succeeded != 1 || stale != 1 {
		t.Fatalf("racing results success=%d stale=%d errors=%v", succeeded, stale, errs)
	}
}

func TestEmailChannelConsentSinkFailureRollsBackEverything(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41230"
	subscriber := seedChannelConsentSubscriber(t, pool, tenantID)
	repo := &Repo{
		Pool: pool, Webhooks: noOpChannelConsentWebhook{},
		EngineSyncOutbox: subscriberOutboxTestAdapter{err: errors.New("injected outbox failure")},
	}
	grant := channelConsentDecision("opted_in", time.Now().UTC().Add(-time.Hour))
	grant.IfMatchToken = subscriber.Version
	if _, err := repo.SetChannelConsentWithAudit(ctx, tenantID, subscriber.ID, "email", grant, multiEmailAuditMeta(tenantID)); err == nil {
		t.Fatal("expected injected sink failure")
	}
	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("verify tx: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var events, proofs, channels, audits int
	var status, addressStatus string
	var vector bool
	if err := verify.QueryRow(ctx, `SELECT status, consent_email_marketing_at IS NOT NULL
 FROM subscribers WHERE tenant_id=$1::uuid AND id=$2::uuid`, tenantID, subscriber.ID).Scan(&status, &vector); err != nil {
		t.Fatalf("read subscriber: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT consent_status FROM subscriber_emails
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid AND lower(email::text)=lower($3)`, tenantID, subscriber.ID, subscriber.Email).Scan(&addressStatus); err != nil {
		t.Fatalf("read address: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM consent_events
 WHERE tenant_id=$1::uuid AND subject_email=$2`, tenantID, subscriber.Email).Scan(&events); err != nil {
		t.Fatalf("read events: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM consent_records
 WHERE tenant_id=$1::uuid AND email=$2`, tenantID, subscriber.Email).Scan(&proofs); err != nil {
		t.Fatalf("read proofs: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM subscriber_channel_consents
 WHERE tenant_id=$1::uuid AND subscriber_id=$2::uuid`, tenantID, subscriber.ID).Scan(&channels); err != nil {
		t.Fatalf("read channels: %v", err)
	}
	if err := verify.QueryRow(ctx, `SELECT count(*) FROM audit_log
 WHERE tenant_id=$1::uuid AND resource_id=$2
   AND action='subscriber.channel_consent_updated'`, tenantID, subscriber.ID).Scan(&audits); err != nil {
		t.Fatalf("read audits: %v", err)
	}
	if status == StatusEnabled || vector || addressStatus == "subscribed" || events != 0 || proofs != 0 || channels != 0 || audits != 0 {
		t.Fatalf("partial state escaped rollback status=%q vector=%v address=%q events=%d proofs=%d channels=%d audits=%d",
			status, vector, addressStatus, events, proofs, channels, audits)
	}
}

func TestEmailChannelConsentWebhookFailureRollsBackEvidenceAndProjection(t *testing.T) {
	pool := newPrimaryEmailTestPool(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const tenantID = "00000000-0000-4000-8000-0099a2c41231"
	subscriber := seedChannelConsentSubscriber(t, pool, tenantID)
	repo := &Repo{
		Pool:             pool,
		Webhooks:         failingAddressConsentWebhook{err: errors.New("injected webhook failure")},
		EngineSyncOutbox: subscriberOutboxTestAdapter{repo: &outbox.Repo{Pool: pool}},
	}
	grant := channelConsentDecision("opted_in", time.Now().UTC().Add(-time.Hour))
	grant.IfMatchToken = subscriber.Version
	if _, err := repo.SetChannelConsentWithAudit(ctx, tenantID, subscriber.ID, "email", grant, multiEmailAuditMeta(tenantID)); err == nil {
		t.Fatal("expected injected webhook failure")
	}
	verify, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("verify tx: %v", err)
	}
	defer func() { _ = verify.Rollback(ctx) }()
	var committedRows int
	if err := verify.QueryRow(ctx, `
SELECT
    (SELECT count(*) FROM consent_events
      WHERE tenant_id=$1::uuid AND subject_email=$2) +
    (SELECT count(*) FROM consent_records
      WHERE tenant_id=$1::uuid AND email=$2) +
    (SELECT count(*) FROM subscriber_channel_consents
      WHERE tenant_id=$1::uuid AND subscriber_id=$3::uuid) +
    (SELECT count(*) FROM audit_log
      WHERE tenant_id=$1::uuid AND resource_id=$3::text
        AND action='subscriber.channel_consent_updated') +
    (SELECT count(*) FROM outbox_events
      WHERE tenant_id=$1::uuid AND kind=$4
        AND payload->>'subscriber_id'=$3::text)`, tenantID, subscriber.Email,
		subscriber.ID, OutboxKindListmonkSync).Scan(&committedRows); err != nil {
		t.Fatalf("read rolled-back rows: %v", err)
	}
	var status, addressStatus string
	var vector bool
	if err := verify.QueryRow(ctx, `
SELECT subscriber.status,
       subscriber.consent_email_marketing_at IS NOT NULL,
       address.consent_status
  FROM subscribers AS subscriber
  JOIN subscriber_emails AS address
    ON address.tenant_id=subscriber.tenant_id
   AND address.subscriber_id=subscriber.id
   AND lower(address.email::text)=lower(subscriber.email::text)
 WHERE subscriber.tenant_id=$1::uuid AND subscriber.id=$2::uuid`,
		tenantID, subscriber.ID).Scan(&status, &vector, &addressStatus); err != nil {
		t.Fatalf("read rolled-back projection: %v", err)
	}
	if committedRows != 0 || status == StatusEnabled || vector || addressStatus == "subscribed" {
		t.Fatalf("webhook failure escaped rollback rows=%d status=%q vector=%v address=%q",
			committedRows, status, vector, addressStatus)
	}
}
