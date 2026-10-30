// SPDX-License-Identifier: AGPL-3.0-only
//
// Package ai_agent implements the LLM campaign agent (Phase 3 XL gap
// `sto-ai-campaign-agent`). It mirrors the operator-facing "Composer /
// Operator / Nova Agent" surface shipped by:
//
//   - Klaviyo Composer
//   - Iterable Nova Agent (Apr 2026)
//   - MoEngage Merlin Custom Agents
//   - Braze Operator
//   - Customer.io AI Agent
//
// The model: an operator opens a chat session, types a single high-level
// brief ("Send a Black Friday teaser to power users on Thursday — split
// on subject + send time"), and the agent fans out to grounded tool calls
// to assemble a fully-configured campaign plan: audience selection, copy,
// send time, branching.
//
// Tool surface exposed to the LLM (planned — only the registry skeleton
// is shipped in the v1 scaffold):
//
//	list_segments                    — read the tenant's segments + sizes
//	list_templates                   — read available email templates
//	get_recent_campaign_performance  — feed past open/click rates as
//	                                    per-tenant grounding
//	create_campaign_draft            — write a draft (NOT a send) into
//	                                    the campaigns table
//	schedule_with_sto                — propose a send time via the
//	                                    send-time-optimization engine
//
// The confirm-before-save guardrail: the agent NEVER materializes the
// plan into a real campaign in the same turn it proposes it. The
// session transitions to `pending_confirmation` and the desktop renders
// a diff view; the operator clicks Confirm and only then does the API
// call `/api/v1/ai-agent/sessions/{id}/confirm` to atomically create
// the campaign from the latest `ai_campaign_plans` row.
//
// # SCAFFOLD SCOPE
//
// This v1 ships the data model + handler skeleton + a happy-path stub
// that creates a session, echoes the prompt as a placeholder assistant
// message, and persists a stub plan. The actual LLM tool-call loop
// (multi-turn ReAct, structured-output JSON schema, grounded data
// fetches) is deferred to follow-on work documented in MIGRATION.md.
package ai_agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/aicompose"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/feature_flags"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/httperror"
	"github.com/postwave/postwave/apps/api/internal/middleware"
)

// FlagCampaignsCreateDraft is the feature-flag key that gates real
// campaign materialization from the ai-agent Confirm handler. Until
// the campaigns-package wiring lands, Confirm returns 503 even when
// the flag is set (the flag is the forward-compat hook for the
// follow-on PR that actually implements draft creation).
const FlagCampaignsCreateDraft = "ai_agent.campaigns_create_draft"

// ----- public constants ----------------------------------------------------

// Session lifecycle states (mirrors the CHECK constraint on
// ai_campaign_agent_sessions.status). The desktop renders different
// affordances per state — see ../../apps/desktop/src/components/ai/
// CampaignAgent/ (deferred).
const (
	SessionStatusOpen                = "open"
	SessionStatusPendingConfirmation = "pending_confirmation"
	SessionStatusConfirmed           = "confirmed"
	SessionStatusDiscarded           = "discarded"
)

// Message roles. The `tool` role is for serialized tool-call traces.
const (
	RoleUser      = "user"
	RoleAssistant = "assistant"
	RoleTool      = "tool"
)

// Tool registry — the canonical names the LLM is allowed to call. The
// v1 scaffold ships an empty no-op handler for each; follow-on work
// fills in the real implementations.
const (
	ToolListSegments                 = "list_segments"
	ToolListTemplates                = "list_templates"
	ToolGetRecentCampaignPerformance = "get_recent_campaign_performance"
	ToolCreateCampaignDraft          = "create_campaign_draft"
	ToolScheduleWithSTO              = "schedule_with_sto"
)

// jsonMaxBodyBytes bounds the request body. The richest payload is a
// /messages turn with a long brief; 32KB is generous-but-bounded.
const jsonMaxBodyBytes int64 = 32 << 10

// ----- errors -------------------------------------------------------------

// ErrSessionNotFound is returned when a session ID is unknown or
// belongs to another tenant (RLS would filter it; we surface 404).
var ErrSessionNotFound = errors.New("ai_agent: session not found")

// ErrSessionLocked is returned when the operator attempts to mutate a
// session that has already been confirmed or discarded.
var ErrSessionLocked = errors.New("ai_agent: session is no longer mutable")

// ErrNoPlan is returned when /confirm is called on a session that has
// no plan to materialize.
var ErrNoPlan = errors.New("ai_agent: no plan to confirm")

// ----- domain types -------------------------------------------------------

// Session is the chat thread header. Lifecycle is tracked by `Status`
// (see SessionStatus* constants); the `LastDraft` field holds the
// in-flight plan rendered in the UI (authoritative copy lives in
// ai_campaign_plans).
type Session struct {
	ID         string          `json:"id"`
	TenantID   string          `json:"tenant_id"`
	Title      string          `json:"title"`
	Status     string          `json:"status"`
	LastDraft  json.RawMessage `json:"last_draft,omitempty"`
	CampaignID *string         `json:"campaign_id,omitempty"`
	CreatedAt  time.Time       `json:"created_at"`
	UpdatedAt  time.Time       `json:"updated_at"`
}

// Message is one turn in the conversation. For `role=tool`, ToolName
// carries the canonical tool identifier and ToolPayload is the
// structured output returned to the LLM.
type Message struct {
	ID           string          `json:"id"`
	SessionID    string          `json:"session_id"`
	Role         string          `json:"role"`
	Body         string          `json:"body"`
	ToolName     string          `json:"tool_name,omitempty"`
	ToolPayload  json.RawMessage `json:"tool_payload,omitempty"`
	InputTokens  *int            `json:"input_tokens,omitempty"`
	OutputTokens *int            `json:"output_tokens,omitempty"`
	CreatedAt    time.Time       `json:"created_at"`
}

// CampaignPlan is the structured proposal. The shape is intentionally
// loose JSON in v1 — the LLM emits whatever it thinks the campaign
// should look like, and the desktop's diff view renders it. The
// `Validate` method enforces the minimum required fields at confirm
// time (name + subject + audience at minimum).
type CampaignPlan struct {
	Name        string        `json:"name"`
	Subject     string        `json:"subject"`
	PreviewText string        `json:"preview_text,omitempty"`
	BodyHTML    string        `json:"body_html,omitempty"`
	Audience    PlanAudience  `json:"audience"`
	Schedule    *PlanSchedule `json:"schedule,omitempty"`
	// Branching is reserved for the multi-step plan the operator-class
	// agents (Braze Operator) emit. v1 scaffold returns it as opaque
	// JSON; the materialization step will translate it into journey
	// steps once the journey-builder integration lands.
	Branching json.RawMessage `json:"branching,omitempty"`
}

// PlanAudience identifies which segments to include / exclude.
type PlanAudience struct {
	SegmentIDs          []string `json:"segment_ids"`
	ExclusionSegmentIDs []string `json:"exclusion_segment_ids,omitempty"`
}

// PlanSchedule is the proposed send time. `Mode` is `sto` for
// send-time-optimization (the per-recipient timing engine picks the
// actual moment within the window) or `absolute` for a fixed timestamp.
type PlanSchedule struct {
	Mode      string     `json:"mode"`
	SendAt    *time.Time `json:"send_at,omitempty"`
	STOWindow *string    `json:"sto_window,omitempty"`
}

// Validate enforces the minimum-viable-plan invariants the materializer
// relies on: name + subject + at least one audience segment.
//
// The agent itself MUST emit valid plans (the LLM is prompted with the
// schema); this check is the last-line guardrail on /confirm.
func (p CampaignPlan) Validate() error {
	if strings.TrimSpace(p.Name) == "" {
		return errors.New("plan.name is required")
	}
	if strings.TrimSpace(p.Subject) == "" {
		return errors.New("plan.subject is required")
	}
	if len(p.Audience.SegmentIDs) == 0 {
		return errors.New("plan.audience.segment_ids must include at least one segment")
	}
	return nil
}

// ----- Repo -----------------------------------------------------------------

// Repo is the persistence layer for the ai_agent feature. All methods
// open a tenant-scoped transaction internally and rely on RLS to enforce
// cross-tenant isolation.
type Repo struct {
	Pool *db.Pool
}

// CreateSession opens a new chat session. Title is derived by the
// caller (typically the first 80 chars of the operator's brief).
func (r *Repo) CreateSession(ctx context.Context, tenantID, title string, createdByUser *string) (*Session, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var s Session
	s.TenantID = tenantID
	row := tx.QueryRow(ctx, `
		INSERT INTO ai_campaign_agent_sessions (tenant_id, created_by_user, title)
		VALUES ($1::uuid, $2, $3)
		RETURNING id::text, COALESCE(title,''), status, created_at, updated_at
	`, tenantID, createdByUser, title)
	if err := row.Scan(&s.ID, &s.Title, &s.Status, &s.CreatedAt, &s.UpdatedAt); err != nil {
		return nil, fmt.Errorf("insert session: %w", err)
	}
	s.LastDraft = json.RawMessage(`{}`)
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit session: %w", err)
	}
	return &s, nil
}

// GetSession returns the session by id. Returns ErrSessionNotFound if
// the id is unknown or owned by another tenant (RLS-filtered).
func (r *Repo) GetSession(ctx context.Context, tenantID, sessionID string) (*Session, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	return r.getSessionTx(ctx, tx, sessionID)
}

func (r *Repo) getSessionTx(ctx context.Context, tx pgx.Tx, sessionID string) (*Session, error) {
	var s Session
	var draft []byte
	var campaignID *string
	row := tx.QueryRow(ctx, `
		SELECT id::text, tenant_id::text, COALESCE(title,''), status,
		       COALESCE(last_draft, '{}'::jsonb),
		       campaign_id::text,
		       created_at, updated_at
		  FROM ai_campaign_agent_sessions
		 WHERE id = $1::uuid
	`, sessionID)
	if err := row.Scan(&s.ID, &s.TenantID, &s.Title, &s.Status, &draft,
		&campaignID, &s.CreatedAt, &s.UpdatedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrSessionNotFound
		}
		return nil, fmt.Errorf("select session: %w", err)
	}
	if len(draft) > 0 {
		s.LastDraft = json.RawMessage(draft)
	}
	if campaignID != nil && *campaignID != "" {
		s.CampaignID = campaignID
	}
	return &s, nil
}

// ListSessions returns up to `limit` recent sessions for the tenant,
// ordered by updated_at DESC. Used by the desktop chat history sidebar.
func (r *Repo) ListSessions(ctx context.Context, tenantID string, limit int) ([]Session, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
		SELECT id::text, tenant_id::text, COALESCE(title,''), status,
		       campaign_id::text, created_at, updated_at
		  FROM ai_campaign_agent_sessions
		 ORDER BY updated_at DESC
		 LIMIT $1
	`, limit)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	defer rows.Close()

	out := []Session{}
	for rows.Next() {
		var s Session
		var campaignID *string
		if err := rows.Scan(&s.ID, &s.TenantID, &s.Title, &s.Status,
			&campaignID, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan session: %w", err)
		}
		if campaignID != nil && *campaignID != "" {
			s.CampaignID = campaignID
		}
		out = append(out, s)
	}
	return out, nil
}

// AppendMessage appends a turn to the session. Returns the persisted
// message (with id + created_at filled).
func (r *Repo) AppendMessage(ctx context.Context, tenantID string, m Message) (*Message, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var payload []byte
	if len(m.ToolPayload) > 0 {
		payload = []byte(m.ToolPayload)
	}
	row := tx.QueryRow(ctx, `
		INSERT INTO ai_campaign_agent_messages
		    (tenant_id, session_id, role, body, tool_name, tool_payload, input_tokens, output_tokens)
		VALUES ($1::uuid, $2::uuid, $3, $4, NULLIF($5,''), $6, $7, $8)
		RETURNING id::text, created_at
	`, tenantID, m.SessionID, m.Role, m.Body, m.ToolName, payload, m.InputTokens, m.OutputTokens)
	if err := row.Scan(&m.ID, &m.CreatedAt); err != nil {
		return nil, fmt.Errorf("insert message: %w", err)
	}
	// Bump updated_at on the parent session so the sidebar reorders.
	if _, err := tx.Exec(ctx, `
		UPDATE ai_campaign_agent_sessions
		   SET updated_at = now()
		 WHERE id = $1::uuid
	`, m.SessionID); err != nil {
		return nil, fmt.Errorf("touch session: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit message: %w", err)
	}
	return &m, nil
}

// ListMessages returns all messages for a session ordered chronologically.
func (r *Repo) ListMessages(ctx context.Context, tenantID, sessionID string) ([]Message, error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
		SELECT id::text, session_id::text, role, COALESCE(body,''),
		       COALESCE(tool_name,''), tool_payload,
		       input_tokens, output_tokens, created_at
		  FROM ai_campaign_agent_messages
		 WHERE session_id = $1::uuid
		 ORDER BY created_at ASC
	`, sessionID)
	if err != nil {
		return nil, fmt.Errorf("list messages: %w", err)
	}
	defer rows.Close()

	out := []Message{}
	for rows.Next() {
		var m Message
		var payload []byte
		if err := rows.Scan(&m.ID, &m.SessionID, &m.Role, &m.Body,
			&m.ToolName, &payload, &m.InputTokens, &m.OutputTokens,
			&m.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan message: %w", err)
		}
		if len(payload) > 0 {
			m.ToolPayload = json.RawMessage(payload)
		}
		out = append(out, m)
	}
	return out, nil
}

// SavePlan persists a proposed plan and marks the session as
// `pending_confirmation`. Returns the plan id and version. The
// confirm-before-save guardrail relies on this state transition.
func (r *Repo) SavePlan(ctx context.Context, tenantID, sessionID string, plan CampaignPlan) (planID string, version int, err error) {
	planJSON, err := json.Marshal(plan)
	if err != nil {
		return "", 0, fmt.Errorf("marshal plan: %w", err)
	}

	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	s, err := r.getSessionTx(ctx, tx, sessionID)
	if err != nil {
		return "", 0, err
	}
	if s.Status == SessionStatusConfirmed || s.Status == SessionStatusDiscarded {
		return "", 0, ErrSessionLocked
	}

	// Compute next version (1-based) by looking at the max existing.
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(MAX(plan_version), 0) + 1
		  FROM ai_campaign_plans
		 WHERE session_id = $1::uuid
	`, sessionID).Scan(&version); err != nil {
		return "", 0, fmt.Errorf("compute plan version: %w", err)
	}

	if err := tx.QueryRow(ctx, `
		INSERT INTO ai_campaign_plans (tenant_id, session_id, plan_version, plan)
		VALUES ($1::uuid, $2::uuid, $3, $4::jsonb)
		RETURNING id::text
	`, tenantID, sessionID, version, planJSON).Scan(&planID); err != nil {
		return "", 0, fmt.Errorf("insert plan: %w", err)
	}

	if _, err := tx.Exec(ctx, `
		UPDATE ai_campaign_agent_sessions
		   SET status = $2,
		       last_draft = $3::jsonb,
		       updated_at = now()
		 WHERE id = $1::uuid
	`, sessionID, SessionStatusPendingConfirmation, planJSON); err != nil {
		return "", 0, fmt.Errorf("update session: %w", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return "", 0, fmt.Errorf("commit plan: %w", err)
	}
	return planID, version, nil
}

// LatestPlan returns the most recent plan for a session (highest
// plan_version). Returns ErrNoPlan if the session has no plans yet.
func (r *Repo) LatestPlan(ctx context.Context, tenantID, sessionID string) (planID string, version int, plan CampaignPlan, err error) {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return "", 0, CampaignPlan{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var planJSON []byte
	row := tx.QueryRow(ctx, `
		SELECT id::text, plan_version, plan
		  FROM ai_campaign_plans
		 WHERE session_id = $1::uuid
		 ORDER BY plan_version DESC
		 LIMIT 1
	`, sessionID)
	if err := row.Scan(&planID, &version, &planJSON); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", 0, CampaignPlan{}, ErrNoPlan
		}
		return "", 0, CampaignPlan{}, fmt.Errorf("select latest plan: %w", err)
	}
	if err := json.Unmarshal(planJSON, &plan); err != nil {
		return "", 0, CampaignPlan{}, fmt.Errorf("unmarshal plan: %w", err)
	}
	return planID, version, plan, nil
}

// MarkConfirmed records that `planID` was materialized into a campaign
// and flips the session to `confirmed`. The actual campaign creation is
// the caller's responsibility — this only records the linkage.
func (r *Repo) MarkConfirmed(ctx context.Context, tenantID, sessionID, planID, campaignID string, confirmedByUser *string) error {
	tx, err := db.WithTenant(ctx, r.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `
		UPDATE ai_campaign_plans
		   SET materialized_campaign_id = $2::uuid,
		       confirmed_by_user = $3,
		       confirmed_at = now()
		 WHERE id = $1::uuid
	`, planID, campaignID, confirmedByUser); err != nil {
		return fmt.Errorf("update plan: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE ai_campaign_agent_sessions
		   SET status = $2,
		       campaign_id = $3::uuid,
		       updated_at = now()
		 WHERE id = $1::uuid
	`, sessionID, SessionStatusConfirmed, campaignID); err != nil {
		return fmt.Errorf("update session: %w", err)
	}
	return tx.Commit(ctx)
}

// ----- Agent orchestrator (skeleton) --------------------------------------

// Agent orchestrates one chat turn end-to-end: persist the user
// message, run the tool-call loop, persist the assistant reply,
// optionally produce a plan, and return the rendered turn.
//
// SCAFFOLD: the v1 ship is a happy-path stub. It does NOT actually call
// the LLM tool-call loop — it echoes the operator brief into a
// placeholder plan so the desktop can wire the confirm flow end-to-end
// while the multi-week LLM work is in progress. See MIGRATION.md.
type Agent struct {
	Repo  *Repo
	Voice aicompose.VoiceClient
}

// New constructs an Agent. Voice may be nil to disable LLM fan-out (the
// stub still works — it just emits a deterministic placeholder plan).
func New(repo *Repo, voice aicompose.VoiceClient) *Agent {
	return &Agent{Repo: repo, Voice: voice}
}

// TurnInput is the payload for POST /api/v1/ai-agent/sessions/{id}/messages.
type TurnInput struct {
	// Prompt is the operator's brief for this turn. Required.
	Prompt string `json:"prompt"`
}

// TurnOutput is the response shape — what the desktop renders after a turn.
type TurnOutput struct {
	Session   Session `json:"session"`
	Assistant Message `json:"assistant"`
	// Plan is populated when this turn produced a campaign plan
	// (transitioning the session to `pending_confirmation`).
	Plan        *CampaignPlan `json:"plan,omitempty"`
	PlanID      string        `json:"plan_id,omitempty"`
	PlanVersion int           `json:"plan_version,omitempty"`
}

// Turn runs a single conversational turn. v1 happy-path:
//
//  1. Append the operator's prompt as a `user` message.
//  2. Synthesize a placeholder assistant reply (no LLM call yet).
//  3. Synthesize a stub plan from the prompt (name = brief, subject = brief).
//  4. Append the assistant reply + persist the plan; the session
//     transitions to `pending_confirmation`.
//
// Full ReAct tool-call loop is deferred — see MIGRATION.md.
func (a *Agent) Turn(ctx context.Context, tenantID, sessionID string, in TurnInput) (*TurnOutput, error) {
	prompt := strings.TrimSpace(in.Prompt)
	if prompt == "" {
		return nil, fmt.Errorf("prompt is required")
	}

	// Persist the user turn.
	if _, err := a.Repo.AppendMessage(ctx, tenantID, Message{
		SessionID: sessionID,
		Role:      RoleUser,
		Body:      prompt,
	}); err != nil {
		return nil, err
	}

	// Synthesize a stub plan. Real implementation will fan out to the
	// tool registry (list_segments → list_templates →
	// get_recent_campaign_performance → create_campaign_draft →
	// schedule_with_sto) and let the LLM compose the plan from the
	// grounded outputs.
	plan := CampaignPlan{
		Name:        truncate(prompt, 80),
		Subject:     truncate(prompt, 120),
		PreviewText: "",
		BodyHTML:    "",
		Audience: PlanAudience{
			SegmentIDs: []string{},
		},
		Schedule: &PlanSchedule{
			Mode: "sto",
		},
	}

	planID, version, err := a.Repo.SavePlan(ctx, tenantID, sessionID, plan)
	if err != nil {
		return nil, err
	}

	// Persist the assistant reply (placeholder copy — real impl will
	// stream the LLM's free-form rationale alongside the structured plan).
	assistantBody := "Drafted a placeholder plan from your brief. " +
		"Review the proposed name, subject, audience, and schedule, " +
		"then click Confirm to create the campaign."
	asst, err := a.Repo.AppendMessage(ctx, tenantID, Message{
		SessionID: sessionID,
		Role:      RoleAssistant,
		Body:      assistantBody,
	})
	if err != nil {
		return nil, err
	}

	session, err := a.Repo.GetSession(ctx, tenantID, sessionID)
	if err != nil {
		return nil, err
	}

	return &TurnOutput{
		Session:     *session,
		Assistant:   *asst,
		Plan:        &plan,
		PlanID:      planID,
		PlanVersion: version,
	}, nil
}

// ----- HTTP handlers -------------------------------------------------------

// Deps wires the agent into the HTTP layer.
type Deps struct {
	Repo  *Repo
	Agent *Agent
	// Logger is used by httperror.WriteInternal so 5xx responses log
	// the underlying error (with tenant_id + request_id) instead of
	// echoing err.Error() back to the client. Wired by the caller after
	// construction; nil-safe at the httperror call site.
	Logger *slog.Logger
}

// MountRoutes registers the routes onto the API router under
// /api/v1/ai-agent. Scoped to ScopeWriteCampaigns because the surface
// ultimately creates campaigns; the read endpoints share the scope so
// the desktop can use a single API key.
func MountRoutes(r chi.Router, d *Deps) {
	if d == nil || d.Repo == nil {
		return
	}
	h := &handlers{deps: d}
	r.Route("/api/v1/ai-agent", func(r chi.Router) {
		r.Use(apikeys.RequireScope(apikeys.ScopeWriteCampaigns))
		r.Get("/sessions", h.ListSessions)
		r.Post("/sessions", h.CreateSession)
		r.Get("/sessions/{id}", h.GetSession)
		r.Get("/sessions/{id}/messages", h.ListMessages)
		r.Post("/sessions/{id}/messages", h.PostMessage)
		r.Post("/sessions/{id}/confirm", h.Confirm)
		r.Post("/sessions/{id}/discard", h.Discard)
	})
}

type handlers struct {
	deps *Deps
}

// ListSessions handles GET /api/v1/ai-agent/sessions.
func (h *handlers) ListSessions(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	out, err := h.deps.Repo.ListSessions(r.Context(), t.ID, 50)
	if err != nil {
		httperror.WriteInternal(w, h.deps.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
}

// CreateSession handles POST /api/v1/ai-agent/sessions.
func (h *handlers) CreateSession(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	var body struct {
		Title string `json:"title"`
	}
	if err := httpbody.DecodeJSON(w, r, jsonMaxBodyBytes, &body); err != nil {
		// httpbody error codes (bad_json, payload_too_large) are in the
		// httperror safe-echo allowlist — the message text is
		// operator-authored by httpbody itself.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	s, err := h.deps.Repo.CreateSession(r.Context(), t.ID, body.Title, nil)
	if err != nil {
		httperror.WriteInternal(w, h.deps.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusCreated, s)
}

// GetSession handles GET /api/v1/ai-agent/sessions/{id}.
func (h *handlers) GetSession(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	s, err := h.deps.Repo.GetSession(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrSessionNotFound) {
			writeErr(w, http.StatusNotFound, "not_found", "session not found")
			return
		}
		httperror.WriteInternal(w, h.deps.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// ListMessages handles GET /api/v1/ai-agent/sessions/{id}/messages.
func (h *handlers) ListMessages(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	out, err := h.deps.Repo.ListMessages(r.Context(), t.ID, id)
	if err != nil {
		httperror.WriteInternal(w, h.deps.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": out})
}

// PostMessage handles POST /api/v1/ai-agent/sessions/{id}/messages —
// the single chat turn. Returns the assistant reply + any new plan.
func (h *handlers) PostMessage(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	var in TurnInput
	if err := httpbody.DecodeJSON(w, r, jsonMaxBodyBytes, &in); err != nil {
		// httpbody error codes are in the httperror safe-echo allowlist.
		httperror.Write(w, httpbody.StatusCode(err), httpbody.ErrorCode(err), httpbody.PublicMessage(err))
		return
	}
	if h.deps.Agent == nil {
		writeErr(w, http.StatusServiceUnavailable, "agent_unavailable",
			"ai agent is not configured")
		return
	}
	// Verify the session belongs to this tenant (RLS-filtered).
	if _, err := h.deps.Repo.GetSession(r.Context(), t.ID, id); err != nil {
		if errors.Is(err, ErrSessionNotFound) {
			writeErr(w, http.StatusNotFound, "not_found", "session not found")
			return
		}
		httperror.WriteInternal(w, h.deps.Logger, err, r.Context())
		return
	}
	out, err := h.deps.Agent.Turn(r.Context(), t.ID, id, in)
	if err != nil {
		if errors.Is(err, ErrSessionLocked) {
			// Operator-authored sentinel — safe to echo verbatim.
			httperror.Write(w, http.StatusConflict, "session_locked", err.Error())
			return
		}
		// Turn() validation errors (prompt required) are our own strings
		// — safe to echo via WriteValidation.
		httperror.WriteValidation(w, "turn_failed", "request could not be processed")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// Confirm handles POST /api/v1/ai-agent/sessions/{id}/confirm — the
// guardrail. Validates the latest plan and would materialize it into
// a real campaign, but the materialization path isn't wired yet.
//
// IMPORTANT: the previous scaffold generated a random UUID and
// persisted it as if a real campaign had been created — which
// silently broke the desktop's "open campaign" link and produced
// dangling FKs in audit history. We now return 503 to surface the
// missing dependency loudly. The handler is gated behind the
// `ai_agent.campaigns_create_draft` feature flag so the follow-on PR
// that actually implements draft creation can enable it per-tenant
// without redeploying.
func (h *handlers) Confirm(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")
	planID, _, plan, err := h.deps.Repo.LatestPlan(r.Context(), t.ID, id)
	if err != nil {
		if errors.Is(err, ErrNoPlan) {
			writeErr(w, http.StatusBadRequest, "no_plan", "no plan to confirm")
			return
		}
		httperror.WriteInternal(w, h.deps.Logger, err, r.Context())
		return
	}
	if err := plan.Validate(); err != nil {
		// Validate() returns our own validator strings — safe to echo.
		httperror.WriteValidation(w, "plan_invalid", err.Error())
		return
	}

	// Feature-flag gate. Even when the flag is enabled, the real
	// materialization path isn't wired yet — but having the gate in
	// place means the follow-on PR is a one-line change. Today every
	// path falls through to the 503 below; once draft creation is
	// wired, the gate will dispatch into the campaigns package when
	// the flag is on and keep returning 503 when off.
	_ = feature_flags.IsEnabled(r.Context(), h.deps.Repo.Pool, t.ID, FlagCampaignsCreateDraft)
	_ = planID

	writeErr(w, http.StatusServiceUnavailable, "confirm_unimplemented",
		"Campaign creation from agent confirm not yet wired")
}

// Discard handles POST /api/v1/ai-agent/sessions/{id}/discard.
func (h *handlers) Discard(w http.ResponseWriter, r *http.Request) {
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok {
		writeErr(w, http.StatusUnauthorized, "no_tenant", "tenant required")
		return
	}
	id := chi.URLParam(r, "id")

	tx, err := db.WithTenant(r.Context(), h.deps.Repo.Pool, t.ID)
	if err != nil {
		httperror.WriteInternal(w, h.deps.Logger, err, r.Context())
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	tag, err := tx.Exec(r.Context(), `
		UPDATE ai_campaign_agent_sessions
		   SET status = $2, updated_at = now()
		 WHERE id = $1::uuid
		   AND status IN ($3, $4)
	`, id, SessionStatusDiscarded, SessionStatusOpen, SessionStatusPendingConfirmation)
	if err != nil {
		httperror.WriteInternal(w, h.deps.Logger, err, r.Context())
		return
	}
	if tag.RowsAffected() == 0 {
		writeErr(w, http.StatusConflict, "not_discardable",
			"session not found or already terminal")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		httperror.WriteInternal(w, h.deps.Logger, err, r.Context())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": SessionStatusDiscarded})
}

// ----- helpers -------------------------------------------------------------

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return strings.TrimSpace(string(r[:n]))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{"code": code, "message": msg},
	})
}
