// SPDX-License-Identifier: AGPL-3.0-only
package campaigns

import (
	"context"
	"strings"
)

// A campaign placed on the calendar with no audience.
//
// The schedule endpoint accepted any campaign in a schedulable state and said
// nothing about who it would go to. So a campaign with no list, no segment, or
// an audience that resolves to zero eligible subscribers sat on the calendar
// looking ready — and the person found out at send time, which for a scheduled
// send is whenever the scheduler next ticks, possibly at 3am and possibly to
// nobody at all.
//
// ONE NOTION OF "HAS RECIPIENTS", not a second one written here. This asks
// `checkRecipients`, which is what the pre-send checklist and queue-fill both
// use — it resolves the audience through `ResolveCampaignAudience`, the same
// path that produces the actual send set. A separate count written for the
// schedule endpoint would eventually disagree with the one that decides who
// gets the mail, and the disagreement would surface as a campaign that
// scheduled cleanly and then refused to send.
//
// IT WARNS, IT DOES NOT REFUSE. Placing a campaign on the calendar before its
// audience is finalised is ordinary practice: people book the slot, then build
// the list. Refusing would make the calendar unusable for the campaigns most
// likely to be planned in advance. What was missing is being told.

// scheduleAudienceWarning returns a human sentence about the audience, or "".
//
// Only called when scheduling, never when unscheduling: a campaign being pulled
// off the calendar does not need to be told its audience is empty.
func (d *Deps) scheduleAudienceWarning(ctx context.Context, tenantID string, c *Campaign) string {
	if d.Repo == nil || c == nil {
		return ""
	}
	item := d.Repo.checkRecipients(ctx, tenantID, c)
	switch item.Status {
	case CheckFail:
		// The checklist's own sentence, not a paraphrase. It already
		// distinguishes "no audience selected" from "zero eligible subscribers"
		// from "both a list and a segment", and restating those here would be a
		// second vocabulary for the same three conditions.
		detail := strings.TrimSpace(item.Detail)
		if detail == "" {
			return "this campaign has no sendable audience"
		}
		return detail
	case CheckWarn:
		// Legacy wiring with no counter: the audience could not be evaluated.
		// Reported, because "we could not check" is materially different from
		// "we checked and it is fine", and the calendar should not imply the
		// latter.
		detail := strings.TrimSpace(item.Detail)
		if detail == "" {
			return "this campaign's audience could not be verified"
		}
		return detail
	default:
		return ""
	}
}
