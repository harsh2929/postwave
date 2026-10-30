// SPDX-License-Identifier: AGPL-3.0-only
//
// GAP-LS-084: MPP-aware engagement classification.
//
// Apple's Mail Privacy Protection (MPP, iOS 15+) silently pre-fetches
// the tracking pixel from an Apple-controlled relay, which means the
// `opened` event we receive in subscriber_events is generated whether
// or not the human ever opened the message. Every downstream metric
// that treats every open as a human signal (engagement_rate, list
// hygiene score, sunset triggers, frequency caps) is silently broken
// for the >70% of consumer mail clients on iOS today.
//
// Klaviyo's MPP guidance (https://seresa.io/blog/klaviyo-integration/
// apples-mpp-is-breaking-your-klaviyo-sunset-flow) recommends shifting
// engagement signals to clicks + on-site events; SendGrid surfaces
// machine opens explicitly via the `sg_machine_open` field on event
// webhook payloads (https://www.twilio.com/docs/sendgrid/for-developers/
// tracking-events/event).
//
// This helper is the single source of truth for "is this event a
// machine open" — every package that filters opens for engagement
// should call IsMachineOpen so the heuristics stay coherent.

package listmonk_events

import (
	"net"
	"strings"
)

// MachineOpenHints is the structured projection a caller passes in.
// Each field is optional; the classifier returns true on any signal.
//
// Source / WireType are deliberately separate so the same helper
// works at ingest time (CanonicalEvent in hand) AND at read time
// (subscriber_events row in hand) without forcing one shape on both.
type MachineOpenHints struct {
	// EventType is the canonical event type. Machine-open detection
	// only applies to "opened"; everything else returns false.
	EventType string

	// UserAgent is the X-User-Agent / User-Agent header from the
	// tracking-pixel hit. Lower-cased before comparison.
	UserAgent string

	// IP is the remote address that hit the tracking pixel (string
	// form; we parse internally). Apple's Privacy Cache uses a
	// well-known address range that is the strongest signal.
	IP string

	// ProviderSignals carries provider-side flags lifted out of the
	// event payload at ingest. Keys we recognise today:
	//   - "sg_machine_open"  (SendGrid event webhook)
	//   - "x-mailer-mpp"     (custom header surfaced by some ESPs)
	//   - "machine_open"     (Mailgun / Postmark normalised flag)
	// Values can be bool or string; any truthy value short-circuits
	// to "machine".
	ProviderSignals map[string]any

	// Source identifies the ESP / engine — when the field is one of
	// the providers that NEVER strips bots (legacy Listmonk pixel
	// without UA), we treat it as a non-MPP signal so the helper
	// doesn't false-positive on bare opens.
	Source string
}

// IsMachineOpen reports whether the given hints look like a machine /
// MPP / pre-fetch open rather than a human view. Conservative: false
// negatives (real opens occasionally counted as human) are preferred
// to false positives (real engagement silently dropped).
//
// Detection priority (first match wins):
//  1. Explicit ESP flag (sg_machine_open, machine_open, x-mailer-mpp).
//  2. Apple-Relay UA / known Apple Privacy Cache UA fingerprint.
//  3. IP in the Apple Privacy Relay published range (17.0.0.0/8 is
//     too broad — we use the 17.57.x.x subnet that the relay actually
//     hits from, plus 17.121/16 which appears in the public list).
//  4. Other known pre-fetch UAs (Google Image Proxy, Outlook Safe
//     Links image fetcher, mimecast pre-fetch).
func IsMachineOpen(h MachineOpenHints) bool {
	if !strings.EqualFold(h.EventType, "opened") {
		return false
	}

	// 1. Provider-supplied machine_open flags.
	if h.ProviderSignals != nil {
		for _, key := range machineOpenFlagKeys {
			if v, ok := h.ProviderSignals[key]; ok && truthy(v) {
				return true
			}
		}
	}

	ua := strings.ToLower(strings.TrimSpace(h.UserAgent))
	// 2. UA-based detection.
	for _, needle := range appleRelayUAFragments {
		if ua != "" && strings.Contains(ua, needle) {
			return true
		}
	}
	for _, needle := range otherPrefetchUAFragments {
		if ua != "" && strings.Contains(ua, needle) {
			return true
		}
	}

	// 3. IP-based detection (Apple Privacy Relay published subnets).
	if h.IP != "" {
		if ip := net.ParseIP(strings.TrimSpace(h.IP)); ip != nil {
			for _, n := range appleRelayNets {
				if n.Contains(ip) {
					return true
				}
			}
		}
	}

	return false
}

// machineOpenFlagKeys is the set of payload keys we treat as
// authoritative ESP-side machine-open signals. Lowercased; callers
// should normalise keys when populating ProviderSignals.
var machineOpenFlagKeys = []string{
	"sg_machine_open", // SendGrid event webhook
	"machine_open",    // Mailgun + Postmark normalised
	"x-mailer-mpp",    // custom header some ESPs surface
	"is_machine_open", // alternate phrasing used in some adapters
}

// appleRelayUAFragments is what shows up in the User-Agent header
// when MPP fetches the tracking pixel. Apple has shipped a few
// variants since iOS 15; we match the ones documented by Litmus +
// Mailgun + Postmark. Lowercased.
var appleRelayUAFragments = []string{
	"applemail/mpp",      // Mailgun's normalised label
	"apple-mail-mpp",     // alt phrasing
	"mac os x mail",      // iCloud relay sometimes presents this UA + Apple IP
	"icloud-content",     // observed in some MPP fetches
	"mail-privacy-proxy", // Postmark normalised label
}

// otherPrefetchUAFragments — non-Apple but still machine. We count
// these as machine opens too so cold-list calculations don't false-
// inflate engagement.
var otherPrefetchUAFragments = []string{
	"ggpht.com",         // Google image proxy (Gmail desktop pre-fetch)
	"googleimageproxy",  // alt
	"outlook-safelinks", // Microsoft SafeLinks scanner
	"outlook safelinks", // alt with space
	"mimecast",          // Mimecast inbound pre-fetch scanner
	"barracuda",         // Barracuda email security scanner
	"proofpoint",        // Proofpoint URL Defense pre-fetch
}

// appleRelayNets are the published Apple Privacy Cache ranges that
// originate MPP pixel fetches. We deliberately do NOT use 17.0.0.0/8
// (too broad — would match every Apple corporate egress); the more
// specific /16s below are what Apple actually uses for the relay.
var appleRelayNets = mustParseCIDRs(
	"17.57.144.0/24", // primary Apple Privacy Relay
	"17.57.145.0/24", // secondary
	"17.121.0.0/16",  // Apple iCloud relay published in their docs
	"17.241.0.0/16",  // newer Apple Privacy Relay expansion
)

func mustParseCIDRs(cidrs ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err == nil && n != nil {
			out = append(out, n)
		}
	}
	return out
}

func truthy(v any) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		s := strings.ToLower(strings.TrimSpace(x))
		return s == "true" || s == "1" || s == "yes"
	case int:
		return x != 0
	case int64:
		return x != 0
	case float64:
		return x != 0
	}
	return false
}

// HintsFromCanonical lifts the relevant fields out of a CanonicalEvent
// so callers at ingest time don't have to know which fields matter.
func HintsFromCanonical(c CanonicalEvent) MachineOpenHints {
	return MachineOpenHints{
		EventType:       string(c.EventType),
		UserAgent:       c.UserAgent,
		IP:              c.IP,
		ProviderSignals: c.Metadata,
		Source:          c.Source,
	}
}
