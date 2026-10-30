/**
 * leaderboard-helpers — pure logic for the referral leaderboard card
 * (GET /api/v1/referrals/leaderboard, roadmap R12).
 *
 * Server contract (apps/api/internal/referrals/leaderboard.go):
 *   - emails arrive pre-masked (a***@domain) — never unmask client-side;
 *   - `milestone` is the highest ALL-TIME unlocked program milestone
 *     count (0 = none unlocked or no program configured) — it is NOT
 *     scoped to the selected window, so the badge copy must not imply
 *     "in this window";
 *   - `rank` is server-assigned within the window — render verbatim.
 */

export interface LeaderboardWindowOption {
  /** Query value sent as ?window= (server accepts "30d"/"90"/"12w"). */
  value: string;
  label: string;
  /** Day count, for the empty-state copy. */
  days: number;
}

export const LEADERBOARD_WINDOWS: readonly LeaderboardWindowOption[] = [
  { value: "30d", label: "30d", days: 30 },
  { value: "90d", label: "90d", days: 90 },
  { value: "365d", label: "365d", days: 365 },
];

export const LEADERBOARD_DEFAULT_WINDOW = "90d";

/** Rows requested per window — the card is an overview, not a report. */
export const LEADERBOARD_LIMIT = 20;

/**
 * Badge copy for the milestone column. Returns null for 0/invalid so
 * the cell renders an honest "—" instead of a fabricated tier.
 */
export function milestoneBadge(milestone: number): string | null {
  if (!Number.isFinite(milestone) || milestone <= 0) return null;
  return `${milestone.toLocaleString()}-referral tier`;
}

/**
 * Empty-state copy. `windowDays` comes from the RESPONSE
 * (`window_days`), not the request — the server falls back to 90 on
 * invalid windows and the copy must reflect what was actually queried.
 */
export function leaderboardEmptyCopy(windowDays: number): string {
  const d =
    Number.isFinite(windowDays) && windowDays > 0 ? Math.floor(windowDays) : 90;
  return `No historical credited records were created in the last ${d} day${d === 1 ? "" : "s"}. Live signup qualification and attribution remain review-gated.`;
}
