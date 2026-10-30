import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Page, Route, TestInfo } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const ISSUE_IDS = {
  fieldNotes: "11111111-1111-4111-8111-111111111111",
  systems: "22222222-2222-4222-8222-222222222222",
  release: "33333333-3333-4333-8333-333333333333",
  handbook: "44444444-4444-4444-8444-444444444444",
} as const;

const POPULATED_ISSUES = [
  {
    campaignId: ISSUE_IDS.fieldNotes,
    slug: "field-notes-from-a-quiet-launch",
    subject: "Field notes from a quiet launch",
    excerpt:
      "What the team learned from releasing deliberately, measuring patiently, and keeping reader trust intact.",
    publishedAt: "2026-07-25T11:30:00.000Z",
    pinned: true,
    viewCount: 18_420,
    uniqueVisitors: 11_304,
  },
  {
    campaignId: ISSUE_IDS.systems,
    slug: "the-systems-behind-useful-email",
    subject: "The systems behind useful email",
    excerpt:
      "A practical tour through durable editorial operations and the details readers never have to notice.",
    publishedAt: "2026-07-18T08:15:00.000Z",
    pinned: false,
    viewCount: 12_840,
    uniqueVisitors: 7_940,
  },
  {
    campaignId: ISSUE_IDS.release,
    slug: "release-notes-july",
    subject: "Release notes · July",
    excerpt: "Every product refinement shipped this month, without the noise.",
    publishedAt: "2026-07-12T13:00:00.000Z",
    pinned: false,
    viewCount: 9_106,
    uniqueVisitors: 5_624,
  },
  {
    campaignId: ISSUE_IDS.handbook,
    slug: "a-reader-first-publishing-handbook",
    subject:
      "A reader-first publishing handbook for thoughtful teams with deliberately long issue titles",
    excerpt:
      "A long-form operating manual for teams that want every archive issue to remain clear, discoverable, and useful.",
    publishedAt: "2026-07-03T06:45:00.000Z",
    pinned: false,
    viewCount: 8_254,
    uniqueVisitors: 4_988,
  },
] as const;

type ArchiveRole = "admin" | "viewer";
type ResponseMode = "ready" | "failure";

interface ArchiveHarnessOptions {
  empty?: boolean;
  listMode?: ResponseMode;
  role?: ArchiveRole;
  statsMode?: ResponseMode;
}

interface ArchiveHarness {
  advancedRequests: string[];
  archiveListRequests: string[];
  mutationRequests: string[];
  setListMode: (mode: ResponseMode) => void;
  setStatsMode: (mode: ResponseMode) => void;
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function previewFor(slug: string): Record<string, unknown> {
  const issue = POPULATED_ISSUES.find((candidate) => candidate.slug === slug);
  if (!issue) {
    return {
      error: { code: "not_found", message: "Archive issue not found." },
    };
  }
  return {
    slug: issue.slug,
    subject: issue.subject,
    excerpt: issue.excerpt,
    publishedAt: issue.publishedAt,
    pinned: issue.pinned,
    campaignId: issue.campaignId,
    htmlBody:
      "<h1>Field notes</h1><p>This publication snapshot contains tested, reader-safe HTML.</p>",
    metaDescription: "A measured release and the systems behind it.",
    authorName: "Moosewave Editorial",
    canonicalUrl: "",
    ogImage: "",
    heroImage: "",
  };
}

async function installArchiveHarness(
  page: Page,
  options: ArchiveHarnessOptions = {},
): Promise<ArchiveHarness> {
  let listMode = options.listMode ?? "ready";
  let statsMode = options.statsMode ?? "ready";
  const role = options.role ?? "admin";
  const archiveListRequests: string[] = [];
  const mutationRequests: string[] = [];
  const advancedRequests: string[] = [];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();

    if (pathname === "/api/v1/auth/me") {
      await json(route, {
        user_id: `archive-${role}`,
        tenant_id: "archive-qualification-tenant",
        email: `${role}@archive.example.invalid`,
        role,
        effective_role: role,
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Archive qualification",
        workspace_slug: "archive-qualification",
      });
      return;
    }

    if (pathname === "/api/v1/dashboard/layout" && method === "GET") {
      await json(route, {
        userId: `archive-${role}`,
        tenantId: "archive-qualification-tenant",
        order: [
          "subs",
          "opens",
          "clicks",
          "bounces",
          "forecast",
          "anomalies",
          "goals",
          "benchmarks",
          "engagement",
          "parity",
          "inbox-health",
          "clv",
        ],
        updatedAt: "2026-07-26T09:45:00.000Z",
      });
      return;
    }

    if (pathname === "/api/v1/archive" && method === "GET") {
      archiveListRequests.push(request.url());
      if (listMode === "failure") {
        await json(
          route,
          {
            error: {
              code: "archive_unavailable",
              message: "The archive catalog is temporarily unavailable.",
            },
          },
          503,
        );
        return;
      }
      await json(route, {
        items: options.empty ? [] : POPULATED_ISSUES,
      });
      return;
    }

    if (pathname === "/api/v1/archive/stats" && method === "GET") {
      if (statsMode === "failure") {
        await json(
          route,
          {
            error: {
              code: "archive_stats_unavailable",
              message: "The archive performance rollup is delayed.",
            },
          },
          503,
        );
        return;
      }
      await json(route, {
        totalIssues: options.empty ? 0 : POPULATED_ISSUES.length,
        pinnedIssues: options.empty ? 0 : 1,
        views30d: options.empty ? 0 : 48_620,
        uniqueVisitors30d: options.empty ? 0 : 29_856,
        topIssueSlug: options.empty ? "" : POPULATED_ISSUES[0].slug,
        topIssueSubject: options.empty ? "" : POPULATED_ISSUES[0].subject,
        topIssueViews: options.empty ? 0 : POPULATED_ISSUES[0].viewCount,
        lastPublishedAt: options.empty ? "" : POPULATED_ISSUES[0].publishedAt,
      });
      return;
    }

    if (
      pathname === "/api/v1/admin/archive/tenant-settings" &&
      method === "GET"
    ) {
      await json(route, {
        tenant_archive_slug: "archive-qualification",
        archive_domain: "",
        archive_title: "Archive qualification",
        archive_tagline: "Durable notes for thoughtful readers.",
      });
      return;
    }

    if (pathname === "/api/v1/campaigns" && method === "GET") {
      await json(route, {
        items: POPULATED_ISSUES.map((issue) => ({
          id: issue.campaignId,
          name: issue.subject,
          subject: issue.subject,
          status: "sent",
          sent_at: issue.publishedAt,
        })),
      });
      return;
    }

    const previewMatch = pathname.match(
      /^\/api\/v1\/admin\/archive\/issues\/([^/]+)\/preview$/u,
    );
    if (previewMatch && method === "GET") {
      const slug = decodeURIComponent(previewMatch[1] ?? "");
      const preview = previewFor(slug);
      await json(route, preview, "error" in preview ? 404 : 200);
      return;
    }

    const isAdvancedSurface =
      pathname.startsWith("/api/v1/archive/comments") ||
      pathname.startsWith("/api/v1/podcast/");
    if (isAdvancedSurface) {
      advancedRequests.push(`${method} ${pathname}`);
      await json(
        route,
        {
          error: {
            code: "review_gated_fixture",
            message: "This review-gated endpoint must not be requested.",
          },
        },
        409,
      );
      return;
    }

    const isArchiveMutation =
      method !== "GET" &&
      (pathname.startsWith("/api/v1/admin/archive/") ||
        pathname.includes("/publish-archive") ||
        pathname.includes("/unpublish-archive") ||
        /\/api\/v1\/campaigns\/[^/]+\/archive\/(?:pin|unpin)$/u.test(pathname));
    if (isArchiveMutation) {
      mutationRequests.push(`${method} ${pathname}`);
      await json(
        route,
        {
          error: {
            code: "fixture_mutation_blocked",
            message: "Archive qualification never commits mutations.",
          },
        },
        409,
      );
      return;
    }

    await route.fallback();
  });

  return {
    advancedRequests,
    archiveListRequests,
    mutationRequests,
    setListMode: (mode) => {
      listMode = mode;
    },
    setStatsMode: (mode) => {
      statsMode = mode;
    },
  };
}

async function openArchive(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
  setTheme: (page: Page, theme: "system" | "dark" | "light") => Promise<void>,
  options: ArchiveHarnessOptions & {
    height?: number;
    theme?: "dark" | "light";
    width?: number;
  } = {},
): Promise<ArchiveHarness> {
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 1_000,
  });
  await setTheme(page, options.theme ?? "dark");
  await bootApp(page);
  const harness = await installArchiveHarness(page, options);
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  const destination = page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="archive"]');
  await destination.click();
  await expect(destination).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", {
      name: "Give every issue a useful life after send.",
      exact: true,
    }),
  ).toBeVisible();
  return harness;
}

async function seriousAxeViolations(
  page: Page,
  options: { disableColorContrast?: boolean } = {},
) {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async ({ disableColorContrast }) => {
    const axe = (
      window as typeof window & {
        axe: {
          run: (
            context: string,
            options: unknown,
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
    const result = await axe.run(".arc-page", {
      runOnly: {
        type: "tag",
        values: [
          "wcag2a",
          "wcag2aa",
          "wcag21a",
          "wcag21aa",
          "wcag22a",
          "wcag22aa",
        ],
      },
      ...(disableColorContrast
        ? { rules: { "color-contrast": { enabled: false } } }
        : {}),
    });
    return result.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    );
  }, options);
}

async function expectNoRootHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const archive = document.querySelector<HTMLElement>(".arc-page");
    return {
      archive: archive ? archive.scrollWidth - archive.clientWidth : 999,
      body: document.body.scrollWidth - window.innerWidth,
      document: document.documentElement.scrollWidth - window.innerWidth,
      horizontalScroll: window.scrollX,
    };
  });
  expect(overflow.archive).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.horizontalScroll).toBe(0);
}

async function capture(
  page: Page,
  testInfo: TestInfo,
  name: string,
  options: { resetScroll?: boolean } = {},
): Promise<void> {
  if (options.resetScroll !== false) {
    await page.evaluate(async () => {
      const content = document.querySelector<HTMLElement>(".content");
      if (!content) return;
      const previousBehavior = content.style.scrollBehavior;
      content.style.scrollBehavior = "auto";
      content.scrollTop = 0;
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      content.style.scrollBehavior = previousBehavior;
    });
  }
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
  });
}

async function expectReviewGatedPublicActions(page: Page): Promise<void> {
  await expect(
    page.getByText("Publication is review-gated", { exact: true }),
  ).toBeVisible();
  const publish = page.getByRole("button", {
    name: "Publish from campaign",
    exact: true,
  });
  await expect(publish).toHaveAttribute("aria-disabled", "true");

  for (const name of ["Copy URL", "Copy RSS", "Copy sitemap", "Open archive"]) {
    await expect(
      page.getByRole("button", { name, exact: true }),
    ).toHaveAttribute("aria-disabled", "true");
  }
}

for (const theme of ["dark", "light"] as const) {
  test(`populated issue catalog is accurate, contained, and accessible in ${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openArchive(page, bootApp, setTheme, { theme });
    const table = page.getByRole("table", {
      name: "Published archive issues",
    });

    await expect(table).toBeVisible();
    await expect(table.getByRole("row")).toHaveCount(5);
    await expect(
      table.getByRole("button", {
        name: POPULATED_ISSUES[0].subject,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      table.getByText("/field-notes-from-a-quiet-launch"),
    ).toBeVisible();
    await expect(table.getByText("18k", { exact: true })).toBeVisible();
    await expect(table.getByText("Pinned", { exact: true })).toBeVisible();
    await expect(
      table.getByText(POPULATED_ISSUES[3].subject, { exact: true }),
    ).toBeVisible();

    const stats = page.getByRole("group", { name: "Key statistics" });
    await expect(stats).toContainText("Issues published");
    await expect(stats.locator(".stat-strip-v2-value").nth(0)).toHaveText("4");
    await expect(stats.locator(".stat-strip-v2-value").nth(1)).toHaveText(
      "49k",
    );
    await expect(stats.locator(".stat-strip-v2-value").nth(2)).toHaveText(
      "18k",
    );

    await expectReviewGatedPublicActions(page);
    await page
      .getByRole("button", { name: "Publish from campaign", exact: true })
      .click({ force: true });
    await page
      .getByRole("button", { name: "Copy URL", exact: true })
      .click({ force: true });
    await page
      .getByRole("button", {
        name: `Open ${POPULATED_ISSUES[0].subject} in browser`,
      })
      .click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(harness.mutationRequests).toEqual([]);

    await expectNoRootHorizontalOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    await capture(page, testInfo, `archive-populated-${theme}`);
  });
}

test("terminal first-load failure is explicit and recovers without fabricating a catalog", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const harness = await openArchive(page, bootApp, setTheme, {
    listMode: "failure",
  });
  const alert = page.locator(".arc-error");

  await expect(alert).toContainText("Archive data could not be loaded.");
  await expect(alert).toContainText("Server error. Please try again.");
  await expect(
    page.getByRole("table", { name: "Published archive issues" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("0 published issues", { exact: true }),
  ).toHaveCount(0);

  const requestsBeforeRecovery = harness.archiveListRequests.length;
  harness.setListMode("ready");
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("table", { name: "Published archive issues" }),
  ).toBeVisible();
  await expect(alert).toHaveCount(0);
  await expect
    .poll(() => harness.archiveListRequests.length)
    .toBeGreaterThan(requestsBeforeRecovery);
  expect(await seriousAxeViolations(page)).toEqual([]);
});

test("partial metrics and a later failed refresh retain the last-good issue catalog", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const harness = await openArchive(page, bootApp, setTheme, {
    statsMode: "failure",
  });
  const table = page.getByRole("table", {
    name: "Published archive issues",
  });
  const alert = page.locator(".arc-error");

  await expect(table).toBeVisible();
  await expect(alert).toContainText("Some archive data is unavailable.");
  await expect(alert).toContainText(
    "Performance totals are temporarily unavailable",
  );
  await expect(
    page.getByRole("group", { name: "Key statistics" }),
  ).toContainText("—");

  const requestsBeforeRefresh = harness.archiveListRequests.length;
  harness.setStatsMode("ready");
  harness.setListMode("failure");
  await page
    .getByRole("button", { name: "Refresh catalog", exact: true })
    .click();
  await expect
    .poll(() => harness.archiveListRequests.length)
    .toBeGreaterThan(requestsBeforeRefresh);
  await expect(alert).toContainText("The issue catalog remains visible.");
  await expect(alert).toContainText("Server error. Please try again.");
  await expect(
    table.getByRole("button", {
      name: POPULATED_ISSUES[0].subject,
      exact: true,
    }),
  ).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
});

test("empty and search-no-match states explain the next reversible action", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await openArchive(page, bootApp, setTheme, {
    empty: true,
    theme: "light",
  });

  await expect(
    page.getByRole("heading", {
      name: "Your issue catalog is ready for its first publication.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Published archive issues" }),
  ).toHaveCount(0);
  await expectReviewGatedPublicActions(page);

  const search = page.getByRole("searchbox", { name: "Search issues" });
  await search.fill("missing-reader-story");
  await expect(
    page.getByRole("heading", {
      name: "No issues match “missing-reader-story”",
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toHaveValue("");
  await expect(
    page.getByRole("heading", {
      name: "Your issue catalog is ready for its first publication.",
    }),
  ).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);
  await capture(page, testInfo, "archive-empty-light");
});

test("viewer access is inspectable while every issue mutation fails closed", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const harness = await openArchive(page, bootApp, setTheme, {
    role: "viewer",
  });

  await expect(
    page.getByText("Review-only access", { exact: true }),
  ).toBeVisible();
  const pin = page.getByRole("button", {
    name: `Unpin ${POPULATED_ISSUES[0].subject}`,
  });
  await expect(pin).toHaveAttribute("aria-disabled", "true");
  await pin.click({ force: true });
  expect(harness.mutationRequests).toEqual([]);

  await page
    .getByRole("button", {
      name: `View details for ${POPULATED_ISSUES[0].subject}`,
    })
    .click();
  const dialog = page.getByRole("dialog", {
    name: POPULATED_ISSUES[0].subject,
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Public slug")).toBeDisabled();
  await expect(dialog.getByLabel("Excerpt")).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Save changes" }),
  ).toHaveAttribute("aria-disabled", "true");
  await expect(dialog.getByRole("button", { name: "Unpin" })).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(
    dialog.getByRole("button", { name: "Unpublish issue" }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Save changes" })
    .click({ force: true });
  expect(harness.mutationRequests).toEqual([]);
  expect(await seriousAxeViolations(page)).toEqual([]);
});

test("admin containment keeps only the confirmed unpublish safety removal actionable", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const harness = await openArchive(page, bootApp, setTheme, {
    role: "admin",
  });

  await expect(
    page.getByText("Review-only access", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Catalog changes review-gated", { exact: true }),
  ).toBeVisible();
  const pin = page.getByRole("button", {
    name: `Unpin ${POPULATED_ISSUES[0].subject}`,
  });
  await expect(pin).toHaveAttribute("aria-disabled", "true");
  await pin.click({ force: true });
  await expectReviewGatedPublicActions(page);

  for (const name of [
    "Publish from campaign",
    "Copy URL",
    "Copy RSS",
    "Copy sitemap",
    "Open archive",
  ]) {
    await page
      .getByRole("button", { name, exact: true })
      .click({ force: true });
  }
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(harness.mutationRequests).toEqual([]);

  await page
    .getByRole("button", {
      name: `View details for ${POPULATED_ISSUES[0].subject}`,
    })
    .click();
  const issueDialog = page.getByRole("dialog", {
    name: POPULATED_ISSUES[0].subject,
  });
  await expect(issueDialog.getByLabel("Public slug")).toBeDisabled();
  await expect(
    issueDialog.getByRole("button", { name: "Save changes" }),
  ).toHaveAttribute("aria-disabled", "true");
  await expect(
    issueDialog.getByRole("button", { name: "Unpin" }),
  ).toHaveAttribute("aria-disabled", "true");
  const unpublish = issueDialog.getByRole("button", {
    name: "Unpublish issue",
  });
  await expect(unpublish).not.toHaveAttribute("aria-disabled", "true");
  await unpublish.click();
  const confirmation = page.getByRole("alertdialog", {
    name: "Unpublish this issue?",
  });
  await expect(confirmation).toContainText(
    "The original campaign is preserved.",
  );
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toBeHidden();
  expect(harness.mutationRequests).toEqual([]);
});

test("workspace tabs follow manual-activation APG semantics and never mount gated child controls", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const harness = await openArchive(page, bootApp, setTheme);
  const tabs = page.getByRole("tablist", { name: "Archive workspaces" });
  const issues = tabs.getByRole("tab", { name: /^Issues/u });
  const comments = tabs.getByRole("tab", { name: /^Comments/u });
  const privateFeeds = tabs.getByRole("tab", { name: /^Private feeds/u });

  await expect(issues).toHaveAttribute("aria-selected", "true");
  await issues.focus();
  await issues.press("ArrowRight");
  await expect(comments).toBeFocused();
  await expect(comments).toHaveAttribute("aria-selected", "false");
  await expect(issues).toHaveAttribute("aria-selected", "true");

  await comments.press("Enter");
  await expect(comments).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", {
      name: "Comment moderation is held back.",
    }),
  ).toBeVisible();
  let activePanel = page.locator('[role="tabpanel"]:not([hidden])');
  await expect(
    activePanel.locator("button, input, select, textarea, a[href]"),
  ).toHaveCount(0);

  await comments.press("End");
  await expect(privateFeeds).toBeFocused();
  await expect(privateFeeds).toHaveAttribute("aria-selected", "false");
  await privateFeeds.press("Space");
  await expect(privateFeeds).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", {
      name: "Private feed access is held back.",
    }),
  ).toBeVisible();
  activePanel = page.locator('[role="tabpanel"]:not([hidden])');
  await expect(
    activePanel.locator("button, input, select, textarea, a[href]"),
  ).toHaveCount(0);

  await privateFeeds.press("Home");
  await expect(issues).toBeFocused();
  await issues.press("Enter");
  await expect(issues).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("table", { name: "Published archive issues" }),
  ).toBeVisible();
  expect(harness.advancedRequests).toEqual([]);
  expect(harness.mutationRequests).toEqual([]);
  expect(await seriousAxeViolations(page)).toEqual([]);
});

test("880 by 560 reduced-motion layout and 200-percent proxy reflow without root overflow", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openArchive(page, bootApp, setTheme, {
    height: 560,
    theme: "light",
    width: 880,
  });

  await expect(
    page.getByRole("table", { name: "Published archive issues" }),
  ).toBeVisible();
  const animationNames = await page
    .locator(
      ".arc-distribution-line i, .arc-refresh-indicator svg, .arc-skeleton",
    )
    .evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).animationName),
    );
  expect(animationNames.every((name) => name === "none")).toBe(true);
  await expectNoRootHorizontalOverflow(page);
  await capture(page, testInfo, "archive-880x560-reduced-motion");

  // Chromium has no stable installed-app zoom API. A 440×280 CSS-pixel
  // viewport models the layout pressure of an 880×560 window at 200%.
  await page.setViewportSize({ width: 440, height: 280 });
  const search = page.getByRole("searchbox", { name: "Search issues" });
  await search.scrollIntoViewIfNeeded();
  await expect(search).toBeVisible();
  await search.fill("systems");
  await expect(
    page.getByText("1 match for “systems”", { exact: true }),
  ).toBeVisible();
  const action = page.getByRole("button", {
    name: `View details for ${POPULATED_ISSUES[1].subject}`,
  });
  await action.scrollIntoViewIfNeeded();
  const actionBox = await action.boundingBox();
  expect(actionBox).not.toBeNull();
  expect(actionBox!.width).toBeGreaterThanOrEqual(40);
  expect(actionBox!.height).toBeGreaterThanOrEqual(40);
  await expectNoRootHorizontalOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await capture(page, testInfo, "archive-200-percent-proxy", {
    resetScroll: false,
  });
});

test("forced colors preserve selected, focused, and review-gated distinctions", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active" });
  await openArchive(page, bootApp, setTheme, { theme: "dark" });

  const tabs = page.getByRole("tablist", { name: "Archive workspaces" });
  const issues = tabs.getByRole("tab", { name: /^Issues/u });
  const comments = tabs.getByRole("tab", { name: /^Comments/u });
  await expect(issues).toHaveCSS("border-top-width", "2px");
  await issues.focus();
  await issues.press("ArrowRight");
  await expect(comments).toBeFocused();

  const colors = await page.evaluate(() => {
    const active = document.querySelector<HTMLElement>(
      '.arc-workspace-tabs [role="tab"].is-selected',
    );
    const focused = document.activeElement as HTMLElement | null;
    const gated = document.querySelector<HTMLElement>(
      '.arc-public-actions [aria-disabled="true"]',
    );
    if (!active || !focused || !gated) {
      throw new Error("Missing Archive forced-color evidence targets.");
    }
    const probe = document.createElement("span");
    probe.style.cssText =
      "color: GrayText; background: Highlight; border: 1px solid Highlight; forced-color-adjust: none";
    document.body.appendChild(probe);
    const expected = getComputedStyle(probe);
    const activeStyle = getComputedStyle(active);
    const focusedStyle = getComputedStyle(focused);
    const gatedStyle = getComputedStyle(gated);
    const result = {
      activeBorder: activeStyle.borderTopColor,
      focusedOutline: focusedStyle.outlineColor,
      gatedColor: gatedStyle.color,
      grayText: expected.color,
      highlight: expected.backgroundColor,
    };
    probe.remove();
    return result;
  });
  expect(colors.activeBorder).toBe(colors.highlight);
  expect(colors.focusedOutline).toBe(colors.highlight);
  expect(colors.gatedColor).toBe(colors.grayText);
  expect(
    await seriousAxeViolations(page, { disableColorContrast: true }),
  ).toEqual([]);
  await capture(page, testInfo, "archive-forced-colors");
});
