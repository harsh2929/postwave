/**
 * lib/mcp-api.ts — the MCP tool surface exposed to agents.
 *
 * Two `/api/v1/mcp/*` paths were reached by desktop and by no web file:
 * the governed tool/category catalog and quotas.
 *
 * THE QUOTAS ARE NOT ENFORCED AND THE SERVER SAYS SO IN THREE FIELDS:
 *
 *     "enforcementMode": "advisory_unverified",
 *     "authoritative": false,
 *     "releaseHold": "mcp_quota_enforcement_release_held"
 *
 * A quota screen that lists limits without those is the most dangerous kind of
 * governance UI: it tells an operator that agent access is bounded when
 * nothing is stopping it. `authoritative: false` is the field to believe.
 *
 * `/catalog` returns a BARE ARRAY, not an envelope — like /analytics/cohorts
 * and unlike most of this API.
 */
import { api } from "@/lib/api";

export interface McpTool {
  name: string;
  category: string;
  description?: string;
}

export interface McpQuotas {
  quotas: unknown[];
  /** e.g. "advisory_unverified" — advisory means NOT enforced. */
  enforcementMode: string;
  /** False when these limits do not actually bind. */
  authoritative: boolean;
  /** Non-empty when enforcement is deliberately held back. */
  releaseHold: string;
}

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export async function listMcpTools(): Promise<McpTool[]> {
  // Bare array, not { items: [] }.
  const res = await api.get<unknown>("/api/v1/mcp/catalog");
  return asArray<McpTool>(res).map((t) => ({
    name: String(t?.name ?? ""),
    category: String(t?.category ?? "uncategorised"),
    description: typeof t?.description === "string" ? t.description : undefined,
  }));
}

export async function getMcpQuotas(): Promise<McpQuotas> {
  const res = await api.get<McpQuotas>("/api/v1/mcp/quotas");
  return {
    quotas: asArray(res?.quotas),
    enforcementMode:
      typeof res?.enforcementMode === "string" ? res.enforcementMode : "",
    authoritative: res?.authoritative === true,
    releaseHold: typeof res?.releaseHold === "string" ? res.releaseHold : "",
  };
}

/** Tool counts per category, largest first. */
export function toolsByCategory(tools: readonly McpTool[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// ---------------------------------------------------------------------------
// Recorded execution telemetry (history)
//
// Three more `/api/v1/mcp/*` reads desktop consumed and web did not:
// `/stats`, `/trend` and `/executions`. All three are admin-only
// (RequireExactTenantAdmin) and all three describe a recorder the server
// itself labels `best_effort_observability` with `detailPolicy:
// "minimized_v1"`.
//
// THAT LABEL IS THE HEADLINE FOR THIS SECTION, the way `authoritative: false`
// is for quotas. These rows are not an audit trail: the recorder is
// asynchronous and may omit calls, and the "MCP" source is nothing more than
// a caller-controlled user-agent prefix. A history table that presents them
// as a complete record of what an agent did would be read as proof, and it is
// not proof. Every surface that renders them says so.
//
// There is no CSV export verb here on purpose: the server returns 503
// `mcp_execution_export_release_held` for `/api/v1/mcp/executions.csv`
// (internal/apikeycalls/handlers.go), so an export button would be a control
// that cannot succeed.
// ---------------------------------------------------------------------------

export type McpHistoryWindow = "24h" | "7d" | "30d";
/** `mcp` = self-identified npm proxy only; `all` = every API-key call. */
export type McpHistorySource = "mcp" | "all";

export const MCP_WINDOW_HOURS: Record<McpHistoryWindow, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

export const MCP_WINDOW_LABELS: Record<McpHistoryWindow, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

/** One page of rows; the client stops traversing here rather than unbounded. */
export const MAX_RETAINED_MCP_EXECUTIONS = 500;
export const MCP_EXECUTION_PAGE_SIZE = 50;

/**
 * The server's own canonical tool token grammar
 * (internal/apikeycalls/apikeycalls.go `toolLabelPattern`). Sending anything
 * else returns 400 `invalid_query`, so the filter is withheld with a reason
 * rather than fired blind.
 */
const TOOL_TOKEN = /^[A-Za-z][A-Za-z0-9._:-]{0,95}$/u;

export function isCanonicalMcpToolToken(value: string): boolean {
  return TOOL_TOKEN.test(value.trim());
}

export function mcpWindowSinceISO(
  window: McpHistoryWindow,
  now: number = Date.now(),
): string {
  return new Date(now - MCP_WINDOW_HOURS[window] * 3_600_000).toISOString();
}

export interface McpExecution {
  id: number;
  tenantId: string;
  apiKeyId?: string;
  apiKeyPrefix?: string;
  method: string;
  path: string;
  /** Server-minimized key shape (`key_count=N`), never a replayable query. */
  queryString?: string;
  toolName?: string;
  statusCode: number;
  latencyMs: number;
  userAgent?: string;
  errorCode?: string;
  /** Bounded request-body SHAPE. Scalar values are removed by the server. */
  requestBody?: unknown;
  /** Only ever a caller header assertion — never proof of a dry run. */
  dryRunAsserted?: boolean;
  costMicros: number;
  calledAt: string;
}

export interface McpExecutionPage {
  rows: McpExecution[];
  /** Cursor for the next page; pass back as `beforeId`. */
  nextBeforeId?: number;
  detailPolicy: string;
  evidenceClass: string;
}

export interface McpToolFrequency {
  toolName: string;
  calls: number;
}

export interface McpStatusFrequency {
  /** Leading digit of the HTTP status (2|3|4|5). */
  statusClass: number;
  calls: number;
}

export interface McpStats {
  windowHours: number;
  totalCalls: number;
  successfulCalls: number;
  successRate: number;
  averageLatencyMs: number;
  p95LatencyMs: number;
  lastCallAt?: string;
  topTools: McpToolFrequency[];
  statusBreakdown: McpStatusFrequency[];
  totalCostMicros: number;
}

export interface McpTrendPoint {
  /** RFC3339 hour-aligned UTC bucket boundary. */
  bucket: string;
  calls: number;
}

// --- response normalisation -------------------------------------------------

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const HTTP_METHODS = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);
const UNSAFE_INVISIBLE =
  /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const SECRET_MATERIAL =
  /(?:pw_[A-Za-z0-9_-]{6,}|Bearer\s+\S+|Basic\s+\S+|[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}|[^\s@]+@[^\s@]+\.[^\s@]+)/iu;

export function safeMcpMethod(value: unknown): string {
  const normalized = text(value).trim().toUpperCase();
  return HTTP_METHODS.has(normalized) ? normalized : "GET";
}

export function safeMcpPath(value: unknown): string {
  const raw = text(value);
  if (!raw.startsWith("/")) return "/";
  const normalized = raw
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .slice(0, 2_048);
  return SECRET_MATERIAL.test(normalized) || UNSAFE_INVISIBLE.test(normalized)
    ? "/[SENSITIVE_PATH_SUPPRESSED]"
    : normalized;
}

export function safeMcpToolName(value: unknown): string {
  const normalized = text(value).trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(normalized) &&
    !SECRET_MATERIAL.test(normalized)
    ? normalized
    : "Suppressed";
}

export function safeMcpUserAgent(value: unknown): string {
  const match = text(value).match(
    /^postwave-mcp-server\/([A-Za-z0-9._+-]{1,64})$/u,
  );
  return match ? `postwave-mcp-server/${match[1]}` : "Suppressed";
}

export function safeMcpDiagnostic(value: unknown): string {
  const normalized = text(value).trim();
  return /^[A-Za-z0-9._:/ -]{1,128}$/u.test(normalized) &&
    !SECRET_MATERIAL.test(normalized)
    ? normalized
    : "Suppressed";
}

/** The only request-body fields any Moosewave surface is allowed to retain. */
export interface McpRequestShape {
  _summary: true;
  type: string;
  key_count: number;
  _truncated: boolean;
}

export interface McpRequestMetadata {
  /** The constant shape fields, or null when nothing was recorded. */
  body: McpRequestShape | null;
  /** Pretty JSON of `body`, or "" when nothing was recorded. */
  bodyJson: string;
  /** `key_count=N`, or "" when no query was recorded. */
  query: string;
  /** How many caller-supplied items are known to have been dropped. */
  redactionCount: number;
}

function queryKeyCount(queryString: string): { query: string; count: number } {
  if (!queryString) return { query: "", count: 0 };
  const minimized = /^(?:key|parameter)_count=(0|[1-9]\d{0,3})$/u.exec(
    queryString,
  );
  if (minimized) return { query: `key_count=${minimized[1]}`, count: Number(minimized[1]) };
  try {
    const size = [...new URLSearchParams(queryString).keys()].length;
    return { query: size > 0 ? `key_count=${size}` : "", count: size };
  } catch {
    return { query: "key_count=unknown", count: 1 };
  }
}

/**
 * Reduce a recorded request to constant shape metadata.
 *
 * The server already minimizes; this repeats it at the response boundary so a
 * server that regresses cannot put caller-supplied key names or values into
 * retained browser state. Only `type`, `key_count` and `_truncated` survive.
 */
export function mcpRequestMetadata(
  execution: Pick<McpExecution, "queryString" | "requestBody">,
): McpRequestMetadata {
  const query = queryKeyCount(text(execution.queryString));
  const raw = execution.requestBody;
  if (raw == null) {
    return {
      body: null,
      bodyJson: "",
      query: query.query,
      redactionCount: query.count,
    };
  }
  const source = record(raw);
  const isArray = Array.isArray(raw);
  const declaredType = text(source["type"]);
  const allowed = [
    "array",
    "boolean",
    "null",
    "number",
    "object",
    "string",
    "unknown",
  ];
  const observedType = isArray
    ? "array"
    : typeof raw === "object"
      ? "object"
      : typeof raw;
  const type =
    source["_summary"] === true && allowed.includes(declaredType)
      ? declaredType
      : observedType;
  const declaredCount = source["key_count"];
  const keyCount =
    source["_summary"] === true &&
    Number.isSafeInteger(declaredCount) &&
    Number(declaredCount) >= 0
      ? Number(declaredCount)
      : isArray || typeof raw !== "object"
        ? 0
        : Object.keys(source).length;
  const body: McpRequestShape = {
    _summary: true,
    type,
    key_count: keyCount,
    _truncated: source["_truncated"] === true,
  };
  return {
    body,
    bodyJson: JSON.stringify(body, null, 2),
    query: query.query,
    redactionCount: keyCount + query.count,
  };
}

/**
 * Minimize a row BEFORE it becomes retained React state — remote IP and raw
 * request values are removed at the boundary, not merely hidden at render.
 */
export function projectSafeMcpExecution(value: unknown): McpExecution | null {
  const row = record(value);
  const id = row["id"];
  if (!Number.isSafeInteger(id) || Number(id) <= 0) return null;
  const calledAt = text(row["calledAt"]);
  if (!Number.isFinite(new Date(calledAt).getTime())) return null;
  const metadata = mcpRequestMetadata({
    queryString: text(row["queryString"]),
    requestBody: row["requestBody"],
  });
  const toolName = text(row["toolName"]);
  return {
    id: Number(id),
    tenantId: text(row["tenantId"]),
    apiKeyId: text(row["apiKeyId"]) || undefined,
    apiKeyPrefix: text(row["apiKeyPrefix"]) || undefined,
    method: safeMcpMethod(row["method"]),
    path: safeMcpPath(row["path"]),
    queryString: metadata.query || undefined,
    toolName: toolName ? safeMcpToolName(toolName) : undefined,
    statusCode: count(row["statusCode"]),
    latencyMs: count(row["latencyMs"]),
    userAgent: text(row["userAgent"])
      ? safeMcpUserAgent(row["userAgent"])
      : undefined,
    errorCode: text(row["errorCode"])
      ? safeMcpDiagnostic(row["errorCode"])
      : undefined,
    requestBody: metadata.body ?? undefined,
    dryRunAsserted: row["dryRunAsserted"] === true || row["dryRun"] === true,
    costMicros: count(row["costMicros"]),
    calledAt,
  };
}

/** Newest-first, de-duplicated by id, bounded by the retention ceiling. */
export function mergeMcpExecutions(
  primary: readonly McpExecution[],
  secondary: readonly McpExecution[],
): McpExecution[] {
  const rows = new Map<number, McpExecution>();
  for (const row of [...primary, ...secondary]) {
    if (!rows.has(row.id)) rows.set(row.id, row);
  }
  return [...rows.values()]
    .sort((left, right) => right.id - left.id)
    .slice(0, MAX_RETAINED_MCP_EXECUTIONS);
}

// --- reads ------------------------------------------------------------------

export interface McpHistoryScope {
  window: McpHistoryWindow;
  include: McpHistorySource;
}

export async function getMcpStats(
  scope: McpHistoryScope,
  signal?: AbortSignal,
): Promise<McpStats> {
  const params = new URLSearchParams({ window: scope.window });
  if (scope.include === "all") params.set("include", "all");
  const res = record(
    await api.get<unknown>(`/api/v1/mcp/stats?${params.toString()}`, { signal }),
  );
  const total = count(res["totalCalls"]);
  const successful = Math.min(count(res["successfulCalls"]), total);
  return {
    windowHours: count(res["windowHours"]),
    totalCalls: total,
    successfulCalls: successful,
    successRate: total === 0 ? 0 : successful / total,
    averageLatencyMs: count(res["averageLatencyMs"]),
    p95LatencyMs: count(res["p95LatencyMs"]),
    lastCallAt: text(res["lastCallAt"]) || undefined,
    topTools: asArray<unknown>(res["topTools"])
      .map((entry) => {
        const tool = record(entry);
        return {
          toolName: safeMcpToolName(tool["toolName"]),
          calls: count(tool["calls"]),
        };
      })
      .sort((left, right) => right.calls - left.calls),
    statusBreakdown: asArray<unknown>(res["statusBreakdown"]).map((entry) => {
      const bucket = record(entry);
      return {
        statusClass: count(bucket["class"]),
        calls: count(bucket["calls"]),
      };
    }),
    totalCostMicros: count(res["totalCostMicros"]),
  };
}

export async function getMcpTrend(
  scope: McpHistoryScope,
  signal?: AbortSignal,
): Promise<McpTrendPoint[]> {
  const params = new URLSearchParams({ window: scope.window });
  if (scope.include === "all") params.set("include", "all");
  const res = record(
    await api.get<unknown>(`/api/v1/mcp/trend?${params.toString()}`, { signal }),
  );
  return asArray<unknown>(res["points"])
    .map((entry) => {
      const point = record(entry);
      return { bucket: text(point["bucket"]), calls: count(point["calls"]) };
    })
    .filter((point) => Number.isFinite(new Date(point.bucket).getTime()));
}

export interface McpExecutionQuery {
  include: McpHistorySource;
  /** Sets the `since` lower bound. Omit for an unbounded newest-first page. */
  window?: McpHistoryWindow;
  /** Exact canonical tool token; ignored unless it matches the grammar. */
  tool?: string;
  /** Cursor from a previous page's `nextBeforeId`. */
  beforeId?: number;
  limit?: number;
  /** Explicit lower bound, overriding the one derived from `window`. */
  since?: string;
}

export async function listMcpExecutions(
  query: McpExecutionQuery,
  signal?: AbortSignal,
): Promise<McpExecutionPage> {
  const params = new URLSearchParams();
  if (query.include === "all") params.set("include", "all");
  const tool = (query.tool ?? "").trim();
  if (tool && isCanonicalMcpToolToken(tool)) params.set("tool", tool);
  const since =
    query.since ?? (query.window ? mcpWindowSinceISO(query.window) : "");
  if (since) params.set("since", since);
  params.set("limit", String(query.limit ?? MCP_EXECUTION_PAGE_SIZE));
  if (query.beforeId && query.beforeId > 0) {
    params.set("before_id", String(query.beforeId));
  }
  const res = record(
    await api.get<unknown>(`/api/v1/mcp/executions?${params.toString()}`, {
      signal,
    }),
  );
  const rows: McpExecution[] = [];
  for (const entry of asArray<unknown>(res["rows"])) {
    const projected = projectSafeMcpExecution(entry);
    if (projected) rows.push(projected);
  }
  const next = res["nextBeforeId"];
  return {
    rows,
    nextBeforeId:
      Number.isSafeInteger(next) && Number(next) > 0 ? Number(next) : undefined,
    detailPolicy: text(res["detailPolicy"]),
    evidenceClass: text(res["evidenceClass"]),
  };
}

// --- display ----------------------------------------------------------------

export function formatMcpLatency(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "Not available";
  if (milliseconds < 1) return "<1 ms";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(2)} s`;
}

/** Keep the unit visible for sub-cent values; these are estimates, not bills. */
export function formatMcpMicrosUsd(micros: number): string {
  if (!Number.isFinite(micros) || micros < 0) return "Not available";
  if (micros === 0) return "$0.00 USD";
  const dollars = micros / 1_000_000;
  if (dollars >= 1) return `$${dollars.toFixed(2)} USD`;
  if (dollars >= 0.01) return `$${dollars.toFixed(3)} USD`;
  return `${Math.round(micros).toLocaleString()} micro-USD`;
}

export function formatMcpTimestamp(value: string | undefined): string {
  if (!value) return "Not recorded";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "Invalid timestamp";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export type McpStatusTone = "success" | "secondary" | "warning" | "destructive";

export function mcpStatusTone(statusCode: number): McpStatusTone {
  if (statusCode >= 200 && statusCode < 300) return "success";
  if (statusCode >= 300 && statusCode < 400) return "secondary";
  if (statusCode >= 400 && statusCode < 500) return "warning";
  return "destructive";
}

export function mcpStatusClassLabel(statusClass: number): string {
  if (statusClass === 2) return "2xx success";
  if (statusClass === 3) return "3xx redirect";
  if (statusClass === 4) return "4xx client error";
  if (statusClass === 5) return "5xx server error";
  return `${statusClass}xx response`;
}
