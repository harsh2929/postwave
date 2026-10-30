// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";

import { SubscribersGrowthTrend } from "@/app/(dashboard)/app/subscribers/subscribers-growth-trend";
import {
  getSubscriberGrowth,
  type GrowthPoint,
} from "@/lib/subscriber-growth-api";
import { waitFor } from "../pages/_wait";

vi.mock("@/components/subscribers/directory-context", () => ({
  useDirectoryIdentity: () => ({ ready: true, tenantId: "qa", role: "owner" }),
}));
vi.mock("@/lib/subscriber-growth-api", () => ({
  getSubscriberGrowth: vi.fn(),
}));

let root: Root | undefined;
let client: QueryClient | undefined;
let host: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  client?.clear();
  host?.remove();
});

function point(total: number, date: string): GrowthPoint {
  return { total, date, added: 0, unsubbed: 0, lapsed: 0 };
}

async function render(series: GrowthPoint[], delta = 0, delta_pct = 0) {
  vi.mocked(getSubscriberGrowth).mockResolvedValue({
    days: 90,
    series,
    delta,
    delta_pct,
    total_added: 0,
    total_unsubbed: 0,
    unavailable_metrics: [],
    partial_metrics: [],
  });
  host = document.createElement("div");
  document.body.append(host);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client = queryClient;
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(SubscribersGrowthTrend),
      ),
    ),
  );
  await waitFor(() => expect(client?.isFetching()).toBe(0));
  return host;
}

it.each([{ series: [] }, { series: [point(50, "2026-10-24")] }])(
  "does not claim zero growth without comparable daily history: %j",
  async ({ series }) => {
    const el = await render(series);
    expect(el.textContent).toContain("Collecting daily history");
    expect(el.textContent).not.toContain("0.0%");
  },
);

it("shows the server's percentage without multiplying it again", async () => {
  const el = await render(
    [point(10, "2026-10-23"), point(12, "2026-10-24")],
    2,
    20,
  );
  expect(el.textContent).toContain("+2+20.0%");
  expect(el.querySelector('svg[role="img"]')).not.toBeNull();
});

it("does not invent a percentage when the starting audience was zero", async () => {
  const el = await render(
    [point(0, "2026-10-23"), point(50, "2026-10-24")],
    50,
    0,
  );
  expect(el.textContent).toContain("+50No starting audience");
  expect(el.textContent).not.toContain("0.0%");
});
