// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/campaignreportprojection"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/listmonk_events"
	"github.com/postwave/postwave/apps/api/internal/replies"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
	"github.com/postwave/postwave/apps/api/internal/webhooks"
)

// initializeCampaignReportProjectionRuntime is the only production gate for
// writer-side migrations 1959/1964 composition. Disabled means no readiness
// query and an actual nil pointer; enabled means startup proves the restricted
// app-role append, evidence, mutation, and RLS boundaries before any webhook can
// be accepted.
func initializeCampaignReportProjectionRuntime(
	ctx context.Context,
	pool *db.Pool,
	getenv func(string) string,
) (*campaignreportprojection.Runtime, error) {
	configuration, err := campaignreportprojection.RuntimeConfigurationFromEnvironment(getenv)
	if err != nil {
		return nil, fmt.Errorf("campaign report projection configuration: %w", err)
	}
	if !configuration.Enabled {
		return nil, nil
	}
	runtime, err := campaignreportprojection.BuildRuntime(ctx, configuration, pool)
	if err != nil {
		return nil, fmt.Errorf("campaign report projection startup readiness: %w", err)
	}
	return runtime, nil
}

// These package-specific converters are intentionally repetitive. Each writer
// owns a narrow local interface, and assigning a nil *Runtime directly to one
// would create a non-nil interface whose method call returns RuntimeDisabled.
// The explicit converters preserve the gate's real off behavior.
func listmonkCampaignReportProjectorForDeps(
	runtime *campaignreportprojection.Runtime,
) listmonk_events.TransactionalCampaignReportProjector {
	if runtime == nil || !runtime.Enabled() {
		return nil
	}
	return runtime
}

func espCampaignReportProjectorForDeps(
	runtime *campaignreportprojection.Runtime,
) webhooks.TransactionalCampaignReportProjector {
	if runtime == nil || !runtime.Enabled() {
		return nil
	}
	return runtime
}

func subscriberCampaignReportProjectorForDeps(
	runtime *campaignreportprojection.Runtime,
) subscribers.TransactionalCampaignReportProjector {
	if runtime == nil || !runtime.Enabled() {
		return nil
	}
	return runtime
}

func replyCampaignReportProjectorForDeps(
	runtime *campaignreportprojection.Runtime,
) replies.TransactionalCampaignReportProjector {
	if runtime == nil || !runtime.Enabled() {
		return nil
	}
	return runtime
}
