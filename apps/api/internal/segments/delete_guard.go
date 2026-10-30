// SPDX-License-Identifier: AGPL-3.0-only
//
// delete_guard.go — why a segment cannot be deleted right now, in words.
//
// Migration 1876 refuses `DELETE FROM segments` while a campaign that can still
// send targets the segment: the campaigns FK is ON DELETE SET NULL, and a NULL
// segment_id resolves to the whole workspace, so the delete would silently turn
// a targeted campaign into a company-wide send. The trigger raises SQLSTATE
// 23503 with a message meant for a log, and until this file existed the API
// passed that through as a generic 500. The web client retries 5xx mutations,
// so the refusal arrived three times and said only "an internal error
// occurred".
//
// The trigger stays the one place that decides, atomically with the DELETE.
// Repo.Delete recognises its refusal (by the raising function, not by SQLSTATE
// alone, so a future foreign key is not mistaken for it), names the blocking
// campaigns from a fresh transaction, and returns a typed refusal the handler
// maps to 409.

package segments

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/postwave/postwave/packages/runtime/campaigndispatch"
)

// blockingCampaignNameLimit bounds how many campaigns a refusal names. The
// total is always reported; the names are there so the reader knows where to
// go, and five is enough to find the rest from the campaigns list.
const blockingCampaignNameLimit = 5

// BlockingCampaign is a campaign that still sends to a segment.
type BlockingCampaign struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

// SegmentInUseError refuses a segment delete because campaigns that have not
// sent yet use it as their audience. Campaigns holds at most
// blockingCampaignNameLimit entries; Total counts all of them.
type SegmentInUseError struct {
	Campaigns []BlockingCampaign
	Total     int
}

func (e *SegmentInUseError) Error() string {
	return fmt.Sprintf("%s (%d campaign(s))", ErrSegmentInUse.Error(), e.Total)
}

// Unwrap lets callers test for the refusal with errors.Is(err, ErrSegmentInUse).
func (e *SegmentInUseError) Unwrap() error { return ErrSegmentInUse }

// Message is the operator-facing explanation: which campaigns hold the
// reference and what to do about it. Campaign names are the operator's own
// data, so echoing them back to the same tenant is safe.
func (e *SegmentInUseError) Message() string {
	names := make([]string, 0, len(e.Campaigns))
	for _, c := range e.Campaigns {
		names = append(names, `"`+c.Name+`"`)
	}
	switch {
	case len(names) == 0:
		// The trigger refused the delete, but the campaign that held the
		// reference had moved on by the time we looked.
		return "A campaign that hasn't sent yet was using this segment as its audience when you tried to delete it. Check the campaigns that use this segment, then try again."
	case e.Total <= 1 && len(names) == 1:
		return "This segment is the audience of the campaign " + names[0] +
			", which hasn't sent yet. Move that campaign to another audience, or delete it, before deleting this segment."
	case e.Total > len(names):
		return "This segment is the audience of " + strconv.Itoa(e.Total) +
			" campaigns that haven't sent yet, including " + joinWithAnd(names) +
			". Move them to another audience, or delete them, before deleting this segment."
	default:
		return "This segment is the audience of " + strconv.Itoa(e.Total) +
			" campaigns that haven't sent yet: " + joinWithAnd(names) +
			". Move them to another audience, or delete them, before deleting this segment."
	}
}

func joinWithAnd(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	default:
		return strings.Join(items[:len(items)-1], ", ") + " and " + items[len(items)-1]
	}
}

// blockingCampaignsSQL is the 1876 trigger's predicate, spelled with the same
// shared constant the campaign content freeze uses, so "has not sent yet"
// cannot mean one thing to the delete guard and another to the send path.
var blockingCampaignsSQL = `
SELECT id::text, name, status, count(*) OVER ()::int
  FROM campaigns
 WHERE tenant_id = $1::uuid
   AND segment_id::text = $2
   AND ` + campaigndispatch.EditablePredicate + `
 ORDER BY lower(name), id
 LIMIT ` + strconv.Itoa(blockingCampaignNameLimit)

// sendableCampaignRefusalFunction is the 1876 trigger function. Its RAISE is
// reported with this name in the error's context.
const sendableCampaignRefusalFunction = "refuse_segment_delete_with_sendable_campaigns"

// isSendableCampaignRefusal reports whether err is the 1876 trigger refusing a
// segment delete. The trigger raises 23503 without a constraint name; a real
// foreign-key violation names its constraint and comes from no function.
func isSendableCampaignRefusal(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) &&
		pgErr.Code == "23503" &&
		pgErr.ConstraintName == "" &&
		strings.Contains(pgErr.Where, sendableCampaignRefusalFunction+"()")
}

// segmentInUse returns a *SegmentInUseError when campaigns that can still send
// target the segment, or nil when the delete may proceed.
func segmentInUse(ctx context.Context, tx pgx.Tx, tenantID, segmentID string) error {
	rows, err := tx.Query(ctx, blockingCampaignsSQL, tenantID, segmentID)
	if err != nil {
		return err
	}
	defer rows.Close()
	refusal := &SegmentInUseError{}
	for rows.Next() {
		var c BlockingCampaign
		if err := rows.Scan(&c.ID, &c.Name, &c.Status, &refusal.Total); err != nil {
			return err
		}
		refusal.Campaigns = append(refusal.Campaigns, c)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(refusal.Campaigns) == 0 {
		return nil
	}
	return refusal
}
