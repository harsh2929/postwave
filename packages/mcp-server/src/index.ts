// SPDX-License-Identifier: MIT
import { fileURLToPath } from "node:url";

import { createPostwaveClient } from "./client.js";
import { SetHeldScopes } from "./lib/register.js";
import { fetchHeldScopes } from "./lib/scopes.js";
import { createServer } from "./server.js";
import { toolsForProfile } from "./tools/index.js";
import { startHttp } from "./transports/http.js";
import { startStdio } from "./transports/stdio.js";

export { createServer } from "./server.js";
export { createPostwaveClient } from "./client.js";

/** Catalogue probe for an installed candidate artifact, never authorization. */
export function candidateToolNames(profile: "templates" | "full" = "templates"): string[] {
  // Registration constructs handlers but does not invoke the API. This probe
  // must remain independent of credentials so a packed artifact can be
  // inspected before anyone provisions a tenant key.
  return toolsForProfile({} as ReturnType<typeof createPostwaveClient>, profile)
    .map((tool) => tool.name)
    .sort();
}

async function main(): Promise<void> {
  const transport = (
    process.env.POSTWAVE_MCP_TRANSPORT ?? "stdio"
  ).toLowerCase();
  const client = createPostwaveClient();

  // Resolve the key's scopes once so the proxy can hide / refuse tools it
  // can't use. An unavailable or malformed self projection produces null,
  // which makes discovery and invocation fail closed.
  SetHeldScopes(await fetchHeldScopes(client));

  if (transport === "http") {
    // Stateless HTTP: the transport builds a fresh server per request.
    await startHttp(() => createServer(client));
    return;
  }
  if (transport === "stdio") {
    // stdio is a single long-lived connection — one server instance.
    await startStdio(createServer(client));
    return;
  }
  throw new Error(`unsupported POSTWAVE_MCP_TRANSPORT: ${transport}`);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error("[postwave-mcp] fatal:", err);
    process.exit(1);
  });
}
