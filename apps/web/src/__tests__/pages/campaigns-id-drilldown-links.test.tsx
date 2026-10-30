// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// analytics-48 — the campaign workspace reaches its drill-downs (analytics
// report, languages, activity & insights, UTM) from the route entry, so each is
// reachable while the editor itself is still loading.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@/app/(dashboard)/app/campaigns/[id]/campaign-detail-client-loader",
  () => ({ CampaignDetailClientLoader: () => null }),
);

import CampaignDetailPage from "@/app/(dashboard)/app/campaigns/[id]/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function renderPage(id: string) {
  const element = await CampaignDetailPage({ params: Promise.resolve({ id }) });
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });
  return container;
}

function linkNamed(container: HTMLElement, name: string) {
  return [...container.querySelectorAll("a")].find(
    (a) => a.textContent?.trim() === name,
  );
}

describe("campaign detail drill-down links", () => {
  it("links the analytics report and the other drill-downs for this campaign, encoding the id", async () => {
    const container = await renderPage("c 1/x");
    expect(linkNamed(container, "Analytics report")?.getAttribute("href")).toBe(
      "/app/campaigns/c%201%2Fx/analytics",
    );
    expect(linkNamed(container, "Languages")?.getAttribute("href")).toBe(
      "/app/campaigns/c%201%2Fx/translations",
    );
    expect(
      linkNamed(container, "Activity & insights")?.getAttribute("href"),
    ).toBe("/app/campaigns/c%201%2Fx/activity");
    expect(linkNamed(container, "UTM tracking")?.getAttribute("href")).toBe(
      "/app/campaigns/c%201%2Fx/utm",
    );
  });
});
