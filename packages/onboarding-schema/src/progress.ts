/**
 * Client types for `GET /api/v1/onboarding-progress`.
 *
 * These mirror, byte-for-byte, the JSON the Go endpoint emits
 * (apps/api/internal/onboarding_progress/onboarding_progress.go). The server
 * derives each step's done-ness from row-existence — there is no stored
 * progress state — so this is read-only and safe to poll/refetch.
 *
 * Every client (web/desktop/mobile) deserializes with THESE types so the
 * checklist + adaptive-tour logic reads identical fields everywhere.
 */

import type { ChecklistGoalKey } from "./checklist.js";

/** One checklist step as returned by the server. */
export interface OnboardingStep {
  /** Canonical key — aligns with {@link ChecklistGoalKey}. */
  key: ChecklistGoalKey | (string & {});
  /** Server-authored label (the client's schema carries a fallback). */
  label: string;
  /** Server-authored description. */
  description: string;
  /** Whether the underlying row(s) exist for this tenant. */
  completed: boolean;
}

/** The full `/onboarding-progress` payload. */
export interface OnboardingProgress {
  steps: OnboardingStep[];
  /** Count of completed steps. */
  completed: number;
  /** Total number of steps. */
  total: number;
  /** Integer percentage 0–100 (`completed / total`). */
  percent: number;
  /** True when every step is complete. */
  all_done: boolean;
}

/** Type guard for a raw payload (defensive parsing across API versions). */
export function isOnboardingProgress(value: unknown): value is OnboardingProgress {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.steps) &&
    typeof v.completed === "number" &&
    typeof v.total === "number" &&
    typeof v.percent === "number" &&
    typeof v.all_done === "boolean"
  );
}

/** Is a specific goal complete in a progress payload? Safe on partial data. */
export function isGoalComplete(
  progress: OnboardingProgress | null | undefined,
  key: ChecklistGoalKey,
): boolean {
  if (!progress) return false;
  return progress.steps.some((s) => s.key === key && s.completed);
}
