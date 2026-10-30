/**
 * api/mcpCatalog.ts — the server-bundled MCP tool catalogue.
 *
 * `GET /api/v1/mcp/catalog` (apps/api/internal/apikeycalls/handlers.go:206-225,
 * `GetCatalog`) writes the bytes of a JSON file embedded into the API binary
 * at build time. It is mounted behind the same `admin` scope as every other
 * /api/v1/mcp/* route (identity_api.go:159) and the manifest says the same.
 *
 * The response carries `X-Postwave-Catalog-Provenance: api-build-candidate`
 * and a digest header. `rawRequest` does not surface headers, and nothing
 * here pretends otherwise: the screen labels the list a CANDIDATE snapshot
 * in the handler's own words rather than quoting a digest it never read.
 *
 * Validation (lib/mcpCatalog) is all-or-nothing, so a parse failure is thrown
 * as an Error carrying the desktop's exact sentence; TanStack keeps the last
 * valid catalogue on screen underneath it.
 */
import { normalizeMcpCatalog, type McpCatalogEntry } from "@/lib/mcpCatalog";

import { McpRequestError } from "./mcpActivity";
import { rawRequest } from "./request";

export async function fetchMcpCatalog(): Promise<McpCatalogEntry[]> {
  const res = await rawRequest<unknown>("GET", "/api/v1/mcp/catalog", undefined);
  if (res.error) throw new McpRequestError(res.error, "Loading the tool catalogue");
  const parsed = normalizeMcpCatalog(res.data);
  if (parsed.error !== null) throw new Error(parsed.error);
  return parsed.entries;
}
