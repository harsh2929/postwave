// SPDX-License-Identifier: AGPL-3.0-only
package mobilepush

import (
	"strings"
	"testing"
)

// The channel id is a wire contract with the mobile client: Android drops a
// notification whose channel the device never created. The exhaustive
// event-for-event agreement is asserted from the client side (see
// apps/mobile/src/lib/pushChannelContract.test.ts, which parses this file);
// these cases pin the properties that side cannot see.
func TestAndroidChannelForEvent(t *testing.T) {
	cases := map[string]string{
		"auth.new_device_sign_in":  "security",
		"approval.requested":       "approvals",
		"campaign.sent":            "campaigns",
		"subscriber.bounced":       "subscribers",
		"subscriber.complained":    "subscribers",
		"automation.failed":        "automations",
		"sequence.generated":       "automations",
		"migration.completed":      "migrations",
		"form.submitted":           "forms",
		"":                         legacyAndroidChannel,
		"something.invented.later": legacyAndroidChannel,
	}
	for event, want := range cases {
		if got := androidChannelForEvent(event); got != want {
			t.Fatalf("androidChannelForEvent(%q) = %q, want %q", event, got, want)
		}
	}
}

func TestNewDeviceSignInNotificationContract(t *testing.T) {
	const event = "auth.new_device_sign_in"
	if !SupportsEvent(event) {
		t.Fatal("new-device sign-in is not eligible for native delivery")
	}
	if got := categoryForEvent(event); got != pushCategorySecurity {
		t.Fatalf("categoryForEvent(%q) = %q, want %q", event, got, pushCategorySecurity)
	}
	if got := androidChannelForEvent(event); got != "security" {
		t.Fatalf("androidChannelForEvent(%q) = %q, want security", event, got)
	}
	if got := interruptionLevelForEvent(event); got != interruptionTimeSensitive {
		t.Fatalf("interruptionLevelForEvent(%q) = %q, want %q", event, got, interruptionTimeSensitive)
	}
	if got := titleForEvent(event); got != "New sign-in to your Moosewave account" {
		t.Fatalf("titleForEvent(%q) = %q", event, got)
	}
	body := bodyForEvent(event)
	if body != "A new device signed in. Review active sessions if this wasn't you." {
		t.Fatalf("bodyForEvent(%q) = %q", event, body)
	}
	for _, forbidden := range []string{"cookie", "verifier", "device_code", "token="} {
		if strings.Contains(strings.ToLower(titleForEvent(event)+" "+body), forbidden) {
			t.Fatalf("security copy leaked forbidden field %q", forbidden)
		}
	}
}

// Approvals must never share a channel with high-volume traffic — the whole
// point of splitting them is that silencing bounces leaves approvals audible.
func TestApprovalChannelIsDistinct(t *testing.T) {
	approvals := androidChannelForEvent("approval.requested")
	for _, noisy := range []string{
		"subscriber.bounced", "campaign.opened", "form.submitted",
	} {
		if androidChannelForEvent(noisy) == approvals {
			t.Fatalf("%s shares the approvals channel %q", noisy, approvals)
		}
	}
	if approvals == legacyAndroidChannel {
		t.Fatalf("approvals fell through to the legacy channel")
	}
}

// NATIVE-V#1. The interruption level is set by the SENDER — a remote push has
// no client-side equivalent — and it was never set at all, so a Focus mode
// silenced an approval exactly as reliably as a campaign-open ping.
//
// The bar these tests hold is not "approvals are time-sensitive" but "ROUTINE
// TRAFFIC IS NOT". iOS shows the user a per-app time-sensitive switch; an app
// that marks bounces and form submissions urgent gets that switch turned off,
// and the approval push dies with it.
func TestInterruptionLevelIsReservedForBlockingEvents(t *testing.T) {
	timeSensitive := map[string]bool{
		"auth.new_device_sign_in": true,
		"approval.requested":      true,
		"billing.payment_failed":  true,
	}
	for event := range allowedDeviceEvents {
		got := interruptionLevelForEvent(event)
		want := interruptionActive
		if timeSensitive[event] {
			want = interruptionTimeSensitive
		}
		if got != want {
			t.Fatalf("interruptionLevelForEvent(%q) = %q, want %q", event, got, want)
		}
	}
}

func TestInterruptionLevelNeverEscalatesAnUnknownEvent(t *testing.T) {
	// An older server meeting a newer event name must not guess "urgent".
	for _, event := range []string{"", "something.invented.later", "critical"} {
		if got := interruptionLevelForEvent(event); got != interruptionActive {
			t.Fatalf("interruptionLevelForEvent(%q) = %q, want %q", event, got, interruptionActive)
		}
	}
}

// `critical` bypasses the ringer switch and needs an Apple-granted entitlement.
// Nothing here may ever emit it.
func TestInterruptionLevelNeverUsesCritical(t *testing.T) {
	for event := range allowedDeviceEvents {
		if interruptionLevelForEvent(event) == "critical" {
			t.Fatalf("%q was classified critical", event)
		}
	}
}

// The two new operational events must ride the channels the client registers,
// or Android drops them silently. The exhaustive event-for-event agreement is
// asserted from the client side; these pin the pair this change added.
func TestOperationalEventsHaveTheirOwnChannels(t *testing.T) {
	cases := map[string]string{
		"webhook.auto_disabled":  "integrations",
		"billing.payment_failed": "billing",
	}
	for event, want := range cases {
		if got := androidChannelForEvent(event); got != want {
			t.Fatalf("androidChannelForEvent(%q) = %q, want %q", event, got, want)
		}
		if !SupportsEvent(event) {
			t.Fatalf("%q is not in allowedDeviceEvents; the native channel would be skipped", event)
		}
		if titleForEvent(event) == "Moosewave update" {
			t.Fatalf("%q has no copy of its own", event)
		}
	}
	// The receiver URL of a webhook can be a capability. It must never appear
	// in copy the sender can render without context.
	if body := bodyForEvent("webhook.auto_disabled"); strings.Contains(body, "http") {
		t.Fatalf("auto-disable copy leaked a URL: %q", body)
	}
}
