// SPDX-License-Identifier: MIT
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { PostwaveClient } from "@postwave/sdk";

import { registerTools } from "./tools/index.js";

export const SERVER_NAME = "moosewave";
export const SERVER_VERSION = "0.1.0";
export const RESOURCE_SURFACE_RELEASED = false;
export const PROMPT_SURFACE_RELEASED = false;

/**
 * Construct a fully-wired Moosewave MCP server. Capabilities advertised:
 *   - tools: with listChanged notifications enabled (we don't currently
 *     mutate the tool set at runtime, but we keep the door open for it)
 * Resource and prompt surfaces are structurally held. They do not yet carry
 * complete per-item scope metadata or reviewed bounded model-output
 * projections, so advertising them would bypass the fail-closed tool boundary.
 */
export function createServer(client: PostwaveClient): Server {
  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: { listChanged: true },
      },
    },
  );

  registerTools(server, client);

  return server;
}
