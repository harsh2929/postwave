// SPDX-License-Identifier: AGPL-3.0-only
//
// Repository-level tests against a real Postgres. Skipped when DATABASE_URL is
// unset so the package stays hermetic by default.
package crm_integrations

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

func newCRMRepoTestPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping pg-backed CRM repo tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatalf("pgxpool.New: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

func seedCRMRepoTenant(t *testing.T, pool *pgxpool.Pool, slug string) string {
	t.Helper()
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	var tenantID string
	if err := conn.QueryRow(ctx, `SELECT gen_random_uuid()::text`).Scan(&tenantID); err != nil {
		t.Fatalf("uuid: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	if _, err := conn.Exec(ctx, `
INSERT INTO tenants (id, slug, name, tier)
VALUES ($1::uuid, $2, $3, 'pro')`,
		tenantID, slug, "CRM Repo "+slug); err != nil {
		t.Fatalf("seed tenant: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		conn, err := pool.Acquire(ctx)
		if err != nil {
			return
		}
		defer conn.Release()
		_, _ = conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID)
		_, _ = conn.Exec(ctx, `DELETE FROM crm_sync_runs WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = conn.Exec(ctx, `DELETE FROM crm_webhook_events WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = conn.Exec(ctx, `DELETE FROM crm_integrations WHERE tenant_id = $1::uuid`, tenantID)
		_, _ = conn.Exec(ctx, `DELETE FROM tenants WHERE id = $1::uuid`, tenantID)
	})
	return tenantID
}

func TestRepoUpsertIntegrationReconnectClearsDisconnectedPipedriveState(t *testing.T) {
	pool := newCRMRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedCRMRepoTenant(t, pool, "crm-pipedrive-reconnect-"+suffix)
	name := "Pipedrive Reconnect " + suffix
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		conn.Release()
		t.Fatalf("set tenant: %v", err)
	}
	if _, err := conn.Exec(ctx, `
INSERT INTO crm_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings,
    sync_cursor, last_sync_at, error_message
) VALUES (
    $1::uuid, 'pipedrive', $2, 'disconnected', ARRAY[]::text[], 'cred_old',
    $3::jsonb, 'pipedrive_retry:stale', now() - interval '1 day', 'old failure'
)`, tenantID, name, `{
		"company_domain":"old",
		"pipedrive_webhook_ids":["old-hook"],
		"pipedrive_oauth_client_id":"old-client",
		"provider_cleanup":{"status":"operator_action_required"}
	}`); err != nil {
		conn.Release()
		t.Fatalf("seed disconnected integration: %v", err)
	}
	conn.Release()

	out, err := repo.UpsertIntegration(ctx, tenantID, IntegrationInput{
		Provider:       ProviderPipedrive,
		Name:           name,
		CredentialsRef: "cred_new",
		Settings: map[string]any{
			"company_domain": "new",
		},
	})
	if err != nil {
		t.Fatalf("upsert reconnect: %v", err)
	}
	if out.Status != "connected" || out.CredentialsRef != "cred_new" || out.SyncCursor != "" || out.LastSyncAt != nil || out.ErrorMessage != "" {
		t.Fatalf("reconnected integration=%+v", out)
	}
	if settingString(out.Settings, "company_domain") != "new" ||
		out.Settings["pipedrive_webhook_ids"] != nil ||
		out.Settings["pipedrive_oauth_client_id"] != nil ||
		out.Settings["provider_cleanup"] != nil {
		t.Fatalf("stale settings survived reconnect: %+v", out.Settings)
	}
}

func TestRepoPauseIntegrationDoesNotResurrectDisconnectedPipedriveRow(t *testing.T) {
	pool := newCRMRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedCRMRepoTenant(t, pool, "crm-pipedrive-pause-"+suffix)
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		conn.Release()
		t.Fatalf("set tenant: %v", err)
	}
	var id string
	if err := conn.QueryRow(ctx, `
INSERT INTO crm_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
) VALUES (
    $1::uuid, 'pipedrive', $2, 'disconnected', ARRAY[]::text[], 'cred_pipedrive',
    '{"company_domain":"pause","provider_cleanup":{"status":"operator_action_required"}}'::jsonb
)
RETURNING id::text`, tenantID, "Pipedrive Pause "+suffix).Scan(&id); err != nil {
		conn.Release()
		t.Fatalf("seed disconnected integration: %v", err)
	}
	conn.Release()

	if _, err := repo.PauseIntegration(ctx, tenantID, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("pause err=%v, want ErrNotFound", err)
	}
	out, err := repo.GetIntegration(ctx, tenantID, id)
	if err != nil {
		t.Fatalf("get integration: %v", err)
	}
	if out.Status != "disconnected" || out.Settings["provider_cleanup"] == nil {
		t.Fatalf("disconnected row changed: %+v", out)
	}
}

func TestRepoCRMWebhookClaimsAreIntegrationScopedAndBodyChecked(t *testing.T) {
	pool := newCRMRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedCRMRepoTenant(t, pool, "crm-webhook-claim-"+suffix)
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		conn.Release()
		t.Fatalf("set tenant: %v", err)
	}
	var firstID, secondID string
	if err := conn.QueryRow(ctx, `
INSERT INTO crm_integrations (tenant_id, provider, name, status, scopes, credentials_ref, settings)
VALUES ($1::uuid, 'pipedrive', $2, 'connected', ARRAY[]::text[], 'cred_pipedrive_1', '{"company_domain":"claim-a"}'::jsonb)
RETURNING id::text`, tenantID, "Pipedrive Claim A "+suffix).Scan(&firstID); err != nil {
		conn.Release()
		t.Fatalf("seed first CRM integration: %v", err)
	}
	if err := conn.QueryRow(ctx, `
INSERT INTO crm_integrations (tenant_id, provider, name, status, scopes, credentials_ref, settings)
VALUES ($1::uuid, 'pipedrive', $2, 'connected', ARRAY[]::text[], 'cred_pipedrive_2', '{"company_domain":"claim-b"}'::jsonb)
RETURNING id::text`, tenantID, "Pipedrive Claim B "+suffix).Scan(&secondID); err != nil {
		conn.Release()
		t.Fatalf("seed second CRM integration: %v", err)
	}
	conn.Release()

	body := []byte(`{"id":"event_1","email":"buyer@example.com"}`)
	claim, err := repo.ClaimWebhook(ctx, tenantID, firstID, ProviderPipedrive, "msg_1", "change.person", body)
	if err != nil || claim != WebhookClaimed {
		t.Fatalf("first claim=%q err=%v", claim, err)
	}
	if err := repo.MarkWebhookProcessed(ctx, tenantID, firstID, ProviderPipedrive, "msg_1"); err != nil {
		t.Fatalf("mark processed: %v", err)
	}
	claim, err = repo.ClaimWebhook(ctx, tenantID, firstID, ProviderPipedrive, "msg_1", "change.person", body)
	if err != nil || claim != WebhookProcessed {
		t.Fatalf("duplicate claim=%q err=%v", claim, err)
	}
	claim, err = repo.ClaimWebhook(ctx, tenantID, secondID, ProviderPipedrive, "msg_1", "change.person", body)
	if err != nil || claim != WebhookClaimed {
		t.Fatalf("second integration claim=%q err=%v", claim, err)
	}
	if _, err := repo.ClaimWebhook(ctx, tenantID, firstID, ProviderPipedrive, "msg_1", "change.person", []byte(`{"id":"event_1","email":"other@example.com"}`)); !errors.Is(err, ErrCRMWebhookBodyMismatch) {
		t.Fatalf("different body err=%v, want ErrCRMWebhookBodyMismatch", err)
	}

	repo.webhookClaimStaleAfter = 100 * time.Millisecond
	staleBody := []byte(`{"id":"event_stale","email":"stale@example.com"}`)
	claim, err = repo.ClaimWebhook(ctx, tenantID, firstID, ProviderPipedrive, "msg_stale", "change.person", staleBody)
	if err != nil || claim != WebhookClaimed {
		t.Fatalf("initial stale candidate claim=%q err=%v", claim, err)
	}
	time.Sleep(150 * time.Millisecond)
	claim, err = repo.ClaimWebhook(ctx, tenantID, firstID, ProviderPipedrive, "msg_stale", "change.person", staleBody)
	if err != nil || claim != WebhookClaimed {
		t.Fatalf("stale claim recovery=%q err=%v", claim, err)
	}
	claim, err = repo.ClaimWebhook(ctx, tenantID, firstID, ProviderPipedrive, "msg_stale", "change.person", staleBody)
	if err != nil || claim != WebhookInProgress {
		t.Fatalf("fresh in-progress claim=%q err=%v", claim, err)
	}
	conn, err = pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire claim evidence: %v", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		t.Fatalf("set claim evidence tenant: %v", err)
	}
	var attempts int
	if err := conn.QueryRow(ctx, `
SELECT attempts
  FROM crm_webhook_events
 WHERE tenant_id = $1::uuid
   AND integration_id = $2::uuid
   AND provider = $3
   AND webhook_id = 'msg_stale'`,
		tenantID, firstID, ProviderPipedrive).Scan(&attempts); err != nil {
		t.Fatalf("read stale claim attempts: %v", err)
	}
	if attempts != 2 {
		t.Fatalf("stale claim attempts=%d, want 2", attempts)
	}
}

func TestRepoPipedriveWebhookLookupFailsClosedOnAmbiguousRoute(t *testing.T) {
	pool := newCRMRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedCRMRepoTenant(t, pool, "crm-pipedrive-ambiguous-"+suffix)
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		conn.Release()
		t.Fatalf("set tenant: %v", err)
	}
	for _, name := range []string{"A", "B"} {
		if _, err := conn.Exec(ctx, `
INSERT INTO crm_integrations (tenant_id, provider, name, status, scopes, credentials_ref, settings)
VALUES ($1::uuid, 'pipedrive', $2, 'connected', ARRAY[]::text[], 'cred_pipedrive', '{"company_domain":"ambiguous","pipedrive_webhook_id":"wh-shared"}'::jsonb)`,
			tenantID, "Pipedrive Ambiguous "+name+" "+suffix); err != nil {
			conn.Release()
			t.Fatalf("seed ambiguous integration: %v", err)
		}
	}
	conn.Release()

	if _, err := repo.FindPipedriveIntegrationByWebhookID(ctx, "wh-shared"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("lookup err=%v, want ErrNotFound", err)
	}
}

func TestRepoHubSpotWebhookLookupBindsAppPortalAndFailsClosedOnAmbiguousRoute(t *testing.T) {
	pool := newCRMRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedCRMRepoTenant(t, pool, "crm-hubspot-ambiguous-"+suffix)
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		conn.Release()
		t.Fatalf("set tenant: %v", err)
	}
	for _, name := range []string{"A", "B"} {
		if _, err := conn.Exec(ctx, `
INSERT INTO crm_integrations (tenant_id, provider, name, status, scopes, credentials_ref, settings)
VALUES (
	$1::uuid, 'hubspot', $2, 'connected', ARRAY[]::text[], 'crm:hubspot:test',
	'{"portal_id":"12345678","hubspot_portal_id":"12345678","hubspot_app_id":"777","hubspot_auth_mode":"managed_oauth","hubspot_oauth_managed_by_postwave":true}'::jsonb
)`, tenantID, "HubSpot Ambiguous "+name+" "+suffix); err != nil {
			conn.Release()
			t.Fatalf("seed ambiguous integration: %v", err)
		}
	}
	conn.Release()

	if _, err := repo.FindHubSpotIntegrationByAppAndPortalID(ctx, "777", "12345678"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("ambiguous lookup err=%v, want ErrNotFound", err)
	}
	if _, err := repo.FindHubSpotIntegrationByAppAndPortalID(ctx, "other-app", "12345678"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong-app lookup err=%v, want ErrNotFound", err)
	}
}

func TestHubSpotContactBindingBootstrapsRawMigrationIdentityAndReconcilesLifecycle(t *testing.T) {
	pool := newCRMRepoTestPool(t)
	repo := &Repo{Pool: pool}
	subscriberRepo := &subscribers.Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedCRMRepoTenant(t, pool, "crm-hubspot-identity-"+suffix)
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	var integrationID, subscriberID, profileID string
	if err := conn.QueryRow(ctx, `
INSERT INTO crm_integrations (
    tenant_id, provider, name, status, scopes, credentials_ref, settings
)
VALUES (
    $1::uuid, 'hubspot', $2, 'connected', ARRAY[]::text[],
    'crm:hubspot:test', '{"portal_id":"12345678"}'::jsonb
)
RETURNING id::text`, tenantID, "HubSpot Identity "+suffix).Scan(&integrationID); err != nil {
		t.Fatalf("seed integration: %v", err)
	}
	if err := conn.QueryRow(ctx, `
INSERT INTO subscribers (
    tenant_id, email, status, consent_source, tags,
    source_platform, source_id, external_id
)
VALUES (
    $1::uuid, 'old@example.com', 'unconfirmed', 'unknown',
    ARRAY['migration-evidence']::text[], 'hubspot', '42', 'shopify-customer-7'
)
RETURNING id::text, profile_id::text`,
		tenantID).Scan(&subscriberID, &profileID); err != nil {
		t.Fatalf("seed migrated subscriber: %v", err)
	}

	sink := SubscriberProfileSink{Repo: subscriberRepo, Identities: repo}
	gotID, err := sink.UpsertCRMContact(ctx, tenantID, Integration{
		ID: integrationID, TenantID: tenantID, Provider: ProviderHubSpot,
	}, ContactInput{
		SourceID:  "hubspot://contact/42",
		Email:     "new@example.com",
		FirstName: "Ada",
	})
	if err != nil {
		t.Fatalf("native sync over migrated profile: %v", err)
	}
	if gotID != subscriberID {
		t.Fatalf("subscriber id=%q, want migrated %q", gotID, subscriberID)
	}
	var (
		email, status, consentSource, sourcePlatform, sourceID, externalID string
		tags                                                               []string
	)
	if err := conn.QueryRow(ctx, `
SELECT email::text, status, consent_source, COALESCE(source_platform, ''),
       COALESCE(source_id, ''), COALESCE(external_id, ''), tags
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
		tenantID, subscriberID).Scan(
		&email, &status, &consentSource, &sourcePlatform, &sourceID, &externalID, &tags,
	); err != nil {
		t.Fatalf("read reconciled subscriber: %v", err)
	}
	if email != "new@example.com" ||
		status != "unconfirmed" ||
		consentSource != "unknown" ||
		sourcePlatform != ProviderHubSpot ||
		sourceID != "42" ||
		externalID != "shopify-customer-7" ||
		len(tags) != 1 || tags[0] != "migration-evidence" {
		t.Fatalf(
			"subscriber email=%q status=%q consent=%q source=%q/%q external=%q tags=%v",
			email, status, consentSource, sourcePlatform, sourceID, externalID, tags,
		)
	}
	binding, err := repo.ResolveCRMContactProfileBinding(
		ctx, tenantID, integrationID, ProviderHubSpot, "hubspot://contact/42",
	)
	if err != nil {
		t.Fatalf("resolve binding: %v", err)
	}
	if binding == nil ||
		binding.SubscriberID != subscriberID ||
		binding.SubscriberProfileID != profileID ||
		binding.ProviderContactID != "hubspot://contact/42" ||
		binding.BindingOrigin != "migration_source" ||
		binding.State != "active" ||
		binding.SourceRevisionAt == nil {
		t.Fatalf("binding=%+v", binding)
	}

	deletionOccurredAt := binding.SourceRevisionAt.Add(time.Second)
	for i := 0; i < 2; i++ {
		binding, err = repo.TransitionCRMContactProfileBinding(
			ctx,
			tenantID,
			integrationID,
			ProviderHubSpot,
			"hubspot://contact/42",
			"deleted",
			map[string]any{
				"attempt":             i + 1,
				"hubspot_occurred_at": deletionOccurredAt.UnixMilli(),
			},
		)
		if err != nil {
			t.Fatalf("delete transition %d: %v", i+1, err)
		}
	}
	if binding == nil || binding.State != "deleted" {
		t.Fatalf("deleted binding=%+v", binding)
	}

	reactivationRevision := deletionOccurredAt.Add(time.Second)
	gotID, err = sink.UpsertCRMContact(ctx, tenantID, Integration{
		ID: integrationID, TenantID: tenantID, Provider: ProviderHubSpot,
	}, ContactInput{
		SourceID:  "42",
		Email:     "new@example.com",
		UpdatedAt: &reactivationRevision,
	})
	if err != nil {
		t.Fatalf("recreate ordinarily deleted contact: %v", err)
	}
	if gotID != subscriberID {
		t.Fatalf("recreated subscriber id=%q, want %q", gotID, subscriberID)
	}
	binding, err = repo.ResolveCRMContactProfileBinding(
		ctx, tenantID, integrationID, ProviderHubSpot, "hubspot://contact/42",
	)
	if err != nil ||
		binding == nil ||
		binding.State != "active" ||
		binding.LastEmail != "new@example.com" ||
		binding.SourceRevisionAt == nil ||
		binding.SourceRevisionAt.Before(reactivationRevision) {
		t.Fatalf("reactivated binding=%+v err=%v", binding, err)
	}

	// HubSpot can deliver an ordinary deletion after a newer recreation or
	// property fetch. The stale event must not re-inactivate the binding or
	// detach the recreated contact's memberships.
	binding, err = repo.TransitionCRMContactProfileBinding(
		ctx,
		tenantID,
		integrationID,
		ProviderHubSpot,
		"hubspot://contact/42",
		"deleted",
		map[string]any{
			"ordinary_event":      "delayed-after-recreation",
			"hubspot_occurred_at": deletionOccurredAt.UnixMilli(),
		},
	)
	if err != nil || binding != nil {
		t.Fatalf("stale deletion transition binding=%+v err=%v, want ignored", binding, err)
	}
	binding, err = repo.ResolveCRMContactProfileBinding(
		ctx, tenantID, integrationID, ProviderHubSpot, "hubspot://contact/42",
	)
	if err != nil || binding == nil || binding.State != "active" || binding.LastEmail != "new@example.com" {
		t.Fatalf("stale deletion regressed reactivated binding=%+v err=%v", binding, err)
	}

	privacyOccurredAt := reactivationRevision.Add(time.Second)
	binding, err = repo.TransitionCRMContactProfileBinding(
		ctx,
		tenantID,
		integrationID,
		ProviderHubSpot,
		"hubspot://contact/42",
		"privacy_deleted",
		map[string]any{
			"hubspot_event_id":    "privacy-first",
			"hubspot_occurred_at": privacyOccurredAt.UnixMilli(),
			"email":               "new@example.com",
		},
	)
	if err != nil || binding == nil || binding.State != "privacy_deleted" {
		t.Fatalf("privacy transition binding=%+v err=%v", binding, err)
	}
	if binding.LastEmail != "" {
		t.Fatalf("privacy deletion retained binding email %q", binding.LastEmail)
	}
	ordinaryOccurredAt := privacyOccurredAt.Add(time.Second)
	binding, err = repo.TransitionCRMContactProfileBinding(
		ctx,
		tenantID,
		integrationID,
		ProviderHubSpot,
		"hubspot://contact/42",
		"deleted",
		map[string]any{
			"ordinary_event":      "arrived-later",
			"hubspot_occurred_at": ordinaryOccurredAt.UnixMilli(),
		},
	)
	if err != nil || binding == nil || binding.State != "privacy_deleted" {
		t.Fatalf("out-of-order ordinary deletion downgraded privacy binding=%+v err=%v", binding, err)
	}
	privacyMetadata, ok := binding.StateMetadata["privacy_deletion"].(map[string]any)
	if !ok || privacyMetadata["hubspot_event_id"] != "privacy-first" {
		t.Fatalf("privacy deletion metadata was not preserved: %+v", binding.StateMetadata)
	}
	encodedMetadata, err := json.Marshal(binding.StateMetadata)
	if err != nil {
		t.Fatalf("encode privacy metadata: %v", err)
	}
	if strings.Contains(string(encodedMetadata), "new@example.com") {
		t.Fatalf("privacy tombstone retained PII: %s", encodedMetadata)
	}
	if err := conn.QueryRow(ctx, `
SELECT status, consent_source, COALESCE(external_id, '')
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
		tenantID, subscriberID).Scan(&status, &consentSource, &externalID); err != nil {
		t.Fatalf("read subscriber after deletion: %v", err)
	}
	if status != "unconfirmed" || consentSource != "unknown" || externalID != "shopify-customer-7" {
		t.Fatalf("deletion changed subscriber lifecycle: status=%q consent=%q external=%q", status, consentSource, externalID)
	}

	resurrectionRevision := ordinaryOccurredAt.Add(time.Second)
	_, err = sink.UpsertCRMContact(ctx, tenantID, Integration{
		ID: integrationID, TenantID: tenantID, Provider: ProviderHubSpot,
	}, ContactInput{
		SourceID:  "42",
		Email:     "resurrected@example.com",
		UpdatedAt: &resurrectionRevision,
	})
	if !errors.Is(err, ErrCRMContactPrivacyDeleted) {
		t.Fatalf("privacy resurrection error=%v, want ErrCRMContactPrivacyDeleted", err)
	}
	binding, err = repo.ResolveCRMContactProfileBinding(
		ctx, tenantID, integrationID, ProviderHubSpot, "hubspot://contact/42",
	)
	if err != nil ||
		binding == nil ||
		binding.State != "privacy_deleted" ||
		binding.LastEmail != "" {
		t.Fatalf("privacy tombstone was reactivated=%+v err=%v", binding, err)
	}
}

func TestHubSpotContactBindingUsesDurableMigrationProjectionAfterPreBindingMerge(t *testing.T) {
	pool := newCRMRepoTestPool(t)
	repo := &Repo{Pool: pool}
	subscriberRepo := &subscribers.Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedCRMRepoTenant(t, pool, "crm-hubspot-prebinding-merge-"+suffix)
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		t.Fatalf("set tenant: %v", err)
	}

	var integrationID string
	if err := conn.QueryRow(ctx, `
INSERT INTO crm_integrations (tenant_id, provider, name, status, scopes, credentials_ref, settings)
VALUES ($1::uuid, 'hubspot', $2, 'connected', ARRAY[]::text[], 'crm:hubspot:test', '{}'::jsonb)
RETURNING id::text`,
		tenantID,
		"HubSpot Prebinding Merge "+suffix,
	).Scan(&integrationID); err != nil {
		t.Fatalf("seed integration: %v", err)
	}
	primary, err := subscriberRepo.Upsert(ctx, tenantID, subscribers.CreateInput{
		Email:                "survivor-" + suffix + "@example.com",
		Status:               subscribers.StatusUnconfirmed,
		ConsentSource:        subscribers.ConsentUnknown,
		PreserveConsentState: true,
	})
	if err != nil {
		t.Fatalf("seed merge survivor: %v", err)
	}
	duplicate, err := subscriberRepo.Upsert(ctx, tenantID, subscribers.CreateInput{
		Email:                "migrated-" + suffix + "@example.com",
		Status:               subscribers.StatusUnconfirmed,
		ConsentSource:        subscribers.ConsentUnknown,
		PreserveConsentState: true,
		SourcePlatform:       ProviderHubSpot,
		SourceID:             "42",
	})
	if err != nil {
		t.Fatalf("seed migrated duplicate: %v", err)
	}
	var jobID string
	if err := conn.QueryRow(ctx, `
INSERT INTO migration_jobs (tenant_id, source, status)
VALUES ($1::uuid, 'hubspot', 'complete')
RETURNING id::text`,
		tenantID,
	).Scan(&jobID); err != nil {
		t.Fatalf("seed migration job: %v", err)
	}
	projection, err := json.Marshal(map[string]any{
		"postwave_subscriber_id": duplicate.ID,
		"postwave_source_projections": map[string]any{
			"hubspot:42": map[string]any{
				"version": 1,
				"subscriber": map[string]any{
					"email":             duplicate.Email,
					"status":            "unconfirmed",
					"consent_timestamp": nil,
					"consent_source":    "unknown",
					"custom_fields":     map[string]any{},
					"tags":              []string{},
					"source_id":         "42",
					"source_platform":   "hubspot",
				},
				"audiences": []any{},
			},
		},
	})
	if err != nil {
		t.Fatalf("encode migration projection: %v", err)
	}
	if _, err := conn.Exec(ctx, `
INSERT INTO migration_imported_resources (
    tenant_id, job_id, resource_type, source_platform, source_id,
    destination_type, destination_id, destination_metadata
)
VALUES (
    $1::uuid, $2::uuid, 'subscriber', 'hubspot', '43',
    'listmonk_subscriber', '9001', $3::jsonb
)`,
		tenantID,
		jobID,
		string(projection),
	); err != nil {
		t.Fatalf("seed durable migration projection: %v", err)
	}

	if _, err := subscriberRepo.Merge(ctx, tenantID, subscribers.MergeInput{
		PrimaryID:        primary.ID,
		DuplicateID:      duplicate.ID,
		PrimaryVersion:   primary.Version,
		DuplicateVersion: duplicate.Version,
	}); err != nil {
		t.Fatalf("merge migrated subscriber before native binding: %v", err)
	}
	var tombstoneSourcePlatform, tombstoneSourceID string
	if err := conn.QueryRow(ctx, `
SELECT COALESCE(source_platform, ''), COALESCE(source_id, '')
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND id = $2::uuid`,
		tenantID,
		duplicate.ID,
	).Scan(&tombstoneSourcePlatform, &tombstoneSourceID); err != nil {
		t.Fatalf("read merged migration tombstone: %v", err)
	}
	if tombstoneSourcePlatform != "" || tombstoneSourceID != "" {
		t.Fatalf("merge did not clear duplicate source provenance: %q/%q", tombstoneSourcePlatform, tombstoneSourceID)
	}

	binding, err := repo.ResolveCRMContactProfileBinding(
		ctx,
		tenantID,
		integrationID,
		ProviderHubSpot,
		"hubspot://contact/42",
	)
	if err != nil {
		t.Fatalf("resolve durable pre-binding merge projection: %v", err)
	}
	if binding == nil ||
		binding.SubscriberID != primary.ID ||
		binding.SubscriberProfileID != primary.ProfileID ||
		binding.BindingOrigin != "migration_source" {
		t.Fatalf("durable pre-binding merge projection resolved binding=%+v", binding)
	}
}

func TestHubSpotContactBindingSerializesFirstSyncAndDeletionAgainstStaleFetch(t *testing.T) {
	pool := newCRMRepoTestPool(t)
	repo := &Repo{Pool: pool}
	subscriberRepo := &subscribers.Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedCRMRepoTenant(t, pool, "crm-hubspot-binding-race-"+suffix)
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	var integrationID string
	if err := conn.QueryRow(ctx, `
INSERT INTO crm_integrations (tenant_id, provider, name, status, scopes, credentials_ref, settings)
VALUES ($1::uuid, 'hubspot', $2, 'connected', ARRAY[]::text[], 'crm:hubspot:test', '{}'::jsonb)
RETURNING id::text`,
		tenantID,
		"HubSpot Binding Race "+suffix,
	).Scan(&integrationID); err != nil {
		t.Fatalf("seed integration: %v", err)
	}
	integration := Integration{
		ID: integrationID, TenantID: tenantID, Provider: ProviderHubSpot,
	}
	sink := SubscriberProfileSink{Repo: subscriberRepo, Identities: repo}
	// source_revision_at is a timestamptz, which holds microseconds; pgx sends
	// the binary wire value as Nanosecond()/1000. A Go instant with a
	// sub-microsecond remainder (any Linux wall clock; macOS happens to tick in
	// whole microseconds) therefore reads back up to 999ns EARLIER than it was
	// sent, and `SourceRevisionAt.Before(newerRevision)` would report a lost
	// revision that was persisted exactly. Pin the seeds to what the column can
	// store so every revision derived from them round-trips bit-for-bit.
	olderRevision := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Microsecond)
	newerRevision := olderRevision.Add(time.Hour)
	contacts := []ContactInput{
		{SourceID: "42", Email: "race-old-" + suffix + "@example.com", UpdatedAt: &olderRevision},
		{SourceID: "42", Email: "race-new-" + suffix + "@example.com", UpdatedAt: &newerRevision},
	}
	type upsertResult struct {
		subscriberID string
		err          error
	}
	start := make(chan struct{})
	results := make(chan upsertResult, len(contacts))
	var wg sync.WaitGroup
	for _, contact := range contacts {
		contact := contact
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			id, upsertErr := sink.UpsertCRMContact(ctx, tenantID, integration, contact)
			results <- upsertResult{subscriberID: id, err: upsertErr}
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	successIDs := map[string]struct{}{}
	for result := range results {
		if result.err != nil && !errors.Is(result.err, ErrCRMContactSourceRevisionStale) {
			t.Fatalf("concurrent first sync: %v", result.err)
		}
		if result.subscriberID != "" {
			successIDs[result.subscriberID] = struct{}{}
		}
	}
	if len(successIDs) != 1 {
		t.Fatalf("concurrent first sync subscriber IDs=%v, want one stable identity", successIDs)
	}
	binding, err := repo.ResolveCRMContactProfileBinding(
		ctx, tenantID, integrationID, ProviderHubSpot, "hubspot://contact/42",
	)
	if err != nil ||
		binding == nil ||
		binding.State != "active" ||
		binding.SourceRevisionAt == nil ||
		binding.SourceRevisionAt.Before(newerRevision) {
		t.Fatalf("binding after concurrent first sync=%+v err=%v", binding, err)
	}
	var activeProfiles int
	if err := conn.QueryRow(ctx, `
SELECT count(*)::int
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND merged_into_subscriber_id IS NULL`,
		tenantID,
	).Scan(&activeProfiles); err != nil {
		t.Fatalf("count concurrent first-sync profiles: %v", err)
	}
	if activeProfiles != 1 {
		t.Fatalf("active first-sync profiles=%d, want 1", activeProfiles)
	}

	staleFetchRevision := newerRevision.Add(time.Hour)
	deletionOccurredAt := staleFetchRevision.Add(time.Hour)
	start = make(chan struct{})
	errs := make(chan error, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		_, upsertErr := sink.UpsertCRMContact(ctx, tenantID, integration, ContactInput{
			SourceID:  "42",
			Email:     "race-stale-" + suffix + "@example.com",
			UpdatedAt: &staleFetchRevision,
		})
		errs <- upsertErr
	}()
	go func() {
		defer wg.Done()
		<-start
		_, _, transitionErr := sink.ReconcileCRMContactState(
			ctx,
			tenantID,
			integration,
			"hubspot://contact/42",
			"deleted",
			map[string]any{"hubspot_occurred_at": deletionOccurredAt.UnixMilli()},
		)
		errs <- transitionErr
	}()
	close(start)
	wg.Wait()
	close(errs)
	for raceErr := range errs {
		if raceErr != nil && !errors.Is(raceErr, ErrCRMContactSourceRevisionStale) {
			t.Fatalf("delete/stale-fetch race: %v", raceErr)
		}
	}
	binding, err = repo.ResolveCRMContactProfileBinding(
		ctx, tenantID, integrationID, ProviderHubSpot, "hubspot://contact/42",
	)
	persistedDeletionRevision := time.UnixMilli(deletionOccurredAt.UnixMilli())
	if err != nil ||
		binding == nil ||
		binding.State != "deleted" ||
		binding.SourceRevisionAt == nil ||
		binding.SourceRevisionAt.Before(persistedDeletionRevision) {
		t.Fatalf("stale fetch won deletion race binding=%+v err=%v", binding, err)
	}
}

func TestHubSpotMigrationBindingFailsClosedOnAmbiguousRawAndNamespacedSources(t *testing.T) {
	pool := newCRMRepoTestPool(t)
	repo := &Repo{Pool: pool}
	suffix := strings.ReplaceAll(time.Now().UTC().Format("20060102150405.000000000"), ".", "")
	tenantID := seedCRMRepoTenant(t, pool, "crm-hubspot-identity-ambiguous-"+suffix)
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT set_config('app.tenant_id', $1, false)`, tenantID); err != nil {
		t.Fatalf("set tenant: %v", err)
	}
	var integrationID string
	if err := conn.QueryRow(ctx, `
INSERT INTO crm_integrations (tenant_id, provider, name, status, scopes, credentials_ref, settings)
VALUES ($1::uuid, 'hubspot', $2, 'connected', ARRAY[]::text[], 'crm:hubspot:test', '{}'::jsonb)
RETURNING id::text`, tenantID, "HubSpot Ambiguous Identity "+suffix).Scan(&integrationID); err != nil {
		t.Fatalf("seed integration: %v", err)
	}
	for i, sourceID := range []string{"42", "hubspot://contact/42"} {
		if _, err := conn.Exec(ctx, `
INSERT INTO subscribers (
    tenant_id, email, status, consent_source, source_platform, source_id
)
VALUES ($1::uuid, $2, 'unconfirmed', 'unknown', 'hubspot', $3)`,
			tenantID, fmt.Sprintf("ambiguous-%d@example.com", i), sourceID); err != nil {
			t.Fatalf("seed ambiguous source %q: %v", sourceID, err)
		}
	}
	_, err = repo.ResolveCRMContactProfileBinding(
		ctx, tenantID, integrationID, ProviderHubSpot, "hubspot://contact/42",
	)
	if !errors.Is(err, ErrCRMContactIdentityAmbiguous) {
		t.Fatalf("resolve err=%v, want ErrCRMContactIdentityAmbiguous", err)
	}
}
