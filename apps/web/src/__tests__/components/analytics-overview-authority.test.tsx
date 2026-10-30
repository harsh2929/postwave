// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORDER = [
  "subscribers_total",
  "subscribers_added",
  "subscribers_unsubbed",
  "campaigns_sent",
  "opens",
  "clicks",
  "bounces",
  "active_sequences",
];

const IDENTITY = {
  user_id: "user-a",
  tenant_id: "tenant-a",
  email: "owner@example.com",
  role: "admin" as const,
  effective_role: "admin" as const,
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "A",
  workspace_slug: "a",
};

const mocks = vi.hoisted(() => ({
  getLayout: vi.fn(),
  putLayout: vi.fn(),
  whoamiFresh: vi.fn(),
}));

vi.mock("@/lib/use-online", () => ({ useOnline: () => "online" }));
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoamiFresh: mocks.whoamiFresh,
}));
vi.mock("@/lib/analytics-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics-api")>()),
  getLayout: mocks.getLayout,
  putLayout: mocks.putLayout,
  getBenchmarks: vi.fn().mockResolvedValue({ rows: [], note: "" }),
  getSubscriberTimeseries: vi
    .fn()
    .mockResolvedValue({ range: "30d", points: [] }),
  listAnomalies: vi.fn().mockResolvedValue({ items: [] }),
  compareCampaigns: vi.fn().mockResolvedValue([]),
  getDigestPrefs: vi.fn().mockResolvedValue({ frequency: "off" }),
}));
vi.mock("@/lib/mailchimp-compat-api", () => ({
  getMailchimpCompatSummary: vi.fn().mockResolvedValue({
    ecommerce: {
      integrations: 0,
      revenue_cents: 0,
      attributed_revenue_cents: 0,
    },
  }),
  runInlineAI: vi.fn(),
}));
vi.mock("@/lib/campaigns-api", () => ({
  listCampaigns: vi.fn().mockResolvedValue([]),
}));

import { AnalyticsOverview } from "@/app/(dashboard)/app/analytics/_overview";

const stats = {
  subscribers_total: 12,
  subscribers_added_30d: 3,
  subscribers_unsubbed_30d: 1,
  campaigns_sent_30d: 2,
  opens_total_30d: 8,
  clicks_total_30d: 4,
  bounces_total_30d: 1,
};

function render(ui: ReactNode): {
  root: Root;
  rerender: (next: ReactNode) => void;
} {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const wrap = (node: ReactNode) =>
    createElement(QueryClientProvider, { client }, node);
  act(() => root.render(wrap(ui)));
  return {
    root,
    rerender: (next) => act(() => root.render(wrap(next))),
  };
}

function overview(
  overrides: { role?: "admin" | "viewer"; viewerMode?: boolean } = {},
) {
  return createElement(AnalyticsOverview, {
    stats,
    loading: false,
    tenantId: "tenant-a",
    role: overrides.role ?? "admin",
    userId: "user-a",
    viewerMode: overrides.viewerMode ?? false,
    range: "30d",
    mounted: true,
  });
}

function button(name: string): HTMLButtonElement {
  const result = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!(result instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${name}`);
  }
  return result;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let error: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (next) {
      error = next;
      await flush();
    }
  }
  throw error;
}

// The Overview's desktop-parity panels (sequence funnel, reply series, …) read
// through @/lib/api → global fetch rather than the modules mocked above.
// Answer them with a 404 so the test never reaches the real network.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ error: { code: "not_found", message: "" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
    ),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("analytics overview authority", () => {
  it("locks a double click, verifies fresh authority, and confirms the write", async () => {
    mocks.getLayout.mockResolvedValue({ order: ORDER });
    mocks.putLayout.mockResolvedValue({ ok: true });
    mocks.whoamiFresh.mockResolvedValue(IDENTITY);
    const { root } = render(overview());

    try {
      await waitFor(() => expect(button("Customize").disabled).toBe(false));
      act(() => button("Customize").click());
      const save = button("Save layout");
      act(() => {
        save.click();
        save.click();
      });
      await waitFor(() => expect(mocks.putLayout).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(document.querySelector('[role="region"]')).toBeNull(),
      );

      expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1);
      expect(mocks.getLayout).toHaveBeenCalledTimes(2);
      expect(Object.isFrozen(mocks.putLayout.mock.calls[0]?.[0])).toBe(true);
      expect(mocks.putLayout.mock.calls[0]?.[1]).toEqual(
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          idempotencyKey: expect.stringMatching(/^analytics-layout:/),
        }),
      );
      expect(mocks.getLayout.mock.calls[1]?.[0]).toEqual(
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          requireOnline: true,
          maxAttempts: 1,
        }),
      );
      expect(mocks.whoamiFresh.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.putLayout.mock.invocationCallOrder[0]!,
      );
      expect(mocks.putLayout.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.getLayout.mock.invocationCallOrder[1]!,
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("makes viewer mode visibly read-only with zero fresh-auth or write calls", async () => {
    mocks.getLayout.mockResolvedValue({ order: ORDER });
    const { root } = render(overview({ role: "viewer", viewerMode: true }));
    try {
      await flush();
      expect(button("Customize").disabled).toBe(true);
      expect(document.body.textContent).toContain("Viewer mode is read-only");
      expect(button("Generate summary").disabled).toBe(true);
      expect(mocks.whoamiFresh).not.toHaveBeenCalled();
      expect(mocks.putLayout).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("refuses a fresh downgrade before the layout PUT", async () => {
    mocks.getLayout.mockResolvedValue({ order: ORDER });
    mocks.whoamiFresh.mockResolvedValue({
      ...IDENTITY,
      effective_role: "viewer",
      viewer_mode: true,
    });
    const { root } = render(overview());
    try {
      await waitFor(() => expect(button("Customize").disabled).toBe(false));
      act(() => button("Customize").click());
      act(() => button("Save layout").click());
      await waitFor(() =>
        expect(document.body.textContent).toContain("access changed"),
      );
      expect(mocks.putLayout).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("reuses one idempotency identity after an ambiguous layout failure", async () => {
    mocks.getLayout.mockResolvedValue({ order: ORDER });
    mocks.putLayout
      .mockRejectedValueOnce(new Error("network response lost"))
      .mockResolvedValueOnce({ ok: true });
    mocks.whoamiFresh.mockResolvedValue(IDENTITY);
    const { root } = render(overview());
    try {
      await waitFor(() => expect(button("Customize").disabled).toBe(false));
      act(() => button("Customize").click());
      act(() => button("Save layout").click());
      await waitFor(() =>
        expect(document.body.textContent).toContain("network response lost"),
      );
      act(() => button("Save layout").click());
      await waitFor(() => expect(mocks.putLayout).toHaveBeenCalledTimes(2));

      expect(mocks.putLayout.mock.calls[0]?.[1]?.idempotencyKey).toBe(
        mocks.putLayout.mock.calls[1]?.[1]?.idempotencyKey,
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("aborts a late authority check and never writes after identity changes", async () => {
    mocks.getLayout.mockResolvedValue({ order: ORDER });
    let resolveFresh: ((value: typeof IDENTITY) => void) | undefined;
    mocks.whoamiFresh.mockImplementation(
      () =>
        new Promise<typeof IDENTITY>((resolve) => {
          resolveFresh = resolve;
        }),
    );
    const { root, rerender } = render(overview());
    try {
      await waitFor(() => expect(button("Customize").disabled).toBe(false));
      act(() => button("Customize").click());
      act(() => button("Save layout").click());
      await waitFor(() => expect(mocks.whoamiFresh).toHaveBeenCalledTimes(1));
      const signal = mocks.whoamiFresh.mock.calls[0]?.[0] as AbortSignal;

      rerender(overview({ role: "viewer", viewerMode: true }));
      expect(signal.aborted).toBe(true);
      await act(async () => {
        resolveFresh?.(IDENTITY);
        await flush();
      });
      expect(mocks.putLayout).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
