// Package campaigndispatch owns release qualification shared by every process
// that can materialize a scheduled email campaign. Keeping the compile-time
// lock in a workspace package prevents the API and automation service from
// drifting into different scheduling policy.
package campaigndispatch

import "errors"

const (
	// SchedulingQualified must remain false until the campaign scheduler has
	// durable claim recovery plus an enabled claim-to-dispatch integration test.
	// Runtime environment flags express operator intent; they cannot qualify an
	// unsafe implementation by themselves.
	SchedulingQualified = false

	SchedulingUnqualifiedCode    = "campaign_scheduling_unqualified"
	SchedulingUnqualifiedMessage = "campaign scheduling is unavailable until durable dispatch recovery is release-qualified"
	SchedulingDisabledCode       = "campaign_scheduling_disabled"
	SchedulingDisabledMessage    = "campaign scheduling is disabled by operator policy"
)

var (
	ErrSchedulingUnqualified = errors.New(SchedulingUnqualifiedCode)
	ErrSchedulingDisabled    = errors.New(SchedulingDisabledCode)
)

// CheckScheduledMaterialization applies both the compile-time release lock and
// the runtime operator interlock. The release lock is deliberately evaluated
// first so enabling environment variables cannot arm an unqualified worker.
func CheckScheduledMaterialization(runtimeEnabled bool) error {
	if !SchedulingQualified {
		return ErrSchedulingUnqualified
	}
	if !runtimeEnabled {
		return ErrSchedulingDisabled
	}
	return nil
}

// PublicError returns the fixed, non-sensitive contract for callers that need
// to surface a scheduling-policy failure over HTTP or logs.
func PublicError(err error) (code, message string) {
	if errors.Is(err, ErrSchedulingDisabled) {
		return SchedulingDisabledCode, SchedulingDisabledMessage
	}
	return SchedulingUnqualifiedCode, SchedulingUnqualifiedMessage
}
