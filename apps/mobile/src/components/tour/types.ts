/**
 * Tour engine types.
 *
 * The tour is a small state machine: a list of steps the user advances
 * through with Next/Back/Skip. Each step optionally targets a UI element
 * registered by the `useTourTarget` hook, optionally on a different tab.
 *
 * Targets are React Native `View` refs. We measure their on-screen rect
 * with `ref.measureInWindow` when a step activates so the spotlight can
 * cut a hole around them. Cross-tab steps carry a `navigateTo` route the
 * engine pushes via `router.replace` before measuring.
 */
import type { RefObject } from "react";
import type { View } from "react-native";

import type { ChecklistGoalKey } from "@postwave/onboarding-schema";

/** Stable ID a screen registers a target under. */
export type TourTargetId =
  | "dashboard.stats"
  | "dashboard.recent"
  | "campaigns.list"
  | "voice.profile"
  | "settings.replay";

/** Where the tooltip sits relative to the spotlighted target. */
export type TooltipPlacement = "top" | "bottom" | "auto" | "center";

/** A single step in the tour's script. */
export interface TourStep {
  /** Stable key for analytics + persistence. */
  id: string;
  /** Human-readable title shown above the body in the tooltip. */
  title: string;
  /** Body copy. Avoid emojis — tone comes from word choice. */
  body: string;
  /**
   * The element this step highlights. When omitted, the step renders
   * centered with no spotlight (used for the welcome + outro beats).
   */
  targetId?: TourTargetId;
  /**
   * Expo Router path to navigate to before measuring. Use for cross-tab
   * steps (Campaigns, Voice, Settings). The engine `router.replace`s and
   * waits a beat for layout before measuring the target.
   */
  navigateTo?: string;
  /** Tooltip side. "auto" picks whichever has more vertical space. */
  placement?: TooltipPlacement;
  /**
   * Extra padding around the target rect when carving the spotlight,
   * in points. Default 12. Useful when a target is a tight square (a
   * tab-bar icon) and we want a bigger glow.
   */
  spotlightPadding?: number;
  /**
   * Override spotlight rect. When provided, the engine skips measuring
   * and uses this rect directly. Used for the welcome step's "no target"
   * variant or for fixed-position UI (the FAB itself).
   */
  fixedRect?: TourRect;
  /**
   * Adaptivity: drop this step entirely when this onboarding goal is
   * already complete for the tenant (resolved from /onboarding-progress
   * at start). Mirrors the shared schema's `skipIfGoalDone`; the provider
   * filters the script through `adaptiveSteps` using fetched progress.
   */
  skipIfGoalDone?: ChecklistGoalKey;
}

/** Pixel-coordinate rect in the window's coordinate space. */
export interface TourRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A target a screen registers with the tour context. */
export interface TourTarget {
  id: TourTargetId;
  ref: RefObject<View | null>;
}

/** Context value exposed to consumers. */
export interface TourContextValue {
  /** Whether the tour overlay is currently active. */
  active: boolean;
  /** Index of the current step. */
  stepIndex: number;
  /** The script being run. */
  steps: readonly TourStep[];
  /** Start the tour from step 0. */
  start: () => void;
  /** End the tour without marking complete. */
  dismiss: () => void;
  /** Advance to the next step (or complete on the last). */
  next: () => void;
  /** Go back one step (clamps at 0). */
  back: () => void;
  /** Skip the rest of the tour. Marks dismissed. */
  skip: () => void;
  /** Register a target ref. Returns an unregister fn. */
  registerTarget: (id: TourTargetId, ref: RefObject<View | null>) => () => void;
  /** Look up a registered target by id. */
  getTarget: (id: TourTargetId) => TourTarget | undefined;
  /** True once we've checked AsyncStorage for completion + reduced-motion. */
  hydrated: boolean;
  /** Whether reduced-motion is on (animations should be instant). */
  reducedMotion: boolean;
}
