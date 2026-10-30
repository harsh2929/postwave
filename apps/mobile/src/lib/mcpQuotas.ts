/**
 * lib/mcpQuotas.ts — per-tool daily quota observations, parsed and judged.
 *
 * WHAT THE PAYLOAD IS. `GET /api/v1/mcp/quotas` (apps/api/internal/apikeycalls/
 * quotas.go: `ListQuotasHandler`) answers a `QuotaResponse`
 * (apikeycalls.go:363-369): `{tenantId, quotas: ToolQuota[], enforcementMode,
 * authoritative, releaseHold}`. Each `ToolQuota` (apikeycalls.go:129-136) is
 * `{toolName, dailyLimit?, estimatedCostMicros, usedToday}`; `usedToday` is a
 * LEFT JOIN LATERAL count of `api_key_calls` since UTC midnight
 * (quotas.go:41-59), so it is a best-effort recorder tally, not a meter.
 *
 * FOUR SERVER FACTS THAT DECIDE HOW THIS CARD READS NUMBERS:
 *
 *  1. The handler hard-codes `EnforcementMode: "advisory_unverified"`,
 *     `Authoritative: false` and `ReleaseHold: QuotaMutationReleaseHoldCode`
 *     (quotas.go:201-207), and `LegacyHTTPQuotaEnforcementReleased = false`
 *     (apikeycalls.go:743) keeps `QuotaMiddleware` observation-only. A bar at
 *     100% therefore does NOT mean the next call is blocked. The card renders
 *     the server's own three words verbatim rather than translating them into
 *     a promise.
 *  2. `dailyLimit` is a nullable pointer — `nil` is an explicit row with no
 *     threshold. The desktop refuses to call that "unlimited" ("Absence does
 *     not establish an enforced unlimited policy"), and so does this module:
 *     `fraction` is null, the bar is empty, and the caption says "no
 *     configured threshold row".
 *  3. PUT/DELETE on this route answer 503 `mcp_quota_enforcement_release_held`
 *     (quotas.go:210-232). This module is read-only by design; nothing here
 *     builds a mutation.
 *  4. The response is tenant-bound "so a client can reject a well-formed
 *     response after a workspace switch" (apikeycalls.go:360-362). The parser
 *     takes the expected tenant and refuses a mismatch.
 *
 * Tone thresholds (70% warning, 90% danger) are the desktop's QuotasCard
 * (apps/desktop/src/pages/MCP.tsx:1730-1735), so the two surfaces never
 * disagree about which bar is red.
 *
 * DELIBERATELY IMPORT-FREE so it runs under the node vitest environment.
 */

export interface McpToolQuota {
  toolName: string;
  /** null = the row carries no daily threshold. Not "unlimited" — see fact 2. */
  dailyLimit: number | null;
  estimatedCostMicros: number;
  usedToday: number;
}

export interface McpQuotaSnapshot {
  tenantId: string;
  quotas: readonly McpToolQuota[];
  /** Server-authored, rendered verbatim: "advisory_unverified" today. */
  enforcementMode: string;
  /** Only ever true when the server literally said `true`. */
  authoritative: boolean;
  /** Server-authored hold code, rendered verbatim. */
  releaseHold: string;
}

export type McpQuotaParse =
  | { snapshot: McpQuotaSnapshot; error: null }
  | { snapshot: null; error: string };

export const MCP_QUOTAS_MALFORMED = "The quota response was malformed.";
export const MCP_QUOTAS_INVALID_ENTRY =
  "The quota response contained an invalid entry.";
export const MCP_QUOTAS_WRONG_WORKSPACE =
  "The quota response belongs to a different workspace.";

/** The server's own grammar for a tool label (apikeycalls.go:1049, 1078-1093). */
const TOOL_LABEL = /^[A-Za-z][A-Za-z0-9._:-]{0,95}$/u;
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu;

/** Same rule as the server's `safeToolLabel`: refuse UUID-ish and digit-heavy names. */
export function safeMcpQuotaToolName(value: unknown): string {
  if (typeof value !== "string") return "";
  const tool = value.trim();
  if (!TOOL_LABEL.test(tool) || UUID_LIKE.test(tool)) return "";
  let digits = 0;
  for (const char of tool) if (char >= "0" && char <= "9") digits += 1;
  return digits > tool.length / 2 ? "" : tool;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
    ? value
    : null;
}

function validQuota(value: unknown): McpToolQuota | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const toolName = safeMcpQuotaToolName(row.toolName);
  if (!toolName) return null;
  const usedToday = nonNegativeInt(row.usedToday);
  const estimatedCostMicros = nonNegativeInt(row.estimatedCostMicros);
  if (usedToday === null || estimatedCostMicros === null) return null;
  let dailyLimit: number | null = null;
  if (row.dailyLimit !== undefined && row.dailyLimit !== null) {
    // The server rejects a non-positive limit on write (quotas.go:89-91), so
    // one arriving on read means the payload is not what it claims to be.
    const limit = nonNegativeInt(row.dailyLimit);
    if (limit === null || limit < 1) return null;
    dailyLimit = limit;
  }
  return { toolName, dailyLimit, estimatedCostMicros, usedToday };
}

/**
 * The whole response is accepted or the whole response is refused — a partial
 * list that silently dropped a bad row would read as complete.
 */
export function normalizeMcpQuotas(
  raw: unknown,
  expectedTenantId: string | null,
): McpQuotaParse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { snapshot: null, error: MCP_QUOTAS_MALFORMED };
  }
  const body = raw as Record<string, unknown>;
  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  if (!tenantId || !Array.isArray(body.quotas)) {
    return { snapshot: null, error: MCP_QUOTAS_MALFORMED };
  }
  if (expectedTenantId && tenantId !== expectedTenantId) {
    return { snapshot: null, error: MCP_QUOTAS_WRONG_WORKSPACE };
  }
  const seen = new Set<string>();
  const quotas: McpToolQuota[] = [];
  for (const entry of body.quotas) {
    const quota = validQuota(entry);
    if (!quota || seen.has(quota.toolName)) {
      return { snapshot: null, error: MCP_QUOTAS_INVALID_ENTRY };
    }
    seen.add(quota.toolName);
    quotas.push(quota);
  }
  return {
    snapshot: {
      tenantId,
      quotas,
      enforcementMode:
        typeof body.enforcementMode === "string"
          ? body.enforcementMode.trim()
          : "",
      authoritative: body.authoritative === true,
      releaseHold:
        typeof body.releaseHold === "string" ? body.releaseHold.trim() : "",
    },
    error: null,
  };
}

export type McpQuotaTone = "success" | "warning" | "danger" | "neutral";

export interface McpQuotaReading {
  /** 0–1, clamped, for the bar; null when the row has no threshold. */
  fraction: number | null;
  /** Unclamped percentage; null when the row has no threshold. */
  utilization: number | null;
  tone: McpQuotaTone;
  remaining: number | null;
  overage: number;
  /** "12 used / 50 configured threshold" or "12 used · no configured threshold row". */
  headline: string;
  /** "24.0% · below configured threshold", or "" with no threshold. */
  standing: string;
  /** The distance sentence. Desktop wording, including its disclaimer. */
  distance: string;
}

const WARNING_AT = 70;
const DANGER_AT = 90;

function whole(value: number): string {
  return String(value);
}

export function mcpQuotaReading(quota: McpToolQuota): McpQuotaReading {
  const limit = quota.dailyLimit ?? 0;
  const utilization = limit > 0 ? (quota.usedToday / limit) * 100 : null;
  const fraction =
    utilization === null
      ? null
      : Math.min(1, Math.max(0, quota.usedToday / limit));
  const remaining = limit > 0 ? Math.max(0, limit - quota.usedToday) : null;
  const overage = limit > 0 ? Math.max(0, quota.usedToday - limit) : 0;
  const tone: McpQuotaTone =
    utilization === null
      ? "neutral"
      : utilization >= DANGER_AT
        ? "danger"
        : utilization >= WARNING_AT
          ? "warning"
          : "success";
  const headline =
    limit > 0
      ? `${whole(quota.usedToday)} used / ${whole(limit)} configured threshold`
      : `${whole(quota.usedToday)} used · no configured threshold row`;
  const standing =
    utilization === null
      ? ""
      : `${utilization.toFixed(1)}% · ${
          tone === "danger"
            ? "above or near threshold"
            : tone === "warning"
              ? "approaching threshold"
              : "below configured threshold"
        }`;
  const distance =
    overage > 0
      ? `${whole(overage)} observed calls above the configured threshold`
      : remaining === null
        ? "No daily threshold represented"
        : `${whole(remaining)} calls until the configured threshold (not an enforcement promise)`;
  return {
    fraction,
    utilization,
    tone,
    remaining,
    overage,
    headline,
    standing,
    distance,
  };
}

/** Next UTC midnight after `now`, as RFC3339 — the day the server counts from. */
export function mcpQuotaResetAt(now: number): string {
  const reset = new Date(now);
  reset.setUTCHours(24, 0, 0, 0);
  return reset.toISOString();
}

/** Recorder-configured per-call estimate in whole currency units. */
export function mcpQuotaCostUnits(micros: number): number {
  return micros / 1_000_000;
}

/** Desktop's summary sentence, verbatim. */
export function mcpQuotaSummary(count: number): string {
  return `${whole(count)} configured per-tool quota observations. Best-effort usage is counted from 00:00 UTC; cost values are configured estimates per call and are not billing receipts.`;
}

/**
 * The server's stance on its own numbers, in its own words. Every token here
 * is copied from the payload; an absent field is named as absent rather than
 * filled in.
 */
export function mcpQuotaServerStance(snapshot: McpQuotaSnapshot): string {
  return [
    `enforcement ${snapshot.enforcementMode || "unstated"}`,
    snapshot.authoritative ? "authoritative" : "not authoritative",
    `hold ${snapshot.releaseHold || "none stated"}`,
  ].join(" · ");
}
