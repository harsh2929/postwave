// SPDX-License-Identifier: AGPL-3.0-only
//
// membership_import_owner_db_test.go — a membership a CSV import created is an
// operator's membership, so the Members tab's Remove really removes it.
//
// RemoveMember retires the OPERATOR owners of a membership and then removes the
// membership itself only when no other owner still claims it. That is what stops
// a CRM sync from silently undoing an operator's add. A CSV import that named a
// target list (subscriber_import/target_list.go writes source 'csv' with the
// ledger owner 'source:csv') is an operator action of exactly the same kind:
// nothing re-runs it. With its owner missing from that set, Remove answered 204
// and left the contact on the list.

package lists

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// activeMembership reports whether the contact is an ACTIVE member, plus the
// ledger owners that still claim the membership.
func activeMembership(t *testing.T, pool *db.Pool, tenantID, listUUID, subscriberID string) (bool, []string) {
	t.Helper()
	ctx := context.Background()
	tx, err := db.WithTenant(ctx, pool, tenantID)
	if err != nil {
		t.Fatalf("open membership read: %v", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var active bool
	var owners []string
	if err := tx.QueryRow(ctx, `
SELECT EXISTS(
           SELECT 1 FROM list_subscribers
            WHERE tenant_id = $1::uuid AND list_id = $2::uuid
              AND subscriber_id = $3::uuid AND removed_at IS NULL),
       COALESCE(ARRAY(
           SELECT owner_key FROM list_subscriber_sources
            WHERE tenant_id = $1::uuid AND list_id = $2::uuid
              AND subscriber_id = $3::uuid AND removed_at IS NULL
            ORDER BY owner_key), '{}'::text[])`,
		tenantID, listUUID, subscriberID).Scan(&active, &owners); err != nil {
		t.Fatalf("read membership: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit membership read: %v", err)
	}
	return active, owners
}

func TestRemoveMemberRemovesAMembershipACSVImportCreated(t *testing.T) {
	pool := newListMembershipConsentTestPool(t)
	tenantID := seedListMembershipConsentTenant(t, pool)
	listUUID := mappedTestList(t, pool, tenantID)
	email := "csv-import-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:8] + "@example.test"
	repo := &Repo{Pool: pool}

	// Exactly what an import that named a target list writes.
	subscriberID, err := repo.AddEmailToListOwned(context.Background(), tenantID, listUUID, email,
		ListMembershipOwner{
			Source:   "csv",
			OwnerKey: "source:csv",
			Metadata: map[string]any{"owner": "subscriber_import"},
		})
	if err != nil {
		t.Fatalf("seed import-owned membership: %v", err)
	}
	if active, owners := activeMembership(t, pool, tenantID, listUUID, subscriberID); !active ||
		len(owners) != 1 || owners[0] != "source:csv" {
		t.Fatalf("seeded membership active=%v owners=%v, want active with [source:csv]", active, owners)
	}

	removed, err := repo.RemoveMember(context.Background(), tenantID, listUUID, subscriberID)
	if err != nil {
		t.Fatalf("remove member: %v", err)
	}
	if !removed {
		t.Fatal("remove reported nothing to remove")
	}
	active, owners := activeMembership(t, pool, tenantID, listUUID, subscriberID)
	if active {
		t.Error("the contact is still an active member after Remove")
	}
	if len(owners) != 0 {
		t.Errorf("owners still claiming the membership: %v", owners)
	}
}

// The other half of the same rule: a LIVE sync's owner keeps the membership
// alive, because that owner would only put the contact back.
func TestRemoveMemberKeepsAMembershipALiveSyncStillOwns(t *testing.T) {
	pool := newListMembershipConsentTestPool(t)
	tenantID := seedListMembershipConsentTenant(t, pool)
	listUUID := mappedTestList(t, pool, tenantID)
	email := "synced-" + strings.ReplaceAll(uuid.NewString(), "-", "")[:8] + "@example.test"
	repo := &Repo{Pool: pool}

	subscriberID, err := repo.AddEmailToListOwned(context.Background(), tenantID, listUUID, email,
		ListMembershipOwner{
			Source:   "csv",
			OwnerKey: "source:csv",
			Metadata: map[string]any{"owner": "subscriber_import"},
		})
	if err != nil {
		t.Fatalf("seed import-owned membership: %v", err)
	}
	if _, formErr := repo.AddEmailToListOwned(context.Background(), tenantID, listUUID, email,
		ListMembershipOwner{
			Source:   "form",
			OwnerKey: "source:form:signup",
			Metadata: map[string]any{"owner": "form"},
		}); formErr != nil {
		t.Fatalf("seed form-owned membership: %v", formErr)
	}

	removed, err := repo.RemoveMember(context.Background(), tenantID, listUUID, subscriberID)
	if err != nil {
		t.Fatalf("remove member: %v", err)
	}
	if !removed {
		t.Fatal("remove reported nothing to remove")
	}
	active, owners := activeMembership(t, pool, tenantID, listUUID, subscriberID)
	if !active {
		t.Error("a membership a signup form still owns was removed")
	}
	if len(owners) != 1 || owners[0] != "source:form:signup" {
		t.Errorf("owners = %v, want only the form", owners)
	}
}
