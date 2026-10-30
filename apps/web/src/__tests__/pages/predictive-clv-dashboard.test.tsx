// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  getClvDashboard: vi.fn(),
  getDataSufficiency: vi.fn(),
  getPredictiveCatalog: vi.fn(),
  listPredictiveProfiles: vi.fn(),
  listRfmSegments: vi.fn(),
}));

vi.mock("@/lib/auth-api", () => ({ whoami: mocks.whoami }));
vi.mock("@/lib/predictive-api", () => ({
  getClvDashboard: mocks.getClvDashboard,
  getDataSufficiency: mocks.getDataSufficiency,
  getPredictiveCatalog: mocks.getPredictiveCatalog,
  listPredictiveProfiles: mocks.listPredictiveProfiles,
  listRfmSegments: mocks.listRfmSegments,
  partialModels: () => [],
  placeholderCount: () => 0,
  predictionIsPlaceholder: () => false,
}));

import PredictivePage from "@/app/(dashboard)/app/predictive/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-08-30T10:00:00Z";

function snapshot(profileCount = 3) {
  return {
    profile_count: profileCount,
    scored_profiles: profileCount === 0 ? 0 : 2,
    total_clv_cents: profileCount === 0 ? 0 : 12_000,
    predicted_clv_cents: profileCount === 0 ? 0 : 4_000,
    avg_total_clv_cents: profileCount === 0 ? 0 : 4_000,
    percentiles: {
      p10_cents: profileCount === 0 ? 0 : 100,
      p25_cents: profileCount === 0 ? 0 : 500,
      p50_cents: profileCount === 0 ? 0 : 2_000,
      p75_cents: profileCount === 0 ? 0 : 5_000,
      p90_cents: profileCount === 0 ? 0 : 8_000,
      p99_cents: profileCount === 0 ? 0 : 10_000,
    },
    tiers:
      profileCount === 0
        ? []
        : [
            {
              key: "champions",
              label: "Champions",
              profiles: 1,
              avg_total_clv_cents: 8_000,
              avg_churn_risk: 0.1,
            },
            {
              key: "at_risk",
              label: "At risk",
              profiles: 2,
              avg_total_clv_cents: 2_000,
              avg_churn_risk: 0.7,
            },
          ],
    last_calculated_at: profileCount === 0 ? null : NOW,
  };
}

function mount(): { root: Root; container: HTMLElement } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(PredictivePage),
      ),
    );
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
  mocks.whoami.mockResolvedValue({
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "qa@postwave.test",
    role: "admin",
  });
  mocks.getPredictiveCatalog.mockResolvedValue({ models: [] });
  mocks.getDataSufficiency.mockResolvedValue({
    insufficient: { count: 0, percentage: 0 },
    limited: { count: 0, percentage: 0 },
    sufficient: { count: 0, percentage: 0 },
    total: 0,
    last_updated: null,
  });
  mocks.listPredictiveProfiles.mockResolvedValue([]);
  mocks.listRfmSegments.mockResolvedValue([]);
  mocks.getClvDashboard.mockResolvedValue(snapshot());
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("predictive aggregate CLV dashboard", () => {
  it("renders aggregate projections and states the identity-minimization boundary", async () => {
    const { root, container } = mount();
    try {
      await waitFor(() => {
        expect(container.textContent).toContain("Predicted customer value");
        expect(container.textContent).toContain("Modeled total");
        expect(container.textContent).toContain("$120");
        expect(container.textContent).toContain("Value distribution");
        expect(container.textContent).toContain("Champions");
        expect(container.textContent).toContain(
          "Aggregate-only request; subscriber preview identities were not transferred.",
        );
      });
      expect(mocks.getClvDashboard).toHaveBeenCalledWith(
        expect.any(AbortSignal),
      );
      expect(container.textContent).not.toContain("private@example.test");
    } finally {
      act(() => root.unmount());
    }
  });

  it("withholds aggregate model defaults when every profile is insufficient", async () => {
    mocks.getClvDashboard.mockResolvedValue({
      ...snapshot(),
      scored_profiles: 0,
    });
    const { root, container } = mount();
    try {
      await waitFor(() =>
        expect(container.textContent).toContain(
          "Not enough evidence to estimate customer value",
        ),
      );
      expect(container.textContent).not.toContain("Modeled total");
      expect(container.textContent).not.toContain("projected churn");
      expect(container.querySelector("#pr-clv-tiers")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("distinguishes loading from a verified empty snapshot", async () => {
    let release!: (value: ReturnType<typeof snapshot>) => void;
    mocks.getClvDashboard.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { root, container } = mount();
    try {
      await waitFor(() => {
        expect(
          container.querySelector(
            '[role="status"][aria-label="Loading customer-value distribution"]',
          ),
        ).not.toBeNull();
      });
      await act(async () => {
        release(snapshot(0));
        await flush();
      });
      await waitFor(() => {
        expect(container.textContent).toContain(
          "No customer-value snapshot yet",
        );
      });
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders a failed aggregate read as retryable instead of inferred zero", async () => {
    mocks.getClvDashboard
      .mockRejectedValueOnce(new Error("CLV unavailable"))
      .mockResolvedValueOnce(snapshot());
    const { root, container } = mount();
    try {
      await waitFor(() => {
        expect(container.textContent).toContain(
          "Customer-value distribution could not be verified",
        );
        expect(container.textContent).not.toContain(
          "No customer-value snapshot yet",
        );
      });
      await act(async () => {
        button(container, "Retry").click();
        await flush();
      });
      await waitFor(() => {
        expect(container.textContent).toContain("Modeled total");
        expect(container.textContent).toContain("$120");
      });
      expect(mocks.getClvDashboard).toHaveBeenCalledTimes(2);
    } finally {
      act(() => root.unmount());
    }
  });
});
