// SPDX-License-Identifier: AGPL-3.0-only
package lists

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type recordingMembershipWebhookFanout struct {
	tenant string
	events []SubscriberAddedMembership
	err    error
}

func (r *recordingMembershipWebhookFanout) FireListSubscriberAddedBatch(
	_ context.Context,
	_ pgx.Tx,
	tenantID string,
	events []SubscriberAddedMembership,
) (int, error) {
	r.tenant = tenantID
	r.events = append(r.events, events...)
	return len(events), r.err
}

func TestFireListSubscriberAddedBatchForwardsPersistedProjection(t *testing.T) {
	recorder := &recordingMembershipWebhookFanout{}
	repo := &Repo{MembershipWebhooks: recorder}
	event := SubscriberAddedMembership{
		SubscriberID: "subscriber-1",
		Email:        "person@example.com",
		ListID:       "list-1",
		Source:       "api",
		AddedAt:      time.Date(2026, 7, 23, 9, 10, 11, 0, time.UTC),
	}
	if err := repo.fireListSubscriberAddedBatch(
		context.Background(), nil, "tenant-1",
		[]SubscriberAddedMembership{event},
	); err != nil {
		t.Fatalf("fire: %v", err)
	}
	if recorder.tenant != "tenant-1" ||
		len(recorder.events) != 1 ||
		recorder.events[0] != event {
		t.Fatalf("fanout received tenant=%q events=%#v", recorder.tenant, recorder.events)
	}
}

func TestFireListSubscriberAddedBatchFailsClosed(t *testing.T) {
	sentinel := errors.New("fanout unavailable")
	repo := &Repo{MembershipWebhooks: &recordingMembershipWebhookFanout{err: sentinel}}
	err := repo.fireListSubscriberAddedBatch(
		context.Background(), nil, "tenant-1",
		[]SubscriberAddedMembership{{
			SubscriberID: "subscriber-1",
			Email:        "person@example.com",
			ListID:       "list-1",
			Source:       "api",
			AddedAt:      time.Now().UTC(),
		}},
	)
	if !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want wrapped %v", err, sentinel)
	}
}

func TestFireListSubscriberAddedBatchNilFanoutIsTestSafe(t *testing.T) {
	if err := (&Repo{}).fireListSubscriberAddedBatch(
		context.Background(), nil, "tenant-1",
		[]SubscriberAddedMembership{{
			SubscriberID: "subscriber-1",
		}},
	); err != nil {
		t.Fatalf("nil optional fanout: %v", err)
	}
}
