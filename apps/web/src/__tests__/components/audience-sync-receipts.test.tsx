// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AudienceSyncsPage from "@/app/(dashboard)/app/audience-syncs/page";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  listSyncs: vi.fn(),
  listRuns: vi.fn(),
  preview: vi.fn(),
  getReceipt: vi.fn(),
  download: vi.fn(),
}));

vi.mock("@/lib/auth-api", () => ({
  whoami: mocks.whoami,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));
vi.mock("@/lib/forms-api", () => ({
  listLists: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/segments-api", () => ({
  listSegments: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/use-online", () => ({ useOnline: () => "online" }));
vi.mock("@/lib/download", () => ({ downloadTextFile: mocks.download }));
vi.mock("@/lib/audience-syncs-api", () => ({
  listAudienceSyncs: mocks.listSyncs,
  listAudienceSyncRuns: mocks.listRuns,
  previewAudienceSyncExclusions: mocks.preview,
  getExclusionReceipt: mocks.getReceipt,
  createAudienceSync: vi.fn(),
  updateAudienceSync: vi.fn(),
  deleteAudienceSync: vi.fn(),
  runAudienceSync: vi.fn(),
}));

// happy-dom does not hydrate Next's `{ ssr: false }` boundary. Substitute the
// real deferred manager at that boundary so this suite exercises inventory,
// history, and receipt authority behavior while the production route remains
// lazy-loaded.
vi.mock("next/dynamic", async () => {
  const { AudienceSyncsManager } =
    await import("@/app/(dashboard)/app/audience-syncs/audience-syncs-manager");
  return { default: () => AudienceSyncsManager };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LIST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SYNC = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RUN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = "2026-08-25T12:00:00Z";

function render(ui: ReactNode): { root: Root; queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, ui),
    );
  });
  return { root, queryClient };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.requestAnimationFrame(resolve));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
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

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(label),
  );
}

beforeEach(() => {
  mocks.whoami.mockResolvedValue({
    user_id: USER,
    tenant_id: TENANT,
    email: "ada@example.com",
    role: "admin",
    effective_role: "admin",
  });
  mocks.listSyncs.mockResolvedValue([
    {
      id: SYNC,
      name: "Weekly purchasers",
      source: { list_id: LIST },
      destination: {
        type: "webhook",
        url: "https://receiver.example/import",
        url_redacted: false,
        secret_set: true,
        config: {},
        credential_reference_set: false,
      },
      schedule: "manual",
      enabled: true,
      last_run_at: NOW,
      last_run_status: "succeeded",
      created_at: NOW,
      updated_at: NOW,
    },
  ]);
  mocks.listRuns.mockResolvedValue([
    {
      id: RUN,
      sync_id: SYNC,
      status: "succeeded",
      rows_exported: 142,
      batches_sent: 2,
      started_at: NOW,
      finished_at: NOW,
      trigger_kind: "manual",
      source_members_observed: 149,
      cap_exceeded: false,
      excluded_count: 7,
    },
  ]);
  mocks.preview.mockResolvedValue({
    audience_count: 149,
    excluded_consent: 4,
    excluded_suppression: 3,
    excluded_total: 7,
    purpose: "targeted_ads",
    computed_at: NOW,
    available: true,
  });
  mocks.getReceipt.mockResolvedValue({
    run_id: RUN,
    csv: "header\nrow\n",
    excluded_rows: 1,
    signature: `t=1,v1=${"a".repeat(64)}`,
    filename: `exclusion-receipt-${RUN}.csv`,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("audience sync run and receipt disclosure", () => {
  it("defers history and PII receipt requests until explicit actions", async () => {
    const { root } = render(createElement(AudienceSyncsPage));
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Weekly purchasers");
      });
      expect(mocks.listRuns).not.toHaveBeenCalled();
      expect(mocks.preview).not.toHaveBeenCalled();
      expect(mocks.getReceipt).not.toHaveBeenCalled();

      await act(async () => button("History")?.click());
      await waitFor(() => {
        expect(mocks.listRuns).toHaveBeenCalledWith(
          SYNC,
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(mocks.preview).toHaveBeenCalled();
        expect(document.body.textContent).toContain("142 exported");
        expect(document.body.textContent).toContain("7 excluded");
      });
      expect(mocks.getReceipt).not.toHaveBeenCalled();

      await act(async () => button("Signed receipt")?.click());
      await waitFor(() => {
        expect(mocks.getReceipt).toHaveBeenCalledWith(
          RUN,
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
        expect(mocks.download).toHaveBeenCalledWith(
          `exclusion-receipt-${RUN}.csv`,
          "header\nrow\n",
          "text/csv;charset=utf-8",
        );
        expect(mocks.whoami).toHaveBeenCalledTimes(3);
      });
      expect(document.body.textContent).not.toContain("header");
      expect(document.body.textContent).not.toContain("header\nrow");
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps run-history and explicit unavailable-preview failures distinct from empty", async () => {
    mocks.listRuns.mockRejectedValueOnce(new Error("run history unavailable"));
    mocks.preview.mockResolvedValueOnce({
      audience_count: -1,
      excluded_consent: -1,
      excluded_suppression: -1,
      excluded_total: -1,
      purpose: "targeted_ads",
      computed_at: NOW,
      available: false,
    });
    const { root } = render(createElement(AudienceSyncsPage));
    try {
      await waitFor(() => {
        expect(document.body.textContent).toContain("Weekly purchasers");
      });
      await act(async () => button("History")?.click());
      await waitFor(() => {
        expect(document.body.textContent).toContain(
          "Run history could not be loaded",
        );
        expect(document.body.textContent).toContain(
          "Source counts unavailable",
        );
      });
      expect(document.body.textContent).not.toContain(
        "Verified empty run history",
      );
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("audience sync webhook creation", () => {
  it("offers the required receiver and write-only HMAC fields for a new sync", async () => {
    mocks.listSyncs.mockResolvedValue([]);
    const { root, queryClient } = render(createElement(AudienceSyncsPage));
    try {
      await waitFor(() => expect(button("New sync")).toBeTruthy());
      await act(async () => button("New sync")!.click());
      await waitFor(() => {
        expect(document.querySelector("input#sync-url")).not.toBeNull();
        expect(document.querySelector("input#sync-secret")).not.toBeNull();
      });
      const url = document.querySelector<HTMLInputElement>("input#sync-url")!;
      const secret =
        document.querySelector<HTMLInputElement>("input#sync-secret")!;
      expect(url.required).toBe(true);
      expect(url.type).toBe("url");
      expect(secret.required).toBe(true);
      expect(secret.type).toBe("password");
      expect(secret.minLength).toBe(16);
      expect(secret.value).toBe("");
      expect(document.body.textContent).not.toContain(
        "This legacy platform sync row",
      );
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  });
});
