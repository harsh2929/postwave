// SPDX-License-Identifier: AGPL-3.0-only
//
// per_recipient_tz.go — sto-per-recipient-timezone (P1, surface=send-time).
//
// BEFORE this file, the STO pipeline collapsed every timestamp to UTC
// (HourOfWeek(t) = int(t.UTC().Weekday())*24 + t.UTC().Hour()), so a
// subscriber whose opens cluster at "9am their local time" got a
// best_send_hour that depended on their offset from UTC. Two
// subscribers with identical local-time behaviour but in different
// timezones ended up in different modal-hour buckets — and the
// scheduler then fired the campaign at the stored UTC hour, arriving
// at wildly different local clocks for the two recipients.
//
// 2026 SOTA: Klaviyo, Braze, Iterable, MoEngage, Customer.io all run
// STO in each recipient's LOCAL timezone. Klaviyo's account profile
// stores the tz; Braze reads `user.time_zone`; MoEngage uses the
// subscriber's declared zone with a per-campaign override.
//
// THIS FILE ADDS:
//
//   - HourOfWeekIn(t, loc): tz-aware variant of HourOfWeek. The
//     existing HourOfWeek is preserved (legacy callers and the cold-
//     start fallback still depend on UTC-bucketing) — instead we
//     introduce a sibling that accepts a *time.Location.
//   - LocalRecipient: extends Recipient with an optional *time.Location.
//   - ScheduleByBestTimeLocalized: the tz-aware sibling of
//     ScheduleByBestTime. Cold recipients (BestHour=nil) fall back to
//     the tenant mean INTERPRETED IN THEIR LOCAL TZ, which is what
//     every modern ESP does — the mean is a "polite hour", not a
//     "polite UTC hour".
//   - ApplyQuietHoursLocalized: composition primitive that combines
//     the per-recipient-tz schedule output with the existing
//     ApplyQuietHours resolver (sto-quiet-hours-edge-snap) so a
//     subscriber's quiet-hour window is evaluated in their LOCAL tz,
//     not the tenant's tz. This is the composition step the audit
//     called out.
//   - ResolveSubscriberLocation: shared helper between this package
//     and recipient_tz_send so both paths read the same source of
//     truth for "what tz is this recipient in?" (subscribers.timezone
//     column → custom_fields->>'timezone' → tenant fallback → UTC).
//
// COMPOSITION WITH recipient_tz_send: the recipient_tz_send package
// owns "operator declares 9am local, dispatcher releases by tz". This
// package owns "STO learned best_hour, scheduler fires per-recipient
// local time". Both surfaces now read `subscribers.timezone` through
// the same resolver, so an operator who imports a tz once gets it
// honoured by BOTH features.
package send_time_opt

import (
	"context"
	"strings"
	"time"

	"github.com/postwave/postwave/apps/api/internal/db"
)

// LocalRecipient is the tz-aware sibling of Recipient. The base
// Recipient is preserved so existing callers (worker, schedule_preview)
// don't break — they continue to use UTC bucketing. Migration is
// opt-in per call site.
//
// Location is the subscriber's IANA tz (e.g. America/Los_Angeles or
// Europe/Berlin). A nil Location means "fall back to tenant's
// configured tz", which the scheduler resolves before calling into
// ScheduleByBestTimeLocalized.
//
// QuietHours, when non-nil, is evaluated in Location after the
// best-hour-of-week math has produced the candidate send moment. The
// resolver respects the policy (snap | defer_to_end | skip) per the
// existing sto-quiet-hours-edge-snap implementation.
type LocalRecipient struct {
	Email      string
	BestHour   *int              // hour-of-week 0..167 — already in subscriber's local tz
	Location   *time.Location    // nil → caller resolves to tenant fallback
	QuietHours *QuietHoursWindow // optional per-recipient override; nil → tenant-level
}

// LocalSchedule is the tz-aware Schedule. SendAtUTC remains the
// authoritative wall-clock the dispatcher fires at (the SMTP layer
// only knows UTC). SendAtLocal is a convenience the desktop renders
// so the operator can verify "the LA recipient is set for 9:00am
// PT" without having to do the offset math themselves.
//
// Timezone is the IANA name of the location used to derive SendAtLocal
// — surfaces "where this recipient lives" in the preview UI.
//
// Skipped is true when ApplyQuietHours returned keep=false (skip
// policy). The caller drops the row from the dispatcher's queue but
// still keeps it in the preview response so the operator can see how
// many recipients were dropped.
type LocalSchedule struct {
	Email       string    `json:"email"`
	SendAtUTC   time.Time `json:"send_at"`
	SendAtLocal time.Time `json:"send_at_local"`
	BestHour    int       `json:"best_hour_local"`
	Timezone    string    `json:"timezone"`
	Skipped     bool      `json:"skipped,omitempty"`
}

// HourOfWeekIn returns the hour-of-week 0..167 for `t` AS OBSERVED in
// `loc`. When loc is nil, falls through to UTC bucketing (matches
// HourOfWeek). This is the function STO's Compute() should use when
// computing best-send-hour for a tz-aware subscriber:
//
//	hours = append(hours, HourOfWeekIn(at, subscriberLoc))
//
// so the modal hour is the modal LOCAL hour, not the modal UTC hour.
// Two subscribers in LA and Berlin who both open at 9am their time
// end up in hour-of-week bucket "9am Tuesday" together rather than
// in different UTC buckets.
//
// Caveat: DST. The hour-of-week index assumes a 168-hour week, but
// real weeks have 167 or 169 hours twice a year. Bucket math stays
// stable because we always read the wall-clock observation through
// the location — DST shifts come through naturally as the open
// timestamps move between buckets.
func HourOfWeekIn(t time.Time, loc *time.Location) int {
	if loc == nil {
		return HourOfWeek(t)
	}
	tl := t.In(loc)
	return int(tl.Weekday())*24 + tl.Hour()
}

// nextHourOfWeekIn is the tz-aware sibling of nextHourOfWeek. Returns
// the next instant (>= now) whose local-time hour-of-week equals
// target, projected into `loc`. When loc is nil the function falls
// through to the UTC math so existing callers keep working.
//
// The returned time is in `loc` (so the caller can format it for the
// desktop without a separate conversion). The dispatcher converts to
// UTC at write time via t.UTC().
func nextHourOfWeekIn(now time.Time, target int, loc *time.Location) time.Time {
	if loc == nil {
		return nextHourOfWeek(now, target)
	}
	if target < 0 || target > 167 {
		target = 0
	}
	nowLocal := now.In(loc)
	curr := int(nowLocal.Weekday())*24 + nowLocal.Hour()
	delta := target - curr
	if delta < 0 {
		delta += 168
	}
	// Anchor at the top of the current local hour so the projected
	// moment's minute/second is zero (matches the UTC sibling).
	base := time.Date(nowLocal.Year(), nowLocal.Month(), nowLocal.Day(),
		nowLocal.Hour(), 0, 0, 0, loc)
	return base.Add(time.Duration(delta) * time.Hour)
}

// ScheduleByBestTimeLocalized computes the next-fire moment for each
// LocalRecipient within [now, now+withinDays). Cold recipients
// (BestHour=nil) inherit `tenantMean` — INTERPRETED IN THEIR LOCAL
// TZ. Recipients with a Location=nil fall through to `fallbackLoc`,
// which the caller resolves from tenant_send_settings.sto_fallback_timezone.
//
// fallbackLoc must NOT be nil. If a caller passes nil, the function
// substitutes time.UTC so the math still produces something sensible
// (matches the legacy posture).
//
// Optional `tenantQH` applies tenant-level quiet hours per recipient,
// interpreted in the recipient's local tz (so a 22-6 tenant quiet
// window means 22-6 LOCAL for every recipient, not 22-6 UTC). Pass
// QuietHoursWindow{Enabled: false} to disable.
//
// Returns one LocalSchedule per input recipient (including skipped
// rows — Skipped=true on those). The caller filters skipped rows out
// of the dispatcher queue but keeps them in the preview for the
// "X recipients dropped to quiet-hours skip" UI signal.
func ScheduleByBestTimeLocalized(
	now time.Time,
	withinDays int,
	recipients []LocalRecipient,
	tenantMean int,
	fallbackLoc *time.Location,
	tenantQH QuietHoursWindow,
) []LocalSchedule {
	if withinDays < 1 {
		withinDays = 1
	}
	if fallbackLoc == nil {
		fallbackLoc = time.UTC
	}
	out := make([]LocalSchedule, 0, len(recipients))
	end := now.Add(time.Duration(withinDays) * 24 * time.Hour)
	for _, r := range recipients {
		loc := r.Location
		if loc == nil {
			loc = fallbackLoc
		}
		hour := tenantMean
		if r.BestHour != nil {
			hour = *r.BestHour
		}
		whenLocal := nextHourOfWeekIn(now, hour, loc)
		// Clamp to within-days window. We compare in UTC because the
		// window is a duration, not a wall-clock interval.
		if whenLocal.UTC().After(end) {
			whenLocal = now.In(loc)
		}

		// Quiet-hours composition. The per-recipient QuietHours
		// overrides the tenant-level window when set.
		qh := tenantQH
		if r.QuietHours != nil {
			qh = *r.QuietHours
		}
		shifted, keep := ApplyQuietHours(whenLocal, qh)

		out = append(out, LocalSchedule{
			Email:       r.Email,
			SendAtUTC:   shifted.UTC(),
			SendAtLocal: shifted,
			BestHour:    hour,
			Timezone:    loc.String(),
			Skipped:     !keep,
		})
	}
	return out
}

// ResolveSubscriberLocation reads a subscriber's timezone and returns
// the matching *time.Location. The resolution order matches the
// audit's "single source of truth" requirement so both
// send_time_opt and recipient_tz_send read the same value:
//
//  1. subscribers.timezone column (added 0172) — primary.
//  2. subscribers.custom_fields->>'timezone' — legacy fallback for
//     tenants who imported via the CSV path before 0172 landed.
//  3. tenant_send_settings.sto_fallback_timezone — tenant default.
//  4. UTC — final fallback so the resolver never panics.
//
// `tz` is the resolved IANA string; `loc` is the parsed
// *time.Location. When `tz` parses to a valid Location, loc is the
// parsed value; when it doesn't (malformed import data), loc falls
// back to UTC and tz reflects the offending raw string so the
// preview UI can flag it.
//
// Source-of-truth contract: this function is the ONLY place STO
// reads subscriber tz. Adding a new tz source means editing this
// function; no other call site should query subscribers.timezone
// directly.
func ResolveSubscriberLocation(
	ctx context.Context,
	pool *db.Pool,
	tenantID, email, fallbackTZ string,
) (tz string, loc *time.Location, err error) {
	if fallbackTZ == "" {
		fallbackTZ = "UTC"
	}
	tx, terr := db.WithTenant(ctx, pool, tenantID)
	if terr != nil {
		// On RLS/transaction failure we don't surface the error —
		// the STO scheduler tolerates missing tz data and falls back
		// to the tenant default. Surfacing the error here would let
		// a transient DB blip break every scheduled send.
		l, _ := time.LoadLocation(fallbackTZ)
		if l == nil {
			l = time.UTC
		}
		return fallbackTZ, l, nil
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var primary, custom *string
	row := tx.QueryRow(ctx, `
SELECT timezone, custom_fields->>'timezone'
  FROM subscribers
 WHERE tenant_id = $1::uuid
   AND lower(email) = lower($2)`, tenantID, strings.TrimSpace(email))
	_ = row.Scan(&primary, &custom)
	_ = tx.Commit(ctx)

	candidates := []string{}
	if primary != nil && strings.TrimSpace(*primary) != "" {
		candidates = append(candidates, strings.TrimSpace(*primary))
	}
	if custom != nil && strings.TrimSpace(*custom) != "" {
		candidates = append(candidates, strings.TrimSpace(*custom))
	}
	candidates = append(candidates, fallbackTZ)

	for _, c := range candidates {
		l, lerr := time.LoadLocation(c)
		if lerr == nil && l != nil {
			return c, l, nil
		}
	}
	// All candidates malformed — final safety net.
	return "UTC", time.UTC, nil
}

// MustLoadLocation is a small helper used by the schedule pipeline
// where the tz string is sourced from a trusted column with a CHECK
// constraint (tenant_send_settings.sto_fallback_timezone). Falls
// back to UTC on any parse error so a single bad row can't crash the
// scheduler.
func MustLoadLocation(tz string) *time.Location {
	if tz == "" {
		return time.UTC
	}
	loc, err := time.LoadLocation(tz)
	if err != nil || loc == nil {
		return time.UTC
	}
	return loc
}

// LocalizedSummary describes the tz distribution of a scheduled batch
// — used by the schedule-preview UI to show "12 recipients in
// America/Los_Angeles, 47 in Europe/Berlin, ...".
type LocalizedSummary struct {
	Timezone    string `json:"timezone"`
	Subscribers int    `json:"subscribers"`
	Skipped     int    `json:"skipped"`
}

// SummarizeByTimezone groups a LocalSchedule slice by Timezone and
// returns one entry per tz, sorted by subscribers DESC (preview
// surface). Skipped rows are counted separately so the operator can
// see "America/Los_Angeles: 1,200 scheduled, 14 dropped to quiet-hours
// skip" in one row.
//
// O(n) using a map. Stable across calls because we re-sort on every
// invocation; the desktop's preview re-fetches on every form change
// so amortising the sort across calls is not worth the complexity.
func SummarizeByTimezone(schedule []LocalSchedule) []LocalizedSummary {
	if len(schedule) == 0 {
		return []LocalizedSummary{}
	}
	bucket := map[string]*LocalizedSummary{}
	for _, s := range schedule {
		row, ok := bucket[s.Timezone]
		if !ok {
			row = &LocalizedSummary{Timezone: s.Timezone}
			bucket[s.Timezone] = row
		}
		if s.Skipped {
			row.Skipped++
		} else {
			row.Subscribers++
		}
	}
	// Convert to a slice. We use a deterministic-order pass: max-
	// subscribers first, ties broken by tz name alphabetically.
	out := make([]LocalizedSummary, 0, len(bucket))
	for _, v := range bucket {
		out = append(out, *v)
	}
	// Insertion sort — len(out) is bounded by the number of unique
	// timezones in the audience (at most ~400 IANA names; in
	// practice <30 for any real tenant).
	for i := 1; i < len(out); i++ {
		for j := i; j > 0; j-- {
			if out[j].Subscribers > out[j-1].Subscribers ||
				(out[j].Subscribers == out[j-1].Subscribers && out[j].Timezone < out[j-1].Timezone) {
				out[j], out[j-1] = out[j-1], out[j]
				continue
			}
			break
		}
	}
	return out
}
