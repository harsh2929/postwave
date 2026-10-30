// SPDX-License-Identifier: MIT
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/** Connect a Server instance to a stdio transport. */
export async function startStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The MCP SDK keeps stdin/stdout open; nothing else to do here.
}
