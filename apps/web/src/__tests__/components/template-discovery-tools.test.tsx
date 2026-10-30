// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TemplateDiscoveryTools,
  removeObsoleteSavedSearchFilterPairs,
} from "@/app/(dashboard)/app/templates/_components/template-discovery-tools";
import { TemplateViewRecorder } from "@/app/(dashboard)/app/templates/_components/template-view-recorder";
import { ApiError } from "@/lib/api";
import type {
  CampaignTemplateSavedSearch,
  CampaignTemplateSavedSearchFilters,
  CampaignTemplateSummary,
} from "@/lib/campaign-templates-api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  listRecent: vi.fn(),
  clearRecent: vi.fn(),
  listCollections: vi.fn(),
  listSaved: vi.fn(),
  createSaved: vi.fn(),
  updateSaved: vi.fn(),
  compare: vi.fn(),
  recordView: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/campaign-templates-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/campaign-templates-api")>();
  return {
    ...actual,
    listRecentCampaignTemplateViews: mocks.listRecent,
    clearRecentCampaignTemplateViews: mocks.clearRecent,
    listCampaignTemplateCollections: mocks.listCollections,
    listCampaignTemplateSavedSearches: mocks.listSaved,
    createCampaignTemplateSavedSearch: mocks.createSaved,
    updateCampaignTemplateSavedSearch: mocks.updateSaved,
    compareCampaignTemplates: mocks.compare,
    recordCampaignTemplateView: mocks.recordView,
  };
});

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const template = (id: string, name: string): CampaignTemplateSummary => ({
  id,
  name,
  subject: `${name} subject`,
  tags: [],
  goal: "newsletter",
  style: "editorial",
  industry: "media",
  layout_archetype: "digest",
  quality_score: 0.86,
});

const savedSearch = (
  id: string,
  name: string,
): CampaignTemplateSavedSearch => ({
  id,
  name,
  filters: { goal: "newsletter", style: "minimal" },
  created_at: "2026-07-30T00:00:00Z",
  updated_at: "2026-07-30T00:00:00Z",
  version: 1,
  etag: `"campaign-template-saved-search:${id}:v1"`,
});

function renderDiscovery(
  compareSelection: CampaignTemplateSummary[] = [],
  options: {
    onRemoveCompare?: (id: string) => void;
    currentFilters?: CampaignTemplateSavedSearchFilters;
    onApplySavedSearch?: (filters: CampaignTemplateSavedSearchFilters) => void;
  } = {},
): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(TemplateDiscoveryTools, {
        currentFilters: options.currentFilters ?? {
          goal: "newsletter",
          style: "minimal",
        },
        compareSelection,
        organizerTemplate: null,
        onRemoveCompare: options.onRemoveCompare ?? vi.fn(),
        onClearCompare: vi.fn(),
        onOrganizerTemplateChange: vi.fn(),
        onApplySavedSearch: options.onApplySavedSearch ?? vi.fn(),
      }),
    );
  });
  return root;
}

function button(text: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }
  return match;
}

function click(target: Element): void {
  act(() => {
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

function setValue(target: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  mocks.listRecent.mockResolvedValue([]);
  mocks.clearRecent.mockResolvedValue({ ok: true, cleared: 0 });
  mocks.listCollections.mockResolvedValue([]);
  mocks.listSaved.mockResolvedValue([]);
  mocks.compare.mockResolvedValue({
    items: [],
    unavailable_identifiers: [],
  });
  mocks.recordView.mockResolvedValue({});
  mocks.updateSaved.mockImplementation(
    async (
      current: CampaignTemplateSavedSearch,
      input: Partial<CampaignTemplateSavedSearch>,
    ) => ({
      ...current,
      ...input,
      version: current.version + 1,
      etag: `"campaign-template-saved-search:${current.id}:v${
        current.version + 1
      }"`,
    }),
  );
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("template discovery tools", () => {
  it("loads a private Recent view and explains its empty state", async () => {
    const recentTemplate = template("recent-1", "Weekly Signal");
    mocks.listRecent.mockResolvedValue([
      {
        template: recentTemplate,
        view_count: 2,
        first_viewed_at: "2026-07-29T00:00:00Z",
        last_viewed_at: "2026-07-30T00:00:00Z",
      },
    ]);
    const root = renderDiscovery();

    try {
      click(button("Recent"));
      await flush();

      expect(mocks.listRecent).toHaveBeenCalledWith(
        50,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(document.body.textContent).toContain("Recently viewed designs");
      expect(document.body.textContent).toContain("Weekly Signal");
      expect(document.body.textContent).toContain("Viewed 2×");
    } finally {
      act(() => root.unmount());
    }
  });

  it("renders an accessible comparison matrix for two selected templates", async () => {
    const one = template("one", "One");
    const two = template("two", "Two");
    mocks.compare.mockResolvedValue({
      items: [
        { requested_identifier: "one", matched_by: "id", template: one },
        { requested_identifier: "two", matched_by: "id", template: two },
      ],
      unavailable_identifiers: [],
    });
    mocks.listCollections.mockResolvedValue([
      {
        id: "collection-1",
        name: "Editorial picks",
        description: "",
        template_ids: ["one"],
        item_count: 1,
        created_at: "2026-07-30T00:00:00Z",
        updated_at: "2026-07-30T00:00:00Z",
        version: 1,
        etag: '"campaign-template-collection:collection-1:v1"',
      },
    ]);
    const root = renderDiscovery([one, two]);

    try {
      click(button("Compare"));
      await flush();

      expect(mocks.compare).toHaveBeenCalledWith(
        ["one", "two"],
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(document.querySelector("table caption")?.textContent).toContain(
        "Side-by-side template attributes",
      );
      expect(document.body.textContent).toContain("Industry");
      expect(document.body.textContent).toContain("Style");
      expect(document.body.textContent).toContain("Layout");
      expect(document.body.textContent).toContain("Desktop preview");
      expect(document.body.textContent).toContain("Mobile preview");
      expect(document.body.textContent).toContain("Capability");
      expect(document.body.textContent).toContain("Favorite");
      expect(document.body.textContent).toContain("Review");
      expect(document.body.textContent).toContain("Provenance");
      expect(document.body.textContent).toContain("Ingestion quality");
      expect(document.body.textContent).toContain("86%");
      expect(document.body.textContent).toContain("Collections");
      expect(document.body.textContent).toContain("Editorial picks");
      expect(document.body.textContent).toContain(
        "Collection membership is private to this account",
      );
      expect(document.body.textContent).toContain("One");
      expect(document.body.textContent).toContain("Two");
    } finally {
      act(() => root.unmount());
    }
  });

  it("prunes and announces compare selections the server says are unavailable", async () => {
    const one = template("one", "One");
    const two = template("two", "Two");
    const onRemoveCompare = vi.fn();
    mocks.compare.mockResolvedValue({
      items: [{ requested_identifier: "one", matched_by: "id", template: one }],
      unavailable_identifiers: ["two"],
    });
    const root = renderDiscovery([one, two], { onRemoveCompare });

    try {
      click(button("Compare"));
      await flush();

      expect(onRemoveCompare).toHaveBeenCalledWith("two");
      const status = document.querySelector(
        '[role="status"][aria-live="assertive"]',
      );
      expect(status?.textContent).toContain(
        "Removed Two from comparison because it is no longer available",
      );
      expect(document.body.textContent).toContain(
        "Choose another available design",
      );
      expect(document.querySelector("table")).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("reuses the same create key when an ambiguous saved-search retry is requested", async () => {
    const created = savedSearch("saved-1", "Minimal ideas");
    mocks.createSaved
      .mockRejectedValueOnce(
        new ApiError("Connection closed", 0, undefined, { kind: "network" }),
      )
      .mockResolvedValueOnce(created);
    const root = renderDiscovery();

    try {
      click(button("Saved searches"));
      await flush();
      const name = document.querySelector(
        'input[placeholder="e.g. Minimal ecommerce newsletters"]',
      );
      expect(name).toBeInstanceOf(HTMLInputElement);
      setValue(name as HTMLInputElement, "Minimal ideas");

      click(button("Save current"));
      await flush();
      click(button("Save current"));
      await flush();

      expect(mocks.createSaved).toHaveBeenCalledTimes(2);
      expect(mocks.createSaved.mock.calls[0][1].idempotencyKey).toBe(
        mocks.createSaved.mock.calls[1][1].idempotencyKey,
      );
      expect(mocks.toastSuccess).toHaveBeenCalledWith("Search saved");
    } finally {
      act(() => root.unmount());
    }
  });

  it("recovers the same pending create key after a component remount", async () => {
    const created = savedSearch("saved-1", "Reload-safe");
    mocks.createSaved
      .mockRejectedValueOnce(
        new ApiError("Timed out", 0, undefined, { kind: "timeout" }),
      )
      .mockResolvedValueOnce(created);
    const firstRoot = renderDiscovery();

    click(button("Saved searches"));
    await flush();
    setValue(
      document.querySelector(
        'input[placeholder="e.g. Minimal ecommerce newsletters"]',
      ) as HTMLInputElement,
      "Reload-safe",
    );
    click(button("Save current"));
    await flush();
    const originalKey = mocks.createSaved.mock.calls[0][1].idempotencyKey;
    act(() => firstRoot.unmount());

    const secondRoot = renderDiscovery();
    try {
      click(button("Saved searches"));
      await flush();
      setValue(
        document.querySelector(
          'input[placeholder="e.g. Minimal ecommerce newsletters"]',
        ) as HTMLInputElement,
        "Reload-safe",
      );
      click(button("Save current"));
      await flush();

      expect(mocks.createSaved.mock.calls[1][1].idempotencyKey).toBe(
        originalKey,
      );
    } finally {
      act(() => secondRoot.unmount());
    }
  });

  it("removes only obsolete filter pairs using the latest ETag", async () => {
    const existing: CampaignTemplateSavedSearch = {
      ...savedSearch("saved-1", "Old filters"),
      filters: {
        goal: "newsletter",
        style: "retired-style",
        industry: "technology",
        tags: ["weekly", "retired-tag"],
        featured: false,
      },
      obsolete_filters: [
        { field: "style", value: "retired-style" },
        { field: "tags", value: "retired-tag" },
      ],
    };
    const currentFilters: CampaignTemplateSavedSearchFilters = {
      goal: "promotional",
      kind: "editable",
      archived: "all",
      featured: true,
      favorited: false,
    };
    mocks.listSaved.mockResolvedValue([existing]);
    const root = renderDiscovery([], { currentFilters });

    try {
      click(button("Saved searches"));
      await flush();
      click(button("Manage"));
      click(button("Remove unavailable filters"));
      await flush();
      click(button("Remove unavailable values"));
      await flush();

      expect(mocks.updateSaved).toHaveBeenCalledWith(existing, {
        filters: {
          goal: "newsletter",
          industry: "technology",
          tags: ["weekly"],
          featured: false,
        },
      });
      expect(mocks.toastSuccess).toHaveBeenCalledWith(
        "Unavailable filters removed",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("removes exact obsolete pairs while preserving false values and siblings", () => {
    expect(
      removeObsoleteSavedSearchFilterPairs(
        {
          goal: "newsletter",
          style: "legacy",
          tags: ["weekly", "legacy"],
          featured: false,
          favorited: false,
        },
        [
          { field: "style", value: "legacy" },
          { field: "tags", value: "legacy" },
          { field: "favorited", value: "true" },
        ],
      ),
    ).toEqual({
      goal: "newsletter",
      tags: ["weekly"],
      featured: false,
      favorited: false,
    });
  });

  it("keeps unavailable filters visible until an explicit replacement", async () => {
    const existing: CampaignTemplateSavedSearch = {
      ...savedSearch("saved-legacy", "Legacy filters"),
      obsolete_filters: [{ field: "kind", value: "retired-kind" }],
    };
    mocks.listSaved.mockResolvedValue([existing]);
    const onApplySavedSearch = vi.fn();
    const root = renderDiscovery([], { onApplySavedSearch });

    try {
      click(button("Saved searches"));
      await flush();
      expect(document.body.textContent).toContain(
        "Kind “retired-kind” is no longer available",
      );

      click(button("Manage"));
      expect(document.body.textContent).toContain(
        "still preserves unavailable filters",
      );
      expect(button("Apply filters").disabled).toBe(true);
      expect(button("Remove unavailable filters").disabled).toBe(false);
      expect(onApplySavedSearch).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("records exactly once after a verified detail mount under StrictMode", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(TemplateViewRecorder, { templateId: "one" }),
        ),
      );
    });
    await flush();
    expect(mocks.recordView).toHaveBeenCalledTimes(1);
    expect(mocks.recordView).toHaveBeenCalledWith(
      "one",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    act(() => root.unmount());
  });
});
