// SPDX-License-Identifier: AGPL-3.0-only
package mobilepush

import (
	"encoding/json"
	"net/http"
	"regexp"

	"github.com/postwave/postwave/apps/api/internal/notifications"
)

const maxEventTypeBytes = 128

var (
	expoPushTokenRE = regexp.MustCompile(`^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9._=-]{1,256}\]$`)
	eventTypeRE     = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,127}$`)
)

func validExpoToken(token string) bool { return expoPushTokenRE.MatchString(token) }

func validEventType(eventType string) bool {
	return len(eventType) <= maxEventTypeBytes && eventTypeRE.MatchString(eventType)
}

const (
	pushCategoryApproval = "approval"
	pushCategorySecurity = "security"
	pushCategoryEntity   = "entity"
)

// categoryForEvent defers to the shared catalog.
//
// It used to hold its own switch. That switch was the ONLY place an event's
// actionable buttons were decided, and the in-app feed row — which had no
// actions column at all — could not agree with it even in principle. Now both
// read `notifications.ActionsForEvent`/`CategoryForEvent`, so adding an
// approval-style event gives it buttons on every surface or none.
//
// The local constants stay as the wire values; the test below pins them to the
// shared ones so a rename in either place is caught rather than silently
// producing a category no client has registered.
func categoryForEvent(eventType string) string {
	return notifications.CategoryForEvent(eventType)
}

// legacyAndroidChannel is the single channel every delivery used to be posted
// to. It stays registered on the client forever (notifications already sitting
// in a shade were posted against it) and is the fallback for an event the
// channel map does not know.
const legacyAndroidChannel = "default"

// androidChannelForEvent maps an event onto the Android notification channel it
// is delivered on. Channels are the ONLY notification control Android gives a
// person — importance, sound, vibration and "silence this" all hang off them —
// and this sender used to hardcode "default" for everything, so muting bounce
// pings also muted approval requests.
//
// The ids are a WIRE CONTRACT with the client: apps/mobile/src/lib/pushChannels.ts
// derives the same ids from the shared @postwave/notifications manifest, and
// apps/mobile/src/lib/pushChannelContract.test.ts fails if the two drift. An
// id that does not exist on the device means Android silently drops the
// notification, so never rename one without shipping the client first.
func androidChannelForEvent(eventType string) string {
	switch eventType {
	case "auth.new_device_sign_in":
		return "security"
	case "approval.requested", "approval.escalated":
		return "approvals"
	case "campaign.sent", "campaign.opened", "campaign.clicked",
		// Assurance runs are campaign-scoped, and the decision a person makes
		// about them is the same one they make about a campaign — so they share
		// the channel rather than adding a category nobody would tune apart.
		"assurance.run.blocked", "assurance.run.completed":
		return "campaigns"
	case "subscriber.created", "subscriber.confirmed", "subscriber.unsubscribed",
		"subscriber.bounced", "subscriber.complained":
		return "subscribers"
	case "automation.completed", "automation.failed", "sequence.generated",
		"sequence.participants.stuck":
		return "automations"
	case "deliverability.degraded", "deliverability.auto_throttled":
		return "deliverability"
	case "migration.completed", "migration.failed":
		return "migrations"
	case "form.submitted", "form.confirmed":
		return "forms"
	case "webhook.auto_disabled", "auditsink.circuit_opened":
		return "integrations"
	case "billing.payment_failed":
		return "billing"
	default:
		return legacyAndroidChannel
	}
}

// iOS interruption levels, as the Expo push API spells them.
//
//	passive        — no sound, no screen wake; Notification Center only.
//	active         — the system default: sound + banner unless a Focus is on.
//	time-sensitive — breaks through Focus and Do Not Disturb for 1 hour.
//	critical       — bypasses the mute switch entirely. Needs an Apple-granted
//	                 entitlement; deliberately never used here.
const (
	interruptionActive        = "active"
	interruptionTimeSensitive = "time-sensitive"
)

// interruptionLevelForEvent classifies an event for iOS Focus / Do Not Disturb
// (NATIVE-V#1).
//
// The product's marquee flow is "approve on your phone in seconds", and the
// exact OS mechanism that guarantees timely delivery — the interruption level —
// was the one field the envelope never set. Every push therefore arrived at the
// system default and was silenced by a Focus mode indiscriminately.
//
// ONLY URGENT, LOW-VOLUME EVENTS ARE TIME-SENSITIVE. The level is a
// privilege that costs the user's attention, and iOS surfaces a per-app switch
// for it: an app that marks routine traffic time-sensitive gets that switch
// turned off, taking the approval and security pushes down with it. The list is
// deliberately limited to a new account sign-in, an approval waiting on a
// decision, and a failed payment that risks a lapsed workspace. Everything
// else is explicitly `active`, which is the behaviour it already had.
//
// NOTE FOR THE CLIENT SIDE: time-sensitive delivery additionally requires the
// `com.apple.developer.usernotifications.time-sensitive` entitlement in the app
// build. Without it iOS silently degrades these to `active`, i.e. exactly
// today's behaviour — so shipping this server-side first is safe and is a
// strict improvement the moment the entitlement lands.
func interruptionLevelForEvent(eventType string) string {
	switch eventType {
	// approval.escalated is deliberately NOT here. The request already fires
	// time-sensitive, and the escalation is a second notification about the same
	// approval — marking both doubles the time-sensitive volume per approval.
	// This file'''s own test explains the cost: a user who sees too many of them
	// turns the switch off, "and the approval push dies with it".
	case "auth.new_device_sign_in", "approval.requested", "billing.payment_failed":
		return interruptionTimeSensitive
	default:
		return interruptionActive
	}
}

func titleForEvent(eventType string) string {
	switch eventType {
	case "auth.new_device_sign_in":
		return "New sign-in to your Moosewave account"
	case "subscriber.unsubscribed":
		return "Subscriber unsubscribed"
	case "subscriber.complained":
		return "Spam complaint received"
	case "subscriber.bounced":
		return "Subscriber bounced"
	case "campaign.sent":
		return "Campaign sent"
	case "approval.requested":
		return "Approval needed"
	case "approval.escalated":
		return "Approval overdue"
	case "automation.failed":
		return "Automation failed"
	case "sequence.generated":
		return "Sequence ready"
	case "sequence.participants.stuck":
		return "Participants stuck"
	case "deliverability.degraded":
		return "Deliverability degraded"
	case "deliverability.auto_throttled":
		return "Sending auto-throttled"
	case "migration.completed":
		return "Migration complete"
	case "migration.failed":
		return "Migration failed"
	case "form.submitted":
		return "Form submitted"
	case "webhook.auto_disabled":
		return "Webhook paused"
	case "auditsink.circuit_opened":
		return "Audit sink stopped"
	case "billing.payment_failed":
		return "Payment failed"
	case "assurance.run.blocked":
		return "Send blocked by assurance"
	case "assurance.run.completed":
		return "Assurance run finished"
	default:
		return "Moosewave update"
	}
}

func bodyForEvent(eventType string) string {
	switch eventType {
	case "auth.new_device_sign_in":
		return "A new device signed in. Review active sessions if this wasn't you."
	case "subscriber.unsubscribed":
		return "A subscriber opted out."
	case "subscriber.complained":
		return "A recipient marked an email as spam."
	case "subscriber.bounced":
		return "A message bounced for a subscriber."
	case "campaign.sent":
		return "A campaign finished sending."
	case "approval.requested":
		return "A pending request is waiting for your decision."
	case "automation.failed":
		return "An automation run failed and needs attention."
	case "sequence.generated":
		return "A generated sequence is ready to review."
	case "sequence.participants.stuck":
		// Never name the sequence or count anyone: the alert body carries
		// subscriber rows and the operator's own sequence label, and neither
		// belongs on a lock screen.
		return "People have been waiting in a sequence longer than its stuck threshold."
	case "deliverability.degraded":
		return "This workspace's deliverability score dropped below the healthy threshold."
	case "deliverability.auto_throttled":
		return "Moosewave reduced this workspace's send rate to protect sender reputation."
	case "migration.completed":
		return "Your migration finished importing."
	case "migration.failed":
		return "Your migration ran into a problem."
	case "form.submitted":
		return "Someone submitted a form."
	case "webhook.auto_disabled":
		// Never name the receiver URL — its path/query can be a capability.
		return "An outbound webhook was paused after repeated delivery failures."
	case "auditsink.circuit_opened":
		// Never name the sink URL — same capability risk as a webhook receiver.
		return "An audit sink stopped accepting events. New audit records are being held."
	case "billing.payment_failed":
		return "Your latest payment didn't go through. Update your payment method."
	case "assurance.run.blocked":
		// Never name the campaign or the refusal code. A blocked send means a
		// check found something — often a compliance or content problem — and
		// the specifics belong behind authentication, not on a lock screen.
		return "The assurance gate refused a send. Open the campaign to see why."
	case "assurance.run.completed":
		return "An assurance run finished and has a verdict."
	default:
		return "Open Moosewave for details."
	}
}

func writeJSONError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]map[string]string{
		"error": {"code": code, "message": message},
	})
}
