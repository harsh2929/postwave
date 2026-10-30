// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// campaigns-94 (Grid / List view, tile density, reset filters) and campaigns-96
// (bulk Copy URLs) for the asset library. /app/assets/assets-client.tsx is
// another session's WIP, so the components are driven through a harness that
// mounts them the way the page will. Assertions are consequences: which
// layout renders the loaded rows, the grid class each density applies, the
// filter state after Reset, and the exact text written to the clipboard (or
// the refusal and its reason when a URL is not public).
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AssetBrowseControls,
  assetFiltersActive,
  assetGridClassName,
  DEFAULT_ASSET_BROWSE_FILTERS,
  useAssetBrowseView,
  type AssetBrowseFilters,
} from "@/components/assets/asset-browse-controls";
import { CopyAssetUrlsButton } from "@/components/assets/asset-copy-urls-button";
import { AssetListView } from "@/components/assets/asset-list-view";
import type { Asset } from "@/lib/assets-api";

const mocks = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  writeText: vi.fn(async (_text: string): Promise<void> => undefined),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function asset(id: string, url: string, extra: Partial<Asset> = {}): Asset {
  return {
    id,
    tenantId: "tenant-1",
    filename: `${id}.png`,
    mime: "image/png",
    bytes: 2048,
    width: 640,
    height: 480,
    url,
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-02T10:00:00Z",
    version: 1,
    altText: "",
    referencesCount: 0,
    lastUsedAt: null,
    folderId: null,
    ...extra,
  };
}

const HERO = asset("hero", "https://cdn.postwave.example/a/hero.png", {
  referencesCount: 3,
  altText: "Hero banner",
});
const LOGO = asset("logo", "https://cdn.postwave.example/a/logo.png");
const LOCAL = asset("local", "http://localhost:8080/api/v1/assets/local/blob");

let root: Root | null = null;

function render(node: ReturnType<typeof createElement>): void {
  const host = document.createElement("div");
  document.body.append(host);
  act(() => {
    root = createRoot(host);
    root.render(node);
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function setSelect(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.writeText },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

/** Mounts the controls the way assets-client.tsx will. */
function BrowseHarness({ initial }: { initial: AssetBrowseFilters }) {
  const browse = useAssetBrowseView();
  const [filters, setFilters] = useState(initial);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const assets = [HERO, LOGO];
  return createElement(
    "div",
    null,
    createElement(AssetBrowseControls, {
      view: browse.view,
      density: browse.density,
      onViewChange: browse.setView,
      onDensityChange: browse.setDensity,
      filtersActive: assetFiltersActive(filters),
      onResetFilters: () => setFilters(DEFAULT_ASSET_BROWSE_FILTERS),
    }),
    createElement(
      "output",
      { "data-testid": "filters" },
      JSON.stringify(filters),
    ),
    browse.view === "list"
      ? createElement(AssetListView, {
          assets,
          selected,
          selectable: true,
          onToggle: (row: Asset, checked: boolean) =>
            setSelected((current) => {
              const next = new Set(current);
              if (checked) next.add(row.id);
              else next.delete(row.id);
              return next;
            }),
          renderActions: (row: Asset) =>
            createElement("button", { type: "button" }, `Inspect ${row.id}`),
        })
      : createElement(
          "ul",
          {
            "data-testid": "asset-grid",
            className: assetGridClassName(browse.density),
          },
          assets.map((row) =>
            createElement("li", { key: row.id }, row.filename),
          ),
        ),
    createElement(
      "output",
      { "data-testid": "selected" },
      [...selected].join(","),
    ),
  );
}

describe("asset browse controls (campaigns-94)", () => {
  it("switches the loaded rows between Grid and a List table, and density restyles the grid", async () => {
    render(
      createElement(BrowseHarness, { initial: DEFAULT_ASSET_BROWSE_FILTERS }),
    );
    const grid = () =>
      document.querySelector<HTMLUListElement>('[data-testid="asset-grid"]');
    expect(grid()?.className).toBe(assetGridClassName("cozy"));
    expect(button("Grid").getAttribute("aria-pressed")).toBe("true");

    const tileSize = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Tile size"]',
    )!;
    await act(async () => setSelect(tileSize, "compact"));
    expect(grid()?.className).toContain("xl:grid-cols-5");
    await act(async () => setSelect(tileSize, "comfortable"));
    expect(grid()?.className).toBe("grid gap-4 lg:grid-cols-2");

    await act(async () => button("List").click());
    expect(button("List").getAttribute("aria-pressed")).toBe("true");
    expect(grid()).toBeNull();
    // Tile size only applies to the grid.
    expect(document.querySelector('select[aria-label="Tile size"]')).toBeNull();
    const rows = document.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("hero.png");
    expect(rows[0]?.textContent).toContain("Hero banner");
    expect(rows[0]?.textContent).toContain("640 × 480px");
    expect(rows[0]?.textContent).toContain("2.0 KiB");
    expect(rows[0]?.textContent).toContain("Inspect hero");

    const select = document.querySelector<HTMLInputElement>(
      'input[aria-label="Select logo.png"]',
    )!;
    await act(async () => select.click());
    expect(
      document.querySelector('[data-testid="selected"]')?.textContent,
    ).toBe("logo");
  });

  it("Reset filters restores search, sort, smart filter, folder, and tag — and is withheld at defaults", async () => {
    render(
      createElement(BrowseHarness, {
        initial: {
          query: "banner",
          sort: "largest",
          filter: "unused",
          folderId: "folder-1",
          tag: "spring",
        },
      }),
    );
    const reset = button("Reset filters");
    expect(reset.disabled).toBe(false);
    await act(async () => reset.click());
    expect(
      JSON.parse(
        document.querySelector('[data-testid="filters"]')?.textContent ?? "{}",
      ),
    ).toEqual(DEFAULT_ASSET_BROWSE_FILTERS);
    expect(button("Reset filters").disabled).toBe(true);
    expect(button("Reset filters").title).toBe(
      "Search, sort, and filters are already at their defaults.",
    );
  });

  it("counts every filter dimension as active", () => {
    expect(assetFiltersActive(DEFAULT_ASSET_BROWSE_FILTERS)).toBe(false);
    expect(
      assetFiltersActive({ ...DEFAULT_ASSET_BROWSE_FILTERS, query: "  " }),
    ).toBe(false);
    for (const change of [
      { query: "x" },
      { sort: "name" as const },
      { filter: "in-use" as const },
      { folderId: "root" },
      { tag: "promo" },
    ]) {
      expect(
        assetFiltersActive({ ...DEFAULT_ASSET_BROWSE_FILTERS, ...change }),
      ).toBe(true);
    }
  });

  it("omits selection for a role that cannot select", () => {
    render(
      createElement(AssetListView, {
        assets: [HERO],
        selected: new Set<string>(),
        selectable: false,
        onToggle: () => undefined,
      }),
    );
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.querySelector("tbody tr")?.textContent).toContain(
      "hero.png",
    );
  });
});

describe("bulk Copy URLs (campaigns-96)", () => {
  it("copies every selected public URL, one per line", async () => {
    render(createElement(CopyAssetUrlsButton, { assets: [HERO, LOGO] }));
    await act(async () => {
      button("Copy URLs").click();
      await Promise.resolve();
    });
    expect(mocks.writeText).toHaveBeenCalledWith(
      "https://cdn.postwave.example/a/hero.png\nhttps://cdn.postwave.example/a/logo.png",
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("2 asset URLs copied");
  });

  it("refuses the whole copy when a selected asset has no public URL, and says how many", async () => {
    render(createElement(CopyAssetUrlsButton, { assets: [HERO, LOCAL] }));
    await act(async () => {
      button("Copy URLs").click();
      await Promise.resolve();
    });
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "1 of the 2 selected assets has no public URL, so nothing was copied.",
      expect.objectContaining({
        description: expect.stringContaining("Deselect them"),
      }),
    );
  });

  it("surfaces a rejected clipboard write instead of claiming success", async () => {
    mocks.writeText.mockRejectedValueOnce(new Error("denied"));
    render(createElement(CopyAssetUrlsButton, { assets: [HERO] }));
    await act(async () => {
      button("Copy URLs").click();
      await Promise.resolve();
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "The browser refused the clipboard write. Nothing was copied.",
    );
  });

  it("is disabled with the reason when the browser has no clipboard", () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    render(createElement(CopyAssetUrlsButton, { assets: [HERO] }));
    const copy = button("Copy URLs");
    expect(copy.disabled).toBe(true);
    expect(copy.title).toContain("Clipboard access is unavailable");
  });
});
