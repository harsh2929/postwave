package subscribers

import (
	"context"

	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/listmonk"
)

// NewEngineResolver shares the gateway's tenant registry with form signups,
// subscriber sync and deletes. Legacy engines retain the sole-tenant proof.
func NewEngineResolver(pool *db.Pool, client *listmonk.Client) EngineResolver {
	if client.TenantRouted() {
		return &routedEngineResolver{client: client}
	}
	return &SingleTenantGlobalEngineResolver{Pool: pool, Engine: client}
}

type routedEngineResolver struct{ client *listmonk.Client }

func (r *routedEngineResolver) Acquire(ctx context.Context, tenantID string) (EngineLease, error) {
	client, err := r.client.ForTenant(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	return routedEngineLease{client}, nil
}

type routedEngineLease struct{ engine Engine }

func (l routedEngineLease) Engine() Engine { return l.engine }
func (l routedEngineLease) Close() error   { return nil }
