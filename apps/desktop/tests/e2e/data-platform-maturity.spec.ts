import type { Locator, Page } from "@playwright/test";

import {
  DATA_PLATFORM_PATHS,
  DATA_PLATFORM_SECRET_CANARY,
  attachDataPlatformJson,
  captureDataPlatformEvidence,
  expectDataPlatformReducedMotion,
  expectNoDataPlatformOverflow,
  openDataPlatform,
  PRIMARY_CONNECTION_ID,
  dataPlatformAxeViolations,
  type DataPlatformHarness,
} from "./data-platform-evidence-harness";
import { expect, test } from "../visual/fixture";

test.describe.configure({ timeout: 180_000 });

function routeTab(page: Page, label: string): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const tablist = page
    .getByRole("tablist", { name: "Data platform sections" })
    .getByRole("tab");
  return tablist.filter({
    has: page
      .locator("strong")
      .filter({ hasText: new RegExp(`^${escaped}$`, "u") }),
  });
}

async function activateTab(page: Page, label: string): Promise<Locator> {
  const tab = routeTab(page, label);
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  const activePanel = page.locator('[role="tabpanel"]:not([hidden])');
  await expect(activePanel).toHaveCount(1);
  await activePanel.evaluate(async (panel) => {
    await Promise.all(
      panel
        .getAnimations()
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  return tab;
}

function expectHarnessClean(
  harness: DataPlatformHarness,
  options: { allowExpectedFailures?: boolean } = {},
): void {
  expect(harness.unexpectedRequests).toEqual([]);
  expect(harness.blockedExternalRequests).toEqual([]);
  expect(harness.adminRequestsFromViewer).toEqual([]);
  expect(harness.runtimeErrors).toEqual([]);
  if (!options.allowExpectedFailures) {
    expect(harness.expectedHttpFailures).toEqual([]);
  }
}

async function attachHarness(
  testInfo: Parameters<typeof attachDataPlatformJson>[0],
  harness: DataPlatformHarness,
): Promise<void> {
  await attachDataPlatformJson(testInfo, "data-platform-request-ledger", {
    adminRequestsFromViewer: harness.adminRequestsFromViewer,
    blockedExternalRequests: harness.blockedExternalRequests,
    expectedHttpFailures: harness.expectedHttpFailures,
    requests: harness.requests,
    runtimeErrors: harness.runtimeErrors,
    unexpectedRequests: harness.unexpectedRequests,
  });
}

test("admin can traverse every manual tab, preview safely, and retain tab drafts", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openDataPlatform(page, bootApp, setTheme, {
    role: "admin",
    theme: "dark",
  });

  const tabs = page
    .getByRole("tablist", { name: "Data platform sections" })
    .getByRole("tab");
  await expect(tabs).toHaveCount(4);
  await expect(routeTab(page, "Warehouse")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByLabel("Warehouse readiness")).toBeVisible();
  await expect(page.getByLabel("Snowflake: available")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Warehouse connections" }),
  ).toContainText("Customer 360 warehouse");
  await expect(
    page.getByRole("region", { name: "Warehouse sync runs" }),
  ).toContainText("whr-34000000-completed");
  await expect(page.locator("body")).not.toContainText(
    DATA_PLATFORM_SECRET_CANARY,
  );
  await captureDataPlatformEvidence(
    page,
    testInfo,
    "data-platform-admin-warehouse-populated",
  );

  const manageConnection = page.getByRole("button", {
    name: "Manage Customer 360 warehouse",
    exact: true,
  });
  await manageConnection.click();
  const connectionDialog = page.getByRole("dialog", {
    name: "Manage — Customer 360 warehouse",
  });
  await expect(connectionDialog).toBeVisible();
  await expect(
    connectionDialog.getByRole("button", {
      name: "Refresh evidence",
      exact: true,
    }),
  ).toBeFocused();
  await expect(
    connectionDialog.getByText("Saved status", { exact: true }).locator(".."),
  ).toContainText("Active");
  await expect(
    connectionDialog
      .getByText("Connection health", { exact: true })
      .locator(".."),
  ).toContainText("Healthy");
  await expect(
    connectionDialog.getByText("Latest run", { exact: true }).locator(".."),
  ).toContainText("Completed");
  await expect(
    connectionDialog
      .getByText("Provider runtime", { exact: true })
      .locator(".."),
  ).toContainText("Available");
  await expect(
    connectionDialog
      .getByText("Worker attachment", { exact: true })
      .locator(".."),
  ).toContainText("Attached");
  const providerVerification = connectionDialog.getByRole("region", {
    name: "Provider Checked",
  });
  await expect(providerVerification).toContainText("Live state: Healthy");
  await expect(providerVerification).toContainText("Execution mode: Inline");
  await expect(providerVerification).toContainText(
    "1 bounded verification statement executed.",
  );
  const recentRuns = connectionDialog.getByRole("list", {
    name: "Five most recent warehouse runs",
  });
  await expect(recentRuns).toContainText("Completed");
  await expect(recentRuns).toContainText("Export · Scheduled");
  await expect(recentRuns).toContainText("4,818 moved · 4 failed");
  await expect(connectionDialog).not.toContainText(DATA_PLATFORM_SECRET_CANARY);

  const verifyProvider = providerVerification.getByRole("button", {
    name: "Verify provider",
    exact: true,
  });
  await expect(verifyProvider).toHaveAttribute("aria-describedby", /\S+/u);
  await verifyProvider.click();
  const providerHealthPath = `/api/v1/warehouse/connections/${PRIMARY_CONNECTION_ID}/health`;
  await expect
    .poll(() =>
      harness.requests.filter(
        ({ method, pathname, search }) =>
          method === "GET" &&
          pathname === providerHealthPath &&
          search === "?provider_check=true",
      ),
    )
    .toEqual([
      {
        body: null,
        method: "GET",
        pathname: providerHealthPath,
        search: "?provider_check=true",
      },
    ]);
  await expect(verifyProvider).toHaveText("Verify provider");
  await expect(connectionDialog).not.toContainText(DATA_PLATFORM_SECRET_CANARY);
  expect(await dataPlatformAxeViolations(page, ".modal-card")).toEqual([]);
  await connectionDialog.locator(".modal-close").click();
  await expect(connectionDialog).toBeHidden();
  await expect(manageConnection).toBeFocused();

  // Manual APG tabs: ArrowRight moves focus only; Enter activates.
  const warehouse = routeTab(page, "Warehouse");
  const reverse = routeTab(page, "Reverse ETL");
  await warehouse.focus();
  await page.keyboard.press("ArrowRight");
  await expect(reverse).toBeFocused();
  await expect(warehouse).toHaveAttribute("aria-selected", "true");
  await expect(reverse).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Enter");
  await expect(reverse).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByText("Driver required", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("plan_tier", { exact: false })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sync unavailable", exact: true }),
  ).toHaveAttribute("aria-disabled", "true");

  await activateTab(page, "Custom objects");
  await expect(page.getByText("Orders", { exact: true })).toBeVisible();
  await expect(page.getByText("Wishlists", { exact: true })).toBeVisible();

  await activateTab(page, "CDP transforms");
  await expect(page.getByLabel("Registered operations")).toContainText(
    "lowercase",
  );
  const propertiesEditor = page.getByLabel("Input properties (JSON)");
  const retainedDraft = '{\n  "email": "  RETAIN.ME@EXAMPLE.COM "\n}';
  await propertiesEditor.fill(retainedDraft);
  await page.getByRole("button", { name: "Run preview", exact: true }).click();
  await expect(page.getByText("Preview passed", { exact: true })).toBeVisible();
  await expect(page.getByText("2 ops succeeded · 0 failed")).toBeVisible();

  await activateTab(page, "Custom objects");
  await activateTab(page, "CDP transforms");
  await expect(propertiesEditor).toHaveValue(retainedDraft);
  await expect(page.getByText("Preview passed", { exact: true })).toBeVisible();
  await expectNoDataPlatformOverflow(page);
  expect(await dataPlatformAxeViolations(page)).toEqual([]);
  await captureDataPlatformEvidence(
    page,
    testInfo,
    "data-platform-admin-transform-evidence",
  );

  expect(
    harness.requests.some(
      ({ method, pathname }) =>
        method === "POST" && pathname === DATA_PLATFORM_PATHS.transformPreview,
    ),
  ).toBe(true);
  expectHarnessClean(harness);
  await attachHarness(testInfo, harness);
});

test("warehouse distinguishes loading, verified empty, unavailable, and recovered states", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openDataPlatform(page, bootApp, setTheme, {
    role: "admin",
    theme: "light",
    initialModes: {
      [DATA_PLATFORM_PATHS.catalog]: "deferred",
      [DATA_PLATFORM_PATHS.connections]: "deferred",
      [DATA_PLATFORM_PATHS.runs]: "deferred",
    },
    payloads: {
      [DATA_PLATFORM_PATHS.connections]: { items: [] },
      [DATA_PLATFORM_PATHS.runs]: { items: [] },
    },
  });

  await expect(
    page.getByText("Loading catalog…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Loading connections…", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Verifying warehouse runs…", { exact: true }),
  ).toBeVisible();

  harness.releaseEndpoint(DATA_PLATFORM_PATHS.catalog);
  harness.releaseEndpoint(DATA_PLATFORM_PATHS.connections);
  harness.releaseEndpoint(DATA_PLATFORM_PATHS.runs);
  await expect(
    page.getByRole("heading", {
      name: "Warehouse manifests without guesswork.",
    }),
  ).toBeVisible();
  await expect(
    page.getByText("No runs were returned", { exact: false }),
  ).toBeVisible();
  expect(await dataPlatformAxeViolations(page)).toEqual([]);

  harness.setEndpointMode(DATA_PLATFORM_PATHS.catalog, "error");
  harness.setEndpointMode(DATA_PLATFORM_PATHS.connections, "error");
  harness.setEndpointMode(DATA_PLATFORM_PATHS.runs, "error");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Data platform", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText("warehouse catalog could not be verified", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Warehouse connections could not be verified", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Couldn’t verify warehouse runs", { exact: false }),
  ).toBeVisible();
  expect(await dataPlatformAxeViolations(page)).toEqual([]);
  await captureDataPlatformEvidence(
    page,
    testInfo,
    "data-platform-warehouse-unavailable",
  );

  harness.setEndpointMode(DATA_PLATFORM_PATHS.catalog, "success");
  harness.setEndpointMode(DATA_PLATFORM_PATHS.connections, "success");
  harness.setEndpointMode(DATA_PLATFORM_PATHS.runs, "success");
  await page
    .getByRole("button", { name: "Retry warehouse overview", exact: true })
    .click();
  await expect(
    page.getByText("warehouse catalog could not be verified", {
      exact: false,
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    page.getByText("Couldn’t verify warehouse runs", { exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", {
      name: "Warehouse manifests without guesswork.",
    }),
  ).toBeVisible();
  await expectNoDataPlatformOverflow(page);
  expectHarnessClean(harness, { allowExpectedFailures: true });
  await attachHarness(testInfo, harness);
});

test("viewer boundaries prevent warehouse, reverse ETL, and transform preview requests", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openDataPlatform(page, bootApp, setTheme, {
    role: "viewer",
    theme: "dark",
  });

  await expect(
    page.getByText("View-only access", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Warehouse requires administrator access",
    }),
  ).toBeVisible();
  expect(harness.requests).toEqual([]);

  await activateTab(page, "Reverse ETL");
  await expect(
    page.getByRole("heading", {
      name: "Reverse ETL requires administrator access",
    }),
  ).toBeVisible();
  expect(harness.requests).toEqual([]);

  await activateTab(page, "Custom objects");
  await expect(page.getByText("Orders", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "+ New type" })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Records", exact: true })
    .first()
    .click();
  await expect(page.getByLabel("Orders records")).toContainText("order-1001");
  await expect(page.getByRole("button", { name: "+ New record" })).toHaveCount(
    0,
  );

  await activateTab(page, "CDP transforms");
  await expect(
    page.getByText("Preview execution requires administrator access", {
      exact: true,
    }),
  ).toBeVisible();
  const preview = page.getByRole("button", {
    name: "Preview requires admin",
    exact: true,
  });
  await expect(preview).toHaveAttribute("aria-disabled", "true");
  // Dispatch a synthetic click to prove the handler itself is fail-closed;
  // Playwright correctly refuses a user click on aria-disabled controls.
  await preview.dispatchEvent("click");
  expect(
    harness.requests.filter(
      ({ pathname }) => pathname === DATA_PLATFORM_PATHS.transformPreview,
    ),
  ).toEqual([]);
  expect(
    harness.requests.filter(({ pathname }) =>
      pathname.startsWith("/api/v1/warehouse"),
    ),
  ).toEqual([]);
  expect(await dataPlatformAxeViolations(page)).toEqual([]);
  await expectNoDataPlatformOverflow(page);
  await captureDataPlatformEvidence(
    page,
    testInfo,
    "data-platform-viewer-permission-boundary",
  );
  expectHarnessClean(harness);
  await attachHarness(testInfo, harness);
});

test("390px reduced-motion layout keeps all four tabs accessible and axe-clean", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const harness = await openDataPlatform(page, bootApp, setTheme, {
    role: "admin",
    theme: "light",
    width: 390,
    height: 844,
  });

  for (const label of [
    "Warehouse",
    "Reverse ETL",
    "Custom objects",
    "CDP transforms",
  ]) {
    await activateTab(page, label);
    await expectNoDataPlatformOverflow(page);
    expect(await dataPlatformAxeViolations(page)).toEqual([]);
  }
  await expectDataPlatformReducedMotion(page);
  await captureDataPlatformEvidence(
    page,
    testInfo,
    "data-platform-narrow-reduced-motion",
  );
  expectHarnessClean(harness);
  await attachHarness(testInfo, harness);
});

test("record inspector traps focus, closes with Escape, and restores its trigger", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openDataPlatform(page, bootApp, setTheme, {
    role: "admin",
    theme: "light",
  });
  await activateTab(page, "Custom objects");
  await page
    .getByRole("button", { name: "Records", exact: true })
    .first()
    .click();
  const inspect = page.getByRole("button", {
    name: "Inspect record order-1001",
    exact: true,
  });
  await inspect.focus();
  await expect(inspect).toBeFocused();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", { name: "Record order-1001" });
  await expect(dialog).toBeVisible();
  const footerClose = dialog
    .locator(".modal-footer")
    .getByRole("button", { name: "Close", exact: true });
  await expect(footerClose).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.locator(".modal-close")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(footerClose).toBeFocused();
  expect(await dataPlatformAxeViolations(page, ".modal-card")).toEqual([]);
  await captureDataPlatformEvidence(
    page,
    testInfo,
    "data-platform-record-inspector-modal",
  );

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(inspect).toBeFocused();
  expectHarnessClean(harness);
  await attachHarness(testInfo, harness);
});

test("history and routed tab changes tear down record overlays without isolation leaks", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openDataPlatform(page, bootApp, setTheme, {
    role: "admin",
    theme: "light",
  });
  const warehouse = routeTab(page, "Warehouse");
  const reverse = routeTab(page, "Reverse ETL");
  const objects = routeTab(page, "Custom objects");
  const objectsPanel = page.locator('[data-data-platform-panel="objects"]');

  await activateTab(page, "Custom objects");
  await page
    .getByRole("button", { name: "Records", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", {
      name: "Inspect record order-1001",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", { name: "Record order-1001" });
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("hidden");

  await page.goBack();
  await expect(warehouse).toHaveAttribute("aria-selected", "true");
  await expect(dialog).toHaveCount(0);
  await expect(objectsPanel.locator(":scope > *")).toHaveCount(0);
  await expect(warehouse).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const route = document.querySelector<HTMLElement>(".dp-page");
        const tablist = document.querySelector<HTMLElement>(
          '[role="tablist"][aria-label="Data platform sections"]',
        );
        const selectedTab = tablist?.querySelector<HTMLElement>(
          '[role="tab"][aria-selected="true"]',
        );
        const isolationSelector = '[inert], [aria-hidden="true"]';
        return {
          bodyOverflow: document.body.style.overflow,
          overlayCount:
            route?.querySelectorAll(
              '.modal-backdrop, .slideover-backdrop, [aria-modal="true"]',
            ).length ?? -1,
          routeIsolated:
            route?.inert === true ||
            route?.getAttribute("aria-hidden") === "true",
          selectedTabIsolated: Boolean(selectedTab?.closest(isolationSelector)),
          tablistIsolated: Boolean(tablist?.closest(isolationSelector)),
        };
      }),
    )
    .toEqual({
      bodyOverflow: "",
      overlayCount: 0,
      routeIsolated: false,
      selectedTabIsolated: false,
      tablistIsolated: false,
    });

  // History restoration leaves the APG tabset immediately operable.
  await page.keyboard.press("ArrowRight");
  await expect(reverse).toBeFocused();
  await expect(warehouse).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(reverse).toHaveAttribute("aria-selected", "true");

  // Re-mounting the evicted Objects panel starts clean; the read-only
  // inspector cannot resurrect from its previous local state.
  await objects.click();
  await expect(objects).toHaveAttribute("aria-selected", "true");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Records", exact: true }).first(),
  ).toBeVisible();

  // Exercise the tab's routed click handler as well. A real pointer is
  // intentionally blocked by modal inertness; dispatching the handler mirrors
  // an app-level navigation command without weakening the dialog boundary.
  await page
    .getByRole("button", { name: "Records", exact: true })
    .first()
    .click();
  await page
    .getByRole("button", {
      name: "Inspect record order-1001",
      exact: true,
    })
    .click();
  await expect(dialog).toBeVisible();
  await page
    .locator(".dp-route-tab")
    .filter({ has: page.locator("strong", { hasText: /^Warehouse$/u }) })
    .dispatchEvent("click");
  await expect(warehouse).toHaveAttribute("aria-selected", "true");
  await expect(dialog).toHaveCount(0);
  await expect(objectsPanel.locator(":scope > *")).toHaveCount(0);
  await expect(warehouse).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => document.body.style.overflow))
    .toBe("");
  expect(await dataPlatformAxeViolations(page)).toEqual([]);
  expectHarnessClean(harness);
  await attachHarness(testInfo, harness);
});

test("forced colors preserve selected and keyboard-focus evidence", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  const harness = await openDataPlatform(page, bootApp, setTheme, {
    role: "admin",
    theme: "dark",
    width: 700,
    height: 900,
  });
  const warehouse = routeTab(page, "Warehouse");
  const reverse = routeTab(page, "Reverse ETL");
  await warehouse.focus();
  await page.keyboard.press("ArrowRight");
  await expect(reverse).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(reverse).toHaveAttribute("aria-selected", "true");

  const evidence = await reverse.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      focusVisible: element.matches(":focus-visible"),
      forcedColors: matchMedia("(forced-colors: active)").matches,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(evidence.forcedColors).toBe(true);
  expect(evidence.focusVisible).toBe(true);
  expect(evidence.outlineStyle).toBe("solid");
  expect(evidence.outlineWidth).toBeGreaterThanOrEqual(2);
  await expectNoDataPlatformOverflow(page);
  // Axe evaluates retained author colors against the forced Canvas rather than
  // Chromium's system-color substitution. Skip only that known emulation
  // mismatch; every other WCAG A/AA rule remains enabled.
  expect(
    await dataPlatformAxeViolations(page, ".dp-page", {
      disableColorContrast: true,
    }),
  ).toEqual([]);
  await captureDataPlatformEvidence(
    page,
    testInfo,
    "data-platform-forced-colors-reduced-motion",
  );
  expectHarnessClean(harness);
  await attachHarness(testInfo, harness);
});
