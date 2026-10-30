// SPDX-License-Identifier: AGPL-3.0-only
package customobjects

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

// seedTypeAndRecord creates a type + record for tenant and returns the
// record id (used as the link target).
func seedTypeAndRecord(t *testing.T, s *MemoryStore, tenant string) (typeID, recordID string) {
	t.Helper()
	ctx := context.Background()
	ot, err := s.CreateType(ctx, tenant, CreateTypeParams{Key: "order", Label: "Order", Schema: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatalf("create type: %v", err)
	}
	rec, err := s.UpsertRecord(ctx, tenant, ot.ID, UpsertRecordParams{
		ExternalID: "ord_1",
		Properties: json.RawMessage(`{"total":42}`),
	})
	if err != nil {
		t.Fatalf("upsert record: %v", err)
	}
	return ot.ID, rec.ID
}

func TestProfileLinks_CreateListUpdateDelete(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	tenant := "tenant-a"
	sub := "11111111-1111-1111-1111-111111111111"
	typeID, recordID := seedTypeAndRecord(t, s, tenant)

	// Create.
	link, err := s.CreateProfileLink(ctx, tenant, sub, CreateProfileLinkParams{
		ObjectRecordID: recordID,
		Relationship:   "purchased",
		Metadata:       json.RawMessage(`{"qty":2}`),
	})
	if err != nil {
		t.Fatalf("create link: %v", err)
	}
	if link.ID == "" || link.ObjectTypeID != typeID || link.Relationship != "purchased" {
		t.Fatalf("unexpected link: %+v", link)
	}

	// List hydrates type + record context.
	links, err := s.ListProfileLinks(ctx, tenant, sub)
	if err != nil || len(links) != 1 {
		t.Fatalf("list: %v len=%d", err, len(links))
	}
	if links[0].ObjectTypeKey != "order" || links[0].ExternalID != "ord_1" {
		t.Fatalf("listing not hydrated: %+v", links[0])
	}

	// Update relationship only; metadata untouched.
	rel := "returned"
	upd, err := s.UpdateProfileLink(ctx, tenant, link.ID, UpdateProfileLinkParams{Relationship: &rel})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if upd.Relationship != "returned" {
		t.Fatalf("relationship not updated: %+v", upd)
	}
	if string(upd.Metadata) != `{"qty":2}` {
		t.Fatalf("metadata should be preserved on partial update: %s", upd.Metadata)
	}

	// Delete.
	if err := s.DeleteProfileLink(ctx, tenant, link.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	links, _ = s.ListProfileLinks(ctx, tenant, sub)
	if len(links) != 0 {
		t.Fatalf("expected empty after delete, got %d", len(links))
	}
}

func TestProfileLinks_DefaultRelationship(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	tenant := "tenant-a"
	sub := "22222222-2222-2222-2222-222222222222"
	_, recordID := seedTypeAndRecord(t, s, tenant)

	link, err := s.CreateProfileLink(ctx, tenant, sub, CreateProfileLinkParams{ObjectRecordID: recordID})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if link.Relationship != "related" {
		t.Fatalf("default relationship = %q, want related", link.Relationship)
	}
	if string(link.Metadata) != "{}" {
		t.Fatalf("default metadata = %q, want {}", link.Metadata)
	}
}

func TestProfileLinks_DuplicateConflict(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	tenant := "tenant-a"
	sub := "33333333-3333-3333-3333-333333333333"
	_, recordID := seedTypeAndRecord(t, s, tenant)

	if _, err := s.CreateProfileLink(ctx, tenant, sub, CreateProfileLinkParams{ObjectRecordID: recordID, Relationship: "owns"}); err != nil {
		t.Fatalf("first link: %v", err)
	}
	_, err := s.CreateProfileLink(ctx, tenant, sub, CreateProfileLinkParams{ObjectRecordID: recordID, Relationship: "owns"})
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate (tenant,record,subscriber,relationship) = %v, want ErrConflict", err)
	}
}

func TestProfileLinks_UnknownRecord(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	_, err := s.CreateProfileLink(ctx, "tenant-a", "44444444-4444-4444-4444-444444444444",
		CreateProfileLinkParams{ObjectRecordID: "no-such-record"})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("link to unknown record = %v, want ErrNotFound", err)
	}
}

func TestProfileLinks_TenantIsolation(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	sub := "55555555-5555-5555-5555-555555555555"
	_, recordID := seedTypeAndRecord(t, s, "tenant-a")

	link, err := s.CreateProfileLink(ctx, "tenant-a", sub, CreateProfileLinkParams{ObjectRecordID: recordID})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// tenant-b cannot see, update, or delete tenant-a's link.
	if links, _ := s.ListProfileLinks(ctx, "tenant-b", sub); len(links) != 0 {
		t.Fatalf("cross-tenant list leaked %d links", len(links))
	}
	if _, err := s.UpdateProfileLink(ctx, "tenant-b", link.ID, UpdateProfileLinkParams{}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant update = %v, want ErrNotFound", err)
	}
	if err := s.DeleteProfileLink(ctx, "tenant-b", link.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant delete = %v, want ErrNotFound", err)
	}
}
