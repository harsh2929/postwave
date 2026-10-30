// SPDX-License-Identifier: AGPL-3.0-only
package listmonk_events

import "testing"

func TestIsMachineOpen_NonOpenAlwaysFalse(t *testing.T) {
	cases := []string{"clicked", "bounced", "complained", "unsubscribed", ""}
	for _, ev := range cases {
		if IsMachineOpen(MachineOpenHints{EventType: ev, UserAgent: "applemail/mpp"}) {
			t.Fatalf("event_type %q must not be classified as machine open", ev)
		}
	}
}

func TestIsMachineOpen_SendGridFlag(t *testing.T) {
	h := MachineOpenHints{
		EventType:       "opened",
		ProviderSignals: map[string]any{"sg_machine_open": true},
	}
	if !IsMachineOpen(h) {
		t.Fatal("sg_machine_open=true should be machine")
	}
}

func TestIsMachineOpen_StringFlag(t *testing.T) {
	for _, val := range []string{"true", "1", "yes", "TRUE"} {
		h := MachineOpenHints{
			EventType:       "opened",
			ProviderSignals: map[string]any{"machine_open": val},
		}
		if !IsMachineOpen(h) {
			t.Fatalf("machine_open=%q should classify as machine", val)
		}
	}
}

func TestIsMachineOpen_AppleRelayUA(t *testing.T) {
	for _, ua := range []string{
		"Mozilla/5.0 (Macintosh) AppleMail/MPP",
		"icloud-content/1.0",
		"mail-privacy-proxy/1.0",
	} {
		h := MachineOpenHints{EventType: "opened", UserAgent: ua}
		if !IsMachineOpen(h) {
			t.Fatalf("UA %q should classify as machine", ua)
		}
	}
}

func TestIsMachineOpen_AppleRelayIP(t *testing.T) {
	for _, ip := range []string{"17.57.144.7", "17.121.10.10", "17.241.5.5"} {
		h := MachineOpenHints{EventType: "opened", IP: ip}
		if !IsMachineOpen(h) {
			t.Fatalf("IP %q should classify as machine", ip)
		}
	}
}

func TestIsMachineOpen_HumanGmailOpen(t *testing.T) {
	h := MachineOpenHints{
		EventType: "opened",
		UserAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) Gecko Chrome/120",
		IP:        "8.8.8.8",
	}
	if IsMachineOpen(h) {
		t.Fatal("real Chrome on non-Apple IP should not be machine")
	}
}

func TestIsMachineOpen_GoogleImageProxy(t *testing.T) {
	h := MachineOpenHints{EventType: "opened", UserAgent: "GoogleImageProxy ggpht.com"}
	if !IsMachineOpen(h) {
		t.Fatal("Google Image Proxy should classify as machine")
	}
}

func TestHintsFromCanonical(t *testing.T) {
	c := CanonicalEvent{
		EventType: EventOpened,
		UserAgent: "ua",
		IP:        "1.2.3.4",
		Source:    "sendgrid",
		Metadata:  map[string]any{"sg_machine_open": true},
	}
	h := HintsFromCanonical(c)
	if h.EventType != "opened" || h.UserAgent != "ua" || h.IP != "1.2.3.4" {
		t.Fatalf("lift mismatch: %+v", h)
	}
	if !IsMachineOpen(h) {
		t.Fatal("hints from canonical must roundtrip the machine flag")
	}
}
