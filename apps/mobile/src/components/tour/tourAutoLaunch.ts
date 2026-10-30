/**
 * Automatic product-tour precedence against first-run onboarding.
 *
 * Import-free so the lifecycle decision can be reasoned about without React,
 * TanStack Query, or the overlay. Manual Replay deliberately does not consult
 * this policy; an explicit user action always wins.
 */
export type TourAutoLaunchDecision = "wait" | "suppress" | "allow";

export function tourAutoLaunchDecision({
  completed,
  failed,
  pending,
}: {
  completed: unknown;
  failed: boolean;
  pending: boolean;
}): TourAutoLaunchDecision {
  // A known-empty workspace gets the setup wizard, never two overlays. Keep
  // this first so a cached successful empty result still wins if a background
  // refresh later fails.
  if (completed === 0) return "suppress";
  // Older deployments may not expose onboarding-progress. The tour was
  // intentionally fail-soft before this coordination and remains so.
  if (failed) return "allow";
  if (pending) return "wait";
  // Non-empty, malformed, or otherwise settled-without-data all preserve the
  // existing launch behavior. Only authoritative zero suppresses it.
  return "allow";
}
