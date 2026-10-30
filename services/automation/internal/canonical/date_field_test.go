// SPDX-License-Identifier: AGPL-3.0-only
package canonical

import (
	"testing"
	"time"
)

func TestValidateDateField(t *testing.T) {
	good := AutomationTrigger{Type: TriggerDateField, Field: "birthday", TimeOfDay: "09:00", TZ: "UTC"}
	if err := ValidateDateField(good); err != nil {
		t.Fatalf("good rejected: %v", err)
	}
	bad := AutomationTrigger{Type: TriggerDateField, TimeOfDay: "09:00"}
	if err := ValidateDateField(bad); err == nil {
		t.Fatalf("missing field should fail")
	}
	wrong := AutomationTrigger{Type: "list_join", Field: "birthday"}
	if err := ValidateDateField(wrong); err == nil {
		t.Fatalf("wrong type should fail")
	}
	badTZ := AutomationTrigger{Type: TriggerDateField, Field: "birthday", TZ: "Not/Real"}
	if err := ValidateDateField(badTZ); err == nil {
		t.Fatalf("bad tz should fail")
	}
}

func TestMatchDateField_BirthdayToday(t *testing.T) {
	trig := AutomationTrigger{Type: TriggerDateField, Field: "birthday", OffsetDays: 0, TZ: "UTC"}
	now := time.Date(2026, 5, 3, 10, 0, 0, 0, time.UTC)
	if !MatchDateField(trig, "1990-05-03", now) {
		t.Fatalf("same month+day should match")
	}
	if MatchDateField(trig, "1990-05-04", now) {
		t.Fatalf("different day should not match")
	}
	if MatchDateField(trig, "", now) {
		t.Fatalf("empty value should not match")
	}
}

func TestMatchDateField_OffsetDays(t *testing.T) {
	// "Anniversary in 7 days" — fires today when the stored date is 7
	// days from now's calendar.
	trig := AutomationTrigger{Type: TriggerDateField, Field: "anniversary", OffsetDays: 7, TZ: "UTC"}
	now := time.Date(2026, 5, 3, 9, 0, 0, 0, time.UTC)
	if !MatchDateField(trig, "2024-05-10", now) {
		t.Fatalf("offset+7 from May 3 should match May 10")
	}
	if MatchDateField(trig, "2024-05-09", now) {
		t.Fatalf("offset+7 from May 3 should not match May 9")
	}
}
