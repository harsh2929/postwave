import type {
  MCPExecution,
  MCPExecutionsResponse,
  MCPQuotaResponse,
  MCPStats,
  MCPToolQuota,
  MCPTrendPoint,
} from "../../lib/api-client";
import { MCP_WINDOW_HOURS } from "./mcp-display";
import {
  safeMcpMethod,
  safeMcpToolName,
  safeMcpUserAgent,
} from "./mcp-execution-security";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const UNSAFE_CONTROL = /[\u0000-\u001f\u007f]/u;
const MAX_BREAKDOWN_ROWS = 100;
const MAX_TREND_POINTS = MCP_WINDOW_HOURS["30d"] + 1;
const MAX_QUOTA_ROWS = 1_000;
export const MAX_RETAINED_MCP_EXECUTIONS = 500;

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    RFC3339.test(value) &&
    Number.isFinite(new Date(value).getTime())
  );
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function validStatsTools(value: unknown[], totalCalls: number): boolean {
  if (value.length > MAX_BREAKDOWN_ROWS) return false;
  const names = new Set<string>();
  let representedCalls = 0;
  for (const candidate of value) {
    if (!objectRecord(candidate)) return false;
    const { toolName, calls } = candidate;
    if (
      typeof toolName !== "string" ||
      safeMcpToolName(toolName) !== toolName ||
      names.has(toolName) ||
      !nonNegativeInteger(calls) ||
      calls > totalCalls
    ) {
      return false;
    }
    names.add(toolName);
    representedCalls += calls;
  }
  return representedCalls <= totalCalls;
}

function validStatsKeys(value: unknown[], totalCalls: number): boolean {
  if (value.length > MAX_BREAKDOWN_ROWS) return false;
  const identities = new Set<string>();
  let representedCalls = 0;
  for (const candidate of value) {
    if (!objectRecord(candidate)) return false;
    const { apiKeyId, apiKeyPrefix, calls } = candidate;
    if (
      typeof apiKeyPrefix !== "string" ||
      (apiKeyPrefix !== "" && !SAFE_ID.test(apiKeyPrefix)) ||
      (apiKeyId != null &&
        (typeof apiKeyId !== "string" ||
          (apiKeyId !== "" && !SAFE_ID.test(apiKeyId)))) ||
      (!apiKeyId && !apiKeyPrefix) ||
      !nonNegativeInteger(calls) ||
      calls > totalCalls
    ) {
      return false;
    }
    const identity = String(apiKeyId || apiKeyPrefix);
    if (identities.has(identity)) return false;
    identities.add(identity);
    representedCalls += calls;
  }
  return representedCalls <= totalCalls;
}

function validStatusBreakdown(
  value: unknown[],
  totalCalls: number,
  successfulCalls: number,
): boolean {
  if (value.length > 4) return false;
  const classes = new Set<number>();
  let representedCalls = 0;
  let representedSuccesses = 0;
  for (const candidate of value) {
    if (!objectRecord(candidate)) return false;
    const statusClass = candidate.class;
    const calls = candidate.calls;
    if (
      !nonNegativeInteger(statusClass) ||
      ![2, 3, 4, 5].includes(statusClass) ||
      classes.has(statusClass) ||
      !nonNegativeInteger(calls)
    ) {
      return false;
    }
    classes.add(statusClass);
    representedCalls += calls;
    if (statusClass === 2 || statusClass === 3) representedSuccesses += calls;
  }
  return (
    representedCalls === totalCalls && representedSuccesses === successfulCalls
  );
}

export function validStats(value: MCPStats | undefined): value is MCPStats {
  if (!value) return false;
  if (
    !SAFE_ID.test(value.tenantId) ||
    !nonNegativeInteger(value.windowHours) ||
    !nonNegativeInteger(value.totalCalls) ||
    !nonNegativeInteger(value.successfulCalls) ||
    value.successfulCalls > value.totalCalls ||
    !nonNegativeNumber(value.successRate) ||
    value.successRate > 1 ||
    !nonNegativeNumber(value.averageLatencyMs) ||
    !nonNegativeInteger(value.p95LatencyMs) ||
    !nonNegativeInteger(value.totalCostMicros) ||
    !Array.isArray(value.topTools) ||
    !Array.isArray(value.topApiKeys) ||
    !Array.isArray(value.statusBreakdown)
  ) {
    return false;
  }
  const expectedSuccessRate =
    value.totalCalls === 0 ? 0 : value.successfulCalls / value.totalCalls;
  if (Math.abs(value.successRate - expectedSuccessRate) > 0.000_001)
    return false;
  if (value.lastCallAt && !validTimestamp(value.lastCallAt)) return false;
  return (
    validStatsTools(value.topTools, value.totalCalls) &&
    validStatsKeys(value.topApiKeys, value.totalCalls) &&
    validStatusBreakdown(
      value.statusBreakdown,
      value.totalCalls,
      value.successfulCalls,
    )
  );
}

export function validTrend(
  value: MCPTrendPoint[] | undefined,
): value is MCPTrendPoint[] {
  if (!Array.isArray(value) || value.length > MAX_TREND_POINTS) return false;
  let previous = Number.NEGATIVE_INFINITY;
  for (const candidate of value) {
    if (!objectRecord(candidate)) return false;
    const { bucket, calls } = candidate;
    if (!validTimestamp(bucket) || !nonNegativeInteger(calls)) return false;
    const timestamp = new Date(bucket).getTime();
    if (
      timestamp <= previous ||
      new Date(timestamp).getUTCMinutes() !== 0 ||
      new Date(timestamp).getUTCSeconds() !== 0 ||
      new Date(timestamp).getUTCMilliseconds() !== 0 ||
      (previous !== Number.NEGATIVE_INFINITY &&
        timestamp - previous !== 60 * 60 * 1_000)
    ) {
      return false;
    }
    previous = timestamp;
  }
  return true;
}

export function validTrendForWindow(
  value: MCPTrendPoint[] | undefined,
  since: string,
  windowHours: number,
  now = Date.now(),
): value is MCPTrendPoint[] {
  if (!validTrend(value) || value.length !== windowHours + 1) return false;
  const hourMs = 60 * 60 * 1_000;
  const requestedAt = new Date(since).getTime() + windowHours * hourMs;
  if (!Number.isFinite(requestedAt)) return false;
  const expectedFirst = Math.floor(new Date(since).getTime() / hourMs) * hourMs;
  const expectedLast = expectedFirst + windowHours * hourMs;
  const currentHour = Math.floor(now / hourMs) * hourMs;
  const first = new Date(value[0]?.bucket ?? "").getTime();
  const last = new Date(value.at(-1)?.bucket ?? "").getTime();
  return (
    first === expectedFirst &&
    last === expectedLast &&
    expectedLast === Math.floor(requestedAt / hourMs) * hourMs &&
    expectedLast <= currentHour &&
    expectedLast >= currentHour - hourMs
  );
}

export function validTrendEnvelopeForScope(
  value:
    | {
        tenantId: string;
        windowHours: number;
        points: MCPTrendPoint[];
      }
    | undefined,
  tenantId: string,
  windowHours: number,
  since: string,
  now = Date.now(),
): boolean {
  return Boolean(
    value &&
    value.tenantId === tenantId &&
    value.windowHours === windowHours &&
    validTrendForWindow(value.points, since, windowHours, now),
  );
}

export function validQuotas(
  value: MCPToolQuota[] | undefined,
): value is MCPToolQuota[] {
  if (!Array.isArray(value) || value.length > MAX_QUOTA_ROWS) return false;
  const names = new Set<string>();
  for (const candidate of value) {
    if (!objectRecord(candidate)) return false;
    const { toolName, dailyLimit, estimatedCostMicros, usedToday } = candidate;
    if (
      typeof toolName !== "string" ||
      safeMcpToolName(toolName) !== toolName ||
      names.has(toolName) ||
      (dailyLimit != null &&
        (!Number.isSafeInteger(dailyLimit) || Number(dailyLimit) <= 0)) ||
      !nonNegativeInteger(estimatedCostMicros) ||
      !nonNegativeInteger(usedToday)
    ) {
      return false;
    }
    names.add(toolName);
  }
  return true;
}

export function validQuotaEnvelopeForScope(
  value: MCPQuotaResponse | undefined,
  tenantId: string,
): boolean {
  return Boolean(
    value &&
    value.tenantId === tenantId &&
    value.enforcementMode === "advisory_unverified" &&
    value.authoritative === false &&
    value.releaseHold === "mcp_quota_enforcement_release_held" &&
    validQuotas(value.quotas),
  );
}

function optionalBoundedString(value: unknown, maxLength: number): boolean {
  return (
    value == null ||
    (typeof value === "string" &&
      value.length <= maxLength &&
      !UNSAFE_CONTROL.test(value))
  );
}

function optionalSafeId(value: unknown): boolean {
  return (
    value == null ||
    value === "" ||
    (typeof value === "string" && SAFE_ID.test(value))
  );
}

function validRequestBody(value: unknown): boolean {
  if (!objectRecord(value) || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = new Set(["_summary", "_truncated", "key_count", "type"]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    record["_summary"] !== true ||
    (record["_truncated"] != null &&
      typeof record["_truncated"] !== "boolean") ||
    (record["type"] != null &&
      ![
        "array",
        "boolean",
        "null",
        "number",
        "object",
        "string",
        "unknown",
      ].includes(String(record["type"]))) ||
    (record["key_count"] != null &&
      (!Number.isSafeInteger(record["key_count"]) ||
        Number(record["key_count"]) < 0 ||
        Number(record["key_count"]) > 1_024))
  ) {
    return false;
  }
  return true;
}

export function validExecution(value: unknown): value is MCPExecution {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<MCPExecution>;
  return (
    Number.isSafeInteger(row.id) &&
    Number(row.id) > 0 &&
    typeof row.tenantId === "string" &&
    row.tenantId.length > 0 &&
    row.tenantId.length <= 128 &&
    !UNSAFE_CONTROL.test(row.tenantId) &&
    typeof row.method === "string" &&
    safeMcpMethod(row.method) === row.method &&
    typeof row.path === "string" &&
    row.path.startsWith("/") &&
    row.path.length <= 2_048 &&
    !UNSAFE_CONTROL.test(row.path) &&
    (row.toolName == null ||
      row.toolName === "" ||
      (typeof row.toolName === "string" &&
        safeMcpToolName(row.toolName) === row.toolName)) &&
    optionalSafeId(row.apiKeyId) &&
    optionalSafeId(row.apiKeyPrefix) &&
    nonNegativeInteger(row.statusCode) &&
    Number(row.statusCode) >= 100 &&
    Number(row.statusCode) <= 599 &&
    nonNegativeNumber(row.latencyMs) &&
    nonNegativeInteger(row.costMicros) &&
    validTimestamp(row.calledAt) &&
    (row.queryString == null ||
      (typeof row.queryString === "string" &&
        /^key_count=(?:0|[1-9]\d{0,3})$/u.test(row.queryString) &&
        Number(row.queryString.slice("key_count=".length)) <= 1_024)) &&
    optionalBoundedString(row.userAgent, 512) &&
    optionalBoundedString(row.remoteIp, 128) &&
    optionalBoundedString(row.errorCode, 512) &&
    (row.requestBody == null || validRequestBody(row.requestBody)) &&
    (row.dryRun == null || typeof row.dryRun === "boolean") &&
    (row.dryRunAsserted == null || typeof row.dryRunAsserted === "boolean") &&
    (row.dryRun == null ||
      row.dryRunAsserted == null ||
      row.dryRun === row.dryRunAsserted)
  );
}

export function validExecutionPage(
  value: MCPExecutionsResponse | undefined,
): value is MCPExecutionsResponse {
  if (
    !value ||
    !SAFE_ID.test(value.tenantId) ||
    value.detailPolicy !== "minimized_v1" ||
    value.evidenceClass !== "best_effort_observability" ||
    !Array.isArray(value.rows) ||
    value.rows.length > MAX_RETAINED_MCP_EXECUTIONS ||
    !value.rows.every(validExecution) ||
    (value.nextBeforeId !== undefined &&
      (!Number.isSafeInteger(value.nextBeforeId) || value.nextBeforeId <= 0))
  ) {
    return false;
  }
  return new Set(value.rows.map((row) => row.id)).size === value.rows.length;
}

export function validExecutionPageForScope(
  value: MCPExecutionsResponse | undefined,
  since: string,
  tool: string,
  beforeId?: number,
  tenantId?: string,
  source?: "mcp" | "all",
  now = Date.now(),
): value is MCPExecutionsResponse {
  if (!validExecutionPage(value)) return false;
  if (tenantId !== undefined && value.tenantId !== tenantId) return false;
  const lowerBound = new Date(since).getTime();
  const upperBound = now + 5 * 60 * 1_000;
  let previousId = Number.POSITIVE_INFINITY;
  for (const row of value.rows) {
    const timestamp = new Date(row.calledAt).getTime();
    if (
      timestamp < lowerBound ||
      timestamp > upperBound ||
      row.id >= previousId ||
      (tenantId !== undefined && row.tenantId !== tenantId) ||
      (source === "mcp" && safeMcpUserAgent(row.userAgent) !== row.userAgent) ||
      Boolean(tool && row.toolName !== tool) ||
      (beforeId !== undefined && row.id >= beforeId)
    ) {
      return false;
    }
    previousId = row.id;
  }
  if (value.nextBeforeId !== undefined) {
    if (
      value.rows.length === 0 ||
      value.nextBeforeId !== value.rows[value.rows.length - 1].id
    ) {
      return false;
    }
  }
  return true;
}

/** Validate one minimized live row against the exact represented UI scope. */
export function validLiveExecutionForScope(
  value: unknown,
  since: string,
  tenantId: string,
  source: "mcp" | "all",
  now = Date.now(),
): value is MCPExecution {
  if (!validExecution(value)) return false;
  const timestamp = new Date(value.calledAt).getTime();
  const lowerBound = new Date(since).getTime();
  return (
    timestamp >= lowerBound &&
    timestamp <= now + 5 * 60 * 1_000 &&
    value.tenantId === tenantId &&
    (source !== "mcp" || safeMcpUserAgent(value.userAgent) === value.userAgent)
  );
}

export function mergeExecutions(
  primary: MCPExecution[],
  secondary: MCPExecution[],
): MCPExecution[] {
  const rows = new Map<number, MCPExecution>();
  for (const row of [...primary, ...secondary]) {
    if (!rows.has(row.id)) rows.set(row.id, row);
  }
  return Array.from(rows.values())
    .sort((left, right) => right.id - left.id)
    .slice(0, MAX_RETAINED_MCP_EXECUTIONS);
}
