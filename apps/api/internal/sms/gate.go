package sms

import (
	"fmt"
	"strings"
	"time"
)

func EvaluateGate(s GateSnapshot) GateDecision {
	segments := SegmentCount(s.Body)
	switch {
	case strings.TrimSpace(s.Body) == "":
		return GateDecision{Allowed: false, Reason: "empty_body", Segments: segments}
	case segments > 10:
		return GateDecision{Allowed: false, Reason: "too_many_segments", Segments: segments}
	case s.SenderPaused:
		return GateDecision{Allowed: false, Reason: "sender_paused", Segments: segments}
	case s.RegistrationStatus != RegistrationApproved:
		return GateDecision{Allowed: false, Reason: "sender_not_approved", Segments: segments}
	// A recipient suppression is already a complete, immutable reason not to
	// send. Report that authority before evaluating location-dependent timing
	// policy so a missing timezone cannot mask an opt-out or review hold in the
	// audit trail. This changes only the diagnostic: both branches fail closed.
	case s.Suppressed:
		return GateDecision{Allowed: false, Reason: "recipient_suppressed", Segments: segments}
	// The statutory floor is checked BEFORE the tenant's own window. Order is
	// load-bearing for the audit trail: when both apply we want the record to
	// say the send was blocked by the TCPA, not by a settings page the tenant
	// could have emptied.
	case s.StatutoryFloor.Blocked:
		decision := GateDecision{
			Allowed:  false,
			Reason:   string(s.StatutoryFloor.Reason),
			Segments: segments,
		}
		if !s.StatutoryFloor.Until.IsZero() {
			until := s.StatutoryFloor.Until
			decision.HoldUntil = &until
		}
		return decision
	case s.QuietHours:
		return GateDecision{Allowed: false, Reason: "quiet_hours", Segments: segments}
	case s.TenantLimitRemaining == 0:
		return GateDecision{Allowed: false, Reason: "tenant_limit_reached", Segments: segments}
	case s.SubscriptionStatus != SubscriptionOptedIn:
		return GateDecision{Allowed: false, Reason: "sms_consent_required", Segments: segments}
	default:
		return GateDecision{Allowed: true, Segments: segments}
	}
}

// QuietHoursActive accepts sender metadata shaped like:
// {"quiet_hours":{"timezone":"America/New_York","start":"20:00","end":"08:00"}}.
// Missing settings mean no sender policy. Once quiet_hours is present,
// malformed configuration is a blocking policy error: callers must not turn
// an unreadable legal/policy window into permission to send.
func QuietHoursActive(now time.Time, metadata map[string]any) bool {
	active, configured, _, err := senderQuietHoursState(now, metadata)
	return configured && (err != nil || active)
}

func senderQuietHoursState(now time.Time, metadata map[string]any) (active bool, configured bool, holdUntil time.Time, err error) {
	rawValue, exists := metadata["quiet_hours"]
	if !exists || rawValue == nil {
		return false, false, time.Time{}, nil
	}
	raw, ok := rawValue.(map[string]any)
	if !ok {
		return false, true, time.Time{}, fmt.Errorf("quiet_hours must be an object")
	}
	start := strings.TrimSpace(stringFromAny(raw["start"]))
	end := strings.TrimSpace(stringFromAny(raw["end"]))
	tz := strings.TrimSpace(stringFromAny(raw["timezone"]))
	if start == "" || end == "" || tz == "" {
		return false, true, time.Time{}, fmt.Errorf("quiet_hours requires start, end, and timezone")
	}
	loc, loadErr := time.LoadLocation(tz)
	if loadErr != nil {
		return false, true, time.Time{}, fmt.Errorf("quiet_hours timezone is invalid")
	}
	localNow := now.In(loc)
	startMinute, ok := minuteOfDay(start)
	if !ok {
		return false, true, time.Time{}, fmt.Errorf("quiet_hours start is invalid")
	}
	endMinute, ok := minuteOfDay(end)
	if !ok {
		return false, true, time.Time{}, fmt.Errorf("quiet_hours end is invalid")
	}
	current := localNow.Hour()*60 + localNow.Minute()
	endAt := func(dayOffset int) time.Time {
		return time.Date(localNow.Year(), localNow.Month(), localNow.Day()+dayOffset,
			endMinute/60, endMinute%60, 0, 0, loc).UTC()
	}
	if startMinute == endMinute {
		// A sender policy with equal boundaries is a continuously active
		// 24-hour window. Return the next local boundary so workers defer and
		// re-gate rather than terminally blocking the recipient.
		return true, true, endAt(1), nil
	}
	if startMinute < endMinute {
		if current >= startMinute && current < endMinute {
			return true, true, endAt(0), nil
		}
		return false, true, time.Time{}, nil
	}
	if current >= startMinute {
		return true, true, endAt(1), nil
	}
	if current < endMinute {
		return true, true, endAt(0), nil
	}
	return false, true, time.Time{}, nil
}

func SenderPaused(metadata map[string]any) bool {
	if truthyAny(metadata["paused"]) || truthyAny(metadata["sender_paused"]) {
		return true
	}
	if sending := mapFromAny(metadata["sending"]); len(sending) > 0 {
		return truthyAny(sending["paused"]) || truthyAny(sending["kill_switch"])
	}
	return false
}

func truthyAny(v any) bool {
	switch strings.ToLower(strings.TrimSpace(stringFromAny(v))) {
	case "1", "true", "yes", "y", "on":
		return true
	default:
		return false
	}
}

func minuteOfDay(value string) (int, bool) {
	parsed, err := time.Parse("15:04", strings.TrimSpace(value))
	if err != nil {
		return 0, false
	}
	return parsed.Hour()*60 + parsed.Minute(), true
}
