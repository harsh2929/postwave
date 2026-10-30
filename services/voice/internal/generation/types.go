// Package generation owns Moosewave's sequence-generation pipeline.
//
// Inputs: a VoiceProfile, a Template, a small map of writer-supplied
// variables, and optional StyleControls.
// Outputs: a Sequence of GeneratedEmails, each scored by the FidelityEvaluator.
//
// The engine is intentionally synchronous in V1 (calls Claude, scores, then
// returns). Async/job-runner wiring (Inngest) is a Phase 3 concern; the API
// contract is shaped so handlers can swap to a job-poll model without
// changing the engine.
package generation

import (
	"fmt"
	"time"

	"github.com/postwave/postwave/services/voice/internal/profile"
)

// GeneratedEmail is one email of a generated Sequence. Mirrors the shape
// expected by apps/web/src/lib/types.ts (frontend should keep this in sync —
// owner agent for apps/web should mirror the JSON tags).
//
// Voice fidelity:
//
//	VoiceFidelityScore is 0..100, computed by the fidelity package.
//	<60 is the auto-regenerate threshold; ≥60 is shippable; ≥80 is good.
type GeneratedEmail struct {
	Position           int                `json:"position"`
	DelaySeconds       int                `json:"delay_seconds"`
	Subject            string             `json:"subject"`
	Body               string             `json:"body"`
	BodyHTML           string             `json:"body_html,omitempty"`
	BodyMJML           string             `json:"body_mjml,omitempty"`
	VoiceFidelityScore float64            `json:"voice_fidelity_score"`
	FidelityBreakdown  *FidelityBreakdown `json:"fidelity_breakdown,omitempty"`
	RegenerationCount  int                `json:"regeneration_count"`
}

// Sequence is the persisted output of one generation run.
type Sequence struct {
	ID         string           `json:"id"`
	TenantID   string           `json:"tenant_id"`
	TemplateID string           `json:"template_id"`
	Name       string           `json:"name"`
	Status     string           `json:"status"`
	Emails     []GeneratedEmail `json:"emails"`
	CreatedAt  time.Time        `json:"created_at"`
	UpdatedAt  time.Time        `json:"updated_at"`
	// LowFidelityFlag is set when at least one email finished generation
	// below the score floor even after a stronger-prompt retry.
	LowFidelityFlag bool `json:"low_fidelity_flag,omitempty"`
	// Steps is the v0.3+ richer step list. When non-empty it's the
	// authoritative shape: the visual canvas can encode condition
	// branches, standalone delays, tag mutations, and explicit exit
	// nodes that the legacy Emails slice cannot. Producers that only
	// emit emails leave this empty and populate Emails as before; the
	// handler round-trips whichever side the caller sent.
	Steps []Step `json:"steps,omitempty"`
	// Version is the monotonically incrementing row version used for
	// optimistic concurrency on PATCH. Reads expose it as the entity's
	// "etag"; writes pass it back through If-Match and the store
	// rejects mismatches so the handler can surface 412 Precondition
	// Failed to the caller.
	//
	// New rows start at version=1 on first save; each successful PATCH
	// bumps it by 1. Legacy rows that predate the column surface as
	// version=1 after the backfill migration.
	Version int64 `json:"version"`
	// Goal is the optional sequence-level success criterion (roadmap:
	// goals / exit criteria). nil means no goal configured. Stored in
	// voice_sequences.goal (jsonb, migration 0395).
	Goal *SequenceGoal `json:"goal,omitempty"`
	// StuckAfterDays, when >= 1, enables stuck-participant detection:
	// an enrolled subscriber idle at a step for more than this many
	// days is surfaced by GET /sequences/{id}/stuck and by the stuck
	// scanner worker. 0 (the default) disables. Stored in
	// voice_sequences.stuck_after_days (migration 0395).
	StuckAfterDays int `json:"stuck_after_days,omitempty"`
}

// ---------------------------------------------------------------------------
// Sequence goals / exit criteria
// ---------------------------------------------------------------------------

// GoalKind values accepted on SequenceGoal.Kind.
const (
	GoalKindConversion = "conversion"
	GoalKindClick      = "click"
	GoalKindOpen       = "open"
)

// SequenceGoal is the sequence-level success criterion.
//
// Kind semantics:
//   - "open"       — goal is met when the subscriber opens any sequence
//     email (derivable in-repo from sequence_funnel_events.opened_at).
//   - "click"      — met on any sequence-email click (clicked_at).
//   - "conversion" — met on an external conversion event. NO in-repo
//     event source exists for sequence conversions today, so
//     conversion goals are stored + exposed but never evaluate as met
//     until the engine-side event pipeline writes a conversion signal.
//
// ExitOnGoal asks the runtime to stop sending further sequence emails
// once the goal is met. The send loop lives OUTSIDE this repo (the
// engine-side sequence dispatcher named in migration 0052); in-repo we
// derive the `completed_goal` participant status and exclude goal-met
// subscribers from stuck alerts, but cannot stop the external sends.
type SequenceGoal struct {
	Kind       string `json:"kind"`
	ExitOnGoal bool   `json:"exit_on_goal"`
}

// Validate checks the goal's kind. Returns nil for a nil receiver so
// callers can validate optional goals without a nil-check.
func (g *SequenceGoal) Validate() error {
	if g == nil {
		return nil
	}
	switch g.Kind {
	case GoalKindConversion, GoalKindClick, GoalKindOpen:
		return nil
	default:
		return fmt.Errorf("goal kind must be one of %q, %q, %q", GoalKindConversion, GoalKindClick, GoalKindOpen)
	}
}

// StyleControls bias generation. Each numeric field is a *delta* from the
// profile's measured value. Length is a coarse instruction.
type StyleControls struct {
	Humor          float64 `json:"humor"`           // -1..+1 delta
	Directness     float64 `json:"directness"`      // -1..+1 delta
	FormalityShift float64 `json:"formality_shift"` // -1..+1 delta
	Length         string  `json:"length"`          // "shorter" | "longer" | "as-is" | ""
}

// GenerateRequest is the input to Engine.Generate.
type GenerateRequest struct {
	TenantID   string `json:"tenant_id"`
	TemplateID string `json:"template_id"`
	Name       string `json:"name"`
	Status     string `json:"status,omitempty"`
	Steps      []Step `json:"steps,omitempty"`
	// Goal / StuckAfterDays mirror the Sequence fields so the manual
	// canvas-draft path (POST /sequences without template_id) can set
	// them at creation time. Both validated at the handler layer.
	Goal           *SequenceGoal        `json:"goal,omitempty"`
	StuckAfterDays int                  `json:"stuck_after_days,omitempty"`
	Profile        profile.VoiceProfile `json:"profile"`
	Variables      map[string]string    `json:"variables"`
	StyleControls  StyleControls        `json:"style_controls"`
	// Cap-related fields (per-customer monthly cap, billing tier) are
	// enforced by the API gateway / billing service, not here. The engine
	// generates if asked.
	//
	// Historical: there used to be no quota check anywhere on the call
	// path. A quota gate is now in place at the handler layer — see
	// services/voice/internal/handlers/chat.go where
	// `h.quotaOrNoop().CheckAndConsume(..., string(req.Kind), 1)` runs
	// before generation kicks off and consumes against the per-tenant
	// `tenant_ai_usage` table. The over-quota path returns 402
	// PaymentRequired with the upgrade-url body. This comment is
	// retained so the next reader doesn't reintroduce a duplicate gate.
}

// RegenerateRequest is the input to Engine.Regenerate.
//
// Variables, when set, OVERRIDE the variables embedded in the existing
// email at that position. When nil/empty, the engine reuses whatever
// the existing email had — same as the original V1 behaviour. This
// closes the half-baked-feature catalog item: users couldn't change a
// variable without rebuilding the whole sequence.
type RegenerateRequest struct {
	SequenceID    string            `json:"sequence_id"`
	EmailPosition int               `json:"email_position"`
	StyleControls StyleControls     `json:"style_controls"`
	UserHint      string            `json:"user_hint,omitempty"`
	Variables     map[string]string `json:"variables,omitempty"`
}

// MinFidelityFloor is the score below which the engine auto-retries a
// single email once with a stronger voice-matching prompt.
const MinFidelityFloor = 60.0

// ---------------------------------------------------------------------------
// Sequence step types (v0.3+)
//
// The original V1 Sequence shape (above) only carried email steps —
// they were modelled directly as GeneratedEmail entries on
// Sequence.Emails. The visual canvas in apps/desktop wants more: delays
// as standalone nodes, conditions with two branches, tag-add /
// tag-remove sentinels, and an explicit exit. To keep the JSON contract
// backwards compatible (existing rows in voice_sequences.emails still
// decode) we store the new step types as a parallel `Steps []Step` slice.
// Producers that emit only emails can continue to populate Sequence.Emails
// as before; producers that need conditions/tags/exit emit Sequence.Steps
// instead. The handler accepts BOTH on PATCH and round-trips whichever
// the caller sent.
//
// Storage: voice_sequences.emails is jsonb already (see
// infra/migrations/0010_voice.sql) — no schema migration required. We
// chose to round-trip the new shape inside the same `emails` column
// when Steps is populated, by persisting a top-level "steps" envelope
// inside the existing GeneratedEmail layout via a tagged element. This
// is achieved by serializing the Sequence directly as JSON (the seqstore
// already does `json.Marshal(seq.Emails)` — see seqstore/postgres.go);
// the desktop reads/writes the same wire format. See sequences.go in
// the handlers package for the PATCH path.
// ---------------------------------------------------------------------------

// StepType is the discriminator for the sequence step union. The string
// values match the apps/desktop canvas types so a Step round-trips
// across the wire without any label translation.
type StepType string

// Sequence step type constants.
const (
	StepTypeEmail     StepType = "email"
	StepTypeDelay     StepType = "delay"
	StepTypeCondition StepType = "condition"
	StepTypeTagAdd    StepType = "tag_add"
	StepTypeTagRemove StepType = "tag_remove"
	StepTypeExit      StepType = "exit"
)

// Step is the typed envelope for a sequence node. Exactly one of the
// type-specific subfields (Email/Delay/Condition/Tag) is non-nil; for
// StepTypeExit no subfield is needed (the type alone is the signal).
//
// Position is 1-based across the FLAT step list; condition branches
// re-use the same numbering inside their YesBranch / NoBranch slices,
// so a step's "global" id is (parent-condition-id, branch, position).
// We don't enforce that here — the handler validates uniqueness within
// each branch before persisting.
type Step struct {
	Type      StepType         `json:"type"`
	Position  int              `json:"position"`
	Email     *EmailConfig     `json:"email,omitempty"`
	Delay     *DelayConfig     `json:"delay,omitempty"`
	Condition *ConditionConfig `json:"condition,omitempty"`
	Tag       *TagConfig       `json:"tag,omitempty"`
}

// EmailConfig is the payload for a StepTypeEmail step. Mirrors the
// fields on GeneratedEmail so a producer can decide whether to emit
// either shape; see the package doc above on how the two coexist.
type EmailConfig struct {
	Subject      string `json:"subject"`
	Body         string `json:"body"`
	BodyHTML     string `json:"body_html,omitempty"`
	BodyMJML     string `json:"body_mjml,omitempty"`
	DelaySeconds int    `json:"delay_seconds,omitempty"`
	TemplateID   string `json:"template_id,omitempty"`
	// Variants is the optional A/B test split for this email step.
	// When non-empty: 2..4 variants, weights in basis points summing
	// to exactly 10000 (see ValidateVariants). Per-enrollment variant
	// assignment is deterministic — AssignVariant hashes
	// (subscriber, sequence, step) so repeated sends are stable.
	// Rides inside the steps jsonb column; no schema change needed.
	Variants []EmailVariant `json:"variants,omitempty"`
}

// EmailVariant is one arm of an email step's A/B split.
type EmailVariant struct {
	Key      string `json:"key"`
	Subject  string `json:"subject"`
	Body     string `json:"body"`
	BodyHTML string `json:"body_html,omitempty"`
	// WeightBP is the assignment weight in basis points (1/100 of a
	// percent). All variants of a step must sum to exactly 10000.
	WeightBP int `json:"weight_bp"`
}

// DelayConfig is a wait period as a standalone node (vs the
// `delay_seconds` ride-along on EmailConfig). Producers should use this
// when the delay is conceptually distinct from the next email — e.g.
// "wait two days, then run a Condition that decides which email
// fires next".
type DelayConfig struct {
	// Seconds is the canonical normalised value used by the runner.
	// Producers may also set the human-friendly Value/Unit pair; if
	// both are present, Seconds wins on PATCH (the handler does NOT
	// re-derive it because integer truncation when the producer set a
	// non-multiple value would surprise round-trip).
	Seconds int    `json:"seconds"`
	Value   int    `json:"value,omitempty"`
	Unit    string `json:"unit,omitempty"` // "minutes" | "hours" | "days"
}

// ConditionConfig is the two-branch decision node. Predicate names the
// rule (opened_previous, clicked_any, tag_present, custom_property_eq);
// Value is the rule's argument when the predicate takes one (the tag
// name for tag_present; "key:value" for custom_property_eq). The two
// branches are arrays of Steps each — the canvas + runner walk
// YesBranch on truthy outcomes, NoBranch otherwise. Branches MAY
// contain further conditions; depth is bounded by the canvas at 3 to
// keep the visual layout legible.
type ConditionConfig struct {
	Predicate string `json:"predicate"`
	Value     string `json:"value,omitempty"`
	YesBranch []Step `json:"yes_branch"`
	NoBranch  []Step `json:"no_branch"`
}

// TagConfig is the payload shared by StepTypeTagAdd and
// StepTypeTagRemove. The runner applies / removes the named tag on
// the subscriber when the step fires.
type TagConfig struct {
	Tag string `json:"tag"`
}
