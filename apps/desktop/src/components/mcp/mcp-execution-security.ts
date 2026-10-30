import type { MCPExecution } from "../../lib/api-client";

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

export interface RedactedMcpRequestDetails {
  body: unknown;
  bodyJson: string;
  query: string;
  redactionCount: number;
}

function redactQuery(queryString: string | undefined): {
  query: string;
  count: number;
} {
  if (!queryString) return { query: "", count: 0 };
  const minimized = queryString.match(
    /^(?:key|parameter)_count=(0|[1-9]\d{0,3})$/u,
  );
  if (minimized) {
    const count = Number(minimized[1]);
    if (Number.isSafeInteger(count) && count >= 0 && count <= 1_024) {
      return { query: "key_count=" + String(count), count };
    }
    return { query: "key_count=unknown", count: 1 };
  }
  try {
    const source = new URLSearchParams(queryString);
    const count = Array.from(source.keys()).length;
    return {
      query: count > 0 ? "key_count=" + String(count) : "",
      count,
    };
  } catch {
    return { query: "key_count=unknown", count: 1 };
  }
}

function requestBodyMetadata(value: unknown): {
  body: unknown;
  count: number;
} {
  if (value == null) return { body: null, count: 0 };
  try {
    const type = Array.isArray(value)
      ? "array"
      : typeof value === "object"
        ? "object"
        : typeof value;
    let keyCount = 0;
    let truncated = false;
    if (typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (record["_summary"] === true) {
        const recordedType = record["type"];
        const recordedCount = record["key_count"];
        type BodyType =
          | "array"
          | "boolean"
          | "null"
          | "number"
          | "object"
          | "string"
          | "unknown";
        const allowedTypes: readonly BodyType[] = [
          "array",
          "boolean",
          "null",
          "number",
          "object",
          "string",
          "unknown",
        ];
        const safeType =
          typeof recordedType === "string" &&
          allowedTypes.includes(recordedType as BodyType)
            ? recordedType
            : type;
        const keys = record["keys"];
        keyCount =
          Number.isSafeInteger(recordedCount) && Number(recordedCount) >= 0
            ? Number(recordedCount)
            : Array.isArray(keys)
              ? keys.length
              : 0;
        truncated = record["_truncated"] === true;
        return {
          body: {
            _summary: true,
            type: safeType,
            key_count: keyCount,
            _truncated: truncated,
          },
          count: keyCount,
        };
      }
      keyCount = Object.keys(record).length;
      truncated = keyCount > 100;
    }
    return {
      body: {
        _summary: true,
        type,
        key_count: keyCount,
        _truncated: truncated,
      },
      count: keyCount,
    };
  } catch {
    return {
      body: {
        _summary: true,
        type: "unknown",
        key_count: 0,
        _truncated: true,
      },
      count: 1,
    };
  }
}

export function redactMcpRequestDetails(
  execution: Pick<MCPExecution, "queryString" | "requestBody">,
): RedactedMcpRequestDetails {
  const summarizedBody = requestBodyMetadata(execution.requestBody);
  const body = summarizedBody.body;
  const query = redactQuery(execution.queryString);
  let bodyJson = "";
  if (body !== null) {
    try {
      bodyJson = JSON.stringify(body, null, 2);
    } catch {
      bodyJson = '"[REQUEST SHAPE REDACTED]"';
      // The static fallback contains no caller-supplied value or key name.
    }
  }
  return {
    body,
    bodyJson,
    query: query.query,
    redactionCount: summarizedBody.count + query.count,
  };
}

export function safeMcpMethod(method: unknown): string {
  if (typeof method !== "string") return "GET";
  const normalized = method.trim().toUpperCase();
  return HTTP_METHODS.has(normalized) ? normalized : "GET";
}

export function safeMcpPath(path: unknown): string {
  if (typeof path !== "string" || !path.startsWith("/")) return "/";
  const normalized = path
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .slice(0, 2_048);
  return SECRET_MATERIAL.test(normalized) || UNSAFE_INVISIBLE.test(normalized)
    ? "/[SENSITIVE_PATH_SUPPRESSED]"
    : normalized;
}

export function safeMcpDiagnostic(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._:/ -]{1,128}$/u.test(normalized) &&
    !SECRET_MATERIAL.test(normalized)
    ? normalized
    : "Suppressed";
}

export function safeMcpToolName(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(normalized) &&
    !SECRET_MATERIAL.test(normalized)
    ? normalized
    : "Suppressed";
}

export function safeMcpUserAgent(value: unknown): string {
  const match =
    typeof value === "string"
      ? value.match(/^postwave-mcp-server\/([A-Za-z0-9._+-]{1,64})$/u)
      : null;
  return match ? "postwave-mcp-server/" + match[1] : "Suppressed";
}

/**
 * Minimise an execution row before it becomes retained React state. Raw query
 * and JSON scalar values plus remote IPs are unnecessary for the UI and are
 * removed at the response boundary, not merely hidden during render.
 */
export function projectSafeMcpExecution(execution: MCPExecution): MCPExecution {
  const request = redactMcpRequestDetails(execution);
  const dryRunAsserted =
    execution.dryRunAsserted === true || execution.dryRun === true;
  return {
    ...execution,
    method: safeMcpMethod(execution.method),
    path: safeMcpPath(execution.path),
    queryString: request.query || undefined,
    toolName: execution.toolName
      ? safeMcpToolName(execution.toolName)
      : undefined,
    userAgent: execution.userAgent
      ? safeMcpUserAgent(execution.userAgent)
      : undefined,
    remoteIp: undefined,
    errorCode: execution.errorCode
      ? safeMcpDiagnostic(execution.errorCode)
      : undefined,
    requestBody: request.body ?? undefined,
    dryRun: undefined,
    dryRunAsserted,
  };
}
