// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/postwave/postwave/apps/api/internal/campaignassurancegate"
	"github.com/postwave/postwave/apps/api/internal/campaigndelivery"
	"github.com/postwave/postwave/apps/api/internal/campaignsendruntime"
	"github.com/postwave/postwave/apps/api/internal/campaigntransport"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/mailer"
	"github.com/postwave/postwave/apps/api/internal/replycorrelation"
	"github.com/postwave/postwave/apps/api/internal/uploads"
)

const campaignBoundSendTestLeaseOwner = "f7b555e5-2362-4f62-ad48-7477c81e4ca2"

type compositionReceiptMailer struct{}

func (compositionReceiptMailer) Send(context.Context, mailer.Message) error { return nil }
func (compositionReceiptMailer) SendWithReceipt(context.Context, mailer.Message) (mailer.DeliveryReceipt, error) {
	return mailer.DeliveryReceipt{ProviderMessageID: "provider-receipt"}, nil
}

type compositionReceiptlessMailer struct{}

func (compositionReceiptlessMailer) Send(context.Context, mailer.Message) error { return nil }

func TestCampaignBoundSendRuntimeIsDefaultOffWithoutTouchingDependencies(t *testing.T) {
	verified := false
	composition, err := initializeCampaignBoundSendRuntimeWithDependencies(t.Context(), campaignBoundSendStartupDependencies{
		VerifySchema: func(context.Context, *db.Pool) error {
			verified = true
			return nil
		},
	})
	if err != nil {
		t.Fatalf("disabled runtime returned error: %v", err)
	}
	if composition.enabled() || verified {
		t.Fatalf("disabled runtime enabled=%v verified_schema=%v", composition.enabled(), verified)
	}
}

func TestCampaignBoundSendRuntimeFailsClosedWithoutDurableOrReceiptDependencies(t *testing.T) {
	pool := new(db.Pool)
	objects := uploads.NewMemoryStore()
	gate := &campaignassurancegate.Gate{}
	verify := func(context.Context, *db.Pool) error { return nil }
	newLeaseOwner := func() string { return campaignBoundSendTestLeaseOwner }
	correlation := compositionReplyCorrelation(t)

	tests := []struct {
		name string
		deps campaignBoundSendStartupDependencies
	}{
		{name: "database", deps: campaignBoundSendStartupDependencies{Enabled: true, Objects: objects, Mailer: compositionReceiptMailer{}, Gate: gate, VerifySchema: verify, NewLeaseOwner: newLeaseOwner, ReplyCorrelation: correlation}},
		{name: "objects", deps: campaignBoundSendStartupDependencies{Enabled: true, Pool: pool, Mailer: compositionReceiptMailer{}, Gate: gate, VerifySchema: verify, NewLeaseOwner: newLeaseOwner, ReplyCorrelation: correlation}},
		{name: "mailer", deps: campaignBoundSendStartupDependencies{Enabled: true, Pool: pool, Objects: objects, Gate: gate, VerifySchema: verify, NewLeaseOwner: newLeaseOwner, ReplyCorrelation: correlation}},
		{name: "gate", deps: campaignBoundSendStartupDependencies{Enabled: true, Pool: pool, Objects: objects, Mailer: compositionReceiptMailer{}, VerifySchema: verify, NewLeaseOwner: newLeaseOwner, ReplyCorrelation: correlation}},
		{name: "provider receipt", deps: campaignBoundSendStartupDependencies{Enabled: true, Pool: pool, Objects: objects, Mailer: compositionReceiptlessMailer{}, Gate: gate, VerifySchema: verify, NewLeaseOwner: newLeaseOwner, ReplyCorrelation: correlation}},
		{name: "reply correlation", deps: campaignBoundSendStartupDependencies{Enabled: true, Pool: pool, Objects: objects, Mailer: compositionReceiptMailer{}, Gate: gate, VerifySchema: verify, NewLeaseOwner: newLeaseOwner}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			composition, err := initializeCampaignBoundSendRuntimeWithDependencies(t.Context(), test.deps)
			if err == nil || composition.enabled() {
				t.Fatalf("unsafe dependencies accepted: composition=%+v err=%v", composition, err)
			}
		})
	}
}

func TestCampaignBoundSendRuntimeWiresExactProductionBoundary(t *testing.T) {
	pool := new(db.Pool)
	objects := uploads.NewMemoryStore()
	provider := compositionReceiptMailer{}
	sharedGate := &campaignassurancegate.Gate{}
	verified := false
	composition, err := initializeCampaignBoundSendRuntimeWithDependencies(t.Context(), campaignBoundSendStartupDependencies{
		Enabled: true,
		Pool:    pool,
		Objects: objects,
		Mailer:  provider,
		Gate:    sharedGate,
		VerifySchema: func(_ context.Context, got *db.Pool) error {
			verified = true
			if got != pool {
				t.Fatal("schema verifier received a different pool")
			}
			return nil
		},
		NewLeaseOwner:    func() string { return campaignBoundSendTestLeaseOwner },
		ReplyCorrelation: compositionReplyCorrelation(t),
	})
	if err != nil {
		t.Fatalf("initialize runtime: %v", err)
	}
	if !verified || !composition.enabled() || composition.LeaseOwner != campaignBoundSendTestLeaseOwner || composition.Transport != campaignBoundSendTransportName {
		t.Fatalf("incomplete composition: %+v verified=%v", composition, verified)
	}
	runtime, ok := composition.Dispatcher.(*campaignsendruntime.Runtime)
	if !ok {
		t.Fatalf("dispatcher type = %T", composition.Dispatcher)
	}
	if runtime.Objects != objects {
		t.Fatal("runtime did not receive the shared warehouse object store")
	}
	if runtime.Gate != sharedGate {
		t.Fatalf("runtime gate = %T/%p, want shared gate %p", runtime.Gate, runtime.Gate, sharedGate)
	}
	resolver, ok := runtime.Recipients.(*campaignsendruntime.PostgresRecipientResolver)
	if !ok || resolver.Pool != pool {
		t.Fatalf("recipient resolver = %#v", runtime.Recipients)
	}
	coordinator, ok := runtime.Delivery.(*campaigndelivery.Coordinator)
	if !ok {
		t.Fatalf("delivery coordinator type = %T", runtime.Delivery)
	}
	if coordinator.TransportName != campaignBoundSendTransportName || coordinator.LeaseOwner != campaignBoundSendTestLeaseOwner ||
		coordinator.LeaseDuration != campaignBoundSendLeaseTTL || coordinator.AllowReceiptlessTransport {
		t.Fatalf("unsafe coordinator configuration: %+v", coordinator)
	}
	transport, ok := coordinator.Transport.(campaigntransport.RawMailerTransport)
	if !ok {
		t.Fatalf("transport type = %T", coordinator.Transport)
	}
	capabilities := transport.Capabilities()
	if !capabilities.RawMIME || !capabilities.ProviderReceipt || capabilities.ProviderIdempotency || capabilities.DedicatedMessenger {
		t.Fatalf("unexpected transport capability contract: %+v", capabilities)
	}
}

func TestCampaignBoundSendRuntimePropagatesSchemaReadinessFailure(t *testing.T) {
	want := errors.New("migration 1924 absent")
	composition, err := initializeCampaignBoundSendRuntimeWithDependencies(t.Context(), campaignBoundSendStartupDependencies{
		Enabled:          true,
		Pool:             new(db.Pool),
		Objects:          uploads.NewMemoryStore(),
		Mailer:           compositionReceiptMailer{},
		Gate:             &campaignassurancegate.Gate{},
		VerifySchema:     func(context.Context, *db.Pool) error { return want },
		NewLeaseOwner:    func() string { return campaignBoundSendTestLeaseOwner },
		ReplyCorrelation: compositionReplyCorrelation(t),
	})
	if !errors.Is(err, want) || composition.enabled() {
		t.Fatalf("schema failure composition=%+v err=%v", composition, err)
	}
}

func compositionReplyCorrelation(t *testing.T) *replycorrelation.Service {
	t.Helper()
	now := time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC)
	service, err := replycorrelation.NewService("reply.example.test", replycorrelation.DefaultTTL, []replycorrelation.Key{{
		ID: "k1", Secret: []byte(strings.Repeat("s", 32)),
		NotBefore: now.Add(-24 * time.Hour), NotAfter: now.Add(365 * 24 * time.Hour),
	}}, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func TestCampaignSendWorkersStartAfterAllLateBoundDependencies(t *testing.T) {
	root := readAPICompositionRoot(t)
	text := root.run
	const loopStart = "sendGuard.Loop(outboxCtx)"
	if inRun, inRoot := strings.Count(text, loopStart), strings.Count(root.all, loopStart); inRun != 1 || inRoot != 1 {
		t.Fatalf("send-guard loop starts = %d in run() and %d in the composition root, want one, in run()",
			inRun, inRoot)
	}
	workerStart := strings.Index(text, loopStart)
	// The loop reads every late-bound field as it runs. One assigned after it
	// starts races the loop and leaves a window where the loop runs without it;
	// for RequireAssuranceBinding, that window lets an unbound recipient row
	// escape to Listmonk in block rollout instead of being withheld.
	for _, assignment := range []string{
		"sendGuard.AssuranceBound = campaignBoundSend.Dispatcher",
		"sendGuard.RequireAssuranceBinding = campaignAssuranceGateConvergence.blocksDispatch()",
		"sendGuard.SendCompleteNotifier =",
	} {
		at := strings.Index(text, assignment)
		if at < 0 {
			t.Fatalf("run() no longer composes %q before the send worker starts", assignment)
		}
		if at > workerStart {
			t.Fatalf("send worker starts before immutable composition: %q at %d, worker at %d",
				assignment, at, workerStart)
		}
	}
}

// compositionTestDatabaseURL returns the database a composition readiness
// proof reads: the one the dedicated variable names, or else TEST_DATABASE_URL,
// which CI sets to the application role on a database migrated to head. The
// proofs only read the catalog and the schema, so the shared database serves.
// Requiring the dedicated variable alone skipped them in every CI run.
func compositionTestDatabaseURL(t *testing.T, dedicated string) string {
	t.Helper()
	for _, name := range []string{dedicated, "TEST_DATABASE_URL"} {
		if url := strings.TrimSpace(os.Getenv(name)); url != "" {
			return url
		}
	}
	t.Skipf("neither %s nor TEST_DATABASE_URL is set; this composition proof needs a database migrated to head",
		dedicated)
	return ""
}

func TestCampaignBoundSendSchemaReadiness_DB(t *testing.T) {
	url := compositionTestDatabaseURL(t, "POSTWAVE_CAMPAIGN_DELIVERY_TEST_DATABASE_URL")
	pool, err := pgxpool.New(t.Context(), url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if err := verifyCampaignBoundSendSchema(t.Context(), pool); err != nil {
		t.Fatalf("campaign bound send schema readiness: %v", err)
	}
}
