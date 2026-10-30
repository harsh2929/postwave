package tenantengine

import (
	"context"
	"database/sql"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"
)

const insertBinding = `INSERT INTO tenant_email_destinations(tenant_id, destination_id, endpoint_hash)
VALUES ($1::uuid, $2::uuid, $3) ON CONFLICT DO NOTHING`
const readBinding = `SELECT destination_id::text, endpoint_hash FROM tenant_email_destinations WHERE tenant_id=$1::uuid`

// VerifySQL pins on first use, then checks the immutable binding on every
// acquisition. UNIQUE constraints prevent different deployments from assigning
// the same instance to two tenants, including simultaneous first acquisitions.
func VerifySQL(ctx context.Context, db *sql.DB, route Route) error {
	if db == nil {
		return errors.New("tenant email destination binding database unavailable")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, route.TenantID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, insertBinding, route.TenantID, route.DestinationID, route.EndpointHash()); err != nil {
		return err
	}
	var id, hash string
	if err = tx.QueryRowContext(ctx, readBinding, route.TenantID).Scan(&id, &hash); err != nil {
		return ErrBindingChanged
	}
	if id != route.DestinationID || hash != route.EndpointHash() {
		return ErrBindingChanged
	}
	return tx.Commit()
}

func VerifyPGX(ctx context.Context, db *pgxpool.Pool, route Route) error {
	if db == nil {
		return errors.New("tenant email destination binding database unavailable")
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, route.TenantID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, insertBinding, route.TenantID, route.DestinationID, route.EndpointHash()); err != nil {
		return err
	}
	var id, hash string
	if err = tx.QueryRow(ctx, readBinding, route.TenantID).Scan(&id, &hash); err != nil {
		return ErrBindingChanged
	}
	if id != route.DestinationID || hash != route.EndpointHash() {
		return ErrBindingChanged
	}
	return tx.Commit(ctx)
}

// CheckLegacy* prevents removal of the registry from silently sending an
// already-routed tenant back to a shared installation after a restart.
func CheckLegacySQL(ctx context.Context, db *sql.DB, tenantID string) error {
	if db == nil || tenantID == "" {
		return nil
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	var exists bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM tenant_email_destinations WHERE tenant_id=$1::uuid)`, tenantID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return ErrBindingChanged
	}
	return nil
}

func CheckLegacyPGX(ctx context.Context, db *pgxpool.Pool, tenantID string) error {
	if db == nil || tenantID == "" {
		return nil
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT set_config('app.tenant_id', $1, true)`, tenantID); err != nil {
		return err
	}
	var exists bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM tenant_email_destinations WHERE tenant_id=$1::uuid)`, tenantID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return ErrBindingChanged
	}
	return nil
}
