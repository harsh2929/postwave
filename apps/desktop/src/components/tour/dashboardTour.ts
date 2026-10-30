import { TOUR_STEPS } from "../../lib/onboarding-manifest";
import type { TourStep } from "./types";

/**
 * Presentation projection of the single onboarding manifest. Step identity,
 * order, role applicability, adaptive goal, and routed destination are no
 * longer independently declared by the spotlight engine.
 */
export const DASHBOARD_TOUR_STEPS: TourStep[] = TOUR_STEPS.map((step) => ({
  id: step.id,
  targetSelector: step.targetSelector,
  ...(step.route ? { navigateTo: step.route.section } : {}),
  ...(step.placement ? { placement: step.placement } : {}),
  title: step.title,
  body: step.body,
  ...(step.hideBack ? { hideBack: true } : {}),
  ...(step.isFinal ? { isFinal: true } : {}),
  ...(step.skipIfGoalDone ? { skipIfGoalDone: step.skipIfGoalDone } : {}),
}));
