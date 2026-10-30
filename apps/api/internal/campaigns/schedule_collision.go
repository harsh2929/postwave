// SPDX-License-Identifier: AGPL-3.0-only
package campaigns

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// Two campaigns landing on one audience at nearly the same moment.
//
// Nothing checked for this. A person scheduling from the calendar sees their own
// campaign and not the one a colleague placed an hour earlier on the same list —
// and the audience receives two emails in the same hour, which is the complaint
// that produces unsubscribes rather than a support ticket.
//
// It is a WARNING, not a refusal. Two sends to one list in an hour is sometimes
// exactly right — a launch and its reminder, a live event — and refusing would
// make the calendar unusable for the campaigns most likely to be deliberate. The
// judgement belongs to the person; what was missing is the information.

// collisionWindow is how close two sends have to be to be worth mentioning.
//
// Two hours. Short enough that a morning and an afternoon send do not warn every
// time, long enough to catch the case that matters: two messages arriving in one
// inbox session. A warning that fires on every ordinary schedule is one people
// learn to dismiss, which costs the warnings that matter.
const collisionWindow = 2 * time.Hour

// scheduleCollision returns a human sentence naming the campaigns that share
// this audience near this instant, or "".
//
// READ THE COLUMNS THE CAMPAIGN IS ACTUALLY STORED IN. `campaigns` carries both
// `segment_id` and `audience_segment_id`; the repo writes and reads the FIRST,
// and the second is never populated. Querying `audience_segment_id` compared
// every segment campaign against NULL, so the advisory returned nothing for all
// of them — permanently, and looking exactly like "no clash found". The list
// half worked, which is why the mutation replacing the whole audience predicate
// with `true` was still caught: the list tests covered it and there was no
// segment test at all.
//
// AUDIENCE IDENTITY IS THE LIST OR SEGMENT, not the resolved membership. Two
// segments can overlap heavily without being equal, and computing real overlap
// would mean materialising both audiences on every schedule — expensive, and
// wrong the moment either segment's definition moves. Naming the obvious case
// exactly beats guessing at the subtle one.
func (d *Deps) scheduleCollision(
	ctx context.Context, tenantID, campaignID string, at *time.Time, c *Campaign,
) string {
	if at == nil || d.Repo == nil || d.Repo.Pool == nil || c == nil {
		return ""
	}
	listID := strings.TrimSpace(c.AudienceListID())
	segmentID := strings.TrimSpace(c.SegmentID)
	if listID == "" && segmentID == "" {
		// A campaign with no addressable audience cannot collide with one. Its
		// own audience problems are the queue path's business.
		return ""
	}

	names, total, err := d.Repo.scheduledNeighbours(ctx, tenantID, campaignID, listID, segmentID,
		at.Add(-collisionWindow), at.Add(collisionWindow))
	if err != nil || len(names) == 0 {
		// Silent on error: this is advisory, and a database hiccup must not
		// produce a scary message about a clash that may not exist.
		return ""
	}
	if total == 1 {
		return fmt.Sprintf("%q is already scheduled to this audience within two hours", names[0])
	}
	// `total` is counted separately from the names, which are capped. Reporting
	// `len(names)` said "10 other campaigns" when there were fifteen — an
	// undercount in the one direction that matters, since the number is what
	// tells somebody how bad the pile-up is.
	return fmt.Sprintf("%d other campaigns are already scheduled to this audience within two hours, including %q",
		total, names[0])
}

// scheduledNeighbours finds campaigns sharing this audience inside the window,
// returning up to ten names and the TOTAL count.
//
// Excludes the campaign being scheduled — comparing it to itself would warn on
// every reschedule.
//
// A DRAFT IS EXCLUDED AND A SEND IN FLIGHT IS NOT. A draft carrying a date is an
// intention, and warning about one would fill the calendar with sends nobody has
// committed to. `sending` and `sent` are the opposite case: the original version
// of this only counted `scheduled`, so a colleague's campaign became invisible
// the instant it began sending, and one that had ALREADY GONE OUT an hour ago
// produced nothing at all — which is the literal harm in the doc above, since
// the audience has by then actually received it. Those are the neighbours a
// person most needs to know about, because that mail cannot be recalled.
//
// The bound is `scheduled_at`, so a campaign sent immediately rather than
// scheduled has no time to compare against and is not considered. Naming that
// limit rather than pretending to a completeness this cannot have: matching on
// `sent_at` as well would need the two columns reconciled, and a send that was
// never placed on the calendar is not something the calendar can warn about.
func (r *Repo) scheduledNeighbours(
	ctx context.Context, tenantID, campaignID, listID, segmentID string, from, to time.Time,
) ([]string, int, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `
WITH neighbours AS (
  SELECT name, scheduled_at
    FROM campaigns
   WHERE tenant_id = $1::uuid
     AND id <> $2::uuid
     AND status IN ('scheduled', 'sending', 'sent')
     AND scheduled_at IS NOT NULL
     AND scheduled_at BETWEEN $3 AND $4
     AND (
          ($5 <> '' AND audience_list_id::text = $5)
       OR ($6 <> '' AND segment_id::text = $6)
     )
)
SELECT name, (SELECT count(*) FROM neighbours)::int
  FROM neighbours
 ORDER BY scheduled_at
 LIMIT 10`, tenantID, campaignID, from, to, listID, segmentID)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []string
	total := 0
	for rows.Next() {
		var name string
		if err := rows.Scan(&name, &total); err != nil {
			return nil, 0, err
		}
		out = append(out, name)
	}
	return out, total, rows.Err()
}
