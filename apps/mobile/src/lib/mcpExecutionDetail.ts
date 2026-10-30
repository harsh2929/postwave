/**
 * lib/mcpExecutionDetail.ts — one retained api_key_calls row, minimised for a
 * detail sheet, with the desktop's masking ported one for one.
 *
 * WHERE THE MASKING ALREADY HAPPENED, AND WHY IT HAPPENS AGAIN. The server
 * runs every row through `minimizeCallForResponse`
 * (apps/api/internal/apikeycalls/handlers.go:332-345) before it leaves: the
 * path is cut to its reviewed leading segments, the query string becomes
 * `key_count=N`, the body becomes `{_summary, type, key_count, _truncated}`,
 * the remote IP is blanked, the User-Agent is reduced to its product token,
 * and tool / prefix / error-code fields are re-validated. That is the
 * DetailPolicy the response names: `minimized_v1`.
 *
 * The desktop (apps/desktop/src/components/mcp/mcp-execution-security.ts)
 * applies the same rules AGAIN at the client boundary, because rows written
 * before minimisation existed are projected through the handler but a
 * recorder bug — or a proxy that is not this server — could still hand the
 * client a raw path with an e-mail address in it. Identifiers here are
 * rendered as exact tokens and offered to the clipboard, so a value that
 * LOOKS like a path but carries a bearer token or a bidi override must be
 * suppressed, not shown. Every rule below is the desktop's, unchanged.
 *
 * WHAT THIS MODULE DOES NOT DO. It never reconstructs a request. The only
 * copyable artefact is the constant-shaped body summary, and the desktop's
 * "Executable replay is release-held" stance is carried into the sheet
 * verbatim.
 *
 * WHY A SEPARATE DETAIL FETCH. `lib/mcpActivity.normalizeMcpExecutions` keeps
 * only the fields the log row renders and drops `queryString`, `requestBody`
 * and `apiKeyId`. This module parses the same list payload (there is no
 * per-row route) but keeps the minimised metadata, and the sheet re-reads
 * one row with `limit=1&before_id=id+1` — `before_id` is exclusive
 * (`id < before_id`), so that window is exactly the row that was tapped.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */

const HTTP_METHODS = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);
const UNSAFE_INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;
const SECRET_MATERIAL =
  /(?:pw_[A-Za-z0-9_-]{6,}|Bearer\s+\S+|Basic\s+\S+|[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}|[^\s@]+@[^\s@]+\.[^\s@]+)/iu;

export const MCP_SUPPRESSED = "Suppressed";
export const MCP_SENSITIVE_PATH = "/[SENSITIVE_PATH_SUPPRESSED]";

export function safeMcpMethod(method: unknown): string {
  if (typeof method !== "string") return "GET";
  const normalized = method.trim().toUpperCase();
  return HTTP_METHODS.has(normalized) ? normalized : "GET";
}

export function safeMcpPath(path: unknown): string {
  if (typeof path !== "string" || !path.startsWith("/")) return "/";
  const normalized = path.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 2_048);
  return SECRET_MATERIAL.test(normalized) || UNSAFE_INVISIBLE.test(normalized)
    ? MCP_SENSITIVE_PATH
    : normalized;
}

export function safeMcpDiagnostic(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._:/ -]{1,128}$/u.test(normalized) &&
    !SECRET_MATERIAL.test(normalized)
    ? normalized
    : MCP_SUPPRESSED;
}

export function safeMcpToolName(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(normalized) &&
    !SECRET_MATERIAL.test(normalized)
    ? normalized
    : MCP_SUPPRESSED;
}

export function safeMcpUserAgent(value: unknown): string {
  const match =
    typeof value === "string"
      ? value.match(/^postwave-mcp-server\/([A-Za-z0-9._+-]{1,64})$/u)
      : null;
  return match ? `postwave-mcp-server/${match[1]}` : MCP_SUPPRESSED;
}

export interface RedactedMcpRequestDetails {
  /** Pretty JSON of the constant-shaped summary, or "" when no body was retained. */
  bodyJson: string;
  /** "key_count=N", or "" when no query was retained. */
  query: string;
  /** Lower bound on caller-supplied items that were removed. */
  redactionCount: number;
}

function redactQuery(queryString: unknown): { query: string; count: number } {
  if (typeof queryString !== "string" || !queryString) {
    return { query: "", count: 0 };
  }
  const minimized = queryString.match(
    /^(?:key|parameter)_count=(0|[1-9]\d{0,3})$/u,
  );
  if (minimized) {
    const count = Number(minimized[1]);
    if (Number.isSafeInteger(count) && count >= 0 && count <= 1_024) {
      return { query: `key_count=${count}`, count };
    }
    return { query: "key_count=unknown", count: 1 };
  }
  // A raw query string reaching the client is itself the failure this guards
  // against; only its key COUNT survives, never a key name or a value.
  try {
    const source = new URLSearchParams(queryString);
    const count = Array.from(source.keys()).length;
    return { query: count > 0 ? `key_count=${count}` : "", count };
  } catch {
    return { query: "key_count=unknown", count: 1 };
  }
}

type BodyType =
  | "array"
  | "boolean"
  | "null"
  | "number"
  | "object"
  | "string"
  | "unknown";
const BODY_TYPES: readonly BodyType[] = [
  "array",
  "boolean",
  "null",
  "number",
  "object",
  "string",
  "unknown",
];

interface BodySummary {
  _summary: true;
  type: BodyType;
  key_count: number;
  _truncated: boolean;
}

function requestBodyMetadata(value: unknown): {
  body: BodySummary | null;
  count: number;
} {
  if (value == null) return { body: null, count: 0 };
  const type: BodyType = Array.isArray(value)
    ? "array"
    : typeof value === "object"
      ? "object"
      : BODY_TYPES.includes(typeof value as BodyType)
        ? (typeof value as BodyType)
        : "unknown";
  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record._summary === true) {
      const recordedType = record.type;
      const recordedCount = record.key_count;
      const keys = record.keys;
      const keyCount =
        typeof recordedCount === "number" &&
        Number.isSafeInteger(recordedCount) &&
        recordedCount >= 0
          ? recordedCount
          : Array.isArray(keys)
            ? keys.length
            : 0;
      return {
        body: {
          _summary: true,
          type:
            typeof recordedType === "string" &&
            BODY_TYPES.includes(recordedType as BodyType)
              ? (recordedType as BodyType)
              : type,
          key_count: keyCount,
          _truncated: record._truncated === true,
        },
        count: keyCount,
      };
    }
    const keyCount = Object.keys(record).length;
    return {
      body: {
        _summary: true,
        type,
        key_count: keyCount,
        _truncated: keyCount > 100,
      },
      count: keyCount,
    };
  }
  return {
    body: { _summary: true, type, key_count: 0, _truncated: false },
    count: 0,
  };
}

export function redactMcpRequestDetails(execution: {
  queryString?: unknown;
  requestBody?: unknown;
}): RedactedMcpRequestDetails {
  const summarized = requestBodyMetadata(execution.requestBody);
  const query = redactQuery(execution.queryString);
  return {
    bodyJson: summarized.body ? JSON.stringify(summarized.body, null, 2) : "",
    query: query.query,
    redactionCount: summarized.count + query.count,
  };
}

/** Desktop's sentence under the metadata block, verbatim. */
export function mcpRedactionSentence(count: number): string {
  return `Only constant type, key-count, and truncation fields remain. At least ${count} request metadata item${count === 1 ? " was" : "s were"} omitted; caller-supplied key names and values are not shown.`;
}

export interface McpExecutionDetail {
  id: number;
  /** "" when the key row was deleted (the pointer is nil). */
  apiKeyId: string;
  apiKeyPrefix: string;
  method: string;
  path: string;
  query: string;
  toolName: string;
  statusCode: number;
  latencyMs: number;
  userAgent: string;
  errorCode: string;
  bodyJson: string;
  redactionCount: number;
  dryRunAsserted: boolean;
  costMicros: number;
  calledAt: string;
}

export interface McpExecutionDetailEnvelope {
  tenantId: string;
  /** Server-authored, rendered verbatim: "minimized_v1" today. */
  detailPolicy: string;
  /** Server-authored, rendered verbatim: "best_effort_observability" today. */
  evidenceClass: string;
  /** null when the window came back empty or held a different row. */
  row: McpExecutionDetail | null;
}

export type McpExecutionDetailParse =
  | { detail: McpExecutionDetailEnvelope; error: null }
  | { detail: null; error: string };

export const MCP_DETAIL_MALFORMED = "The call detail response was malformed.";
export const MCP_DETAIL_WRONG_WORKSPACE =
  "The call detail response belongs to a different workspace.";
export const MCP_DETAIL_NOT_RETAINED =
  "This row is no longer retained on the server.";

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function int(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

/** Project one wire row through every rule above. Exported for the tests. */
export function projectMcpExecutionDetail(
  value: unknown,
): McpExecutionDetail | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = int(row.id);
  if (id <= 0) return null;
  const request = redactMcpRequestDetails(row);
  const toolName = str(row.toolName);
  const userAgent = str(row.userAgent);
  const errorCode = str(row.errorCode);
  return {
    id,
    apiKeyId: str(row.apiKeyId),
    apiKeyPrefix: str(row.apiKeyPrefix),
    method: safeMcpMethod(row.method),
    path: safeMcpPath(row.path),
    query: request.query,
    toolName: toolName ? safeMcpToolName(toolName) : "",
    statusCode: int(row.statusCode),
    latencyMs: int(row.latencyMs),
    userAgent: userAgent ? safeMcpUserAgent(userAgent) : "",
    errorCode: errorCode ? safeMcpDiagnostic(errorCode) : "",
    bodyJson: request.bodyJson,
    redactionCount: request.redactionCount,
    dryRunAsserted: row.dryRunAsserted === true || row.dryRun === true,
    costMicros: int(row.costMicros),
    calledAt: str(row.calledAt),
  };
}

/**
 * Parse the one-row window. The row is only accepted when its id is the one
 * that was asked for: `before_id` is a cursor, so if the tapped row has since
 * been purged the server answers with the next-older row, and showing that
 * under the tapped row's header would be a lie.
 */
export function normalizeMcpExecutionDetail(
  raw: unknown,
  wantedId: number,
  expectedTenantId: string | null,
): McpExecutionDetailParse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { detail: null, error: MCP_DETAIL_MALFORMED };
  }
  const body = raw as Record<string, unknown>;
  const tenantId = str(body.tenantId);
  if (!tenantId || !Array.isArray(body.rows)) {
    return { detail: null, error: MCP_DETAIL_MALFORMED };
  }
  if (expectedTenantId && tenantId !== expectedTenantId) {
    return { detail: null, error: MCP_DETAIL_WRONG_WORKSPACE };
  }
  const first = body.rows.length > 0 ? projectMcpExecutionDetail(body.rows[0]) : null;
  return {
    detail: {
      tenantId,
      detailPolicy: str(body.detailPolicy),
      evidenceClass: str(body.evidenceClass),
      row: first && first.id === wantedId ? first : null,
    },
    error: null,
  };
}

/** The sheet title: the identifier, or the reason there is none. */
export function mcpExecutionTitle(toolName: string): string {
  if (!toolName) return "No tool identifier recorded";
  const safe = safeMcpToolName(toolName);
  return safe === MCP_SUPPRESSED ? "Tool identifier suppressed" : safe;
}
