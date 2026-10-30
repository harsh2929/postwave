// SPDX-License-Identifier: AGPL-3.0-only

package sms

import (
	"strconv"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/recipient_tz_send"
	"github.com/postwave/postwave/apps/api/internal/send_time_opt"
)

// send_timing wires SMS campaigns into the platform's existing send-time
// infrastructure (SMS-037). Instead of a single global datetime, a campaign
// can request per-recipient delivery timing:
//
//   - recipient_tz: deliver at a fixed local wall-clock time in each
//     recipient's own timezone (recipient_tz_send.ResolveSendAt).
//   - sto:          deliver at each recipient's learned best send hour
//     (subscribers.best_send_hour, hour-of-week) via the same
//     send_time_opt.ScheduleByBestTime engine the email path uses.
//
// The mode rides on sms_campaigns.metadata (no migration). At send time
// each recipient's target UTC instant is stamped into
// sms_campaign_recipients.next_attempt_at; the worker already holds any
// row whose next_attempt_at is in the future (the same primitive that
// backs quiet-hours deferral), so no worker changes are required and
// there is no defer-loop.
const (
	scheduleModeFixed       = "fixed"
	scheduleModeRecipientTZ = "recipient_tz"
	scheduleModeSTO         = "sto"

	defaultLocalSendTime = "09:00"
	defaultFallbackTZ    = "UTC"
	defaultWithinDays    = 7

	// tenantMeanBestHour is the hour-of-week fallback for STO recipients
	// with no learned best hour, mirroring send_time_opt's documented
	// mean=9 default (Sunday 09:00 UTC bucket). ScheduleByBestTime clamps
	// the result into its 7–30 day search window.
	tenantMeanBestHour = 9
)

// scheduleMode captures the per-recipient send-timing options parsed from a
// campaign's metadata.
type scheduleMode struct {
	Mode       string
	LocalTime  string // "HH:MM", recipient_tz only
	FallbackTZ string // IANA tz for recipients with no known tz
	WithinDays int    // STO search window (days)
}

// scheduled reports whether the mode requires per-recipient timing (i.e. is
// anything other than the immediate/global fixed mode).
func (m scheduleMode) scheduled() bool {
	return m.Mode == scheduleModeRecipientTZ || m.Mode == scheduleModeSTO
}

// parseScheduleMode reads the send-timing options off campaign metadata,
// defaulting to fixed (immediate) and silently ignoring malformed values so a
// bad flag never blocks a send.
func parseScheduleMode(meta map[string]any) scheduleMode {
	m := scheduleMode{
		Mode:       scheduleModeFixed,
		LocalTime:  defaultLocalSendTime,
		FallbackTZ: defaultFallbackTZ,
		WithinDays: defaultWithinDays,
	}
	if meta == nil {
		return m
	}
	switch strings.TrimSpace(stringFromMeta(meta["schedule_mode"])) {
	case scheduleModeRecipientTZ:
		m.Mode = scheduleModeRecipientTZ
	case scheduleModeSTO:
		m.Mode = scheduleModeSTO
	}
	if v := strings.TrimSpace(stringFromMeta(meta["local_time"])); v != "" {
		if _, err := time.Parse("15:04", v); err == nil {
			m.LocalTime = v
		}
	}
	if v := strings.TrimSpace(stringFromMeta(meta["fallback_tz"])); v != "" {
		if _, err := time.LoadLocation(v); err == nil {
			m.FallbackTZ = v
		}
	}
	if v, ok := intFromMeta(meta["within_days"]); ok && v > 0 {
		m.WithinDays = v
	}
	return m
}

// computeSendAt returns the UTC instant at which a recipient should be
// released. Fixed mode — and any unresolvable timezone/best-hour — returns
// `now`, preserving immediate-send behavior (never a silent drop).
func computeSendAt(now time.Time, m scheduleMode, timezone string, bestHour *int) time.Time {
	switch m.Mode {
	case scheduleModeRecipientTZ:
		tz := strings.TrimSpace(timezone)
		if tz == "" {
			tz = m.FallbackTZ
		}
		loc, err := time.LoadLocation(tz)
		if err != nil {
			return now
		}
		localToday := now.In(loc).Format("2006-01-02")
		when, err := recipient_tz_send.ResolveSendAt(tz, localToday, m.LocalTime)
		if err != nil {
			return now
		}
		if !when.After(now) {
			// The local window already passed today — release tomorrow.
			localTomorrow := now.In(loc).Add(24 * time.Hour).Format("2006-01-02")
			next, nextErr := recipient_tz_send.ResolveSendAt(tz, localTomorrow, m.LocalTime)
			if nextErr != nil {
				return now
			}
			return next
		}
		return when
	case scheduleModeSTO:
		sched := send_time_opt.ScheduleByBestTime(now, m.WithinDays,
			[]send_time_opt.Recipient{{Email: "recipient", BestHour: bestHour}}, tenantMeanBestHour)
		if len(sched) == 1 {
			return sched[0].SendAt
		}
		return now
	default:
		return now
	}
}

// stringFromMeta coerces a metadata value to a string (JSON decodes strings as
// string; tolerate nothing else).
func stringFromMeta(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// intFromMeta coerces a metadata value (JSON number → float64, or a numeric
// string) to an int.
func intFromMeta(v any) (int, bool) {
	switch t := v.(type) {
	case float64:
		return int(t), true
	case int:
		return t, true
	case string:
		if n, err := strconv.Atoi(strings.TrimSpace(t)); err == nil {
			return n, true
		}
	}
	return 0, false
}
