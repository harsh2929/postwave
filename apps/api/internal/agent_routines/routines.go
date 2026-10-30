// SPDX-License-Identifier: AGPL-3.0-only
//
// Package agent_routines implements standing agent instructions with
// approval gates (platform-2026 roadmap #1 differentiator). A routine
// is a tenant-authored brief ("every Monday draft a re-engagement
// campaign for lapsed subscribers") that the platform agent executes on
// a schedule by calling the voice service's existing drafting endpoints.
//
// SAFETY INVARIANT — NEVER AUTO-SEND: a routine run only ever produces
// DRAFT artifacts (campaigns.status = 'draft', voice sequences with
// status = 'draft'). There is no code path in this package that queues,
// schedules, or sends anything. When require_approval is true (the
// default) each run additionally opens a pending approvals row
// referencing the draft, so the human-in-the-loop gate reviews agent
// output before any human promotes it.
//
// Tables: agent_routines (0386) + agent_routine_runs (0387).
package agent_routines

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Kinds of draft a routine can produce.
const (
	KindDraftCampaign = "draft_campaign"
	KindDraftSequence = "draft_sequence"
)

// Schedules. Interval-based in v1 (measured from last_run_at),
// mirroring audience_syncs.
const (
	ScheduleManual  = "manual"
	ScheduleDaily   = "daily"
	ScheduleWeekly  = "weekly"
	ScheduleMonthly = "monthly"
)

// Run statuses (CHECK constraint in 0387).
const (
	RunStatusRunning   = "running"
	RunStatusSucceeded = "succeeded"
	RunStatusFailed    = "failed"
)

// staleRunInterruptedError is deliberately generic and tenant-safe. A stale
// receipt proves only that its owning process stopped making progress; it does
// not prove which provider, dependency, or panic caused the interruption.
const staleRunInterruptedError = "routine execution was interrupted before completion"

// Output kinds recorded on runs; they double as the approvals
// resource_type values (approvals.ResourceCampaign / ResourceSequence).
const (
	OutputCampaign = "campaign"
	OutputSequence = "sequence"
)

// Input bounds. promptMaxRunes mirrors the voice service's draft brief
// cap (and the CHECK in 0386).
const (
	nameMaxRunes   = 200
	promptMaxRunes = 8000
)

// Routine mirrors an agent_routines row.
type Routine struct {
	ID              string         `json:"id"`
	Name            string         `json:"name"`
	Prompt          string         `json:"prompt"`
	Kind            string         `json:"kind"`
	Schedule        string         `json:"schedule"`
	ScheduleDetail  map[string]any `json:"schedule_detail,omitempty"`
	TargetListID    *string        `json:"target_list_id,omitempty"`
	TargetSegmentID *string        `json:"target_segment_id,omitempty"`
	RequireApproval bool           `json:"require_approval"`
	Enabled         bool           `json:"enabled"`
	// HasActiveRun is derived from the durable run ledger. While true, the
	// routine is immutable and cannot be started again or deleted; this keeps
	// detached execution bound to one stable configuration snapshot.
	HasActiveRun bool       `json:"has_active_run"`
	LastRunAt    *time.Time `json:"last_run_at,omitempty"`
	CreatedBy    string     `json:"created_by,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

// Run mirrors an agent_routine_runs row.
//
// The trust fields (PromptUsed, ContextUsed, Reasoning, DraftPreview) are
// the honest record the desktop renders so a reviewer can see what the
// agent was told, the model's own rationale, and exactly what it drafted —
// before approving. They are empty for runs that predate the feature or
// that failed before producing a draft (never fabricated).
type Run struct {
	ID           string          `json:"id"`
	RoutineID    string          `json:"routine_id"`
	Status       string          `json:"status"`
	OutputKind   string          `json:"output_kind,omitempty"`
	OutputRef    string          `json:"output_ref,omitempty"`
	ApprovalID   string          `json:"approval_id,omitempty"`
	Error        string          `json:"error,omitempty"`
	PromptUsed   string          `json:"prompt_used,omitempty"`
	ContextUsed  string          `json:"context_used,omitempty"`
	Reasoning    string          `json:"reasoning,omitempty"`
	DraftPreview json.RawMessage `json:"draft_preview,omitempty"`
	StartedAt    time.Time       `json:"started_at"`
	FinishedAt   *time.Time      `json:"finished_at,omitempty"`
}

// CreateInput is the POST body. RequireApproval / Enabled are pointers
// so "absent" defaults to true (the safe default) rather than false.
type CreateInput struct {
	Name           string         `json:"name"`
	Prompt         string         `json:"prompt"`
	Kind           string         `json:"kind"`
	Schedule       string         `json:"schedule,omitempty"`
	ScheduleDetail map[string]any `json:"schedule_detail,omitempty"`
	// TargetListID is retained only so old clients can explicitly clear a
	// legacy stored value with "". Non-empty list targeting was never backed
	// by a compatible identity/runtime contract and is rejected.
	TargetListID    *string `json:"target_list_id,omitempty"`
	TargetSegmentID *string `json:"target_segment_id,omitempty"`
	RequireApproval *bool   `json:"require_approval,omitempty"`
	Enabled         *bool   `json:"enabled,omitempty"`
}

// UpdateInput is the PATCH body — nil pointer = "leave unchanged".
type UpdateInput struct {
	Name           *string         `json:"name,omitempty"`
	Prompt         *string         `json:"prompt,omitempty"`
	Schedule       *string         `json:"schedule,omitempty"`
	ScheduleDetail *map[string]any `json:"schedule_detail,omitempty"`
	// TargetListID accepts only "" for legacy cleanup. Nil leaves the inert
	// legacy value unchanged; non-empty values are rejected.
	TargetListID    *string `json:"target_list_id,omitempty"`
	TargetSegmentID *string `json:"target_segment_id,omitempty"`
	RequireApproval *bool   `json:"require_approval,omitempty"`
	Enabled         *bool   `json:"enabled,omitempty"`
}

// ErrNotFound is returned by store implementations for missing rows.
var ErrNotFound = errors.New("agent_routines: not found")

// ErrNameTaken is returned when (tenant_id, name) collides.
var ErrNameTaken = errors.New("agent_routines: name already in use")

// ErrRoutineActive is returned when a routine already owns a running ledger
// receipt. It is intentionally shared by start, update, and delete so callers
// receive one tenant-safe conflict without learning anything about another
// run's provider state or internals.
var ErrRoutineActive = errors.New("agent_routines: routine has an active run")

// ErrInvalidTargetSegment intentionally collapses malformed, missing, and
// cross-tenant segment ids into one operator-safe validation outcome. Callers
// must never be able to use this surface to enumerate another tenant's ids.
var ErrInvalidTargetSegment = errors.New("agent_routines: target segment is not available in this workspace")

// ErrUnsupportedTargetList closes the historical bigint/UUID identity gap.
// The list catalog exposes Listmonk int64 ids while this legacy column is a
// UUID, and routine execution never resolved or attached it to a draft.
var ErrUnsupportedTargetList = errors.New("agent_routines: target list is not supported")

func validKind(k string) bool {
	return k == KindDraftCampaign || k == KindDraftSequence
}

func validSchedule(s string) bool {
	switch s {
	case ScheduleManual, ScheduleDaily, ScheduleWeekly, ScheduleMonthly:
		return true
	}
	return false
}

// ValidateCreate normalizes + validates a CreateInput. Returns an
// operator-safe error message on failure.
func ValidateCreate(in *CreateInput) error {
	in.Name = strings.TrimSpace(in.Name)
	in.Prompt = strings.TrimSpace(in.Prompt)
	in.Kind = strings.ToLower(strings.TrimSpace(in.Kind))
	in.Schedule = strings.ToLower(strings.TrimSpace(in.Schedule))
	if in.Schedule == "" {
		in.Schedule = ScheduleManual
	}
	if in.Name == "" {
		return errors.New("name is required")
	}
	if utf8.RuneCountInString(in.Name) > nameMaxRunes {
		return fmt.Errorf("name must be %d characters or fewer", nameMaxRunes)
	}
	if in.Prompt == "" {
		return errors.New("prompt is required")
	}
	if utf8.RuneCountInString(in.Prompt) > promptMaxRunes {
		return fmt.Errorf("prompt must be %d characters or fewer", promptMaxRunes)
	}
	if !validKind(in.Kind) {
		return fmt.Errorf("kind must be %s or %s", KindDraftCampaign, KindDraftSequence)
	}
	if !validSchedule(in.Schedule) {
		return errors.New("schedule must be manual, daily, weekly, or monthly")
	}
	if err := validateTargetListInput(in.TargetListID); err != nil {
		return err
	}
	trimOptionalID(in.TargetSegmentID)
	return nil
}

// ValidateUpdate normalizes + validates an UpdateInput.
func ValidateUpdate(in *UpdateInput) error {
	if in.Name != nil {
		*in.Name = strings.TrimSpace(*in.Name)
		if *in.Name == "" {
			return errors.New("name cannot be empty")
		}
		if utf8.RuneCountInString(*in.Name) > nameMaxRunes {
			return fmt.Errorf("name must be %d characters or fewer", nameMaxRunes)
		}
	}
	if in.Prompt != nil {
		*in.Prompt = strings.TrimSpace(*in.Prompt)
		if *in.Prompt == "" {
			return errors.New("prompt cannot be empty")
		}
		if utf8.RuneCountInString(*in.Prompt) > promptMaxRunes {
			return fmt.Errorf("prompt must be %d characters or fewer", promptMaxRunes)
		}
	}
	if in.Schedule != nil {
		*in.Schedule = strings.ToLower(strings.TrimSpace(*in.Schedule))
		if !validSchedule(*in.Schedule) {
			return errors.New("schedule must be manual, daily, weekly, or monthly")
		}
	}
	if err := validateTargetListInput(in.TargetListID); err != nil {
		return err
	}
	trimOptionalID(in.TargetSegmentID)
	return nil
}

func trimOptionalID(value *string) {
	if value != nil {
		*value = strings.TrimSpace(*value)
	}
}

func validateTargetListInput(value *string) error {
	trimOptionalID(value)
	if value != nil && *value != "" {
		return ErrUnsupportedTargetList
	}
	return nil
}

// scheduleInterval maps a schedule to its run interval. Zero for
// manual (never auto-due). Monthly is a fixed 30 days in v1 —
// schedule_detail anchoring is a documented follow-up.
func scheduleInterval(schedule string) time.Duration {
	switch schedule {
	case ScheduleDaily:
		return 24 * time.Hour
	case ScheduleWeekly:
		return 7 * 24 * time.Hour
	case ScheduleMonthly:
		return 30 * 24 * time.Hour
	}
	return 0
}

// IsDue reports whether a routine should auto-run at `now`. Pure so the
// scheduler's dueness rule is unit-testable without Postgres; the SQL
// due-scan in repo.go encodes the identical rule.
func IsDue(r *Routine, now time.Time) bool {
	if r == nil || !r.Enabled || r.Schedule == ScheduleManual {
		return false
	}
	iv := scheduleInterval(r.Schedule)
	if iv <= 0 {
		return false
	}
	if r.LastRunAt == nil {
		return true
	}
	return r.LastRunAt.Add(iv).Before(now) || r.LastRunAt.Add(iv).Equal(now)
}
