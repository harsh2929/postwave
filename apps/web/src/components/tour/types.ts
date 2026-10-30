// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tour TYPES — the content schema (Tour/TourStep/TourPlacement) now lives in
 * the shared @postwave/onboarding-schema package so web, desktop, and mobile
 * author the same shape. We re-export it here (proving the shared contract)
 * and keep only the web-only React context/state types local.
 *
 * NOTE on navigation: the schema's `TourStep.navigateToRouteKey` is an
 * ABSTRACT route key (platform-resolved). The web tour engine has always used
 * a concrete `navigateTo` path string. Rather than fork the schema, web
 * defines {@link WebTourStep} = the shared `TourStep` plus an optional
 * concrete `navigateTo` path, and threads that type through the engine. This
 * keeps web's behavior identical while consuming the canonical base type.
 */

import type {
  Tour as SchemaTour,
  TourStep as SchemaTourStep,
} from "@postwave/onboarding-schema";

export type { TourPlacement } from "@postwave/onboarding-schema";

/**
 * Web's step type: the shared schema step + the concrete `navigateTo` path the
 * web engine routes to (the schema models this abstractly as
 * `navigateToRouteKey`; web keeps the real path it already shipped with).
 */
export type WebTourStep = SchemaTourStep & {
  /** Concrete href the user navigates to before advancing (web-only). */
  navigateTo?: string;
  /** Page on which this spotlight belongs; also used when going Back/replaying. */
  route?: string;
};

/**
 * Web's tour type: a `Tour` whose steps are {@link WebTourStep}. We re-shape
 * the schema's `Tour` (which uses the base `TourStep[]`) to use the web step.
 */
export type TourStep = WebTourStep;

export type Tour = Omit<SchemaTour, "steps"> & {
  /** Optional concrete pathname this tour expects to start on. */
  startsOn?: string;
  steps: WebTourStep[];
};

export interface TourState {
  tourId: string | null;
  stepIndex: number;
  isOpen: boolean;
}

export interface TourContextValue {
  state: TourState;
  steps: TourStep[];
  start: (tourId?: string) => void;
  next: () => void;
  /** Advance past the current step because its target couldn't be resolved.
   *  Emits a tour_step_skipped analytics event (distinct from a full dismiss). */
  skipStep: () => void;
  back: () => void;
  skip: () => void;
  complete: () => void;
  replay: () => void;
  goTo: (index: number) => void;
  /** Has the user completed the registered tour at least once? */
  hasCompleted: boolean;
}
