package reportstore

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

type retentionStoreFake struct {
	mu              sync.Mutex
	candidates      []SeedObservationObject
	listErr         error
	recordErr       error
	alreadyRecorded bool
	records         []SeedObservationDeletionRecord
	recordedObjects []SeedObservationObject
}

func (f *retentionStoreFake) ListExpiredSeedObservationObjects(_ context.Context, _ time.Time, _ int) ([]SeedObservationObject, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]SeedObservationObject(nil), f.candidates...), f.listErr
}

func (f *retentionStoreFake) RecordSeedObservationObjectDeletion(_ context.Context, object SeedObservationObject, record SeedObservationDeletionRecord) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.recordedObjects = append(f.recordedObjects, object)
	f.records = append(f.records, record)
	return f.alreadyRecorded, f.recordErr
}

type retentionObjectStoreFake struct {
	mu        sync.Mutex
	deleted   []ObjectReceipt
	deleteErr map[string]error
}

func (f *retentionObjectStoreFake) PutRawMIME(context.Context, RawMIMEObject) (ObjectReceipt, error) {
	return ObjectReceipt{}, errors.New("unexpected put")
}

func (f *retentionObjectStoreFake) DeleteRawMIME(_ context.Context, receipt ObjectReceipt) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted = append(f.deleted, receipt)
	return f.deleteErr[receipt.VersionID]
}

func TestSeedObservationRetentionDeletesExactVersionAndRecordsNonSecretReceipt(t *testing.T) {
	now := time.Date(2026, time.August, 9, 18, 30, 0, 0, time.UTC)
	object := SeedObservationObject{
		TenantID:      "30f5418d-d4fe-436c-ad96-e0e82755aaf2",
		ObservationID: "c07c6daf-eabb-4934-8cd6-3ecb46652008",
		ObjectKind:    "received_mime",
		ObjectRef:     "s3://private/seed/v1/private-path?versionId=private-version",
		ObjectVersion: "private-version",
		ExpiresAt:     now.Add(-time.Second),
	}
	store := &retentionStoreFake{candidates: []SeedObservationObject{object}}
	objects := &retentionObjectStoreFake{}
	sweeper := &SeedObservationRetentionSweeper{Store: store, Objects: objects, Now: func() time.Time { return now }}

	result, err := sweeper.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result != (SeedObservationRetentionResult{Scanned: 1, Deleted: 1}) {
		t.Fatalf("result = %#v", result)
	}
	if len(objects.deleted) != 1 || objects.deleted[0].ObjectRef != object.ObjectRef || objects.deleted[0].VersionID != object.ObjectVersion {
		t.Fatalf("exact deletion receipt = %#v", objects.deleted)
	}
	if len(store.records) != 1 {
		t.Fatalf("records = %#v", store.records)
	}
	record := store.records[0]
	if record.ObjectRefSHA256 != digestString(object.ObjectRef) || record.DeletedAt != now {
		t.Fatalf("record = %#v", record)
	}
	serialized := strings.Join([]string{
		record.Receipt["schema"].(string), record.Receipt["store"].(string),
		record.Receipt["result"].(string), record.Receipt["object_version_sha256"].(string),
	}, " ")
	if strings.Contains(serialized, object.ObjectRef) || strings.Contains(serialized, object.ObjectVersion) {
		t.Fatalf("deletion receipt leaked private object identity: %s", serialized)
	}
}

func TestSeedObservationRetentionContinuesAfterDeleteFailureAndDoesNotWriteFalseReceipt(t *testing.T) {
	now := time.Date(2026, time.August, 9, 18, 30, 0, 0, time.UTC)
	failed := SeedObservationObject{
		TenantID: "30f5418d-d4fe-436c-ad96-e0e82755aaf2", ObservationID: "c07c6daf-eabb-4934-8cd6-3ecb46652008",
		ObjectKind: "received_mime", ObjectRef: "s3://private/failed", ObjectVersion: "failed", ExpiresAt: now.Add(-time.Hour),
	}
	succeeded := failed
	succeeded.ObservationID = "c850fcaf-cea3-41c0-8f19-fb468a5bb601"
	succeeded.ObjectRef = "s3://private/succeeded"
	succeeded.ObjectVersion = "succeeded"
	store := &retentionStoreFake{candidates: []SeedObservationObject{failed, succeeded}}
	objects := &retentionObjectStoreFake{deleteErr: map[string]error{"failed": errors.New("private backend detail")}}
	sweeper := &SeedObservationRetentionSweeper{Store: store, Objects: objects, Now: func() time.Time { return now }}

	result, err := sweeper.RunOnce(context.Background())
	if err == nil || strings.Contains(err.Error(), "private backend detail") || strings.Contains(err.Error(), failed.ObjectRef) {
		t.Fatalf("expected sanitized aggregate failure, got %v", err)
	}
	if result.Scanned != 2 || result.Deleted != 1 || result.Failed != 1 || len(store.records) != 1 {
		t.Fatalf("result=%#v records=%d", result, len(store.records))
	}
	if store.recordedObjects[0].ObservationID != succeeded.ObservationID {
		t.Fatalf("false deletion receipt recorded for failed object: %#v", store.recordedObjects)
	}
}

func TestSeedObservationRetentionReportsConcurrentReceiptWithoutDoubleCounting(t *testing.T) {
	now := time.Date(2026, time.August, 9, 18, 30, 0, 0, time.UTC)
	store := &retentionStoreFake{
		alreadyRecorded: true,
		candidates: []SeedObservationObject{{
			TenantID: "30f5418d-d4fe-436c-ad96-e0e82755aaf2", ObservationID: "c07c6daf-eabb-4934-8cd6-3ecb46652008",
			ObjectKind: "received_mime", ObjectRef: "s3://private/object", ObjectVersion: "version", ExpiresAt: now,
		}},
	}
	result, err := (&SeedObservationRetentionSweeper{
		Store: store, Objects: &retentionObjectStoreFake{}, Now: func() time.Time { return now },
	}).RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Deleted != 0 || result.AlreadyRecorded != 1 || result.Failed != 0 {
		t.Fatalf("result = %#v", result)
	}
}
