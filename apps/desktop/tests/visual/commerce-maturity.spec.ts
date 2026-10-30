import type { Locator, Page } from "@playwright/test";

import {
  attachJson,
  COMMERCE_HERO_TITLE,
  countCommerceRequests,
  expectCursorListContract,
  expectNoHorizontalOverflow,
  FEED_SECRET_PATH,
  FEED_SECRET_TOKEN,
  openCommerce,
  PRIMARY_CATALOG_ID,
  PRIMARY_CATALOG_NAME,
  PRIMARY_FEED_NAME,
  PRIMARY_INTEGRATION_ID,
  PRIMARY_PRODUCT_TITLE,
  PRIMARY_STORE,
  RECOVERY_EMAIL,
  RECOVERY_SECRET_PATH,
  RECOVERY_SECRET_TOKEN,
  saveEvidence,
  seriousAxeViolations,
  observeRenderer,
  waitForCommerceRequest,
  type CommerceHarness,
} from "./commerce-evidence-harness";
import { expect, test } from "./fixture";

function commerceTab(page: Page, name: RegExp): Locator {
  return page
    .getByRole("tablist", { name: "Commerce sections" })
    .getByRole("tab", { name });
}

function recoveryTab(page: Page, name: RegExp): Locator {
  return page
    .getByRole("tablist", { name: "Recovery datasets" })
    .getByRole("tab", { name });
}

function commerceText(page: Page): Locator {
  return page.locator(".commerce-page");
}

async function openCatalogs(page: Page): Promise<void> {
  await commerceTab(page, /Catalogs & feeds/u).click();
  await expect(
    page.getByRole("heading", {
      name: "Catalogs & product feeds",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Product catalogs" }),
  ).toBeVisible();
}

async function openRecovery(page: Page): Promise<void> {
  await commerceTab(page, /^.*Recovery.*$/u).click();
  await expect(
    page.getByRole("heading", { name: "Cart-recovery links", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Cart-recovery links" }),
  ).toBeVisible();
}

async function openLifecycle(page: Page): Promise<void> {
  await commerceTab(page, /Lifecycle health/u).click();
  await expect(
    page.getByRole("heading", { name: "Lifecycle health", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", {
      name: `Lifecycle subscription status for ${PRIMARY_STORE}`,
    }),
  ).toBeVisible();
}

function recoveryRequestCount(
  harness: CommerceHarness,
  dataset:
    | "cart-recovery-links"
    | "back-in-stock-subscriptions"
    | "price-drop-watchers",
): number {
  return countCommerceRequests(
    harness,
    `/api/v1/commerce/integrations/${PRIMARY_INTEGRATION_ID}/${dataset}`,
    "GET",
  );
}

for (const theme of ["dark", "light"] as const) {
  test(`populated Commerce workspace is truthful, responsive, and axe-clean in ${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const renderer = observeRenderer(page);
    const harness = await openCommerce(page, bootApp, setTheme, { theme });

    await expect(
      page.getByRole("heading", {
        name: COMMERCE_HERO_TITLE,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "Review needed" }),
    ).toBeVisible();
    const facts = page.getByLabel("Commerce connection snapshot");
    await expect(
      facts.locator("span").filter({ hasText: /^Connections/u }),
    ).toContainText("2");
    await expect(
      facts.locator("span").filter({ hasText: /^Healthy/u }),
    ).toContainText("1");
    await expect(
      facts.locator("span").filter({ hasText: /^Needs review/u }),
    ).toContainText("1");
    await expect(facts).toContainText("Last recorded sync");
    await expect(
      page.getByText(
        "Store states only; each dataset owns its refresh. Provider capability is partial and certification-pending.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("table", { name: "Store integrations" }),
    ).toHaveAttribute("aria-rowcount", "3");
    await expectNoHorizontalOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    expect(harness.unexpected).toEqual([]);
    renderer.expectClean();

    await saveEvidence(page, testInfo, `commerce-populated-${theme}`);
    await attachJson(testInfo, `commerce-populated-requests-${theme}`, {
      requests: harness.requests,
      unexpected: harness.unexpected,
    });
  });
}

test("route tabs implement manual APG keyboard activation without preloading hidden workspaces", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openCommerce(page, bootApp, setTheme);
  const stores = commerceTab(page, /Stores/u);
  const catalogs = commerceTab(page, /Catalogs & feeds/u);
  const recovery = commerceTab(page, /^.*Recovery.*$/u);
  const lifecycle = commerceTab(page, /Lifecycle health/u);

  await stores.focus();
  await stores.press("ArrowRight");
  await expect(catalogs).toBeFocused();
  await expect(stores).toHaveAttribute("aria-selected", "true");
  await expect(catalogs).toHaveAttribute("aria-selected", "false");
  expect(
    countCommerceRequests(harness, "/api/v1/commerce/catalogs", "GET"),
  ).toBe(0);

  await catalogs.press("Enter");
  await expect(catalogs).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", {
      name: "Catalogs & product feeds",
      exact: true,
    }),
  ).toBeVisible();
  await waitForCommerceRequest(
    harness,
    ({ method, pathname }) =>
      method === "GET" && pathname === "/api/v1/commerce/catalogs",
  );

  await catalogs.press("ArrowRight");
  await expect(recovery).toBeFocused();
  await expect(catalogs).toHaveAttribute("aria-selected", "true");
  expect(recoveryRequestCount(harness, "cart-recovery-links")).toBe(0);
  await recovery.press("Space");
  await expect(recovery).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "Cart-recovery links", exact: true }),
  ).toBeVisible();

  await recovery.press("End");
  await expect(lifecycle).toBeFocused();
  await expect(recovery).toHaveAttribute("aria-selected", "true");
  await lifecycle.press("Enter");
  await expect(lifecycle).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "Lifecycle health", exact: true }),
  ).toBeVisible();

  await lifecycle.press("Home");
  await expect(stores).toBeFocused();
  await expect(lifecycle).toHaveAttribute("aria-selected", "true");
  await stores.press("Space");
  await expect(stores).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "Connected stores", exact: true }),
  ).toBeVisible();

  await expectNoHorizontalOverflow(page);
  expectCursorListContract(harness);
  expect(await seriousAxeViolations(page)).toEqual([]);
  renderer.expectClean();
  await attachJson(testInfo, "commerce-route-tab-contract", {
    requests: harness.requests,
  });
});

test("Recovery keeps secret URLs and email identities out of the DOM and fetches only the manually activated dataset", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openCommerce(page, bootApp, setTheme);
  await openRecovery(page);

  await expect
    .poll(() => recoveryRequestCount(harness, "cart-recovery-links"))
    .toBeGreaterThanOrEqual(1);
  expect(recoveryRequestCount(harness, "back-in-stock-subscriptions")).toBe(0);
  expect(recoveryRequestCount(harness, "price-drop-watchers")).toBe(0);

  const routeText = await commerceText(page).innerText();
  expect(routeText).toContain("https://checkout.northstar.example");
  expect(routeText).toContain("Secure path and token hidden");
  expect(routeText).toContain("r•••@customer.example");
  expect(routeText).not.toContain(RECOVERY_SECRET_PATH);
  expect(routeText).not.toContain(RECOVERY_SECRET_TOKEN);
  expect(routeText).not.toContain(RECOVERY_EMAIL);
  await expect(
    commerceText(page).locator(
      `a[href*="${RECOVERY_SECRET_TOKEN}"], [data-token="${RECOVERY_SECRET_TOKEN}"]`,
    ),
  ).toHaveCount(0);
  await page
    .getByRole("heading", { name: "Cart-recovery links", exact: true })
    .scrollIntoViewIfNeeded();
  await saveEvidence(page, testInfo, "commerce-recovery-secret-masking", {
    resetScroll: false,
  });

  const carts = recoveryTab(page, /Abandoned carts/u);
  const stock = recoveryTab(page, /Back in stock/u);
  const price = recoveryTab(page, /Price drops/u);
  await carts.focus();
  await carts.press("ArrowRight");
  await expect(stock).toBeFocused();
  await expect(carts).toHaveAttribute("aria-selected", "true");
  expect(recoveryRequestCount(harness, "back-in-stock-subscriptions")).toBe(0);

  await stock.press("Enter");
  await expect(stock).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", {
      name: "Back-in-stock subscriptions",
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() => recoveryRequestCount(harness, "back-in-stock-subscriptions"))
    .toBeGreaterThanOrEqual(1);
  expect(recoveryRequestCount(harness, "price-drop-watchers")).toBe(0);

  await stock.press("ArrowRight");
  await expect(price).toBeFocused();
  await expect(stock).toHaveAttribute("aria-selected", "true");
  expect(recoveryRequestCount(harness, "price-drop-watchers")).toBe(0);
  await price.press("Enter");
  await expect(price).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", {
      name: "Price-drop watchers",
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() => recoveryRequestCount(harness, "price-drop-watchers"))
    .toBeGreaterThanOrEqual(1);

  expectCursorListContract(harness);
  await expectNoHorizontalOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  renderer.expectClean();
  await attachJson(testInfo, "commerce-recovery-fetch-isolation", {
    requests: harness.requests.filter(({ pathname }) =>
      /(?:cart-recovery|back-in-stock|price-drop)/u.test(pathname),
    ),
  });
});

test("store browse panel owns focus, uses opaque cursor navigation, opens product evidence, and restores its opener", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openCommerce(page, bootApp, setTheme);
  const opener = page.getByRole("button", {
    name: `Browse data for ${PRIMARY_STORE}`,
  });
  await opener.focus();
  await opener.click();

  const panel = page.getByRole("region", {
    name: `${PRIMARY_STORE} commerce data`,
  });
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();
  await expect(
    page.getByRole("table", { name: "Synced commerce customers" }),
  ).toBeVisible();
  await expect(panel).toContainText("m•••@customer.example");
  await expect(panel).not.toContainText("maya.private@customer.example");

  const customersPager = page.getByRole("navigation", {
    name: "Customers pagination",
  });
  await customersPager
    .getByRole("button", { name: "Customers: Next page" })
    .click();
  await waitForCommerceRequest(
    harness,
    ({ method, pathname, search }) =>
      method === "GET" &&
      pathname ===
        `/api/v1/commerce/integrations/${PRIMARY_INTEGRATION_ID}/customers` &&
      new URLSearchParams(search).get("cursor") === "customer-page-two:opaque",
  );
  await expect(panel).toContainText("Noah Chen");
  await expect(customersPager).toContainText("Page 2");

  await customersPager
    .getByRole("button", { name: "Customers: Previous page" })
    .click();
  await expect
    .poll(
      () =>
        harness.requests.filter(
          ({ method, pathname, search }) =>
            method === "GET" &&
            pathname ===
              `/api/v1/commerce/integrations/${PRIMARY_INTEGRATION_ID}/customers` &&
            !new URLSearchParams(search).has("cursor"),
        ).length,
    )
    .toBeGreaterThanOrEqual(2);
  await expect(panel).toContainText("Maya Rivera");

  const customerTab = panel.getByRole("tab", { name: "Customers" });
  const productTab = panel.getByRole("tab", { name: "Products" });
  await customerTab.focus();
  await customerTab.press("ArrowRight");
  await expect(productTab).toBeFocused();
  await expect(productTab).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("table", { name: "Synced commerce products" }),
  ).toBeVisible();

  const inventoryOpener = page.getByRole("button", {
    name: `View inventory for ${PRIMARY_PRODUCT_TITLE}`,
  });
  await inventoryOpener.click();
  const inventoryDialog = page.getByRole("dialog", {
    name: `Inventory — ${PRIMARY_PRODUCT_TITLE}`,
  });
  await expect(inventoryDialog).toBeVisible();
  const inventoryTable = inventoryDialog.getByRole("table", {
    name: `Inventory history for ${PRIMARY_PRODUCT_TITLE}`,
  });
  await expect(inventoryTable).toBeVisible();
  expect(
    await inventoryTable.evaluate(
      (table) => table.scrollWidth - table.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  expect(
    await seriousAxeViolations(page, { rootSelector: ".modal-card" }),
  ).toEqual([]);
  await saveEvidence(page, testInfo, "commerce-product-inventory-dialog");
  await inventoryDialog
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await expect(inventoryDialog).toHaveCount(0);
  await expect(inventoryOpener).toBeFocused();

  await panel.getByRole("button", { name: "Close store data" }).click();
  await expect(panel).toHaveCount(0);
  await expect(opener).toBeFocused();

  expectCursorListContract(harness);
  await expectNoHorizontalOverflow(page);
  renderer.expectClean();
  await attachJson(testInfo, "commerce-browse-cursor-contract", {
    requests: harness.requests.filter(({ pathname }) =>
      /(?:customers|products|inventory|analytics)$/u.test(pathname),
    ),
  });
});

test("catalog feed panel owns and restores focus while previewing resolver evidence without exposing source secrets", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openCommerce(page, bootApp, setTheme, {
    theme: "light",
  });
  await openCatalogs(page);

  const catalogText = await commerceText(page).innerText();
  expect(catalogText).toContain("https://feeds.northstar.example");
  expect(catalogText).toContain("Feed path and query hidden");
  expect(catalogText).not.toContain(FEED_SECRET_PATH);
  expect(catalogText).not.toContain(FEED_SECRET_TOKEN);

  const opener = page.getByRole("button", {
    name: `Show product feeds for ${PRIMARY_CATALOG_NAME}`,
  });
  await opener.focus();
  await opener.click();
  const panel = page.getByRole("region", {
    name: `Product feeds for ${PRIMARY_CATALOG_NAME}`,
  });
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();
  await expect(
    panel.getByRole("table", {
      name: `Product feeds for ${PRIMARY_CATALOG_NAME}`,
    }),
  ).toBeVisible();
  await expect(panel).toContainText("Criteria: 2 configured fields");
  await expect(panel).toContainText("Fallback: 1 configured field");
  await expect(panel).not.toContainText("private-summer-canary");
  await expect(panel).not.toContainText("private-fallback-canary");

  const resolveOpener = panel.getByRole("button", {
    name: `Resolve a preview of ${PRIMARY_FEED_NAME}`,
  });
  await resolveOpener.click();
  const dialog = page.getByRole("dialog", {
    name: `Resolve preview — ${PRIMARY_FEED_NAME}`,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("table", {
      name: `Resolved products for ${PRIMARY_FEED_NAME}`,
    }),
  ).toBeVisible();
  await expect(dialog).toContainText(PRIMARY_PRODUCT_TITLE);
  await expect(dialog).toContainText("Campaign rendering: not executed");
  await expect(dialog).toContainText("No message was sent.");
  await expect(dialog.getByText(/^(?:Message sent|Delivered)$/u)).toHaveCount(
    0,
  );
  expect(
    await seriousAxeViolations(page, { rootSelector: ".modal-card" }),
  ).toEqual([]);
  await saveEvidence(page, testInfo, "commerce-feed-resolver-preview");

  await dialog
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(resolveOpener).toBeFocused();
  await panel.getByRole("button", { name: "Close feeds" }).click();
  await expect(panel).toHaveCount(0);
  await expect(opener).toBeFocused();

  expectCursorListContract(harness);
  await expectNoHorizontalOverflow(page);
  renderer.expectClean();
  await attachJson(testInfo, "commerce-feed-panel-contract", {
    requests: harness.requests.filter(({ pathname }) =>
      pathname.includes(`/catalogs/${PRIMARY_CATALOG_ID}/feeds`),
    ),
  });
});

test("connection, catalog, import, feed, recovery, and lifecycle dialogs state their authority boundaries and restore focus", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openCommerce(page, bootApp, setTheme);

  const connectOpener = page.getByRole("button", { name: "+ Connect store" });
  await connectOpener.focus();
  await connectOpener.click();
  const connectDialog = page.getByRole("dialog", { name: "Connect store" });
  await expect(connectDialog).toBeVisible();
  await expect(connectDialog).toContainText("Partial · certification pending");
  await expect(connectDialog).toContainText(
    "This creates a partial, certification-pending connection.",
  );
  await connectDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(connectDialog).toHaveCount(0);
  await expect(connectOpener).toBeFocused();

  const disconnectOpener = page
    .getByRole("button", {
      name: "Disconnect",
    })
    .first();
  await disconnectOpener.focus();
  await disconnectOpener.click();
  const disconnectDialog = page.getByRole("alertdialog", {
    name: "Disconnect store integration?",
  });
  await expect(disconnectDialog).toContainText(
    "Already-imported customers, products, and orders are kept.",
  );
  await disconnectDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(disconnectDialog).toHaveCount(0);
  await expect(disconnectOpener).toBeFocused();

  await openCatalogs(page);
  const catalogOpener = page.getByRole("button", { name: "+ New catalog" });
  await catalogOpener.focus();
  await catalogOpener.click();
  const catalogDialog = page.getByRole("dialog", { name: "New catalog" });
  await expect(catalogDialog).toContainText(
    "Manual and remote-feed catalog sources stay unavailable",
  );
  const storeOption = catalogDialog.getByRole("option", {
    name: new RegExp(PRIMARY_STORE, "u"),
  });
  await expect(storeOption).toHaveCount(1);
  await expect(
    catalogDialog.locator(
      `select:has(option[value="${PRIMARY_INTEGRATION_ID}"])`,
    ),
  ).toHaveValue(PRIMARY_INTEGRATION_ID);
  await catalogDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(catalogDialog).toHaveCount(0);
  await expect(
    page.getByRole("alertdialog", {
      name: "Discard product catalog draft?",
    }),
  ).toHaveCount(0);
  await expect(catalogOpener).toBeFocused();

  const importOpener = page.getByRole("button", {
    name: `Import products into ${PRIMARY_CATALOG_NAME}`,
  });
  await importOpener.click();
  const importDialog = page.getByRole("dialog", {
    name: `Import products — ${PRIMARY_CATALOG_NAME}`,
  });
  await expect(importDialog).toContainText("1,000 product objects");
  await expect(importDialog).toContainText("1,000,000 encoded request bytes");
  await importDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(importDialog).toHaveCount(0);
  await expect(importOpener).toBeFocused();

  const feedsOpener = page.getByRole("button", {
    name: `Show product feeds for ${PRIMARY_CATALOG_NAME}`,
  });
  await feedsOpener.click();
  const feedsPanel = page.getByRole("region", {
    name: `Product feeds for ${PRIMARY_CATALOG_NAME}`,
  });
  const feedOpener = feedsPanel.getByRole("button", { name: "+ New feed" });
  await feedOpener.click();
  const feedDialog = page.getByRole("dialog", { name: "New product feed" });
  await expect(feedDialog).toContainText(
    "New feeds are saved as drafts; this workspace does not claim they are published.",
  );
  await expect(
    feedDialog.getByRole("button", { name: "Create draft feed" }),
  ).toBeVisible();
  await feedDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(feedDialog).toHaveCount(0);
  await expect(feedOpener).toBeFocused();
  await feedsPanel.getByRole("button", { name: "Close feeds" }).click();

  await openRecovery(page);
  const recoveryOpener = page.getByRole("button", { name: "+ New link" });
  await recoveryOpener.click();
  const recoveryDialog = page.getByRole("dialog", {
    name: "New cart-recovery link",
  });
  await expect(recoveryDialog).toContainText(
    "Upserts on the cart id — re-registering the same cart updates the link.",
  );
  await expect(recoveryDialog.getByLabel(/^Recovery URL/u)).toBeVisible();
  await recoveryDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(recoveryDialog).toHaveCount(0);
  await expect(recoveryOpener).toBeFocused();

  await openLifecycle(page);
  const evaluationOpener = page.getByRole("button", {
    name: "Evaluate eligibility",
  });
  await evaluationOpener.focus();
  await evaluationOpener.click();
  const evaluationDialog = page.getByRole("dialog", {
    name: `Evaluate eligibility for ${PRIMARY_STORE}?`,
  });
  await expect(evaluationDialog).toContainText("Preflight limits:");
  await expect(evaluationDialog).toContainText(
    "candidate count, channel impact, and inventory/price freshness are not returned",
  );
  await expect(evaluationDialog).toContainText(
    "does not prove any notification was queued, sent, or delivered",
  );
  expect(
    await seriousAxeViolations(page, { rootSelector: ".modal-card" }),
  ).toEqual([]);
  await saveEvidence(page, testInfo, "commerce-lifecycle-evaluation-preflight");
  await evaluationDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(evaluationDialog).toHaveCount(0);
  await expect(evaluationOpener).toBeFocused();

  expectCursorListContract(harness);
  expect(harness.requests.filter(({ method }) => method !== "GET")).toEqual([]);
  renderer.expectClean();
});

test("1440×900, 1100×560, 960×720, 880×700, 700×900, and 400×800 layouts avoid document, shell-content, and route overflow", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openCommerce(page, bootApp, setTheme, {
    theme: "light",
    width: 1440,
    height: 900,
  });
  const evidence: Array<Record<string, unknown>> = [];
  const cases = [
    { width: 1440, height: 900, tab: /Stores/u },
    { width: 1100, height: 560, tab: /Catalogs & feeds/u },
    { width: 960, height: 720, tab: /^.*Recovery.*$/u },
    { width: 880, height: 700, tab: /Lifecycle health/u },
    { width: 700, height: 900, tab: /Stores/u },
    { width: 400, height: 800, tab: /Catalogs & feeds/u },
  ] as const;

  for (const candidate of cases) {
    await page.setViewportSize({
      width: candidate.width,
      height: candidate.height,
    });
    await commerceTab(page, candidate.tab).click();
    await expect(commerceText(page)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const measurement = await page.evaluate(() => {
      const route = document.querySelector<HTMLElement>(".commerce-page");
      const activeTab = document.querySelector<HTMLElement>(
        '.commerce-mode-tab[aria-selected="true"]',
      );
      const buttons = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".commerce-page button:not([hidden])",
        ),
      ).filter((button) => button.getClientRects().length > 0);
      const actionHeights = buttons.map(
        (button) => button.getBoundingClientRect().height,
      );
      return {
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        routeWidth: route?.getBoundingClientRect().width ?? 0,
        routeScrollWidth: route?.scrollWidth ?? 0,
        selectedTab: activeTab?.innerText ?? null,
        minimumVisibleActionHeight:
          actionHeights.length > 0 ? Math.min(...actionHeights) : null,
      };
    });
    evidence.push(measurement);
    expect(measurement.routeWidth).toBeLessThanOrEqual(candidate.width);
    expect(
      measurement.routeScrollWidth - measurement.routeWidth,
    ).toBeLessThanOrEqual(1);
    await saveEvidence(
      page,
      testInfo,
      `commerce-responsive-${candidate.width}x${candidate.height}`,
    );
  }

  expect(await seriousAxeViolations(page)).toEqual([]);
  expectCursorListContract(harness);
  renderer.expectClean();
  await attachJson(testInfo, "commerce-responsive-measurements", evidence);
});

test("reduced motion removes Commerce status animation and forced colors preserve selected-tab focus", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({
    reducedMotion: "reduce",
    forcedColors: "active",
  });
  const renderer = observeRenderer(page);
  const harness = await openCommerce(page, bootApp, setTheme, {
    width: 700,
    height: 900,
  });
  const selected = commerceTab(page, /Stores/u);
  const keyboardTarget = commerceTab(page, /Catalogs & feeds/u);
  await selected.focus();
  await expect(selected).toBeFocused();
  await selected.press("ArrowRight");
  await expect(keyboardTarget).toBeFocused();

  const mediaEvidence = await page.evaluate(() => {
    const heroSignal = document.querySelector<HTMLElement>(
      ".commerce-hero-status > span",
    );
    const selectedTab = document.querySelector<HTMLElement>(
      '.commerce-mode-tab[aria-selected="true"]',
    );
    const focusedTab = document.activeElement as HTMLElement | null;
    const selectedStyle = selectedTab ? getComputedStyle(selectedTab) : null;
    const focusStyle = focusedTab ? getComputedStyle(focusedTab) : null;
    return {
      reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches,
      forcedColors: window.matchMedia("(forced-colors: active)").matches,
      heroSignalAnimation: heroSignal
        ? getComputedStyle(heroSignal).animationName
        : null,
      focusedTabLabel: focusedTab?.innerText ?? null,
      focusVisible: focusedTab?.matches(":focus-visible") ?? false,
      focusOutlineStyle: focusStyle?.outlineStyle ?? null,
      focusOutlineWidth: focusStyle
        ? Number.parseFloat(focusStyle.outlineWidth)
        : null,
      selectedOutlineStyle: selectedStyle?.outlineStyle ?? null,
      selectedOutlineWidth: selectedStyle
        ? Number.parseFloat(selectedStyle.outlineWidth)
        : null,
    };
  });
  expect(mediaEvidence.reducedMotion).toBe(true);
  expect(mediaEvidence.forcedColors).toBe(true);
  expect(mediaEvidence.heroSignalAnimation).toBe("none");
  expect(mediaEvidence.focusedTabLabel).toContain("Catalogs & feeds");
  expect(mediaEvidence.focusVisible).toBe(true);
  expect(mediaEvidence.focusOutlineStyle).toBe("solid");
  expect(mediaEvidence.focusOutlineWidth).toBeGreaterThanOrEqual(2);
  expect(mediaEvidence.selectedOutlineStyle).toBe("solid");
  expect(mediaEvidence.selectedOutlineWidth).toBeGreaterThanOrEqual(2);

  await expectNoHorizontalOverflow(page);
  expect(
    await seriousAxeViolations(page, { disableColorContrast: true }),
  ).toEqual([]);
  expect(harness.unexpected).toEqual([]);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "commerce-forced-colors-reduced-motion");
  await attachJson(
    testInfo,
    "commerce-forced-colors-reduced-motion-measurements",
    mediaEvidence,
  );
});
