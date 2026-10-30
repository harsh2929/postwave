// SPDX-License-Identifier: AGPL-3.0-only
package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/postwave/postwave/apps/api/internal/agenttools"
	"github.com/postwave/postwave/apps/api/internal/apikeys"
	"github.com/postwave/postwave/apps/api/internal/budgets"
	"github.com/postwave/postwave/apps/api/internal/campaigntemplates"
	"github.com/postwave/postwave/apps/api/internal/db"
	"github.com/postwave/postwave/apps/api/internal/httpbody"
	"github.com/postwave/postwave/apps/api/internal/middleware"
	"github.com/postwave/postwave/apps/api/internal/subscribers"
)

// ProtocolVersion identifies the published MCP revision whose JSON-RPC message
// shapes this preview follows. It is not a claim of Streamable HTTP lifecycle
// conformance; NativeProtocolLifecycleReleased remains false.
const ProtocolVersion = "2025-06-18"

// NativeProtocolLifecycleReleased is the transport qualification boundary.
// The preview does not yet negotiate initialize params or maintain the
// initialize -> notifications/initialized lifecycle required by MCP.
const NativeProtocolLifecycleReleased = false

// NativeProtocolReleaseHoldCode is stable across headers, initialize metadata,
// and the curated OpenAPI description.
const NativeProtocolReleaseHoldCode = "mcp_streamable_http_lifecycle_release_held"

// MaxRPCBody bounds the request body the RPC endpoint will read.
// Larger frames are 413'd at the httpbody layer. Tool arguments are
// always small in practice; 256 KiB leaves headroom for batched calls.
const MaxRPCBody = 256 * 1024

// NativeWriteTierReleased is a compile-time release boundary. Native write
// handlers currently commit their domain mutation before audit evidence and
// send-budget usage are durably recorded. Until those effects share an atomic
// transaction/outbox boundary, no tenant setting may make a write tool
// discoverable or executable.
const NativeWriteTierReleased = false

// NativeWriteTierReleaseHoldCode is stable across the REST settings surface
// and JSON-RPC error data so clients can render an honest release hold without
// matching human-readable text.
const NativeWriteTierReleaseHoldCode = "mcp_write_tier_release_held"

// JSON-RPC standard error codes (see https://www.jsonrpc.org/specification).
const (
	errParseError     = -32700
	errInvalidRequest = -32600
	errMethodNotFound = -32601
	errInvalidParams  = -32602
	errInternalError  = -32603

	// MCP-tier transport errors (-32001..-32099 are spec-reserved
	// for transport). We use -32010 = tenant disabled the surface.
	errTenantDisabled = -32010
	errScopeDenied    = -32011
	errQuotaExceeded  = -32012
	errBudgetExceeded = -32013
	errWriteTierHeld  = -32014
)

func nativeWriteTierEnabled(s *Settings) bool {
	return NativeWriteTierReleased && s != nil && s.WriteEnabled
}

// Deps wires the package to the surrounding runtime. The pool is
// the only hard dependency; everything else (clock, logger) is
// injected in tests.
type Deps struct {
	Pool *db.Pool
	// Now is the clock used for the call-log entries. Defaults to
	// time.Now when nil so production callers don't have to wire it.
	Now func() time.Time
	// Gov is the governance adapter every tool call routes through. It is a
	// hard dependency for read and write execution: read tools can return
	// subscriber PII to an LLM-facing caller, so a nil/no-op governor must fail
	// closed rather than treating the read tier as inherently safe.
	Gov agenttools.Governor
	// Budgets, when set, lets the whoami / self-info path report the
	// caller's remaining send + cost budget. Optional: nil simply omits
	// those fields.
	Budgets budgets.Checker

	// Delegation services for the native write tools (1.3b). Each is the
	// narrow slice of a domain service that the corresponding tool calls
	// directly (bare-handler delegation — no router, single governance
	// pass). A nil seam disables only its own tool's handler (it returns a
	// clean "not available" error); the registry still builds and validates,
	// so dev/test wirings that omit these keep working.
	CampaignCreate campaignCreator
	CampaignSend   campaignSender
	TagCreate      tagCreator
	SubTagApply    subscriberTagApplier
	AssetUpload    assetUploader
	ListCreate     listCreator
	// SubscriberRepo is the canonical aggregate writer for identity aliases.
	// MCP must never write profile_aliases directly: the subscriber service
	// owns exact revisions, collision prevention, audit/webhook evidence, and
	// delivery-engine reconciliation.
	SubscriberRepo subscriberAliasWriter

	// Visual campaign-template catalog + reference-aware design generator.
	// Read tools only need CampaignTemplates; AI adaptation/generation also
	// require TemplateGenerator, while draft creation reuses CampaignCreate.
	CampaignTemplates CampaignTemplateCatalog
	TemplateGenerator campaigntemplates.TemplateGenerator
	// CampaignTemplateWorkflow is the canonical durable design application
	// service shared with REST. Native MCP must not duplicate generation,
	// validation, revision, or commit logic.
	CampaignTemplateWorkflow campaignTemplateWorkflow

	reg     *agenttools.Registry
	regOnce sync.Once
}

type subscriberAliasWriter interface {
	UpsertAlias(
		ctx context.Context,
		tenantID, subscriberID string,
		in subscribers.AliasInput,
		ifMatchToken string,
		auditMeta db.AuditMeta,
	) (*subscribers.Alias, error)
}

// Registry returns the shared agenttools registry, building and validating
// it once. A malformed tool panics here — call Registry() at startup (it is
// also exercised by the package tests) so the assertion fires before any
// request is served.
func (d *Deps) Registry() *agenttools.Registry {
	d.regOnce.Do(func() {
		d.reg = d.buildRegistry()
		if err := d.reg.Validate(); err != nil {
			panic("mcp: tool registry failed validation: " + err.Error())
		}
	})
	return d.reg
}

// now returns d.Now() or wall-clock time when unset.
func (d *Deps) now() time.Time {
	if d == nil || d.Now == nil {
		return time.Now().UTC()
	}
	return d.Now().UTC()
}

// HandleRPC is the http.Handler for POST /api/v1/mcp/rpc — the
// JSON-RPC 2.0 entry point. The upstream apikeys middleware has
// already attached the tenant + scopes to ctx; this handler
// dispatches on `method` and runs the appropriate MCP routine.
func (d *Deps) HandleRPC(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("X-Postwave-MCP-Mode", "native-json-rpc-readonly-preview")
	w.Header().Set("X-Postwave-MCP-Lifecycle-Qualified", "false")
	w.Header().Set("X-Postwave-MCP-Write-Tier", "release-held")
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{
			"error": map[string]any{"code": "method_not_allowed",
				"message": "POST is required for /api/v1/mcp/rpc"},
		})
		return
	}
	t, ok := middleware.TenantFromContext(r.Context())
	if !ok || t == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"error": map[string]any{"code": "no_tenant",
				"message": "MCP RPC requires an authenticated bearer token"},
		})
		return
	}

	// Per-tenant master switch. When the operator has toggled the
	// surface off, every RPC method returns the disabled error so
	// the LLM can surface a sensible message.
	settings, err := d.loadOrInitSettings(r.Context(), t.ID)
	if err != nil {
		writeRPCError(w, nil, errInternalError, "failed to load tenant settings", nil)
		return
	}
	if !settings.Enabled {
		writeRPCError(w, nil, errTenantDisabled,
			"MCP server is disabled for this tenant; enable it from Settings > MCP", nil)
		return
	}

	var req rpcRequest
	if err := httpbody.DecodeJSON(w, r, MaxRPCBody, &req); err != nil {
		if errors.Is(err, httpbody.ErrTooLarge) || errors.Is(err, httpbody.ErrUnsupportedMediaType) {
			writeJSON(w, httpbody.StatusCode(err), map[string]any{
				"error": map[string]any{"code": httpbody.ErrorCode(err),
					"message": httpbody.PublicMessage(err)},
			})
			return
		}
		writeRPCError(w, nil, errParseError, "invalid JSON-RPC envelope", nil)
		return
	}
	if req.JSONRPC != "2.0" {
		writeRPCError(w, req.ID, errInvalidRequest, "jsonrpc must be \"2.0\"", nil)
		return
	}

	switch req.Method {
	case "initialize":
		d.handleInitialize(r.Context(), w, &req, t.ID)
	case "tools/list":
		d.handleToolsList(r.Context(), w, &req, settings)
	case "tools/call":
		d.handleToolsCall(r.Context(), w, &req, settings)
	case "ping":
		// MCP defines a no-op `ping` for liveness checks.
		writeRPCResult(w, req.ID, map[string]any{})
	default:
		writeRPCError(w, req.ID, errMethodNotFound,
			"unknown method "+req.Method+" (supported: initialize, tools/list, tools/call, ping)", nil)
	}
}

// handleInitialize is the protocol handshake. The LLM client opens
// the connection, sends `initialize` with its own protocolVersion +
// capabilities, and we reply with the server-side info. Touching the
// last_handshake_at column gives the dashboard a "last connected"
// timestamp.
func (d *Deps) handleInitialize(ctx context.Context, w http.ResponseWriter, req *rpcRequest, tenantID string) {
	result := initResult{
		ProtocolVersion: ProtocolVersion,
		ServerInfo: serverInfo{
			Name:    "postwave-mcp",
			Version: "1.0.0",
		},
		Capabilities: capabilities{
			Tools: toolsCapability{ListChanged: false},
		},
		Instructions:         "Moosewave native read-only JSON-RPC preview. This endpoint is not yet qualified MCP Streamable HTTP: initialize-first state, initialized notifications, and request protocol-version enforcement are release-held. Call tools/list to discover scoped reads with explicitly reviewed bounded model-output projections. Input schemas are server-enforced; annotations are untrusted hints, not approval. Other reads and all writes remain release-held.",
		TransportMode:        "native_json_rpc_readonly_preview",
		LifecycleQualified:   NativeProtocolLifecycleReleased,
		InputSchemaEnforced:  true,
		WriteTierAvailable:   agenttools.InteractiveWriteTierReleased && NativeWriteTierReleased,
		ProtocolReleaseHold:  NativeProtocolReleaseHoldCode,
		WriteTierReleaseHold: NativeWriteTierReleaseHoldCode,
	}
	_ = d.touchHandshake(ctx, tenantID)
	writeRPCResult(w, req.ID, result)
}

// handleToolsList enumerates the tools the bearer token can call.
// Three filters compose: (1) the scope check on each tool, (2) the
// per-tenant allowed_tools list (if set), (3) the structural write-tier
// release boundary. A persisted write_enabled value cannot bypass the hold.
func (d *Deps) handleToolsList(ctx context.Context, w http.ResponseWriter, req *rpcRequest, s *Settings) {
	allowed := make(map[string]struct{}, len(s.AllowedTools))
	for _, name := range s.AllowedTools {
		allowed[name] = struct{}{}
	}
	useAllowlist := len(allowed) > 0
	specs := d.Registry().List(agenttools.SurfaceMCP)
	tools := make([]toolDescriptor, 0, len(specs))
	for _, spec := range specs {
		if spec.WriteTier && !nativeWriteTierEnabled(s) {
			continue
		}
		if !spec.LLMOutputSafe {
			continue
		}
		if useAllowlist {
			if _, ok := allowed[spec.Name]; !ok {
				continue
			}
		}
		if len(spec.MissingScopes(ctx)) > 0 {
			continue
		}
		ann := spec.Annotations // copy so &ann is per-iteration
		tools = append(tools, toolDescriptor{
			Name:         spec.Name,
			Description:  spec.Description,
			InputSchema:  spec.InputSchema,
			OutputSchema: spec.OutputSchema,
			Annotations:  &ann,
		})
	}
	writeRPCResult(w, req.ID, toolsListResult{Tools: tools})
}

// handleToolsCall executes one tool. It enforces the same three
// filters as tools/list (so a client can't "discover" a tool by
// calling it directly when it was hidden) and records the outcome
// in mcp_server_call_log for the dashboard.
func (d *Deps) handleToolsCall(ctx context.Context, w http.ResponseWriter, req *rpcRequest, s *Settings) {
	var params toolCallParams
	if len(req.Params) > 0 {
		if err := json.Unmarshal(req.Params, &params); err != nil {
			writeRPCError(w, req.ID, errInvalidParams, "params must be {name, arguments}", nil)
			return
		}
	}
	if params.Name == "" {
		writeRPCError(w, req.ID, errInvalidParams, "tool name is required", nil)
		return
	}
	spec := d.Registry().Lookup(params.Name)
	if spec == nil || !spec.ExposedOn(agenttools.SurfaceMCP) {
		writeRPCError(w, req.ID, errMethodNotFound, "unknown tool: "+params.Name, nil)
		return
	}
	// MCP-surface tenant policy gates (distinct from the shared gauntlet):
	// the write-enabled master switch and the per-tenant allowlist. These
	// live in mcp_server_settings, so they are checked here and logged
	// directly (the gauntlet does not know about them).
	if spec.WriteTier && !nativeWriteTierEnabled(s) {
		d.logCall(ctx, params.Name, "denied", 0)
		writeRPCError(w, req.ID, errWriteTierHeld,
			"write-tier tools are unavailable until durable mutation, budget, and audit coupling is released",
			map[string]string{"code": NativeWriteTierReleaseHoldCode})
		return
	}
	if !spec.LLMOutputSafe {
		d.logCall(ctx, params.Name, "denied", 0)
		writeRPCError(w, req.ID, errScopeDenied,
			"tool output is not yet approved for model context",
			map[string]string{"code": agenttools.LLMDataEgressReleaseHoldCode})
		return
	}
	if !agenttools.LLMResultProtectionReady(d.Gov) {
		writeRPCError(w, req.ID, errInternalError,
			"native tool execution is unavailable because the LLM result-protection governor is not configured",
			map[string]string{"code": "mcp_result_protection_unavailable"})
		return
	}
	// Governance precondition: a write-tier tool must never run without the
	// full governance adapter (budgets/approvals/quota/audit). Refuse here
	// even if the tenant enabled writes but the deployment forgot to wire
	// the governor — writes can never bypass governance.
	if spec.WriteTier && d.Gov == nil {
		d.logCall(ctx, params.Name, "denied", 0)
		writeRPCError(w, req.ID, errInternalError,
			"write-tier tools are unavailable: the governance adapter is not configured", nil)
		return
	}
	if len(s.AllowedTools) > 0 && !containsString(s.AllowedTools, params.Name) {
		d.logCall(ctx, params.Name, "denied", 0)
		writeRPCError(w, req.ID, errScopeDenied,
			"tool is not in the per-tenant allowlist", nil)
		return
	}

	// The shared governed chokepoint: scopes -> quota -> sandbox -> send
	// budget -> approval -> handler -> PII scrub -> audit (cross-surface
	// audit_log, via the injected governor). The mcp_server_call_log
	// dashboard row is written here so it is independent of which governor
	// is wired.
	res, err := agenttools.Execute(ctx, d.Registry(), d.governor(), callerFromCtx(ctx), params.Name, params.Arguments)
	d.logCall(ctx, params.Name, callLogOutcome(res.Outcome), res.LatencyMs)
	if err == nil && (res.Ran() || res.IsSandboxed()) {
		// A sandbox simulation is still tenant activity for the dashboard.
		_ = d.touchLastToolCall(ctx, tenantFromCtx(ctx))
	}
	d.writeToolCallResult(w, req, res, err)
}

// loadOrInitSettings reads the per-tenant settings row, lazily
// inserting a default row on first contact. The row never blocks the
// request — a default Settings (Enabled=true, WriteEnabled=false) is
// returned if even the insert fails (the operator can still flip the
// flag from the desktop later).
func (d *Deps) loadOrInitSettings(ctx context.Context, tenantID string) (*Settings, error) {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	s, err := loadSettings(ctx, tx, tenantID)
	if err == nil {
		return s, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, err
	}
	// Lazy insert. ON CONFLICT DO NOTHING handles the race where two
	// RPC frames hit a brand-new tenant simultaneously.
	if _, err := tx.Exec(ctx, `
INSERT INTO mcp_server_settings (tenant_id, enabled, write_enabled)
VALUES ($1::uuid, true, false)
ON CONFLICT (tenant_id) DO NOTHING`, tenantID); err != nil {
		return nil, err
	}
	s2, err := loadSettings(ctx, tx, tenantID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return s2, nil
}

// touchHandshake updates last_handshake_at. Best-effort — failures
// are swallowed because they're cosmetic (the dashboard surface).
func (d *Deps) touchHandshake(ctx context.Context, tenantID string) error {
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE mcp_server_settings
   SET last_handshake_at = now(),
       updated_at = now()
 WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (d *Deps) touchLastToolCall(ctx context.Context, tenantID string) error {
	if tenantID == "" {
		return nil
	}
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `
UPDATE mcp_server_settings
   SET last_tool_call_at = now(),
       updated_at = now()
 WHERE tenant_id = $1::uuid`, tenantID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// logCall inserts one mcp_server_call_log row. Best-effort — a
// failure here must not block the RPC from returning a result.
func (d *Deps) logCall(ctx context.Context, toolName, outcome string, latencyMs int) {
	tenantID := tenantFromCtx(ctx)
	if tenantID == "" {
		return
	}
	keyID := middleware.APIKeyIDFromContext(ctx)
	tx, err := db.WithTenant(ctx, d.Pool, tenantID)
	if err != nil {
		return
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var keyArg any
	if keyID != "" {
		keyArg = keyID
	}
	_, _ = tx.Exec(ctx, `
INSERT INTO mcp_server_call_log (tenant_id, tool_name, api_key_id, latency_ms, outcome)
VALUES ($1::uuid, $2, NULLIF($3::text, '')::uuid, $4, $5)`,
		tenantID, toolName, keyArg, latencyMs, outcome)
	_ = tx.Commit(ctx)
}

func tenantFromCtx(ctx context.Context) string {
	t, ok := middleware.TenantFromContext(ctx)
	if !ok || t == nil {
		return ""
	}
	return t.ID
}

func containsString(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

func scopeListFor(scopes []apikeys.Scope) []string {
	out := make([]string, 0, len(scopes))
	for _, s := range scopes {
		out = append(out, string(s))
	}
	return out
}

// ---------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------

func writeRPCResult(w http.ResponseWriter, id json.RawMessage, result any) {
	writeJSON(w, http.StatusOK, rpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result:  result,
	})
}

func writeRPCError(w http.ResponseWriter, id json.RawMessage, code int, message string, data any) {
	// RPC-level errors return HTTP 200 with an `error` payload —
	// per JSON-RPC 2.0, the transport is happy as long as the JSON
	// is well-formed. Truly fatal HTTP-level errors (auth, body
	// limit) are returned via plain writeJSON with a non-200.
	writeJSON(w, http.StatusOK, rpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error:   &rpcError{Code: code, Message: message, Data: data},
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
