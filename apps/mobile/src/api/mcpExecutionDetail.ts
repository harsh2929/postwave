/**
 * api/mcpExecutionDetail.ts — one retained execution row, re-read for the
 * detail sheet.
 *
 * THERE IS NO PER-ROW ROUTE. `apps/api/internal/apikeycalls/handlers.go`
 * mounts `/executions`, `/stats`, `/trend`, `/catalog`, `/executions.csv`
 * (and the SSE stream); nothing takes an id. What the list endpoint does
 * take is `before_id`, an EXCLUSIVE cursor (`id < before_id`,
 * handlers.go:257-263 → Repo.List), and `limit` from 1 to 500. So the window
 * `limit=1&before_id=id+1` is exactly the tapped row when it still exists,
 * and the next-older row when it does not — which is why the parser
 * (lib/mcpExecutionDetail) checks the id and reports "no longer retained"
 * rather than showing a stranger under the tapped row's header.
 *
 * `include=all` is sent on purpose. The default read is MCP-only by
 * User-Agent (handlers.go:236); the row was already shown to the operator
 * under whichever scope was active, and a row id is unique, so widening the
 * filter cannot reveal a row they had not seen — it only avoids a false
 * "not retained" for a row whose caller-asserted label does not match.
 *
 * WHY NOT REUSE `listMcpExecutions`. Its normaliser keeps only the log-row
 * fields and drops `queryString`, `requestBody` and `apiKeyId`; this file is
 * the additive path that keeps the minimised metadata, without changing what
 * the list already renders.
 */
import {
  normalizeMcpExecutionDetail,
  type McpExecutionDetailEnvelope,
} from "@/lib/mcpExecutionDetail";

import { McpRequestError } from "./mcpActivity";
import { rawRequest } from "./request";

export async function fetchMcpExecutionDetail(
  id: number,
  expectedTenantId: string | null,
): Promise<McpExecutionDetailEnvelope> {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("The call has no retained id to look up.");
  }
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/mcp/executions?limit=1&before_id=${id + 1}&include=all`,
    undefined,
  );
  if (res.error) throw new McpRequestError(res.error, "Loading call details");
  const parsed = normalizeMcpExecutionDetail(res.data, id, expectedTenantId);
  if (parsed.error !== null) throw new Error(parsed.error);
  return parsed.detail;
}
