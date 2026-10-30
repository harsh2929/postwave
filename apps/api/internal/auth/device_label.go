// SPDX-License-Identifier: AGPL-3.0-only
//
// device_label.go — the ONE user-agent parser.
//
// The active-sessions list existed but answered the wrong question. It
// returned a raw IP and a raw User-Agent string, so "is this login me?" —
// the only question that list is for — was unanswerable without reading a
// 140-character UA by eye. Every client then hand-rolled its own parser
// (apps/web's deviceLabel(), apps/mobile's src/lib/sessionDevice.ts), which
// guarantees the three surfaces eventually disagree about what the same row
// means.
//
// So the normalisation lives here, on the server, and ships inside
// SessionInfo. Clients render `device_label`; they do not parse.
//
// SCOPE, stated so nobody expects more than this gives:
//
//   - This is a heuristic over a self-reported header. A UA is trivially
//     forged. It is a RECOGNITION aid ("that's my iPhone"), never an
//     authorization input. Nothing in this package branches on it.
//   - No geo lookup. Approximate location genuinely helps answer "is this
//     me", but it needs a third-party IP database with its own update
//     cadence, licence, and privacy surface. That is a separate decision,
//     not a side effect of labelling devices.
//   - No third-party UA library. The matrix that matters for a B2B admin
//     console is small and stable (iOS/Android/macOS/Windows/Linux ×
//     Safari/Chrome/Firefox/Edge, plus our own apps and CLI), and a
//     hand-rolled table we can read beats a dependency we cannot.
//
// Ordering matters and is the whole trick: Edge's UA contains "Chrome",
// Chrome's contains "Safari", and every iPad since iPadOS 13 claims to be a
// Macintosh. Each matcher below therefore runs most-specific-first, and the
// tests pin that ordering.
package auth

import "strings"

// DeviceIdentity is the normalised, human-recognisable view of a
// User-Agent string. Every field is best-effort: an unrecognised (or
// absent) UA yields DeviceTypeUnknown and the "Unknown device" label
// rather than an error, because a session row must always render.
type DeviceIdentity struct {
	// Label is the display string, e.g. "Chrome on macOS", "Moosewave for
	// iOS", "Moosewave CLI". Always non-empty.
	Label string `json:"device_label"`
	// DeviceType is the coarse form factor a client picks an icon from.
	DeviceType string `json:"device_type"`
	// OS and Client are the parts, exposed separately so a client can
	// compose its own layout without re-parsing Label.
	OS     string `json:"device_os,omitempty"`
	Client string `json:"device_client,omitempty"`
}

// DeviceType values. A closed vocabulary: clients switch on these to pick
// an icon, so adding one is an API change and the constants make that
// visible.
const (
	DeviceTypeDesktop = "desktop"
	DeviceTypeMobile  = "mobile"
	DeviceTypeTablet  = "tablet"
	DeviceTypeCLI     = "cli"
	DeviceTypeBot     = "bot"
	DeviceTypeUnknown = "unknown"
)

// unknownDeviceLabel is what an empty or unrecognisable UA renders as. It
// is a real label, not an empty string, so the UI never shows a blank row.
const unknownDeviceLabel = "Unknown device"

// IdentifyDevice normalises a raw User-Agent header. Pure and total: it
// never errors and never returns an empty Label.
func IdentifyDevice(userAgent string) DeviceIdentity {
	ua := strings.TrimSpace(userAgent)
	if ua == "" {
		return DeviceIdentity{Label: unknownDeviceLabel, DeviceType: DeviceTypeUnknown}
	}
	lower := strings.ToLower(ua)

	// First-party clients identify themselves explicitly, so they are
	// matched before any browser heuristic. Our own UAs are the only ones
	// we control, and they are the labels users most need to recognise.
	if id, ok := identifyFirstParty(lower); ok {
		return id
	}
	if id, ok := identifyNonBrowser(lower); ok {
		return id
	}

	os, deviceType := identifyOS(lower)
	client := identifyBrowser(lower)

	switch {
	case client != "" && os != "":
		return DeviceIdentity{Label: client + " on " + os, DeviceType: deviceType, OS: os, Client: client}
	case client != "":
		return DeviceIdentity{Label: client, DeviceType: deviceType, Client: client}
	case os != "":
		return DeviceIdentity{Label: os, DeviceType: deviceType, OS: os}
	default:
		return DeviceIdentity{Label: unknownDeviceLabel, DeviceType: DeviceTypeUnknown}
	}
}

// identifyFirstParty matches the Moosewave-authored clients. Their UAs are
// set by us (apps/mobile sets a "Moosewave/<version> (iOS ...)" agent; the
// CLI and desktop shell do the same), so these are exact rather than
// heuristic.
func identifyFirstParty(lower string) (DeviceIdentity, bool) {
	// Keep recognising clients released under the former name while making
	// Moosewave the canonical identity emitted by every current client.
	if !strings.Contains(lower, "moosewave") && !strings.Contains(lower, "postwave") {
		return DeviceIdentity{}, false
	}
	switch {
	case strings.Contains(lower, "cli"):
		return DeviceIdentity{Label: "Moosewave CLI", DeviceType: DeviceTypeCLI, Client: "Moosewave CLI"}, true
	case strings.Contains(lower, "desktop") || strings.Contains(lower, "electron") || strings.Contains(lower, "tauri"):
		os, _ := identifyOS(lower)
		return DeviceIdentity{
			Label:      labelWithOS("Moosewave Desktop", os),
			DeviceType: DeviceTypeDesktop,
			OS:         os,
			Client:     "Moosewave Desktop",
		}, true
	case strings.Contains(lower, "ios") || strings.Contains(lower, "iphone") || strings.Contains(lower, "ipad"):
		deviceType := DeviceTypeMobile
		if strings.Contains(lower, "ipad") {
			deviceType = DeviceTypeTablet
		}
		return DeviceIdentity{
			Label:      "Moosewave for iOS",
			DeviceType: deviceType,
			OS:         "iOS",
			Client:     "Moosewave Mobile",
		}, true
	case strings.Contains(lower, "android"):
		return DeviceIdentity{
			Label:      "Moosewave for Android",
			DeviceType: DeviceTypeMobile,
			OS:         "Android",
			Client:     "Moosewave Mobile",
		}, true
	case strings.Contains(lower, "mobile"):
		// Native clients always send X-Postwave-Client, but some embedded
		// networking stacks omit the platform from User-Agent. Device-grant
		// capture canonicalises those requests to "Moosewave Mobile" so the
		// approval screen can still name the form factor without inventing an OS.
		return DeviceIdentity{
			Label:      "Moosewave Mobile",
			DeviceType: DeviceTypeMobile,
			Client:     "Moosewave Mobile",
		}, true
	}
	// A Moosewave UA we do not recognise the platform of is still ours, and
	// saying so beats falling through to a browser guess.
	return DeviceIdentity{Label: "Moosewave app", DeviceType: DeviceTypeUnknown, Client: "Moosewave"}, true
}

// identifyNonBrowser catches scripted callers. Worth naming rather than
// mislabelling: a curl session in this list is a real signal, and a bot UA
// on an operator account is a much stronger one.
func identifyNonBrowser(lower string) (DeviceIdentity, bool) {
	switch {
	case strings.HasPrefix(lower, "curl/"):
		return DeviceIdentity{Label: "curl", DeviceType: DeviceTypeCLI, Client: "curl"}, true
	case strings.HasPrefix(lower, "wget/"):
		return DeviceIdentity{Label: "wget", DeviceType: DeviceTypeCLI, Client: "wget"}, true
	case strings.Contains(lower, "python-requests") || strings.Contains(lower, "python-urllib"):
		return DeviceIdentity{Label: "Python script", DeviceType: DeviceTypeCLI, Client: "Python"}, true
	case strings.HasPrefix(lower, "go-http-client"):
		return DeviceIdentity{Label: "Go client", DeviceType: DeviceTypeCLI, Client: "Go"}, true
	case strings.HasPrefix(lower, "postmanruntime"):
		return DeviceIdentity{Label: "Postman", DeviceType: DeviceTypeCLI, Client: "Postman"}, true
	case strings.Contains(lower, "bot") || strings.Contains(lower, "crawler") || strings.Contains(lower, "spider"):
		return DeviceIdentity{Label: "Automated client", DeviceType: DeviceTypeBot, Client: "Bot"}, true
	}
	return DeviceIdentity{}, false
}

// identifyOS returns the display OS name plus the form factor it implies.
//
// Order is load-bearing:
//   - iPad/iPhone before "macintosh", because iPadOS 13+ Safari sends a
//     desktop Macintosh UA and is only distinguishable by the explicit
//     iPad token when present.
//   - "android" before "linux", because every Android UA also says Linux.
//   - "windows phone" before "windows".
func identifyOS(lower string) (name, deviceType string) {
	switch {
	case strings.Contains(lower, "ipad"):
		return "iPadOS", DeviceTypeTablet
	case strings.Contains(lower, "iphone") || strings.Contains(lower, "ipod"):
		return "iOS", DeviceTypeMobile
	case strings.Contains(lower, "android"):
		// Android tablets omit "Mobile" from the UA; phones include it.
		if strings.Contains(lower, "mobile") {
			return "Android", DeviceTypeMobile
		}
		return "Android", DeviceTypeTablet
	case strings.Contains(lower, "windows phone"):
		return "Windows Phone", DeviceTypeMobile
	case strings.Contains(lower, "windows"):
		return "Windows", DeviceTypeDesktop
	case strings.Contains(lower, "cros"):
		return "ChromeOS", DeviceTypeDesktop
	case strings.Contains(lower, "mac os x") || strings.Contains(lower, "macintosh"):
		return "macOS", DeviceTypeDesktop
	case strings.Contains(lower, "linux") || strings.Contains(lower, "x11"):
		return "Linux", DeviceTypeDesktop
	}
	return "", DeviceTypeUnknown
}

// identifyBrowser returns the display browser name, "" when unrecognised.
//
// Order is load-bearing: Edge's UA contains "Chrome" AND "Safari", Chrome's
// contains "Safari", and the iOS variants (CriOS/FxiOS/EdgiOS) contain none
// of the desktop tokens. Most specific first, always.
func identifyBrowser(lower string) string {
	switch {
	case strings.Contains(lower, "edg/") || strings.Contains(lower, "edga/") ||
		strings.Contains(lower, "edgios/") || strings.Contains(lower, "edge/"):
		return "Edge"
	case strings.Contains(lower, "opr/") || strings.Contains(lower, "opera"):
		return "Opera"
	case strings.Contains(lower, "samsungbrowser"):
		return "Samsung Internet"
	case strings.Contains(lower, "brave/"):
		return "Brave"
	case strings.Contains(lower, "vivaldi"):
		return "Vivaldi"
	case strings.Contains(lower, "crios/"):
		return "Chrome"
	case strings.Contains(lower, "fxios/") || strings.Contains(lower, "firefox"):
		return "Firefox"
	case strings.Contains(lower, "chromium"):
		return "Chromium"
	case strings.Contains(lower, "chrome/"):
		return "Chrome"
	case strings.Contains(lower, "safari"):
		return "Safari"
	}
	return ""
}

// labelWithOS composes "<client> on <os>", degrading to the client alone
// when the OS could not be determined.
func labelWithOS(client, os string) string {
	if os == "" {
		return client
	}
	return client + " on " + os
}
