// SPDX-License-Identifier: AGPL-3.0-only
//
// sample_data_segments.go — removing the sample segment without breaking a
// campaign the operator built on it.
//
// "Use in a campaign" on the seeded sample segment creates a real, non-sample
// draft campaign that targets it. Migration 1876 refuses to delete a segment
// while a campaign that has not sent uses it (the campaign would otherwise be
// silently retargeted at the whole workspace), so removing sample data used to
// abort on that trigger and answer 500, leaving every sample row in place.
//
// Removal now deletes the sample segments nothing still sends to and keeps the
// rest, naming the campaigns that hold them, so the operator learns exactly
// what to move before removing sample data again.

package onboarding

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/packages/runtime/campaigndispatch"
)

// KeptSampleSegment is a sample segment Remove left in place because a
// campaign that has not sent yet still targets it.
type KeptSampleSegment struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Campaigns []string `json:"campaigns"`
}

// removeSampleSegments deletes the tenant's sample segments that no sendable
// campaign targets and reports the ones it kept. It runs inside Remove's
// transaction, after the sample campaigns are gone, so only the operator's
// own campaigns can hold a sample segment back.
func removeSampleSegments(ctx context.Context, tx pgx.Tx, tenantID string) (int, []KeptSampleSegment, error) {
	// The guard is the 1876 trigger's own predicate, so the DELETE never
	// reaches a row the trigger would refuse. The predicate's columns are
	// unqualified; segments has neither, so they resolve to the campaign.
	tag, err := tx.Exec(ctx, `
DELETE FROM segments s
 WHERE s.tenant_id = $1::uuid
   AND s.description LIKE $2
   AND NOT EXISTS (
       SELECT 1 FROM campaigns c
        WHERE c.tenant_id = s.tenant_id
          AND c.segment_id = s.id
          AND `+campaigndispatch.EditablePredicate+`)`, tenantID, sampleSegmentDescPrefix+"%")
	if err != nil {
		return 0, nil, err
	}
	rows, err := tx.Query(ctx, `
SELECT s.id::text, s.name,
       COALESCE(array_agg(c.name ORDER BY lower(c.name)) FILTER (WHERE c.id IS NOT NULL), '{}')
  FROM segments s
  LEFT JOIN campaigns c
    ON c.tenant_id = s.tenant_id
   AND c.segment_id = s.id
   AND `+campaigndispatch.EditablePredicate+`
 WHERE s.tenant_id = $1::uuid
   AND s.description LIKE $2
 GROUP BY s.id, s.name
 ORDER BY lower(s.name), s.id`, tenantID, sampleSegmentDescPrefix+"%")
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()
	var kept []KeptSampleSegment
	for rows.Next() {
		var k KeptSampleSegment
		if err := rows.Scan(&k.ID, &k.Name, &k.Campaigns); err != nil {
			return 0, nil, err
		}
		kept = append(kept, k)
	}
	if err := rows.Err(); err != nil {
		return 0, nil, err
	}
	return int(tag.RowsAffected()), kept, nil
}
