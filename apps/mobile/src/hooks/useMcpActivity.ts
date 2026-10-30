/**
 * hooks/useMcpActivity.ts — TanStack wiring for the agent-activity monitor.
 *
 * Every judgement lives in `lib/mcpActivity` (pure, node-tested); this file is
 * only the query layer.
 *
 * TWO GATES ON EVERY QUERY, NOT ONE.
 *
 *  - `useOnlineQueryGate` is the offline/auth gate. Offline a query never runs,
 *    which in TanStack v5 is status "pending" with fetchStatus "idle" —
 *    `isLoading` FALSE and `isError` FALSE — so a screen that fell through to
 *    "no calls" would be inventing silence. `QueryStates` owns that branch.
 *  - `allowed` carries the ROLE decision. Every /api/v1/mcp/* route is behind
 *    `RequireScope(ScopeAdmin)` (see the note at the top of api/mcpActivity.ts),
 *    so for any other role these requests can only ever answer 403. Firing them
 *    anyway spends a cellular round trip to be told something the client
 *    already knows, and paints a generic error over a screen whose real state
 *    is "your role cannot see this".
 *
 * STALENESS. The stats aggregate is the live thing and gets the short window.
 * The trend is hourly buckets — re-reading it faster than an hour cannot change
 * a rendered pixel, so it gets a much longer one. The execution log sits in
 * between: rows are append-only, and the newest ones are the whole point.
 *
 * NO POLLING. `refetchInterval` on a screen an operator leaves open would keep
 * a phone radio warm for a dashboard nobody is looking at. Foreground resume
 * plus pull-to-refresh is the whole refresh story, and the screen says so
 * rather than implying it is live.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchMcpStats,
  fetchMcpTrend,
  listMcpExecutions,
  MCP_EXECUTIONS_PAGE_SIZE,
} from "@/api/mcpActivity";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import type { McpExecution, McpStats, McpTrend, McpWindow } from "@/lib/mcpActivity";

export type {
  McpExecution,
  McpStats,
  McpTrend,
  McpWindow,
} from "@/lib/mcpActivity";

const STATS_STALE_MS = 30_000;
const TREND_STALE_MS = 300_000;
const EXECUTIONS_STALE_MS = 30_000;

export function useMcpStats(
  window: McpWindow,
  includeAll: boolean,
  allowed: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery<McpStats>({
    queryKey: ["mcp", "stats", gate.tenantId, window, includeAll],
    enabled: gate.enabled && Boolean(gate.tenantId) && allowed,
    staleTime: STATS_STALE_MS,
    queryFn: () => fetchMcpStats(window, includeAll),
  });
}

export function useMcpTrend(
  window: McpWindow,
  includeAll: boolean,
  allowed: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery<McpTrend>({
    queryKey: ["mcp", "trend", gate.tenantId, window, includeAll],
    enabled: gate.enabled && Boolean(gate.tenantId) && allowed,
    staleTime: TREND_STALE_MS,
    queryFn: () => fetchMcpTrend(window, includeAll),
  });
}

/**
 * The newest calls.
 *
 * Deliberately NOT keyed on the window: `/executions` has no `window`
 * parameter (it takes `since`/`until`/`before_id` instead — handlers.go:60-88),
 * so keying it on the window control would mint a fresh cache entry per window
 * for a request whose response is identical. The screen states that the log is
 * the newest N calls regardless of the window above it, because it is.
 *
 * `tool` IS part of the key: it is the server's exact-match `?tool=` filter,
 * so two values are two different result sets. Older pages under this first
 * page are `hooks/useMcpExecutionLog`, which resets whenever this one changes.
 */
export function useMcpExecutions(
  includeAll: boolean,
  allowed: boolean,
  tool: string = "",
) {
  const gate = useOnlineQueryGate();
  return useQuery<McpExecution[]>({
    queryKey: [
      "mcp",
      "executions",
      gate.tenantId,
      includeAll,
      MCP_EXECUTIONS_PAGE_SIZE,
      tool,
    ],
    enabled: gate.enabled && Boolean(gate.tenantId) && allowed,
    staleTime: EXECUTIONS_STALE_MS,
    queryFn: () => listMcpExecutions(includeAll, MCP_EXECUTIONS_PAGE_SIZE, tool),
  });
}
