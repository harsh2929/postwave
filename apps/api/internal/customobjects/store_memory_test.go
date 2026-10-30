// SPDX-License-Identifier: AGPL-3.0-only
package customobjects

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

func newTestStore() *MemoryStore {
	tick := int64(0)
	return NewMemoryStore(func() time.Time {
		tick++
		return time.Unix(1700000000+tick, 0).UTC()
	})
}

func TestMemoryStore_CreateAndListTypes(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	tenant := "tenant-a"

	out, err := s.CreateType(ctx, tenant, CreateTypeParams{Key: "order", Label: "Order", Schema: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if out.ID == "" || out.Status != "active" || out.PrimaryKey != "external_id" {
		t.Errorf("unexpected defaults: %+v", out)
	}

	list, err := s.ListTypes(ctx, tenant)
	if err != nil || len(list) != 1 || list[0].Key != "order" {
		t.Fatalf("list: %v, %v", list, err)
	}
}

func TestMemoryStore_CreateTypeRejectsDuplicateKey(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	tenant := "tenant-a"

	if _, err := s.CreateType(ctx, tenant, CreateTypeParams{Key: "order", Label: "Order", Schema: json.RawMessage(`{}`)}); err != nil {
		t.Fatalf("first create: %v", err)
	}
	_, err := s.CreateType(ctx, tenant, CreateTypeParams{Key: "order", Label: "Order v2", Schema: json.RawMessage(`{}`)})
	if !errors.Is(err, ErrConflict) {
		t.Errorf("expected ErrConflict, got %v", err)
	}
}

func TestMemoryStore_TenantIsolation(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()

	if _, err := s.CreateType(ctx, "tenant-a", CreateTypeParams{Key: "order", Label: "Order", Schema: json.RawMessage(`{}`)}); err != nil {
		t.Fatalf("create a: %v", err)
	}
	if _, err := s.CreateType(ctx, "tenant-b", CreateTypeParams{Key: "order", Label: "Order", Schema: json.RawMessage(`{}`)}); err != nil {
		t.Fatalf("tenant-b should be able to use the same key: %v", err)
	}

	list, _ := s.ListTypes(ctx, "tenant-a")
	if len(list) != 1 {
		t.Errorf("tenant-a list = %d, want 1", len(list))
	}
	list, _ = s.ListTypes(ctx, "tenant-b")
	if len(list) != 1 {
		t.Errorf("tenant-b list = %d, want 1", len(list))
	}
}

func TestMemoryStore_GetType_NotFoundCrossTenant(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	o, err := s.CreateType(ctx, "tenant-a", CreateTypeParams{Key: "order", Label: "Order", Schema: json.RawMessage(`{}`)})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	_, err = s.GetType(ctx, "tenant-b", o.ID)
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("cross-tenant read must return ErrNotFound, got %v", err)
	}
}

func TestMemoryStore_UpsertAndListRecords(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	tenant := "tenant-a"
	o, _ := s.CreateType(ctx, tenant, CreateTypeParams{Key: "order", Label: "Order", Schema: json.RawMessage(`{}`)})

	r1, err := s.UpsertRecord(ctx, tenant, o.ID, UpsertRecordParams{
		ExternalID: "ord_1",
		Properties: json.RawMessage(`{"status":"shipped","total":42}`),
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	// Upsert same external_id should update, not duplicate.
	r2, err := s.UpsertRecord(ctx, tenant, o.ID, UpsertRecordParams{
		ExternalID:      "ord_1",
		Properties:      json.RawMessage(`{"status":"delivered","total":42}`),
		ExpectedVersion: r1.Version,
	})
	if err != nil {
		t.Fatalf("upsert 2: %v", err)
	}
	if r1.ID != r2.ID {
		t.Errorf("upsert should update in place, got ids %s vs %s", r1.ID, r2.ID)
	}

	list, err := s.ListRecords(ctx, tenant, o.ID, ListRecordsFilter{})
	if err != nil || len(list.Items) != 1 {
		t.Fatalf("list: len=%d err=%v", len(list.Items), err)
	}
}

func TestMemoryStore_ListRecordsPropertyFilter(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	tenant := "tenant-a"
	o, _ := s.CreateType(ctx, tenant, CreateTypeParams{Key: "order", Label: "Order", Schema: json.RawMessage(`{}`)})

	_, _ = s.UpsertRecord(ctx, tenant, o.ID, UpsertRecordParams{ExternalID: "a", Properties: json.RawMessage(`{"status":"shipped"}`)})
	_, _ = s.UpsertRecord(ctx, tenant, o.ID, UpsertRecordParams{ExternalID: "b", Properties: json.RawMessage(`{"status":"delivered"}`)})
	_, _ = s.UpsertRecord(ctx, tenant, o.ID, UpsertRecordParams{ExternalID: "c", Properties: json.RawMessage(`{"status":"shipped"}`)})

	list, _ := s.ListRecords(ctx, tenant, o.ID, ListRecordsFilter{PropertyKey: "status", PropertyValue: "shipped"})
	if len(list.Items) != 2 {
		t.Errorf("filtered list = %d, want 2", len(list.Items))
	}
}

func TestMemoryStore_ListRecordsPropertyFilter_HandlesNumberAndBool(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	tenant := "tenant-a"
	o, _ := s.CreateType(ctx, tenant, CreateTypeParams{Key: "order", Label: "Order", Schema: json.RawMessage(`{}`)})

	_, _ = s.UpsertRecord(ctx, tenant, o.ID, UpsertRecordParams{ExternalID: "a", Properties: json.RawMessage(`{"total":42,"vip":true}`)})
	_, _ = s.UpsertRecord(ctx, tenant, o.ID, UpsertRecordParams{ExternalID: "b", Properties: json.RawMessage(`{"total":7,"vip":false}`)})

	list, _ := s.ListRecords(ctx, tenant, o.ID, ListRecordsFilter{PropertyKey: "total", PropertyValue: "42"})
	if len(list.Items) != 1 || list.Items[0].ExternalID != "a" {
		t.Errorf("numeric filter mismatch, got %+v", list)
	}
	list, _ = s.ListRecords(ctx, tenant, o.ID, ListRecordsFilter{PropertyKey: "vip", PropertyValue: "true"})
	if len(list.Items) != 1 || list.Items[0].ExternalID != "a" {
		t.Errorf("boolean filter mismatch, got %+v", list)
	}
}

func TestMemoryStore_DeleteTypeCascadesRecords(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	tenant := "tenant-a"
	o, _ := s.CreateType(ctx, tenant, CreateTypeParams{Key: "order", Label: "Order", Schema: json.RawMessage(`{}`)})
	_, _ = s.UpsertRecord(ctx, tenant, o.ID, UpsertRecordParams{ExternalID: "a", Properties: json.RawMessage(`{}`)})

	if err := s.DeleteType(ctx, tenant, o.ID, DeleteTypeParams{ExpectedVersion: o.Version, ConfirmationKey: o.Key}); err != nil {
		t.Fatalf("delete: %v", err)
	}
	list, _ := s.ListRecords(ctx, tenant, o.ID, ListRecordsFilter{})
	if len(list.Items) != 0 {
		t.Errorf("cascade failed, %d records remain", len(list.Items))
	}
}

func TestMemoryStore_UpdateTypeKeepsKeyImmutable(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	tenant := "tenant-a"
	o, _ := s.CreateType(ctx, tenant, CreateTypeParams{Key: "order", Label: "Order", Schema: json.RawMessage(`{}`)})

	out, err := s.UpdateType(ctx, tenant, o.ID, UpdateTypeParams{
		Label:           "Order v2",
		Schema:          json.RawMessage(`{"type":"object"}`),
		Status:          "deprecated",
		ExpectedVersion: o.Version,
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if out.Key != "order" {
		t.Errorf("key should be immutable on update, got %q", out.Key)
	}
	if out.Label != "Order v2" || out.Status != "deprecated" {
		t.Errorf("update fields didn't apply: %+v", out)
	}
}

func TestMemoryStore_UpdateTypeKeepsCustomPrimaryKeyDeclared(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	o, err := s.CreateType(ctx, "tenant-a", CreateTypeParams{
		Key: "order", Label: "Order", PrimaryKey: "order_id",
		Schema: json.RawMessage(`{"type":"object","properties":{"order_id":{"type":"string"}}}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.UpdateType(ctx, "tenant-a", o.ID, UpdateTypeParams{
		Label: "Order", Schema: json.RawMessage(`{"type":"object","properties":{}}`),
		Status: "active", ExpectedVersion: o.Version,
	})
	if validationCode(err) != "invalid_primary_key" {
		t.Fatalf("schema removed immutable primary key: %v", err)
	}
	current, _ := s.GetType(ctx, "tenant-a", o.ID)
	if current.Version != o.Version || string(current.Schema) != string(o.Schema) {
		t.Fatalf("rejected update changed row: %+v", current)
	}
}

func TestMemoryStore_UpdateOfMissingRecordDoesNotCreate(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	o, _ := s.CreateType(ctx, "tenant-a", CreateTypeParams{
		Key: "order", Label: "Order", Schema: json.RawMessage(`{}`),
	})
	_, err := s.UpsertRecord(ctx, "tenant-a", o.ID, UpsertRecordParams{
		ExternalID: "missing", Properties: json.RawMessage(`{}`), ExpectedVersion: 7,
	})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("positive-version missing update err=%v", err)
	}
	page, listErr := s.ListRecords(ctx, "tenant-a", o.ID, ListRecordsFilter{})
	if listErr != nil || len(page.Items) != 0 {
		t.Fatalf("missing update created a record: page=%+v err=%v", page, listErr)
	}
}

func TestMemoryStore_DeleteRecord_CrossTenantBlocked(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	o, _ := s.CreateType(ctx, "tenant-a", CreateTypeParams{Key: "order", Label: "Order", Schema: json.RawMessage(`{}`)})
	r, _ := s.UpsertRecord(ctx, "tenant-a", o.ID, UpsertRecordParams{ExternalID: "x", Properties: json.RawMessage(`{}`)})

	params := DeleteRecordParams{ExpectedVersion: r.Version, ConfirmationExternalID: r.ExternalID}
	if err := s.DeleteRecord(ctx, "tenant-b", r.ID, params); !errors.Is(err, ErrNotFound) {
		t.Errorf("cross-tenant delete should return ErrNotFound, got %v", err)
	}
	if err := s.DeleteRecord(ctx, "tenant-a", r.ID, params); err != nil {
		t.Errorf("same-tenant delete should succeed, got %v", err)
	}
}

func TestMemoryStore_GetTypeByKey(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	tenant := "tenant-a"
	want, _ := s.CreateType(ctx, tenant, CreateTypeParams{Key: "order", Label: "Order", Schema: json.RawMessage(`{}`)})

	got, err := s.GetTypeByKey(ctx, tenant, "order")
	if err != nil || got.ID != want.ID {
		t.Errorf("GetTypeByKey mismatch, got %+v err %v", got, err)
	}

	_, err = s.GetTypeByKey(ctx, tenant, "nope")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("missing key should return ErrNotFound, got %v", err)
	}
}

func TestMemoryStore_ConcurrentTypeUpdatesHaveOneWinner(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	objectType, err := s.CreateType(ctx, "tenant-a", CreateTypeParams{
		Key: "order", Label: "Order", Schema: json.RawMessage(`{}`),
	})
	if err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, label := range []string{"Order A", "Order B"} {
		label := label
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, updateErr := s.UpdateType(ctx, "tenant-a", objectType.ID, UpdateTypeParams{
				Label: label, Schema: json.RawMessage(`{}`), Status: "active", ExpectedVersion: objectType.Version,
			})
			errs <- updateErr
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	winners, stale := 0, 0
	for updateErr := range errs {
		switch {
		case updateErr == nil:
			winners++
		case errors.Is(updateErr, ErrStale):
			stale++
		default:
			t.Fatalf("unexpected update error: %v", updateErr)
		}
	}
	if winners != 1 || stale != 1 {
		t.Fatalf("winners=%d stale=%d", winners, stale)
	}
	current, _ := s.GetType(ctx, "tenant-a", objectType.ID)
	if current.Version != 2 {
		t.Fatalf("current version=%d", current.Version)
	}
}

func TestMemoryStore_RecordPageReportsTruncation(t *testing.T) {
	s := newTestStore()
	ctx := context.Background()
	objectType, _ := s.CreateType(ctx, "tenant-a", CreateTypeParams{
		Key: "order", Label: "Order", Schema: json.RawMessage(`{}`),
	})
	for _, externalID := range []string{"one", "two", "three"} {
		if _, err := s.UpsertRecord(ctx, "tenant-a", objectType.ID, UpsertRecordParams{
			ExternalID: externalID, Properties: json.RawMessage(`{}`), ExpectedVersion: 0,
		}); err != nil {
			t.Fatal(err)
		}
	}
	page, err := s.ListRecords(ctx, "tenant-a", objectType.ID, ListRecordsFilter{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || page.Limit != 2 || !page.HasMore {
		t.Fatalf("page=%+v", page)
	}
}
