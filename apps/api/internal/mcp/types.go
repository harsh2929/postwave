// SPDX-License-Identifier: AGPL-3.0-only
package mcp

import (
	"encoding/json"

	"github.com/postwave/postwave/apps/api/internal/agenttools"
)

// JSON-RPC 2.0 wire types. The Model Context Protocol layers an
// MCP-specific envelope (initialize / tools/list / tools/call) on top
// of plain JSON-RPC 2.0 — so the envelope types below are the same
// you'd find in any JSON-RPC server.

// rpcRequest is one JSON-RPC 2.0 request frame. This read-only preview does
// not yet implement the MCP initialize/initialized session lifecycle:
// id-less notifications are not a supported transport contract and callers
// must not treat this endpoint as qualified Streamable HTTP.
type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

// rpcResponse is the success/error envelope returned for a request.
type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// rpcError is the JSON-RPC error object. The MCP spec reuses the
// standard JSON-RPC codes (-32700 parse error … -32603 internal) and
// reserves -32001..-32099 for transport-specific errors.
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// MCP envelope types.

// initResult is the body of `initialize`'s response — advertises
// protocol version + the capabilities this server implements. We
// implement tools but no resources/prompts in v1.
type initResult struct {
	ProtocolVersion      string       `json:"protocolVersion"`
	ServerInfo           serverInfo   `json:"serverInfo"`
	Capabilities         capabilities `json:"capabilities"`
	Instructions         string       `json:"instructions,omitempty"`
	TransportMode        string       `json:"transportMode"`
	LifecycleQualified   bool         `json:"lifecycleQualified"`
	InputSchemaEnforced  bool         `json:"inputSchemaEnforced"`
	WriteTierAvailable   bool         `json:"writeTierAvailable"`
	ProtocolReleaseHold  string       `json:"protocolReleaseHold,omitempty"`
	WriteTierReleaseHold string       `json:"writeTierReleaseHold,omitempty"`
}

type serverInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type capabilities struct {
	// Tools section advertises whether tools/list_changed
	// notifications are sent. We don't send them in v1; the
	// dashboard write-access toggle is rare enough that the
	// client can re-list on each session.
	Tools toolsCapability `json:"tools"`
}

type toolsCapability struct {
	ListChanged bool `json:"listChanged"`
}

// toolDescriptor is one entry in the `tools/list` response. Annotations
// (MCP 2025-06-18) let a client decide whether a tool is safe to
// auto-approve; outputSchema types the structuredContent result.
type toolDescriptor struct {
	Name         string                  `json:"name"`
	Description  string                  `json:"description"`
	InputSchema  json.RawMessage         `json:"inputSchema"`
	OutputSchema json.RawMessage         `json:"outputSchema,omitempty"`
	Annotations  *agenttools.Annotations `json:"annotations,omitempty"`
}

// toolsListResult is what `tools/list` returns.
type toolsListResult struct {
	Tools []toolDescriptor `json:"tools"`
}

// toolCallParams is the body of `tools/call`. Arguments are centrally and
// fail-closed validated against the registered inputSchema in
// agenttools.Execute before any reservation, quota, approval, or handler.
type toolCallParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

// toolCallResult is what `tools/call` returns. The MCP convention is
// to return a list of `content` blocks (text/image/embedded resource);
// v1 only emits text blocks containing the JSON-encoded payload, which
// keeps every client renderer happy and lets the LLM parse the
// machine-readable form right back.
type toolCallResult struct {
	Content []contentBlock `json:"content"`
	// StructuredContent (MCP 2025-06-18) carries the machine-readable
	// result as a top-level value the model can consume directly, instead
	// of re-parsing the JSON text block.
	StructuredContent any  `json:"structuredContent,omitempty"`
	IsError           bool `json:"isError,omitempty"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// settings mirrors a row in mcp_server_settings.
type Settings struct {
	TenantID             string   `json:"tenant_id"`
	Enabled              bool     `json:"enabled"`
	WriteEnabled         bool     `json:"write_enabled"`
	AllowedTools         []string `json:"allowed_tools,omitempty"`
	LastHandshakeAt      *string  `json:"last_handshake_at,omitempty"`
	LastToolCallAt       *string  `json:"last_tool_call_at,omitempty"`
	WriteTierAvailable   bool     `json:"write_tier_available"`
	WriteTierReleaseHold string   `json:"write_tier_release_hold,omitempty"`
}

// UpdateSettingsInput is the body of PATCH /api/v1/mcp/server/settings.
// Each field is a pointer so callers can update one field without
// clobbering others (the desktop toggles `enabled` independently of
// the `allowed_tools` picker).
type UpdateSettingsInput struct {
	Enabled      *bool     `json:"enabled,omitempty"`
	WriteEnabled *bool     `json:"write_enabled,omitempty"`
	AllowedTools *[]string `json:"allowed_tools,omitempty"`
}
