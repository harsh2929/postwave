// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  buildLookalike: vi.fn(),
  listRecipes: vi.fn(),
  listMembers: vi.fn(),
  comparePnl: vi.fn(),
  engagement: vi.fn(),
  growth: vi.fn(),
  listSaved: vi.fn(),
  patchSaved: vi.fn(),
  previewSaved: vi.fn(),
  listFolders: vi.fn(),
  createFolder: vi.fn(),
  renameFolder: vi.fn(),
  deleteFolder: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));
vi.mock("@/lib/data-operations-api", () => ({
  buildLookalikeAudience: mocks.buildLookalike,
}));
vi.mock("@/lib/segment-parity-api", () => ({
  MAX_COMPARE_SEGMENTS: 5,
  PRESET_MEMBER_PAGE_SIZE: 25,
  listPresetSegmentRecipes: mocks.listRecipes,
  listPresetSegmentMembers: mocks.listMembers,
  compareSegmentPnL: mocks.comparePnl,
  getSegmentEngagementMetrics: mocks.engagement,
  getSegmentGrowthMetrics: mocks.growth,
  listSavedSegmentBookmarks: mocks.listSaved,
  patchSavedSegmentBookmark: mocks.patchSaved,
  getSavedSegmentAggregatePreview: mocks.previewSaved,
  listStrictSegmentFolders: mocks.listFolders,
  createStrictSegmentFolder: mocks.createFolder,
  renameStrictSegmentFolder: mocks.renameFolder,
  deleteStrictSegmentFolder: mocks.deleteFolder,
}));

import { SegmentParitySuite } from "@/components/segments/segment-parity-suite";
import { NaturalLanguageCompiler } from "@/components/segments/nl-compiler";
import type { Segment } from "@/lib/segments-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-08-30T10:00:00Z";

function segments(count = 2): Segment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `segment-${index + 1}`,
    tenantId: "tenant-1",
    name: `Segment ${index + 1}`,
    description: "",
    queryAst: {
      op: "condition",
      field: "status",
      comparator: "equals",
      value: "enabled",
    },
    lastCount: 100 + index,
    createdAt: NOW,
    updatedAt: NOW,
  }));
}

function mount(
  overrides: Partial<Parameters<typeof SegmentParitySuite>[0]> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const props: Parameters<typeof SegmentParitySuite>[0] = {
    segments: segments(),
    tenantId: "tenant-1",
    role: "editor",
    identityReady: true,
    identityLoading: false,
    identityError: false,
    onRetryIdentity: vi.fn(),
    canMutate: true,
    ...overrides,
  };
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SegmentParitySuite, props),
      ),
    );
  });
  return { container, root, client, props };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await settle();
    }
  }
  throw lastError;
}

function button(name: RegExp, root: ParentNode = document): HTMLButtonElement {
  const match = [...root.querySelectorAll("button")].find((node) =>
    name.test(
      (
        node.textContent?.trim() ||
        node.getAttribute("aria-label") ||
        ""
      ).trim(),
    ),
  );
  if (!match) throw new Error(`Button not found: ${name}`);
  return match as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listRecipes.mockResolvedValue([]);
  mocks.listSaved.mockResolvedValue({
    items: [],
    totalItems: 0,
    maxItems: 200,
  });
  mocks.listFolders.mockResolvedValue([]);
  mocks.listMembers.mockResolvedValue({
    preset: "engaged_30d",
    label: "Engaged",
    members: [],
    limit: 25,
    offset: 0,
    hasNext: false,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SegmentParitySuite state and authorization wiring", () => {
  it("blocks tenant reads while identity loads and exposes identity retry on failure", () => {
    const loading = mount({ identityReady: false, identityLoading: true });
    expect(loading.container.textContent).toContain(
      "Loading workspace segment tools",
    );
    expect(mocks.listRecipes).not.toHaveBeenCalled();
    act(() => loading.root.unmount());

    const retryIdentity = vi.fn();
    const failed = mount({
      identityReady: false,
      identityError: true,
      onRetryIdentity: retryIdentity,
    });
    expect(
      failed.container.querySelector('[role="alert"]')?.textContent,
    ).toMatch(/identity could not be verified/u);
    act(() => button(/Retry identity/u, failed.container).click());
    expect(retryIdentity).toHaveBeenCalledOnce();
    act(() => failed.root.unmount());
  });

  it("distinguishes verified-empty reads and disables every organizer write for viewers", async () => {
    const view = mount({ canMutate: false, role: "viewer" });
    await waitFor(() => {
      expect(view.container.textContent).toContain(
        "No preset recipes are configured",
      );
      expect(view.container.textContent).toContain("verified empty library");
    });
    expect(view.container.textContent).toContain("Viewer mode is read-only");
    expect(button(/^Create lookalike$/u, view.container).disabled).toBe(true);
    expect(button(/^New folder$/u, view.container).disabled).toBe(true);
    act(() => view.root.unmount());
  });

  it("renames folders through the strict tenant-bound route and reads them back", async () => {
    mocks.listFolders.mockResolvedValue([
      { id: "11111111-1111-4111-8111-111111111111", name: "Leads" },
    ]);
    mocks.renameFolder.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Qualified leads",
    });
    const view = mount();
    await waitFor(() => expect(view.container.textContent).toContain("Leads"));
    act(() => button(/^Rename$/u, view.container).click());
    const input =
      document.querySelector<HTMLInputElement>("#saved-folder-name")!;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "Qualified leads");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => button(/^Save folder$/u).click());

    await waitFor(() => expect(mocks.renameFolder).toHaveBeenCalledOnce());
    expect(mocks.renameFolder).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "Qualified leads",
      "tenant-1",
    );
    await waitFor(() =>
      expect(mocks.listFolders.mock.calls.length).toBeGreaterThan(1),
    );
    await waitFor(() =>
      expect(document.querySelector('[role="dialog"]')).toBeNull(),
    );
    act(() => view.root.unmount());
  });

  it("keeps lookalike creation disabled until explicit data-use acknowledgement", async () => {
    mocks.buildLookalike.mockResolvedValue({
      id: "lookalike-1",
      name: "Lookalike of Segment 1",
      seed_segment_id: "segment-1",
      size_requested: 1000,
      member_count: 900,
      seed_count: 100,
      confidence_threshold: null,
      model_version: "v1",
      status: "ready",
      created_at: NOW,
      updated_at: NOW,
    });
    const view = mount();
    await settle();
    act(() => button(/^Create lookalike$/u, view.container).click());
    const dialog = document.querySelector('[role="dialog"]')!;
    const submit = button(/^Create audience$/u, dialog);
    expect(submit.disabled).toBe(true);
    const disclosure = dialog.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    act(() => disclosure.click());
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    await settle();
    expect(mocks.buildLookalike).toHaveBeenCalledWith(
      expect.objectContaining({
        seed_segment_id: "segment-1",
        size: 1000,
        data_use_acknowledged: true,
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(document.body.textContent).toContain(
      "900 of 1,000 requested members",
    );
    act(() => view.root.unmount());
  });

  it("reviews a preset before navigating to a seeded unsaved draft", async () => {
    mocks.listRecipes.mockResolvedValue([
      {
        key: "engaged_30d",
        label: "Engaged (30 days)",
        description: "opened or clicked in the last 30 days",
        count: 42,
      },
    ]);
    const view = mount();
    await waitFor(() =>
      expect(button(/^Review recipe$/u, view.container)).toBeTruthy(),
    );
    act(() => button(/^Review recipe$/u, view.container).click());
    const reviewDialog = document.querySelector('[role="dialog"]')!;
    expect(reviewDialog.textContent).toContain(
      "No segment will be created yet",
    );
    await act(async () =>
      button(/^Open reviewed draft$/u, reviewDialog).click(),
    );
    expect(mocks.push).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/app\/subscribers\/segments\/new\?seedName=Engaged%2B%252830%2Bdays%2529|^\/app\/subscribers\/segments\/new\?/u,
      ),
    );
    const destination = String(mocks.push.mock.calls[0]?.[0]);
    const params = new URL(destination, "https://postwave.test").searchParams;
    expect(params.get("seedName")).toBe("Engaged (30 days)");
    expect(params.get("seedDescription")).toBe(
      "opened or clicked in the last 30 days",
    );
    expect(params.get("seedNaturalLanguage")).toBe(
      "opened or clicked in the last 30 days",
    );
    act(() => view.root.unmount());
  });
});

describe("preset draft handoff", () => {
  it("prefills the natural-language compiler without compiling or saving", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onResult = vi.fn();
    act(() => {
      root.render(
        createElement(NaturalLanguageCompiler, {
          initialText: "opened or clicked in the last 30 days",
          onResult,
        }),
      );
    });
    await settle();
    expect(container.querySelector<HTMLInputElement>("#seg-nl")?.value).toBe(
      "opened or clicked in the last 30 days",
    );
    expect(onResult).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
