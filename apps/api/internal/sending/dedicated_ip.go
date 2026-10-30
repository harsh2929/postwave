package sending

import (
	"context"
	"fmt"
)

// PoolStrategy describes how a tenant's outbound sending is partitioned at
// the IP level.
//
// Sending tier → Shared pool, reputation isolation via per-tenant DKIM domain.
// Pro tier     → Dedicated IP, attached to the tenant's Postmark server.
type PoolStrategy string

const (
	PoolShared    PoolStrategy = "shared"
	PoolDedicated PoolStrategy = "dedicated"
)

// StrategyForTier returns the IP pool strategy for a tier.
func StrategyForTier(tier string) PoolStrategy {
	if tier == "pro" {
		return PoolDedicated
	}
	return PoolShared
}

// DedicatedIPProvisioner glues the Postmark dedicated-IP rental API into the
// tenant provisioning flow.
type DedicatedIPProvisioner struct {
	Postmark *PostmarkClient
}

// ProvisionDedicatedIP rents an IP and attaches it to the tenant's stream.
// The caller starts warmup after the sending_state row is durable so
// Postgres-backed trackers can update the row in place.
func (p *DedicatedIPProvisioner) ProvisionDedicatedIP(
	ctx context.Context,
	postmarkServerID int,
	region string,
) (*DedicatedIP, error) {
	ip, err := p.Postmark.RentDedicatedIP(ctx, postmarkServerID, region)
	if err != nil {
		return nil, fmt.Errorf("rent dedicated ip: %w", err)
	}
	return ip, nil
}
