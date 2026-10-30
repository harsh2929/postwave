/**
 * template-leaderboard — pure logic for the Templates page
 * "Performance" section (analyticsExtrasApi.templateLeaderboard).
 *
 * Backend contract (apps/api/internal/analytics/template_leaderboard.go):
 *
 *   GET /api/v1/analytics/template-leaderboard?days=N → {items}
 *   - default window 90 days, rows ranked by sends, capped at top 50;
 *   - open_rate / click_rate are 0..1 FRACTIONS (rounded to 4dp
 *     server-side) — multiply by 100 exactly once when rendering,
 *     consistent with this branch's rate convention (SubjectLab PCT,
 *     subject-analyzer formatRate);
 *   - attribution: campaigns use source_template_id as their canonical
 *     lineage. Older campaigns without that value may use the explicitly
 *     labelled delivery-settings / exact-subject fallback. Campaigns
 *     matching no template are absent — hence the honest caveat below.
 *
 * Lives in a .ts module (not the .tsx section) so the node-environment
 * vitest suite can exercise it without a JSX transform.
 */

/** The two windows the UI offers. 90 mirrors the server default. */
export const LEADERBOARD_WINDOWS = [30, 90] as const;
export type LeaderboardWindow = (typeof LEADERBOARD_WINDOWS)[number];

export interface VerifiedTemplateLeaderboardItem {
  template_id: string;
  template_name: string;
  campaigns_used: number;
  sent: number;
  opens: number;
  clicks: number;
  open_rate: number;
  click_rate: number;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Fail closed when a successful response does not match the wire contract. */
export function decodeTemplateLeaderboard(
  value: unknown,
): VerifiedTemplateLeaderboardItem[] | null {
  if (!value || typeof value !== "object") return null;
  const items = (value as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;

  const verified: VerifiedTemplateLeaderboardItem[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") return null;
    const row = item as Record<string, unknown>;
    if (
      typeof row.template_id !== "string" ||
      row.template_id.trim() === "" ||
      typeof row.template_name !== "string" ||
      row.template_name.trim() === "" ||
      !isNonNegativeFiniteNumber(row.campaigns_used) ||
      !isNonNegativeFiniteNumber(row.sent) ||
      !isNonNegativeFiniteNumber(row.opens) ||
      !isNonNegativeFiniteNumber(row.clicks) ||
      !isNonNegativeFiniteNumber(row.open_rate) ||
      row.open_rate > 1 ||
      !isNonNegativeFiniteNumber(row.click_rate) ||
      row.click_rate > 1
    ) {
      return null;
    }

    verified.push({
      template_id: row.template_id,
      template_name: row.template_name,
      campaigns_used: row.campaigns_used,
      sent: row.sent,
      opens: row.opens,
      clicks: row.clicks,
      open_rate: row.open_rate,
      click_rate: row.click_rate,
    });
  }
  return verified;
}

/**
 * Formats a 0..1 fraction as a percentage with one decimal —
 * `0.4321 → "43.2%"`. The ×100 happens HERE and nowhere else.
 * Non-finite input (defensive against a malformed row) renders "—".
 */
export function formatLeaderboardRate(rate: number): string {
  if (!Number.isFinite(rate)) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

/** Locale-grouped integer; non-finite renders "0". */
export function formatLeaderboardCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return Math.trunc(n).toLocaleString();
}

/**
 * Attribution caveat — rendered as muted copy whenever the table (or
 * its empty state) shows, so operators know WHY a heavily-used
 * template can be missing. Canonical lineage is preferred; the bounded
 * legacy fallback exists only for older campaigns without lineage.
 */
export const LEADERBOARD_ATTRIBUTION_CAVEAT =
  "Current campaigns use their recorded source-template lineage. Older " +
  "campaigns without lineage may use a legacy stored-template or exact-subject " +
  "match, so edited legacy campaigns can be absent.";

/** Honest empty-state copy — no attributable sends ≠ no template usage. */
export function leaderboardEmptyCopy(days: LeaderboardWindow): string {
  return (
    `No attributable template sends in the last ${days} days. ` +
    "This appears once campaigns created from templates have delivery " +
    "events inside the window."
  );
}
