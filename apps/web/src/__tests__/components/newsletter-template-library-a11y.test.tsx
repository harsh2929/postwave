// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TemplatesBrowser as DeferredTemplatesBrowser } from "@/app/(dashboard)/app/templates/_components/browser";
import { CampaignTemplateReferencePicker } from "@/app/(dashboard)/app/templates/_components/campaign-template-reference-picker";
import { GenerateTemplateDialog } from "@/app/(dashboard)/app/templates/_components/generate-template-dialog";
import { PreviewImage } from "@/app/(dashboard)/app/templates/_components/preview-image";
import { TemplateCapturePreview } from "@/app/(dashboard)/app/templates/_components/template-capture-preview";
import { TemplatePreviewFrame } from "@/app/(dashboard)/app/templates/_components/template-preview";
import { TemplatesBulkBar } from "@/app/(dashboard)/app/templates/_components/templates-bulk-bar";
import { TemplateGallery } from "@/app/(dashboard)/app/templates/_components/template-gallery";
import { ApiError } from "@/lib/api";
import type { CampaignTemplateSummary } from "@/lib/campaign-templates-api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  browserState: {
    view: "mine",
    q: "",
    goal: "",
    category: "",
    style: "",
    industry: "",
    layout: "",
    source: "mine",
    provider: "",
    kind: "all",
    tag: "",
    featured: undefined,
    favorited: false,
    sort: "recommended",
    archived: "active",
  },
  setState: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  search: vi.fn(),
  favorite: vi.fn(),
  clone: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
  startDesign: vi.fn(),
  selectDesign: vi.fn(),
  discardDesign: vi.fn(),
  setWorkflowError: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/templates",
  useRouter: () => ({
    replace: mocks.replace,
    push: mocks.push,
    refresh: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/use-table-url-state", () => ({
  useTableUrlState: () => ({
    state: mocks.browserState,
    setState: mocks.setState,
  }),
}));

vi.mock("@/lib/campaign-templates-api", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/campaign-templates-api")>();
  return {
    ...actual,
    searchCampaignTemplates: mocks.search,
    favoriteCampaignTemplate: mocks.favorite,
    cloneCampaignTemplate: mocks.clone,
    archiveCampaignTemplate: mocks.archive,
    restoreCampaignTemplate: mocks.restore,
  };
});

vi.mock(
  "@/app/(dashboard)/app/templates/_components/use-campaign-template-design-workflow",
  () => ({
    useCampaignTemplateDesignWorkflow: () => ({
      designs: [],
      revisions: [],
      selectedDesign: undefined,
      recovering: false,
      working: false,
      awaitingAcknowledgement: false,
      recoveryPersistenceAvailable: true,
      error: null,
      setError: mocks.setWorkflowError,
      start: mocks.startDesign,
      select: mocks.selectDesign,
      discard: mocks.discardDesign,
      refine: vi.fn(),
      retry: vi.fn(),
      saveExactRevision: vi.fn(),
      createCampaignExactRevision: vi.fn(),
      refresh: vi.fn(),
    }),
    campaignTemplateDesignMutationErrorMessage: vi.fn(),
  }),
);

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: mocks.toastInfo,
  },
}));

function TemplatesBrowser(
  props: ComponentProps<typeof DeferredTemplatesBrowser>,
) {
  return (
    <DeferredTemplatesBrowser {...props} galleryComponent={TemplateGallery} />
  );
}

function ownedTemplate(
  id: string,
  name: string,
  archived = false,
): CampaignTemplateSummary {
  return {
    id,
    tenant_id: "tenant-1",
    version: 7,
    etag: `"template-${id}-v7"`,
    archived_at: archived ? "2026-07-29T00:00:00Z" : undefined,
    name,
    description: `${name} description`,
    subject: `${name} subject`,
    tags: [],
    template_kind: "editable",
    source: "mine",
    capabilities: {
      can_preview: true,
      can_favorite: true,
      can_adapt: false,
      can_use_directly: !archived,
      can_edit_directly: !archived,
      can_clone: !archived,
      can_create_campaign: !archived,
      can_delete: !archived,
      can_archive: !archived,
      can_restore: archived,
      has_source_html: true,
      has_source_mjml: false,
      has_desktop_preview: true,
      has_mobile_preview: true,
    },
  };
}

function referenceTemplate(id: string, name: string): CampaignTemplateSummary {
  return {
    id,
    name,
    subject: `${name} subject`,
    tags: [],
    template_kind: "reference",
    capabilities: {
      can_preview: true,
      can_favorite: true,
      can_adapt: true,
      can_use_directly: false,
      can_edit_directly: false,
      can_clone: false,
      can_create_campaign: false,
      can_delete: false,
      can_archive: false,
      can_restore: false,
      has_source_html: false,
      has_source_mjml: false,
      has_desktop_preview: true,
      has_mobile_preview: true,
    },
  };
}

function searchResult(items: CampaignTemplateSummary[]) {
  return {
    items,
    next_cursor: null,
    total: items.length,
    facets: {},
  };
}

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return root;
}

async function flush(): Promise<void> {
  await act(async () => {
    // next/dynamic resolves secondary template tools and the card gallery on
    // separate microtask/render turns. Settle both without coupling assertions
    // to the fallback duration.
    for (let index = 0; index < 3; index += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    }
  });
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
}

function sendKey(
  target: EventTarget,
  key: string,
  init: KeyboardEventInit = {},
): void {
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

function changeValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      "value",
    )?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  Object.assign(mocks.browserState, {
    view: "mine",
    q: "",
    goal: "",
    category: "",
    style: "",
    industry: "",
    layout: "",
    source: "mine",
    provider: "",
    kind: "all",
    tag: "",
    featured: undefined,
    favorited: false,
    sort: "recommended",
    archived: "active",
  });
  mocks.startDesign.mockResolvedValue([]);
  mocks.discardDesign.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("newsletter template browser accessibility", () => {
  it("refreshes an explicit default-filter deep link instead of trusting an empty seed", async () => {
    const current = referenceTemplate("current", "Current inspiration");
    Object.assign(mocks.browserState, {
      view: "inspiration",
      q: "",
      goal: "newsletter",
      source: "platform",
      provider: "",
      kind: "all",
      favorited: false,
      sort: "recommended",
    });
    mocks.search.mockResolvedValueOnce(searchResult([current]));
    const root = render(
      <TemplatesBrowser
        initialResult={searchResult([])}
        initialRequiresRefresh
      />,
    );

    try {
      await flush();
      expect(mocks.search).toHaveBeenCalledWith(
        expect.objectContaining({
          goal: "newsletter",
          source: "platform",
          kind: undefined,
          page: 1,
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(
        document.querySelector(
          '[role="article"][aria-label="Current inspiration"]',
        ),
      ).toBeTruthy();
    } finally {
      act(() => root.unmount());
    }
  });

  it("re-queries and paginates with the selected global server sort", async () => {
    const zeta = referenceTemplate("zeta", "Zeta Digest");
    const alpha = referenceTemplate("alpha", "Alpha Brief");
    const beta = referenceTemplate("beta", "Beta Bulletin");
    const initialResult = searchResult([zeta, alpha]);
    Object.assign(mocks.browserState, {
      view: "inspiration",
      goal: "newsletter",
      source: "platform",
      provider: "",
      kind: "all",
      favorited: false,
      sort: "recommended",
    });
    mocks.search
      .mockResolvedValueOnce({
        items: [zeta, alpha],
        next_cursor: "name-page-2",
        total: 3,
        facets: {},
      })
      .mockResolvedValueOnce({
        items: [beta],
        next_cursor: null,
        total: 3,
        facets: {},
      });

    const root = render(<TemplatesBrowser initialResult={initialResult} />);

    try {
      expect(mocks.search).not.toHaveBeenCalled();

      Object.assign(mocks.browserState, { sort: "name" });
      act(() => {
        root.render(<TemplatesBrowser initialResult={initialResult} />);
      });
      await flush();

      expect(mocks.search).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          sort: "name",
          page: 1,
          perPage: 24,
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      // The browser renders the server's exact order. It does not alphabetize
      // only the currently loaded slice.
      expect(
        Array.from(document.querySelectorAll('[role="article"]')).map((card) =>
          card.getAttribute("aria-label"),
        ),
      ).toEqual(["Zeta Digest", "Alpha Brief"]);

      click(buttonByText("Load more designs"));
      await flush();

      expect(mocks.search).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          sort: "name",
          cursor: "name-page-2",
          page: 2,
          perPage: 24,
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(
        Array.from(document.querySelectorAll('[role="article"]')).map((card) =>
          card.getAttribute("aria-label"),
        ),
      ).toEqual(["Zeta Digest", "Alpha Brief", "Beta Bulletin"]);
    } finally {
      act(() => root.unmount());
    }
  });

  it("aborts and ignores an old page when filters change during Load more", async () => {
    const first = referenceTemplate("first", "First result");
    const stale = referenceTemplate("stale", "Stale old page");
    const current = referenceTemplate("current", "Current filtered result");
    Object.assign(mocks.browserState, {
      view: "inspiration",
      goal: "newsletter",
      q: "",
      source: "platform",
      provider: "",
      kind: "all",
      favorited: false,
      sort: "recommended",
    });
    let resolveOldPage:
      | ((value: ReturnType<typeof searchResult>) => void)
      | undefined;
    const oldPage = new Promise<ReturnType<typeof searchResult>>((resolve) => {
      resolveOldPage = resolve;
    });
    mocks.search
      .mockImplementationOnce(() => oldPage)
      .mockResolvedValueOnce(searchResult([current]));
    const root = render(
      <TemplatesBrowser
        initialResult={{
          ...searchResult([first]),
          next_cursor: "old-page-2",
          total: 2,
        }}
      />,
    );

    try {
      click(buttonByText("Load more designs"));
      await flush();
      const oldSignal = (
        mocks.search.mock.calls[0]?.[1] as { signal?: AbortSignal }
      )?.signal;

      Object.assign(mocks.browserState, { q: "current" });
      act(() => {
        root.render(
          <TemplatesBrowser
            initialResult={{
              ...searchResult([first]),
              next_cursor: "old-page-2",
              total: 2,
            }}
          />,
        );
      });
      await flush();

      expect(oldSignal?.aborted).toBe(true);
      expect(
        document.querySelector(
          '[role="article"][aria-label="Current filtered result"]',
        ),
      ).toBeTruthy();
      expect(
        document.querySelector('[role="article"][aria-label="First result"]'),
      ).toBeNull();

      resolveOldPage?.(searchResult([stale]));
      await flush();

      expect(
        document.querySelector('[role="article"][aria-label="Stale old page"]'),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not retain unrelated cards when a new filtered request fails", async () => {
    const inspiration = referenceTemplate("old", "Unrelated inspiration");
    Object.assign(mocks.browserState, {
      view: "inspiration",
      goal: "newsletter",
      q: "",
      source: "platform",
      provider: "",
      kind: "all",
      favorited: false,
      sort: "recommended",
    });
    const root = render(
      <TemplatesBrowser initialResult={searchResult([inspiration])} />,
    );

    try {
      mocks.search.mockRejectedValueOnce(new Error("filtered request failed"));
      Object.assign(mocks.browserState, { q: "private filter" });
      act(() => {
        root.render(
          <TemplatesBrowser initialResult={searchResult([inspiration])} />,
        );
      });
      await flush();

      expect(document.body.textContent).toContain("filtered request failed");
      expect(
        document.querySelector(
          '[role="article"][aria-label="Unrelated inspiration"]',
        ),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("supports tablist keyboard navigation and names lifecycle/card controls", async () => {
    const item = ownedTemplate("weekly", "Weekly Signal");
    mocks.search.mockResolvedValue(searchResult([item]));
    const root = render(
      <TemplatesBrowser initialResult={searchResult([item])} />,
    );

    try {
      await flush();

      const tablist = document.querySelector(
        '[role="tablist"][aria-label="Template library"]',
      );
      const tabs = Array.from(
        tablist?.querySelectorAll('[role="tab"]') ?? [],
      ) as HTMLButtonElement[];
      expect(tabs).toHaveLength(3);
      expect(tabs[1].getAttribute("aria-selected")).toBe("true");
      expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);

      act(() => {
        tabs[1].focus();
        sendKey(tablist as HTMLDivElement, "End");
      });
      expect(mocks.setState).toHaveBeenCalledWith({
        view: "favorites",
        source: "all",
        kind: "all",
        favorited: true,
        goal: "",
        provider: "",
        archived: "active",
      });
      expect(document.activeElement).toBe(tabs[2]);

      const lifecycle = document.querySelector(
        '[role="group"][aria-label="Template lifecycle"]',
      );
      expect(lifecycle).toBeTruthy();
      const lifecycleButtons = Array.from(
        lifecycle?.querySelectorAll("button") ?? [],
      );
      expect(lifecycleButtons[0].getAttribute("aria-pressed")).toBe("true");
      expect(lifecycleButtons[1].getAttribute("aria-pressed")).toBe("false");
      click(lifecycleButtons[1]);
      expect(mocks.setState).toHaveBeenCalledWith({ archived: "archived" });

      const card = document.querySelector(
        '[role="article"][aria-label="Weekly Signal"]',
      );
      expect(card).toBeTruthy();
      expect(card?.textContent).toContain("Desktop");
      expect(card?.textContent).toContain("Mobile");
      const titleLink = Array.from(card?.querySelectorAll("a") ?? []).find(
        (link) => link.textContent?.trim() === "Weekly Signal",
      );
      expect(titleLink?.className).toContain("min-h-11");
      expect(
        document.querySelector(
          'button[aria-label="Add to favorites: Weekly Signal"]',
        ),
      ).toBeTruthy();
      const select = document.querySelector(
        'input[aria-label="Select Weekly Signal"]',
      ) as HTMLInputElement;
      expect(select.type).toBe("checkbox");
      click(select);
      // The bulk bar is a deferred module; settle its load before asserting.
      await flush();

      const bulkRegion = document.querySelector(
        '[role="region"][aria-label="Bulk template actions"]',
      );
      expect(bulkRegion).toBeTruthy();
      expect(bulkRegion?.querySelector('[role="status"]')?.textContent).toBe(
        "1 selected",
      );
      expect(
        bulkRegion?.querySelector('button[aria-label="Archive 1 template"]'),
      ).toBeTruthy();
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps only failed favorites selected after a partial bulk result", async () => {
    const one = ownedTemplate("one", "One");
    const two = ownedTemplate("two", "Two");
    mocks.search.mockResolvedValue(searchResult([one, two]));
    mocks.favorite
      .mockResolvedValueOnce({ ok: true, favorited: true })
      .mockRejectedValueOnce(new Error("retry Two"));
    const root = render(
      <TemplatesBrowser initialResult={searchResult([one, two])} />,
    );

    try {
      await flush();
      click(
        document.querySelector(
          'input[aria-label="Select One"]',
        ) as HTMLInputElement,
      );
      click(
        document.querySelector(
          'input[aria-label="Select Two"]',
        ) as HTMLInputElement,
      );
      // The bulk bar is a deferred module; settle its load before acting.
      await flush();
      click(
        document.querySelector(
          'button[aria-label="Add 2 selected templates to favorites"]',
        ) as HTMLButtonElement,
      );
      await flush();

      expect(document.body.textContent).toContain("1 selected");
      expect(
        (
          document.querySelector(
            'input[aria-label="Select One"]',
          ) as HTMLInputElement
        ).checked,
      ).toBe(false);
      expect(
        (
          document.querySelector(
            'input[aria-label="Deselect Two"]',
          ) as HTMLInputElement
        ).checked,
      ).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it("gives Favorites its own empty state and a clear way back to discovery", async () => {
    Object.assign(mocks.browserState, {
      view: "favorites",
      source: "all",
      provider: "",
      kind: "all",
      favorited: true,
    });
    mocks.search.mockResolvedValue(searchResult([]));
    const root = render(<TemplatesBrowser initialResult={searchResult([])} />);

    try {
      await flush();

      expect(document.body.textContent).toContain("No favorite designs yet");
      expect(document.body.textContent).toContain(
        "Use the star on any available design",
      );
      click(buttonByText("Browse inspiration"));
      expect(mocks.setState).toHaveBeenCalledWith({
        view: "inspiration",
        source: "platform",
        kind: "all",
        favorited: false,
        goal: "newsletter",
        provider: "",
        archived: "active",
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not offer a dead AI action in an empty Inspiration view", async () => {
    Object.assign(mocks.browserState, {
      view: "inspiration",
      goal: "newsletter",
      source: "platform",
      provider: "",
      kind: "all",
      favorited: false,
    });
    mocks.search.mockResolvedValue(searchResult([]));
    const root = render(<TemplatesBrowser initialResult={searchResult([])} />);

    try {
      await flush();
      expect(document.body.textContent).toContain("No designs for this goal yet");
      const aiActions = Array.from(document.querySelectorAll("button")).filter(
        (button) => /AI designs|Checking AI availability|AI temporarily unavailable/.test(button.textContent ?? ""),
      );
      expect(aiActions.length).toBeGreaterThan(0);
      expect(aiActions.every((button) => button.disabled)).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it("distinguishes Favorites access denial from catalogue unavailability", async () => {
    Object.assign(mocks.browserState, {
      view: "favorites",
      source: "all",
      provider: "",
      kind: "all",
      favorited: true,
    });
    mocks.search.mockRejectedValueOnce(
      new ApiError("Forbidden", 403, undefined, {
        code: "forbidden",
        kind: "http",
      }),
    );
    const favoritesRoot = render(
      <TemplatesBrowser initialResult={searchResult([])} />,
    );

    await flush();
    expect(document.body.textContent).toContain(
      "Favorites aren’t available in this workspace",
    );
    expect(document.body.textContent).toContain(
      "Ask a workspace admin for personal-library access",
    );
    act(() => favoritesRoot.unmount());

    Object.assign(mocks.browserState, {
      view: "inspiration",
      goal: "newsletter",
      q: "",
      source: "platform",
      provider: "",
      kind: "all",
      favorited: false,
    });
    const catalogRoot = render(
      <TemplatesBrowser
        initialResult={searchResult([])}
        initialLoadError="Unavailable"
        initialLoadStatus={503}
      />,
    );
    try {
      await flush();
      expect(document.body.textContent).toContain(
        "Template catalogue temporarily unavailable",
      );
      expect(document.body.textContent).toContain(
        "No local or previously saved design was removed",
      );
    } finally {
      act(() => catalogRoot.unmount());
    }
  });

  it("does not expose stale Inspiration cards after Favorites access is denied", async () => {
    const inspiration = referenceTemplate("reference-one", "Reference one");
    Object.assign(mocks.browserState, {
      view: "favorites",
      source: "all",
      provider: "",
      kind: "all",
      favorited: true,
    });
    mocks.search.mockRejectedValueOnce(
      new ApiError("Forbidden", 403, undefined, {
        code: "forbidden",
        kind: "http",
      }),
    );
    const root = render(
      <TemplatesBrowser initialResult={searchResult([inspiration])} />,
    );

    try {
      await flush();

      expect(document.body.textContent).toContain(
        "Favorites aren’t available in this workspace",
      );
      expect(document.body.textContent).not.toContain("Refresh failed");
      expect(
        document.querySelector('[role="article"][aria-label="Reference one"]'),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps only failed lifecycle targets selected for one-action retry", async () => {
    const one = ownedTemplate("one", "One");
    const two = ownedTemplate("two", "Two");
    mocks.search.mockResolvedValue(searchResult([one, two]));
    mocks.archive
      .mockResolvedValueOnce({ ...one, archived_at: "2026-07-30T00:00:00Z" })
      .mockRejectedValueOnce(new Error("retry Two"));
    const root = render(
      <TemplatesBrowser initialResult={searchResult([one, two])} />,
    );

    try {
      await flush();
      click(
        document.querySelector(
          'input[aria-label="Select One"]',
        ) as HTMLInputElement,
      );
      click(
        document.querySelector(
          'input[aria-label="Select Two"]',
        ) as HTMLInputElement,
      );
      click(
        document.querySelector(
          'button[aria-label="Archive 2 templates"]',
        ) as HTMLButtonElement,
      );
      await flush();
      const dialog = document.querySelector('[role="dialog"]');
      const confirm = Array.from(dialog?.querySelectorAll("button") ?? []).find(
        (candidate) => candidate.textContent?.trim() === "Archive",
      );
      click(confirm as HTMLButtonElement);
      await flush();

      expect(
        document.querySelector('[role="article"][aria-label="One"]'),
      ).toBeNull();
      expect(
        document.querySelector('[role="article"][aria-label="Two"]'),
      ).toBeTruthy();
      expect(document.body.textContent).toContain("1 selected");
      expect(
        (
          document.querySelector(
            'input[aria-label="Deselect Two"]',
          ) as HTMLInputElement
        ).checked,
      ).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps verified cards visible and labels them stale when refresh fails", async () => {
    const item = ownedTemplate("weekly", "Weekly Signal");
    mocks.search.mockRejectedValue(new Error("offline"));
    const root = render(
      <TemplatesBrowser initialResult={searchResult([item])} />,
    );

    try {
      await flush();
      expect(
        document.querySelector('[role="article"][aria-label="Weekly Signal"]'),
      ).toBeTruthy();
      expect(document.body.textContent).toContain(
        "Showing 1 previously loaded design · Refresh failed",
      );
      expect(document.body.textContent).toContain(
        "Showing the last verified results because the refresh failed: offline",
      );
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("reference picker accessibility", () => {
  it("announces selection limits and exposes search state to assistive tech", async () => {
    vi.useFakeTimers();
    const items = [
      referenceTemplate("editorial", "Editorial Signal"),
      referenceTemplate("launch", "Launch Notes"),
    ];
    mocks.search.mockResolvedValue(searchResult(items));

    function PickerHarness() {
      const [selected, setSelected] = useState<string[]>([]);
      return (
        <CampaignTemplateReferencePicker
          selected={selected}
          onChange={setSelected}
          max={1}
        />
      );
    }

    const root = render(<PickerHarness />);
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      const input = document.querySelector(
        'input[placeholder="Search all eligible designs"]',
      ) as HTMLInputElement;
      const help = document.getElementById(
        input.getAttribute("aria-describedby") ?? "",
      );
      expect(help?.textContent).toContain("complete server catalogue");
      expect(input.hasAttribute("aria-invalid")).toBe(false);
      expect(
        document
          .querySelector(
            '[role="group"][aria-label="Eligible reference designs"]',
          )
          ?.getAttribute("aria-busy"),
      ).toBe("false");
      expect(
        document.querySelector(
          '[role="status"][aria-label="Reference search status"]',
        )?.textContent,
      ).toContain("2 eligible reference designs found");

      click(
        document.querySelector(
          'button[aria-label="Select Editorial Signal"]',
        ) as HTMLButtonElement,
      );
      expect(
        document
          .querySelector('[role="status"][aria-live="polite"]')
          ?.getAttribute("aria-label"),
      ).toBe("1 of 1 reference designs selected");
      const limited = document.querySelector(
        'button[aria-label="Select Launch Notes; maximum reference designs selected"]',
      ) as HTMLButtonElement;
      expect(limited.disabled).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it("associates a failed catalogue search with the search field", async () => {
    vi.useFakeTimers();
    mocks.search.mockRejectedValue(new Error("offline"));
    const root = render(
      <CampaignTemplateReferencePicker selected={[]} onChange={vi.fn()} />,
    );

    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      const alert = document.querySelector('[role="alert"]');
      const input = document.querySelector(
        'input[placeholder="Search all eligible designs"]',
      ) as HTMLInputElement;
      expect(alert?.textContent).toContain("offline");
      expect(input.hasAttribute("aria-invalid")).toBe(false);
      expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(
        alert?.id,
      );
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("template preview accessibility", () => {
  it("keeps desktop, card, and mobile captures independently inspectable", () => {
    const root = render(
      <TemplateCapturePreview
        templateName="Weekly Signal"
        assets={[
          {
            variant: "desktop",
            url: "https://assets.postwave.test/desktop.png",
            width: 680,
            height: 2400,
            size_bytes: 100,
            status: "ready",
          },
          {
            variant: "card",
            url: "https://assets.postwave.test/card.png",
            width: 680,
            height: 900,
            size_bytes: 80,
            status: "ready",
          },
          {
            variant: "mobile",
            url: "https://assets.postwave.test/mobile.png",
            width: 390,
            height: 2400,
            size_bytes: 90,
            status: "source_missing",
          },
        ]}
      />,
    );

    try {
      const desktop = buttonByText("Desktop");
      const card = buttonByText("Card");
      const mobile = buttonByText("Mobile");
      expect(desktop.getAttribute("aria-pressed")).toBe("true");
      expect(card.getAttribute("aria-pressed")).toBe("false");
      expect(mobile.getAttribute("aria-pressed")).toBe("false");
      expect(document.querySelector("img")?.getAttribute("src")).toContain(
        "desktop.png",
      );

      click(mobile);
      expect(mobile.getAttribute("aria-pressed")).toBe("true");
      expect(document.querySelector("img")?.getAttribute("src")).toContain(
        "mobile.png",
      );
      expect(document.body.textContent).toContain("Last verified capture");
      for (const control of [desktop, card, mobile]) {
        expect(control.className).toContain("min-h-11");
      }
    } finally {
      act(() => root.unmount());
    }
  });

  it("groups preview controls and exposes every visual mode in the frame title", () => {
    const root = render(
      <TemplatePreviewFrame
        html="<p>Hello</p>"
        title="Weekly Signal preview"
      />,
    );

    try {
      expect(
        document.querySelector(
          '[role="region"][aria-label="Weekly Signal preview controls and preview"]',
        ),
      ).toBeTruthy();
      const previewRegion = document.querySelector(
        '[role="region"][aria-label="Weekly Signal preview controls and preview"]',
      );
      expect(previewRegion?.className).toContain("min-w-0");
      const scrollRegion = previewRegion?.querySelector(
        '[data-slot="template-preview-scroll"]',
      ) as HTMLDivElement;
      expect(scrollRegion.tabIndex).toBe(0);
      expect(scrollRegion.getAttribute("aria-label")).toContain(
        "desktop preview on a light canvas scroll area",
      );
      const deviceGroup = document.querySelector(
        '[role="group"][aria-label="Preview device"]',
      );
      const desktop = buttonByText("Desktop");
      const mobile = buttonByText("Mobile");
      expect(deviceGroup?.contains(desktop)).toBe(true);
      expect(desktop.getAttribute("aria-pressed")).toBe("true");
      expect(mobile.getAttribute("aria-pressed")).toBe("false");

      click(mobile);
      expect(mobile.getAttribute("aria-pressed")).toBe("true");
      expect(document.querySelector("iframe")?.title).toContain(
        "mobile preview on a light canvas",
      );

      const dark = document.querySelector(
        'button[aria-label="Use dark preview canvas"]',
      ) as HTMLButtonElement;
      click(dark);
      expect(
        document
          .querySelector('button[aria-label="Use light preview canvas"]')
          ?.getAttribute("aria-pressed"),
      ).toBe("true");
      expect(document.querySelector("iframe")?.title).toContain(
        "mobile preview on a dark canvas",
      );
      expect(
        document.querySelector('[role="status"][aria-live="polite"]')
          ?.textContent,
      ).toContain("mobile preview on a dark canvas");
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps an intentionally decorative missing thumbnail out of the image tree", () => {
    const root = render(<PreviewImage alt="" />);
    try {
      const fallback = document.querySelector('[aria-hidden="true"]');
      expect(fallback).toBeTruthy();
      expect(fallback?.hasAttribute("role")).toBe(false);
      expect(fallback?.hasAttribute("aria-label")).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("generate dialog accessibility", () => {
  it("labels the modal, focuses invalid brief input, and closes with Escape", async () => {
    mocks.search.mockResolvedValue(searchResult([]));

    function GenerateHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open generator
          </button>
          <GenerateTemplateDialog
            open={open}
            onOpenChange={setOpen}
            templates={[]}
          />
        </>
      );
    }

    const root = render(<GenerateHarness />);
    try {
      const trigger = buttonByText("Open generator");
      trigger.focus();
      click(trigger);
      await flush();

      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).toBeTruthy();
      expect(
        document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")
          ?.textContent,
      ).toBe("Generate a newsletter design");
      expect(
        document.getElementById(dialog?.getAttribute("aria-describedby") ?? "")
          ?.textContent,
      ).toContain("Nothing is sent automatically");

      click(buttonByText("Generate design"));
      const brief = document.querySelector(
        "#template-generation-brief",
      ) as HTMLTextAreaElement;
      const error = document.getElementById(
        brief.getAttribute("aria-describedby") ?? "",
      );
      expect(document.activeElement).toBe(brief);
      expect(brief.getAttribute("aria-invalid")).toBe("true");
      expect(error?.getAttribute("role")).toBe("alert");
      expect(error?.textContent).toContain("Describe the newsletter");
      expect(mocks.startDesign).not.toHaveBeenCalled();

      changeValue(brief, "A weekly launch digest.");
      expect(brief.getAttribute("aria-invalid")).toBe("false");
      expect(brief.hasAttribute("aria-describedby")).toBe(false);

      await act(async () => {
        sendKey(dialog as HTMLElement, "Escape");
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
});

describe("template lifecycle action accessibility", () => {
  it("names bulk actions with their affected count and supports modal dismissal", async () => {
    const archive = vi.fn().mockResolvedValue(undefined);
    const root = render(
      <TemplatesBulkBar
        count={3}
        favoriteableCount={1}
        archivableCount={2}
        restorableCount={1}
        onClear={vi.fn()}
        onFavorite={vi.fn()}
        onArchive={archive}
        onRestore={vi.fn()}
      />,
    );

    try {
      const trigger = document.querySelector(
        'button[aria-label="Archive 2 templates"]',
      ) as HTMLButtonElement;
      expect(trigger).toBeTruthy();
      expect(
        document.querySelector('button[aria-label="Restore 1 template"]'),
      ).toBeTruthy();
      trigger.focus();
      click(trigger);
      await flush();

      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).toBeTruthy();
      expect(
        document.getElementById(dialog?.getAttribute("aria-labelledby") ?? "")
          ?.textContent,
      ).toBe("Archive 2 templates?");
      expect(dialog?.textContent).toContain("can be restored later");

      await act(async () => {
        sendKey(dialog as HTMLElement, "Escape");
        await new Promise((resolve) => window.setTimeout(resolve, 0));
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();

      click(trigger);
      await flush();
      const reopened = document.querySelector('[role="dialog"]');
      const confirm = Array.from(
        reopened?.querySelectorAll("button") ?? [],
      ).find((button) => button.textContent?.trim() === "Archive");
      click(confirm as HTMLButtonElement);
      await flush();
      expect(archive).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });
});
