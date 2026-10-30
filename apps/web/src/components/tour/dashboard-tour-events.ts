// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lightweight bridge into the lazy dashboard tour island.
 *
 * Keep this module free of React and tour-engine imports: settings can request
 * a replay without pulling TourProvider, its queries, or the overlay into the
 * route's initial bundle.
 */
export const DASHBOARD_TOUR_REPLAY_EVENT =
  "postwave:dashboard-tour-replay" as const;

interface DashboardTourWindow extends Window {
  __postwaveDashboardTourReplayPending?: boolean;
}

function dashboardTourWindow(): DashboardTourWindow | null {
  return typeof window === "undefined" ? null : (window as DashboardTourWindow);
}

/** Request a replay, retaining one pending request until the lazy island loads. */
export function requestDashboardTourReplay(): void {
  const target = dashboardTourWindow();
  if (!target) return;

  // The settings route can hydrate before the client-only island's chunk has
  // evaluated. Marking the request before dispatch makes that click durable
  // across the loading race; the island consumes and clears it on mount.
  target.__postwaveDashboardTourReplayPending = true;
  target.dispatchEvent(new Event(DASHBOARD_TOUR_REPLAY_EVENT));
}

/** Atomically claim the pending replay request, if one exists. */
export function consumePendingDashboardTourReplay(): boolean {
  const target = dashboardTourWindow();
  if (!target?.__postwaveDashboardTourReplayPending) return false;

  delete target.__postwaveDashboardTourReplayPending;
  return true;
}
