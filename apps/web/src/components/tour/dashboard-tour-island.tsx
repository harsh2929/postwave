// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect } from "react";

import type { RoleKey } from "@/lib/query-keys";

import {
  DASHBOARD_TOUR_REPLAY_EVENT,
  consumePendingDashboardTourReplay,
} from "./dashboard-tour-events";
import { TourLauncher } from "./TourLauncher";
import { TourProvider, useTour } from "./TourProvider";

function DashboardTourReplayBridge(): null {
  const { replay } = useTour();

  useEffect(() => {
    function replayRequested(): void {
      // Clear the durable marker whether this request arrived before or after
      // subscription, then let the provider perform its canonical replay flow
      // (decision write, focus restoration, analytics and adaptive steps).
      consumePendingDashboardTourReplay();
      replay();
    }

    window.addEventListener(DASHBOARD_TOUR_REPLAY_EVENT, replayRequested);

    // A fast click on the already-hydrated settings button can beat this lazy
    // chunk. Claim that request after subscribing so there is no lost-event
    // gap between the check and addEventListener.
    if (consumePendingDashboardTourReplay()) replay();

    return () => {
      window.removeEventListener(DASHBOARD_TOUR_REPLAY_EVENT, replayRequested);
    };
  }, [replay]);

  return null;
}

export function DashboardTourIsland({
  tenantId,
  userId,
  role,
  viewerMode,
}: {
  tenantId?: string;
  userId?: string;
  role?: RoleKey | null;
  viewerMode?: boolean;
}): JSX.Element {
  return (
    <TourProvider
      tour="dashboard"
      tenantId={tenantId}
      userId={userId}
      role={role}
      viewerMode={viewerMode}
    >
      <DashboardTourReplayBridge />
      <TourLauncher />
    </TourProvider>
  );
}
