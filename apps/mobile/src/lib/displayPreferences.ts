/**
 * lib/displayPreferences.ts — the PURE half of "make the app fit the way I
 * work" (LOVE#51).
 *
 * Settings offered exactly one display preference — theme — while every list
 * in the product is card-heavy and every operator lands on Dashboard whether
 * or not Dashboard is what they open the app for. Desktop has had both of the
 * knobs below for as long as it has had a settings page.
 *
 * THREE KNOBS WERE ASKED FOR; TWO ARE HERE, AND THE THIRD IS REFUSED ON
 * PURPOSE — see `TAB_ORDER_IS_FIXED` at the bottom of this file, which is the
 * honest answer rather than a missing feature.
 *
 * Import-free (react-native, expo, and the route manifest all stay out), so
 * the whole policy — including the role gate on the landing choice — is
 * unit-tested under node. The ROLE itself is a parameter, not an import: the
 * caller holds the auth store, and keeping the decision here keeps it testable
 * without one.
 *
 * Storage is NOT re-invented: `useDisplayPreferences` layers these values onto
 * the existing `useListPreferences` / `lib/listPreferences` store, so they
 * inherit its origin+tenant+user scoping and its sign-out wipe rather than
 * becoming a second, differently-scoped memory of the user.
 */

/** How much air a list row gets. */
export type RowDensity = "comfortable" | "compact";

export const ROW_DENSITIES: readonly RowDensity[] = ["comfortable", "compact"];

export const DEFAULT_ROW_DENSITY: RowDensity = "comfortable";

/**
 * Routes a cold launch may land on.
 *
 * Only the four primary tabs. Not because the list could not be longer, but
 * because a landing screen has to be safe to arrive on with no context: no
 * arguments, no destructive affordance in reach, and a place the tab bar can
 * take you back from. A secondary More destination fails the last of those —
 * you would launch into a screen with no tab highlighted.
 */
export type LandingRoute =
  | "/(tabs)/dashboard"
  | "/(tabs)/subscribers"
  | "/(tabs)/campaigns"
  | "/(tabs)/approvals";

export const DEFAULT_LANDING_ROUTE: LandingRoute = "/(tabs)/dashboard";

/**
 * The whole set, in tab-bar order. This module holds ROUTES only — what each
 * one is CALLED is a message (`display.landing.*` in lib/messagesEn.ts), so
 * the label cannot become a second, untranslated copy of the tab-bar word.
 */
const ALL_LANDING_ROUTES: readonly LandingRoute[] = [
  "/(tabs)/dashboard",
  "/(tabs)/subscribers",
  "/(tabs)/campaigns",
  "/(tabs)/approvals",
];

/**
 * The landing choices this person may actually reach.
 *
 * `canApprove` is admin-or-owner, and it is not a guess: `GET /api/v1/approvals`
 * runs `requireAdmin` (apps/api/internal/approvals/handlers.go:226 → :597,
 * which admits `owner` and `admin` and 403s everyone else). The generated
 * route-authz manifest lists that route as viewer-level, but that row is a
 * `fail_closed_default` safe default and not a reading of the handler. Offering
 * Approvals as a landing screen to an editor would launch them into a
 * permission notice every single time they open the app.
 */
export function landingOptions(
  canApprove: boolean,
): readonly LandingRoute[] {
  return ALL_LANDING_ROUTES.filter(
    (route) => canApprove || route !== "/(tabs)/approvals",
  );
}

function isLandingRoute(value: string): value is LandingRoute {
  return (ALL_LANDING_ROUTES as readonly string[]).includes(value);
}

/**
 * What a stored value resolves to today.
 *
 * Re-checked on EVERY launch rather than once at write time, because the thing
 * that changes underneath a stored preference is the user's role: an admin who
 * chose Approvals and was later demoted must fall back to Dashboard, not open
 * the app on a 403. The same path also absorbs a value written by an older
 * build for a route that no longer exists.
 */
export function resolveLandingRoute(
  stored: string | null | undefined,
  canApprove: boolean,
): LandingRoute {
  const trimmed = (stored ?? "").trim();
  if (!isLandingRoute(trimmed)) return DEFAULT_LANDING_ROUTE;
  return landingOptions(canApprove).includes(trimmed)
    ? trimmed
    : DEFAULT_LANDING_ROUTE;
}

/** Coerce a stored density, dropping anything an older build wrote. */
export function resolveRowDensity(
  stored: string | null | undefined,
): RowDensity {
  const trimmed = (stored ?? "").trim();
  return ROW_DENSITIES.includes(trimmed as RowDensity)
    ? (trimmed as RowDensity)
    : DEFAULT_ROW_DENSITY;
}

/** The measurements a list row applies for the chosen density. */
export interface DensityMetrics {
  /** Inner padding of a row card. */
  rowPadding: number;
  /** Gap between a row's columns (avatar ↔ text ↔ trailing). */
  rowGap: number;
  /** Vertical space between one row and the next. */
  rowSpacing: number;
  /** Declared floor for the row's height. */
  rowMinHeight: number;
}

/**
 * NOTHING HERE SHRINKS TEXT. Compact removes PADDING, never type size: the
 * type scale is the Dynamic Type contract (src/lib/typeScale.ts), and a
 * density control that quietly overrode the OS text-size setting would be an
 * accessibility regression dressed up as a preference. It also never takes a
 * row under the 44pt touch floor — `rowMinHeight` is asserted against it.
 */
const DENSITY_METRICS: Record<RowDensity, DensityMetrics> = {
  comfortable: { rowPadding: 14, rowGap: 12, rowSpacing: 8, rowMinHeight: 64 },
  compact: { rowPadding: 10, rowGap: 10, rowSpacing: 6, rowMinHeight: 48 },
};

/** The smallest touch target iOS and Android both consider reachable. */
export const MIN_TOUCH_TARGET = 44;

export function densityMetrics(density: RowDensity): DensityMetrics {
  return DENSITY_METRICS[density];
}

/**
 * TAB ORDER IS DELIBERATELY NOT A PREFERENCE, and this constant exists so the
 * reason is in the source rather than in a review comment.
 *
 * The five bottom destinations are asserted, in order, in three places that
 * are not this app's to change unilaterally: `@postwave/nav` (the shared
 * cross-surface nav manifest), `src/lib/nav.consistency.test.ts`'s MOBILE_TABS,
 * and `app/(tabs)/_layout.tsx`. Desktop and web render the same five in the
 * same order. A per-device reordering would mean a screenshot in a support
 * thread, a "third tab along" in the docs, and a colleague's phone all
 * disagreeing about what the tab bar says — for a saving of one tap.
 *
 * The need underneath it is real and is already met: More has pinned
 * favourites and a recents list (`lib/navPreferences.ts`), which personalises
 * the destinations WITHOUT making the shared five mean different things on
 * different devices. The Display section says exactly this to the user rather
 * than staying silent about a control that is not there.
 */
export const TAB_ORDER_IS_FIXED = true;
