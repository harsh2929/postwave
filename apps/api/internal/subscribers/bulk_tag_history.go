// SPDX-License-Identifier: AGPL-3.0-only
//
// bulk_tag_history.go — makes the bulk tag verbs visible in tag history.
//
// There are TWO bulk tag paths in this system, and only one of them was
// recorded. `tags.Repo.Apply` (POST /api/v1/tags/bulk-*) writes a single
// batched `bulk_applied` / `bulk_unapplied` row — one row rather than N,
// deliberately, to avoid history bloat on a thousand-member call.
// `POST /api/v1/subscribers/bulk/tag` wrote nothing at all.
//
// The gap was invisible from either end. The subscribers verb updates
// `subscribers.tags`, and migration 1774's reconcile trigger faithfully
// projects that into the canonical `subscriber_tags` join — so membership was
// always correct and the tag registry always agreed. Only the HISTORY was
// missing: someone tagging five thousand people through this endpoint left no
// trace in the surface whose entire job is answering "who applied this tag, and
// when". Verified against the database rather than inferred — a direct array
// write produces one canonical membership row and zero tag_history rows.
//
// Worse, `GET /api/v1/tags/history` reports its own coverage as
// `partial_legacy_history` and lists "bulk legacy events are aggregate rows
// rather than per-member transitions" among its known limitations. That
// sentence describes the OTHER path. For this one the events were not
// aggregate, they were absent — so the declared limitation understated the gap
// and a reader checking the coverage block would have been misled about which
// operations they were seeing.
//
// ONE AGGREGATE ROW, matching the sibling exactly. Per-subscriber rows would be
// 10,000 inserts on a capped bulk call, which is the bloat the tags package
// already decided against; diverging here would also make the two bulk paths
// disagree about what a bulk tag event looks like.
//
// WEBHOOKS AND FLOW TRIGGERS ARE DELIBERATELY NOT FIRED, and that is a
// decision rather than an omission. `tags.History` fans out to both when its
// dispatchers are set; this constructs the emitter with neither, so only the
// database row is written. Firing them would turn one bulk call into up to
// 10,000 flow enrolments and 10,000 webhook deliveries — a fan-out with real
// cost that nobody has asked for, and which the tag-trigger adapter already
// caps at 10 flows per event precisely because that blow-up is the known
// hazard. Making the bulk verb newly emit those is a product decision with a
// scale consequence, not a bug fix, so it is left to be made explicitly.
// Recording the history row is the part with no downside: it costs one insert
// and it stops an audited action being unauditable.

package subscribers

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/tags"
)

// emitBulkTagHistory writes the one aggregate row for a bulk tag mutation.
//
// Called after the tag UPDATE has already run in this transaction, which
// matters: migration 1774's reconcile trigger registers the tag name in `tags`
// as part of that UPDATE, so the name→id resolution inside the emitter finds a
// row. Emitting before the mutation would leave `tag_id` NULL and the event
// invisible to per-tag history — present, but not where anyone would look.
func emitBulkTagHistory(
	ctx context.Context,
	tx pgx.Tx,
	tenantID, tagName, action string,
	affected, requested int,
	audienceSource string,
	userID *string,
) error {
	if affected == 0 {
		// Nothing changed, so there is nothing to record. A row here would put
		// "someone bulk-tagged" in the history of a call that tagged nobody —
		// every member already had the tag — which is a false positive in the
		// one surface that must not have them.
		return nil
	}
	actorID := ""
	if userID != nil {
		actorID = *userID
	}
	history := &tags.History{}
	return history.EmitTx(ctx, tx, tags.HistoryEvent{
		TenantID: tenantID,
		TagName:  tagName,
		Action:   action,
		Source:   "subscribers_bulk",
		ActorID:  actorID,
		Metadata: map[string]any{
			"subscriber_count": affected,
			"requested_count":  requested,
			"audience_source":  audienceSource,
			"endpoint":         "subscribers.bulk",
		},
	})
}
