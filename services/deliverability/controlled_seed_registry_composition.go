package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/postwave/postwave/services/deliverability/internal/seedlist"
)

type controlledSeedRegistryDependencies struct {
	Enabled   bool
	Pool      *pgxpool.Pool
	Registry  *seedlist.Registry
	Connector seedlist.Connector
}

// initializeControlledSeedRegistry publishes and binds the exact declarative
// snapshot before the poller or Inbox Reality dispatcher takes its first
// snapshot. It intentionally does not construct another registry authority.
func initializeControlledSeedRegistry(
	ctx context.Context,
	dependencies controlledSeedRegistryDependencies,
) error {
	if !dependencies.Enabled {
		return nil
	}
	if dependencies.Pool == nil || dependencies.Registry == nil || dependencies.Connector == nil {
		return errors.New("controlled seed registry: dependencies are incomplete")
	}
	if err := verifyControlledSeedRegistrySchema(ctx, dependencies.Pool); err != nil {
		return err
	}
	ledger := seedlist.NewPostgresRegistryLedger(dependencies.Pool)
	if _, err := ledger.PublishSnapshot(
		ctx, dependencies.Registry, seedlist.CapabilitiesOf(dependencies.Connector),
	); err != nil {
		return fmt.Errorf("controlled seed registry: publish startup snapshot: %w", err)
	}
	return nil
}

func verifyControlledSeedRegistrySchema(ctx context.Context, pool *pgxpool.Pool) error {
	var (
		tablePresent bool
		canSelect    bool
		canInsert    bool
	)
	err := pool.QueryRow(ctx, `
SELECT to_regclass('public.controlled_seed_registry_versions') IS NOT NULL,
       has_table_privilege(current_user, 'public.controlled_seed_registry_versions', 'SELECT'),
       has_table_privilege(current_user, 'public.controlled_seed_registry_versions', 'INSERT')`).
		Scan(&tablePresent, &canSelect, &canInsert)
	if err != nil {
		return fmt.Errorf("controlled seed registry: verify schema: %w", err)
	}
	if !tablePresent || !canSelect || !canInsert {
		return errors.New("controlled seed registry: migration 1930 or required privileges are unavailable")
	}
	return nil
}
