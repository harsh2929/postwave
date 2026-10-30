// SPDX-License-Identifier: AGPL-3.0-only
package ai_agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/postwave/postwave/apps/api/internal/agenttools"
)

// This file implements the real in-app agent: a bounded tool-calling loop
// whose tools ARE the shared agenttools registry, executed through the same
// governed chokepoint (agenttools.Execute) as the native MCP endpoint. The
// LLM sits behind LLMClient so the loop is unit-testable without a network.

// LLMContent is one Anthropic-style content block. The single struct serves
// both request serialization and response parsing; omitempty drops the
// fields irrelevant to a given block type.
type LLMContent struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
	// tool_use (assistant)
	ID    string          `json:"id,omitempty"`
	Name  string          `json:"name,omitempty"`
	Input json.RawMessage `json:"input,omitempty"`
	// tool_result (user)
	ToolUseID string `json:"tool_use_id,omitempty"`
	Content   string `json:"content,omitempty"`
	IsError   bool   `json:"is_error,omitempty"`
}

// LLMMessage is one turn in the conversation.
type LLMMessage struct {
	Role    string       `json:"role"`
	Content []LLMContent `json:"content"`
}

// TokenUsage is the model token accounting for a call/run, for the cost
// ledger and per-tenant attribution.
type TokenUsage struct {
	InputTokens  int `json:"input_tokens"`
	OutputTokens int `json:"output_tokens"`
}

// Add accumulates another usage record into u.
func (u *TokenUsage) Add(o TokenUsage) {
	u.InputTokens += o.InputTokens
	u.OutputTokens += o.OutputTokens
}

// LLMResponse is the model's reply.
type LLMResponse struct {
	StopReason string
	Content    []LLMContent
	Usage      TokenUsage
}

// ToolDefn is a tool advertised to the model.
type ToolDefn struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"input_schema"`
}

// LLMClient is the minimal surface the loop needs from a provider. The
// real implementation (anthropicToolClient) talks to the Messages API;
// tests supply a scripted fake.
type LLMClient interface {
	Message(ctx context.Context, system string, messages []LLMMessage, tools []ToolDefn) (*LLMResponse, error)
}

// AgentEvent is a progress event emitted during a run (for SSE streaming).
type AgentEvent struct {
	Type        string          `json:"type"` // tool_call | tool_result | final | maxed_out
	Tool        string          `json:"tool,omitempty"`
	Args        json.RawMessage `json:"args,omitempty"`
	Outcome     string          `json:"outcome,omitempty"`
	Error       string          `json:"error,omitempty"`
	Text        string          `json:"text,omitempty"`
	ApprovalRef string          `json:"approval_ref,omitempty"`
}

// ToolLoop runs the agent. Registry + Governor are shared with the MCP
// surface so the agent reaches the same tools under the same governance.
type ToolLoop struct {
	Registry      *agenttools.Registry
	Governor      agenttools.Governor
	LLM           LLMClient
	System        string
	MaxIterations int
	// Emit, when set, receives progress events as the loop runs (the SSE
	// handler wires this to the response stream). nil disables streaming.
	Emit func(AgentEvent)
	// CostRecorder, when set, is called once at the end of a run with the
	// total token usage, so the runtime can attribute LLM cost to the tenant
	// (the cost ledger). nil disables accounting.
	CostRecorder func(ctx context.Context, caller agenttools.Caller, usage TokenUsage)
}

func (l *ToolLoop) emit(ev AgentEvent) {
	if l.Emit != nil {
		l.Emit(ev)
	}
}

const defaultMaxIterations = 8

const defaultSystemPrompt = "You are Moosewave's in-app marketing agent. Use the provided tools to read and act on the tenant's account on the user's behalf. Prefer reading (e.g. whoami, stats, search) before acting. Never claim an action succeeded unless a tool result confirms it. When a tool reports an action requires human approval, tell the user it is pending approval rather than implying it ran."

// ToolCallRecord is the transcript of one tool invocation.
type ToolCallRecord struct {
	Tool    string          `json:"tool"`
	Args    json.RawMessage `json:"args,omitempty"`
	Outcome string          `json:"outcome"`
	Error   string          `json:"error,omitempty"`
}

// RunResult is the outcome of a full loop.
type RunResult struct {
	Text       string           `json:"text"`
	ToolCalls  []ToolCallRecord `json:"tool_calls"`
	Iterations int              `json:"iterations"`
	Pending    []string         `json:"pending_approvals,omitempty"`
	MaxedOut   bool             `json:"maxed_out,omitempty"`
	Usage      TokenUsage       `json:"usage"`
}

// toolDefs advertises the agent-surface tools the caller is scoped for, so
// the model never sees a tool it cannot call.
func (l *ToolLoop) toolDefs(ctx context.Context) []ToolDefn {
	specs := l.Registry.List(agenttools.SurfaceAgent)
	out := make([]ToolDefn, 0, len(specs))
	for _, s := range specs {
		// The shared execution chokepoint also refuses these. Hiding them keeps
		// the model from planning an action that the structural release boundary
		// cannot execute, while the admin evidence catalogue can still enumerate
		// candidate write capabilities.
		if s.WriteTier && !agenttools.InteractiveWriteTierReleased {
			continue
		}
		if !s.LLMOutputSafe {
			continue
		}
		if len(s.MissingScopes(ctx)) > 0 {
			continue
		}
		out = append(out, ToolDefn{Name: s.Name, Description: s.Description, InputSchema: s.InputSchema})
	}
	return out
}

// Run executes the loop: it appends the user's message to the history and
// repeatedly calls the model, executing any tool_use blocks through the
// governed chokepoint and feeding the results back, until the model stops
// requesting tools or the iteration cap is hit.
func (l *ToolLoop) Run(ctx context.Context, caller agenttools.Caller, history []LLMMessage, userText string) (*RunResult, error) {
	if l.Registry == nil || l.LLM == nil {
		return &RunResult{}, errors.New("ai_agent: loop is not configured (registry or LLM missing)")
	}
	if !agenttools.LLMResultProtectionReady(l.Governor) {
		return &RunResult{}, errors.New("ai_agent: LLM result-protection governor is not configured")
	}
	maxIters := l.MaxIterations
	if maxIters <= 0 {
		maxIters = defaultMaxIterations
	}
	system := l.System
	if strings.TrimSpace(system) == "" {
		system = defaultSystemPrompt
	}
	tools := l.toolDefs(ctx)

	// Caller-supplied history is untrusted: keep only text turns so a client
	// cannot forge prior tool_use/tool_result blocks that misrepresent past
	// outcomes to the model (governance is unaffected either way — new
	// tool_use still routes through Execute).
	msgs := sanitizeHistory(history)
	msgs = append(msgs, LLMMessage{Role: "user", Content: []LLMContent{{Type: "text", Text: userText}}})

	result := &RunResult{}
	// Attribute total token usage to the tenant when the run ends (even on
	// error / cap — tokens spent before the failure still cost).
	if l.CostRecorder != nil {
		defer func() { l.CostRecorder(ctx, caller, result.Usage) }()
	}
	for i := 0; i < maxIters; i++ {
		result.Iterations = i + 1
		if err := ctx.Err(); err != nil {
			return result, err
		}
		resp, err := l.LLM.Message(ctx, system, msgs, tools)
		if err != nil {
			return result, fmt.Errorf("ai_agent: llm call: %w", err)
		}
		result.Usage.Add(resp.Usage)
		// Echo the assistant turn back verbatim, but normalize tool_use
		// blocks to carry a non-empty input object (Anthropic 400s otherwise).
		assistant := normalizeAssistant(resp.Content)
		msgs = append(msgs, LLMMessage{Role: "assistant", Content: assistant})

		var toolUses []LLMContent
		for _, b := range assistant {
			if b.Type == "tool_use" {
				toolUses = append(toolUses, b)
			}
		}
		if len(toolUses) == 0 {
			// Model is done — no more tools requested.
			result.Text = concatText(assistant)
			if result.Text == "" {
				result.Text = "(the agent finished without a textual reply)"
			}
			l.emit(AgentEvent{Type: "final", Text: result.Text})
			return result, nil
		}

		toolResults := make([]LLMContent, 0, len(toolUses))
		for _, tu := range toolUses {
			if tu.Name == "" {
				// Malformed model output: still answer the tool_use id so the
				// conversation turn stays complete for the next request.
				toolResults = append(toolResults, LLMContent{Type: "tool_result", ToolUseID: tu.ID, Content: "tool name missing", IsError: true})
				continue
			}
			l.emit(AgentEvent{Type: "tool_call", Tool: tu.Name, Args: tu.Input})
			res, execErr := agenttools.Execute(ctx, l.Registry, l.Governor, caller, tu.Name, tu.Input)
			content, isErr := renderToolResult(res, execErr)
			if content == "" {
				content = "(empty result)"
			}
			rec := ToolCallRecord{Tool: tu.Name, Args: tu.Input, Outcome: outcomeString(res, execErr)}
			ev := AgentEvent{Type: "tool_result", Tool: tu.Name, Outcome: rec.Outcome}
			if isErr {
				rec.Error = content
				ev.Error = content
			}
			if res != nil && res.IsPending() && res.ApprovalRef != "" {
				result.Pending = append(result.Pending, res.ApprovalRef)
				ev.ApprovalRef = res.ApprovalRef
			}
			l.emit(ev)
			result.ToolCalls = append(result.ToolCalls, rec)
			toolResults = append(toolResults, LLMContent{
				Type:      "tool_result",
				ToolUseID: tu.ID,
				Content:   content,
				IsError:   isErr,
			})
		}
		msgs = append(msgs, LLMMessage{Role: "user", Content: toolResults})
	}

	// Hit the iteration cap without the model finishing — return what we
	// have rather than erroring, and flag it.
	result.MaxedOut = true
	if result.Text == "" {
		result.Text = "(stopped after the maximum number of tool iterations; the task may be incomplete)"
	}
	l.emit(AgentEvent{Type: "maxed_out", Text: result.Text})
	return result, nil
}

// renderToolResult turns an Execute outcome into the tool_result content the
// model sees. Governance denials get a clear, actionable message; infra
// failures are generic (never leak internals); pending approvals are explicit.
func renderToolResult(res *agenttools.Result, err error) (content string, isError bool) {
	if err != nil {
		switch {
		case errors.Is(err, agenttools.ErrScopeDenied):
			return "permission denied: this API key is missing a required scope for that tool", true
		case errors.Is(err, agenttools.ErrWriteTierReleaseHeld):
			return "write-capable agent tools are release-held until mutations, approvals, budgets, and audit evidence are durably coupled", true
		case errors.Is(err, agenttools.ErrLLMDataEgressReleaseHeld):
			return "this tool is release-held because its output is not yet an approved bounded projection for model context", true
		case errors.Is(err, agenttools.ErrInvalidArguments):
			return err.Error(), true
		case errors.Is(err, agenttools.ErrQuotaExceeded):
			return "this tool's per-day quota is exhausted; try again later", true
		case errors.Is(err, agenttools.ErrBudgetExceeded):
			return "the send budget for this key is exhausted", true
		case errors.Is(err, agenttools.ErrMandateDenied):
			return "permission denied: this action is outside the caller's mandate", true
		case errors.Is(err, agenttools.ErrUnknownTool):
			return "the requested tool is unavailable", true
		case errors.Is(err, agenttools.ErrInternal), errors.Is(err, agenttools.ErrScrubFailed):
			return "the tool could not run due to an internal error", true
		default:
			// Defense in depth for a future executor or adapter error. Arbitrary
			// error strings are never model context.
			return "the tool could not run due to an internal error", true
		}
	}
	if res != nil && res.IsPending() {
		return "this action requires human approval and has been queued (ref " + res.ApprovalRef + "); it has NOT run yet", false
	}
	b, mErr := json.Marshal(payloadOf(res))
	if mErr != nil {
		return "the tool result could not be encoded", true
	}
	return string(b), false
}

func payloadOf(res *agenttools.Result) any {
	if res == nil {
		return map[string]any{}
	}
	return res.Payload
}

func outcomeString(res *agenttools.Result, err error) string {
	if res != nil && res.Outcome != "" {
		return string(res.Outcome)
	}
	if err != nil {
		return string(agenttools.OutcomeError)
	}
	return string(agenttools.OutcomeOK)
}

// sanitizeHistory keeps only well-formed text turns from caller-supplied
// history, dropping any client-asserted tool_use/tool_result blocks (and
// any role other than user/assistant). This prevents a forged transcript
// from misrepresenting past tool outcomes to the model.
func sanitizeHistory(history []LLMMessage) []LLMMessage {
	out := make([]LLMMessage, 0, len(history))
	for _, m := range history {
		if m.Role != "user" && m.Role != "assistant" {
			continue
		}
		var text []LLMContent
		for _, b := range m.Content {
			if b.Type == "text" && b.Text != "" {
				text = append(text, LLMContent{Type: "text", Text: b.Text})
			}
		}
		if len(text) > 0 {
			out = append(out, LLMMessage{Role: m.Role, Content: text})
		}
	}
	return out
}

// normalizeAssistant copies the model's content blocks and ensures every
// tool_use block carries a non-empty input object — Anthropic rejects a
// tool_use whose `input` field is missing when the turn is echoed back.
func normalizeAssistant(blocks []LLMContent) []LLMContent {
	out := make([]LLMContent, len(blocks))
	copy(out, blocks)
	for i := range out {
		if out[i].Type == "tool_use" && len(out[i].Input) == 0 {
			out[i].Input = json.RawMessage("{}")
		}
	}
	return out
}

func concatText(blocks []LLMContent) string {
	var sb strings.Builder
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			if sb.Len() > 0 {
				sb.WriteString("\n")
			}
			sb.WriteString(b.Text)
		}
	}
	return sb.String()
}
