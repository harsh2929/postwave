// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardTourIsland } from "@/components/tour/dashboard-tour-island";
import {
  consumePendingDashboardTourReplay,
  requestDashboardTourReplay,
} from "@/components/tour/dashboard-tour-events";

const mocks = vi.hoisted(() => ({ replay: vi.fn(), providerProps: vi.fn() }));

vi.mock("@/components/tour/TourProvider", () => ({
  TourProvider: (props: { children: ReactNode }) => {
    mocks.providerProps(props);
    return createElement(
      "div",
      { "data-testid": "tour-provider" },
      props.children,
    );
  },
  useTour: () => ({ replay: mocks.replay }),
}));

vi.mock("@/components/tour/TourLauncher", () => ({
  TourLauncher: () =>
    createElement("button", { "aria-label": "Open product tour menu" }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  mocks.replay.mockReset();
  mocks.providerProps.mockReset();
  consumePendingDashboardTourReplay();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  consumePendingDashboardTourReplay();
});

describe("dashboard tour lazy island", () => {
  it("replays live requests and claims a request made before it mounts", async () => {
    // Settings may hydrate before the island chunk. That first click must not
    // disappear while the client-only boundary is still loading.
    requestDashboardTourReplay();

    await act(async () => {
      root?.render(
        createElement(DashboardTourIsland, {
          tenantId: "tenant_123",
          userId: "user_456",
          role: "viewer",
          viewerMode: true,
        }),
      );
    });

    expect(mocks.replay).toHaveBeenCalledTimes(1);
    expect(mocks.providerProps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tour: "dashboard",
        tenantId: "tenant_123",
        userId: "user_456",
        role: "viewer",
        viewerMode: true,
      }),
    );
    expect(
      container?.querySelector('[aria-label="Open product tour menu"]'),
    ).not.toBeNull();

    act(() => requestDashboardTourReplay());
    expect(mocks.replay).toHaveBeenCalledTimes(2);

    await act(async () => root?.unmount());
    root = null;
    requestDashboardTourReplay();
    expect(mocks.replay).toHaveBeenCalledTimes(2);
    expect(consumePendingDashboardTourReplay()).toBe(true);
  });
});
