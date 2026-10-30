// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TemplateOutcomesPanel } from "@/app/(dashboard)/app/templates/_components/template-outcomes-panel";

const mocks = vi.hoisted(() => ({ report: vi.fn() }));
vi.mock("@/lib/campaign-analytics-api", () => ({ getCampaignReport: mocks.report }));
vi.mock("next/link", async () => {
  const React = await import("react");
  return { default: ({ href, children }: { href: string; children: React.ReactNode }) => React.createElement("a", { href }, children) };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("template outcome panel", () => {
  it("loads only on request, caps reports, and labels observed—not causal—outcomes", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mocks.report.mockImplementation(async (id: string) => ({
      campaign_id: id,
      delivered: 100,
      unique_opens: 40,
      unique_clicks: 10,
    }));
    await act(async () => root.render(createElement(TemplateOutcomesPanel, {
      campaigns: Array.from({ length: 10 }, (_, index) => ({ id: `campaign-${index}`, name: `Campaign ${index}` })),
    })));
    expect(mocks.report).not.toHaveBeenCalled();
    const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.includes("Load outcomes"));
    await act(async () => button?.click());
    expect(mocks.report).toHaveBeenCalledTimes(8);
    expect(host.textContent).toContain("800");
    expect(host.textContent).toContain("80");
    expect(host.textContent).toContain("do not measure the template’s causal impact");
    await act(async () => root.unmount());
  });

  it("excludes failed and mismatched reports rather than presenting zeroes", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    mocks.report.mockImplementation(async (id: string) => {
      if (id === "campaign-b") throw new Error("Report unavailable");
      return { campaign_id: id === "campaign-c" ? "different" : id, delivered: 50, unique_opens: 20, unique_clicks: 5 };
    });
    await act(async () => root.render(createElement(TemplateOutcomesPanel, {
      campaigns: ["campaign-a", "campaign-b", "campaign-c"].map((id) => ({ id, name: id })),
    })));
    await act(async () => host.querySelector("button")?.click());
    expect(host.textContent).toContain("2 reports unavailable");
    expect(host.textContent).toContain("Across 1 report.");
    expect(host.textContent).toContain("50");
    await act(async () => root.unmount());
  });
});
