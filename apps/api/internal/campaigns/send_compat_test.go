package campaigns

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sort"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/dispatchcontrol"
	"github.com/postwave/postwave/apps/api/internal/frequency"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/suppressions"
)

// forbiddenLegacyCampaignSender makes a regression to direct Listmonk fan-out
// observable. The compatibility route receives this collaborator for API
// construction compatibility, but must never invoke either method.
type forbiddenLegacyCampaignSender struct {
	createCalls int
	statusCalls int
}

func (s *forbiddenLegacyCampaignSender) CreateCampaign(
	context.Context,
	listmonk.CreateCampaignReq,
) (*listmonk.CreateCampaignResponse, error) {
	s.createCalls++
	return nil, errors.New("legacy Listmonk campaign creation must not be called")
}

func (s *forbiddenLegacyCampaignSender) UpdateCampaignStatus(
	context.Context,
	int64,
	string,
) error {
	s.statusCalls++
	return errors.New("legacy Listmonk campaign status must not be called")
}

func TestLegacySendRouteFailsClosedWithoutTenantAndNeverCallsListmonk(t *testing.T) {
	sender := &forbiddenLegacyCampaignSender{}
	router := chi.NewRouter()
	MountSend(router, &Deps{}, &SendDeps{Sender: sender})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost,
		"/api/v1/campaigns/00000000-0000-0000-0000-000000000001/send", nil)
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusUnauthorized, rec.Body.String())
	}
	assertLegacySenderUnused(t, sender)
}

func TestLegacySendRouteQueuesOnlyExactConsentedUnsuppressedRecipients(t *testing.T) {
	pool := dbForIntegration(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	tenantID := setupTenantQ(t, pool, ctx, "send-compat-guarded-queue")
	insertSubscribersQ(t, pool, ctx, tenantID, []subQ{
		{email: "allowed@example.test", status: "enabled"},
		// The profile-level legacy projection remains granted, but this exact
		// delivery address is revoked and must not enter the queue.
		{email: "address-revoked@example.test", status: "enabled", addressConsentStatus: "unsubscribed"},
		// The exact address is subscribed, but the unified suppression ledger
		// must remove it before campaign_recipients are materialized.
		{email: "suppressed@example.test", status: "enabled"},
		// No profile-level email-marketing grant: also ineligible.
		{email: "never-consented@example.test", status: "enabled", noEmailConsent: true},
	})

	campaignID := insertQueueableCampaignQ(t, pool, ctx, tenantID, "legacy send guarded queue")
	enableEmailComplianceQ(t, pool, ctx, tenantID, campaignID, "sender@example.test")

	suppressionStore := &suppressions.Store{Pool: pool}
	insertUnifiedSuppressionQ(t, pool, ctx, tenantID, "suppressed@example.test")

	sender := &forbiddenLegacyCampaignSender{}
	router := chi.NewRouter()
	base := &Deps{
		Repo:         &Repo{Pool: pool},
		Suppressions: suppressionStore,
		LiveDispatch: dispatchcontrol.StaticGate{Enabled: true},
		Frequency: func(ctx context.Context, tenantID, channel string, candidates []string) ([]string, int, []FrequencySkipBreakdown, error) {
			result, err := frequency.FilterAudienceForChannel(ctx, pool, tenantID, channel, candidates)
			return result.Kept, result.Skipped, nil, err
		},
		SubscriberPreference: func(ctx context.Context, tenantID string, candidates []string) ([]string, int, error) {
			result, err := frequency.FilterBySubscriberPreference(ctx, pool, tenantID, candidates)
			return result.Kept, result.Skipped, err
		},
	}
	MountSend(router, base, &SendDeps{Sender: sender})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost,
		"/api/v1/campaigns/"+campaignID+"/send", nil)
	req = req.WithContext(middleware.WithTenant(req.Context(), &middleware.Tenant{ID: tenantID}))
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusAccepted, rec.Body.String())
	}
	var response queueResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, rec.Body.String())
	}
	if response.CampaignID != campaignID || response.Status != StatusSending || response.RecipientsQueued != 1 {
		t.Fatalf("response = %+v, want campaign=%s status=%s recipients=1",
			response, campaignID, StatusSending)
	}
	assertLegacySenderUnused(t, sender)

	recipients, status := queuedRecipientsAndCampaignStatusQ(t, pool, ctx, tenantID, campaignID)
	if len(recipients) != 1 || recipients[0] != "allowed@example.test" {
		t.Fatalf("queued recipients = %v, want only exact-consented unsuppressed address", recipients)
	}
	if status != StatusSending {
		t.Fatalf("campaign status = %q, want %q", status, StatusSending)
	}
}

func assertLegacySenderUnused(t *testing.T, sender *forbiddenLegacyCampaignSender) {
	t.Helper()
	if sender.createCalls != 0 || sender.statusCalls != 0 {
		t.Fatalf("legacy Listmonk sender used: CreateCampaign=%d UpdateCampaignStatus=%d",
			sender.createCalls, sender.statusCalls)
	}
}

// insertUnifiedSuppressionQ writes only the canonical suppression ledger. It
// deliberately leaves subscribers.status enabled and the per-address
// subscriber_emails projection unsuppressed, so the test can prove the queue's
// SuppressionLookup removed the address rather than an earlier audience gate.
func insertUnifiedSuppressionQ(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID, email string,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin unified suppression fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO subscriber_suppressions
       (tenant_id, email, reason, source, metadata)
VALUES ($1::uuid, $2, 'manual_unsubscribe', 'manual',
        '{"test":"legacy_send_queue_guard"}'::jsonb)`, tenantID, email); err != nil {
		t.Fatalf("insert unified suppression: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit unified suppression fixture: %v", err)
	}
}

func enableEmailComplianceQ(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID, campaignID, fromEmail string,
) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin compliance fixture: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
INSERT INTO email_compliance_profiles
       (tenant_id, legal_sender_name, physical_address_line1,
        physical_address_city, physical_address_country,
        compliance_contact_email, list_unsubscribe_enabled,
        one_click_unsubscribe_enabled, verified_sender_domain)
VALUES ($1::uuid, 'Moosewave Test Sender', '1 Test Street',
        'Test City', 'US', 'compliance@example.test', TRUE, TRUE, TRUE)
ON CONFLICT (tenant_id) DO UPDATE SET
    legal_sender_name = EXCLUDED.legal_sender_name,
    physical_address_line1 = EXCLUDED.physical_address_line1,
    physical_address_city = EXCLUDED.physical_address_city,
    physical_address_country = EXCLUDED.physical_address_country,
    compliance_contact_email = EXCLUDED.compliance_contact_email,
    list_unsubscribe_enabled = TRUE,
    one_click_unsubscribe_enabled = TRUE,
    verified_sender_domain = TRUE`, tenantID); err != nil {
		t.Fatalf("insert compliance profile: %v", err)
	}
	// A verified identity can only be reached through the wizard, so the
	// fixture reproduces exactly what it writes: the pinned DNS instruction
	// values enforced by sending_identities_dns_instruction_safety_check
	// (migration 1854) plus a green timestamp on each of the three legs,
	// which is the only way sending_identity.Verify reaches
	// verify_state='verified'. Inserting NULL instruction values would
	// fabricate a row production code cannot produce.
	if _, err := tx.Exec(ctx, `
INSERT INTO sending_identities
       (tenant_id, domain, dkim_public_key_b64,
        spf_record_value, dmarc_record_value,
        spf_verified_at, dkim_verified_at, dmarc_verified_at,
        verify_state, verified_at)
VALUES ($1::uuid, 'example.test', 'integration-test-public-key',
        'v=spf1 include:_spf.postwave.io -all',
        'v=DMARC1; p=none; aspf=r; adkim=r',
        now(), now(), now(),
        'verified', now())
ON CONFLICT (tenant_id, domain) DO UPDATE SET
    spf_record_value = EXCLUDED.spf_record_value,
    dmarc_record_value = EXCLUDED.dmarc_record_value,
    spf_verified_at = EXCLUDED.spf_verified_at,
    dkim_verified_at = EXCLUDED.dkim_verified_at,
    dmarc_verified_at = EXCLUDED.dmarc_verified_at,
    verify_state = 'verified', verified_at = now()`, tenantID); err != nil {
		t.Fatalf("insert verified sending identity: %v", err)
	}
	if _, err := tx.Exec(ctx, `
UPDATE campaigns
   SET delivery_settings = jsonb_build_object('from_email', $3::text)
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, campaignID, fromEmail); err != nil {
		t.Fatalf("set campaign from address: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit compliance fixture: %v", err)
	}
}

func queuedRecipientsAndCampaignStatusQ(
	t *testing.T,
	pool *db.Pool,
	ctx context.Context,
	tenantID, campaignID string,
) ([]string, string) {
	t.Helper()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("begin queue assertion: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
SELECT subscriber_email::text
  FROM campaign_recipients
 WHERE tenant_id = $1::uuid AND campaign_id = $2::uuid`, tenantID, campaignID)
	if err != nil {
		t.Fatalf("read queued recipients: %v", err)
	}
	var recipients []string
	for rows.Next() {
		var email string
		if err := rows.Scan(&email); err != nil {
			rows.Close()
			t.Fatalf("scan queued recipient: %v", err)
		}
		recipients = append(recipients, email)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatalf("iterate queued recipients: %v", err)
	}
	rows.Close()
	sort.Strings(recipients)
	var status string
	if err := tx.QueryRow(ctx, `
SELECT status FROM campaigns
 WHERE tenant_id = $1::uuid AND id = $2::uuid`, tenantID, campaignID).Scan(&status); err != nil {
		t.Fatalf("read campaign status: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit queue assertion: %v", err)
	}
	return recipients, status
}
