import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Page, Route } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const LEGACY_UNKNOWN_EMAIL = "legacy.unknown@example.test";
const CANONICAL_EMAIL = "canonical.search@example.test";
const ADDED_EMAIL = "reviewed.operator@example.test";
const IMPORTED_EMAIL = "reviewed.import@example.test";

const LEGACY_ROWS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    email: LEGACY_UNKNOWN_EMAIL,
    reason: "manual",
    created_at: "2026-07-18T07:30:00.000Z",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    email:
      "a-deliberately-long-complaint-address-for-responsive-evidence@example.test",
    reason: "complaint",
    created_at: "2026-07-17T09:00:00.000Z",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    email: "hard-bounce@example.test",
    reason: "hard_bounce",
    created_at: "2026-07-16T12:00:00.000Z",
  },
] as const;

const CANONICAL_ENTRY = {
  id: "44444444-4444-4444-8444-444444444444",
  email: CANONICAL_EMAIL,
  reason: "manual_unsubscribe",
  source: "import",
  created_at: "2026-07-18T06:00:00.000Z",
  expires_at: null,
} as const;

type ListMode = "good" | "failure";
type SearchMode = "good" | "failure";

interface Gate {
  promise: Promise<void>;
  release: () => void;
}

interface SuppressionsApiControl {
  addBodies: Array<Record<string, unknown>>;
  bulkDeleteBodies: Array<Record<string, unknown>>;
  bulkImportBodies: Array<Record<string, unknown>>;
  pauseAdd: () => () => void;
  pauseBulkImport: () => () => void;
  setListMode: (mode: ListMode) => void;
  setSearchMode: (mode: SearchMode) => void;
}

function gate(): Gate {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installSuppressionsApi(
  page: Page,
): Promise<SuppressionsApiControl> {
  let listMode: ListMode = "good";
  let searchMode: SearchMode = "good";
  let addGate: Gate | null = null;
  let bulkImportGate: Gate | null = null;
  let canonicalDeleted = false;
  let legacyRows: Array<Record<string, unknown>> = LEGACY_ROWS.map((row) => ({
    ...row,
  }));
  const addBodies: Array<Record<string, unknown>> = [];
  const bulkDeleteBodies: Array<Record<string, unknown>> = [];
  const bulkImportBodies: Array<Record<string, unknown>> = [];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const isSuppressionsDomain =
      pathname === "/api/v1/suppressions" ||
      pathname.startsWith("/api/v1/suppressions/") ||
      pathname === "/api/v1/deliverability/suppressions" ||
      pathname.startsWith("/api/v1/deliverability/suppressions/");
    if (!isSuppressionsDomain) {
      await route.fallback();
      return;
    }

    if (
      pathname === "/api/v1/suppressions/trend" &&
      request.method() === "GET"
    ) {
      const days = Number(url.searchParams.get("days") ?? 30);
      await json(route, {
        days,
        points: [
          {
            date: "2026-07-17",
            count: 2,
            by_reason: { complaint: 1, hard_bounce: 1 },
          },
          {
            date: "2026-07-18",
            count: 1,
            by_reason: { manual: 1 },
          },
        ],
      });
      return;
    }

    if (pathname === "/api/v1/suppressions" && request.method() === "GET") {
      if (listMode === "failure") {
        await json(
          route,
          {
            error: {
              code: "fixture_refresh_failed",
              message: "Fixture list refresh failed.",
            },
          },
          422,
        );
        return;
      }
      await json(route, {
        items: legacyRows,
        total: 12_840,
        page: 1,
        per_page: 200,
      });
      return;
    }

    if (pathname === "/api/v1/suppressions" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      addBodies.push(body);
      const pending = addGate;
      if (pending) await pending.promise;
      const created = {
        id: "55555555-5555-4555-8555-555555555555",
        email: String(body.email ?? ""),
        reason: String(body.reason ?? "manual"),
        created_at: "2026-07-18T08:00:00.000Z",
      };
      legacyRows = [created, ...legacyRows];
      await json(route, created, 201);
      return;
    }

    if (
      pathname === "/api/v1/suppressions/bulk-import" &&
      request.method() === "POST"
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      bulkImportBodies.push(body);
      const pending = bulkImportGate;
      if (pending) await pending.promise;
      await json(route, { imported: 1, skipped: 0, errors: [] });
      return;
    }

    if (
      pathname === "/api/v1/suppressions/bulk-delete" &&
      request.method() === "POST"
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      bulkDeleteBodies.push(body);
      canonicalDeleted = true;
      await json(route, { deleted_count: 1, blocked: [], errors: [] });
      return;
    }

    if (
      pathname.endsWith("/audit") &&
      pathname.startsWith("/api/v1/suppressions/") &&
      request.method() === "GET"
    ) {
      const encodedIdentity = pathname.slice(
        "/api/v1/suppressions/".length,
        -"/audit".length,
      );
      const email = decodeURIComponent(encodedIdentity);
      await json(route, {
        items: [
          {
            id: "audit-1",
            tenant_id: "test-tenant",
            email,
            action: "add",
            actor: "Visual admin",
            reason: "manual",
            source_table: "email_suppressions",
            created_at: "2026-07-18T07:30:00.000Z",
          },
        ],
        total: 1,
        page: 1,
        email,
      });
      return;
    }

    if (
      pathname === "/api/v1/deliverability/suppressions" &&
      request.method() === "GET"
    ) {
      if (searchMode === "failure") {
        await json(
          route,
          {
            error: {
              code: "fixture_search_failed",
              message: "Fixture canonical search failed.",
            },
          },
          422,
        );
        return;
      }
      const exact = url.searchParams.get("email")?.trim().toLowerCase();
      const prefix = url.searchParams.get("q")?.trim().toLowerCase();
      let items: Array<Record<string, unknown>> = [];
      if (exact === CANONICAL_EMAIL && !canonicalDeleted) {
        items = [{ ...CANONICAL_ENTRY }];
      } else if (exact === LEGACY_UNKNOWN_EMAIL) {
        // Compatibility detail: a promoted record exists but its dimensional
        // fields were not captured. The renderer must not broaden this to
        // "any / all".
        items = [
          {
            id: LEGACY_ROWS[0].id,
            email: LEGACY_UNKNOWN_EMAIL,
            reason: "manual_unsubscribe",
            source: "import",
            created_at: LEGACY_ROWS[0].created_at,
            expires_at: null,
          },
        ];
      } else if (prefix && CANONICAL_EMAIL.startsWith(prefix)) {
        items = canonicalDeleted ? [] : [{ ...CANONICAL_ENTRY }];
      }
      await json(route, {
        items,
        total: items.length,
        page: 1,
        size: Number(url.searchParams.get("size") ?? 200),
      });
      return;
    }

    if (
      pathname.startsWith("/api/v1/deliverability/suppressions/") &&
      request.method() === "DELETE"
    ) {
      canonicalDeleted = true;
      await json(route, { ok: true });
      return;
    }

    await json(
      route,
      { error: { code: "fixture_unhandled", message: pathname } },
      501,
    );
  });

  return {
    addBodies,
    bulkDeleteBodies,
    bulkImportBodies,
    pauseAdd: () => {
      addGate = gate();
      return () => addGate?.release();
    },
    pauseBulkImport: () => {
      bulkImportGate = gate();
      return () => bulkImportGate?.release();
    },
    setListMode: (mode) => {
      listMode = mode;
    },
    setSearchMode: (mode) => {
      searchMode = mode;
    },
  };
}

async function openSuppressions(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
): Promise<SuppressionsApiControl> {
  await bootApp(page);
  const control = await installSuppressionsApi(page);
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="suppressions"]')
    .click();
  await expect(
    page.getByRole("heading", { name: "Suppressions", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText(LEGACY_UNKNOWN_EMAIL, { exact: true }),
  ).toBeVisible();
  return control;
}

async function assertNoSeriousAxeViolations(
  page: Page,
  options: { disableColorContrast?: boolean } = {},
): Promise<void> {
  await page.addScriptTag({ content: AXE_SOURCE });
  const violations = await page.evaluate(async (disableColorContrast) => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            root: Document,
            options: {
              runOnly: { type: "tag"; values: string[] };
              rules?: Record<string, { enabled: boolean }>;
            },
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
      ...(disableColorContrast
        ? { rules: { "color-contrast": { enabled: false } } }
        : {}),
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
  }, options.disableColorContrast ?? false);
  expect(violations).toEqual([]);
}

for (const theme of ["dark", "light"] as const) {
  test(`Suppressions typical state is truthful and axe-clean in ${theme} theme`, async ({
    page,
    bootApp,
    setTheme,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await setTheme(page, theme);
    await openSuppressions(page, bootApp);

    await expect(
      page.getByText("12,840 addresses · first 3 loaded", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Breakdown below covers the first 3 loaded", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("table", { name: "Suppressed email addresses" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add suppression", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Bulk actions" }),
    ).toBeHidden();
    await assertNoSeriousAxeViolations(page);
  });
}

test("canonical exact search owns safe bulk selection, request payload, and removal truth", async ({
  page,
  bootApp,
}) => {
  const control = await openSuppressions(page, bootApp);
  await page
    .getByRole("searchbox", { name: "Search suppressed email addresses" })
    .fill(CANONICAL_EMAIL);

  await expect(
    page.getByText("Exact-match search across the whole suppression store."),
  ).toBeVisible();
  await expect(page.getByText(CANONICAL_EMAIL, { exact: true })).toBeVisible();
  await page
    .getByRole("checkbox", { name: `Select ${CANONICAL_EMAIL}` })
    .check();
  await expect(
    page.getByRole("region", { name: "Bulk actions" }),
  ).toContainText("1 selected");

  await page.getByRole("button", { name: "Remove selected" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Remove 1 suppression rule?",
  });
  await expect(dialog).toContainText("matching canonical rules only");
  await expect(dialog).toContainText("does not re-enable subscribers");
  await expect(dialog).toContainText("restore consent");
  await expect(dialog).toContainText("other evidence or provider state");
  await expect(dialog).not.toContainText(/receive email again immediately/i);

  await dialog.getByRole("button", { name: "Review and remove" }).click();
  await expect.poll(() => control.bulkDeleteBodies.length).toBe(1);
  expect(control.bulkDeleteBodies).toEqual([
    { emails: [CANONICAL_EMAIL], force: false },
  ]);
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("1 canonical suppression rule removed", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(CANONICAL_EMAIL, { exact: true })).toBeHidden();
});

test("detail preserves unknown channel and purpose instead of inventing a broad rule", async ({
  page,
  bootApp,
}) => {
  await openSuppressions(page, bootApp);
  await page
    .getByRole("button", { name: `View details for ${LEGACY_UNKNOWN_EMAIL}` })
    .click();

  const detail = page.getByRole("dialog", { name: LEGACY_UNKNOWN_EMAIL });
  await expect(detail).toBeVisible();
  await expect(
    detail.getByText("Channel · Purpose", { exact: true }),
  ).toBeVisible();
  await expect(
    detail.getByText("Unknown · Unknown", { exact: true }),
  ).toBeVisible();
  await expect(detail).toContainText("No broader scope is assumed");
  await expect(detail).not.toContainText("any · all");
  await expect(detail).toContainText("Visual admin");
  await assertNoSeriousAxeViolations(page);
});

test("single add traps focus, restores its invoker, and cannot dismiss while submitting", async ({
  page,
  bootApp,
}) => {
  const control = await openSuppressions(page, bootApp);
  const trigger = page.getByRole("button", {
    name: "Add suppression",
    exact: true,
  });
  await trigger.click();
  let dialog = page.getByRole("dialog", { name: "Add suppression" });
  const email = dialog.getByLabel("Email");
  await expect(email).toBeFocused();
  await email.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Suppress" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  const release = control.pauseAdd();
  await trigger.click();
  dialog = page.getByRole("dialog", { name: "Add suppression" });
  await dialog.getByLabel("Email").fill(ADDED_EMAIL);
  await dialog.getByLabel("Reason").selectOption("manual");
  await dialog.getByRole("button", { name: "Suppress" }).click();
  await expect.poll(() => control.addBodies.length).toBe(1);
  expect(control.addBodies).toEqual([{ email: ADDED_EMAIL, reason: "manual" }]);
  await expect(dialog.getByRole("button", { name: "Close" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "Adding the suppression. Keep this dialog open until it finishes.",
  );
  release();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText(`${ADDED_EMAIL} suppressed`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(ADDED_EMAIL, { exact: true })).toBeVisible();
});

test("bulk import owns keyboard and busy lifecycle and reports the exact submitted outcome", async ({
  page,
  bootApp,
}) => {
  const control = await openSuppressions(page, bootApp);
  const trigger = page.getByRole("button", {
    name: "Bulk import",
    exact: true,
  });
  const release = control.pauseBulkImport();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Bulk import suppressions" });
  await expect(dialog.getByRole("radio", { name: /Emails/ })).toBeFocused();
  const editor = dialog.getByLabel("Suppression data");
  await editor.fill(IMPORTED_EMAIL);
  await dialog
    .getByLabel("Reason", { exact: true })
    .selectOption("manual_unsubscribe");
  await dialog.getByRole("button", { name: "Import 1 address" }).click();

  await expect.poll(() => control.bulkImportBodies.length).toBe(1);
  expect(control.bulkImportBodies).toEqual([
    { emails: [IMPORTED_EMAIL], reason: "manual_unsubscribe" },
  ]);
  await expect(dialog.getByRole("button", { name: "Close" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Importing…" }),
  ).toBeDisabled();
  release();

  await expect(
    dialog.getByText("Import complete", { exact: true }),
  ).toBeVisible();
  await expect(dialog).toContainText("Every reason group completed");
  await expect(dialog).toContainText("Imported");
  await expect(dialog).toContainText("1");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("failed refresh and failed canonical search retain last-good rows with explicit sample truth", async ({
  page,
  bootApp,
}) => {
  const control = await openSuppressions(page, bootApp);
  const retained = page.getByText(LEGACY_UNKNOWN_EMAIL, { exact: true });

  control.setListMode("failure");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const routeAlert = page
    .getByRole("main", { name: "Suppressions content" })
    .getByRole("alert");
  await expect(routeAlert).toContainText("Refresh failed");
  await expect(routeAlert).toContainText(
    "The last loaded rows remain visible.",
  );
  await expect(retained).toBeVisible();

  control.setSearchMode("failure");
  await page
    .getByRole("searchbox", { name: "Search suppressed email addresses" })
    .fill(CANONICAL_EMAIL);
  await expect(page.getByText(/Server search failed:/)).toBeVisible();
  await expect(page.getByText(/first 3 loaded rows instead/)).toBeVisible();
  await expect(
    page.getByText(/Only the first 3 loaded rows were searched/),
  ).toBeVisible();
});

test("440 by 280 zoom proxy contains the root and keeps core controls operable", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.setViewportSize({ width: 440, height: 280 });
  await setTheme(page, "light");
  await openSuppressions(page, bootApp);

  const search = page.getByRole("searchbox", {
    name: "Search suppressed email addresses",
  });
  await search.scrollIntoViewIfNeeded();
  await expect(search).toBeVisible();
  await search.fill("ha");
  await expect(page.getByText(/searching first 3 loaded/i)).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => ({
        viewport: window.innerWidth,
        root: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
        horizontalScroll: window.scrollX,
      })),
    )
    .toEqual({ viewport: 440, root: 440, body: 440, horizontalScroll: 0 });

  const trigger = page.getByRole("button", {
    name: "Add suppression",
    exact: true,
  });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Add suppression" });
  await expect(dialog).toBeVisible();
  const rect = await dialog.boundingBox();
  expect(rect).not.toBeNull();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(440);
  expect(rect!.y).toBeGreaterThanOrEqual(0);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(280);
});

test("forced colours and reduced motion preserve status, focus, and semantics", async ({
  page,
  bootApp,
}) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await openSuppressions(page, bootApp);
  await expect(
    page
      .getByRole("table", { name: "Suppressed email addresses" })
      .getByText("Complaint", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "All" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const search = page.getByRole("searchbox", {
    name: "Search suppressed email addresses",
  });
  await search.focus();
  const mediaAndFocus = await search.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      forced: window.matchMedia("(forced-colors: active)").matches,
      reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      outlineWidth: style.outlineWidth,
      transitionMs: Number.parseFloat(style.transitionDuration) * 1_000,
    };
  });
  expect(mediaAndFocus.forced).toBe(true);
  expect(mediaAndFocus.reduced).toBe(true);
  expect(mediaAndFocus.outlineWidth).toBe("2px");
  expect(mediaAndFocus.transitionMs).toBeLessThanOrEqual(10);
  await assertNoSeriousAxeViolations(page, { disableColorContrast: true });
});
