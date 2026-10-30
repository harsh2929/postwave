// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/inboxreality"
	"github.com/postwave/postwave/apps/api/internal/uploads"
	"github.com/postwave/postwave/packages/runtime/internalsign"
)

type inboxRealityGatewayDependencies struct {
	Enabled           bool
	Pool              *db.Pool
	Objects           uploads.Store
	DeliverabilityURL string
	BearerToken       string
	SigningSecrets    string
	Seeds             inboxreality.SeedRegistry
	Quota             inboxreality.QuotaMeter
	Production        bool
	Logger            *slog.Logger
	NewOwnerID        func() string
}

type inboxRealityGatewayRuntime struct {
	Deps    *inboxreality.Deps
	Worker  *inboxreality.DispatchWorker
	enabled bool
}

func (r inboxRealityGatewayRuntime) Enabled() bool { return r.enabled }

func (r inboxRealityGatewayRuntime) Run(ctx context.Context) error {
	if !r.enabled || r.Worker == nil {
		return nil
	}
	return r.Worker.Run(ctx)
}

// initializeInboxRealityGatewayRuntime composes, but does not start, the
// gateway half of the lifecycle. Explicit enablement fails closed unless the
// full schema, exact-artifact object reader, bearer auth, body-signing key, and
// deliverability endpoint are simultaneously ready.
func initializeInboxRealityGatewayRuntime(
	ctx context.Context,
	dependencies inboxRealityGatewayDependencies,
) (inboxRealityGatewayRuntime, error) {
	if dependencies.Pool == nil {
		return inboxRealityGatewayRuntime{}, errors.New("Inbox Reality requires a database pool")
	}
	store, err := inboxreality.NewPostgresStore(dependencies.Pool)
	if err != nil {
		return inboxRealityGatewayRuntime{}, err
	}
	seeds := dependencies.Seeds
	if seeds == nil {
		// Prefer the live catalog whenever the trust boundary to the
		// deliverability service is fully configured. This is deliberately not
		// gated on dependencies.Enabled: manual seed tests predate the
		// exact-artifact lifecycle and only need the seed addresses, so a
		// deployment running with that lifecycle off should still get real
		// mailboxes rather than the empty fallback.
		// Signing needs the PRIMARY secret specifically. SigningSecrets is a
		// comma-separated set so the service can verify against a rotating
		// window; signing with the whole list produces a signature the service
		// cannot reproduce.
		primary, primaryErr := internalsign.PrimarySecret(dependencies.SigningSecrets)
		live := &inboxreality.HTTPSeedRegistry{
			BaseURL:       dependencies.DeliverabilityURL,
			BearerToken:   dependencies.BearerToken,
			SigningSecret: primary,
		}
		if primaryErr == nil && live.Validate() == nil {
			seeds = live
		} else {
			// Catalog visibility remains available, but manual creation fails
			// closed because this registry intentionally contains no addresses.
			seeds = inboxreality.StaticSeedRegistry{}
		}
	}
	orchestrator := inboxreality.NewOrchestrator(store, seeds)
	deps := &inboxreality.Deps{
		Orchestrator: orchestrator, Store: store, Seeds: seeds,
		ActiveSeedCount: 0, Logger: dependencies.Logger, Quota: dependencies.Quota,
	}
	runtime := inboxRealityGatewayRuntime{Deps: deps}
	if !dependencies.Enabled {
		// NewPostgresStore implements LifecycleStore; clear its auto-discovered
		// exact path so a disabled process cannot mint commands it will not drain.
		orchestrator.Lifecycle = nil
		return runtime, nil
	}
	if dependencies.Objects == nil || strings.TrimSpace(dependencies.DeliverabilityURL) == "" ||
		strings.TrimSpace(dependencies.BearerToken) == "" || strings.TrimSpace(dependencies.SigningSecrets) == "" {
		return inboxRealityGatewayRuntime{}, errors.New("enabled Inbox Reality requires object storage, deliverability URL, bearer token, and signing secrets")
	}
	if err := verifyInboxRealityGatewaySchema(ctx, dependencies.Pool); err != nil {
		return inboxRealityGatewayRuntime{}, err
	}
	lifecycle, ok := store.(inboxreality.LifecycleStore)
	if !ok {
		return inboxRealityGatewayRuntime{}, errors.New("Inbox Reality store does not implement the durable lifecycle")
	}
	primarySecret, err := internalsign.PrimarySecret(dependencies.SigningSecrets)
	if err != nil {
		return inboxRealityGatewayRuntime{}, err
	}
	client := &inboxreality.DeliverabilityClient{
		BaseURL: dependencies.DeliverabilityURL, BearerToken: dependencies.BearerToken,
		SigningSecret: primarySecret,
	}
	if err := client.Validate(); err != nil {
		return inboxRealityGatewayRuntime{}, err
	}
	if err := verifyInboxRealityProductionCapacity(ctx, dependencies.Enabled, dependencies.Production, seeds); err != nil {
		return inboxRealityGatewayRuntime{}, err
	}
	newOwnerID := dependencies.NewOwnerID
	if newOwnerID == nil {
		newOwnerID = uuid.NewString
	}
	ownerID := strings.TrimSpace(newOwnerID())
	if _, err := uuid.Parse(ownerID); err != nil {
		return inboxRealityGatewayRuntime{}, errors.New("Inbox Reality dispatch owner must be a UUID")
	}
	deps.InternalSigningSecrets = dependencies.SigningSecrets
	runtime.Worker = &inboxreality.DispatchWorker{
		Lifecycle: lifecycle, Tests: store, Objects: dependencies.Objects, Executor: client,
		OwnerID: ownerID, LeaseTTL: 2 * time.Minute, PollEvery: 2 * time.Second,
		Logger: dependencies.Logger,
	}
	runtime.enabled = true
	return runtime, nil
}

type productionSeedlistCapacityVerifier interface {
	VerifyProductionCapacity(context.Context) error
}

// verifyInboxRealityProductionCapacity keeps a small fixture useful in local
// development while making the controlled-mailbox target a real production
// release gate. A custom/static registry cannot silently bypass the check: it
// must expose the same signed-live-capacity verifier as HTTPSeedRegistry.
func verifyInboxRealityProductionCapacity(
	ctx context.Context,
	enabled bool,
	production bool,
	seeds inboxreality.SeedRegistry,
) error {
	if !enabled || !production {
		return nil
	}
	verifier, ok := seeds.(productionSeedlistCapacityVerifier)
	if !ok {
		return errors.New("enabled production Inbox Reality requires a verifiable live seed registry")
	}
	checkCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := verifier.VerifyProductionCapacity(checkCtx); err != nil {
		return fmt.Errorf("Inbox Reality production seedlist capacity: %w", err)
	}
	return nil
}

func verifyInboxRealityGatewaySchema(ctx context.Context, pool *db.Pool) error {
	readinessCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var ready bool
	err := pool.QueryRow(readinessCtx, `
SELECT
    to_regclass('public.inbox_reality_dispatch_commands') IS NOT NULL
    AND to_regclass('public.inbox_reality_seed_dispatches') IS NOT NULL
    AND has_table_privilege(current_user, 'inbox_reality_dispatch_commands', 'SELECT,INSERT,UPDATE')
    AND has_table_privilege(current_user, 'inbox_reality_seed_dispatches', 'SELECT,INSERT,UPDATE')
    AND EXISTS (
        SELECT 1 FROM pg_policies
         WHERE schemaname='public' AND tablename='inbox_reality_dispatch_commands'
           AND policyname='inbox_reality_dispatch_commands_worker_update'
    )
    AND EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgrelid='inbox_reality_dispatch_commands'::regclass
           AND tgname='inbox_reality_dispatch_command_guard' AND NOT tgisinternal
    )`).Scan(&ready)
	if err != nil {
		return fmt.Errorf("Inbox Reality gateway schema readiness: %w", err)
	}
	if !ready {
		return errors.New("Inbox Reality gateway schema, privileges, or lifecycle guards are unavailable")
	}
	return nil
}
