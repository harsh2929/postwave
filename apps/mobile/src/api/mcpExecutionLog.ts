/**
 * api/mcpExecutionLog.ts — one page of the execution log, older than a cursor.
 *
 * Same route as `listMcpExecutions` (GET /api/v1/mcp/executions, owner/admin
 * per the handler — see the note at the top of api/mcpActivity.ts), read
 * with `before_id` and `tool`. It is a separate function because its result
 * keeps the server's `nextBeforeId`, which the array-shaped list read drops;
 * `lib/mcpExecutionLog` builds the query and parses the page so both halves
 * are node-tested.
 */
import {
  mcpExecutionsQuery,
  parseMcpExecutionPage,
  type McpExecutionPage,
  type McpExecutionsQuery,
} from "@/lib/mcpExecutionLog";

import { McpRequestError } from "./mcpActivity";
import { rawRequest } from "./request";

export async function fetchMcpExecutionPage(
  query: McpExecutionsQuery,
): Promise<McpExecutionPage> {
  const res = await rawRequest<unknown>("GET", mcpExecutionsQuery(query), undefined);
  if (res.error) throw new McpRequestError(res.error, "Loading older calls");
  return parseMcpExecutionPage(res.data);
}
