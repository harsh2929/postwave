// SPDX-License-Identifier: AGPL-3.0-only
//
// Package agenttools is the canonical registry of agent-callable
// capabilities and the single governed execution path for them.
//
// # Why this package exists
//
// Before this package, Moosewave had four divergent tool catalogs that
// disagreed on "what an agent can do": the native MCP server's
// hand-written list, the npm proxy's ~215 TypeScript tools, the desktop
// `tool-catalog.json` snapshot, and the web `mcp-tools.json`. Each was
// maintained by hand and drifted from the others, and governance
// (scopes, budgets, approvals, sandbox, PII scrubbing, audit, quotas)
// was wired per-surface — so the native MCP write path, when it
// eventually shipped, would not inherit any of it.
//
// agenttools fixes both problems with two primitives:
//
//   - [ToolSpec] / [Registry] — every capability declared once. The
//     native MCP server, the in-app AI agent, and the generated proxy
//     and catalog manifests all derive from this one registry. A CI
//     drift gate fails the build if any generated artifact is stale.
//
//   - [Execute] — the one path every surface calls to invoke a tool.
//     It runs an ordered governance gauntlet (scopes → quota → sandbox
//     → send-budget → approval → handler → PII scrub → audit) so the
//     governance posture is identical and proven once, regardless of
//     whether the caller is the MCP endpoint or the in-app agent.
//
// The governance steps are abstracted behind the [Governor] interface
// so this package imports no governance machinery directly (avoiding
// import cycles and keeping it unit-testable with a fake governor).
// The runtime wires a real Governor in main.go.
package agenttools
