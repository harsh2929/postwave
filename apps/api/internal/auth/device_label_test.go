// SPDX-License-Identifier: AGPL-3.0-only

package auth

import "testing"

// TestIdentifyDeviceRealUserAgents pins the normalisation against real
// User-Agent strings. Every case here is a string an actual client sends;
// the ordering hazards (Edge contains "Chrome", Chrome contains "Safari",
// iPadOS claims to be a Macintosh, Android always says Linux) are the whole
// reason this table exists rather than a couple of contains() calls.
func TestIdentifyDeviceRealUserAgents(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		ua         string
		wantLabel  string
		wantType   string
		wantOS     string
		wantClient string
	}{
		{
			name:       "macOS Chrome",
			ua:         "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
			wantLabel:  "Chrome on macOS",
			wantType:   DeviceTypeDesktop,
			wantOS:     "macOS",
			wantClient: "Chrome",
		},
		{
			// The trap: this UA contains BOTH "Chrome" and "Safari".
			name:       "macOS Safari is not Chrome",
			ua:         "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
			wantLabel:  "Safari on macOS",
			wantType:   DeviceTypeDesktop,
			wantOS:     "macOS",
			wantClient: "Safari",
		},
		{
			// The trap: Edge's UA contains "Chrome" AND "Safari".
			name:       "Windows Edge is not Chrome",
			ua:         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87",
			wantLabel:  "Edge on Windows",
			wantType:   DeviceTypeDesktop,
			wantOS:     "Windows",
			wantClient: "Edge",
		},
		{
			name:       "Windows Firefox",
			ua:         "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
			wantLabel:  "Firefox on Windows",
			wantType:   DeviceTypeDesktop,
			wantOS:     "Windows",
			wantClient: "Firefox",
		},
		{
			name:       "Linux Firefox",
			ua:         "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
			wantLabel:  "Firefox on Linux",
			wantType:   DeviceTypeDesktop,
			wantOS:     "Linux",
			wantClient: "Firefox",
		},
		{
			name:       "iPhone Safari",
			ua:         "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
			wantLabel:  "Safari on iOS",
			wantType:   DeviceTypeMobile,
			wantOS:     "iOS",
			wantClient: "Safari",
		},
		{
			// The trap: Chrome on iOS is "CriOS", and there is no "Chrome/"
			// token at all.
			name:       "iPhone Chrome",
			ua:         "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
			wantLabel:  "Chrome on iOS",
			wantType:   DeviceTypeMobile,
			wantOS:     "iOS",
			wantClient: "Chrome",
		},
		{
			// The trap: iPadOS 13+ Safari sends "Macintosh" in desktop mode.
			// When the iPad token IS present we must prefer it.
			name:       "iPad reports iPadOS not macOS",
			ua:         "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
			wantLabel:  "Safari on iPadOS",
			wantType:   DeviceTypeTablet,
			wantOS:     "iPadOS",
			wantClient: "Safari",
		},
		{
			// The trap: every Android UA also contains "Linux".
			name:       "Android Chrome is Android not Linux",
			ua:         "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
			wantLabel:  "Chrome on Android",
			wantType:   DeviceTypeMobile,
			wantOS:     "Android",
			wantClient: "Chrome",
		},
		{
			// Android tablets omit the "Mobile" token.
			name:       "Android tablet",
			ua:         "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
			wantLabel:  "Chrome on Android",
			wantType:   DeviceTypeTablet,
			wantOS:     "Android",
			wantClient: "Chrome",
		},
		{
			name:       "Samsung Internet is not Chrome",
			ua:         "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
			wantLabel:  "Samsung Internet on Android",
			wantType:   DeviceTypeMobile,
			wantOS:     "Android",
			wantClient: "Samsung Internet",
		},
		{
			name:       "first-party iOS app wins over browser heuristics",
			ua:         "Moosewave/1.4.2 (iOS 17.5; iPhone15,3) Expo/51",
			wantLabel:  "Moosewave for iOS",
			wantType:   DeviceTypeMobile,
			wantOS:     "iOS",
			wantClient: "Moosewave Mobile",
		},
		{
			name:       "first-party Android app",
			ua:         "Moosewave/1.4.2 (Android 14; Pixel 8)",
			wantLabel:  "Moosewave for Android",
			wantType:   DeviceTypeMobile,
			wantOS:     "Android",
			wantClient: "Moosewave Mobile",
		},
		{
			name:       "first-party CLI",
			ua:         "postwave-cli/0.9.1 (darwin; arm64)",
			wantLabel:  "Moosewave CLI",
			wantType:   DeviceTypeCLI,
			wantClient: "Moosewave CLI",
		},
		{
			name:       "curl",
			ua:         "curl/8.6.0",
			wantLabel:  "curl",
			wantType:   DeviceTypeCLI,
			wantClient: "curl",
		},
		{
			name:       "Go client",
			ua:         "Go-http-client/2.0",
			wantLabel:  "Go client",
			wantType:   DeviceTypeCLI,
			wantClient: "Go",
		},
		{
			name:      "empty user agent still renders",
			ua:        "",
			wantLabel: unknownDeviceLabel,
			wantType:  DeviceTypeUnknown,
		},
		{
			name:      "whitespace-only user agent still renders",
			ua:        "   \t ",
			wantLabel: unknownDeviceLabel,
			wantType:  DeviceTypeUnknown,
		},
		{
			name:      "unparseable garbage still renders",
			ua:        "????",
			wantLabel: unknownDeviceLabel,
			wantType:  DeviceTypeUnknown,
		},
		{
			// OS with no recognised browser: label degrades to the OS alone
			// rather than to "Unknown device".
			name:      "known OS unknown browser",
			ua:        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) SomeNewEngine/1.0",
			wantLabel: "Windows",
			wantType:  DeviceTypeDesktop,
			wantOS:    "Windows",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := IdentifyDevice(tc.ua)
			if got.Label != tc.wantLabel {
				t.Errorf("Label = %q, want %q", got.Label, tc.wantLabel)
			}
			if got.DeviceType != tc.wantType {
				t.Errorf("DeviceType = %q, want %q", got.DeviceType, tc.wantType)
			}
			if tc.wantOS != "" && got.OS != tc.wantOS {
				t.Errorf("OS = %q, want %q", got.OS, tc.wantOS)
			}
			if tc.wantClient != "" && got.Client != tc.wantClient {
				t.Errorf("Client = %q, want %q", got.Client, tc.wantClient)
			}
		})
	}
}

// TestIdentifyDeviceNeverReturnsEmptyLabel is the invariant the sessions UI
// depends on: a row must always have something to render. Fuzz-ish sweep over
// shapes that have historically produced empty strings in hand-rolled parsers.
func TestIdentifyDeviceNeverReturnsEmptyLabel(t *testing.T) {
	t.Parallel()
	for _, ua := range []string{
		"", " ", "\n", "Mozilla/5.0", "()", "(((", "Mozilla/5.0 ()",
		"Safari", "chrome", "ANDROID", "Moosewave", "postwave",
		"Mozilla/5.0 (compatible; SomeBot/1.0; +http://example.test/bot)",
	} {
		got := IdentifyDevice(ua)
		if got.Label == "" {
			t.Errorf("IdentifyDevice(%q).Label is empty", ua)
		}
		if got.DeviceType == "" {
			t.Errorf("IdentifyDevice(%q).DeviceType is empty", ua)
		}
	}
}

// TestIdentifyDeviceIsCaseInsensitive proves the matcher normalises case, so
// a client that upper-cases its UA is not silently reclassified as unknown.
func TestIdentifyDeviceIsCaseInsensitive(t *testing.T) {
	t.Parallel()
	lower := IdentifyDevice("mozilla/5.0 (macintosh; intel mac os x 10_15_7) chrome/126.0.0.0 safari/537.36")
	upper := IdentifyDevice("MOZILLA/5.0 (MACINTOSH; INTEL MAC OS X 10_15_7) CHROME/126.0.0.0 SAFARI/537.36")
	if lower.Label != upper.Label {
		t.Fatalf("case changed the label: %q vs %q", lower.Label, upper.Label)
	}
	if lower.Label != "Chrome on macOS" {
		t.Fatalf("Label = %q, want %q", lower.Label, "Chrome on macOS")
	}
}

// TestSessionInfoCarriesDeviceLabel proves the normalisation actually reaches
// the wire shape — the point of AUTH#53 is that clients stop parsing, so a
// SessionInfo without a device_label would leave the finding open.
func TestSessionInfoCarriesDeviceLabel(t *testing.T) {
	t.Parallel()
	info := SessionInfo{
		ID:        "sess-1",
		UserAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
	}
	info.DeviceIdentity = IdentifyDevice(info.UserAgent)
	if info.Label != "Safari on iOS" {
		t.Fatalf("Label = %q, want %q", info.Label, "Safari on iOS")
	}
	if info.DeviceType != DeviceTypeMobile {
		t.Fatalf("DeviceType = %q, want mobile", info.DeviceType)
	}
	// The raw UA must survive: removing it would break any client that has
	// not migrated to device_label yet.
	if info.UserAgent == "" {
		t.Fatal("raw user_agent was dropped from the wire shape")
	}
}
