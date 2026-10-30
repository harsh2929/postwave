// SPDX-License-Identifier: AGPL-3.0-only

package crm_integrations

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/lists"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

// A CRM that still holds a contact who was deleted here must not bring them
// back through list membership, and honouring that is not a sync failure:
// the membership sink skips the address, as the contact path skips a
// privacy-deleted contact.
func TestNativeListMembershipSkipsADeletedContactWithoutFailingTheSync_DB(t *testing.T) {
	pool := newCRMRepoTestPool(t)
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")[:10]
	tenantID := seedCRMRepoTenant(t, pool, "crm-erased-member-"+suffix)
	deleted := "crm-deleted-" + suffix + "@example.test"
	kept := "crm-kept-" + suffix + "@example.test"
	keptByProvider := "crm-provider-kept-" + suffix + "@example.test"
	listID := uuid.NewString()
	ctx := context.Background()

	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var subscriberID string
	if err = tx.QueryRow(ctx, `
INSERT INTO subscribers (tenant_id, email, status, consent_source)
VALUES ($1::uuid, $2, 'unconfirmed', 'api')
RETURNING id::text`, tenantID, deleted).Scan(&subscriberID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed contact: %v", err)
	}
	// Lists resolve through list_id_map: give the test list a real identity,
	// as every list created through the product has.
	if _, err = tx.Exec(ctx, `
INSERT INTO list_id_map (postwave_uuid, listmonk_bigint_id, tenant_id)
VALUES ($1::uuid, $2, $3::uuid)`, listID, erasureSyncEngineListID(suffix), tenantID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("seed list identity: %v", err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = (&subscribers.Repo{Pool: pool}).Delete(ctx, tenantID, subscriberID); err != nil {
		t.Fatalf("delete contact: %v", err)
	}
	t.Cleanup(func() {
		cleanup, cleanupErr := db.WithTenant(context.Background(), pool, tenantID)
		if cleanupErr != nil {
			return
		}
		defer func() { _ = cleanup.Rollback(context.Background()) }()
		if _, cleanupErr = cleanup.Exec(context.Background(), `DELETE FROM subscribers WHERE tenant_id = $1::uuid`, tenantID); cleanupErr == nil {
			_ = cleanup.Commit(context.Background())
		}
	})

	// A connected integration, so the provider-owned path records ownership for
	// any address the erasure gate lets through.
	seed, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	var integrationID string
	if err = seed.QueryRow(ctx, `
INSERT INTO crm_integrations (tenant_id, provider, name, status, scopes, credentials_ref, settings)
VALUES ($1::uuid, 'hubspot', $2, 'connected', ARRAY[]::text[], 'cred_hubspot_erasure', '{}'::jsonb)
RETURNING id::text`, tenantID, "HubSpot "+suffix).Scan(&integrationID); err != nil {
		_ = seed.Rollback(ctx)
		t.Fatalf("seed CRM integration: %v", err)
	}
	if err = seed.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	sink := NativeListMembershipSink{Repo: &lists.Repo{Pool: pool}}
	providerMember := func(email, memberID string) CRMNativeListMembershipSeen {
		return CRMNativeListMembershipSeen{
			IntegrationID: integrationID, Provider: ProviderHubSpot, ProviderSegmentType: "list",
			ProviderListID: "hs-list-1", NativeListID: listID, ProviderMemberID: memberID, Email: email,
		}
	}
	if err = sink.AddProviderCRMContactToList(ctx, tenantID, providerMember(deleted, "hs-1")); err != nil {
		t.Fatalf("provider sink reported the erasure as a failure: %v", err)
	}
	if err = sink.AddProviderCRMContactToList(ctx, tenantID, providerMember(keptByProvider, "hs-2")); err != nil {
		t.Fatalf("provider sink refused a live address: %v", err)
	}
	for _, email := range []string{deleted, kept} {
		if err = sink.AddCRMContactToList(ctx, tenantID, listID, "", email); err != nil {
			t.Fatalf("add %s through the list sink: %v", email, err)
		}
	}

	read, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = read.Rollback(ctx) }()
	count := func(sql string, email string) int {
		t.Helper()
		var n int
		if err := read.QueryRow(ctx, sql, tenantID, email).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	const contacts = `SELECT count(*) FROM subscribers WHERE tenant_id = $1::uuid AND lower(email::text) = $2`
	const ownership = `SELECT count(*) FROM list_subscriber_sources WHERE tenant_id = $1::uuid AND lower(email::text) = $2`
	if n := count(contacts, deleted); n != 0 {
		t.Fatalf("CRM membership sync re-created the deleted contact (%d rows)", n)
	}
	if n := count(ownership, deleted); n != 0 {
		t.Fatalf("CRM membership sync recorded list ownership for the deleted contact (%d rows)", n)
	}
	if count(contacts, kept) != 1 || count(contacts, keptByProvider) != 1 || count(ownership, keptByProvider) != 1 {
		t.Fatalf("live addresses were not added: kept=%d provider=%d provider ownership=%d",
			count(contacts, kept), count(contacts, keptByProvider), count(ownership, keptByProvider))
	}
}

// erasureSyncEngineListID derives a unique engine list id from a test's random hex suffix.
func erasureSyncEngineListID(suffix string) int64 {
	id, err := strconv.ParseInt(suffix, 16, 64)
	if err != nil {
		panic(err)
	}
	return id + 1_000_000
}
