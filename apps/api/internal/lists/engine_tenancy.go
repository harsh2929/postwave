package lists

// engine_tenancy.go — who owns an engine list that has no Moosewave identity.
//
// The gateway talks to ONE process-global Listmonk (Deps.ListmonkBaseURL) and
// Listmonk's lists carry no tenant. A list created through this API is
// attributed by the list_id_map row Create writes. A list created anywhere
// else has no identity at all: Listmonk's install-time "Default list" and
// "Opt-in list", a list made in the Listmonk admin, a list that predates
// migration 0257. Every uuid-keyed surface fails closed on such a list — its
// Members tab is a 404, bulk add-to-list is a 404, a campaign aimed at it
// cannot resolve its audience, and a list-scoped webhook is refused.
//
// Exactly one fact attributes such a list: when the database holds a single
// tenant, every engine list is that tenant's. subscribers/engine_sync.go proves
// the same thing before it lets that tenant's profiles reach the global engine,
// and this is the same proof. Tenant creation is locked out while the count is
// read and the identities are written (SHARE conflicts with the ROW EXCLUSIVE
// an INSERT takes), so a second tenant cannot appear between the two.
//
// With more than one tenant the engine is shared and ownership is unknowable.
// An unattributed list then stays unattributed: it is not shown in any
// tenant's catalogue and cannot be renamed or deleted through this API. The
// remedy is operational — create lists through Moosewave (which maps them), or
// record the (tenant, engine id) pair in list_id_map deliberately.

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// proveSoleTenantTx reports whether tenantID is the only tenant, holding a
// SHARE lock on tenants for the rest of tx when it is. tx must be
// worker-scoped: the tenants read policy only admits an enumeration under
// app.outbox_worker.
//
// A shared engine — the common case once it is shared — is answered without
// the lock, so catalogue reads on a multi-tenant deployment never queue
// tenant creation behind them. Only a first "yes" takes the lock and asks
// again, because only a "yes" is acted on.
func proveSoleTenantTx(ctx context.Context, tx pgx.Tx, tenantID string) (bool, error) {
	sole, err := soleTenantIsTx(ctx, tx, tenantID)
	if err != nil || !sole {
		return false, err
	}
	if _, err := tx.Exec(ctx, `LOCK TABLE tenants IN SHARE MODE`); err != nil {
		return false, fmt.Errorf("lists: lock tenants for the engine tenancy proof: %w", err)
	}
	return soleTenantIsTx(ctx, tx, tenantID)
}

func soleTenantIsTx(ctx context.Context, tx pgx.Tx, tenantID string) (bool, error) {
	var count int
	var soleTenantID string
	if err := tx.QueryRow(ctx, `
SELECT count(*), COALESCE(max(id::text), '')
  FROM (
        SELECT id
          FROM tenants
         ORDER BY id
         LIMIT 2
       ) AS bounded_tenants`).Scan(&count, &soleTenantID); err != nil {
		return false, fmt.Errorf("lists: read tenants for the engine tenancy proof: %w", err)
	}
	return count == 1 && soleTenantID == tenantID, nil
}

// adoptEngineLists mints a Moosewave identity for each of engineIDs in tenantID
// when — and only when — tenantID is the sole tenant. engineIDs must be ids the
// engine itself just reported, never ids taken from a request: adopting an id
// Listmonk does not have would mint an identity for a list that does not exist.
//
// Returns the identities this call created and whether the proof held. An id
// that already has an identity (a concurrent adoption, a retired identity) is
// left alone; the caller re-reads the mapping to learn the winner.
func (r *Repo) adoptEngineLists(ctx context.Context, tenantID string, engineIDs []int64) ([]ListIdentity, bool, error) {
	if r == nil || r.Pool == nil {
		return nil, false, ErrListsRepoUnavailable
	}
	if len(engineIDs) == 0 {
		return nil, false, nil
	}
	tx, err := db.WithTenantWorker(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	sole, err := proveSoleTenantTx(ctx, tx, tenantID)
	if err != nil || !sole {
		return nil, false, err
	}
	rows, err := tx.Query(ctx, `
INSERT INTO list_id_map (postwave_uuid, listmonk_bigint_id, tenant_id)
SELECT gen_random_uuid(), engine.id, $1::uuid
  FROM unnest($2::bigint[]) AS engine(id)
ON CONFLICT (tenant_id, listmonk_bigint_id) DO NOTHING
RETURNING postwave_uuid::text, listmonk_bigint_id`, tenantID, engineIDs)
	if err != nil {
		return nil, true, fmt.Errorf("lists: adopt engine lists: %w", err)
	}
	var adopted []ListIdentity
	for rows.Next() {
		var identity ListIdentity
		if err := rows.Scan(&identity.UUID, &identity.EngineID); err != nil {
			rows.Close()
			return nil, true, fmt.Errorf("lists: scan adopted identity: %w", err)
		}
		adopted = append(adopted, identity)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, true, fmt.Errorf("lists: read adopted identities: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, true, err
	}
	return adopted, true, nil
}

// isSoleTenant is the momentary form of the proof, for authorising an
// upstream change to an engine list this tenant has no identity for. Unlike
// adoption it holds nothing beyond the answer: the list is unmapped either
// way, and a tenant created a moment later does not own it either.
func (r *Repo) isSoleTenant(ctx context.Context, tenantID string) (bool, error) {
	if r == nil || r.Pool == nil {
		return false, ErrListsRepoUnavailable
	}
	tx, err := db.WithTenantWorker(ctx, r.Pool, tenantID)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return proveSoleTenantTx(ctx, tx, tenantID)
}
