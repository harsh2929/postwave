// SPDX-License-Identifier: AGPL-3.0-only
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/flowsteps"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// handleFlowRunSteps reads one run's per-node attempts.
//
// Delegates to `internal/flowsteps` rather than re-querying: the ordering
// (oldest-first, because an inspector is read as a sequence) and the decision
// to keep applied/skipped/failed as three numbers are properties of the answer,
// not of the transport. A second query here would eventually disagree with the
// HTTP surface about one of them, and an agent and a dashboard describing the
// same run differently is worse than either being wrong alone.
func handleFlowRunSteps(ctx context.Context, d *Deps, args json.RawMessage) (any, error) {
	var in struct {
		RunID string `json:"run_id"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &in); err != nil {
			return nil, err
		}
	}
	runID := strings.TrimSpace(in.RunID)
	if runID == "" {
		return nil, errors.New("run_id required")
	}
	t, ok := middleware.TenantFromContext(ctx)
	if !ok {
		return nil, errors.New("no tenant in context")
	}
	attempts, err := (&flowsteps.Repo{Pool: d.Pool}).ForRun(ctx, t.ID, runID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"run_id": runID, "attempts": attempts}, nil
}
