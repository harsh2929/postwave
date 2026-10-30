// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// campaigns-94 / campaigns-96 reachability on /app/assets: the browse
// controls (Grid / List, tile size, Reset filters) mount inside the "Asset
// filters" section and drive which layout renders the loaded rows; the
// selection bar carries bulk "Copy URLs" for any role that can browse, while
// "Delete selected" stays writer-only. Assertions are consequences — the
// layout that renders, the request the reset triggers, the exact clipboard
// text — never "a button exists".
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MeResponse } from "@/lib/auth-api";
import type { Asset } from "@/lib/assets-api";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  listAssets: vi.fn(),
  listAssetFolders: vi.fn(),
  listAssetTags: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  writeText: vi.fn(async (_text: string): Promise<void> => undefined),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/assets",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoami,
}));

vi.mock("@/lib/assets-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assets-api")>()),
  listAssets: mocks.listAssets,
  listAssetFolders: mocks.listAssetFolders,
  listAssetTags: mocks.listAssetTags,
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { AssetsClient } from "@/app/(dashboard)/app/assets/assets-client";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TENANT = "22222222-2222-4222-8222-222222222222";

function me(over: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: "11111111-1111-4111-8111-111111111111",
    tenant_id: TENANT,
    email: "qa@postwave.test",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "QA workspace",
    workspace_slug: "qa-workspace",
    ...over,
  };
}

function asset(id: string, url: string, extra: Partial<Asset> = {}): Asset {
  return {
    id,
    tenantId: TENANT,
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

let root: Root | null = null;

async function flush(turns = 4): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

async function renderAssets(): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AssetsClient),
      ),
    );
  });
  await flush();
  expect(container.textContent).toContain("hero.png");
  // The browse toolbar is a next/dynamic chunk mounted inside the filters
  // section; wait for it so every test starts from the settled page.
  await waitUntil(
    () =>
      maybeButton(filtersSection(container), "Grid") !== undefined &&
      maybeButton(filtersSection(container), "Reset filters") !== undefined,
  );
  return container;
}

function button(container: ParentNode, label: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.replace(/\s+/g, " ").trim() === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

function maybeButton(
  container: ParentNode,
  label: string,
): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.replace(/\s+/g, " ").trim() === label,
  );
}

function setSelect(select: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    "value",
  )?.set?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

// The browse toolbar, list view and Copy URLs are next/dynamic chunks; wait
// for them to mount rather than assuming a fixed number of event-loop turns.
async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await flush(1);
  expect(predicate()).toBe(true);
}

function filtersSection(container: ParentNode): HTMLElement {
  const match = container.querySelector<HTMLElement>(
    'section[aria-label="Asset filters"]',
  );
  if (!match) throw new Error("Asset filters section not found");
  return match;
}

beforeEach(() => {
  mocks.whoami.mockResolvedValue(me());
  mocks.listAssets.mockResolvedValue({
    items: [HERO, LOGO],
    counts: { all: 2, recent: 2, inUse: 1, unused: 1, large: 0 },
    nextCursor: null,
  });
  mocks.listAssetFolders.mockResolvedValue([]);
  mocks.listAssetTags.mockResolvedValue([]);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mocks.writeText },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  vi.clearAllMocks();
  Reflect.deleteProperty(navigator, "clipboard");
  document.body.innerHTML = "";
});

describe("asset browse controls on /app/assets (campaigns-94)", () => {
  it("mounts Grid / List and tile size inside the Asset filters section, and switches the loaded rows between layouts", async () => {
    const container = await renderAssets();
    const filters = filtersSection(container);
    const grid = () =>
      container.querySelector<HTMLUListElement>(
        'section[aria-labelledby="asset-list-heading"] ul',
      );

    expect(button(filters, "Grid").getAttribute("aria-pressed")).toBe("true");
    expect(grid()?.className).toBe("mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3");
    expect(grid()?.querySelectorAll("li")).toHaveLength(2);

    const tileSize = filters.querySelector<HTMLSelectElement>(
      'select[aria-label="Tile size"]',
    )!;
    await act(async () => setSelect(tileSize, "compact"));
    expect(grid()?.className).toContain("xl:grid-cols-5");

    await act(async () => button(filters, "List").click());
    expect(button(filters, "List").getAttribute("aria-pressed")).toBe("true");
    expect(grid()).toBeNull();
    expect(filters.querySelector('select[aria-label="Tile size"]')).toBeNull();
    await waitUntil(
      () =>
        container.querySelector('[role="region"][aria-label="Assets table"]') !==
        null,
    );
    const table = container.querySelector<HTMLElement>(
      '[role="region"][aria-label="Assets table"]',
    );
    expect(table).toBeTruthy();
    expect(table!.getAttribute("tabindex")).toBe("0");
    const rows = table!.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("hero.png");
    expect(rows[0]?.textContent).toContain("Hero banner");
    expect(rows[0]?.textContent).toContain("640 × 480px");
    // The page's own per-asset verbs render in the list's action column.
    expect(rows[0]?.textContent).toContain("Inspect");
    expect(rows[0]?.textContent).toContain("Download");
    expect(rows[0]?.textContent).toContain("Delete");
    // No re-fetch: switching layout is a client-side view of loaded rows.
    expect(mocks.listAssets).toHaveBeenCalledTimes(1);

    await act(async () => button(filters, "Grid").click());
    expect(grid()?.className).toContain("xl:grid-cols-5");
    expect(table!.isConnected).toBe(false);
  });

  it("Reset filters is withheld at defaults and, once a filter is active, restores every filter and refetches the default listing", async () => {
    const container = await renderAssets();
    const filters = filtersSection(container);
    const reset = () => button(filters, "Reset filters");
    expect(reset().disabled).toBe(true);
    expect(reset().title).toBe(
      "Search, sort, and filters are already at their defaults.",
    );

    const sort = filters.querySelector<HTMLSelectElement>(
      'select[aria-label="Sort assets"]',
    )!;
    await act(async () => setSelect(sort, "largest"));
    await flush();
    expect(mocks.listAssets).toHaveBeenLastCalledWith(
      expect.objectContaining({ sort: "largest", filter: "all" }),
    );
    expect(reset().disabled).toBe(false);

    await act(async () => reset().click());
    await flush();
    expect(sort.value).toBe("newest");
    expect(mocks.listAssets).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        sort: "newest",
        filter: "all",
        q: "",
        folderId: undefined,
        tag: undefined,
      }),
    );
    expect(reset().disabled).toBe(true);
  });
});

describe("bulk Copy URLs in the selection bar (campaigns-96)", () => {
  it("lets a viewer select assets and copy their public URLs, with no Delete selected offered", async () => {
    mocks.whoami.mockResolvedValue(
      me({ role: "viewer", effective_role: "viewer" }),
    );
    const container = await renderAssets();
    expect(container.textContent).toContain("Read-only mode");

    const selectHero = container.querySelector<HTMLInputElement>(
      'input[aria-label="Select hero.png"]',
    );
    const selectLogo = container.querySelector<HTMLInputElement>(
      'input[aria-label="Select logo.png"]',
    );
    expect(selectHero).toBeTruthy();
    expect(selectLogo).toBeTruthy();
    await act(async () => selectHero!.click());
    await act(async () => selectLogo!.click());

    expect(container.textContent).toContain("2 selected");
    expect(maybeButton(container, "Delete selected")).toBeUndefined();
    expect(maybeButton(container, "Delete")).toBeUndefined();
    await waitUntil(() => maybeButton(container, "Copy URLs")?.disabled === false);
    const copy = button(container, "Copy URLs");

    await act(async () => {
      copy.click();
      await Promise.resolve();
    });
    await flush();
    expect(mocks.writeText).toHaveBeenCalledWith(
      "https://cdn.postwave.example/a/hero.png\nhttps://cdn.postwave.example/a/logo.png",
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("2 asset URLs copied");

    await act(async () => button(container, "Clear").click());
    expect(container.textContent).not.toContain("2 selected");
  });

  it("keeps Delete selected beside Copy URLs for a writer", async () => {
    const container = await renderAssets();
    const selectAll = [...container.querySelectorAll("label")].find((label) =>
      label.textContent?.includes("Select shown"),
    );
    expect(selectAll).toBeTruthy();
    await act(async () =>
      selectAll!.querySelector<HTMLInputElement>("input")!.click(),
    );
    expect(container.textContent).toContain("2 selected");
    await waitUntil(() => maybeButton(container, "Copy URLs")?.disabled === false);
    expect(button(container, "Delete selected")).toBeTruthy();
  });
});
