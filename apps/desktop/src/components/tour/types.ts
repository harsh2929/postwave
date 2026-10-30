/**
 * Tour engine types — shared shape between the step definitions
 * (`dashboardTour.ts`), the provider/state machine (`TourProvider.tsx`),
 * the overlay (`TourOverlay.tsx`), and the tooltip (`TourTooltip.tsx`).
 *
 * The tour is a *feature walkthrough* that fires after the
 * OnboardingWizard has been dismissed/completed. It targets DOM
 * elements via `data-tour` attributes, spotlights them with an
 * SVG-mask cutout, and pins a tooltip near the focused element.
 */

import type { ChecklistGoalKey } from "@postwave/onboarding-schema";

import type { TourStepId } from "../../lib/onboarding-manifest";
import type { RoutableDesktopSection } from "../../lib/desktop-router";

/**
 * Where the tooltip should sit relative to the spotlit target.
 *
 * `auto` measures available viewport space on each side and picks the
 * one with the most room — the universal fallback when a target is
 * pinned to a corner / edge.
 */
export type TooltipPlacement = "top" | "bottom" | "left" | "right" | "auto";

/**
 * One step in the tour. Steps with `targetSelector === null` are
 * centered modals (welcome / done). Steps with `navigateTo` set ask
 * the engine to switch sections before measuring the target.
 */
export interface TourStep {
  /** Stable id used for telemetry + resume. */
  id: TourStepId;
  /**
   * `data-tour` attribute value on the target element. `null` =
   * centered modal (no spotlight, no anchor). The engine resolves
   * this with `document.querySelector('[data-tour="<value>"]')`.
   */
  targetSelector: string | null;
  /** Optional section to switch to before resolving the target. */
  navigateTo?: RoutableDesktopSection;
  /** Tooltip side. Defaults to `auto`. */
  placement?: TooltipPlacement;
  /** Tooltip headline. Short and friendly. */
  title: string;
  /** Tooltip body. One or two sentences. */
  body: string;
  /**
   * Hide the Back button on this step. Used for the welcome step
   * (nothing before it) and any "deadweight" entries we don't want
   * users to scrub backward through.
   */
  hideBack?: boolean;
  /** Final step — show "Done" instead of "Next" + fire confetti. */
  isFinal?: boolean;
  /**
   * Adaptivity (shared schema contract): skip this step entirely when this
   * onboarding goal is already complete for the tenant. Resolved against the
   * server-backed `/onboarding-progress` (via `useOnboardingProgress`) and
   * filtered through `adaptiveSteps()` before the tour runs, so a returning
   * user doesn't re-walk steps for work they've finished.
   */
  skipIfGoalDone?: ChecklistGoalKey;
}

/**
 * Imperative API exposed by `TourProvider` via the `useTour()` hook.
 * Components like the launcher button and Settings "Replay" link call
 * these to drive the state machine.
 */
export interface TourController {
  /** Index into the step list, or -1 when the tour is closed. */
  currentStep: number;
  /** Total step count for progress dots. */
  totalSteps: number;
  /** True while the tour is on-screen. */
  isOpen: boolean;
  /** Begin the tour from step 0. Resumes from saved index if present. */
  start: () => void;
  /** Begin the tour from step 0 unconditionally — bypass any resume state. */
  replay: () => void;
  /** Walk every persistent workspace destination in canonical sidebar order. */
  fullWalkthrough: () => void;
  /** Advance one step. No-op past the end. */
  next: () => void;
  /** Go back one step. No-op at the start. */
  back: () => void;
  /** Dismiss with confirm prompt; persists `dismissed_at`. */
  skip: () => void;
  /** Mark complete; persists `completed_at` + closes. */
  complete: () => void;
}
