// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("@/lib/auth-api", () => ({
  whoami: async () => ({ tenant_id: "tenant", role: "admin" }),
}));
vi.mock("@/lib/human-engaged-reach", async (original) => ({
  ...(await original<typeof import("@/lib/human-engaged-reach")>()),
  getHumanEngagedReach: mocks.read,
}));
import { HumanEngagedReachPanel } from "@/components/analytics/human-engaged-reach-panel";

it("requests the selected date window and preserves release refusal instead of showing zero", async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.read.mockRejectedValue(
    new Error("Calibration release is unavailable."),
  );
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  try {
    for (const days of [7, 30, 90] as const) {
      await act(async () =>
        root.render(
          createElement(
            QueryClientProvider,
            { client },
            createElement(HumanEngagedReachPanel, { days }),
          ),
        ),
      );
      for (let n = 0; n < 30; n++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        if (host.textContent?.includes("Calibration release is unavailable."))
          break;
      }
      const request = mocks.read.mock.calls.at(-1)?.[0];
      expect(Date.parse(request.until) - Date.parse(request.since)).toBe(
        days * 86400000,
      );
      expect(request.signal).toBeInstanceOf(AbortSignal);
      expect(host.textContent).toContain(`Last ${days} days.`);
      expect(host.textContent).toContain("no released measurement was made");
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});
