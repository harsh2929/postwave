import type { RemoteFailure } from "../../lib/remote-resource";

export type McpHistoryWindow = "24h" | "7d" | "30d";
export type McpHistorySource = "mcp" | "all";

export const MCP_WINDOW_HOURS: Record<McpHistoryWindow, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

export function mcpWindowSinceISO(window: McpHistoryWindow): string {
  return new Date(
    Date.now() - MCP_WINDOW_HOURS[window] * 3_600_000,
  ).toISOString();
}

function parsedTimestamp(value: string | undefined | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function formatMcpRelativeTime(
  value: string | undefined | null,
): string {
  const parsed = parsedTimestamp(value);
  if (!parsed) return value ? "Invalid timestamp" : "Not recorded";
  const seconds = Math.round((Date.now() - parsed.getTime()) / 1000);
  const future = seconds < 0;
  const absolute = Math.abs(seconds);
  let amount: number;
  let unit: string;
  if (absolute < 60) {
    amount = absolute;
    unit = "second";
  } else if (absolute < 3_600) {
    amount = Math.floor(absolute / 60);
    unit = "minute";
  } else if (absolute < 86_400) {
    amount = Math.floor(absolute / 3_600);
    unit = "hour";
  } else {
    amount = Math.floor(absolute / 86_400);
    unit = "day";
  }
  const quantity = String(amount) + " " + unit + (amount === 1 ? "" : "s");
  return future ? "in " + quantity : quantity + " ago";
}

export function formatMcpAbsoluteTime(
  value: string | undefined | null,
): string {
  const parsed = parsedTimestamp(value);
  if (!parsed) return value ? "Invalid timestamp" : "Not recorded";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
}

export function formatMcpPercent(value: number): string {
  if (!Number.isFinite(value)) return "Not available";
  return (value * 100).toFixed(1) + "%";
}

export function formatMcpLatency(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0)
    return "Not available";
  if (milliseconds < 1) return "<1 ms";
  if (milliseconds < 1_000) return String(Math.round(milliseconds)) + " ms";
  return (milliseconds / 1_000).toFixed(2) + " s";
}

/** Keep the unit visible for sub-cent values; these are estimates, not bills. */
export function formatMcpMicrosUsd(micros: number): string {
  if (!Number.isFinite(micros) || micros < 0) return "Not available";
  if (micros === 0) return "$0.00 USD";
  const dollars = micros / 1_000_000;
  if (dollars >= 1) return "$" + dollars.toFixed(2) + " USD";
  if (dollars >= 0.01) return "$" + dollars.toFixed(3) + " USD";
  return Math.round(micros).toLocaleString() + " micro-USD";
}

export function mcpStatusBadge(code: number): {
  label: string;
  tone: "success" | "neutral" | "warning" | "danger";
} {
  if (code >= 200 && code < 300)
    return { label: String(code), tone: "success" };
  if (code >= 300 && code < 400)
    return { label: String(code), tone: "neutral" };
  if (code >= 400 && code < 500)
    return { label: String(code), tone: "warning" };
  return {
    label: Number.isInteger(code) ? String(code) : "Invalid",
    tone: "danger",
  };
}

export function mcpStatusClassLabel(statusClass: number): string {
  if (statusClass === 2) return "2xx success";
  if (statusClass === 3) return "3xx redirect";
  if (statusClass === 4) return "4xx client error";
  if (statusClass === 5) return "5xx server error";
  return String(statusClass) + "xx response";
}

export function mcpStatusClassColor(statusClass: number): string {
  if (statusClass === 2) return "var(--pw-success)";
  if (statusClass === 3) return "var(--pw-fg-muted)";
  if (statusClass === 4) return "var(--pw-warning)";
  return "var(--pw-danger)";
}

export function mcpFailureMessage(
  failure: RemoteFailure | null,
  fallback: string,
): string {
  if (!failure) return fallback;
  const message =
    failure.message === "The server could not verify this data."
      ? fallback
      : failure.message;
  return failure.requestId
    ? message + " Reference: " + failure.requestId + "."
    : message;
}
