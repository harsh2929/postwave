/**
 * lib/mcpActivity.ts — parsing and judging the MCP / API-key execution ledger.
 *
 * WHAT THIS SURFACE ANSWERS. `apps/desktop/src/pages/MCP.tsx` is three tabs:
 * Setup (client config plus scoped API-key MINTING), Tools (the bundled
 * catalogue) and History (stats, trend, per-tool and per-key tables, a
 * filterable execution log and a CSV export). Setup must never port — it mints
 * plaintext credentials and its output is pasted into a config file on a
 * developer machine. The catalogue is a static document. What is phone-shaped
 * is the third tab's bounded question: *what did the advisory recorder retain*.
 * Rows are best-effort and droppable; MCP attribution comes from a
 * caller-controlled User-Agent. They can suggest investigation, never prove
 * that no call occurred or that every call succeeded.
 *
 * THE SHAPES, READ OFF THE GO SOURCE (not off openapi.json):
 *   - `Stats`      apps/api/internal/apikeycalls/apikeycalls.go:283-300
 *   - `TrendPoint` apikeycalls.go:313-316
 *   - `Call`       apikeycalls.go:69-100
 *   - the handlers  apps/api/internal/apikeycalls/handlers.go:60-151
 *
 * FIVE SERVER FACTS THAT DECIDE HOW THIS SCREEN READS NUMBERS. Each one is a
 * place where the obvious render would state something false:
 *
 *  1. `successRate` is a FRACTION in [0,1] and it is left at its zero value
 *     when the window holds no calls at all (apikeycalls.go:374-376 only
 *     assigns it when `TotalCalls > 0`). A screen that prints `0%` for an idle
 *     window is reporting a total outage. `hasCalls` carries the distinction
 *     and the UI renders an em-dash.
 *  2. "Successful" is `status_code >= 200 AND status_code < 400`
 *     (apikeycalls.go:356) — 3xx counts as success. The label says 2xx–3xx
 *     rather than "OK" so the number is never read as "returned data".
 *  3. `topTools` is `LIMIT 5` over rows with `tool_name <> ''`
 *     (apikeycalls.go:379-385). Its calls therefore do NOT sum to
 *     `totalCalls`, for two independent reasons — untagged calls and the
 *     top-5 cut. Deriving a percentage-of-traffic from it would be a
 *     fabricated denominator, so this module reports counts and states the
 *     shortfall as its own fact.
 *  4. The default read is MCP-ONLY: both `/stats` and `/trend` apply
 *     `user_agent ILIKE 'postwave-mcp-server/%'` unless `?include=all`
 *     (apikeycalls.go:347-350, 490-493). A missing row therefore means only
 *     that this best-effort recorder retained no matching caller-asserted
 *     label; it says nothing authoritative about MCP or API traffic.
 *  5. The server clamps the window itself — `parseWindow` to [1h, 90d]
 *     (handlers.go:238-254) and `Repo.Trend` again to 30d
 *     (apikeycalls.go:481-483) — and echoes what it actually used as
 *     `windowHours`. When that differs from what was asked for, the reader is
 *     looking at a different window than the control says.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */

/** The windows the monitor offers. Values are the `?window=` shorthand. */
export type McpWindow = "24h" | "7d" | "30d";

export const MCP_WINDOWS: readonly McpWindow[] = ["24h", "7d", "30d"];

/** Hours per window — used to detect a server-side clamp. */
export function mcpWindowHours(window: McpWindow): number {
  if (window === "24h") return 24;
  if (window === "7d") return 24 * 7;
  return 24 * 30;
}

/** The phrase that goes in a sentence: "in the last 24 hours". */
export function mcpWindowLabel(window: McpWindow): string {
  if (window === "24h") return "24 hours";
  if (window === "7d") return "7 days";
  return "30 days";
}

/** How a single recorded call ended, collapsed from its HTTP status. */
export type McpCallOutcome =
  | "ok"
  | "denied"
  | "throttled"
  | "client"
  | "server"
  | "unknown";

export interface McpToolFrequency {
  toolName: string;
  calls: number;
}

export interface McpKeyFrequency {
  /** "" when the key row was deleted — `apiKeyId` is a nullable pointer. */
  apiKeyId: string;
  apiKeyPrefix: string;
  calls: number;
}

export interface McpStatusFrequency {
  /** The leading digit of the HTTP status: 2 | 3 | 4 | 5. */
  statusClass: number;
  calls: number;
}

export interface McpStats {
  /** The window the SERVER used, in hours — not necessarily the one asked for. */
  windowHours: number;
  totalCalls: number;
  successfulCalls: number;
  /** Calls the server did NOT count as successful: total − successful. */
  failedCalls: number;
  /** Fraction in [0,1], meaningful only when `hasCalls`. */
  successRate: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  /** "" when the window holds no calls. */
  lastCallAt: string;
  topTools: readonly McpToolFrequency[];
  topApiKeys: readonly McpKeyFrequency[];
  statusBreakdown: readonly McpStatusFrequency[];
  totalCostMicros: number;
  /**
   * The window contains at least one call. Every rate, latency and cost figure
   * on this object is a MEASUREMENT only when this is true; otherwise they are
   * the zero values the aggregate query returns for an empty set.
   */
  hasCalls: boolean;
}

export interface McpTrendPoint {
  /** RFC3339 hour bucket, UTC. */
  bucket: string;
  calls: number;
}

export interface McpTrend {
  points: readonly McpTrendPoint[];
  windowHours: number;
}

export interface McpExecution {
  id: number;
  apiKeyPrefix: string;
  method: string;
  path: string;
  /** "" for a call that carried no `X-Postwave-MCP-Tool` header. */
  toolName: string;
  /** 0 when the recorder never wrote one — treat as "not recorded". */
  statusCode: number;
  outcome: McpCallOutcome;
  latencyMs: number;
  userAgent: string;
  errorCode: string;
  dryRun: boolean;
  costMicros: number;
  calledAt: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

function float(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Collapse an HTTP status into the six outcomes the UI branches on.
 *
 * 401/403 and 429 are split out of the 4xx block on purpose: for an agent
 * integration "the key lost its scope" and "you are being rate limited" are
 * different incidents with different fixes, and burying both under "client
 * error" is exactly the flattening that makes a log useless at 02:00.
 */
export function mcpCallOutcome(statusCode: number): McpCallOutcome {
  if (!Number.isFinite(statusCode) || statusCode <= 0) return "unknown";
  if (statusCode >= 200 && statusCode < 400) return "ok";
  if (statusCode === 401 || statusCode === 403) return "denied";
  if (statusCode === 429) return "throttled";
  if (statusCode >= 400 && statusCode < 500) return "client";
  if (statusCode >= 500) return "server";
  return "unknown";
}

/** True for every outcome the operator should be looking at. */
export function isMcpFailure(outcome: McpCallOutcome): boolean {
  return outcome !== "ok" && outcome !== "unknown";
}

export function normalizeMcpStats(raw: unknown): McpStats {
  const row = record(raw);
  const totalCalls = int(row.totalCalls);
  const successfulCalls = int(row.successfulCalls);
  return {
    windowHours: int(row.windowHours),
    totalCalls,
    successfulCalls,
    // Clamped at zero: the two counters come from the same aggregate row, so a
    // negative here would mean the payload is not what it claims to be, and a
    // negative "failed calls" is worse than a conservative zero.
    failedCalls: Math.max(0, totalCalls - successfulCalls),
    successRate: float(row.successRate),
    averageLatencyMs: float(row.averageLatencyMs),
    p95LatencyMs: int(row.p95LatencyMs),
    lastCallAt: str(row.lastCallAt),
    topTools: Array.isArray(row.topTools)
      ? row.topTools
          .map((entry) => {
            const tool = record(entry);
            return { toolName: str(tool.toolName), calls: int(tool.calls) };
          })
          .filter((tool) => tool.toolName !== "")
      : [],
    topApiKeys: Array.isArray(row.topApiKeys)
      ? row.topApiKeys.map((entry) => {
          const key = record(entry);
          return {
            apiKeyId: str(key.apiKeyId),
            apiKeyPrefix: str(key.apiKeyPrefix),
            calls: int(key.calls),
          };
        })
      : [],
    statusBreakdown: Array.isArray(row.statusBreakdown)
      ? row.statusBreakdown.map((entry) => {
          const cls = record(entry);
          return { statusClass: int(cls.class), calls: int(cls.calls) };
        })
      : [],
    totalCostMicros: int(row.totalCostMicros),
    hasCalls: totalCalls > 0,
  };
}

export function normalizeMcpTrend(raw: unknown): McpTrend {
  const row = record(raw);
  const points = Array.isArray(row.points) ? row.points : [];
  return {
    points: points
      .map((entry) => {
        const point = record(entry);
        return { bucket: str(point.bucket), calls: int(point.calls) };
      })
      .filter((point) => point.bucket !== ""),
    windowHours: int(row.windowHours),
  };
}

export function normalizeMcpExecutions(raw: unknown): McpExecution[] {
  const row = record(raw);
  const rows = Array.isArray(row.rows)
    ? row.rows
    : Array.isArray(raw)
      ? (raw as unknown[])
      : [];
  return rows.map((entry) => {
    const call = record(entry);
    const statusCode = int(call.statusCode);
    return {
      id: int(call.id),
      apiKeyPrefix: str(call.apiKeyPrefix),
      method: str(call.method),
      path: str(call.path),
      toolName: str(call.toolName),
      statusCode,
      outcome: mcpCallOutcome(statusCode),
      latencyMs: int(call.latencyMs),
      userAgent: str(call.userAgent),
      errorCode: str(call.errorCode),
      dryRun: call.dryRun === true,
      costMicros: int(call.costMicros),
      calledAt: str(call.calledAt),
    };
  });
}

/** The two questions a phone asks of an execution log. */
export type McpExecutionFilter = "all" | "failed";

export function filterMcpExecutions(
  rows: readonly McpExecution[],
  filter: McpExecutionFilter,
): McpExecution[] {
  if (filter === "failed")
    return rows.filter((row) => isMcpFailure(row.outcome));
  return [...rows];
}

export function mcpExecutionCounts(rows: readonly McpExecution[]): {
  all: number;
  failed: number;
} {
  return {
    all: rows.length,
    failed: filterMcpExecutions(rows, "failed").length,
  };
}

export type McpVerdictTone = "ok" | "warn" | "bad" | "idle";

export interface McpVerdict {
  tone: McpVerdictTone;
  headline: string;
  detail: string;
}

/**
 * Anything at or above this share of failed calls is called out as broken
 * rather than as a wobble. A quarter of an agent's calls failing is not noise —
 * it is an integration that has stopped working for most of its callers.
 */
const BAD_FAILURE_SHARE = 0.25;

/**
 * The one sentence the screen exists to produce.
 *
 * `includeAll` changes the SUBJECT of every sentence, so it is a parameter
 * rather than a caption elsewhere. The default filter covers retained rows
 * whose caller-controlled User-Agent starts `postwave-mcp-server/`; neither
 * branch is a complete traffic ledger.
 */
export function mcpActivityVerdict(
  stats: McpStats | null,
  window: McpWindow,
  includeAll: boolean,
): McpVerdict {
  const scope = includeAll
    ? "API-key recorder rows"
    : "MCP-labelled recorder rows";
  const period = mcpWindowLabel(window);
  if (!stats) {
    return {
      tone: "idle",
      headline: "No reading yet",
      detail: `Nothing has been read for the last ${period}.`,
    };
  }
  if (!stats.hasCalls) {
    return {
      tone: "idle",
      headline: `No ${scope} retained in the last ${period}`,
      detail: includeAll
        ? "The best-effort recorder retained no matching row. It is droppable and incomplete, so this does not prove that no API-key request occurred."
        : "The best-effort recorder retained no row with the caller-asserted MCP User-Agent. That label is forgeable and absence does not prove no MCP call occurred.",
    };
  }
  if (stats.failedCalls === 0) {
    return {
      tone: "ok",
      headline: `0 failures among ${stats.totalCalls} ${scope}`,
      detail: `The retained rows for the last ${period} answered 2xx or 3xx. Recorder loss and caller-asserted labels mean this is not proof that every call succeeded.`,
    };
  }
  const share = stats.failedCalls / stats.totalCalls;
  return {
    tone: share >= BAD_FAILURE_SHARE ? "bad" : "warn",
    headline: `${stats.failedCalls} failures among ${stats.totalCalls} ${scope}`,
    detail: `Retained in the last ${period}; 4xx, 5xx, or missing status counts as failure. This best-effort sample is incomplete and non-authoritative.`,
  };
}

/**
 * What the top-tool table does NOT account for.
 *
 * Returns null when there is nothing to disclose. Otherwise the caller prints
 * the sentence verbatim — see fact 3 in the module note: the shortfall has two
 * causes and this deliberately does not guess which one produced it.
 */
export function mcpToolCoverageNotice(stats: McpStats): string | null {
  if (!stats.hasCalls || stats.topTools.length === 0) return null;
  const counted = stats.topTools.reduce((sum, tool) => sum + tool.calls, 0);
  const missing = stats.totalCalls - counted;
  if (missing <= 0) return null;
  return `${missing} of ${stats.totalCalls} calls are not in this list — either they carried no tool name, or their tool fell outside the server's top five.`;
}

/**
 * The server clamped the window. Returns null when it used what was asked for.
 *
 * `/trend` clamps independently of `/stats` (30d vs 90d), so this is asked of
 * each payload separately rather than once for the screen.
 */
export function mcpWindowClampNotice(
  window: McpWindow,
  serverWindowHours: number,
): string | null {
  const asked = mcpWindowHours(window);
  if (serverWindowHours <= 0 || serverWindowHours === asked) return null;
  const days = Math.round(serverWindowHours / 24);
  const served =
    serverWindowHours < 48 ? `${serverWindowHours} hours` : `${days} days`;
  return `The server answered with ${served} rather than ${mcpWindowLabel(window)} — it clamps this window itself.`;
}

/**
 * Recorder-derived cost estimate in whole currency units, or null when there
 * is no measurement behind it. It is advisory, non-billing telemetry.
 */
export function mcpCostUnits(stats: McpStats): number | null {
  if (!stats.hasCalls) return null;
  return stats.totalCostMicros / 1_000_000;
}
