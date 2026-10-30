/**
 * The product-tour content schema — shared across web/desktop/mobile.
 *
 * Generalized from apps/web's original `Tour`/`TourStep` (the cleanest of the
 * three) so all platforms author the same tour shape. The two platform-varying
 * concerns are abstracted:
 *  - `target` is a platform-agnostic id; each renderer maps it to its own
 *    node (web `[data-tour]`, desktop selector, mobile `TourTargetId`).
 *  - `navigateToRouteKey` is an ABSTRACT route key (see OnboardingRouteKey);
 *    each platform resolves it to a real route/screen.
 *
 * Adaptivity lives here as data: `skipIfGoalDone` references a server progress
 * key (ChecklistGoalKey), letting the engine drop steps the tenant already
 * finished — without any per-platform branching code.
 */

import type { ChecklistGoalKey, OnboardingRouteKey } from "./checklist.js";

/**
 * The product tour's analytics identity, shared by every surface.
 *
 * Mobile used to emit "mobile_dashboard" while desktop emitted "dashboard", so
 * the same tour arrived in analytics as two funnels that could never be
 * compared or summed -- precisely the cross-surface split this package exists
 * to prevent.
 *
 * The surface is NOT part of this id. Every onboarding event already carries a
 * `platform` field (see BaseProps in ./analytics), so encoding "mobile" here
 * duplicated a dimension that was already present and made the funnel
 * un-unionable to get it. One id, split by platform when you want the split.
 *
 * This is an ANALYTICS identity only. Tour completion is persisted separately
 * per surface, so changing it does not re-show a tour anybody has finished.
 */
export const DASHBOARD_TOUR_ID = "dashboard";

/**
 * The template-catalog tour's analytics identity.
 *
 * Desktop selects between this and DASHBOARD_TOUR_ID on the event's surface. It
 * is declared here for the same reason: the moment a second surface emits a
 * catalog tour, the two ids have to already be the same one.
 */
export const CATALOG_TOUR_ID = "catalog";

export type TourPlacement =
  | "top"
  | "bottom"
  | "left"
  | "right"
  | "auto"
  | "center";

export interface TourStep {
  /** Unique key within the tour — used for instrumentation + a11y ids. */
  id: string;
  /** Platform-agnostic target id; renderer maps it to a real node. */
  target?: string;
  /** Tooltip headline. */
  title: string;
  /** Tooltip body copy. */
  body: string;
  /** Where to place the tooltip relative to the target. */
  placement?: TourPlacement;
  /** Primary button label (defaults to "Next" / "Got it"). */
  primaryLabel?: string;
  /** Abstract route key to navigate to before advancing (cross-page steps). */
  navigateToRouteKey?: OnboardingRouteKey;
  /** Wait this many ms after navigation before re-measuring the target. */
  navigateDelayMs?: number;
  /** Skip the step if the target can't be found (else render centered). */
  skipIfMissing?: boolean;
  /** Fire confetti on transition into this step. */
  celebrate?: boolean;
  /**
   * Adaptivity: skip this step entirely when this onboarding goal is already
   * complete for the tenant (resolved from /onboarding-progress at start).
   */
  skipIfGoalDone?: ChecklistGoalKey;
}

export interface Tour {
  id: string;
  /** Abstract route key the tour expects to start on (optional). */
  startsOnRouteKey?: OnboardingRouteKey;
  steps: TourStep[];
}

/**
 * Resolve the steps a tenant should actually see, given their server progress.
 * Pure + platform-agnostic so every renderer adapts identically.
 */
export function adaptiveSteps(
  steps: readonly TourStep[],
  isGoalDone: (key: ChecklistGoalKey) => boolean,
): TourStep[] {
  return steps.filter(
    (s) => !s.skipIfGoalDone || !isGoalDone(s.skipIfGoalDone),
  );
}
