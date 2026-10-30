// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setOnlineStatusForTest } from "@/lib/online-manager";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  getApiUsageSummary: vi.fn(),
  getApiUsageKeys: vi.fn(),
  getApiUsageTimeseries: vi.fn(),
  getCostAggregate: vi.fn(),
  getCostLedgerPage: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));
vi.mock("@/lib/api-usage-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-usage-api")>()),
  getApiUsageSummary: mocks.getApiUsageSummary,
  getApiUsageKeys: mocks.getApiUsageKeys,
  getApiUsageTimeseries: mocks.getApiUsageTimeseries,
  getCostAggregate: mocks.getCostAggregate,
  getCostLedgerPage: mocks.getCostLedgerPage,
}));

import ApiUsagePage from "@/app/(dashboard)/app/api-usage/page";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-08-30T10:00:00Z";

function mount(): { root: Root; container: HTMLElement } {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(ApiUsagePage),
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

function ledgerRow(id: number) {
  return {
    id,
    apiKeyId: "12345678-1234-4234-8234-123456789abc",
    actorType: "api_key",
    kind: "ai_generation",
    cents: 25,
    quantity: 2,
    at: NOW,
  };
}

beforeEach(() => {
  // Manual "load more" is refused unless the app is known to be online.
  setOnlineStatusForTest("online");
  vi.clearAllMocks();
  mocks.whoami.mockResolvedValue({
    user_id: "user-1",
    tenant_id: "tenant-1",
    email: "qa@postwave.test",
    role: "admin",
  });
  mocks.getApiUsageSummary.mockResolvedValue({
    active_keys: 1,
    window_days: 30,
    total_sends: 100,
    total_cost_cents: 250,
    avg_sends_per_day: 3,
    avg_cost_cents_per_day: 8,
    projected_30d_sends: 100,
    projected_30d_cost_cents: 250,
    since: NOW,
  });
  mocks.getApiUsageKeys.mockResolvedValue({
    keys: [],
    count: 0,
    since: NOW,
    window_days: 30,
  });
  mocks.getApiUsageTimeseries.mockResolvedValue({
    points: [],
    window_days: 30,
  });
  mocks.getCostAggregate.mockResolvedValue({
    rows: [
      {
        apiKeyId: null,
        actorType: null,
        kind: "ai_generation",
        day: null,
        cents: 125,
        quantity: 10,
        count: 5,
      },
    ],
    since: NOW,
    group_by: "kind",
  });
  mocks.getCostLedgerPage.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  setOnlineStatusForTest("connecting");
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("API usage platform cost ledger", () => {
  it("renders measured aggregate success and keeps itemized reads opt-in", async () => {
    const { root, container } = mount();
    try {
      await waitFor(() => {
        expect(container.textContent).toContain("Platform cost ledger");
        expect(container.textContent).toContain("AI Generation");
        expect(container.textContent).toContain("$1.25");
      });
      expect(mocks.getCostAggregate).toHaveBeenCalledWith({
        since: "30d",
        groupBy: "kind",
        signal: expect.any(AbortSignal),
      });
      expect(mocks.getCostLedgerPage).not.toHaveBeenCalled();

      await act(async () => {
        button(container, "Show itemized ledger").click();
        await flush();
      });
      await waitFor(() => {
        expect(container.textContent).toContain(
          "The itemized ledger is verified empty for this window.",
        );
      });
      expect(mocks.getCostLedgerPage).toHaveBeenCalledWith({
        since: "30d",
        limit: 50,
        signal: expect.any(AbortSignal),
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("distinguishes aggregate loading, verified empty, and retryable failure", async () => {
    let release!: (value: {
      rows: never[];
      since: string;
      group_by: "kind";
    }) => void;
    mocks.getCostAggregate.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const loading = mount();
    try {
      await waitFor(() => {
        const section = loading.container.querySelector(
          '[role="region"][aria-labelledby="au-cost-ledger"]',
        );
        expect(
          section?.querySelector('[role="status"][aria-label="Loading"]'),
        ).not.toBeNull();
      });
      await act(async () => {
        release({ rows: [], since: NOW, group_by: "kind" });
        await flush();
      });
      await waitFor(() => {
        expect(loading.container.textContent).toContain("No metered costs");
      });
    } finally {
      act(() => loading.root.unmount());
    }

    mocks.getCostAggregate.mockClear();
    mocks.getCostAggregate
      .mockRejectedValueOnce(new Error("meter unavailable"))
      .mockResolvedValueOnce({
        rows: [],
        since: NOW,
        group_by: "kind",
      });
    const failure = mount();
    try {
      await waitFor(() => {
        expect(failure.container.textContent).toContain(
          "Cost aggregate could not be loaded",
        );
      });
      await act(async () => {
        button(failure.container, "Try again").click();
        await flush();
      });
      await waitFor(() => {
        expect(failure.container.textContent).toContain("No metered costs");
      });
      expect(mocks.getCostAggregate).toHaveBeenCalledTimes(2);
    } finally {
      act(() => failure.root.unmount());
    }
  });

  it("renders a retryable ledger failure without claiming an empty ledger", async () => {
    mocks.getCostLedgerPage
      .mockRejectedValueOnce(new Error("ledger unavailable"))
      .mockResolvedValueOnce({ rows: [ledgerRow(9)] });
    const { root, container } = mount();
    try {
      await waitFor(() => {
        expect(container.textContent).toContain("Platform cost ledger");
      });
      await act(async () => {
        button(container, "Show itemized ledger").click();
        await flush();
      });
      await waitFor(() => {
        expect(container.textContent).toContain(
          "Itemized cost ledger could not be loaded",
        );
        expect(container.textContent).not.toContain("verified empty");
      });
      await act(async () => {
        button(container, "Try again").click();
        await flush();
      });
      await waitFor(() => {
        expect(container.textContent).toContain("AI Generation");
        expect(container.textContent).toContain("Key 12345678…9abc");
      });
      expect(container.textContent).not.toContain(
        "12345678-1234-4234-8234-123456789abc",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("paginates with the verified cursor and de-duplicates overlapping rows", async () => {
    const first = Array.from({ length: 50 }, (_, index) =>
      ledgerRow(100 - index),
    );
    mocks.getCostLedgerPage
      .mockResolvedValueOnce({ rows: first, nextCursor: "51" })
      .mockResolvedValueOnce({ rows: [ledgerRow(51), ledgerRow(50)] });
    const { root, container } = mount();
    try {
      await waitFor(() => {
        expect(container.textContent).toContain("Platform cost ledger");
      });
      await act(async () => {
        button(container, "Show itemized ledger").click();
        await flush();
      });
      await waitFor(() => {
        expect(container.textContent).toContain("Load more entries");
      });
      await act(async () => {
        button(container, "Load more entries").click();
        await flush();
      });
      await waitFor(() => {
        expect(mocks.getCostLedgerPage).toHaveBeenLastCalledWith({
          since: "30d",
          limit: 50,
          cursor: "51",
          signal: expect.any(AbortSignal),
        });
        expect(container.textContent).not.toContain("Load more entries");
      });
      expect(container.querySelectorAll("tbody tr")).toHaveLength(52);
    } finally {
      act(() => root.unmount());
    }
  });
});
