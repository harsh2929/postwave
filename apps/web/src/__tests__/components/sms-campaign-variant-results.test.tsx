// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSmsCampaignVariants: vi.fn(),
}));

vi.mock("@/lib/sms-api", () => ({
  listSmsCampaignVariants: mocks.listSmsCampaignVariants,
}));

import { CampaignReportPanel } from "@/app/(dashboard)/app/sms/campaign-report-panel";
import type { SmsCampaignReport } from "@/lib/sms-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const report: SmsCampaignReport = {
  campaign: {
    id: "campaign-1",
    name: "Launch SMS",
    body: "Hello",
    status: "sent",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-30T00:00:00Z",
  },
  recipients: 10,
  queued: 0,
  sending: 0,
  sent: 10,
  blocked: 0,
  failed: 0,
  cancelled: 0,
  delivered: 9,
  undelivered: 1,
  clicks: 2,
  unique_clickers: 2,
  segments: 1,
  cost_micros: 100_000,
  status_counts: {},
};

const variants = [
  {
    variant: "A",
    total: 5,
    sent: 5,
    failed: 0,
    blocked: 0,
    segments: 1,
    cost_micros: 50_000,
  },
  {
    variant: "B",
    total: 5,
    sent: 4,
    failed: 1,
    blocked: 0,
    segments: 1,
    cost_micros: 50_000,
  },
];

function mount(): { root: Root; container: HTMLElement } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(CampaignReportPanel, { report }));
  });
  return { root, container };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => flush());
    }
  }
  throw lastError;
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSmsCampaignVariants.mockResolvedValue(variants);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("SMS campaign A/B variant results", () => {
  it("renders a loading state and then verified variant performance", async () => {
    let release!: (value: typeof variants) => void;
    mocks.listSmsCampaignVariants.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { root, container } = mount();
    try {
      expect(container.querySelector('[role="status"]')?.textContent).toMatch(
        /Loading A\/B variant results/iu,
      );

      await act(async () => {
        release(variants);
        await flush();
      });
      await waitFor(() => {
        expect(container.textContent).toContain("A/B variant results");
        expect(container.textContent).toContain("Variant A");
        expect(container.textContent).toContain("Variant B");
        expect(container.textContent).toContain("Leading");
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps a verified non-A/B campaign empty without an error", async () => {
    mocks.listSmsCampaignVariants.mockResolvedValueOnce([]);
    const { root, container } = mount();
    try {
      await waitFor(() => {
        expect(mocks.listSmsCampaignVariants).toHaveBeenCalledWith(
          "campaign-1",
          expect.any(AbortSignal),
        );
        expect(container.querySelector('[role="status"]')).toBeNull();
      });
      expect(container.textContent).not.toContain("A/B variant results");
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders a failed variant read as retryable rather than verified empty", async () => {
    mocks.listSmsCampaignVariants
      .mockRejectedValueOnce(new Error("variants unavailable"))
      .mockResolvedValueOnce(variants);
    const { root, container } = mount();
    try {
      await waitFor(() => {
        expect(container.querySelector('[role="alert"]')?.textContent).toMatch(
          /variant results could not be verified/iu,
        );
        expect(container.textContent).not.toContain("Variant A");
      });
      await act(async () => {
        button(container, "Retry").click();
        await flush();
      });
      await waitFor(() => {
        expect(container.textContent).toContain("Variant A");
        expect(container.querySelector('[role="alert"]')).toBeNull();
      });
      expect(mocks.listSmsCampaignVariants).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
    }
  });
});
