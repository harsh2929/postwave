/**
 * lib/inactiveKeyAlerts.ts — the pure half of the API-keys screen's
 * inactive-key alert card (parity P2.55).
 *
 * Desktop renders InactiveKeysCard (apps/desktop/src/components/settings/
 * InactiveKeysCard.tsx) from GET /api/v1/inactive-keys; mobile read no
 * /inactive-keys path at all, so a dormant credential — the exact thing a
 * quarterly audit, or a 2am "did that contractor's key ever get used" worry,
 * is about — was invisible on the phone that is most likely to be in hand
 * when the worry strikes.
 *
 * WIRE SHAPE, read off the Go handler (apps/api/internal/inactive_keys/
 * inactive_keys.go:147):
 *
 *   { threshold_days: number,
 *     keys: [{ id, label, prefix, actor_type, created_at, last_used_at?,
 *              days_since_last_use, never_used, severity }],
 *     count: number }
 *
 * `severity` is the SERVER'S word — 'warn' | 'high' | 'critical' — and
 * `days_since_last_use` / `never_used` are the server's numbers. Nothing
 * here derives a day count or a severity of its own: a row the server did
 * not describe completely is dropped rather than described with a number
 * this file made up.
 *
 * NEVER ITERATE WHAT IS NOT PROVEN TO BE AN ARRAY (nullishArrayGuard.test):
 * `keys` is checked with Array.isArray, so a `null`, an omitempty sibling, a
 * paged `{items}` envelope, a bare array or an HTML fallback page all become
 * "nothing to show" rather than a crash in the one card that exists to
 * flag a security problem.
 *
 * Import-free so it runs under node vitest.
 */

export interface InactiveKeyAlert {
  id: string;
  label: string;
  /** Non-secret prefix — the only part of the key the server ever shows again. */
  prefix: string;
  /** "human" | "agent" — an agent key is a machine principal. */
  actorType: string;
  createdAt: string;
  lastUsedAt?: string | undefined;
  /** Server-computed; days since last use, or since creation when never used. */
  daysSinceLastUse: number;
  neverUsed: boolean;
  /**
   * Server vocabulary, rendered verbatim: 'warn' | 'high' | 'critical'. An
   * unknown word is kept, not corrected — the badge shows what the server said.
   */
  severity: string;
}

export interface InactiveKeysPayload {
  /** The threshold the server applied; null when the body did not carry one. */
  thresholdDays: number | null;
  keys: InactiveKeyAlert[];
}

/** Desktop's section title, verbatim. */
export const INACTIVE_KEYS_TITLE = "Inactive API keys";

/** Desktop's section description, verbatim. */
export const INACTIVE_KEYS_DESCRIPTION =
  "Keys that haven't authenticated a request recently. Unused keys widen your attack surface — revoke what you don't need.";

/** What a 403 means here: the route is owner/admin-only on the server. */
export const INACTIVE_KEYS_DENIED_COPY =
  "Checking key activity needs an owner or admin session.";

/**
 * A failed read of the inactive-keys route. Lives in lib (not api) so the
 * view mapping below can classify a 403 without importing the transport,
 * which would drag react-native into the node-run test graph.
 */
export class InactiveKeysError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message || "Couldn't check key activity.");
    this.name = "InactiveKeysError";
    this.status = status;
  }
}

/** True when the server refused the session — a permission rule, not a fault. */
export function isInactiveKeysDenied(err: unknown): boolean {
  return err instanceof InactiveKeysError && err.status === 403;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * One wire row → one alert, or null when the server did not describe it
 * completely. A row needs an id, a finite day count and a severity word:
 * without the first it cannot be keyed, and without either of the others the
 * card would have to print a number or a badge the server never sent.
 */
export function normalizeInactiveKey(entry: unknown): InactiveKeyAlert | null {
  if (!isRecord(entry)) return null;
  const id = str(entry.id);
  if (!id) return null;
  const days = entry.days_since_last_use;
  if (typeof days !== "number" || !Number.isFinite(days) || days < 0) {
    return null;
  }
  const severity = str(entry.severity).trim();
  if (!severity) return null;
  const lastUsedAt = optionalStr(entry.last_used_at);
  return {
    id,
    label: str(entry.label),
    prefix: str(entry.prefix),
    actorType: str(entry.actor_type) || "human",
    createdAt: str(entry.created_at),
    ...(lastUsedAt ? { lastUsedAt } : {}),
    daysSinceLastUse: Math.trunc(days),
    neverUsed: entry.never_used === true,
    severity,
  };
}

/**
 * `{threshold_days, keys, count}` → the payload the card reads, or null when
 * the body is not that object at all (a bare array, a string, an HTML page, a
 * paged `{items}` envelope with no `keys` member, `undefined` before the first
 * fetch). The handler always writes `keys`, so its absence means this is not
 * the handler's answer. A `keys` that is present but anything other than an
 * array — `null` included — reads as an empty list; the card then has nothing
 * to show, which is silence, not a claim.
 */
export function parseInactiveKeysPayload(raw: unknown): InactiveKeysPayload | null {
  if (!isRecord(raw) || !("keys" in raw)) return null;
  const rows = Array.isArray(raw.keys) ? raw.keys : [];
  const keys: InactiveKeyAlert[] = [];
  for (const row of rows) {
    const alert = normalizeInactiveKey(row);
    if (alert) keys.push(alert);
  }
  const threshold = raw.threshold_days;
  const thresholdDays =
    typeof threshold === "number" && Number.isFinite(threshold) && threshold > 0
      ? Math.trunc(threshold)
      : null;
  return { thresholdDays, keys };
}

/** Badge tone per server-assigned severity (desktop's inactiveKeySeverityTone). */
export function inactiveKeySeverityTone(
  severity: string,
): "danger" | "warning" | "neutral" {
  switch (severity) {
    case "critical":
      return "danger";
    case "high":
    case "warn":
      return "warning";
    default:
      return "neutral";
  }
}

/** Honest per-key line, desktop verbatim: never-used vs gone-quiet. */
export function inactiveKeyCopy(
  k: Pick<InactiveKeyAlert, "neverUsed" | "daysSinceLastUse">,
): string {
  if (k.neverUsed) return "never used since creation";
  const d = k.daysSinceLastUse;
  return `unused for ${d} day${d === 1 ? "" : "s"}`;
}

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  warn: 2,
};

/** Critical first, then by idle days descending; id last so the order is total. */
export function sortInactiveKeys(keys: readonly InactiveKeyAlert[]): InactiveKeyAlert[] {
  return [...keys].sort((a, b) => {
    const ra = SEVERITY_RANK[a.severity] ?? 3;
    const rb = SEVERITY_RANK[b.severity] ?? 3;
    if (ra !== rb) return ra - rb;
    if (a.daysSinceLastUse !== b.daysSinceLastUse) {
      return b.daysSinceLastUse - a.daysSinceLastUse;
    }
    return a.id.localeCompare(b.id);
  });
}

/**
 * Card headline, desktop verbatim when the threshold is known. Without a
 * threshold the sentence says only what the server said — that these keys
 * were flagged — rather than filling the blank with a default.
 */
export function inactiveKeysHeadline(
  count: number,
  thresholdDays: number | null,
): string {
  const keys = `${count} API key${count === 1 ? "" : "s"}`;
  if (thresholdDays === null) return `${keys} flagged as inactive.`;
  return `${keys} unused for ${thresholdDays}+ days.`;
}

/** Why the card is rendering nothing. Each is a state, not an accident. */
export type InactiveKeysHiddenReason =
  | "role"
  | "loading"
  | "offline"
  | "clean"
  | "unreadable";

export type InactiveKeysCardView =
  | { kind: "hidden"; reason: InactiveKeysHiddenReason }
  | { kind: "error"; denied: boolean; message: string }
  | {
      kind: "alerts";
      headline: string;
      thresholdDays: number | null;
      keys: InactiveKeyAlert[];
    };

export interface InactiveKeysCardInput {
  /** The session may read the route (owner/admin). */
  mayRead: boolean;
  /** The online gate: false when the query cannot run at all. */
  online: boolean;
  isError: boolean;
  error: unknown;
  /** The query's data, UNTRUSTED: a restored cache or a test harness can hand
   * the card any shape, so this is re-validated rather than typed through. */
  data: unknown;
}

function failureCopy(error: unknown): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message
    ? `Couldn't check key activity: ${message}`
    : "Couldn't check key activity.";
}

/**
 * The whole card decision in one place. The precedence is deliberate:
 *
 *   1. below admin → hidden (the host screen is admin-gated; a viewer never
 *      reaches it, and a card that 403s is worse than no card);
 *   2. a failed read → an error line, so a broken check can never look like
 *      "nothing to worry about" — a 403 reads as the permission rule it is;
 *   3. no readable payload → hidden (loading, offline, or a shape that was
 *      never proven to be the server's object);
 *   4. zero alerts → hidden. An all-clear card trains people to skip the
 *      region where the real warning will eventually appear;
 *   5. otherwise the alerts, sorted most-urgent first.
 */
export function inactiveKeysCardView(
  input: InactiveKeysCardInput,
): InactiveKeysCardView {
  if (!input.mayRead) return { kind: "hidden", reason: "role" };
  if (input.isError) {
    const denied = isInactiveKeysDenied(input.error);
    return {
      kind: "error",
      denied,
      message: denied ? INACTIVE_KEYS_DENIED_COPY : failureCopy(input.error),
    };
  }
  const payload = parseInactiveKeysPayload(input.data);
  if (payload === null) {
    if (input.data === undefined) {
      return { kind: "hidden", reason: input.online ? "loading" : "offline" };
    }
    return { kind: "hidden", reason: "unreadable" };
  }
  if (payload.keys.length === 0) return { kind: "hidden", reason: "clean" };
  return {
    kind: "alerts",
    headline: inactiveKeysHeadline(payload.keys.length, payload.thresholdDays),
    thresholdDays: payload.thresholdDays,
    keys: sortInactiveKeys(payload.keys),
  };
}
