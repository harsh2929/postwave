import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Page, Route, TestInfo } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = "2026-07-22T12:00:00.000Z";
const CONFIDENTIAL_CANARY = "never-list-this-secret@example.invalid";

const IDS = {
  editorial: "11111111-1111-4111-8111-111111111111",
  promotion: "22222222-2222-4222-8222-222222222222",
  cadence: "33333333-3333-4333-8333-333333333333",
  created: "44444444-4444-4444-8444-444444444444",
} as const;

type CollectionType = "content" | "coupons" | "schedule";
type SourceType = "uploaded" | "api" | "manual";
type ListMode = "good" | "empty" | "error" | "malformed" | "overlap";

interface CollectionRecord {
  id: string;
  tenant_id: string;
  name: string;
  collection_type: CollectionType;
  source_type: SourceType;
  data: Array<Record<string, unknown>>;
  row_count: number;
  created_at: string;
  updated_at: string;
}

const INITIAL_COLLECTIONS: CollectionRecord[] = [
  {
    id: IDS.editorial,
    tenant_id: TENANT_ID,
    name: "Editorial snippets",
    collection_type: "content",
    source_type: "uploaded",
    data: [
      { title: "Welcome", owner: CONFIDENTIAL_CANARY },
      { title: "Renewal", owner: "lifecycle@example.invalid" },
    ],
    row_count: 2,
    created_at: "2026-07-20T09:00:00.000Z",
    updated_at: NOW,
  },
  {
    id: IDS.promotion,
    tenant_id: TENANT_ID,
    name: "Legacy promotion references",
    collection_type: "coupons",
    source_type: "manual",
    data: [{ code: "SYNTHETIC-ONLY" }],
    row_count: 1,
    created_at: "2026-07-19T09:00:00.000Z",
    updated_at: "2026-07-21T10:00:00.000Z",
  },
  {
    id: IDS.cadence,
    tenant_id: TENANT_ID,
    name: "Launch cadence",
    collection_type: "schedule",
    source_type: "api",
    data: [{ phase: "announce", offset_days: 0 }],
    row_count: 1,
    created_at: "2026-07-18T09:00:00.000Z",
    updated_at: "2026-07-20T10:00:00.000Z",
  },
];

interface DeferredRequest {
  promise: Promise<void>;
  release: () => void;
}

interface CollectionsApiControl {
  calls: Array<{ method: string; path: string; query: string; body?: unknown }>;
  detailReads: string[];
  unexpected: string[];
  setListMode: (mode: ListMode) => void;
  deferNextCreate: () => () => void;
  holdNextList: (query: string) => Promise<() => void>;
}

function deferredRequest(): DeferredRequest {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(body),
  });
}

function summary(record: CollectionRecord): CollectionRecord {
  return { ...record, data: [] };
}

async function installCollectionsApi(
  page: Page,
  role: "admin" | "viewer",
): Promise<CollectionsApiControl> {
  let rows = INITIAL_COLLECTIONS.map((row) => ({
    ...row,
    data: row.data.map((cell) => ({ ...cell })),
  }));
  let listMode: ListMode = "good";
  let nextCreateGate: DeferredRequest | null = null;
  let heldList: {
    query: string;
    arrived: DeferredRequest;
    release: DeferredRequest;
  } | null = null;
  const calls: CollectionsApiControl["calls"] = [];
  const detailReads: string[] = [];
  const unexpected: string[] = [];

  await page.route("**/api/v1/auth/me", async (route) => {
    await json(route, {
      user_id: `collections-${role}`,
      tenant_id: TENANT_ID,
      email: `${role}@collections.example.invalid`,
      role,
      effective_role: role,
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Collections qualification",
      workspace_slug: "collections-qualification",
    });
  });

  await page.route("**/api/v1/collections**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();
    const body = method === "GET" ? undefined : request.postDataJSON();
    calls.push({ method, path: pathname, query: url.search, ...(body === undefined ? {} : { body }) });

    if (pathname === "/api/v1/collections" && method === "GET") {
      const query = url.searchParams.get("q") ?? "";
      if (heldList?.query === query) {
        heldList.arrived.release();
        await heldList.release.promise;
        heldList = null;
      }
      if (listMode === "error") {
        await json(
          route,
          { error: { code: "catalog_unavailable", message: "Catalog unavailable" } },
          503,
        );
        return;
      }
      if (listMode === "malformed") {
        await json(route, { items: [{ id: "not-a-uuid", data: CONFIDENTIAL_CANARY }], total: "3" });
        return;
      }
      if (listMode === "empty") {
        await json(route, { items: [], total: 0 });
        return;
      }
      if (listMode === "overlap" && url.searchParams.has("cursor")) {
        await json(route, {
          items: [summary(rows[0]!)],
          total: rows.length,
          next_cursor: url.searchParams.get("cursor"),
        });
        return;
      }

      const type = url.searchParams.get("collection_type");
      const normalizedQuery = query.toLocaleLowerCase();
      const filtered = rows.filter(
        (row) =>
          (!normalizedQuery || row.name.toLocaleLowerCase().includes(normalizedQuery)) &&
          (!type || row.collection_type === type),
      );
      const cursor = url.searchParams.get("cursor");
      const firstPage = !cursor && !query && !type;
      const selected = firstPage
        ? filtered.slice(0, 2)
        : cursor === "collections-page-2"
          ? filtered.slice(2)
          : filtered;
      await json(route, {
        items: selected.map(summary),
        total: filtered.length,
        ...(firstPage && filtered.length > 2
          ? { next_cursor: "collections-page-2" }
          : {}),
      });
      return;
    }

    if (pathname === "/api/v1/collections" && method === "POST") {
      const gate = nextCreateGate;
      nextCreateGate = null;
      if (gate) await gate.promise;
      const input = body as {
        name: string;
        collection_type: CollectionType;
        source_type: SourceType;
        data: Array<Record<string, unknown>>;
      };
      const created: CollectionRecord = {
        id: IDS.created,
        tenant_id: TENANT_ID,
        name: input.name,
        collection_type: input.collection_type,
        source_type: input.source_type,
        data: input.data,
        row_count: input.data.length,
        created_at: NOW,
        updated_at: NOW,
      };
      rows = [created, ...rows.filter((row) => row.id !== created.id)];
      await json(route, created, 201);
      return;
    }

    const detailMatch = pathname.match(/^\/api\/v1\/collections\/([^/]+)$/u);
    if (detailMatch) {
      const id = detailMatch[1]!;
      const record = rows.find((row) => row.id === id);
      if (!record) {
        await json(route, { error: { code: "not_found", message: "Collection not found" } }, 404);
        return;
      }
      if (method === "GET") {
        detailReads.push(id);
        await json(route, record);
        return;
      }
      if (method === "PATCH") {
        const input = body as Partial<Pick<CollectionRecord, "name" | "collection_type">>;
        const updated = { ...record, ...input, updated_at: NOW };
        rows = rows.map((row) => (row.id === id ? updated : row));
        await json(route, updated);
        return;
      }
      if (method === "DELETE") {
        rows = rows.filter((row) => row.id !== id);
        await json(route, { ok: true });
        return;
      }
    }

    unexpected.push(`${method} ${pathname}${url.search}`);
    await json(
      route,
      { error: { code: "unexpected_route", message: "Unexpected Collections request" } },
      501,
    );
  });

  return {
    calls,
    detailReads,
    unexpected,
    setListMode: (mode) => {
      listMode = mode;
    },
    deferNextCreate: () => {
      const gate = deferredRequest();
      nextCreateGate = gate;
      return gate.release;
    },
    holdNextList: async (query) => {
      heldList = {
        query,
        arrived: deferredRequest(),
        release: deferredRequest(),
      };
      await heldList.arrived.promise;
      return () => heldList?.release.release();
    },
  };
}

async function openCollections(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
  role: "admin" | "viewer" = "admin",
): Promise<CollectionsApiControl> {
  await bootApp(page);
  const api = await installCollectionsApi(page, role);
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="collections"]')
    .click();
  await expect(
    page.getByRole("heading", { name: "Reference collections", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Editorial snippets", { exact: true })).toBeVisible();
  return api;
}

async function seriousAxeViolations(
  page: Page,
  disableColorContrast = false,
): Promise<unknown[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async (disableContrast) => {
    const result = await (
      window as unknown as {
        axe: {
          run: (
            root: Document | Element,
            options: Record<string, unknown>,
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ target: string[]; failureSummary?: string }>;
            }>;
          }>;
        };
      }
    ).axe.run(document.querySelector(".collections-route") ?? document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
      ...(disableContrast
        ? { rules: { "color-contrast": { enabled: false } } }
        : {}),
    });
    return result.violations
      .filter((violation) => violation.impact === "critical" || violation.impact === "serious")
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          failure: node.failureSummary,
        })),
      }));
  }, disableColorContrast);
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

async function dropFile(
  page: Page,
  name: string,
  contents: string,
  type: string,
): Promise<void> {
  await page.locator(".collections-dropzone").evaluate(
    (element, file) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([file.contents], file.name, { type: file.type }));
      element.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
    },
    { name, contents, type },
  );
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

for (const theme of ["dark", "light"] as const) {
  test(`Collections tells the truth, paginates, filters, and reveals rows explicitly in ${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1_000 });
    await setTheme(page, theme);
    const api = await openCollections(page, bootApp);

    await expect(page.getByText("Know what this workspace stores")).toBeVisible();
    await expect(page.getByText(/does not publish it to campaigns, personalization, or automations/iu)).toBeVisible();
    await expect(page.getByText(CONFIDENTIAL_CANARY)).toHaveCount(0);
    expect(
      api.calls.some(
        (call) =>
          call.method === "GET" &&
          call.path === "/api/v1/collections" &&
          call.query.includes("include_data=false") &&
          call.query.includes("limit=50"),
      ),
    ).toBe(true);

    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.getByText("Launch cadence", { exact: true })).toBeVisible();
    expect(
      api.calls.some((call) => call.query.includes("cursor=collections-page-2")),
    ).toBe(true);

    const search = page.getByLabel("Search by name");
    await search.dispatchEvent("compositionstart");
    await search.fill("Launch");
    await search.dispatchEvent("compositionend");
    await expect(page.getByText("Launch cadence", { exact: true })).toBeVisible();
    await expect(page.getByText("Editorial snippets", { exact: true })).toHaveCount(0);
    await expect
      .poll(() => api.calls.some((call) => call.query.includes("q=Launch")))
      .toBe(true);

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.getByText("Editorial snippets", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Review and edit Editorial snippets" }).click();
    const detail = page.getByRole("dialog", {
      name: "Reference collection details",
    });
    await expect(detail).toBeVisible();
    await expect(detail.getByText(CONFIDENTIAL_CANARY)).toBeVisible();
    expect(api.detailReads).toEqual([IDS.editorial]);
    await expect(detail.getByRole("region", { name: "Stored reference rows" })).toBeVisible();

    expect(api.unexpected).toEqual([]);
    expect(await seriousAxeViolations(page)).toEqual([]);
    await saveEvidence(page, testInfo, `collections-${theme}`);
  });
}

test("Collections validates imports, protects dirty drafts, and single-flights create", async ({
  page,
  bootApp,
}, testInfo) => {
  const api = await openCollections(page, bootApp);
  await page.getByRole("button", { name: "Import reference data" }).click();
  const dialog = page.getByRole("dialog", { name: "Import reference data" });
  await dropFile(page, "ambiguous.csv", "key,key\none,two\n", "text/csv");
  await expect(dialog.getByRole("alert")).toContainText(/unique|appears twice/iu);

  await dropFile(
    page,
    "launch-content.csv",
    "title,url\nWelcome,https://example.invalid/welcome\nRenewal,https://example.invalid/renewal\n",
    "text/csv",
  );
  await expect(dialog.getByText("Structure checked locally")).toBeVisible();
  await expect(dialog.getByText(/2 rows · 2 columns/iu)).toBeVisible();
  await expect(dialog.getByLabel("Collection name")).toHaveValue("launch-content");

  await page.keyboard.press("Escape");
  const discard = page.getByRole("alertdialog", { name: "Discard this import draft?" });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeVisible();

  const releaseCreate = api.deferNextCreate();
  await dialog.getByRole("button", { name: "Create reference collection" }).click();
  await expect(dialog.getByRole("button", { name: "Saving…" })).toBeDisabled();
  await page.keyboard.press("Enter");
  expect(
    api.calls.filter(
      (call) => call.method === "POST" && call.path === "/api/v1/collections",
    ),
  ).toHaveLength(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  releaseCreate();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("launch-content", { exact: true })).toBeVisible();

  const create = api.calls.find(
    (call) => call.method === "POST" && call.path === "/api/v1/collections",
  );
  expect(create?.body).toEqual({
    name: "launch-content",
    collection_type: "content",
    source_type: "uploaded",
    data: [
      { title: "Welcome", url: "https://example.invalid/welcome" },
      { title: "Renewal", url: "https://example.invalid/renewal" },
    ],
  });
  expect(api.unexpected).toEqual([]);
  await saveEvidence(page, testInfo, "collections-import-created");
});

test("Collections contains malformed, failed, overlapping, and stale list responses", async ({
  page,
  bootApp,
}, testInfo) => {
  const api = await openCollections(page, bootApp);

  api.setListMode("malformed");
  await page.getByRole("button", { name: "Refresh" }).click();
  const routeAlerts = page.locator(".collections-route").getByRole("alert");
  await expect(routeAlerts.filter({ hasText: /invalid metadata page/iu })).toBeVisible();
  await expect(page.getByText("Editorial snippets", { exact: true })).toBeVisible();
  await expect(page.getByText(CONFIDENTIAL_CANARY)).toHaveCount(0);

  api.setListMode("error");
  await page.locator(".collections-route").getByRole("button", { name: "Retry" }).click();
  await expect(
    routeAlerts.filter({ hasText: /server error.*verified metadata remains/iu }),
  ).toBeVisible();
  await expect(page.getByText("Catalog unavailable", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Editorial snippets", { exact: true })).toBeVisible();

  api.setListMode("overlap");
  await page.locator(".collections-route").getByRole("button", { name: "Retry" }).click();
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(
    routeAlerts.filter({ hasText: /safe continuation|pagination stopped/iu }),
  ).toBeVisible();
  await expect(page.getByText("Launch cadence", { exact: true })).toHaveCount(0);

  api.setListMode("good");
  const held = api.holdNextList("stale");
  await page.getByLabel("Search by name").fill("stale");
  const release = await held;
  await page.getByLabel("Search by name").fill("Launch");
  await expect(page.getByText("Launch cadence", { exact: true })).toBeVisible();
  release();
  await page.waitForTimeout(100);
  await expect(page.getByText("Launch cadence", { exact: true })).toBeVisible();
  await expect(page.getByText("Editorial snippets", { exact: true })).toHaveCount(0);

  expect(api.unexpected).toEqual([]);
  await saveEvidence(page, testInfo, "collections-state-containment");
});

test("Collections metadata edit and hard delete require explicit current intent", async ({
  page,
  bootApp,
}, testInfo) => {
  const api = await openCollections(page, bootApp);
  await page.getByRole("button", { name: "Review and edit Editorial snippets" }).click();
  const detail = page.getByRole("dialog", {
    name: "Reference collection details",
  });
  await detail.getByLabel("Collection name").fill("Editorial snippets reviewed");
  await detail.getByRole("button", { name: "Save metadata changes" }).click();
  await expect(detail).toBeHidden();
  await expect(page.getByText("Editorial snippets reviewed", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Delete Editorial snippets reviewed" }).click();
  const confirm = page.getByRole("alertdialog", {
    name: "Permanently delete reference collection?",
  });
  await expect(confirm).toContainText("2 stored rows");
  const deleteButton = confirm.getByRole("button", { name: "Delete permanently" });
  await expect(deleteButton).toBeDisabled();
  await confirm.locator('input[type="text"]').fill("Editorial snippets reviewed");
  await expect(deleteButton).toBeEnabled();
  await deleteButton.click();
  await expect(page.getByText("Editorial snippets reviewed", { exact: true })).toHaveCount(0);

  const patch = api.calls.find((call) => call.method === "PATCH");
  expect(patch?.body).toEqual({
    name: "Editorial snippets reviewed",
    collection_type: "content",
  });
  expect(api.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  expect(api.unexpected).toEqual([]);
  await saveEvidence(page, testInfo, "collections-delete-ceremony");
});

test("Collections viewer mode withholds row reads and contains a 320px forced-color window", async ({
  page,
  bootApp,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  const api = await openCollections(page, bootApp, "viewer");

  await expect(page.getByText(/Viewer mode shows names, types, dates, and exact row counts only/iu)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Import reference data" }),
  ).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("button", { name: /Review and edit/iu })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Delete /u })).toHaveCount(0);
  await expect(page.getByText(CONFIDENTIAL_CANARY)).toHaveCount(0);
  expect(api.detailReads).toEqual([]);
  expect(api.calls.filter((call) => call.method !== "GET")).toEqual([]);

  const tableRegion = page.getByRole("region", { name: "Reference collection metadata" });
  await tableRegion.focus();
  await expect(tableRegion).toBeFocused();
  const containment = await tableRegion.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    scrollable: element.scrollWidth > element.clientWidth,
  }));
  expect(containment.scrollable).toBe(true);
  await expectNoDocumentOverflow(page);
  expect(await seriousAxeViolations(page, true)).toEqual([]);
  expect(api.unexpected).toEqual([]);
  await testInfo.attach("collections-narrow-measurements.json", {
    body: JSON.stringify(containment, null, 2),
    contentType: "application/json",
  });
  await saveEvidence(page, testInfo, "collections-viewer-narrow-forced-colors");
});
