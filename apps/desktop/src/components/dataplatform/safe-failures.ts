import {
  remoteFailureFromError,
  type RemoteApiError,
} from "../../lib/remote-resource";

type UnknownRecord = Record<string, unknown>;

function recordOf(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function safeToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  if (!token || token.length > 96) return undefined;
  return /^[A-Za-z0-9._:-]+$/.test(token) ? token : undefined;
}

function apiErrorOf(value: unknown): RemoteApiError {
  const record = recordOf(value);
  const status =
    typeof record?.status === "number" && Number.isFinite(record.status)
      ? record.status
      : undefined;
  const rawKind = safeToken(record?.kind);
  const kind = [
    "http",
    "network",
    "offline",
    "storage",
    "timeout",
    "parse",
    "invalid_config",
  ].includes(rawKind ?? "")
    ? (rawKind as RemoteApiError["kind"])
    : undefined;
  return {
    ...(status === undefined ? {} : { status }),
    ...(kind === undefined ? {} : { kind }),
    ...(safeToken(record?.code) ? { code: safeToken(record?.code) } : {}),
    ...(safeToken(record?.requestId)
      ? { requestId: safeToken(record?.requestId) }
      : {}),
  };
}

/**
 * Turn an untrusted transport/provider failure into bounded operator copy.
 * Raw messages may contain reflected data, queries, paths, or secret-adjacent
 * provider detail, so callers should never append them to this result.
 */
export function safeDataPlatformFailure(
  error: unknown,
  fallback: string,
): string {
  const source = apiErrorOf(error);
  const failure = remoteFailureFromError(source);
  let message = failure.message;

  if (source.status === 409) {
    message = "The server state changed. Refresh the data before retrying.";
  } else if (source.status === 422) {
    message = "The server rejected this input. Review the highlighted fields.";
  } else if (source.status === 429) {
    message =
      "The service is rate-limiting requests. Retry after its recovery window.";
  } else if (
    message === "The server could not verify this data." ||
    message === "The server could not complete the request."
  ) {
    message = fallback;
  }

  const reference = [failure.code, failure.requestId]
    .filter(Boolean)
    .join(" · ");
  return `${message}${reference ? ` Reference: ${reference}.` : ""}`;
}

/** Classify a persisted provider/worker string without rendering it. */
export function classifiedDataPlatformIssue(
  raw: unknown,
  fallback = "The operation reported a failure. Raw provider details are hidden.",
): string {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const value = raw.toLowerCase();
  if (/credential|auth|unauthor|forbid|\b401\b|\b403\b/.test(value)) {
    return "Provider authentication needs attention. Review the credentials reference.";
  }
  if (/timeout|deadline|timed out/.test(value)) {
    return "The provider did not respond before the operation deadline.";
  }
  if (/rate.?limit|\b429\b/.test(value)) {
    return "The provider rate-limited this operation. Retry after its recovery window.";
  }
  if (/network|connect|dns|resolve|unreachable/.test(value)) {
    return "The provider endpoint could not be reached.";
  }
  if (/schema|column|field|constraint|table|path/.test(value)) {
    return "The configured schema, field, or object scope needs attention.";
  }
  if (/invalid|parse|json|format|type|cast/.test(value)) {
    return "The operation could not process the supplied value or format.";
  }
  return fallback;
}
