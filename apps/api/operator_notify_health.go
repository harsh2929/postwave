// SPDX-License-Identifier: AGPL-3.0-only

package main

// operator_notify_health.go — the HEALTH operator-alert adapters.
//
// Sibling of operator_notify_alerts.go and bound by the same hard rule:
//
//	NEVER WIDEN THE AUDIENCE, AND NEVER PUT CUSTOMER ROWS IN A PAYLOAD.
//
// Split into its own file rather than appended to that one because these two
// bridges answer a different question. The alerts file announces DISCRETE
// FAILURES with an obvious owner — a charge declined, a sink's breaker opened.
// These announce DEGRADED HEALTH: a score that drifted below a threshold, a
// send rate the platform quietly cut, a journey where nothing failed and
// nothing is moving. Health alerts are the ones that get missed, because
// there is no error anywhere for a human to trip over.
//
// AUDIENCE, VERIFIED AT BOTH LAYERS. Every alert here goes to owner+admin
// (`adminUserIDs`), which for each of them is strictly NARROWER than who may
// already read the same facts:
//
//   - GET /api/v1/deliverability/hub — mount site wraps
//     apikeys.RequireScope(ScopeReadReports); routeauth manifest.json records
//     session_minimum_role "viewer", api_key_scopes ["read:reports"]. The
//     throttle it reports is CLEARED by POST /api/v1/deliverability/repair/
//     override, which is admin at the mount site and admin in the manifest —
//     so owner+admin is exactly the set that can act.
//   - GET /api/v1/voice/sequences/{id}/stuck — mount site wraps
//     apikeys.RequireAllScopes(ScopeReadCampaigns, ScopeReadSubscribers);
//     manifest records session_minimum_role "viewer" with scope_mode "all".
//
// So nothing here discloses anything a recipient could not already fetch; it
// only tells the people who can fix it, without their having to look.

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/deliverability_hub"
	"github.com/postwave/postwave/apps/api/internal/notifyfanout"
	"github.com/postwave/postwave/apps/api/internal/webhooks"
)

// Compile-time proof that the adapter still satisfies the two producer-side
// contracts. main.go assigns these by field, so a signature drift would
// otherwise surface as "the alert stopped being wired" — silently, and only in
// production, which is the exact failure mode these alerts exist to prevent.
var (
	_ deliverability_hub.HealthNotifier = (*operatorNotifyAdapter)(nil)
	_ webhooks.CrossServiceNotifier     = (*operatorNotifyAdapter)(nil)
)

// NotifyDeliverabilityDegraded implements deliverability_hub.HealthNotifier —
// DELIVERABILITY#15.
//
// Fires on the DOWNWARD crossing of the degraded threshold only, which is what
// makes it notifiable: the condition then persists for hours or days, and the
// hub worker recomputes hourly. An alert per recompute would be an hourly ping
// about a fact the operator already acted on, and the reliable outcome of that
// is a silenced category.
//
// Runs inline: the caller is the hub worker's per-tenant loop, already off any
// request path.
func (a *operatorNotifyAdapter) NotifyDeliverabilityDegraded(ctx context.Context, in deliverability_hub.HealthAlert) error {
	if a == nil || a.Fanout == nil || in.TenantID == "" {
		return fmt.Errorf("deliverability operator notify: adapter, fanout, and tenant are required")
	}
	admins, err := a.adminUserIDsResult(ctx, in.TenantID)
	if err != nil {
		return fmt.Errorf("deliverability operator notify: list admins: %w", err)
	}
	if len(admins) == 0 {
		return nil
	}
	deliveries := a.Fanout.Dispatch(ctx, in.TenantID, admins, deliverabilityDegradedEvent(in))
	if len(deliveries) != len(admins) {
		return fmt.Errorf(
			"deliverability operator notify: persisted %d of %d admin notifications",
			len(deliveries),
			len(admins),
		)
	}
	return nil
}

// deliverabilityDegradedEvent builds the dispatched event.
//
// PURE, AND SEPARATE FROM THE ADAPTER ON PURPOSE. Everything worth asserting
// about this notification — that a bearer-free in-app URL is the destination,
// that the native body carries no measured rate, that the dedupe identity
// re-arms after a recovery — lives in this value, while the method around it
// needs a live pgxpool to resolve recipients. Splitting them means the tests
// exercise the REAL construction instead of a copy of it maintained beside the
// assertions.
func deliverabilityDegradedEvent(in deliverability_hub.HealthAlert) notifyfanout.Event {
	// The breach TITLE is our own fixed copy from scoreHub ("Bounce rate above
	// 2%"), not tenant text and not a measured rate — safe to name. The
	// observed rates, the remediation prose and the breach list stay behind the
	// screen this notification opens.
	body := "This workspace's deliverability score fell to " +
		strconv.Itoa(in.Score) + " (grade " + gradeLabel(in.Grade) + ")."
	if in.TopBreachTitle != "" {
		body += " " + in.TopBreachTitle + "."
	}
	payload := map[string]any{
		"score":          in.Score,
		"previous_score": in.PreviousScore,
		"breach_count":   in.BreachCount,
	}
	if in.TopBreachCode != "" {
		payload["top_breach_code"] = in.TopBreachCode
	}
	return notifyfanout.Event{
		Type:  "deliverability.degraded",
		Title: "Deliverability degraded",
		Body:  body,
		// Content-light on the wire: a lock screen gets the fact, not the
		// number. The score is a business metric and the feed already has it.
		MobileBody: "This workspace's deliverability score dropped below the healthy threshold.",
		URL:        "/app/deliverability",
		// Account health has no entity id — the hub screen IS the target, and
		// the shared manifest records deepLinkEntity: null to match.
		EntityID: "",
		// The immutable claim identity collapses a crash retry while allowing a
		// later incident through even if it repeats the exact same scores.
		DedupeKey: "deliverability.degraded:" + in.IncidentID,
		Payload:   payload,
	}
}

// NotifyDeliverabilityAutoThrottled implements deliverability_hub.HealthNotifier
// — DELIVERABILITY#15, and the half of it that actually costs money.
//
// This is the only notification in the product that reports an action taken
// AGAINST the workspace rather than a measurement of it: the reputation-repair
// worker has already halved max_sends_per_hour. Before this, the sole way to
// find out was to open the hub screen and read `auto_throttled`, so the usual
// discovery path was a customer asking why the campaign was crawling.
//
// Exactly one per incident. `applyAutoThrottle` refuses to write a second
// override row while an uncleared one exists, so the throttle cannot re-fire
// until an admin clears it through POST /api/v1/deliverability/repair/override.
func (a *operatorNotifyAdapter) NotifyDeliverabilityAutoThrottled(ctx context.Context, in deliverability_hub.ThrottleAlert) {
	if a == nil || a.Fanout == nil || in.TenantID == "" {
		return
	}
	admins := a.adminUserIDs(ctx, in.TenantID)
	if len(admins) == 0 {
		return
	}
	a.Fanout.Dispatch(ctx, in.TenantID, admins, deliverabilityAutoThrottledEvent(in))
}

// deliverabilityAutoThrottledEvent builds the dispatched event. Pure, for the
// same reason deliverabilityDegradedEvent is.
func deliverabilityAutoThrottledEvent(in deliverability_hub.ThrottleAlert) notifyfanout.Event {
	// Say what the new cap IS. "Sending was throttled" without a number leaves
	// the operator unable to judge whether tonight's send still fits.
	body := "Moosewave reduced this workspace's send rate to " +
		strconv.Itoa(in.ThrottledSendsPerHour) +
		" emails per hour to protect sender reputation."
	payload := map[string]any{
		"score":                    in.Score,
		"throttled_sends_per_hour": in.ThrottledSendsPerHour,
	}
	if in.PriorSendsPerHour > 0 {
		// Only when a cap was genuinely in force. When the workspace had none
		// the worker substituted a conservative default, and reporting that
		// invented number as a "prior" would be a fabricated measurement.
		payload["prior_sends_per_hour"] = in.PriorSendsPerHour
	}
	return notifyfanout.Event{
		Type:       "deliverability.auto_throttled",
		Title:      "Sending auto-throttled",
		Body:       body,
		MobileBody: "Moosewave reduced this workspace's send rate to protect sender reputation.",
		URL:        "/app/deliverability",
		EntityID:   "",
		// The immutable override identity collapses a replay and re-arms after
		// clear/reapply even when the score and cap repeat exactly.
		DedupeKey: "deliverability.auto_throttled:" + in.IncidentID,
		Payload:   payload,
	}
}

// gradeLabel bounds the grade letter before it reaches copy. scoreHub only ever
// produces "A".."F", but this string is concatenated into a notification body
// and the cost of being wrong about that is a malformed push, so it is checked
// rather than trusted.
func gradeLabel(grade string) string {
	switch grade {
	case "A", "B", "C", "D", "F":
		return grade
	default:
		return "?"
	}
}

// maxStuckSequenceNameChars bounds the operator's own sequence label before it
// is concatenated into notification copy.
const maxStuckSequenceNameChars = 60

// stuckAlertBody is the parsed subset of the voice stuck-scanner payload.
//
// NOTE WHAT IS NOT HERE: `items`. The scanner embeds up to 20 stuck
// participants — subscriber identities and their idle times — in the alert
// body, because a webhook receiver is the tenant's own system. A notification
// is not: it lands on lock screens and in a feed that syncs to every device the
// team owns. The count is the actionable part; the rows live behind the screen.
type stuckAlertBody struct {
	SequenceID    string `json:"sequence_id"`
	SequenceName  string `json:"sequence_name"`
	StuckCount    int    `json:"stuck_count"`
	ThresholdDays int    `json:"threshold_days"`
}

// NotifyCrossServiceEvent implements webhooks.CrossServiceNotifier —
// AUTOMATION#41.
//
// Sibling services announce by writing a `webhook.fanout` outbox row, and every
// consumer of that row until now delivered to a destination the TENANT
// configured. This routes the operational subset onto the first-party
// chokepoint so the team's own feed, browsers and phones are told too.
//
// A BOUNDED SET, BY DESIGN. The default arm is silence: a cross-service event
// this function does not name must not become a notification just because a
// service started emitting it. Widening the set is a deliberate edit here, and
// it also requires the event to exist in the shared @postwave/notifications
// manifest, in mobilepush's device allowlist, and in mobile's Android channel
// map — or Android drops the delivery against a channel the handset never
// created.
func (a *operatorNotifyAdapter) NotifyCrossServiceEvent(ctx context.Context, tenantID, eventType string, body json.RawMessage) {
	if a == nil || a.Fanout == nil || tenantID == "" {
		return
	}
	if eventType != string(webhooks.EventSequenceParticipantsStuck) {
		return
	}
	a.notifyParticipantsStuck(ctx, tenantID, body)
}

// notifyParticipantsStuck fans the voice stuck-scanner alert to owner+admin.
//
// The condition this reports is the quiet one: nothing failed, nothing errored,
// and people have simply stopped moving through a journey. `automation.failed`
// cannot cover it — there is no failed run to report — which is why the scanner
// existed and why its output reaching nobody was the whole defect.
func (a *operatorNotifyAdapter) notifyParticipantsStuck(ctx context.Context, tenantID string, raw json.RawMessage) {
	var in stuckAlertBody
	if err := json.Unmarshal(raw, &in); err != nil {
		if a.Logger != nil {
			a.Logger.Warn("operator notify: malformed stuck alert payload",
				"tenant_id", tenantID, "err", err.Error())
		}
		return
	}
	ev, ok := participantsStuckEvent(in, time.Now().UTC())
	if !ok {
		return
	}
	admins := a.adminUserIDs(ctx, tenantID)
	if len(admins) == 0 {
		return
	}
	a.Fanout.Dispatch(ctx, tenantID, admins, ev)
}

// participantsStuckEvent turns one scanner payload into the dispatched event,
// or reports that there is nothing to send.
//
// Pure and clock-injected so the day-bucketed dedupe identity is assertable
// without waiting for midnight. `ok == false` means "stay silent", and it
// covers three genuinely different reasons:
//
//   - no sequence id: the notification's whole value is landing on the journey
//     it names, and there is nothing to open;
//   - an id that is not a safe URL path segment: `/app/sequences/<id>` is
//     concatenated into the feed deep link and the web-push URL, so an id
//     carrying a slash, a scheme or traversal would mint a link pointing
//     somewhere the alert is not about. This mirrors route-map's
//     `isSafeResourceId`, which is the same guard every client applies to the
//     other end of that link;
//   - zero stuck participants: the scanner does not emit in that case, but a
//     notification asserting that nobody is stuck would be a fabricated
//     measurement if it ever did.
func participantsStuckEvent(in stuckAlertBody, now time.Time) (notifyfanout.Event, bool) {
	if !safeResourceID(in.SequenceID) || in.StuckCount <= 0 {
		return notifyfanout.Event{}, false
	}
	label := boundedLabel(in.SequenceName, maxStuckSequenceNameChars)
	body := plural(in.StuckCount, "person", "people") + " stopped progressing"
	if label != "" {
		body += " in “" + label + "”"
	}
	if in.ThresholdDays > 0 {
		body += " for more than " + plural(in.ThresholdDays, "day", "days")
	}
	body += "."
	return notifyfanout.Event{
		Type:  "sequence.participants.stuck",
		Title: "Participants stuck",
		Body:  body,
		// Content-light on the wire: the sequence label is the tenant's own
		// text and the count is their audience data. The id in EntityID is
		// enough for the tap to land on the right screen.
		MobileBody: "People have been waiting in a sequence longer than its stuck threshold.",
		URL:        "/app/sequences/" + in.SequenceID,
		EntityID:   in.SequenceID,
		// ONE ALERT PER SEQUENCE PER DAY. The scanner is stateless and
		// re-alerts on every sweep (24h by default, and it sweeps once
		// immediately on start — so a crash-looping voice service would
		// otherwise emit a fanout row per restart). The day bucket collapses
		// both that and outbox at-least-once retries, while still letting a
		// condition that is still true tomorrow say so again.
		DedupeKey: "sequence.participants.stuck:" + in.SequenceID + ":" +
			now.UTC().Format("2006-01-02"),
		Payload: map[string]any{
			"sequence_id": in.SequenceID,
			"stuck_count": in.StuckCount,
		},
	}, true
}

// safeResourceID mirrors @postwave/route-map's isSafeResourceId: an id is a URL
// PATH SEGMENT on every surface, so anything that could smuggle a second
// segment, a scheme or a traversal is rejected rather than escaped.
func safeResourceID(id string) bool {
	if id == "" || len(id) > 128 {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// boundedLabel trims tenant-authored text to a notification-safe length.
// Returns "" for anything empty so callers can drop the clause entirely rather
// than render an empty pair of quotes.
//
// Counted in RUNES, not bytes. A sequence named in Japanese or with an emoji
// would be cut mid-codepoint by a byte slice, and the replacement character
// that produces is the kind of thing a person screenshots.
func boundedLabel(s string, max int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// plural renders "1 person" / "4 people" so the copy never reads "1 people".
// Small, but this string is the first thing an operator sees on a lock screen.
func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return strconv.Itoa(n) + " " + many
}
