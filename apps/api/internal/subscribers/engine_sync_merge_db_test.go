// SPDX-License-Identifier: AGPL-3.0-only

package subscribers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/listmonk"
	"github.com/postwave/postwave/apps/api/internal/outbox"
)

func TestListmonkSyncHandlerMergeDeletesDuplicateBeforeSurvivorReconcileAndRetriesIdempotently(t *testing.T) {
	repo, _, tenantID := newWritePathTestRepo(t)
	ctx := context.Background()
	primaryEmail := "engine-merge-primary-" + uuid.NewString() + "@example.test"
	duplicateEmail := "engine-merge-duplicate-" + uuid.NewString() + "@example.test"
	primary, err := repo.Upsert(ctx, tenantID, writePathCreate(primaryEmail, nil))
	if err != nil {
		t.Fatalf("seed merge survivor: %v", err)
	}

	const (
		survivorListmonkID  int64 = 701
		duplicateListmonkID int64 = 702
	)
	baseEngine := newSubscriberSyncFakeEngine()
	baseEngine.seed(survivorListmonkID, primaryEmail, StatusEnabled)
	baseEngine.seed(duplicateListmonkID, duplicateEmail, StatusEnabled)
	engine := &orderedMergeSyncEngine{delegate: baseEngine, failNextUpdate: true}
	handler := tenantScopedTestSyncHandler(repo, tenantID, engine)
	event := mergeSyncEvent(t, tenantID, listmonkSyncPayload{
		SubscriberID:              primary.ID,
		MergedDuplicateEmail:      duplicateEmail,
		MergedDuplicateListmonkID: duplicateListmonkID,
	})

	if err := handler.Handle(ctx, event); err == nil || err.Error() != "subscriber engine sync could not update external state" {
		t.Fatalf("first merge reconciliation error = %v; want injected survivor reconciliation failure", err)
	}
	wantFirstOperations := []string{
		fmt.Sprintf("delete:%d", duplicateListmonkID),
		"find:" + primaryEmail,
		fmt.Sprintf("update:%d", survivorListmonkID),
	}
	if got := engine.operationLog(); !reflect.DeepEqual(got, wantFirstOperations) {
		t.Fatalf("first merge reconciliation operations = %#v; want duplicate deletion before survivor reconciliation %#v", got, wantFirstOperations)
	}
	if duplicate := baseEngine.byID(duplicateListmonkID); duplicate != nil {
		t.Fatalf("duplicate external identity survived merge reconciliation: %#v", duplicate)
	}
	unmarked, err := repo.Get(ctx, tenantID, primary.ID)
	if err != nil {
		t.Fatalf("read survivor after failed reconciliation: %v", err)
	}
	if got := listmonkIDFromCustomFields(unmarked.CustomFields); got != 0 {
		t.Fatalf("failed reconciliation persisted survivor external id %d; want transaction rollback", got)
	}

	firstOperationCount := len(wantFirstOperations)
	if err := handler.Handle(ctx, event); err != nil {
		t.Fatalf("retry merge reconciliation: %v", err)
	}
	wantRetryOperations := []string{
		fmt.Sprintf("delete:%d", duplicateListmonkID),
		"find:" + primaryEmail,
		fmt.Sprintf("update:%d", survivorListmonkID),
	}
	operations := engine.operationLog()
	if len(operations) < firstOperationCount {
		t.Fatalf("retry operation log truncated: %#v", operations)
	}
	if got := operations[firstOperationCount:]; !reflect.DeepEqual(got, wantRetryOperations) {
		t.Fatalf("retry merge reconciliation operations = %#v; want idempotent not-found cleanup then survivor update %#v", got, wantRetryOperations)
	}
	if duplicate := baseEngine.byID(duplicateListmonkID); duplicate != nil {
		t.Fatalf("retry resurrected duplicate external identity: %#v", duplicate)
	}
	if survivor := baseEngine.byID(survivorListmonkID); survivor == nil || survivor.Email != primaryEmail {
		t.Fatalf("retry lost or duplicated survivor external identity: %#v", survivor)
	}
	marked, err := repo.Get(ctx, tenantID, primary.ID)
	if err != nil {
		t.Fatalf("read persisted survivor marker: %v", err)
	}
	if got := listmonkIDFromCustomFields(marked.CustomFields); got != survivorListmonkID {
		t.Fatalf("persisted survivor external id = %d; want %d", got, survivorListmonkID)
	}
	if baseEngine.createCalls != 0 || baseEngine.deleteCalls != 2 || baseEngine.updateCalls != 1 {
		t.Fatalf("recovery retry calls create/delete/update = %d/%d/%d; want 0/2/1", baseEngine.createCalls, baseEngine.deleteCalls, baseEngine.updateCalls)
	}

	retryOperationCount := len(operations)
	if err := handler.Handle(ctx, event); err != nil {
		t.Fatalf("duplicate successful delivery: %v", err)
	}
	wantDuplicateDeliveryOperations := []string{
		fmt.Sprintf("delete:%d", duplicateListmonkID),
		fmt.Sprintf("update:%d", survivorListmonkID),
	}
	operations = engine.operationLog()
	if got := operations[retryOperationCount:]; !reflect.DeepEqual(got, wantDuplicateDeliveryOperations) {
		t.Fatalf("duplicate successful delivery operations = %#v; want marker-based idempotent reconciliation %#v", got, wantDuplicateDeliveryOperations)
	}
	if baseEngine.createCalls != 0 || baseEngine.deleteCalls != 3 || baseEngine.updateCalls != 2 {
		t.Fatalf("duplicate delivery calls create/delete/update = %d/%d/%d; want 0/3/2", baseEngine.createCalls, baseEngine.deleteCalls, baseEngine.updateCalls)
	}
}

func mergeSyncEvent(t *testing.T, tenantID string, payload listmonkSyncPayload) outbox.Event {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal merge sync event: %v", err)
	}
	return outbox.Event{
		ID:       uuid.NewString(),
		TenantID: tenantID,
		Kind:     OutboxKindListmonkSync,
		Payload:  raw,
	}
}

type orderedMergeSyncEngine struct {
	delegate *subscriberSyncFakeEngine

	mu         sync.Mutex
	operations []string
	// failNextUpdate models the durable-worker crash window after duplicate
	// cleanup has escaped to Listmonk but before survivor reconciliation and
	// the local marker transaction have completed.
	failNextUpdate bool
}

func (e *orderedMergeSyncEngine) CreateSubscriber(ctx context.Context, req listmonk.CreateSubscriberReq) (*listmonk.Subscriber, error) {
	e.record("create:" + req.Email)
	return e.delegate.CreateSubscriber(ctx, req)
}

func (e *orderedMergeSyncEngine) UpdateSubscriberStatus(ctx context.Context, id int64, req listmonk.UpdateSubscriberStatusReq) error {
	e.mu.Lock()
	e.operations = append(e.operations, fmt.Sprintf("update:%d", id))
	fail := e.failNextUpdate
	e.failNextUpdate = false
	e.mu.Unlock()
	if fail {
		return errors.New("injected survivor reconciliation failure")
	}
	return e.delegate.UpdateSubscriberStatus(ctx, id, req)
}

func (e *orderedMergeSyncEngine) FindSubscriberByEmail(ctx context.Context, email string) (*listmonk.Subscriber, error) {
	e.record("find:" + email)
	return e.delegate.FindSubscriberByEmail(ctx, email)
}

func (e *orderedMergeSyncEngine) DeleteSubscriber(ctx context.Context, id int64) error {
	e.record(fmt.Sprintf("delete:%d", id))
	return e.delegate.DeleteSubscriber(ctx, id)
}

func (e *orderedMergeSyncEngine) record(operation string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.operations = append(e.operations, operation)
}

func (e *orderedMergeSyncEngine) operationLog() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]string(nil), e.operations...)
}
