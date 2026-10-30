// SPDX-License-Identifier: AGPL-3.0-only
package campaigns

import (
	"context"
	"fmt"

	"github.com/postwave/postwave/apps/api/internal/sendingsettings"
)

// A campaign scheduled for more people than the tenant can send to in an hour.
//
// The audience warning answers "will this reach anybody". This answers the
// other half: "will it reach them WHEN the calendar says". A tenant with a
// 5,000/hour ceiling and a 200,000-person audience has booked a send that takes
// forty hours, and nothing on the schedule screen said so — the slot claims a
// time the send cannot keep, and the person finds out by watching a progress
// bar crawl.
//
// This row was parked on "capacity is unmodelled — there is no per-tenant
// sending-rate ceiling in the schema to validate a schedule against". That was
// true when written and is not now: `tenant_sending_settings.max_sends_per_hour`
// exists and the send-rate limiter already enforces it.
//
// ONE NOTION OF THE CEILING, for the same reason the audience check reuses
// `checkRecipients`. It asks `sendingsettings.Repo.CapResolver` — the resolver
// the rate limiter itself consumes — rather than reading the column here. A
// second reading would eventually disagree about the case that matters (a NULL,
// or a zero, both of which mean "no ceiling" and neither of which is obvious),
// and the disagreement would show up as a schedule that warned about a limit
// the sender does not apply, or stayed silent about one it does.
//
// Constructed inline from the pool rather than held as a field on Deps. A
// `CapResolver` field guarded by `if != nil` is the shape of a control that is
// inert because nobody assigned it in main.go, which this repository has
// already shipped once; there is nothing here to forget.
//
// IT WARNS, IT DOES NOT REFUSE — the same decision the audience check makes,
// and for a stronger reason. A long send is not a broken one: a nightly digest
// that takes six hours is somebody's deliberate design, and refusing it would
// make the calendar unusable for exactly the large sends most worth planning.
func (d *Deps) scheduleCapacityWarning(ctx context.Context, tenantID string, c *Campaign) string {
	if d.Repo == nil || d.Repo.Pool == nil || c == nil {
		return ""
	}
	cap, hasCap, err := (&sendingsettings.Repo{Pool: d.Repo.Pool}).CapResolver(ctx, tenantID)
	if err != nil || !hasCap || cap <= 0 {
		// No ceiling configured, or it could not be read. Silence is right here
		// and is NOT the same silence as "we checked and it fits": there is
		// nothing to check against. Inventing a default ceiling would warn
		// about a limit this tenant does not have.
		return ""
	}

	resolved, err := d.Repo.ResolveCampaignAudience(ctx, tenantID, c)
	if err != nil {
		// The audience warning already reports an unresolvable audience in the
		// checklist's own words. Saying it a second time here would put two
		// sentences about one problem on the same screen.
		return ""
	}
	recipients := len(resolved.Emails)
	if recipients <= cap {
		return ""
	}

	// Integer ceiling division: 5,001 recipients at 5,000/hour is two hours,
	// not one. Rounding down would under-report the overrun in exactly the
	// case that is only just over — the one somebody is most likely to accept
	// without checking.
	hours := (recipients + cap - 1) / cap
	return fmt.Sprintf(
		"this campaign's %d recipients exceed the %d/hour sending limit; the send will take about %d hours to finish",
		recipients, cap, hours,
	)
}
