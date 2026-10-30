// SPDX-License-Identifier: AGPL-3.0-only
package freq_caps

import (
	"strings"
	"testing"
)

func TestValidateCap_HappyPath(t *testing.T) {
	c := Cap{
		Channel:       "email",
		MessageType:   "marketing",
		MaxCount:      5,
		WindowSeconds: 86400,
		AppliesTo:     "all",
	}
	if err := ValidateCap(c); err != nil {
		t.Fatalf("good cap rejected: %v", err)
	}
}

func TestValidateCap_BadChannel(t *testing.T) {
	c := Cap{
		Channel:       "carrier-pigeon",
		MessageType:   "marketing",
		MaxCount:      1,
		WindowSeconds: 60,
		AppliesTo:     "all",
	}
	err := ValidateCap(c)
	if err == nil || !strings.Contains(err.Error(), "channel") {
		t.Fatalf("bad channel must be rejected: %v", err)
	}
}

func TestValidateCap_BadMessageType(t *testing.T) {
	c := Cap{
		Channel:       "email",
		MessageType:   "love-letter",
		MaxCount:      1,
		WindowSeconds: 60,
		AppliesTo:     "all",
	}
	err := ValidateCap(c)
	if err == nil || !strings.Contains(err.Error(), "message_type") {
		t.Fatalf("bad message type must be rejected: %v", err)
	}
}

func TestValidateCap_BadMaxCount(t *testing.T) {
	c := Cap{
		Channel: "email", MessageType: "marketing",
		MaxCount: 0, WindowSeconds: 60, AppliesTo: "all",
	}
	if err := ValidateCap(c); err == nil {
		t.Fatal("max_count=0 must be rejected")
	}
	c.MaxCount = 9999
	if err := ValidateCap(c); err == nil {
		t.Fatal("max_count over 1000 must be rejected")
	}
}

func TestValidateCap_BadWindow(t *testing.T) {
	c := Cap{
		Channel: "email", MessageType: "marketing",
		MaxCount: 1, WindowSeconds: 5, AppliesTo: "all",
	}
	if err := ValidateCap(c); err == nil {
		t.Fatal("window < 60s must be rejected")
	}
	c.WindowSeconds = 99999999
	if err := ValidateCap(c); err == nil {
		t.Fatal("window > 30d must be rejected")
	}
}

func TestValidateCap_BlankAppliesTo(t *testing.T) {
	c := Cap{
		Channel: "email", MessageType: "marketing",
		MaxCount: 1, WindowSeconds: 60, AppliesTo: "",
	}
	if err := ValidateCap(c); err == nil {
		t.Fatal("blank applies_to must be rejected")
	}
}

func TestValidateCap_Wildcards(t *testing.T) {
	c := Cap{
		Channel: "*", MessageType: "*",
		MaxCount: 100, WindowSeconds: 86400, AppliesTo: "all",
	}
	if err := ValidateCap(c); err != nil {
		t.Fatalf("wildcard channel/type must be accepted: %v", err)
	}
}

func TestContainsString(t *testing.T) {
	if !containsString([]string{"a", "b"}, "a") {
		t.Fatal("a should be found")
	}
	if containsString([]string{"a", "b"}, "c") {
		t.Fatal("c should not be found")
	}
}

func TestAllowedListsAreNonEmpty(t *testing.T) {
	if len(AllowedChannels) == 0 || len(AllowedMessageTypes) == 0 {
		t.Fatal("validation lists must not be empty")
	}
}
