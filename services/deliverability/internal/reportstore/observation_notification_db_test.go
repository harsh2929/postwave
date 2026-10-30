// SPDX-License-Identifier: AGPL-3.0-only

package reportstore

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/postwave/postwave/packages/runtime/inboxrealitycontract"
	"github.com/postwave/postwave/services/deliverability/internal/domain"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist"
)

type observationNotifierFake struct {
	mu        sync.Mutex
	receipts  []inboxrealitycontract.ObservationReceipt
	failCount int
}

func (f *observationNotifierFake) NotifyObservation(_ context.Context, receipt inboxrealitycontract.ObservationReceipt) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.receipts = append(f.receipts, receipt)
	if f.failCount > 0 {
		f.failCount--
		return errors.New("gateway unavailable")
	}
	return nil
}

func (f *observationNotifierFake) snapshot() []inboxrealitycontract.ObservationReceipt {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]inboxrealitycontract.ObservationReceipt(nil), f.receipts...)
}

func TestGatewayObservationNotificationRetriesAfterDurableCommitDB(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool := seedObservationDBPool(t, ctx)
	fixture := createSeedObservationFixture(t, ctx, pool)
	notifier := &observationNotifierFake{failCount: 1}
	now := time.Now().UTC().Truncate(time.Microsecond)
	store := NewPostgresStore(pool, "")
	store.Now = func() time.Time { return now }
	store.ObservationNotifier = notifier
	observation := seedlist.MessageObservation{
		TestHeaderValue: "irt_" + fixture.token,
		Provider:        domain.ProviderGmail, MailboxID: "gmail-notification-01",
		Folder: "INBOX", Labels: []string{"INBOX"}, Placement: domain.PlacementPrimary,
		Capabilities: seedlist.ConnectorCapabilities{
			Headers: seedlist.CapabilityAvailable, RawMIME: seedlist.CapabilityUnavailable,
			BodyParts: seedlist.CapabilityUnavailable, Placement: seedlist.CapabilityAvailable,
			ObservedSurface: seedlist.CapabilityUnavailable,
		},
		UID: 55, UIDValidity: 66, CheckedAt: now.Add(-time.Second),
		HealthState: seedlist.StatusActive,
	}
	if err := store.WriteMessageObservation(ctx, observation); err == nil {
		t.Fatal("first post-commit callback failure must propagate")
	}
	firstCallbackAt := notifier.snapshot()[0].CapturedAt
	var rows int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM seed_message_observations
WHERE tenant_id=$1::uuid AND test_id=$2::uuid AND mailbox_id=$3`,
		fixture.tenantID, fixture.testID, observation.MailboxID).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("durable observation rows=%d, want 1 despite callback failure", rows)
	}
	now = now.Add(5 * time.Minute)
	if err := store.WriteMessageObservation(ctx, observation); err != nil {
		t.Fatalf("idempotent callback retry: %v", err)
	}
	receipts := notifier.snapshot()
	if len(receipts) != 2 {
		t.Fatalf("callback attempts=%d, want 2", len(receipts))
	}
	for _, receipt := range receipts {
		if receipt.TenantID != fixture.tenantID || receipt.TestID != fixture.testID ||
			receipt.ArtifactID != fixture.artifactID || receipt.ScenarioID != "base" ||
			receipt.MailboxID != observation.MailboxID || receipt.Provider != "gmail" ||
			receipt.Placement != "primary" || receipt.RawMIMEStatus != "unavailable" ||
			receipt.ObservationKey == "" {
			t.Fatalf("unsafe or incomplete callback receipt: %+v", receipt)
		}
		if !receipt.CapturedAt.Equal(firstCallbackAt) {
			t.Fatalf("callback captured_at=%s, want durable value %s", receipt.CapturedAt, firstCallbackAt)
		}
	}
}
