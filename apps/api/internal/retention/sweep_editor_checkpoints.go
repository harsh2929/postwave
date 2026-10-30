// SPDX-License-Identifier: AGPL-3.0-only
//
// sweep_editor_checkpoints.go — expires unfinished editor drafts.
//
// `editorcheckpoint.SweepOlderThan` existed with no caller. It is a per-tenant
// function and nothing enumerated tenants, so the table only ever grew: every
// autosaved draft anyone ever abandoned, kept forever, in a table whose own
// header says a checkpoint "is a convenience with a short useful life". That
// is the failure this file closes — not a missing DELETE, a missing scheduler.
//
// WHY THIS DELEGATES INSTEAD OF WRITING ITS OWN SQL, unlike its sibling sweeps.
// The other sweep_*.go files inline their statements because the tables they
// clear have no owning package. This one does, and that package already
// enforces two things the SQL alone does not express: the cutoff is `updated_at`
// rather than `created_at`, and the age is `editorcheckpoint.SweepAge`. Copying
// the DELETE here would duplicate a rule that must not diverge — and a
// divergence would be silent, because both copies would keep deleting rows.
//
// NO NEW Sweeper FIELD, deliberately. The obvious shape is an
// `EditorCheckpoints *editorcheckpoint.Repo` field guarded by `if != nil`, and
// this repository already has a documented instance of exactly that going
// wrong: a writer whose field is never assigned in main.go, so every nil-check
// is false forever and the mechanism is inert while looking wired. The sweeper
// already holds the pool the repo needs, so constructing it here removes the
// step someone can forget. There is no configuration to omit.

package retention

import (
	"context"

	"github.com/postwave/postwave/apps/api/internal/editorcheckpoint"
)

// sweepEditorCheckpoints deletes this tenant's checkpoints that nobody has
// returned to within editorcheckpoint.SweepAge.
//
// BATCHED like every sibling sweep, via s.batchSize() / s.maxBatchesPerTenant()
// (raw_payloads.go:38-43: "so we don't take long-lived locks on a hot table").
// This class needs that at least as much as they do — a checkpoint row carries
// up to 256 KiB of draft content and one person may hold 200 of them, and the
// index behind the cutoff is on `updated_at` alone rather than
// (tenant_id, updated_at) — so the single unbounded DELETE this used to issue
// was one transaction over a potentially multi-GB backlog, taken while the
// people still working in that tenant wait on their own autosave.
//
// The batching lives HERE and the cutoff rule stays in the owning package:
// SweepBatchOlderThan takes the limit, so nothing about `updated_at` or
// SweepAge is restated in this package where it could drift.
//
// Runs with tenant scope and no acting user, which the table's RESTRICTIVE
// owner_isolation policy explicitly permits: the policy falls through to
// tenant scope when `app.user_id` is unset, so the sweep reaches every user's
// abandoned drafts while a request-path query that forgets its predicate still
// returns nothing. That fall-through is load-bearing here — under a policy
// that required a user the sweep would delete zero rows forever and report
// success every time.
func (s *Sweeper) sweepEditorCheckpoints(ctx context.Context, tenantID string) (int64, error) {
	repo := &editorcheckpoint.Repo{Pool: s.Pool}
	var total int64
	for i := 0; i < s.maxBatchesPerTenant(); i++ {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		n, err := repo.SweepBatchOlderThan(ctx, tenantID, editorcheckpoint.SweepAge, s.batchSize())
		if err != nil {
			return total, err
		}
		total += n
		// A short batch means the backlog is drained. Anything still left when
		// the cap is reached is picked up on the next tick, which is the same
		// deal the other classes make.
		if n == 0 {
			break
		}
	}
	return total, nil
}
