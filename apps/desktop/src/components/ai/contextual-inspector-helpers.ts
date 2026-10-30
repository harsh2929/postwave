/** Safe, bounded presentation helpers owned by the Moosewave AI inspector. */

export type InspectorFailureAction =
  | "brand-load"
  | "brand-save"
  | "profile-load"
  | "profile-mutate"
  | "templates-load"
  | "executions-load";

interface ErrorShape {
  status?: unknown;
  code?: unknown;
  kind?: unknown;
}

const ACTION_FAILURE: Record<InspectorFailureAction, string> = {
  "brand-load": "The brand-voice profile couldn't be loaded. Retry when ready.",
  "brand-save":
    "The brand-voice profile couldn't be saved. Your edits are still here.",
  "profile-load": "Voice-profile data couldn't be loaded. Retry when ready.",
  "profile-mutate":
    "The voice-profile change couldn't be completed. Refresh and retry.",
  "templates-load": "Voice templates couldn't be loaded. Retry when ready.",
  "executions-load":
    "Recent agent activity couldn't be loaded. Retry when ready.",
};

function shapeOf(error: unknown): ErrorShape {
  return error && typeof error === "object" ? (error as ErrorShape) : {};
}

function token(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Convert transport/server failures into stable operator copy. Raw messages
 * are intentionally ignored because they can contain tenant input, upstream
 * responses, request paths, or implementation details.
 */
export function inspectorFailureMessage(
  error: unknown,
  action: InspectorFailureAction,
): string {
  const shape = shapeOf(error);
  const status = typeof shape.status === "number" ? shape.status : undefined;
  const code = token(shape.code);
  const kind = token(shape.kind);

  if (status === 401 || code === "unauthorized") {
    return "Your session is no longer authorized. Sign in again and retry.";
  }
  if (
    status === 403 ||
    ["forbidden", "permission_denied", "insufficient_scope"].includes(code)
  ) {
    return action === "executions-load"
      ? "Your current role can't view MCP execution activity."
      : action === "brand-save" || action === "profile-mutate"
        ? "Your current role can't make this change."
        : "Your current role can't view this data.";
  }
  if (kind === "network" || kind === "offline") {
    return "The service couldn't be reached. Check the connection and retry.";
  }
  if (kind === "timeout") {
    return "The service didn't respond in time. Retry when ready.";
  }
  if (kind === "parse") {
    return "The server returned data this app couldn't verify. Refresh and retry.";
  }
  if (kind === "invalid_config") {
    return "This service isn't configured for the current environment.";
  }
  if (status === 429) {
    return "This operation is temporarily rate-limited. Wait a moment and retry.";
  }
  if (status !== undefined && status >= 500) {
    return "The service couldn't complete the request. Retry when ready.";
  }
  return ACTION_FAILURE[action];
}

/** Plain display text with control characters removed and a hard UI bound. */
export function boundedDisplayText(
  value: unknown,
  maximum: number,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (!normalized) return null;
  const characters = Array.from(normalized);
  if (characters.length <= maximum) return normalized;
  return `${characters.slice(0, Math.max(1, maximum - 1)).join("")}…`;
}

export function safeDateTime(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getFullYear() <= 1970) return null;
  return date.toLocaleString();
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
