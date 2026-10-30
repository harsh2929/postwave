/**
 * api/mcpQuotas.ts — the ONE quota read the phone makes.
 *
 * `GET /api/v1/mcp/quotas` is mounted with the same `admin` scope guard as the
 * rest of /api/v1/mcp/* (apps/api/internal/server/identity_api.go:160) and
 * the generated routeauth manifest agrees (`session_minimum_role: admin`,
 * `review_status: reviewed`). The handler is `ListQuotasHandler`
 * (apps/api/internal/apikeycalls/quotas.go:189-208).
 *
 * PUT /api/v1/mcp/quotas and DELETE /api/v1/mcp/quotas/{tool} are NOT called
 * from here. Both answer 503 `mcp_quota_enforcement_release_held`
 * (quotas.go:210-232), and api/mcpActivity.ts records the product reason
 * on top of the server one: a per-tool daily limit is a spend control whose
 * blast radius is every agent in the workspace.
 *
 * The parse is tenant-checked (lib/mcpQuotas fact 4): a well-formed answer
 * from the previous workspace is refused, not rendered.
 */
import { normalizeMcpQuotas, type McpQuotaSnapshot } from "@/lib/mcpQuotas";

import { McpRequestError } from "./mcpActivity";
import { rawRequest } from "./request";

export async function fetchMcpQuotas(
  expectedTenantId: string | null,
): Promise<McpQuotaSnapshot> {
  const res = await rawRequest<unknown>("GET", "/api/v1/mcp/quotas", undefined);
  if (res.error) throw new McpRequestError(res.error, "Loading quota observations");
  const parsed = normalizeMcpQuotas(res.data, expectedTenantId);
  if (parsed.error !== null) throw new Error(parsed.error);
  return parsed.snapshot;
}

export interface McpReleaseHold {
  /** The server's machine code, e.g. `mcp_quota_enforcement_release_held`. */
  code: string;
  /** The server's sentence, rendered verbatim. */
  message: string;
}

/**
 * The server answered 503 with its release-hold envelope. Rendered verbatim
 * by the caller; never paraphrased and never given a Retry button — the hold
 * is a product boundary, not a fault.
 */
export function mcpReleaseHold(error: unknown): McpReleaseHold | null {
  if (typeof error !== "object" || error === null) return null;
  const { status, message, code } = error as {
    status?: unknown;
    message?: unknown;
    code?: unknown;
  };
  if (status !== 503) return null;
  return {
    code: typeof code === "string" ? code : "",
    message:
      typeof message === "string" && message
        ? message
        : "This route is release-held on this server.",
  };
}
