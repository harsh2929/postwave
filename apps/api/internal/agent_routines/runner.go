// SPDX-License-Identifier: AGPL-3.0-only
//
// runner.go — executes one agent-routine run.
//
// Flow (Start then Execute, split so the manual-run handler can return
// 202 + run id before the LLM round-trip completes):
//
//  1. Start inserts a 'running' agent_routine_runs row and stamps
//     last_run_at on the routine.
//  2. Execute calls the voice service's existing drafting endpoint for
//     the routine's kind, persists the DRAFT artifact, opens a pending
//     approvals row when require_approval is set, and finalizes the
//     run row with the output reference recorded verbatim.
//
// NEVER AUTO-SEND: the only artifacts this runner creates are
// status='draft' campaigns and status='draft' voice sequences. The
// approval row gates human promotion; nothing here queues a send.
package agent_routines

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/postwave/postwave/apps/api/internal/aidisclosure"
)

// ExecuteTimeout bounds one run (two LLM round-trips worst case for
// the sequence kind). Mirrors the voice client timeouts.
const ExecuteTimeout = 3 * time.Minute

// panicFinalizationTimeout is deliberately independent of the execution
// context. A panic may occur while that context is cancelled or expiring; the
// already-created durable run still needs one bounded chance to become
// terminal instead of remaining "running" forever.
const panicFinalizationTimeout = 10 * time.Second

const unexpectedExecutionError = "routine execution failed unexpectedly"

// CampaignDraft is the structured campaign output the voice service
// returns for the campaign_draft chat kind (aicompose.CampaignDraft
// shape, redeclared locally to avoid a package dependency).
//
// Rationale is the model's own explanation of the draft (why this angle /
// audience / CTA). It is captured onto the run's trust record so an
// approver can see the agent's reasoning. Empty honestly means the model
// gave none — never a synthesized stand-in.
type CampaignDraft struct {
	Name        string `json:"name"`
	Subject     string `json:"subject"`
	Body        string `json:"body"`
	PreviewText string `json:"preview_text,omitempty"`
	Rationale   string `json:"rationale,omitempty"`
}

// SequenceDraftStep is one email of a drafted sequence (the voice
// service's DraftStep wire shape).
type SequenceDraftStep struct {
	Subject    string `json:"subject"`
	Body       string `json:"body"`
	DelayHours int    `json:"delay_hours"`
	Position   int    `json:"position"`
}

// SequenceDraft is the voice service's sequences/draft response.
//
// Rationale is the model's own explanation of the sequence arc, captured
// onto the run's trust record. Empty honestly means none was given.
type SequenceDraft struct {
	Name      string              `json:"name"`
	Steps     []SequenceDraftStep `json:"steps"`
	Rationale string              `json:"rationale,omitempty"`
}

// VoiceClient is the narrow drafting surface the runner needs from the
// voice service. Production implementation is HTTPVoiceClient; tests
// pass a fake. Note the interface has NO send-shaped method — the
// runner is structurally incapable of sending.
type VoiceClient interface {
	// GenerateCampaignDraft runs the voice service's campaign_draft
	// chat kind (POST /v1/voice/generate).
	GenerateCampaignDraft(ctx context.Context, tenantID, prompt, contextText string) (CampaignDraft, error)
	// DraftSequence runs POST /v1/voice/sequences/draft (brief → steps).
	DraftSequence(ctx context.Context, tenantID, brief string) (SequenceDraft, error)
	// CreateDraftSequence persists the draft via the voice service's
	// manual-draft path (POST /v1/voice/sequences, status=draft) and
	// returns the new sequence id.
	CreateDraftSequence(ctx context.Context, tenantID string, draft SequenceDraft) (string, error)
}

// ApprovalRequester opens a pending human-in-the-loop approval for a
// drafted artifact. Production wiring adapts approvals.Service.Request;
// tests pass a fake. resourceType is "campaign" or "sequence"
// (approvals.ResourceCampaign / ResourceSequence values).
type ApprovalRequester interface {
	RequestApproval(ctx context.Context, tenantID, resourceType, resourceID, actorLabel string) (approvalID string, err error)
}

// ApprovalRequesterFunc adapts a function into an ApprovalRequester.
type ApprovalRequesterFunc func(ctx context.Context, tenantID, resourceType, resourceID, actorLabel string) (string, error)

func (f ApprovalRequesterFunc) RequestApproval(ctx context.Context, tenantID, resourceType, resourceID, actorLabel string) (string, error) {
	return f(ctx, tenantID, resourceType, resourceID, actorLabel)
}

// FinishRunInput finalizes a run row. The trust fields (PromptUsed,
// ContextUsed, Reasoning, DraftPreview) are the honest record of what the
// agent was told, what it produced, and the model's own rationale — they
// power the desktop "trust" surface. All are optional: a failed run, or a
// model that returned no rationale, simply leaves them empty (never
// fabricated).
type FinishRunInput struct {
	Status      string
	OutputKind  string
	OutputRef   string
	ApprovalID  string
	ErrMsg      string
	PromptUsed  string
	ContextUsed string
	Reasoning   string
	// DraftPreview is a compact JSON snapshot of exactly what the agent
	// drafted at run time (immune to later human edits of the draft).
	// nil for failed runs.
	DraftPreview json.RawMessage
}

// RunnerStore is the persistence surface the runner needs. Implemented
// by *Repo; tests pass a fake.
type RunnerStore interface {
	GetRoutine(ctx context.Context, tenantID, id string) (*Routine, error)
	// InsertRun creates a 'running' run row and stamps the routine's
	// last_run_at. Returns the run id.
	InsertRun(ctx context.Context, tenantID, routineID string) (string, error)
	// FinishRun finalizes the run row, recording the trust fields.
	FinishRun(ctx context.Context, tenantID, runID string, in FinishRunInput) error
	// CreateDraftCampaign inserts a status='draft' campaign and returns
	// its id. segmentID nil = no audience preselected (operator picks
	// at review time).
	CreateDraftCampaign(ctx context.Context, tenantID string, d CampaignDraft, segmentID *string) (string, error)
}

// Runner executes routines. Stateless; safe to share.
type Runner struct {
	Store     RunnerStore
	Voice     VoiceClient
	Approvals ApprovalRequester
	Logger    *slog.Logger
}

// Start opens the run ledger row for a routine. The caller follows up
// with Execute (sync for the scheduler, detached goroutine for the
// manual-run handler's 202 path).
func (rn *Runner) Start(ctx context.Context, tenantID, routineID string) (string, error) {
	if rn == nil || rn.Store == nil {
		return "", errors.New("agent_routines: runner not configured")
	}
	return rn.Store.InsertRun(ctx, tenantID, routineID)
}

// ExecuteSafely is the production execution boundary for both manual and
// scheduled runs. Execute contains the ordinary error-to-receipt flow; this
// wrapper adds the one case ordinary error handling cannot see: a panic from a
// collaborator. The panic value is never copied into the tenant-visible run
// receipt or logs because it may contain model/provider data.
func (rn *Runner) ExecuteSafely(ctx context.Context, tenantID, routineID, runID string) (err error) {
	if rn == nil || rn.Store == nil {
		return errors.New("agent_routines: runner not configured")
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			if rn.Logger != nil {
				rn.Logger.Error("agent_routines: run panic recovered",
					"tenant_id", tenantID,
					"routine_id", routineID,
					"run_id", runID,
					"panic_type", fmt.Sprintf("%T", recovered))
			}
			base := ctx
			if base == nil {
				base = context.Background()
			}
			finishCtx, cancel := context.WithTimeout(context.WithoutCancel(base), panicFinalizationTimeout)
			defer cancel()
			err = rn.fail(finishCtx, tenantID, runID, "", "", unexpectedExecutionError)
		}
	}()
	return rn.Execute(ctx, tenantID, routineID, runID)
}

// draftResult is the honest record of one drafting round: the draft's id
// plus everything the trust surface shows — what the agent was told
// (prompt + resolved audience context), the model's own rationale, and a
// compact snapshot of exactly what it produced.
type draftResult struct {
	ref       string
	prompt    string
	context   string
	reasoning string
	preview   json.RawMessage
}

// Execute performs the drafting work for an already-Started run and
// finalizes the run row. Always returns the terminal run status.
func (rn *Runner) Execute(ctx context.Context, tenantID, routineID, runID string) error {
	if rn == nil || rn.Store == nil {
		return errors.New("agent_routines: runner not configured")
	}
	if rn.Voice == nil {
		return rn.fail(ctx, tenantID, runID, "", "", "voice service not configured")
	}
	routine, err := rn.Store.GetRoutine(ctx, tenantID, routineID)
	if err != nil {
		return rn.fail(ctx, tenantID, runID, "", "", "routine lookup: "+err.Error())
	}

	var outputKind string
	var res *draftResult
	switch routine.Kind {
	case KindDraftCampaign:
		outputKind = OutputCampaign
		res, err = rn.draftCampaign(ctx, tenantID, routine)
	case KindDraftSequence:
		outputKind = OutputSequence
		res, err = rn.draftSequence(ctx, tenantID, routine)
	default:
		err = fmt.Errorf("unknown routine kind %q", routine.Kind)
	}
	if err != nil {
		ref := ""
		if res != nil {
			ref = res.ref
		}
		return rn.fail(ctx, tenantID, runID, outputKind, ref, err.Error())
	}

	// Approval gate. The draft already exists and is inert (drafts are
	// never sent without explicit human action elsewhere); a failed
	// approval insert is still recorded as a failed run so the operator
	// notices the gate didn't open — the output ref stays recorded
	// verbatim either way.
	approvalID := ""
	if routine.RequireApproval {
		if rn.Approvals == nil {
			return rn.fail(ctx, tenantID, runID, outputKind, res.ref,
				"require_approval set but approvals not configured")
		}
		approvalID, err = rn.Approvals.RequestApproval(ctx, tenantID, outputKind, res.ref,
			"agent_routine:"+routine.Name)
		if err != nil {
			return rn.fail(ctx, tenantID, runID, outputKind, res.ref,
				"approval request: "+err.Error())
		}
	}

	if err := rn.Store.FinishRun(ctx, tenantID, runID, FinishRunInput{
		Status:       RunStatusSucceeded,
		OutputKind:   outputKind,
		OutputRef:    res.ref,
		ApprovalID:   approvalID,
		PromptUsed:   res.prompt,
		ContextUsed:  res.context,
		Reasoning:    res.reasoning,
		DraftPreview: res.preview,
	}); err != nil {
		rn.warn("finish run", err)
		return err
	}
	return nil
}

// draftCampaign: one voice generate call → one status='draft' campaign
// row owned by apps/api.
func (rn *Runner) draftCampaign(ctx context.Context, tenantID string, routine *Routine) (*draftResult, error) {
	audience := audienceContext(routine)
	draft, err := rn.Voice.GenerateCampaignDraft(ctx, tenantID, routine.Prompt, audience)
	if err != nil {
		return nil, fmt.Errorf("voice draft: %w", err)
	}
	if strings.TrimSpace(draft.Name) == "" {
		draft.Name = routine.Name + " — " + time.Now().UTC().Format("2006-01-02")
	}
	if strings.TrimSpace(draft.Subject) == "" {
		draft.Subject = draft.Name
	}
	// Routine campaign drafts are generative-AI output. Mark the persisted HTML
	// before creating either the campaign or immutable run preview so every
	// downstream copy carries the same machine-readable disclosure.
	draft.Body = aidisclosure.MarkHTML(draft.Body)
	id, err := rn.Store.CreateDraftCampaign(ctx, tenantID, draft, routine.TargetSegmentID)
	if err != nil {
		return nil, fmt.Errorf("persist draft campaign: %w", err)
	}
	return &draftResult{
		ref:       id,
		prompt:    routine.Prompt,
		context:   audience,
		reasoning: strings.TrimSpace(draft.Rationale),
		preview:   campaignPreview(draft),
	}, nil
}

// draftSequence: voice brief→steps call, then persist via the voice
// service's manual draft path (status='draft').
func (rn *Runner) draftSequence(ctx context.Context, tenantID string, routine *Routine) (*draftResult, error) {
	audience := audienceContext(routine)
	brief := routine.Prompt
	if audience != "" {
		brief += "\n\n" + audience
	}
	draft, err := rn.Voice.DraftSequence(ctx, tenantID, brief)
	if err != nil {
		return nil, fmt.Errorf("voice sequence draft: %w", err)
	}
	if strings.TrimSpace(draft.Name) == "" {
		draft.Name = routine.Name + " — " + time.Now().UTC().Format("2006-01-02")
	}
	if len(draft.Steps) == 0 {
		return nil, errors.New("voice sequence draft returned no steps")
	}
	id, err := rn.Voice.CreateDraftSequence(ctx, tenantID, draft)
	if err != nil {
		return nil, fmt.Errorf("persist draft sequence: %w", err)
	}
	return &draftResult{
		ref:       id,
		prompt:    routine.Prompt,
		context:   audience,
		reasoning: strings.TrimSpace(draft.Rationale),
		preview:   sequencePreview(draft),
	}, nil
}

// previewBodyMaxRunes caps each body snapshot so the run row's jsonb stays
// bounded even if the model over-produces. Drafts are already short; this
// is a defensive ceiling, not the expected truncation point.
const previewBodyMaxRunes = 8000

// campaignPreview is the compact snapshot the trust UI renders for a
// drafted campaign — what the agent wrote, captured at run time so it
// stays accurate even if a human later edits the draft.
func campaignPreview(d CampaignDraft) json.RawMessage {
	raw, err := json.Marshal(map[string]any{
		"kind":         "campaign",
		"name":         d.Name,
		"subject":      d.Subject,
		"preview_text": d.PreviewText,
		"body":         clampRunes(d.Body, previewBodyMaxRunes),
	})
	if err != nil {
		return nil
	}
	return raw
}

// sequencePreview is the compact snapshot for a drafted sequence: name +
// each step's subject, delay, and (clamped) body.
func sequencePreview(d SequenceDraft) json.RawMessage {
	steps := make([]map[string]any, 0, len(d.Steps))
	for _, s := range d.Steps {
		steps = append(steps, map[string]any{
			"position":    s.Position,
			"delay_hours": s.DelayHours,
			"subject":     s.Subject,
			"body":        clampRunes(s.Body, previewBodyMaxRunes),
		})
	}
	raw, err := json.Marshal(map[string]any{
		"kind":  "sequence",
		"name":  d.Name,
		"steps": steps,
	})
	if err != nil {
		return nil
	}
	return raw
}

// clampRunes truncates s to at most n runes, appending an ellipsis marker
// when it cut anything so the UI can show "(truncated)" honestly.
func clampRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n]) + "…"
}

// audienceContext turns the canonical segment hint into LLM context text. A
// legacy TargetListID is deliberately ignored: that UUID column never matched
// the Listmonk int64 catalog and execution never resolved it to a real list.
// Segment hints remain advisory — the human confirms the audience at review.
func audienceContext(r *Routine) string {
	parts := []string{}
	if r.TargetSegmentID != nil && strings.TrimSpace(*r.TargetSegmentID) != "" {
		parts = append(parts, "Target audience: tenant segment "+*r.TargetSegmentID)
	}
	return strings.Join(parts, "\n")
}

func (rn *Runner) fail(ctx context.Context, tenantID, runID, outputKind, outputRef, msg string) error {
	if err := rn.Store.FinishRun(ctx, tenantID, runID, FinishRunInput{
		Status:     RunStatusFailed,
		OutputKind: outputKind,
		OutputRef:  outputRef,
		ErrMsg:     msg,
	}); err != nil {
		rn.warn("finish failed run", err)
	}
	return errors.New(msg)
}

func (rn *Runner) warn(what string, err error) {
	if rn != nil && rn.Logger != nil && err != nil {
		rn.Logger.Warn("agent_routines: "+what+" failed", "err", err.Error())
	}
}
