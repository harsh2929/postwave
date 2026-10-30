// SPDX-License-Identifier: AGPL-3.0-only

package listmonk_events

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/engagementclassification"
)

type countingEngagementClassifier struct {
	delegate TransactionalEngagementClassifier
	calls    int
	err      error
}

func (classifier *countingEngagementClassifier) RecordProviderEvent(
	ctx context.Context,
	tx pgx.Tx,
	tenantID string,
	input engagementclassification.ProviderEventInput,
) error {
	classifier.calls++
	if classifier.err != nil {
		return classifier.err
	}
	return classifier.delegate.RecordProviderEvent(ctx, tx, tenantID, input)
}

func engagementClassificationDBPools(
	t *testing.T,
	ctx context.Context,
) (*pgxpool.Pool, *db.Pool) {
	t.Helper()
	adminURL := strings.TrimSpace(os.Getenv("POSTWAVE_ENGAGEMENT_CLASSIFIER_TEST_DATABASE_URL"))
	appURL := strings.TrimSpace(os.Getenv("POSTWAVE_ENGAGEMENT_CLASSIFIER_APP_TEST_DATABASE_URL"))
	if adminURL == "" || appURL == "" {
		t.Skip("POSTWAVE_ENGAGEMENT_CLASSIFIER_TEST_DATABASE_URL and POSTWAVE_ENGAGEMENT_CLASSIFIER_APP_TEST_DATABASE_URL are required for Listmonk F01 proof")
	}
	admin, err := pgxpool.New(ctx, adminURL)
	if err != nil {
		t.Fatalf("connect Listmonk F01 admin database: %v", err)
	}
	t.Cleanup(admin.Close)
	app, err := db.New(ctx, appURL)
	if err != nil {
		t.Fatalf("connect Listmonk F01 application database: %v", err)
	}
	t.Cleanup(app.Close)
	var user string
	var bypass bool
	if err := app.QueryRow(ctx, `
SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname=current_user`).Scan(
		&user, &bypass,
	); err != nil {
		t.Fatal(err)
	}
	if user != "postwave_app" || bypass {
		t.Skipf("application URL must use non-bypass postwave_app; got user=%q bypassrls=%v", user, bypass)
	}
	var ready bool
	if err := admin.QueryRow(ctx, `
SELECT to_regclass('public.subscriber_event_observations') IS NOT NULL
   AND to_regclass('public.event_classifications') IS NOT NULL
   AND to_regclass('public.engagement_machine_registry_entries') IS NOT NULL`).Scan(&ready); err != nil {
		t.Fatal(err)
	}
	if !ready {
		t.Fatal("configured database is missing migration 1934")
	}
	return admin, app
}

func TestListmonkF01AtomicIngestReplayRollbackAndPrivacy_DB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	admin, app := engagementClassificationDBPools(t, ctx)
	tenantID := uuid.NewString()
	campaignID := uuid.NewString()
	email := "f01-listmonk-" + uuid.NewString() + "@example.test"
	if _, err := admin.Exec(ctx, `
INSERT INTO tenants (id, name, slug, tier)
VALUES ($1::uuid, 'Listmonk F01 integration', 'lm-f01-' || left($1::text, 12), 'studio')`,
		tenantID); err != nil {
		t.Fatalf("seed Listmonk F01 tenant: %v", err)
	}
	if _, err := admin.Exec(ctx, `
INSERT INTO subscribers (
    tenant_id, email, primary_email, status, mailchimp_status,
    consent_source, custom_fields, tags, merge_fields, groups, gdpr_permissions
) VALUES (
    $1::uuid, $2, $2, 'enabled', 'subscribed', 'import', '{}'::jsonb,
    ARRAY[]::text[], '{}'::jsonb, '[]'::jsonb, '[]'::jsonb
)`, tenantID, email); err != nil {
		t.Fatalf("seed Listmonk F01 subscriber: %v", err)
	}
	if _, err := admin.Exec(ctx, `
INSERT INTO campaigns (id, tenant_id, name, subject, body_html, status)
VALUES ($2::uuid, $1::uuid, 'Listmonk F01 campaign', 'F01', '<p>F01</p>', 'draft')`,
		tenantID, campaignID); err != nil {
		t.Fatalf("seed Listmonk F01 fixture: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = admin.Exec(cleanupCtx, `DELETE FROM tenants WHERE id=$1::uuid`, tenantID)
	})

	runtime, err := engagementclassification.BuildRuntime(
		ctx,
		engagementclassification.RuntimeConfiguration{
			Enabled:                  true,
			IdentityHMACKey:          []byte(strings.Repeat("f01-runtime-key-", 3)),
			IdentityKeyID:            "f01-listmonk-key-2026-08",
			ObservationRetention:     365 * 24 * time.Hour,
			ReclassificationLeaseTTL: 2 * time.Minute,
			ReclassificationWorkerID: "f01-listmonk-db-test",
		},
		app,
	)
	if err != nil {
		t.Fatalf("build restricted-role F01 runtime: %v", err)
	}
	counting := &countingEngagementClassifier{delegate: runtime}
	ingestedAt := time.Now().UTC().Truncate(time.Microsecond)
	providerID := "listmonk-f01-" + uuid.NewString()
	event := CanonicalEvent{
		TenantID: tenantID, SubscriberEmail: email, EventType: EventOpened,
		CampaignID: campaignID, Source: "listmonk", ProviderEventID: providerID,
		MessageID: "<f01-" + uuid.NewString() + "@example.test>",
		LinkURL:   "https://example.test/f01", UserAgent: "GoogleImageProxy/1.0",
		IP: "203.0.113.42", At: ingestedAt.Add(-time.Second),
		Metadata: map[string]any{
			"wire_type": "subscriber.opened", "sg_machine_open": true,
			"untrusted_recipient_copy": email,
		},
	}
	deps := &Deps{Pool: app, EngagementClassifier: counting, Now: func() time.Time { return ingestedAt }}
	inserted, err := deps.persist(ctx, event)
	if err != nil || !inserted {
		t.Fatalf("persist classified provider event=(%v,%v)", inserted, err)
	}
	inserted, err = deps.persist(ctx, event)
	if err != nil || inserted {
		t.Fatalf("replay classified provider event=(%v,%v)", inserted, err)
	}
	if counting.calls != 1 {
		t.Fatalf("classifier calls=%d, want one across provider replay", counting.calls)
	}

	var (
		eventCount, observationCount, classificationCount int
		recipientHMAC, keyID, source, sourceEventID       string
		providerMessageID, providerRequestID              string
		messageHash, linkHash, headersJSON, signalsJSON   string
		headersComplete                                   bool
		storedIngestedAt, privacyExpiryAt                 time.Time
		classification, subtype                           string
	)
	if err := admin.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM subscriber_events
    WHERE tenant_id=$1::uuid AND source='listmonk' AND provider_event_id=$2),
  (SELECT count(*) FROM subscriber_event_observations
    WHERE tenant_id=$1::uuid AND source='listmonk' AND source_event_id=$2),
  (SELECT count(*) FROM event_classifications classification_row
     JOIN subscriber_event_observations observation
       ON observation.tenant_id=classification_row.tenant_id
      AND observation.subscriber_event_id=classification_row.subscriber_event_id
      AND observation.subscriber_event_at=classification_row.subscriber_event_at
    WHERE classification_row.tenant_id=$1::uuid AND observation.source_event_id=$2),
  observation.recipient_identity_hmac, observation.recipient_key_id,
  observation.source, observation.source_event_id,
  COALESCE(observation.provider_message_id, ''),
  COALESCE(observation.provider_request_id, ''),
  COALESCE(observation.message_identity_hash, ''),
  COALESCE(observation.link_identity_hash, ''),
  observation.ordered_headers::text, observation.ordered_headers_complete,
  observation.provider_signals::text, observation.ingested_at,
  observation.privacy_expiry_at,
  classification_row.classification,
  COALESCE(classification_row.machine_subtype, '')
FROM subscriber_event_observations observation
JOIN event_classifications classification_row
  ON classification_row.tenant_id=observation.tenant_id
 AND classification_row.subscriber_event_id=observation.subscriber_event_id
 AND classification_row.subscriber_event_at=observation.subscriber_event_at
WHERE observation.tenant_id=$1::uuid AND observation.source_event_id=$2`,
		tenantID, providerID).Scan(
		&eventCount, &observationCount, &classificationCount,
		&recipientHMAC, &keyID, &source, &sourceEventID,
		&providerMessageID, &providerRequestID, &messageHash, &linkHash,
		&headersJSON, &headersComplete, &signalsJSON, &storedIngestedAt,
		&privacyExpiryAt, &classification, &subtype,
	); err != nil {
		t.Fatalf("read atomic F01 evidence: %v", err)
	}
	if eventCount != 1 || observationCount != 1 || classificationCount != 1 {
		t.Fatalf("atomic counts event/observation/classification=%d/%d/%d",
			eventCount, observationCount, classificationCount)
	}
	if len(recipientHMAC) != 64 || recipientHMAC == strings.ToLower(email) ||
		keyID != "f01-listmonk-key-2026-08" || source != "listmonk" ||
		sourceEventID != providerID || providerMessageID != event.MessageID ||
		providerRequestID != "" || len(messageHash) != 64 || len(linkHash) != 64 {
		t.Fatalf("invalid observation identity hmac=%q key=%q source=%q/%q message=%q request=%q hashes=%d/%d",
			recipientHMAC, keyID, source, sourceEventID, providerMessageID,
			providerRequestID, len(messageHash), len(linkHash))
	}
	if headersJSON != "[]" || headersComplete {
		t.Fatalf("unsupported ordered headers json=%q complete=%v", headersJSON, headersComplete)
	}
	if strings.Contains(strings.ToLower(signalsJSON), strings.ToLower(email)) ||
		strings.Contains(signalsJSON, "untrusted_recipient_copy") ||
		!strings.Contains(signalsJSON, "sg_machine_open") {
		t.Fatalf("unsafe or incomplete provider signals=%s", signalsJSON)
	}
	if !storedIngestedAt.Equal(ingestedAt) ||
		!privacyExpiryAt.Equal(ingestedAt.Add(365*24*time.Hour)) {
		t.Fatalf("retention ingested=%v expiry=%v", storedIngestedAt, privacyExpiryAt)
	}
	if classification != "machine" || subtype != "gmail_proxy" {
		t.Fatalf("classification=%q subtype=%q, want machine/gmail_proxy", classification, subtype)
	}

	rollbackProviderID := "listmonk-f01-rollback-" + uuid.NewString()
	sentinel := errors.New("injected F01 classifier failure")
	failing := &Deps{
		Pool:                 app,
		EngagementClassifier: &countingEngagementClassifier{err: sentinel},
		Now:                  func() time.Time { return ingestedAt.Add(time.Minute) },
	}
	rollbackEvent := event
	rollbackEvent.ProviderEventID = rollbackProviderID
	rollbackEvent.MessageID = "<rollback-" + uuid.NewString() + "@example.test>"
	rollbackEvent.At = ingestedAt.Add(time.Minute)
	if inserted, err := failing.persist(ctx, rollbackEvent); inserted || !errors.Is(err, sentinel) {
		t.Fatalf("classifier failure persist=(%v,%v), want rollback", inserted, err)
	}
	var rolledBack int
	if err := admin.QueryRow(ctx, `
SELECT
  (SELECT count(*) FROM subscriber_events WHERE tenant_id=$1::uuid AND provider_event_id=$2)
 + (SELECT count(*) FROM subscriber_event_dedup_keys WHERE tenant_id=$1::uuid AND source_event_id=$2)
 + (SELECT count(*) FROM campaign_report_events WHERE tenant_id=$1::uuid AND provider_event_id=$2)
 + (SELECT count(*) FROM subscriber_event_observations WHERE tenant_id=$1::uuid AND source_event_id=$2)`,
		tenantID, rollbackProviderID).Scan(&rolledBack); err != nil {
		t.Fatal(err)
	}
	if rolledBack != 0 {
		t.Fatalf("classifier failure committed %d canonical/projection/evidence rows", rolledBack)
	}

	// The same provider identity succeeds after the classifier recovers; the
	// rolled-back dedupe claim cannot poison the retry.
	if inserted, err := deps.persist(ctx, rollbackEvent); err != nil || !inserted {
		t.Fatalf("classifier recovery retry=(%v,%v)", inserted, err)
	}
	var recovered int
	if err := admin.QueryRow(ctx, `
SELECT count(*)
  FROM subscriber_event_observations
 WHERE tenant_id=$1::uuid AND source_event_id=$2`, tenantID, rollbackProviderID).Scan(&recovered); err != nil {
		t.Fatal(err)
	}
	if recovered != 1 {
		t.Fatalf("classifier recovery observations=%d, want 1", recovered)
	}

}
