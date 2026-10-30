// SPDX-License-Identifier: AGPL-3.0-only
package agenttools

import (
	"context"
	"encoding/json"

	"github.com/postwave/postwave/apps/api/internal/apikeys"
)

// Surface identifies which agent surface a tool is exposed on / invoked
// from. A ToolSpec with no Surfaces is exposed on every executable
// surface (MCP + in-app agent); proxy-only long-tail tools that have no
// native Go handler yet declare {SurfaceProxy} so the manifest lists
// them but the native server does not.
type Surface string

const (
	// SurfaceMCP is the native JSON-RPC MCP endpoint (/api/v1/mcp/rpc).
	SurfaceMCP Surface = "mcp"
	// SurfaceAgent is the in-app AI agent tool-calling loop.
	SurfaceAgent Surface = "agent"
	// SurfaceProxy is the npm proxy. Proxy tools appear in the generated
	// manifest but are not executed through this package.
	SurfaceProxy Surface = "proxy"
)

// Category groups tools for discovery (the search_tools meta-tool and
// the generated catalogs). Kept as a string type with conventional
// constants rather than a closed enum so adding a domain is a one-liner.
type Category string

const (
	CategoryAudience       Category = "audience"
	CategoryCampaigns      Category = "campaigns"
	CategoryAnalytics      Category = "analytics"
	CategoryAutomation     Category = "automation"
	CategoryDeliverability Category = "deliverability"
	CategoryContent        Category = "content"
	CategoryForms          Category = "forms"
	CategoryIntegrations   Category = "integrations"
	CategoryDeveloper      Category = "developer"
	CategoryPlatform       Category = "platform"
)

// Annotations are MCP tool behavior hints (MCP spec 2025-06-18+). They
// let a client decide whether a tool is safe to auto-approve and how to
// present it. Moosewave derives the wire field names from this struct.
//
// Invariant (enforced by [Registry.Validate]): a tool is either a
// read-only tool (ReadOnly=true, WriteTier=false) or a mutating tool
// (ReadOnly=false). Destructive tools must be WriteTier.
type Annotations struct {
	// ReadOnly: the tool does not modify any state.
	ReadOnly bool `json:"readOnlyHint"`
	// Destructive: the tool may perform irreversible updates/deletes or
	// outward-facing effects (e.g. revoking a key, committing a
	// migration). Destructive tools route through the approval gate.
	Destructive bool `json:"destructiveHint"`
	// Idempotent: repeated calls with the same arguments have no
	// additional effect beyond the first (safe to retry).
	Idempotent bool `json:"idempotentHint"`
	// OpenWorld: the tool interacts with external systems (e.g. sends
	// email, calls a third-party API).
	OpenWorld bool `json:"openWorldHint"`
}

// Handler executes a tool. The context carries the tenant id, the API
// key scopes, and (when set) the sandbox flag — exactly as attached by
// the apikeys middleware. args is the raw arguments object; each handler
// unmarshals it into its own typed input. The returned value is JSON
// marshaled by the calling surface.
type Handler func(ctx context.Context, args json.RawMessage) (any, error)

// ToolSpec is the canonical declaration of one agent capability. It is
// the single source of truth from which the native MCP tool list, the
// in-app agent tool set, and the generated proxy/catalog manifests are
// derived.
type ToolSpec struct {
	// Name is the wire identifier. snake_case is conventional in MCP.
	Name string
	// Category groups the tool for discovery and the catalogs.
	Category Category
	// Description is the LLM-facing one-liner: when to use it, what
	// arguments it expects, and roughly what shape the result takes so
	// the model can plan multi-tool flows.
	Description string
	// InputSchema is a JSON Schema fragment documenting the arguments.
	InputSchema json.RawMessage
	// OutputSchema, when non-nil, types the tool result so the surface
	// can emit MCP structuredContent the model can consume directly.
	OutputSchema json.RawMessage
	// RequiredScopes is the conjunction of API-key scopes the caller
	// must hold. Empty means "any authenticated caller".
	RequiredScopes []apikeys.Scope
	// WriteTier is true for tools that mutate state. Hidden from the
	// native tools/list when mcp_server_settings.write_enabled = false.
	WriteTier bool
	// LLMOutputSafe is an explicit, reviewed output contract. It is true only
	// when this tool's result is a bounded projection that is safe to place in
	// model context. Read-only is not enough: subscriber profiles, campaign
	// content, URLs, tags, and other tenant-defined strings may still contain
	// personal or sensitive data. LLM-facing surfaces fail closed and hide a
	// tool unless this bit is set; the result scrubber remains defense in depth.
	LLMOutputSafe bool
	// ChargesSend is true for tools that consume the per-key send
	// budget (i.e. cause email to go out). Declaring it here is what
	// makes send-budget enforcement work on every surface, instead of a
	// brittle URL-path classifier that silently missed /mcp/rpc.
	ChargesSend bool
	// Annotations are the MCP behavior hints.
	Annotations Annotations
	// Surfaces restricts which surfaces expose/execute the tool. Empty
	// == all executable surfaces (MCP + agent).
	Surfaces []Surface
	// Handler runs the tool. nil is permitted for proxy-only specs and
	// for codegen (which reads metadata only); [Execute] refuses to run
	// a tool with a nil handler.
	Handler Handler
}

// IsExecutable reports whether tools actually run on this surface (as
// opposed to merely appearing in a generated manifest). MCP and the
// in-app agent execute; the proxy listing does not run through this
// package. This is the single definition of "executable surface" that
// ExposedOn and Registry.Validate both consult.
func IsExecutable(s Surface) bool {
	return s == SurfaceMCP || s == SurfaceAgent
}

// ExposedOn reports whether the tool is exposed on the given surface.
// A spec with no Surfaces is exposed on every executable surface
// (MCP + agent) but not implicitly on the proxy-only listing.
func (t *ToolSpec) ExposedOn(s Surface) bool {
	if len(t.Surfaces) == 0 {
		return IsExecutable(s)
	}
	for _, x := range t.Surfaces {
		if x == s {
			return true
		}
	}
	return false
}

// Caller carries the identity invoking a tool.
//
// Authority model: the API-key *scopes* are the one piece of identity
// that [Execute] reads from the context (via apikeys.HasAllScopes), not
// from this struct — so the scope check exercises the exact same path as
// the rest of the API and there is a single source of truth for
// authorization. The sandbox decision is likewise cross-checked against
// the context flag (see [Execute]). The remaining fields here are a
// denormalized convenience the Governor adapters need (the budget,
// approval, and audit systems key off the tenant, key, and actor).
type Caller struct {
	// TenantID is required; Execute fails closed when it is empty so an
	// un-authenticated wiring can never run a tool with a blank tenant.
	TenantID string
	APIKeyID string
	// ActorType / ActorLabel describe who is acting (e.g. "api_key",
	// "agent", "user") for the approval and audit adapters.
	ActorType  string
	ActorLabel string
	// Surface is the calling surface. When set, Execute refuses tools
	// not exposed on it. Leave empty only for trusted internal callers.
	Surface Surface
	// Sandbox is true when the bearer key is sandbox-only. It is OR'd
	// with the context sandbox flag, so it can only ever *add* safety.
	// WriteTier tools are simulated (not executed) for sandbox callers.
	Sandbox bool
	// LLMFacing is true when the result will be fed back to a model
	// (MCP / agent). The PII scrubber only runs for LLM-facing callers.
	LLMFacing bool
	// Mandate is the bounded grant this call is made under, when there is one.
	//
	// Empty means the caller holds only its API key's authority — the state
	// every agent surface is in today. A mandate can only NARROW that: it runs
	// after the scope check, so it subtracts and never adds.
	Mandate string
}

// scopeStrings renders a scope slice as plain strings for error data.
func scopeStrings(scopes []apikeys.Scope) []string {
	out := make([]string, 0, len(scopes))
	for _, s := range scopes {
		out = append(out, string(s))
	}
	return out
}

// MissingScopes returns the subset of the tool's required scopes that
// ctx does not satisfy. Empty result means the caller is authorized.
func (t *ToolSpec) MissingScopes(ctx context.Context) []apikeys.Scope {
	if len(t.RequiredScopes) == 0 {
		return nil
	}
	var missing []apikeys.Scope
	for _, s := range t.RequiredScopes {
		if !apikeys.HasAllScopes(ctx, s) {
			missing = append(missing, s)
		}
	}
	return missing
}
