// SPDX-License-Identifier: AGPL-3.0-only

package campaignassurancequeue

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/campaignassuranceapi"
	"github.com/postwave/postwave/apps/api/internal/campaignassuranceworker"
)

func TestCommandNormalizationCanonicalizesEveryIdentity(t *testing.T) {
	t.Parallel()
	tenantID := uuid.NewString()
	campaignID := uuid.NewString()
	runID := uuid.NewString()
	requestID := uuid.NewString()
	dispatch, err := normalizeDispatch(campaignassuranceapi.DispatchCommand{
		TenantID: "  " + tenantID + "  ", CampaignID: campaignID,
		RunID: runID, RequestID: requestID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if dispatch.TenantID != tenantID || dispatch.CampaignID != campaignID ||
		dispatch.RunID != runID || dispatch.RequestID != requestID {
		t.Fatalf("dispatch = %+v", dispatch)
	}
	deliveryID := uuid.NewString()
	worker, err := normalizeWorkerCommand(campaignassuranceworker.Command{
		DeliveryID: deliveryID, TenantID: tenantID, RunID: runID,
	})
	if err != nil || worker.DeliveryID != deliveryID || worker.TenantID != tenantID || worker.RunID != runID {
		t.Fatalf("worker=%+v err=%v", worker, err)
	}
}

func TestCommandNormalizationRejectsPartialOrNonUUIDIdentity(t *testing.T) {
	t.Parallel()
	valid := uuid.NewString()
	for _, input := range []campaignassuranceapi.DispatchCommand{
		{CampaignID: valid, RunID: valid, RequestID: valid},
		{TenantID: valid, CampaignID: "campaign", RunID: valid, RequestID: valid},
		{TenantID: valid, CampaignID: valid, RunID: "run", RequestID: valid},
		{TenantID: valid, CampaignID: valid, RunID: valid, RequestID: "request"},
	} {
		if _, err := normalizeDispatch(input); !errors.Is(err, ErrInvalidCommand) {
			t.Fatalf("normalizeDispatch(%+v) err=%v", input, err)
		}
	}
	if _, err := normalizeWorkerCommand(campaignassuranceworker.Command{
		DeliveryID: "delivery", TenantID: valid, RunID: valid,
	}); !errors.Is(err, ErrInvalidCommand) {
		t.Fatalf("normalizeWorkerCommand err=%v", err)
	}
}

func TestQueueConfigurationIsBoundedAndDefaulted(t *testing.T) {
	t.Parallel()
	// A nil pool remains invalid even with a canonical owner.
	queue := New(nil, uuid.NewString())
	if _, err := queue.normalized(); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("nil pool err=%v", err)
	}
	// Validate the duration bounds without manufacturing a live database pool.
	queue = &Queue{Pool: &pgxpool.Pool{}, OwnerID: uuid.NewString(), LeaseTTL: 500 * time.Millisecond}
	if _, err := queue.normalized(); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("short lease err=%v", err)
	}
	queue = &Queue{Pool: &pgxpool.Pool{}, OwnerID: uuid.NewString(), LeaseTTL: time.Minute, PollInterval: time.Millisecond}
	if _, err := queue.normalized(); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("short poll err=%v", err)
	}
	queue = &Queue{Pool: &pgxpool.Pool{}, OwnerID: uuid.NewString(), LeaseTTL: 25 * time.Hour}
	if _, err := queue.normalized(); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("long lease err=%v", err)
	}
	queue = &Queue{Pool: &pgxpool.Pool{}, OwnerID: uuid.NewString(), PollInterval: 2 * time.Minute}
	if _, err := queue.normalized(); !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("long poll err=%v", err)
	}
	queue = &Queue{Pool: &pgxpool.Pool{}, OwnerID: uuid.NewString()}
	normalized, err := queue.normalized()
	if err != nil {
		t.Fatalf("defaults err=%v", err)
	}
	if normalized.leaseTTL != defaultLeaseTTL || normalized.pollInterval != defaultPollInterval {
		t.Fatalf("defaults lease=%v poll=%v", normalized.leaseTTL, normalized.pollInterval)
	}
}

func TestReceiveCancellationDoesNotSpinWithoutConfiguration(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := (&Queue{}).Receive(ctx)
	if !errors.Is(err, ErrInvalidConfiguration) {
		t.Fatalf("err=%v", err)
	}
}
