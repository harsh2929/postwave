// SPDX-License-Identifier: AGPL-3.0-only
//
// pools.go — region-keyed pgx pool registry.
//
// Most deployments are single-region: POSTWAVE_DEPLOYMENT_REGION
// is set to (e.g.) us-east-1 and DATABASE_URL points at the
// us-east-1 cluster. The EnforceRegion middleware 421s any cross-
// region request, so each deployment naturally stays within its
// own data plane.
//
// SOME deployments need cross-region admin reads (e.g. the global
// status dashboard, the agency-parent-in-us-east listing children-
// in-eu-central). For those, this Registry holds one pool per region
// and exposes:
//
//   r.ForRegion(region) (*pgxpool.Pool, error)
//   r.ForTenant(ctx, tenantID) (*pgxpool.Pool, region.Region, error)
//
// Configuration is via the POSTWAVE_REGION_POOLS env var:
//
//   POSTWAVE_REGION_POOLS="us-east-1=postgres://...,eu-central-1=postgres://..."
//
// Empty or unset → only the local Current() region is available via
// the supplied default pool. ForRegion(any-other-region) returns
// ErrUnreachableRegion in that case.

package regions

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrUnreachableRegion is returned by Registry.ForRegion when the
// requested region has no pool wired in this process.
var ErrUnreachableRegion = errors.New("regions: unreachable region (no pool wired)")

// Registry maps region → *pgxpool.Pool. The deployment-local region
// (Current()) MUST be present in the registry; the local pool is
// resolved without a network hop.
type Registry struct {
	mu    sync.RWMutex
	pools map[Region]*pgxpool.Pool
	// localRegion is the deployment-local region; matches Current()
	// in production. Kept as a field so tests can pin a different
	// "local" without monkey-patching env vars.
	localRegion Region
}

// NewRegistry creates an empty Registry with the supplied local region.
// The caller should subsequently Register(localRegion, localPool)
// before any handler runs.
func NewRegistry(localRegion Region) *Registry {
	return &Registry{
		pools:       make(map[Region]*pgxpool.Pool),
		localRegion: localRegion,
	}
}

// Register binds a pool to a region. Safe to call multiple times for
// the same region — the latest pool wins. Returns the previously
// registered pool (or nil) so the caller can close it cleanly.
func (r *Registry) Register(region Region, pool *pgxpool.Pool) *pgxpool.Pool {
	if r == nil || pool == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	prev := r.pools[region]
	r.pools[region] = pool
	return prev
}

// Local returns the pool for the deployment-local region.
func (r *Registry) Local() *pgxpool.Pool {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.pools[r.localRegion]
}

// ForRegion returns the pool for region. ErrUnreachableRegion when
// the region is not configured in this process.
func (r *Registry) ForRegion(region Region) (*pgxpool.Pool, error) {
	if r == nil {
		return nil, ErrUnreachableRegion
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	p, ok := r.pools[region]
	if !ok {
		return nil, fmt.Errorf("%w: %s", ErrUnreachableRegion, region)
	}
	return p, nil
}

// Regions returns the configured region set. Useful for the global
// status dashboard ("we can reach 4 regions: us-east-1, us-west-2,
// eu-central-1, eu-west-1").
func (r *Registry) Regions() []Region {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]Region, 0, len(r.pools))
	for region := range r.pools {
		out = append(out, region)
	}
	return out
}

// ForTenant resolves the tenant's data_region (by querying the LOCAL
// pool's tenants table, which has every tenant id but only data_region
// truth for tenants whose data_region == local), then returns the
// pool for that region.
//
// In a true multi-region deployment, tenants.data_region is the
// canonical map; the local tenants table includes a row for every
// tenant (regardless of where the data sits) because the table itself
// is replicated globally (the data_region column tells you where
// the OTHER tables for that tenant actually live).
//
// Returns (nil, "", error) on lookup failure.
func (r *Registry) ForTenant(ctx context.Context, tenantID string) (*pgxpool.Pool, Region, error) {
	if r == nil {
		return nil, "", ErrUnreachableRegion
	}
	local := r.Local()
	if local == nil {
		return nil, "", errors.New("regions: local pool not registered")
	}
	var regionStr string
	err := local.QueryRow(ctx,
		`SELECT data_region FROM tenants WHERE id = $1::uuid`, tenantID,
	).Scan(&regionStr)
	if err != nil {
		return nil, "", fmt.Errorf("lookup data_region: %w", err)
	}
	region := Region(regionStr)
	pool, err := r.ForRegion(region)
	if err != nil {
		return nil, region, err
	}
	return pool, region, nil
}

// ParseRegionPools parses the POSTWAVE_REGION_POOLS env var:
//
//	"us-east-1=postgres://...,eu-central-1=postgres://..."
//
// Whitespace around the comma and `=` is tolerated. Empty values are
// rejected (errors propagate so misconfiguration surfaces loudly
// rather than silently dropping a region).
func ParseRegionPools(raw string) (map[Region]string, error) {
	raw = strings.TrimSpace(raw)
	out := map[Region]string{}
	if raw == "" {
		return out, nil
	}
	for _, pair := range strings.Split(raw, ",") {
		pair = strings.TrimSpace(pair)
		if pair == "" {
			continue
		}
		eq := strings.IndexByte(pair, '=')
		if eq < 0 {
			return nil, fmt.Errorf("regions: malformed pool spec %q (expected region=url)", pair)
		}
		regionStr := strings.TrimSpace(pair[:eq])
		url := strings.TrimSpace(pair[eq+1:])
		if regionStr == "" || url == "" {
			return nil, fmt.Errorf("regions: empty region or url in pool spec %q", pair)
		}
		if err := Validate(regionStr); err != nil {
			return nil, err
		}
		out[Region(regionStr)] = url
	}
	return out, nil
}
