/**
 * engagement-helpers — pure logic behind the Surfacing Analytics
 * engagement panel (#3; backed by apps/api/internal/analytics/engagement.go).
 * JSX-free so the node vitest suite can exercise the inflation-delta
 * formatting, AI-surfacing bucketing, and the human-row gate directly.
 *
 * Honest-UI contract: nothing here invents data. The inflation delta is
 * computed only from the two real rates the API returned and is clamped
 * to never report a negative ("human higher than raw") inflation, which
 * would be nonsensical. The AI-surfacing label is a coarse bucket of the
 * real estimate — it never upgrades a low score into a flattering word.
 */

/** The EngagementPanel wire shape — mirrors api-client.ts::EngagementPanel.
 *  Re-declared structurally (Pick of the fields these helpers read) so the
 *  helpers stay importable without a circular dependency on api-client. */
export interface EngagementPanelLike {
  human_unique_opens: number;
  bot_signatures_applied: string[];
}

/**
 * Format the bot-inflation delta between the raw and human(-stripped)
 * open rates as a percentage-point string, e.g. "−3.2pp bot inflation".
 *
 * Both inputs are fractions in [0,1] (the wire shape). The delta is
 * raw − human in percentage points. Inflation can only be non-negative
 * (bots add opens), so when human ≥ raw — equal rates, or a glitch where
 * the stripped rate came out higher — we clamp to "0.0pp" rather than
 * print a misleading negative. Non-finite inputs read as 0.
 */
export function formatInflationDelta(
  rawRate: number | null | undefined,
  humanRate: number | null | undefined,
): string {
  const raw = finite(rawRate);
  const human = finite(humanRate);
  const deltaPp = (raw - human) * 100;
  if (deltaPp <= 0) return "0.0pp";
  // Unicode minus is for negative; inflation is positive, so no sign
  // prefix — "3.2pp bot inflation" reads as "raw is 3.2pp higher".
  return `${deltaPp.toFixed(1)}pp bot inflation`;
}

/**
 * Coarse bucket label for the AI-surfacing estimate score (a fraction in
 * [0,1]). Buckets: < 0.4 → "Low", < 0.7 → "Moderate", else "High".
 * Non-finite / missing scores read as "Low" (the honest floor — we never
 * upgrade an unknown into a flattering bucket).
 */
export function aiSurfacingLabel(
  score: number | null | undefined,
): "Low" | "Moderate" | "High" {
  const s = finite(score);
  if (s < 0.4) return "Low";
  if (s < 0.7) return "Moderate";
  return "High";
}

/**
 * Whether to render the bot-stripped "Human open rate" row. True only
 * when there is genuine bot-filtering signal: at least one human unique
 * open OR at least one bot signature actually fired. When false (e.g.
 * POSTWAVE_HUMAN_ENGAGEMENT off, or no signatures matched), the caller
 * shows the raw rate plus the D4 "bot filtering not enabled" disclosure
 * note instead of a hidden, silently-raw "Human" row.
 */
export function shouldShowHumanRow(
  panel: EngagementPanelLike | null | undefined,
): boolean {
  if (!panel) return false;
  const opens =
    typeof panel.human_unique_opens === "number" &&
    Number.isFinite(panel.human_unique_opens)
      ? panel.human_unique_opens
      : 0;
  const sigs = Array.isArray(panel.bot_signatures_applied)
    ? panel.bot_signatures_applied
    : [];
  return opens > 0 || sigs.length > 0;
}

/** Coerce a possibly-missing/NaN number to a finite value (0 fallback). */
function finite(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

/* ------- SUB-094 90-day engagement bucketing ----------------------
 *
 * Buckets a flat list of subscriber activity events into per-day
 * open + click counts over the trailing 90-day window. Pure logic,
 * extracted from SubscriberDetailSlideover so the dual-line
 * EngagementSparkline chart (charts/EngagementSparkline.tsx) and the
 * node vitest suite can both exercise it without JSX. Honest-UI: an
 * empty / absent event list yields an empty series (the chart then
 * renders its "no events" placeholder) — it never fabricates days.
 * ---------------------------------------------------------------- */

/** One day's bucketed engagement, keyed by ISO `YYYY-MM-DD`. */
export interface EngagementSparklinePoint {
  date: string;
  opens: number;
  clicks: number;
}

/** Structural slice of SubscriberActivity these helpers read. Declared
 *  locally (not imported from api-client) so engagement-helpers stays
 *  import-free and the node vitest suite can construct fixtures inline. */
export interface EngagementEventLike {
  /** e.g. "opened" | "open" | "clicked" | "click" | "sent" | … */
  type: string;
  /** ISO timestamp of the event. */
  at: string;
}

/** Number of trailing days the engagement sparkline covers. */
export const ENGAGEMENT_HORIZON_DAYS = 90;

/**
 * Bucket a flat activity list into one [date, opens, clicks] point per
 * day across the last ENGAGEMENT_HORIZON_DAYS (oldest → newest). Days
 * with no events are present with zero counts so the line spans the full
 * window. Events outside the window, or with an unparseable timestamp,
 * are skipped. Returns [] for an empty/absent list.
 */
export function bucketDailyEngagement(
  events: EngagementEventLike[] | null | undefined,
): EngagementSparklinePoint[] {
  if (!events || events.length === 0) return [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const map = new Map<string, { opens: number; clicks: number }>();
  for (let i = ENGAGEMENT_HORIZON_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    map.set(d.toISOString().slice(0, 10), { opens: 0, clicks: 0 });
  }
  for (const ev of events) {
    const t = new Date(ev.at);
    if (Number.isNaN(t.getTime())) continue;
    const key = t.toISOString().slice(0, 10);
    const slot = map.get(key);
    if (!slot) continue;
    if (ev.type === "opened" || ev.type === "open") slot.opens++;
    if (ev.type === "clicked" || ev.type === "click") slot.clicks++;
  }
  return Array.from(map.entries()).map(([date, v]) => ({
    date,
    opens: v.opens,
    clicks: v.clicks,
  }));
}
