// SPDX-License-Identifier: AGPL-3.0-only

package workers

import (
	"context"
	"log/slog"

	"github.com/postwave/postwave/apps/api/internal/server"
	"github.com/postwave/postwave/apps/api/internal/support_integrations"
)

type supportIntegrationBackfillRegistration struct {
	name   string
	worker *support_integrations.SupportBackfillWorker
}

// StartSupportIntegrationBackfills launches one worker for every native
// provider using the exact repository, dependency graph, and backfiller
// identities returned by server.MountSupportIntegrationsSurface.
func StartSupportIntegrationBackfills(ctx context.Context, logger *slog.Logger, surface server.SupportIntegrationsSurface) {
	_ = ctx
	_ = surface
	if logger != nil {
		logger.Warn("support integration backfill workers release-held by Route41 privacy boundary")
	}
}

func supportIntegrationBackfillRegistrations(surface server.SupportIntegrationsSurface) []supportIntegrationBackfillRegistration {
	_ = surface
	// Compile-time source hold: no Run/RunOnce-capable worker registration is
	// reachable while Helpdesk provider privacy lifecycle is incomplete.
	return nil
}
