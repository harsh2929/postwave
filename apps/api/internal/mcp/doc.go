// SPDX-License-Identifier: AGPL-3.0-only
//
// Package mcp implements Moosewave's native, read-only JSON-RPC tool preview at
// POST /api/v1/mcp/rpc.
//
// # Honest transport boundary
//
// The preview understands initialize, tools/list, tools/call, and ping-shaped
// JSON-RPC frames based on MCP 2025-06-18. It is not yet a qualified MCP
// Streamable HTTP implementation: it has no initialize-first session state,
// protocol-version negotiation, initialized notification lifecycle, or
// MCP-Protocol-Version request-header enforcement. Standard hosted/remote MCP
// compatibility must remain release-held until those lifecycle requirements
// have conformance evidence.
//
// # Registry boundary
//
// Native tools are declared in this package and adapted into agenttools.Registry.
// This registry is independent of the broad @postwave/mcp-server npm REST proxy
// and of any published npm artifact; catalogue equality must not be inferred.
// Input schemas are centrally enforced by agenttools.Execute before governance
// reservations or handlers. Tools/list annotations are untrusted behavior hints,
// never an authorization or approval decision.
//
// # Structural release holds
//
// Write-tier tools are hidden and refused on both native MCP and the in-app
// agent. Their handlers do not yet share an atomic mutation/budget/audit outbox,
// and approval records are not bound to a canonical hash of exact arguments.
// The per-tool quota UI is also advisory: outer HTTP telemetry cannot
// authoritatively attribute the inner native tool invocation. These boundaries
// require server-owned atomic reservation/evidence before release.
//
// Authentication and scope enforcement are performed by the upstream API-key
// middleware and again per tool in the shared execution chokepoint.
package mcp
