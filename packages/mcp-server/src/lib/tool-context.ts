// SPDX-License-Identifier: MIT

/**
 * AsyncLocalStorage-backed per-call context for the MCP server.
 *
 * Tracks "which tool is the agent currently executing?" so the
 * PostwaveClient's fetch wrapper can emit
 * `X-Postwave-MCP-Tool: <name>` on every outbound call. The API
 * surfaces this label in its MCP guide dashboard, replacing the
 * coarse method+path derivation it would otherwise fall back to.
 *
 * Why AsyncLocalStorage:
 *   - The PostwaveClient is constructed ONCE at MCP-server startup;
 *     it doesn't know which tool is calling it on any given fetch.
 *   - Tools call client methods via deep async chains (some tools
 *     fan out to multiple endpoints). AsyncLocalStorage carries the
 *     tool name through `await` boundaries automatically.
 *   - The alternative — threading the tool name through every method
 *     signature — would touch every tool category file.
 *
 * Node ≥16.8 ships AsyncLocalStorage natively. The MCP server already
 * targets Node 18+ via the @modelcontextprotocol/sdk peer requirement.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface ToolContext {
  /** Logical tool name as registered with the MCP server. */
  toolName: string;
  /** The MCP server's own version, baked into the User-Agent. */
  serverVersion: string;
}

const storage = new AsyncLocalStorage<ToolContext>();

/**
 * Run `fn` with `ctx` available to any code path that reads via
 * {@link getToolContext}. The standard AsyncLocalStorage.run shape.
 */
export function withToolContext<T>(ctx: ToolContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/**
 * Read the current tool context, or undefined when called outside a
 * tool handler (e.g. the initial ListTools probe).
 */
export function getToolContext(): ToolContext | undefined {
  return storage.getStore();
}

/**
 * Convenience: build the User-Agent string for outbound HTTP calls.
 * Format mirrors `npm pkg get version` output so the API's UA filter
 * (`postwave-mcp-server/%`) matches every version. The optional
 * `via` suffix lets the agent identify itself when supplying its own
 * client banner (e.g. "claude-code/0.5.0").
 */
export function buildUserAgent(serverVersion: string, via?: string): string {
  const base = `postwave-mcp-server/${serverVersion}`;
  if (!via) return base;
  return `${base} (via ${via.replace(/[()]/g, "")})`;
}
