import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Page, Route } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const TAG_IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as const;
const GROUP_IDS = [
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
] as const;
const NOW = "2026-07-18T08:00:00Z";

function tag(
  id: string,
  name: string,
  color: string,
  groupId: string | undefined,
) {
  return {
    id,
    name,
    color,
    description: `${name} audience definition`,
    ...(groupId ? { group_id: groupId } : {}),
    created_at: "2026-06-01T09:00:00Z",
    updated_at: NOW,
    pii: false,
    version: 1,
    etag: `"tag:${id}:v1"`,
  };
}

const INITIAL_TAGS = [
  tag(TAG_IDS[0], "Customer", "rose", GROUP_IDS[0]),
  tag(TAG_IDS[1], "Prospect", "brand-gradient-v1", GROUP_IDS[1]),
  tag(TAG_IDS[2], "VIP", "teal", undefined),
];

interface VisualTagGroup {
  id: string;
  name: string;
  color: string;
  sort_order: number;
  created_at: string;
}

const GROUPS: VisualTagGroup[] = [
  {
    id: GROUP_IDS[0],
    name: "Lifecycle",
    color: "indigo",
    sort_order: 0,
    created_at: "2026-06-01T09:00:00Z",
  },
  {
    id: GROUP_IDS[1],
    name: "Imported",
    color: "legacy-gradient",
    sort_order: -10,
    created_at: "2026-06-01T09:00:00Z",
  },
];

type TagsMode = "good" | "offline" | "malformed";

interface TagsApiControl {
  setMode: (mode: TagsMode) => void;
  patches: Array<{ body: Record<string, unknown>; ifMatch: string | null }>;
  groupWrites: Array<{ method: string; body: Record<string, unknown> | null }>;
}

async function installTagsApi(page: Page): Promise<TagsApiControl> {
  let mode: TagsMode = "good";
  let tags = INITIAL_TAGS.map((item) => ({ ...item }));
  let groups = GROUPS.map((item) => ({ ...item }));
  const patches: TagsApiControl["patches"] = [];
  const groupWrites: TagsApiControl["groupWrites"] = [];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const isTagsDomain =
      url.pathname === "/api/v1/tags" ||
      url.pathname === "/api/v1/tag-groups" ||
      url.pathname === "/api/v1/tag-taxonomy" ||
      url.pathname.startsWith("/api/v1/tags/") ||
      url.pathname.startsWith("/api/v1/tag-groups/") ||
      url.pathname.startsWith("/api/v1/tag-taxonomy/");
    if (!isTagsDomain) {
      await route.fallback();
      return;
    }
    if (mode === "offline") {
      await route.abort("internetdisconnected");
      return;
    }
    if (url.pathname === "/api/v1/tags" && request.method() === "GET") {
      const items =
        mode === "malformed"
          ? [
              tags[0],
              {
                ...tags[1],
                name: "customer",
              },
            ]
          : tags;
      await json(route, { items });
      return;
    }
    if (url.pathname === "/api/v1/tag-groups" && request.method() === "GET") {
      await json(route, { items: groups });
      return;
    }
    if (url.pathname === "/api/v1/tag-groups" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      groupWrites.push({ method: "POST", body });
      const created = {
        id: "77777777-7777-4777-8777-777777777777",
        name: String(body.name ?? ""),
        color: String(body.color ?? ""),
        sort_order: Number(body.sort_order ?? 0),
        created_at: NOW,
      };
      groups = [...groups, created];
      await json(route, created, 201);
      return;
    }
    if (
      url.pathname.startsWith("/api/v1/tag-groups/") &&
      request.method() === "PATCH"
    ) {
      const id = url.pathname.split("/").at(-1) ?? "";
      const body = request.postDataJSON() as Record<string, unknown>;
      groupWrites.push({ method: "PATCH", body });
      const current = groups.find((item) => item.id === id);
      if (!current) {
        await json(
          route,
          { error: { code: "not_found", message: "not found" } },
          404,
        );
        return;
      }
      const next = {
        ...current,
        name: typeof body.name === "string" ? body.name : current.name,
      };
      groups = groups.map((item) => (item.id === id ? next : item));
      await json(route, next);
      return;
    }
    if (
      url.pathname.startsWith("/api/v1/tag-groups/") &&
      request.method() === "DELETE"
    ) {
      const id = url.pathname.split("/").at(-1) ?? "";
      groupWrites.push({ method: "DELETE", body: null });
      groups = groups.filter((item) => item.id !== id);
      tags = tags.map((item) =>
        item.group_id === id ? { ...item, group_id: undefined } : item,
      );
      await json(route, { ok: true });
      return;
    }
    if (url.pathname === "/api/v1/tag-taxonomy") {
      await json(route, {
        items: [
          {
            tag: "Customer",
            subscribers: 1_284,
            registered: true,
            created_at: NOW,
          },
          {
            tag: "Prospect",
            subscribers: 642,
            registered: true,
            created_at: NOW,
          },
          { tag: "VIP", subscribers: 87, registered: true, created_at: NOW },
          {
            tag: "Imported legacy",
            subscribers: 21,
            registered: false,
            created_at: NOW,
          },
        ],
      });
      return;
    }
    if (
      url.pathname === "/api/v1/tag-taxonomy/subscribers" &&
      request.method() === "GET"
    ) {
      const requestedTag = url.searchParams.get("tag") ?? "";
      await json(route, {
        tag: requestedTag,
        items: [
          {
            id: "66666666-6666-4666-8666-666666666666",
            email: "reader@example.test",
            status: "enabled",
            created_at: "2026-06-02T10:00:00Z",
          },
        ],
      });
      return;
    }
    if (url.pathname.endsWith("/membership")) {
      const tagId = url.pathname.split("/").at(-2) ?? "";
      const complete = tagId !== TAG_IDS[1];
      await json(route, {
        tag_id: tagId,
        days: Number(url.searchParams.get("days") ?? 30),
        current_count: complete ? 1_284 : 642,
        added: 4,
        removed: 3,
        daily: [
          { date: "2026-07-16", net: 2 },
          { date: "2026-07-17", net: -1 },
        ],
        coverage: {
          contract_version: "canonical-join-events-v2",
          coverage_started_at: complete
            ? "2026-06-01T00:00:00Z"
            : "2026-07-15T00:00:00Z",
          as_of: NOW,
          completeness: "complete_from_coverage_start",
          source: "subscriber_tags_event_ledger",
          requested_window_complete: complete,
        },
      });
      return;
    }
    if (
      url.pathname.startsWith("/api/v1/tags/") &&
      request.method() === "PATCH"
    ) {
      const id = url.pathname.split("/").at(-1) ?? "";
      const body = request.postDataJSON() as Record<string, unknown>;
      patches.push({ body, ifMatch: request.headers()["if-match"] ?? null });
      const current = tags.find((item) => item.id === id);
      if (!current) {
        await json(
          route,
          { error: { code: "not_found", message: "not found" } },
          404,
        );
        return;
      }
      const requestedGroupId =
        typeof body.group_id === "string" ? body.group_id : current.group_id;
      const next = {
        ...current,
        name: typeof body.name === "string" ? body.name : current.name,
        color: typeof body.color === "string" ? body.color : current.color,
        description:
          typeof body.description === "string"
            ? body.description
            : current.description,
        group_id: requestedGroupId === "" ? undefined : requestedGroupId,
        updated_at: NOW,
        version: 2,
        etag: `"tag:${id}:v2"`,
      };
      tags = tags.map((item) => (item.id === id ? next : item));
      await json(route, next, 200, {
        ETag: next.etag,
        "Access-Control-Expose-Headers": "ETag",
      });
      return;
    }
    await route.fallback();
  });

  return {
    setMode: (next) => (mode = next),
    patches,
    groupWrites,
  };
}

async function json(
  route: Route,
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
    headers,
  });
}

async function openTags(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
): Promise<TagsApiControl> {
  await bootApp(page);
  const control = await installTagsApi(page);
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="tags"]')
    .click();
  await expect(
    page.getByRole("heading", { name: "Tags", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open tag Customer" }),
  ).toBeVisible();
  return control;
}

async function assertNoSeriousAxeViolations(page: Page): Promise<void> {
  await page.addScriptTag({ content: AXE_SOURCE });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            root: Document,
            options: { runOnly: { type: "tag"; values: string[] } },
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ target: string[]; failureSummary?: string }>;
            }>;
          }>;
        };
      }
    ).axe;
    const result = await axe.run(document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
    });
    return result.violations
      .filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      )
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          failure: node.failureSummary,
        })),
      }));
  });
  expect(violations).toEqual([]);
}

for (const theme of ["dark", "light"] as const) {
  test(`Tags populated ${theme} theme is semantic and truthful`, async ({
    page,
    bootApp,
    setTheme,
  }) => {
    await setTheme(page, theme);
    await openTags(page, bootApp);

    await expect(page.getByRole("table")).toBeVisible();
    await expect(
      page.getByText("Legacy colour", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Delete Customer" }),
    ).toHaveAttribute("aria-disabled", "true");
    await assertNoSeriousAxeViolations(page);
  });
}

test("Tags detail uses real Back/Forward history and restores row focus", async ({
  page,
  bootApp,
}) => {
  await openTags(page, bootApp);
  const origin = page.getByRole("button", { name: "Open tag Customer" });
  await origin.focus();
  await origin.click();
  await expect(page.getByRole("dialog", { name: "Customer" })).toBeVisible();
  await expect(page).toHaveURL(/overlay=tag-detail/u);
  await expect(
    page.getByText("Exact for the requested 30-day window."),
  ).toBeVisible();

  await page.evaluate(() => window.history.back());
  await expect(page).not.toHaveURL(/overlay=tag-detail/u);
  await expect(page.getByRole("dialog", { name: "Customer" })).toBeHidden();
  await expect(origin).toBeFocused();

  await page.evaluate(() => window.history.forward());
  await expect(page).toHaveURL(/overlay=tag-detail/u);
  await expect(page.getByRole("dialog", { name: "Customer" })).toBeVisible();
});

test("Tags rename and group assignment use one omission-preserving If-Match PATCH", async ({
  page,
  bootApp,
}) => {
  const control = await openTags(page, bootApp);
  await page.getByRole("button", { name: "Edit Customer" }).click();
  const dialog = page.getByRole("dialog", { name: "Edit tag" });
  await dialog.getByLabel("Name").fill("Priority customer");
  await dialog.getByLabel("Group").selectOption(GROUP_IDS[1]);
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(dialog).toBeHidden();

  expect(control.patches).toEqual([
    {
      body: { name: "Priority customer", group_id: GROUP_IDS[1] },
      ifMatch: `"tag:${TAG_IDS[0]}:v1"`,
    },
  ]);
  await expect(
    page.getByRole("button", { name: "Open tag Priority customer" }),
  ).toBeVisible();
});

test("Tags group management settles create, rename, and safe ungrouping delete", async ({
  page,
  bootApp,
}) => {
  const control = await openTags(page, bootApp);
  await page
    .getByRole("button", { name: "Create, rename, or delete tag groups" })
    .click();
  const dialog = page.getByRole("dialog", { name: "Manage tag groups" });
  await dialog.getByLabel("New group").fill("Engagement");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();

  const created = dialog.getByLabel("Group name for Engagement");
  await expect(created).toBeVisible();
  await created.fill("Intent");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByLabel("Group name for Intent")).toBeVisible();

  await dialog.getByRole("button", { name: "Delete group Intent" }).click();
  const confirmation = dialog.getByRole("alertdialog", {
    name: "Confirm delete group",
  });
  await confirmation
    .getByRole("button", { name: "Delete group", exact: true })
    .click();
  await expect(dialog.getByLabel("Group name for Intent")).toBeHidden();
  expect(control.groupWrites).toEqual([
    {
      method: "POST",
      body: { name: "Engagement", color: "", sort_order: 0 },
    },
    { method: "PATCH", body: { name: "Intent" } },
    { method: "DELETE", body: null },
  ]);
  await assertNoSeriousAxeViolations(page);
});

test("Tags retain last-good rows across offline and malformed refreshes", async ({
  page,
  bootApp,
}) => {
  const control = await openTags(page, bootApp);
  const customer = page.getByRole("button", { name: "Open tag Customer" });

  control.setMode("offline");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText(/Last verified data from/u).first(),
  ).toBeVisible();
  await expect(customer).toBeVisible();

  control.setMode("malformed");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText(/invalid tag catalogue/u)).toBeVisible();
  await expect(customer).toBeVisible();
  await expect(page.getByText("No tags match this view")).toBeHidden();
});

test("Tags narrow layout contains the viewport and keeps group filtering operable", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.setViewportSize({ width: 560, height: 800 });
  await setTheme(page, "light");
  await openTags(page, bootApp);

  const groupSelect = page.getByLabel("Filter by tag group");
  await expect(groupSelect).toBeVisible();
  await page.getByRole("checkbox", { name: "Select Customer" }).check();
  await expect(page.getByRole("group", { name: "Tag actions" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Recolour…" })).toBeVisible();
  await groupSelect.selectOption(GROUP_IDS[0]);
  await expect(page.getByRole("group", { name: "Tag actions" })).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Open tag Customer" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open tag VIP" })).toBeHidden();
  const overflow = await page.evaluate(() => {
    if (document.documentElement.scrollWidth <= window.innerWidth + 1)
      return [];
    return Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .map((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        let ancestor = node.parentElement;
        let clipped = false;
        while (ancestor && ancestor !== document.body) {
          const ancestorStyle = getComputedStyle(ancestor);
          if (
            ancestorStyle.overflowX === "auto" ||
            ancestorStyle.overflowX === "scroll" ||
            ancestorStyle.overflowX === "hidden" ||
            ancestorStyle.overflowX === "clip"
          ) {
            clipped = true;
            break;
          }
          ancestor = ancestor.parentElement;
        }
        return {
          selector: `${node.tagName.toLowerCase()}.${node.className}`,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          scrollWidth: node.scrollWidth,
          overflowX: style.overflowX,
          clipped,
        };
      })
      .filter(
        (item) =>
          item.right > window.innerWidth + 1 &&
          !item.clipped &&
          item.overflowX === "visible" &&
          item.width > 0,
      )
      .slice(-12);
  });
  expect(overflow).toEqual([]);
  const { pageScroll, tableScrollLeft, layoutMetrics } = await page.evaluate(
    () => {
      window.scrollTo({ left: 10_000, top: 0, behavior: "instant" });
      const left = window.scrollX;
      window.scrollTo({ left: 0, top: 0, behavior: "instant" });
      const tableScroll =
        document.querySelector<HTMLElement>(".tags-table-scroll");
      tableScroll?.scrollTo({ left: 10_000, top: 0, behavior: "instant" });
      const tableLeft = tableScroll?.scrollLeft ?? 0;
      tableScroll?.scrollTo({ left: 0, top: 0, behavior: "instant" });
      const layoutMetrics: Array<Record<string, unknown>> = [];
      let current: HTMLElement | null = tableScroll;
      while (current) {
        const rect = current.getBoundingClientRect();
        const style = getComputedStyle(current);
        layoutMetrics.push({
          node: `${current.tagName.toLowerCase()}.${current.className}`,
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          clientWidth: current.clientWidth,
          scrollWidth: current.scrollWidth,
          minWidth: style.minWidth,
          maxWidth: style.maxWidth,
          overflowX: style.overflowX,
        });
        current = current.parentElement;
      }
      return {
        pageScroll: left,
        tableScrollLeft: tableLeft,
        layoutMetrics,
      };
    },
  );
  expect(pageScroll, JSON.stringify(layoutMetrics, null, 2)).toBe(0);
  expect(
    tableScrollLeft,
    "the tag table should remain scrollable",
  ).toBeGreaterThan(0);
});

test("Tags forced colours and reduced motion preserve status and chart semantics", async ({
  page,
  bootApp,
}) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await openTags(page, bootApp);
  await page.getByRole("button", { name: "Open tag Prospect" }).click();
  await expect(page.getByText("Joined in covered period")).toBeVisible();
  await expect(
    page.getByText(/earlier part of the requested 30-day window/u),
  ).toBeVisible();
  const bar = page.locator(".tags-membership-bar").first();
  await expect(bar).toBeVisible();
  expect(
    await bar.evaluate((node) => getComputedStyle(node).forcedColorAdjust),
  ).toBe("none");
});
