/**
 * listInsightRows — pure parsers for the per-list insight reads that close
 * the desktop parity gaps on the mobile list detail:
 *
 *   GET /api/v1/lists/{id}/engagement-breakdown  (analytics.go:302)
 *       {list_id, window_days, opens, clicks, unsubs, complaints, bounces}
 *   GET /api/v1/lists/{id}/per-row-engagement    (analytics.go:362)
 *       {list_id, rows:[{id,email,opens,clicks,last_engaged_at?}]}
 *   GET /api/v1/lists/{id}/activity              (analytics.go:540)
 *       {list_id, events:[{at,kind,email?,detail?}]} — `events`, not the
 *       house `items`; reading the wrong key is a permanently-empty feed
 *       that looks like a quiet list, so the parser pins the real key.
 *   GET /api/v1/lists/{id}/suppressions          (member_suppressions.go)
 *       {items, total, page, per_page}
 *   GET /api/v1/lists/{id}/forms                 → {list_id, forms:[...]}
 *   GET /api/v1/lists/{id}/automations           → {list_id, automations:[...]}
 *
 * All are viewer reads (read:subscribers). react-native-free so node vitest
 * covers every shape decision.
 */

// ── engagement breakdown ────────────────────────────────────────────────────

export interface ListEngagementBreakdown {
  windowDays: number;
  opens: number;
  clicks: number;
  unsubs: number;
  complaints: number;
  bounces: number;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseListEngagement(res: unknown): ListEngagementBreakdown {
  const row = (res ?? {}) as Record<string, unknown>;
  return {
    windowDays: num(row.window_days) || 30,
    opens: num(row.opens),
    clicks: num(row.clicks),
    unsubs: num(row.unsubs),
    complaints: num(row.complaints),
    bounces: num(row.bounces),
  };
}

// ── per-row engagement ──────────────────────────────────────────────────────

/** Server cap on subscriber_ids per request (analytics.go maxIDs). */
export const PER_ROW_ENGAGEMENT_MAX_IDS = 500;

export interface MemberEngagementRow {
  id: string;
  email: string;
  opens: number;
  clicks: number;
  lastEngagedAt: string | null;
}

export function parsePerRowEngagement(res: unknown): MemberEngagementRow[] {
  const row = (res ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(row.rows) ? row.rows : [];
  const out: MemberEngagementRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.email !== "string") continue;
    out.push({
      id: r.id == null ? r.email : String(r.id),
      email: r.email,
      opens: num(r.opens),
      clicks: num(r.clicks),
      lastEngagedAt:
        typeof r.last_engaged_at === "string" && r.last_engaged_at
          ? r.last_engaged_at
          : null,
    });
  }
  return out;
}

/**
 * Ids the check button may send: deduped, capped at the server's limit so the
 * request can never 400 on `too_many_ids`. Returns the ids AND whether the
 * cap trimmed anything, so the card can say "first 500 loaded members" when
 * it did — a trimmed check silently presented as complete is a wrong number.
 */
export function engagementCheckIds(
  ids: readonly (string | null | undefined)[],
): { ids: string[]; capped: boolean } {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && id.trim()) seen.add(id.trim());
  }
  const all = [...seen];
  return {
    ids: all.slice(0, PER_ROW_ENGAGEMENT_MAX_IDS),
    capped: all.length > PER_ROW_ENGAGEMENT_MAX_IDS,
  };
}

// ── activity feed ───────────────────────────────────────────────────────────

export interface ListActivityEvent {
  at: string;
  kind: string;
  email: string;
  /** e.g. a suppression reason. Best-effort; empty when absent. */
  detail: string;
}

/**
 * Human vocabulary for the server's kind strings. `suppression_*` kinds are
 * compound ("suppression_add"); unknown kinds fall through verbatim rather
 * than being hidden — an unlabelled event beats a silently dropped one.
 */
export function listActivityKindLabel(kind: string): string {
  if (kind === "subscribed") return "Subscribed";
  if (kind === "unsubscribed") return "Unsubscribed";
  if (kind.startsWith("suppression_")) {
    const action = kind.slice("suppression_".length).replaceAll("_", " ");
    return `Suppression ${action}`.trim();
  }
  return kind.replaceAll("_", " ");
}

export function parseListActivity(res: unknown): ListActivityEvent[] {
  // The handler writes {list_id, events}. A bare array is accepted too so a
  // future de-enveloping cannot silently blank the feed.
  const envelope = res as
    | { events?: unknown[]; items?: unknown[] }
    | null
    | undefined;
  const rows = Array.isArray(envelope?.events)
    ? envelope.events
    : Array.isArray(res)
      ? res
      : Array.isArray(envelope?.items)
        ? envelope.items
        : [];
  const out: ListActivityEvent[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.at !== "string" || !r.at) continue;
    const detail =
      r.detail && typeof r.detail === "object"
        ? Object.values(r.detail as Record<string, unknown>)
            .filter((v): v is string => typeof v === "string" && !!v)
            .join(" · ")
        : "";
    out.push({ at: r.at, kind: str(r.kind), email: str(r.email), detail });
  }
  return out;
}

// ── cross-references (suppressions / forms / automations) ──────────────────

export interface ListCrossRefItem {
  id: string;
  name: string;
  status: string;
}

export interface ListCrossRefs {
  /** From the suppressions page envelope's `total` — list-scoped, active. */
  suppressedTotal: number;
  forms: ListCrossRefItem[];
  automations: ListCrossRefItem[];
}

export function parseListSuppressedTotal(res: unknown): number {
  const row = (res ?? {}) as Record<string, unknown>;
  return num(row.total);
}

function crossRefItems(rows: unknown): ListCrossRefItem[] {
  if (!Array.isArray(rows)) return [];
  const out: ListCrossRefItem[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (r.id == null) continue;
    out.push({
      id: String(r.id),
      name: str(r.name) || String(r.id),
      status: str(r.status),
    });
  }
  return out;
}

export function parseListForms(res: unknown): ListCrossRefItem[] {
  return crossRefItems((res as { forms?: unknown } | null | undefined)?.forms);
}

export function parseListAutomations(res: unknown): ListCrossRefItem[] {
  return crossRefItems(
    (res as { automations?: unknown } | null | undefined)?.automations,
  );
}
