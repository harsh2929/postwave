/**
 * dashboard-sections — pure ordering logic for the Dashboard's
 * customisable layout ("Edit layout" mode).
 *
 * The /api/v1/dashboard/layout endpoint stores ONE flat `order: string[]`
 * per user (1..16 keys, each ≤64 chars). Two groups share that list:
 *
 *   • stat-card keys      — "subs" | "opens" | "clicks" | "bounces"
 *     (drag-reordered inside DashboardStatGrid, shipped earlier)
 *   • section keys        — the main card sections BELOW the stat grid
 *     (this module; reordered via Edit-layout up/down buttons)
 *
 * Participating sections (everything on the Dashboard page except the
 * toolbar, error notice, onboarding checklist and the stat grid, which
 * stays pinned at the top with its own per-tile ordering):
 *
 *   forecast      — ForecastStrip (subscriber forecast)
 *   anomalies     — AnomalyHistoryCard (recent anomalies)
 *   goals         — GoalsCard (goals & pacing)
 *   benchmarks    — BenchmarksCard (industry comparison)
 *   engagement    — RecentCampaignsCard + AuditFeedCard grid
 *   parity        — MailchimpParityCard
 *   inbox-health  — InboxHealthCard
 *   clv           — CLVDashboard (predicted customer-value distribution)
 *
 * Resolution rules (same contract as the stat grid's): unknown saved
 * keys are skipped, known-but-missing keys are appended in default
 * order — so a saved layout from an older build never drops a card,
 * and new cards added later appear at the end.
 *
 * Tested in src/__tests__/components/dashboard-sections.test.ts.
 */

export const STAT_CARD_KEYS = [
  "subs",
  "opens",
  "clicks",
  "bounces",
] as const;

export interface DashboardSectionDef {
  key: string;
  /** Human label shown on the Edit-layout frame. */
  label: string;
}

export const DASHBOARD_SECTIONS: readonly DashboardSectionDef[] = [
  { key: "forecast", label: "Subscriber forecast" },
  { key: "anomalies", label: "Recent anomalies" },
  { key: "goals", label: "Goals & pacing" },
  { key: "benchmarks", label: "How you stack up" },
  { key: "engagement", label: "Recent campaigns & audit feed" },
  { key: "parity", label: "Mailchimp parity" },
  { key: "inbox-health", label: "Inbox health" },
  // SUB-127 — predicted customer-value (CLV) distribution.
  { key: "clv", label: "Predicted customer value" },
];

export const DEFAULT_SECTION_ORDER: readonly string[] =
  DASHBOARD_SECTIONS.map((s) => s.key);

function resolveGroup(
  saved: readonly string[] | null | undefined,
  defaults: readonly string[],
): string[] {
  const known = new Set(defaults);
  const out: string[] = [];
  for (const k of saved ?? []) {
    if (known.has(k) && !out.includes(k)) out.push(k);
  }
  for (const k of defaults) {
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** Section keys in render order, derived from the (mixed) saved layout. */
export function resolveSectionOrder(
  saved: readonly string[] | null | undefined,
): string[] {
  return resolveGroup(saved, DEFAULT_SECTION_ORDER);
}

/** Stat-card keys in render order (mirror of the StatGrid's resolver). */
export function resolveStatOrder(
  saved: readonly string[] | null | undefined,
): string[] {
  return resolveGroup(saved, STAT_CARD_KEYS);
}

/**
 * Move `key` one slot up (-1) or down (+1) within `order`.
 * Returns null when the move is a no-op (unknown key / already at edge)
 * so callers can skip the save round-trip.
 */
export function moveKey(
  order: readonly string[],
  key: string,
  dir: -1 | 1,
): string[] | null {
  const from = order.indexOf(key);
  if (from < 0) return null;
  const to = from + dir;
  if (to < 0 || to >= order.length) return null;
  const next = [...order];
  const tmp = next[to]!;
  next[to] = next[from]!;
  next[from] = tmp;
  return next;
}

/**
 * Build the full persisted order from the saved layout plus an updated
 * group. Stat keys always serialise first, then section keys — both
 * groups keep their resolved order when not being replaced. Output is
 * always ≤ 12 keys, well inside the server's 1..16 bound.
 */
export function mergeLayoutOrder(
  saved: readonly string[] | null | undefined,
  next: { stats?: readonly string[]; sections?: readonly string[] },
): string[] {
  const stats = next.stats
    ? resolveGroup(next.stats, STAT_CARD_KEYS)
    : resolveStatOrder(saved);
  const sections = next.sections
    ? resolveGroup(next.sections, DEFAULT_SECTION_ORDER)
    : resolveSectionOrder(saved);
  return [...stats, ...sections];
}
