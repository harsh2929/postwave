/**
 * lib/referralsBoundary.ts — WHICH referral routes exist, and when.
 *
 * The first of the three modules behind `lib/referrals.ts` (see that file's
 * header for the split). This one owns nothing but the boundary: the mirrored
 * Go constant and the two route lists `referrals.boundary.test.ts` holds
 * against apps/api/internal/referrals/referrals.go, plus the AUTHORITY floor at
 * the foot of the file — which of those mounted routes this session may
 * actually call. "Mounted" and "callable by you" are different questions and
 * one route on this surface answers them differently. It is kept apart from
 * the copy and the parsers because it is the only half whose truth is decided
 * OUTSIDE this app, and because both of the others depend on it — the copy
 * branches on the flag, so the flag cannot live downstream of the copy.
 *
 * WHAT IS REACHABLE. `MountAdminRoutes`
 * (apps/api/internal/referrals/referrals.go) registers three reads
 * unconditionally and then consults a compile-time release gate:
 *
 *   read  GET /api/v1/referral-programs/current
 *   read  GET /api/v1/referrals/stats
 *   read  GET /api/v1/referrals/leaderboard
 *   ────────── if !OperationalRuntimeAvailable { return } ──────────
 *   payouts, variants, credit, programme writes, and — the one the share sheet
 *   needs — GET /api/v1/subscribers/{id}/referral, which MINTS a subscriber's
 *   code and returns its share_url.
 *
 * THE GATE IS NOW OPEN. `OperationalRuntimeAvailable` is `true`, so every route
 * after that early return is mounted, and so is the public redirect
 * `/api/public/r/{code}` that credits new conversions. This file used to assert
 * the opposite in prose the screen rendered verbatim, which made the app state a
 * false fact about live data. The rule that produced that copy is still right —
 * ABSENCE IS NOT ZERO, and a screen must never invent a reason for a number —
 * but its premise moved, so the copy moved with it.
 *
 * WHAT THAT CHANGES HERE, EXACTLY:
 *   - `REFERRAL_RUNTIME_NOTICE` (lib/referralsCopy.ts) is now a CONDITIONAL
 *     banner. It states that the runtime is off, which is only true when
 *     `REFERRAL_RUNTIME_AVAILABLE` is false, so it is rendered only on that
 *     branch. Keeping it (rather than deleting it) is deliberate: the gate is a
 *     release boundary and can close again, and the copy has to be waiting when
 *     it does.
 *   - the reads gated behind it are now wired — payouts, variants, and the
 *     per-subscriber referral link. They are listed in
 *     `RUNTIME_GATED_REFERRAL_READ_ROUTES` and the boundary test holds that list
 *     to the Go source in the same way it holds the unconditional three.
 *
 * Import-free on purpose: parsing and copy are unit-tested in the node
 * environment, the React layer only renders what comes out of here.
 */

/**
 * Mirrors `OperationalRuntimeAvailable` in
 * apps/api/internal/referrals/referrals.go. `referrals.boundary.test.ts` reads
 * that file and fails the build if the two disagree.
 *
 * The mirror has now done its job in BOTH directions: it went red when the A2
 * open landed, and red again on 2026-08-30 when the gate was RE-CLOSED in the
 * server tree ("RELEASE REMAINS HELD. Handler existence is not operational
 * qualification…" — referrals.go:46-52). This constant is the one branch every
 * runtime-dependent claim on the surface hangs off — the honesty banner, the
 * empty-window explanation, whether the gated reads are attempted, and since
 * the desktop-parity pass the ADMIN WRITE affordances too (payout advance,
 * programme editing, the widget install snippet) — so the close flips the
 * whole surface back with this one edit, and a future re-open lights it all
 * up again the same way.
 */
export const REFERRAL_RUNTIME_AVAILABLE = false;

/** The routes `MountAdminRoutes` registers before its runtime gate. */
export const MOUNTED_REFERRAL_READ_ROUTES: readonly string[] = Object.freeze([
  "GET /api/v1/referral-programs/current",
  "GET /api/v1/referrals/stats",
  "GET /api/v1/referrals/leaderboard",
]);

/**
 * The READ routes that mount only once the runtime gate is open. Every one of
 * these is consumed by hooks/useReferrals.ts, and each of those queries is
 * `enabled` on `REFERRAL_RUNTIME_AVAILABLE`, so a closed gate produces no 404s
 * rather than six failed requests per screen focus.
 *
 * The writes behind the same gate (POST /referral-programs, POST
 * /referrals/credit, POST /subscribers/{id}/referral/code, PATCH
 * /referrals/payouts/{id}, variant upsert/delete) are deliberately absent:
 * mobile does not author referral programmes, and claiming those verbs here
 * would be the same kind of false promise this file exists to prevent.
 */
export const RUNTIME_GATED_REFERRAL_READ_ROUTES: readonly string[] =
  Object.freeze([
    "GET /api/v1/subscribers/{id}/referral",
    "GET /api/v1/referrals/payouts",
    "GET /api/v1/referrals/variants",
  ]);

/**
 * THE AUTHORITY FLOOR ON THE ONE ROUTE THAT MINTS.
 *
 * The gate above answers "is it mounted"; this answers "may THIS session call
 * it", and for one route on the surface the two answers differ. In
 * `MountAdminRoutes`, payouts and variants are `r.With(read)` —
 * `RequireScope(ScopeReadReports)` — while
 * `GET /api/v1/subscribers/{id}/referral` is `r.With(admin)` =
 * `RequireScope(ScopeAdmin)`. That is not an API-key-only distinction any more:
 * `ScopeAdmin` is absent from `readOnlyScopes` (apps/api/internal/apikeys/
 * middleware.go), so `requireAdminRoleForScopes` is true and the SESSION path
 * runs `sessionRoleAllowsScopes` and answers `403 insufficient_role` to a
 * viewer, member or editor holding a perfectly valid cookie.
 *
 * So "Get link" is an affordance a whole role class can never complete. It is
 * withheld rather than disabled — a disabled control on a phone is a promise
 * you cannot keep — and `referralsAuthority.test.ts` parses the Go source to
 * hold this constant to the `admin` binding, so a future relaxation of the
 * route to `read` widens the affordance instead of leaving it needlessly shut.
 *
 * `api_key` mode fails this closed: `canAccessMinimumRole` admits an API key
 * only to a `viewer` floor, and mobile cannot see which scopes a key carries.
 */
export const SUBSCRIBER_REFERRAL_MINIMUM_ROLE = "admin";

/**
 * Whether `GET /api/v1/subscribers/{id}/referral` may be issued right now.
 *
 * Extracted from the hook's `enabled:` clause rather than inlined there so the
 * NO-PREFETCH INVARIANT is testable without React. That invariant is the whole
 * reason this predicate is interesting: the read has a WRITE side effect —
 * the handler calls `EnsureCode` and MINTS the subscriber's referral code on
 * first ask — so a `null` `subscriberId` must produce `false`, or scrolling a
 * leaderboard would create referral codes for people nobody selected.
 *
 * Every term is load-bearing and each fails for its own reason:
 *   runtimeAvailable — the route is behind `OperationalRuntimeAvailable`; with
 *                      the gate shut this is a 404, not a link.
 *   gateEnabled      — no usable online session (offline, or signed out).
 *   tenantId         — no workspace resolved yet; the key would be wrong.
 *   canMintLink      — the role floor above; below it this is a guaranteed 403.
 *   subscriberId     — nobody has pressed anything yet. THE MINT GUARD.
 */
export function subscriberReferralQueryEnabled(input: {
  runtimeAvailable: boolean;
  gateEnabled: boolean;
  tenantId: string | null | undefined;
  canMintLink: boolean;
  subscriberId: string | null | undefined;
}): boolean {
  return (
    input.runtimeAvailable &&
    input.gateEnabled &&
    Boolean(input.tenantId) &&
    input.canMintLink &&
    Boolean(input.subscriberId)
  );
}
