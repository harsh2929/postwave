/**
 * lib/referralsCopy.ts — what the referral surface SAYS, and why.
 *
 * The third of the three modules behind `lib/referrals.ts` (see that file's
 * header for the split). Every sentence the referral screen renders that is not
 * a number off the wire is written here, once, so the wording cannot drift
 * between a component and the test that asserts it. The summary lines live here
 * too: each one is a branchy sentence-builder that is worth testing and is not
 * worth re-reading inside JSX.
 *
 * Depends on lib/referralsBoundary.ts (the release gate several of these
 * sentences are claims about) and on lib/referralsWire.ts for the parsed shapes
 * it describes. Nothing here parses, and nothing here decides what is fetched.
 *
 * Import-free of React on purpose, so the copy and its branches are unit-tested
 * in the node environment.
 */
import { REFERRAL_RUNTIME_AVAILABLE } from "./referralsBoundary";
import type {
  ReferralPayoutList,
  ReferralProgram,
  ReferralVariant,
} from "./referralsWire";

/**
 * The three statuses `validPayoutFilterStatus` accepts, in lifecycle order.
 * Anything else the server sends is rendered verbatim with a neutral tone
 * rather than coerced into one of these — a status we do not recognise is a
 * fact about the server, not a rendering problem to be smoothed over.
 */
export const REFERRAL_PAYOUT_STATUSES: readonly string[] = Object.freeze([
  "pending",
  "approved",
  "paid",
]);

/**
 * The fulfilment line under the payouts heading.
 *
 * Counts are computed from the rows IN HAND, so when the server's `total`
 * exceeds them the line says how many it is describing. Saying "2 pending" over
 * a truncated page without that qualifier would understate the operator's
 * actual workload.
 */
export function payoutsSummaryLine(list: ReferralPayoutList): string {
  // Coerce rather than trust. This reads a value that can arrive from the
  // PERSISTED query cache, which means it can be a shape some earlier build of
  // this app wrote — `rows` is only guaranteed by the parser that ran on the
  // version that stored it. A summary line is never worth the screen.
  const rows = Array.isArray(list?.rows) ? list.rows : [];
  const total = typeof list?.total === "number" ? list.total : null;
  if (rows.length === 0) {
    return "No milestone rewards have been recorded yet.";
  }
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  const ordered = [
    ...REFERRAL_PAYOUT_STATUSES.filter((status) => counts.has(status)),
    ...[...counts.keys()]
      .filter((status) => !REFERRAL_PAYOUT_STATUSES.includes(status))
      .sort(),
  ];
  const parts = ordered.map((status) => `${counts.get(status)} ${status}`);
  if (total !== null && total > rows.length) {
    parts.push(`showing ${rows.length} of ${total}`);
  }
  return parts.join(" · ");
}

/**
 * One line describing the A/B split, or `null` when no variants are configured
 * — which is the ordinary case and deserves no row of its own rather than a
 * "no variants" line that would read as a missing setup step.
 *
 * An allocation the server did not send prints as `?%`, never as 0%: a variant
 * silently claiming zero traffic is exactly the misreading `numberOrNull`
 * exists to prevent.
 */
export function variantSummaryLine(
  variants: readonly ReferralVariant[] | undefined,
): string | null {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  return variants
    .map((variant) => {
      const pct =
        variant.allocationPct === null ? "?%" : `${variant.allocationPct}%`;
      return `${variant.key} ${pct}${variant.active ? "" : " (inactive)"}`;
    })
    .join(" · ");
}

/** The leaderboard window chips. `parseLeaderboardWindowDays` clamps to 365. */
export const REFERRAL_WINDOWS: readonly { key: string; days: number; label: string }[] =
  Object.freeze([
    { key: "30d", days: 30, label: "30 days" },
    { key: "90d", days: 90, label: "90 days" },
    { key: "365d", days: 365, label: "1 year" },
  ]);

export const DEFAULT_REFERRAL_WINDOW = "90d";

/**
 * The banner for a CLOSED runtime, and only for a closed runtime.
 *
 * Every clause here is a claim about the build ("no new conversion is being
 * credited"), so it is true exactly when `REFERRAL_RUNTIME_AVAILABLE` is false.
 * ReferralsScreen renders it on that branch alone. It is kept rather than
 * deleted because the Go constant is a release boundary that can close again,
 * and re-deriving this wording under pressure is how a surface ends up silent
 * about a switched-off subsystem.
 *
 * Written once, here, so the wording cannot drift between the screen and its
 * test.
 */
export const REFERRAL_RUNTIME_NOTICE = Object.freeze({
  headline: "Historical figures — the referral runtime is off",
  detail:
    "This build does not run referral attribution: the public referral redirect is unmounted and no new conversion is being credited. Everything below is a record of what the programme did while it was running, not a live counter.",
  spoken:
    "Historical figures. The referral runtime is switched off in this build, so nothing below is a live counter.",
});

/**
 * Why the programme card has no edit affordance.
 *
 * This used to say a referral link "cannot be minted by this build", which was
 * a statement about the SERVER and is now false — POST /referral-programs and
 * GET /subscribers/{id}/referral are both mounted. The remaining limit is a
 * statement about THIS CLIENT: mobile reads the programme and does not author
 * it. Saying so is honest; blaming the server is not.
 */
export const REFERRAL_PROGRAM_READ_ONLY_NOTE =
  "Read-only here. Milestone tiers, rewards and the verification window are edited in the web or desktop app.";

/**
 * The empty leaderboard window, explained without inventing a cause.
 *
 * With the runtime open, an empty window means nobody was credited in it — full
 * stop. The previous wording appended "the referral runtime is off in this
 * build, so no new conversions are being recorded", which would now blame a
 * switched-off subsystem for an ordinary quiet period.
 */
export const REFERRAL_EMPTY_WINDOW_DESCRIPTION = REFERRAL_RUNTIME_AVAILABLE
  ? "Nobody has been credited with a referral inside the selected window. Widen it, or check the programme above."
  : "Nobody has been credited with a referral inside the selected window. Widen it, or check the programme above — the referral runtime is off in this build, so no new conversions are being recorded.";

/**
 * A 404 from /referral-programs/current means "no programme has been
 * configured", which is a legitimate resting state and not a failure. Anything
 * else is a real error and must not be swallowed into an empty-looking card.
 */
export function isNoActiveProgramError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: unknown; code?: unknown; message?: unknown };
  if (e.status === 404) return true;
  if (typeof e.code === "string" && e.code === "not_found") return true;
  return typeof e.message === "string" && /no active program/i.test(e.message);
}

/**
 * Why the "Get link" affordance is absent for some sessions.
 *
 * `GET /api/v1/subscribers/{id}/referral` is `r.With(admin)` while everything
 * else on this screen is `r.With(read)`, and on the session path `ScopeAdmin`
 * is an owner|admin ROLE check — see SUBSCRIBER_REFERRAL_MINIMUM_ROLE in
 * lib/referralsBoundary.ts. Below that floor the button could never succeed, so
 * the card withholds it and says this instead of shipping a control whose only
 * possible outcome is a 403.
 *
 * It names what the role CAN still see, because the rest of the card is
 * genuinely readable: the counts and the recency come from /referrals/stats,
 * which is a read-scope route.
 */
export const SUBSCRIBER_REFERRAL_ROLE_NOTE =
  "Referral links need an owner or admin role: asking for one mints the referrer's code. The counts below are readable by your role.";

/**
 * The same fact, as an ERROR, for the sessions the note above cannot cover.
 *
 * The affordance gate is a client-side mirror of a server rule, and the two can
 * disagree in both directions: an API-key session whose scopes mobile cannot
 * see, a custom role whose grants live in `roles_permissions`, or a role that
 * changed underneath a screen already on-glass. When it does, the request is
 * made and refused, and the operator must not read "Couldn't…" — which reads as
 * transient and invites a retry that is guaranteed to fail the same way.
 */
export const SUBSCRIBER_REFERRAL_ROLE_REFUSAL =
  "Getting a referrer's link needs an owner or admin role. Retrying will not help — ask an owner, or open Referrals in the web admin.";

/**
 * What went wrong fetching one subscriber's referral link, in a sentence an
 * operator can act on.
 *
 * The three failures this route has that a generic "Something went wrong" would
 * flatten are configuration or authority, not faults:
 *
 *   403 insufficient_role — the route carries `ScopeAdmin`, which on the
 *     session-cookie path is an owner|admin role check (apps/api/internal/
 *     apikeys/middleware.go: ScopeAdmin is not in `readOnlyScopes`, so
 *     `requireAdminRoleForScopes` runs the role gate). Nothing about waiting
 *     changes this, so the sentence must not imply a retry.
 *   503 share_base_missing — REFERRAL_SHARE_BASE_URL is unset AND the request
 *     carried no host to fall back to, so the server cannot build a link. There
 *     is nothing to retry; someone has to set it.
 *   409 code_contention    — the code namespace is momentarily busy. The server
 *     sends Retry-After: 1 and means it. Retrying is the whole fix.
 *
 * Anything else falls through to a plain failure, deliberately without echoing
 * the server's message: it is not written for this screen.
 *
 * The status is checked as well as the code because the two denial writers on
 * this path disagree on wording — `RequireScope` writes `insufficient_role` for
 * a session and `insufficient_scope` for an API key — and both are the same
 * fact to the person holding the phone.
 */
export function subscriberReferralErrorMessage(error: unknown): string {
  const e = (error && typeof error === "object" ? error : {}) as {
    status?: unknown;
    code?: unknown;
  };
  const code = typeof e.code === "string" ? e.code : "";
  if (
    code === "insufficient_role" ||
    code === "insufficient_scope" ||
    e.status === 403
  ) {
    return SUBSCRIBER_REFERRAL_ROLE_REFUSAL;
  }
  if (code === "share_base_missing" || e.status === 503) {
    return "This workspace has no referral share base URL configured, so the server cannot build a link. Set REFERRAL_SHARE_BASE_URL and try again.";
  }
  if (code === "code_contention" || e.status === 409) {
    return "The referral code namespace is busy. Try again in a moment.";
  }
  return "Couldn't get this referrer's link.";
}

/**
 * One line summarising the programme for the card header. Kept here because it
 * has three branches worth testing and none worth re-reading inside JSX.
 */
export function programSummaryLine(program: ReferralProgram | null): string {
  if (!program) return "No referral programme configured.";
  // The null check guards the PROGRAMME, not its array field: `omitempty`
  // drops an empty `milestones` and `.length` then throws on undefined. A
  // programme with no tiers is precisely the case this branch describes.
  const milestones = Array.isArray(program.milestones)
    ? program.milestones
    : [];
  if (milestones.length === 0) {
    return program.active
      ? "Programme configured with no milestone tiers."
      : "Programme is inactive and has no milestone tiers.";
  }
  const tiers = program.milestones.length;
  const top = program.milestones[program.milestones.length - 1]?.count ?? 0;
  const state = program.active ? "Active" : "Inactive";
  return `${state} · ${tiers} tier${tiers === 1 ? "" : "s"} · top tier at ${top} referral${top === 1 ? "" : "s"}`;
}
