// SPDX-License-Identifier: MIT
import { PostwaveClient } from "@postwave/sdk";

import { buildUserAgent, getToolContext } from "./lib/tool-context.js";

// Read the MCP server's own package.json version at module load.
// Falls back to "dev" when running from a uncompiled tree (rare —
// CI runs against the bundled dist).
const SERVER_VERSION = readServerVersion();

function readServerVersion(): string {
  try {
    // The bundle embeds package.json data through tsup's banner; in the
    // source tree we read it directly. We try both paths so unit tests
    // running off ts-node don't crash.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "dev";
  } catch {
    return "dev";
  }
}

/**
 * Build a PostwaveClient from environment variables. Throws clearly at
 * startup if `POSTWAVE_API_KEY` is missing — failing here is much friendlier
 * than letting the first tool call return a confusing 401.
 *
 * Every outbound HTTP call is decorated with:
 *
 *   User-Agent:           postwave-mcp-server/<version>
 *   X-Postwave-MCP-Tool:  <currently-executing-tool-name>
 *
 * The User-Agent is what powers the dashboard's "MCP only" filter
 * (`user_agent ILIKE 'postwave-mcp-server/%'`). The tool header
 * lets the dashboard's History tab render the logical tool name
 * ("subscribers_list") instead of the API-path derivation
 * ("get:subscribers"). The tool name comes from AsyncLocalStorage —
 * see lib/tool-context.ts.
 */
export function createPostwaveClient(env: NodeJS.ProcessEnv = process.env): PostwaveClient {
  const apiKey = env.POSTWAVE_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      "mcp_distribution_release_held: this source candidate has no supported client or working-key setup",
    );
  }
  const baseUrl = env.POSTWAVE_BASE_URL?.trim() || undefined;
  const tenantId = env.POSTWAVE_TENANT_ID?.trim() || undefined;

  // Wrap the global fetch so every call carries the MCP UA + the
  // current tool-context's tool name. We can't put X-Postwave-MCP-Tool
  // in defaultHeaders because it varies per call — the SDK's
  // defaultHeaders are static. The fetch wrapper reads
  // AsyncLocalStorage at request time, so each tool invocation gets
  // its own correct label even when handlers fan out concurrently.
  const baseFetch = globalThis.fetch.bind(globalThis);
  const wrappedFetch: typeof fetch = (input, init) => {
    const ctx = getToolContext();
    const headers = new Headers(init?.headers ?? {});
    if (!headers.has("User-Agent")) {
      headers.set("User-Agent", buildUserAgent(ctx?.serverVersion ?? SERVER_VERSION));
    }
    if (ctx?.toolName && !headers.has("X-Postwave-MCP-Tool")) {
      headers.set("X-Postwave-MCP-Tool", ctx.toolName);
    }
    return baseFetch(input, { ...(init ?? {}), headers });
  };

  return new PostwaveClient({
    apiKey,
    baseUrl,
    tenantId,
    fetch: wrappedFetch,
    defaultHeaders: {
      // Static UA fallback for code paths that bypass the fetch wrapper
      // (e.g. server-sent-events stream handles that don't share the
      // fetch instance). The wrapper above takes precedence when both
      // fire.
      "User-Agent": buildUserAgent(SERVER_VERSION),
    },
  });
}

/** Exported for tests + diagnostics. */
export const MCP_SERVER_VERSION = SERVER_VERSION;
