/**
 * Optimized-renderer coverage for the Assets library.  Keep the asset API
 * double in this file: unlike the shared visual fixture, unknown asset calls
 * are failures so a new renderer request cannot silently become `{}`.
 */
import type { Page, Route, TestInfo } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const NOW = "2026-07-18T08:00:00.000Z";
const FOLDER_ID = "folder-brand";

type ListMode = "good" | "empty" | "malformed" | "error" | "partial";
type MutationAckMode = "exact" | "malformed";

type VisualAsset = {
  id: string;
  filename: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  url: string;
  createdAt: string;
  altText?: string;
  referencesCount: number;
  lastUsedAt?: string | null;
  tags?: string[];
  folderId?: string | null;
};

const INITIAL_ASSETS: VisualAsset[] = [
  {
    id: "asset-hero",
    filename: "summer-hero.png",
    mime: "image/png",
    bytes: 2_400_000,
    width: 1600,
    height: 900,
    url: "https://cdn.example.invalid/summer-hero.png",
    createdAt: "2026-07-17T09:00:00.000Z",
    altText: "Summer fruit on a blue table",
    referencesCount: 2,
    lastUsedAt: "2026-07-17T12:00:00.000Z",
    tags: ["hero", "summer"],
    folderId: FOLDER_ID,
  },
  {
    id: "asset-logo",
    filename: "postwave-logo.png",
    mime: "image/png",
    bytes: 18_240,
    width: 480,
    height: 120,
    url: "https://cdn.example.invalid/postwave-logo.png",
    createdAt: "2026-07-16T09:00:00.000Z",
    altText: "Moosewave wordmark",
    referencesCount: 1,
    tags: ["brand"],
    folderId: FOLDER_ID,
  },
  {
    id: "asset-orphan",
    filename: "unused-texture.webp",
    mime: "image/webp",
    bytes: 520_000,
    width: 1200,
    height: 800,
    url: "https://cdn.example.invalid/unused-texture.webp",
    createdAt: "2026-07-15T09:00:00.000Z",
    referencesCount: 0,
    tags: ["texture"],
    folderId: null,
  },
  {
    id: "asset-social",
    filename: "social-card.jpg",
    mime: "image/jpeg",
    bytes: 890_000,
    width: 1200,
    height: 630,
    url: "https://cdn.example.invalid/social-card.jpg",
    createdAt: "2026-07-14T09:00:00.000Z",
    referencesCount: 0,
    tags: ["summer"],
    folderId: null,
  },
];

interface AssetsApiControl {
  calls: Array<{ method: string; path: string; query: string }>;
  unexpected: string[];
  unexpectedNetwork: string[];
  forceDeletes: string[];
  patches: Array<{ id: string; body: unknown }>;
  setListMode: (mode: ListMode) => void;
  setMutationAckMode: (mode: MutationAckMode) => void;
  holdNextList: (query: string) => Promise<() => void>;
  holdNextUpload: () => Promise<() => void>;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function apiError(message: string, code = "visual_error") {
  return { error: { code, message } };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Every `/api/v1/assets` variant is deliberately enumerated here. */
async function installAssetsApi(page: Page): Promise<AssetsApiControl> {
  let listMode: ListMode = "good";
  let mutationAckMode: MutationAckMode = "exact";
  let assets: VisualAsset[] = INITIAL_ASSETS.map((asset) => ({
    ...asset,
    tags: [...(asset.tags ?? [])],
  }));
  let assetFolder: {
    id: string;
    name: string;
    createdAt: string;
    assetCount: number;
  } | null = {
    id: FOLDER_ID,
    name: "Brand kit",
    createdAt: NOW,
    assetCount: assets.filter((asset) => asset.folderId === FOLDER_ID).length,
  };
  let heldList: {
    query: string;
    arrived: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  } | null = null;
  let heldUpload: {
    arrived: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
  } | null = null;
  const calls: AssetsApiControl["calls"] = [];
  const unexpected: string[] = [];
  const unexpectedNetwork: string[] = [];
  const forceDeletes: string[] = [];
  const patches: AssetsApiControl["patches"] = [];

  // The fixture owns the local renderer and its bootstrap API. Asset thumbs
  // are otherwise the only cross-origin request this page is allowed to make.
  page.on("request", (request) => {
    const origin = new URL(request.url()).origin;
    if (
      origin !== "http://localhost:1421" &&
      origin !== "http://localhost:8080" &&
      origin !== "https://api.moosewave.com" &&
      origin !== "https://cdn.example.invalid"
    ) {
      unexpectedNetwork.push(`${request.method()} ${request.url()}`);
    }
  });
  await page.route("https://cdn.example.invalid/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    });
  });

  await page.route("**/api/v1/assets**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    calls.push({ method: request.method(), path: pathname, query: url.search });

    const list = (): VisualAsset[] => {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const filter = url.searchParams.get("filter");
      const tag = url.searchParams.get("tag");
      const folder = url.searchParams.get("folder_id");
      const sort = url.searchParams.get("sort") ?? "newest";
      let rows = assets.filter((asset) =>
        !q ? true : asset.filename.toLowerCase().includes(q),
      );
      if (filter === "unused")
        rows = rows.filter((asset) => asset.referencesCount === 0);
      if (filter === "in-use")
        rows = rows.filter((asset) => asset.referencesCount > 0);
      if (filter === "large")
        rows = rows.filter((asset) => asset.bytes > 1_000_000);
      if (filter === "recent") rows = rows.filter((asset) => asset.lastUsedAt);
      if (tag) rows = rows.filter((asset) => asset.tags?.includes(tag));
      if (folder === "root") rows = rows.filter((asset) => !asset.folderId);
      if (folder && folder !== "root")
        rows = rows.filter((asset) => asset.folderId === folder);
      if (sort === "name")
        rows.sort((a, b) => a.filename.localeCompare(b.filename));
      if (sort === "largest") rows.sort((a, b) => b.bytes - a.bytes);
      if (sort === "oldest")
        rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      if (sort === "most-used")
        rows.sort((a, b) => b.referencesCount - a.referencesCount);
      return rows;
    };

    if (pathname === "/api/v1/assets" && request.method() === "GET") {
      const q = url.searchParams.get("q") ?? "";
      if (heldList?.query === q) {
        heldList.arrived.resolve();
        await heldList.release.promise;
        heldList = null;
      }
      if (listMode === "error")
        return json(route, apiError("asset catalog unavailable"), 503);
      if (listMode === "malformed")
        return json(route, { items: "not-an-array", counts: null });
      if (listMode === "empty")
        return json(route, {
          items: [],
          counts: { all: 0, recent: 0, inUse: 0, unused: 0, large: 0 },
          nextCursor: null,
        });
      const rows = list();
      return json(route, {
        items: listMode === "partial" ? rows.slice(0, 1) : rows,
        counts: {
          all: assets.length,
          recent: 1,
          inUse: 2,
          unused: 2,
          large: 1,
        },
        nextCursor: null,
      });
    }
    if (pathname === "/api/v1/assets/tags" && request.method() === "GET") {
      const counts = new Map<string, number>();
      for (const asset of assets)
        for (const tag of asset.tags ?? [])
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
      return json(route, {
        tags: [...counts].map(([tag, count]) => ({ tag, count })),
      });
    }
    if (pathname === "/api/v1/assets/folders" && request.method() === "GET") {
      return json(route, {
        folders: assetFolder
          ? [
              {
                ...assetFolder,
                assetCount: assets.filter(
                  (asset) => asset.folderId === assetFolder?.id,
                ).length,
              },
            ]
          : [],
      });
    }
    if (pathname === "/api/v1/assets/folders" && request.method() === "POST") {
      const body = request.postDataJSON() as { name?: string };
      return json(
        route,
        {
          id: "folder-new",
          name: body.name ?? "Untitled",
          createdAt: NOW,
          assetCount: 0,
        },
        201,
      );
    }
    if (
      pathname.startsWith("/api/v1/assets/folders/") &&
      request.method() === "PATCH"
    ) {
      const body = request.postDataJSON() as { name?: string };
      if (!assetFolder)
        return json(route, apiError("missing folder", "not_found"), 404);
      assetFolder = { ...assetFolder, name: body.name ?? assetFolder.name };
      return json(route, assetFolder);
    }
    if (
      pathname.startsWith("/api/v1/assets/folders/") &&
      request.method() === "DELETE"
    ) {
      if (!assetFolder)
        return json(route, apiError("missing folder", "not_found"), 404);
      assets = assets.map((asset) =>
        asset.folderId === assetFolder?.id
          ? { ...asset, folderId: null }
          : asset,
      );
      assetFolder = null;
      return json(route, { ok: true });
    }
    if (pathname === "/api/v1/assets" && request.method() === "POST") {
      if (heldUpload) {
        heldUpload.arrived.resolve();
        await heldUpload.release.promise;
        heldUpload = null;
      }
      const attempt = calls.filter(
        (call) => call.method === "POST" && call.path === pathname,
      ).length;
      if (attempt === 1)
        return json(
          route,
          apiError("storage temporarily rejected the image"),
          422,
        );
      const body = request.postDataJSON() as { filename: string; mime: string };
      const uploaded: VisualAsset = {
        id: "asset-uploaded",
        filename: body.filename,
        mime: body.mime,
        bytes: 68,
        width: 1,
        height: 1,
        url: "https://cdn.example.invalid/uploaded.png",
        createdAt: NOW,
        referencesCount: 0,
        tags: [],
        folderId: null,
      };
      assets = [
        uploaded,
        ...assets.filter((asset) => asset.id !== uploaded.id),
      ];
      return json(route, uploaded, 201);
    }
    const idMatch = pathname.match(/^\/api\/v1\/assets\/([^/]+)$/u);
    if (idMatch && request.method() === "GET") {
      const asset = assets.find((candidate) => candidate.id === idMatch[1]);
      return asset
        ? json(route, {
            asset,
            usage: asset.referencesCount
              ? [
                  {
                    kind: "campaign",
                    id: "campaign-summer",
                    name: "Summer launch",
                  },
                  {
                    kind: "template",
                    id: "template-hero",
                    name: "Hero template",
                  },
                ]
              : [],
          })
        : json(route, apiError("missing asset", "not_found"), 404);
    }
    if (idMatch && request.method() === "PATCH") {
      const body = request.postDataJSON() as { alt_text?: string };
      patches.push({ id: idMatch[1], body });
      if (mutationAckMode === "malformed")
        return json(route, { accepted: true });
      assets = assets.map((asset) =>
        asset.id === idMatch[1]
          ? { ...asset, altText: body.alt_text ?? asset.altText }
          : asset,
      );
      return json(
        route,
        assets.find((asset) => asset.id === idMatch[1]),
      );
    }
    if (idMatch && request.method() === "DELETE") {
      const id = idMatch[1];
      const asset = assets.find((candidate) => candidate.id === id);
      if (asset?.referencesCount && url.searchParams.get("force") !== "true") {
        return json(
          route,
          {
            error: {
              code: "has_references",
              message: "asset is used by live drafts",
              count: 2,
              usage: [
                {
                  kind: "campaign",
                  id: "campaign-summer",
                  name: "Summer launch",
                },
                {
                  kind: "template",
                  id: "template-hero",
                  name: "Hero template",
                },
              ],
            },
          },
          409,
        );
      }
      if (url.searchParams.get("force") === "true") forceDeletes.push(id);
      assets = assets.filter((candidate) => candidate.id !== id);
      return json(route, { ok: true });
    }
    const usageMatch = pathname.match(/^\/api\/v1\/assets\/([^/]+)\/usage$/u);
    if (usageMatch && request.method() === "GET")
      return json(route, {
        usage: [
          { kind: "campaign", id: "campaign-summer", name: "Summer launch" },
          { kind: "template", id: "template-hero", name: "Hero template" },
        ],
      });
    const tagsMatch = pathname.match(
      /^\/api\/v1\/assets\/([^/]+)\/tags(?:\/([^/]+))?$/u,
    );
    if (tagsMatch) {
      const asset = assets.find((candidate) => candidate.id === tagsMatch[1]);
      if (request.method() === "GET")
        return json(route, { tags: asset?.tags ?? [] });
      if (request.method() === "POST") {
        const body = request.postDataJSON() as { tag?: string };
        const tags = [
          ...new Set([...(asset?.tags ?? []), body.tag ?? ""]),
        ].filter(Boolean);
        assets = assets.map((candidate) =>
          candidate.id === tagsMatch[1] ? { ...candidate, tags } : candidate,
        );
        return json(route, { tags });
      }
      if (request.method() === "DELETE") return json(route, { ok: true });
    }
    const folderMatch = pathname.match(/^\/api\/v1\/assets\/([^/]+)\/folder$/u);
    if (folderMatch && request.method() === "PATCH")
      return json(route, { ok: true });

    unexpected.push(`${request.method()} ${pathname}`);
    return json(
      route,
      apiError(`Unexpected Assets API route: ${request.method()} ${pathname}`),
      501,
    );
  });

  return {
    calls,
    unexpected,
    unexpectedNetwork,
    forceDeletes,
    patches,
    setListMode: (mode) => {
      listMode = mode;
    },
    setMutationAckMode: (mode) => {
      mutationAckMode = mode;
    },
    holdNextList: async (query) => {
      heldList = {
        query,
        arrived: deferred<void>(),
        release: deferred<void>(),
      };
      await heldList.arrived.promise;
      return () => heldList?.release.resolve();
    },
    holdNextUpload: async () => {
      heldUpload = { arrived: deferred<void>(), release: deferred<void>() };
      await heldUpload.arrived.promise;
      return () => heldUpload?.release.resolve();
    },
  };
}

function expectOnlyExpectedNetwork(api: AssetsApiControl): void {
  expect(api.unexpected).toEqual([]);
  expect(api.unexpectedNetwork).toEqual([]);
}

async function openAssets(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
): Promise<AssetsApiControl> {
  await bootApp(page);
  const api = await installAssetsApi(page);
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="assets"]')
    .click();
  await expect(
    page.getByRole("heading", { name: "Assets", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /summer-hero\.png/u }),
  ).toBeVisible();
  return api;
}

async function saveEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
    fullPage: true,
  });
}

async function dropImage(page: Page, name = "retry.png"): Promise<void> {
  await page.evaluate((filename) => {
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([new Uint8Array([137, 80, 78, 71])], filename, {
        type: "image/png",
      }),
    );
    window.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  }, name);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
}

test("Assets: grid/list, query, IME-safe keyboard selection, Quick Look, and filter requests", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await setTheme(page, "dark");
  const api = await openAssets(page, bootApp);
  await expect(page.getByRole("list", { name: "Assets" })).toBeVisible();
  await expect(page.getByText("Used in 2").first()).toBeVisible();
  await saveEvidence(page, testInfo, "assets-grid-dark");

  const hero = page.locator('[data-library-primary="asset-hero"]');
  await hero.focus();
  await hero.dispatchEvent("keydown", {
    key: "ArrowRight",
    keyCode: 229,
    isComposing: true,
  });
  await expect(hero).toBeFocused();
  await hero.press("ArrowRight");
  await expect(
    page.locator('[data-library-primary="asset-logo"]'),
  ).toBeFocused();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("group", { name: "Selection actions" }),
  ).toContainText("1 selected");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("postwave-logo.png");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByRole("dialog")).toContainText("summer-hero.png");
  await page.getByRole("button", { name: "Close (Esc)" }).click();

  const search = page.getByRole("searchbox", { name: "Search assets" });
  await search.dispatchEvent("compositionstart");
  await search.fill("hero");
  await search.dispatchEvent("compositionend");
  await expect(page.getByText("summer-hero.png").first()).toBeVisible();
  await expect
    .poll(() =>
      api.calls.some(
        (call) =>
          call.path === "/api/v1/assets" && call.query.includes("q=hero"),
      ),
    )
    .toBe(true);
  await page.getByRole("combobox", { name: "Sort" }).selectOption("name");
  await page
    .getByRole("radio", { name: /No reported use/u })
    .check({ force: true });
  await page
    .getByRole("button", { name: "All tags, show assets regardless of tag" })
    .click();
  await page.getByRole("button", { name: /summer, 2 tagged assets/u }).click();
  await page.getByRole("button", { name: /Brand kit, 2 assets/u }).click();
  await expect
    .poll(() =>
      api.calls.some(
        (call) =>
          call.query.includes("sort=name") &&
          call.query.includes("tag=summer") &&
          call.query.includes(`folder_id=${FOLDER_ID}`),
      ),
    )
    .toBe(true);
  await page.getByRole("radio", { name: /^All/u }).check({ force: true });
  await search.fill("");
  await page
    .getByRole("button", { name: "All tags, show assets regardless of tag" })
    .click();
  await page
    .getByRole("button", {
      name: "All folders, show every filed and unfiled asset",
    })
    .click();
  await expect(page.getByText("summer-hero.png").first()).toBeVisible();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Assets", exact: true }),
  ).toBeVisible();
  await setTheme(page, "light");
  await saveEvidence(page, testInfo, "assets-list-light");
  expectOnlyExpectedNetwork(api);
});

test("Assets: upload failure/retry and Clear preserves active uploads until their lifecycle resolves", async ({
  page,
  bootApp,
}, testInfo) => {
  const api = await openAssets(page, bootApp);
  void dropImage(page);
  const tray = page.locator(".lib-upload-tray");
  await expect(tray).toContainText("storage temporarily rejected the image");
  await tray
    .getByRole("button", { name: "Retry upload of retry.png", exact: true })
    .click();
  await expect(tray).toContainText("Uploaded");

  const holdUpload = api.holdNextUpload();
  void dropImage(page, "active.png");
  const releaseUpload = await holdUpload;
  await expect(tray).toContainText("active.png");
  await page
    .getByRole("button", { name: "Dismiss finished and failed uploads" })
    .click();
  await expect(tray).toContainText("active.png");
  await expect(tray).toContainText("Uploading");

  await page.setViewportSize({ width: 640, height: 360 });
  const hero = page.locator('[data-library-primary="asset-hero"]');
  await hero.focus();
  await hero.press("Space");
  const selectionBar = page.getByRole("group", { name: "Selection actions" });
  await expect(selectionBar).toBeVisible();
  await selectionBar.evaluate(async (element) => {
    await Promise.all(
      element.getAnimations().map((animation) => animation.finished),
    );
  });
  const surfaces = await Promise.all([
    tray.boundingBox(),
    selectionBar.boundingBox(),
  ]);
  expect(surfaces[0]).not.toBeNull();
  expect(surfaces[1]).not.toBeNull();
  const trayBox = surfaces[0]!;
  const selectionBox = surfaces[1]!;
  expect(
    trayBox.y + trayBox.height <= selectionBox.y ||
      selectionBox.y + selectionBox.height <= trayBox.y,
  ).toBe(true);
  for (const button of await selectionBar.getByRole("button").all()) {
    const box = await button.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
  await expectNoDocumentOverflow(page);
  await saveEvidence(page, testInfo, "assets-fixed-surfaces-windowed");
  await selectionBar.getByRole("button", { name: /Clear/u }).click();
  await page.setViewportSize({ width: 1280, height: 900 });

  releaseUpload();
  await expect(tray).toContainText("Uploaded");
  await tray.getByRole("button", { name: "Dismiss" }).last().click();
  await saveEvidence(page, testInfo, "assets-upload-cleared");
  expectOnlyExpectedNetwork(api);
});

test("Assets: Quick Look accepts only exact mutation acknowledgements and resolves dirty close", async ({
  page,
  bootApp,
}, testInfo) => {
  const api = await openAssets(page, bootApp);
  await page.locator('[data-library-primary="asset-hero"]').focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  const alt = dialog.getByLabel("Alt text (for accessibility)");
  await alt.fill("Draft alt text");
  const discardPrompt = page.waitForEvent("dialog");
  // Closing is always a discard decision. Leaving the field never implies a
  // save, regardless of whether activation came from pointer, keyboard or AT.
  const closeAttempt = page
    .getByRole("button", { name: "Close (Esc)" })
    .evaluate((button) => (button as HTMLButtonElement).click());
  const prompt = await discardPrompt;
  expect(prompt.message()).toMatch(
    /discard unsaved (asset|alt-text) changes/iu,
  );
  await prompt.dismiss();
  await closeAttempt;
  await expect(dialog).toBeVisible();
  page.once("dialog", (next) => next.accept());
  await page
    .getByRole("button", { name: "Close (Esc)" })
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(dialog).toHaveCount(0);

  await page.locator('[data-library-primary="asset-hero"]').focus();
  await page.keyboard.press("Enter");
  const exactAlt = page
    .getByRole("dialog")
    .getByLabel("Alt text (for accessibility)");
  await exactAlt.fill("Exact acknowledgement alt text");
  await page.getByRole("button", { name: "Save alt text" }).click();
  await expect
    .poll(() =>
      api.patches.some(
        (patch) =>
          patch.id === "asset-hero" &&
          JSON.stringify(patch.body) ===
            JSON.stringify({ alt_text: "Exact acknowledgement alt text" }),
      ),
    )
    .toBe(true);
  await expect(page.getByText("Alt text saved")).toBeVisible();

  api.setMutationAckMode("malformed");
  await exactAlt.fill("Must not commit malformed acknowledgement");
  await page.getByRole("button", { name: "Save alt text" }).click();
  await expect(
    page.getByText(/Alt text save failed|malformed acknowledgement/iu),
  ).toBeVisible();
  await saveEvidence(page, testInfo, "assets-quicklook-mutation-ack");

  await page.setViewportSize({ width: 760, height: 360 });
  const quickLookScroll = page.locator(".lib-quicklook-scroll");
  await expect(quickLookScroll).toBeVisible();
  const reflow = await quickLookScroll.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(reflow.clientHeight).toBeGreaterThan(0);
  expect(reflow.scrollHeight).toBeGreaterThan(reflow.clientHeight);
  await quickLookScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Delete" }),
  ).toBeVisible();
  await expectNoDocumentOverflow(page);
  await saveEvidence(page, testInfo, "assets-quicklook-short-reflow");
  expectOnlyExpectedNetwork(api);
});

test("Assets: malformed, empty, error, partial, and stale responses stay contained", async ({
  page,
  bootApp,
}, testInfo) => {
  const api = await openAssets(page, bootApp);
  api.setListMode("malformed");
  await page.getByRole("combobox", { name: "Sort" }).selectOption("oldest");
  await expect(
    page.getByRole("main", { name: "Assets content" }).getByRole("alert"),
  ).toContainText("invalid asset list");
  await expect(page.getByText("summer-hero.png").first()).toBeVisible();
  api.setListMode("empty");
  await page.getByRole("radio", { name: /Large/u }).check({ force: true });
  await expect(page.getByText("Nothing matches")).toBeVisible();
  api.setListMode("error");
  await page.getByRole("button", { name: "Clear all filters" }).click();
  await expect(
    page.getByRole("main", { name: "Assets content" }).getByRole("alert"),
  ).toContainText(/couldn't refresh assets|server error/iu);
  api.setListMode("partial");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("summer-hero.png").first()).toBeVisible();

  api.setListMode("good");
  const search = page.getByRole("searchbox", { name: "Search assets" });
  const held = api.holdNextList("stale");
  await search.fill("stale");
  const release = await held;
  const catalogStage = page.locator(".lib-catalog-stage");
  await expect(catalogStage).toHaveAttribute("inert", "");
  await expect(page.locator(".lib-catalog-availability")).toContainText(
    "Asset actions will resume when the current catalog arrives.",
  );
  await search.fill("social");
  await expect(page.getByText("social-card.jpg").first()).toBeVisible();
  await expect(catalogStage).not.toHaveAttribute("inert", "");
  await expect(catalogStage).toHaveAttribute("aria-label", "Asset catalog");
  await expect(page.locator(".lib-catalog-availability")).toHaveCount(0);
  release();
  await page.waitForTimeout(100);
  await expect(page.getByText("social-card.jpg").first()).toBeVisible();
  await expect(page.getByText("summer-hero.png").first()).toHaveCount(0);
  await saveEvidence(page, testInfo, "assets-state-containment");
  expectOnlyExpectedNetwork(api);
});

test("Assets: reference-aware deletion requires explicit force acknowledgement", async ({
  page,
  bootApp,
}, testInfo) => {
  const api = await openAssets(page, bootApp);
  const hero = page.locator('[data-library-primary="asset-hero"]');
  await hero.focus();
  await hero.press("Space");
  await page
    .getByRole("group", { name: "Selection actions" })
    .getByRole("button", { name: "Delete" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Delete despite usage?");
  await expect(dialog).toContainText("Summer launch");
  await saveEvidence(page, testInfo, "assets-delete-reference-warning");
  await page.getByRole("button", { name: "Delete anyway" }).click();
  await expect(page.getByText("summer-hero.png").first()).toHaveCount(0);
  expect(api.forceDeletes).toEqual(["asset-hero"]);
  expectOnlyExpectedNetwork(api);
});

test("Assets: viewers are browse-only and compact accessibility modes do not overflow", async ({
  page,
  bootApp,
}, testInfo) => {
  await bootApp(page);
  await page.route("**/api/v1/auth/me", async (route) =>
    json(route, {
      user_id: "viewer",
      tenant_id: "test-tenant",
      email: "viewer@example.invalid",
      role: "viewer",
      effective_role: "viewer",
      workspace_name: "Moosewave",
      workspace_slug: "test-tenant",
    }),
  );
  const api = await installAssetsApi(page);
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="assets"]')
    .click();
  await expect(
    page.getByRole("button", { name: "Delete summer-hero.png" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Viewer access can browse assets but cannot upload them."),
  ).toBeVisible();

  await page.setViewportSize({ width: 320, height: 720 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await expectNoDocumentOverflow(page);
  await saveEvidence(page, testInfo, "assets-viewer-narrow-forced-colors");
  expectOnlyExpectedNetwork(api);
});
