// SPDX-License-Identifier: AGPL-3.0-only
//
// schedule.go — one-time subscriber-import execution.
//
// The wizard's final step lets the operator run an import immediately or
// defer it to one reviewed UTC timestamp:
//
//   * schedule_type = "immediate" — the historical behaviour. Confirm
//     flips status → 'queued' with next_scheduled_at NULL, so the worker
//     claims it on the very next tick.
//   * schedule_type = "scheduled" — a one-shot run at scheduled_at (UTC).
//     Confirm flips → 'queued' but stamps next_scheduled_at = scheduled_at;
//     the worker's claim query gates on next_scheduled_at <= now() so the
//     row stays invisible to the worker until it's due. The canonical
//     "run at 02:00 UTC tonight" case is just a scheduled_at in the future.
// Recurring cron and duration-based drip inputs remain readable for legacy
// rows, but new PATCH/Confirm operations reject them. The worker does not
// durably re-arm a recurring source and its chunk interval does not enforce a
// selected total duration, so accepting either would create a false contract.
//
// This file holds the pure validation + scheduling math so the contract
// is unit-testable without a DB or a wall clock.

package subscriber_import

import (
	"strings"
	"time"
)

// One-shot schedule values. scheduleCron is retained only so legacy rows and
// inputs can be rejected explicitly instead of being misread as immediate.
const (
	scheduleImmediate = "immediate"
	scheduleScheduled = "scheduled"
	scheduleCron      = "cron"

	MaxScheduleSkew = 365 * 24 * time.Hour // refuse run-at more than a year out
)

// scheduleInput is the schedule subset of the PATCH body. Pointer fields
// distinguish absent (leave untouched) from explicit.
type scheduleInput struct {
	ScheduleType      *string `json:"schedule_type,omitempty"`
	ScheduleCron      *string `json:"schedule_cron,omitempty"`
	ScheduledAt       *string `json:"scheduled_at,omitempty"` // RFC3339
	DripHoursInterval *int    `json:"drip_hours_interval,omitempty"`
	DripHoursTotal    *int    `json:"drip_hours_total,omitempty"`
}

// scheduleValues is the validated / normalised subset that maps 1:1 onto
// subscriber_imports columns. nil = untouched.
type scheduleValues struct {
	ScheduleType      *string
	ScheduleCron      *string // "" clears
	ScheduledAt       *time.Time
	ClearScheduledAt  bool
	DripHoursInterval *int
	DripHoursTotal    *int
}

// touched reports whether the PATCH carried any schedule field at all, so
// the handler can skip the schedule UPDATEs entirely when it didn't.
func (v scheduleValues) touched() bool {
	return v.ScheduleType != nil || v.ScheduleCron != nil ||
		v.ScheduledAt != nil || v.ClearScheduledAt ||
		v.DripHoursInterval != nil || v.DripHoursTotal != nil
}

// validateSchedule normalises + validates the SUB-104 schedule fields of
// a PATCH body. Reuses the patchValidationError code/msg contract so the
// handler maps a rejection straight to a 400 with a stable code.
func validateSchedule(in scheduleInput) (scheduleValues, *patchValidationError) {
	var sv scheduleValues
	if in.ScheduleType != nil {
		st := strings.TrimSpace(strings.ToLower(*in.ScheduleType))
		switch st {
		case scheduleImmediate, scheduleScheduled:
			sv.ScheduleType = &st
		case scheduleCron:
			return sv, &patchValidationError{"unsupported_recurring_import",
				"recurring subscriber imports are not supported; use immediate or a one-time scheduled_at"}
		default:
			return sv, &patchValidationError{"invalid_schedule_type",
				"schedule_type must be immediate|scheduled"}
		}
	}
	if in.ScheduleCron != nil {
		c := strings.TrimSpace(*in.ScheduleCron)
		if c != "" {
			return sv, &patchValidationError{"unsupported_recurring_import",
				"schedule_cron is unavailable because subscriber imports are one-time jobs"}
		}
		sv.ScheduleCron = &c
	}
	if in.ScheduledAt != nil {
		raw := strings.TrimSpace(*in.ScheduledAt)
		if raw == "" {
			sv.ClearScheduledAt = true
		} else {
			ts, err := time.Parse(time.RFC3339, raw)
			if err != nil {
				return sv, &patchValidationError{"invalid_scheduled_at",
					"scheduled_at must be an RFC3339 timestamp"}
			}
			utc := ts.UTC()
			sv.ScheduledAt = &utc
		}
	}
	if in.DripHoursInterval != nil {
		n := *in.DripHoursInterval
		if n != 0 {
			return sv, &patchValidationError{"unsupported_import_pacing",
				"drip pacing is unavailable because the worker cannot enforce an exact reviewed duration"}
		}
		sv.DripHoursInterval = &n
	}
	if in.DripHoursTotal != nil {
		n := *in.DripHoursTotal
		if n != 0 {
			return sv, &patchValidationError{"unsupported_import_pacing",
				"drip pacing is unavailable because the worker cannot enforce an exact reviewed duration"}
		}
		sv.DripHoursTotal = &n
	}
	return sv, nil
}

// confirmSchedule is the durable schedule state Confirm reads back to
// decide how to flip the row. Mirrors the subscriber_imports columns.
type confirmSchedule struct {
	ScheduleType      string
	ScheduleCron      string
	ScheduledAt       *time.Time
	DripHoursInterval int
	DripHoursTotal    int
}

// validateConfirmExecution prevents legacy preview rows from bypassing the
// current one-time execution contract at Confirm time. PATCH validation is not
// sufficient because a row may predate it or may have been written by an older
// client.
func validateConfirmExecution(s confirmSchedule) *patchValidationError {
	return validateConfirmExecutionAt(s, time.Now().UTC())
}

func validateConfirmExecutionAt(s confirmSchedule, now time.Time) *patchValidationError {
	st := strings.TrimSpace(strings.ToLower(s.ScheduleType))
	if st == "" {
		st = scheduleImmediate
	}
	if st == scheduleCron || strings.TrimSpace(s.ScheduleCron) != "" {
		return &patchValidationError{"unsupported_recurring_import",
			"recurring subscriber imports are not supported; clear the schedule and review this as a one-time import"}
	}
	if s.DripHoursInterval != 0 || s.DripHoursTotal != 0 {
		return &patchValidationError{"unsupported_import_pacing",
			"drip pacing is unavailable because the worker cannot enforce an exact reviewed duration"}
	}
	switch st {
	case scheduleImmediate:
		if s.ScheduledAt != nil {
			return &patchValidationError{"conflicting_import_schedule",
				"an immediate import cannot retain scheduled_at"}
		}
	case scheduleScheduled:
		if s.ScheduledAt == nil {
			return &patchValidationError{"invalid_scheduled_at",
				"a one-time scheduled import requires scheduled_at"}
		}
		if !s.ScheduledAt.After(now.UTC()) {
			return &patchValidationError{"scheduled_at_in_past",
				"scheduled_at must be in the future; choose immediate for a job that should run now"}
		}
		if s.ScheduledAt.After(now.UTC().Add(MaxScheduleSkew)) {
			return &patchValidationError{"scheduled_at_too_far",
				"scheduled_at cannot be more than one year in the future"}
		}
	default:
		return &patchValidationError{"invalid_schedule_type",
			"schedule_type must be immediate|scheduled"}
	}
	return nil
}

func mergeSchedule(base confirmSchedule, patch scheduleValues) confirmSchedule {
	merged := base
	if patch.ScheduleType != nil {
		merged.ScheduleType = *patch.ScheduleType
	}
	if patch.ScheduleCron != nil {
		merged.ScheduleCron = *patch.ScheduleCron
	}
	if patch.ClearScheduledAt {
		merged.ScheduledAt = nil
	} else if patch.ScheduledAt != nil {
		value := patch.ScheduledAt.UTC()
		merged.ScheduledAt = &value
	}
	if patch.DripHoursInterval != nil {
		merged.DripHoursInterval = *patch.DripHoursInterval
	}
	if patch.DripHoursTotal != nil {
		merged.DripHoursTotal = *patch.DripHoursTotal
	}
	return merged
}

// computeNextRun returns the instant the worker may first claim the row,
// given the row's schedule and the current time. A NULL return (nil)
// means "claimable immediately" (next_scheduled_at stays NULL). The
// scheduled case returns a future timestamp the claim query gates on.
//
//   - immediate → nil (claim now).
//   - scheduled → scheduled_at if it's in the future; nil if it's already
//     past (the operator picked a time that already elapsed → run now).
func computeNextRun(s confirmSchedule, now time.Time) *time.Time {
	switch s.ScheduleType {
	case scheduleScheduled:
		if s.ScheduledAt != nil && s.ScheduledAt.After(now) {
			t := s.ScheduledAt.UTC()
			return &t
		}
		return nil
	default: // immediate or unknown
		return nil
	}
}
