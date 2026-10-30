import type { Page } from "@playwright/test";

import {
  ALL_RECORDS,
  attachJson,
  EMPTY_STATS,
  expectNoHorizontalOverflow,
  expectNoSensitiveDom,
  expectNoUnsupportedActions,
  expectReadOnlyGiftContract,
  FIXED_TIME,
  giftRecord,
  HERO_TITLE,
  observeRenderer,
  openGiftHistory,
  PAGE_SIZE,
  PRIMARY_ID,
  PRIMARY_LABEL,
  PRIMARY_RECORD,
  SAFE_STATS,
  saveEvidence,
  SECOND_PAGE_RECORD,
  seriousAxeViolations,
  SERVICE_FAILURE,
  type GiftHarness,
  type PlannedResponse,
} from "./gift-history-evidence-harness";
import { expect, test } from "./fixture";

const FORBIDDEN_VALUES = [
  "Ada Private Canary",
  "Grace Private Canary",
  "pii-canary@example.invalid",
  "recipient-canary@example.invalid",
] as const;

function pageResponse(
  items: readonly unknown[],
  options: {
    total?: number;
    limit?: number;
    offset?: number;
    snapshotAt?: string;
  } = {},
): PlannedResponse {
  return {
    status: 200,
    body: {
      items,
      total: options.total ?? items.length,
      limit: options.limit ?? PAGE_SIZE,
      offset: options.offset ?? 0,
      snapshot_at: options.snapshotAt ?? FIXED_TIME,
    },
  };
}

function latestListRequest(harness: GiftHarness): URLSearchParams {
  const request = [...harness.requests]
    .reverse()
    .find(({ pathname }) => pathname === "/api/v1/gift-subscriptions");
  if (!request) throw new Error("No gift history list request was recorded.");
  return new URLSearchParams(request.search);
}

async function waitForListQuery(
  harness: GiftHarness,
  predicate: (params: URLSearchParams) => boolean,
): Promise<URLSearchParams> {
  let match: URLSearchParams | null = null;
  await expect
    .poll(() => {
      for (const request of [...harness.requests].reverse()) {
        if (request.pathname !== "/api/v1/gift-subscriptions") continue;
        const params = new URLSearchParams(request.search);
        if (predicate(params)) {
          match = params;
          return true;
        }
      }
      return false;
    })
    .toBe(true);
  return match!;
}

async function expectPopulatedArchive(page: Page): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Lifecycle archive", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Inspect ${PRIMARY_LABEL}` }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Gift history pages" }),
  ).toContainText("Showing 1–18 of 30");
}

for (const theme of ["dark", "light"] as const) {
  test(`populated archive is private, read-only, responsive, and axe-clean in ${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const renderer = observeRenderer(page);
    const harness = await openGiftHistory(page, bootApp, setTheme, { theme });

    await expectPopulatedArchive(page);
    await expect(
      page.getByText("Historical inspection is the complete route boundary.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Sanitized projection · no-store", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Gift lifecycle summary" }),
    ).toBeVisible();
    await expectNoUnsupportedActions(page);
    await expectNoSensitiveDom(page, { forbiddenValues: FORBIDDEN_VALUES });
    await expectNoHorizontalOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    expectReadOnlyGiftContract(harness);
    renderer.expectClean();

    await saveEvidence(page, testInfo, `gift-history-populated-${theme}`);
    await attachJson(testInfo, `gift-history-requests-${theme}`, {
      requests: harness.requests,
    });
  });
}

test("search, filter, sort, pagination, detail keyboard controls, and focus restoration serialize only sanitized reads", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openGiftHistory(page, bootApp, setTheme);
  await expectPopulatedArchive(page);

  const search = page.getByRole("searchbox", {
    name: "Find by gift record prefix",
  });
  const lifecycle = page.getByRole("combobox", { name: "Lifecycle" });
  const order = page.getByRole("combobox", { name: "Order" });

  await search.fill(PRIMARY_ID.slice(0, 8).toLowerCase());
  const searchParams = await waitForListQuery(
    harness,
    (params) => params.get("q") === PRIMARY_ID.slice(0, 8).toLowerCase(),
  );
  expect([...searchParams.entries()]).toEqual([
    ["limit", "18"],
    ["offset", "0"],
    ["q", PRIMARY_ID.slice(0, 8).toLowerCase()],
  ]);
  await expect(
    page.getByRole("button", { name: `Inspect ${PRIMARY_LABEL}` }),
  ).toBeVisible();
  await expect(page.locator(".ghs-card")).toHaveCount(1);

  const callsBeforeInvalidEdit = harness.listCalls;
  await search.fill("Gift record 1111111x");
  await expect(search).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("The current result stays in place", { exact: false }),
  ).toBeVisible();
  await page.waitForTimeout(350);
  expect(harness.listCalls).toBe(callsBeforeInvalidEdit);
  await expect(page.locator(".ghs-card")).toHaveCount(1);

  await page.getByRole("button", { name: "Clear gift record search" }).click();
  await lifecycle.selectOption("open");
  const filterParams = await waitForListQuery(
    harness,
    (params) => params.get("filter") === "open" && !params.has("q"),
  );
  expect([...filterParams.entries()]).toEqual([
    ["limit", "18"],
    ["offset", "0"],
    ["filter", "open"],
  ]);
  await expect(page.locator(".ghs-card")).toHaveCount(10);

  await order.selectOption("duration");
  const sortParams = await waitForListQuery(
    harness,
    (params) =>
      params.get("filter") === "open" && params.get("sort") === "duration",
  );
  expect([...sortParams.entries()]).toEqual([
    ["limit", "18"],
    ["offset", "0"],
    ["filter", "open"],
    ["sort", "duration"],
  ]);
  await expect(page.locator(".ghs-card").first()).toContainText("12 months");

  await lifecycle.selectOption("all");
  await order.selectOption("newest");
  await expectPopulatedArchive(page);
  await page
    .getByRole("navigation", { name: "Gift history pages" })
    .getByRole("button", { name: "Next" })
    .click();
  const nextParams = await waitForListQuery(
    harness,
    (params) => params.get("offset") === "18",
  );
  expect([...nextParams.entries()]).toEqual([
    ["limit", "18"],
    ["offset", "18"],
  ]);
  await expect(
    page.getByRole("button", {
      name: `Inspect ${SECOND_PAGE_RECORD.label}`,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Gift history pages" }),
  ).toContainText("Showing 19–30 of 30");
  await page
    .getByRole("navigation", { name: "Gift history pages" })
    .getByRole("button", { name: "Previous" })
    .click();
  await expectPopulatedArchive(page);

  const opener = page.getByRole("button", {
    name: `Inspect ${PRIMARY_LABEL}`,
  });
  await opener.scrollIntoViewIfNeeded();
  await opener.focus();
  await opener.press("Enter");
  const dialog = page.getByRole("dialog", { name: PRIMARY_LABEL });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Record summary" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Lifecycle trail" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Evidence signals" }),
  ).toBeVisible();
  await expect.poll(() => harness.detailCalls).toBeGreaterThanOrEqual(1);
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true);
  await expectNoSensitiveDom(page, { forbiddenValues: FORBIDDEN_VALUES });
  expect(await seriousAxeViolations(page)).toEqual([]);
  await saveEvidence(page, testInfo, "gift-history-private-detail");

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();

  await opener.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();

  await opener.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close evidence" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();

  await expectNoUnsupportedActions(page);
  await expectNoHorizontalOverflow(page);
  expectReadOnlyGiftContract(harness);
  renderer.expectClean();
  await attachJson(testInfo, "gift-history-interaction-requests", {
    requests: harness.requests,
    lastList: [...latestListRequest(harness).entries()],
  });
});

test("initial list and statistics loading expose a bounded skeleton then resolve to verified evidence", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openGiftHistory(page, bootApp, setTheme, {
    holdInitialList: true,
    holdInitialStats: true,
  });
  await expect.poll(() => harness.listCalls).toBe(1);
  await expect.poll(() => harness.statsCalls).toBe(1);
  await expect(
    page.getByRole("region", { name: "Loading gift history" }),
  ).toBeVisible();
  await expect(
    page.getByText("Verifying gift lifecycle records…", { exact: true }),
  ).toBeAttached();
  await expect(page.locator(".ghs-summary-skeleton")).toBeVisible();
  await saveEvidence(page, testInfo, "gift-history-initial-loading");

  harness.releaseInitialList();
  harness.releaseInitialStats();
  await expectPopulatedArchive(page);
  await expect(page.locator(".ghs-summary")).toBeVisible();
  await expect(page.getByText("Verified reads", { exact: true })).toBeVisible();
  expectReadOnlyGiftContract(harness);
  renderer.expectClean();
});

test("initial archive failure is terminal, retryable, and never presented as a true empty archive", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page, [503]);
  const harness = await openGiftHistory(page, bootApp, setTheme, {
    list: [SERVICE_FAILURE],
  });

  await expect(
    page.getByRole("heading", {
      name: "No verified gift history is available.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry archive read" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "No gift lifecycle records are on file.",
    }),
  ).toHaveCount(0);
  await expect.poll(() => harness.listCalls).toBeGreaterThanOrEqual(3);

  await expectNoUnsupportedActions(page);
  await expectNoHorizontalOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expectReadOnlyGiftContract(harness);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "gift-history-terminal-list-error");
});

test("record refresh failure retains the last verified page through the retry budget", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page, [503]);
  const harness = await openGiftHistory(page, bootApp, setTheme, {
    list: [
      pageResponse(ALL_RECORDS.slice(0, PAGE_SIZE), { total: 30 }),
      SERVICE_FAILURE,
    ],
  });
  await expectPopulatedArchive(page);

  await page.getByRole("button", { name: "Refresh evidence" }).click();
  const retained = page.locator('.ghs-retained-error[role="alert"]');
  await expect(retained).toContainText(
    "Refresh failed; verified record page remain visible.",
  );
  await expectPopulatedArchive(page);
  expect(harness.listCalls).toBeGreaterThanOrEqual(4);

  expect(await seriousAxeViolations(page)).toEqual([]);
  expectReadOnlyGiftContract(harness);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "gift-history-retained-list-error");
});

test("aggregate statistics failure is explicit both initially and after a retained refresh", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page, [503]);
  const harness = await openGiftHistory(page, bootApp, setTheme, {
    stats: [{ status: 200, body: SAFE_STATS }, SERVICE_FAILURE],
  });
  await expectPopulatedArchive(page);
  await expect(page.locator(".ghs-summary")).toBeVisible();

  await page.getByRole("button", { name: "Refresh evidence" }).click();
  await expect(
    page
      .locator('.ghs-retained-error[role="alert"]')
      .filter({ hasText: "aggregate statistics" }),
  ).toBeVisible();
  await expect(page.locator(".ghs-summary")).toBeVisible();
  await expect(
    page.getByText("Aggregate Jul 27, 2026", { exact: false }),
  ).toBeVisible();
  expect(harness.statsCalls).toBeGreaterThanOrEqual(4);

  expect(await seriousAxeViolations(page)).toEqual([]);
  expectReadOnlyGiftContract(harness);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "gift-history-retained-stats-error");
});

test("an initial statistics outage never hides the usable record archive or claims an aggregate", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page, [503]);
  const harness = await openGiftHistory(page, bootApp, setTheme, {
    stats: [
      SERVICE_FAILURE,
      SERVICE_FAILURE,
      SERVICE_FAILURE,
      { status: 200, body: SAFE_STATS },
    ],
  });
  await expectPopulatedArchive(page);
  await expect.poll(() => harness.statsCalls).toBeGreaterThanOrEqual(3);
  await expect(
    page.getByText("Aggregate not verified", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".ghs-summary")).toHaveCount(0);
  await expect(page.locator(".ghs-summary-skeleton")).toHaveCount(0);
  const unavailable = page.getByRole("alert").filter({
    hasText: "The verified record archive is still usable.",
  });
  await expect(unavailable).toBeVisible();
  await unavailable.getByRole("button", { name: "Retry aggregate" }).click();
  await expect(page.locator(".ghs-summary")).toBeVisible();
  await expect(
    page.getByText("Aggregate Jul 27, 2026", { exact: false }),
  ).toBeVisible();

  await expectNoUnsupportedActions(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expectReadOnlyGiftContract(harness);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "gift-history-initial-stats-error");
});

test("detail failure is partial, retains the sanitized list evidence, and recovers through the same GET", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page, [503]);
  const harness = await openGiftHistory(page, bootApp, setTheme, {
    detail: [
      SERVICE_FAILURE,
      SERVICE_FAILURE,
      SERVICE_FAILURE,
      { status: 200, body: PRIMARY_RECORD },
    ],
  });
  await expectPopulatedArchive(page);
  const opener = page.getByRole("button", {
    name: `Inspect ${PRIMARY_LABEL}`,
  });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: PRIMARY_LABEL });
  await expect(dialog).toBeVisible();
  await expect(
    dialog
      .getByRole("alert")
      .getByText("Refresh failed; verified record page remain visible.", {
        exact: false,
      }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Record summary" }),
  ).toBeVisible();
  await saveEvidence(page, testInfo, "gift-history-partial-detail-error");

  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(
    dialog.getByText("Detail verified", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(harness.detailCalls).toBe(4);
  await expectNoSensitiveDom(page, { forbiddenValues: FORBIDDEN_VALUES });
  expect(await seriousAxeViolations(page)).toEqual([]);
  expectReadOnlyGiftContract(harness);
  renderer.expectClean();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("true empty and server-filtered empty results remain semantically distinct", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openGiftHistory(page, bootApp, setTheme, {
    theme: "light",
    list: [pageResponse([])],
    stats: [{ status: 200, body: EMPTY_STATS }],
  });
  await expect(
    page.getByRole("heading", {
      name: "No gift lifecycle records are on file.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "No verified gift history is available.",
    }),
  ).toHaveCount(0);
  await expectNoUnsupportedActions(page);
  await expectNoHorizontalOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expectReadOnlyGiftContract(harness);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "gift-history-true-empty");
});

test("a no-match server search is a filtered empty state and clearing controls restores the archive", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openGiftHistory(page, bootApp, setTheme);
  await expectPopulatedArchive(page);

  await page
    .getByRole("searchbox", { name: "Find by gift record prefix" })
    .fill("ffffeeee");
  await waitForListQuery(harness, (params) => params.get("q") === "ffffeeee");
  await expect(
    page.getByRole("heading", {
      name: "Nothing on this page matches these controls.",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "No gift lifecycle records are on file.",
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Clear controls" }).click();
  await expectPopulatedArchive(page);

  expectReadOnlyGiftContract(harness);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "gift-history-filtered-empty");
});

test("malformed lifecycle evidence is quarantined visibly while PII and provider canaries stay out of the DOM", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const malformed = {
    ...giftRecord(1),
    status: "provider_pending",
    duration_months: 0,
    created_at: "not-a-date",
    provider_invoice_linked: "yes",
    purchaser_email: FORBIDDEN_VALUES[2],
    recipient_email: FORBIDDEN_VALUES[3],
    purchaser_name: FORBIDDEN_VALUES[0],
    recipient_name: FORBIDDEN_VALUES[1],
    message: "private-message-canary",
    stripe_payment_url: "https://provider.invalid/private-checkout-canary",
  };
  const renderer = observeRenderer(page);
  const harness = await openGiftHistory(page, bootApp, setTheme, {
    list: [
      pageResponse([malformed, "malformed-row"], {
        total: 1,
        limit: 101,
        snapshotAt: "not-a-date",
      }),
    ],
  });

  const integrity = page.locator(".ghs-integrity");
  await expect(integrity).toBeVisible();
  await expect(integrity).toContainText("Archive integrity needs review.");
  await expect(integrity).toContainText("contract-invalid row was contained");
  await expect(integrity).toContainText("envelope");
  await expect(
    page.getByText("Data issue", { exact: true }).first(),
  ).toBeVisible();
  await expectNoSensitiveDom(page, {
    forbiddenValues: [
      ...FORBIDDEN_VALUES,
      "private-message-canary",
      "private-checkout-canary",
    ],
  });

  await integrity.getByRole("button", { name: "Review this page" }).click();
  await expect(page.locator(".ghs-card")).toHaveCount(1);
  await expect(
    page.getByText("integrity warnings", { exact: false }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expectReadOnlyGiftContract(harness);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "gift-history-malformed-integrity");
});

test("page-local integrity review preserves later-page access and the server window stops truthfully", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const renderer = observeRenderer(page);
  const harness = await openGiftHistory(page, bootApp, setTheme);
  await expectPopulatedArchive(page);

  await page
    .getByRole("combobox", { name: "Lifecycle" })
    .selectOption("data_issue");
  await expect(
    page.getByRole("heading", {
      name: "No readable field issues appear on this page.",
    }),
  ).toBeVisible();
  const pages = page.getByRole("navigation", { name: "Gift history pages" });
  await expect(pages).toBeVisible();
  await pages.getByRole("button", { name: "Next" }).click();
  await expect
    .poll(() =>
      harness.requests.some(
        ({ pathname, search }) =>
          pathname === "/api/v1/gift-subscriptions" &&
          new URLSearchParams(search).get("offset") === "18",
      ),
    )
    .toBe(true);
  await expect(
    page.getByRole("heading", {
      name: "No readable field issues appear on this page.",
    }),
  ).toBeVisible();

  expectReadOnlyGiftContract(harness);
  renderer.expectClean();
});

test("a large archive never emits an offset beyond the bounded server contract", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const renderer = observeRenderer(page);
  const harness = await openGiftHistory(page, bootApp, setTheme, {
    list: [
      pageResponse([PRIMARY_RECORD], {
        total: 20_000,
        limit: PAGE_SIZE,
        offset: 9_990,
      }),
    ],
  });

  const pages = page.getByRole("navigation", { name: "Gift history pages" });
  await expect(pages).toContainText("archive window limit reached");
  await expect(pages.getByRole("button", { name: "Next" })).toBeDisabled();
  expect(
    harness.requests.some(
      ({ pathname, search }) =>
        pathname === "/api/v1/gift-subscriptions" &&
        Number(new URLSearchParams(search).get("offset")) > 10_000,
    ),
  ).toBe(false);
  expectReadOnlyGiftContract(harness);
  renderer.expectClean();
});

test("1440, 1024, 700, and 400 pixel layouts reflow without document, shell-content, or route overflow", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openGiftHistory(page, bootApp, setTheme, {
    theme: "light",
    width: 1_440,
    height: 900,
  });
  await expectPopulatedArchive(page);

  const evidence: Array<Record<string, unknown>> = [];
  for (const size of [
    { width: 1_440, height: 900 },
    { width: 1_024, height: 900 },
    { width: 700, height: 900 },
    { width: 400, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await expect(page.locator(".ghs-page")).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const layout = await page.evaluate(() => {
      const columns = (selector: string): number => {
        const node = document.querySelector<HTMLElement>(selector);
        if (!node) return 0;
        const value = getComputedStyle(node).gridTemplateColumns;
        return value === "none" ? 0 : value.trim().split(/\s+/u).length;
      };
      const textSizes = [
        ".ghs-journey-live",
        ".ghs-journey-track small",
        ".ghs-summary-label",
        ".ghs-summary small",
        ".ghs-search-boundary",
        ".ghs-card-top > div:nth-child(2) > span",
        ".ghs-card-primary span",
        ".ghs-card-primary strong",
        ".ghs-evidence-pill",
        ".ghs-inspect",
        ".ghs-pagination",
      ].flatMap((selector) => {
        const node = document.querySelector<HTMLElement>(selector);
        return node ? [Number.parseFloat(getComputedStyle(node).fontSize)] : [];
      });
      const targetHeights = [
        ".ghs-refresh",
        ".ghs-inspect",
        ".ghs-pagination .btn",
      ].flatMap((selector) => {
        const node = document.querySelector<HTMLElement>(selector);
        return node ? [node.getBoundingClientRect().height] : [];
      });
      const card = document.querySelector<HTMLElement>(".ghs-card");
      return {
        viewport: window.innerWidth,
        cardColumns: columns(".ghs-card-grid"),
        summaryColumns: columns(".ghs-summary"),
        controlColumns: columns(".ghs-control-grid"),
        cardWidth: card?.getBoundingClientRect().width ?? 0,
        minimumRouteTextSize: Math.min(...textSizes),
        minimumActionHeight: Math.min(...targetHeights),
      };
    });
    evidence.push(layout);

    if (size.width >= 1_024) {
      expect(layout.cardColumns).toBe(2);
    } else {
      expect(layout.cardColumns).toBe(1);
    }
    if (size.width === 1_440) expect(layout.summaryColumns).toBe(5);
    if (size.width === 1_024) expect(layout.summaryColumns).toBe(3);
    if (size.width === 700) expect(layout.summaryColumns).toBe(2);
    if (size.width === 400) {
      expect(layout.summaryColumns).toBe(1);
      expect(layout.controlColumns).toBe(1);
      expect(layout.cardWidth).toBeLessThanOrEqual(400);
    }
    expect(layout.minimumRouteTextSize).toBeGreaterThanOrEqual(10);
    expect(layout.minimumActionHeight).toBeGreaterThanOrEqual(
      size.width <= 700 ? 44 : 40,
    );
    await saveEvidence(page, testInfo, `gift-history-responsive-${size.width}`);
  }

  expect(await seriousAxeViolations(page)).toEqual([]);
  expectReadOnlyGiftContract(harness);
  renderer.expectClean();
  await attachJson(testInfo, "gift-history-responsive-measurements", evidence);
});

test("reduced motion removes the journey signal and interactive transitions", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const renderer = observeRenderer(page);
  const harness = await openGiftHistory(page, bootApp, setTheme, {
    width: 700,
    height: 900,
  });
  await expectPopulatedArchive(page);

  const motion = await page.evaluate(() => {
    const signal = document.querySelector<HTMLElement>(
      ".ghs-journey-connector > span",
    );
    const card = document.querySelector<HTMLElement>(".ghs-card");
    const search = document.querySelector<HTMLElement>(".ghs-search");
    const maxDurationMs = (value: string): number =>
      Math.max(
        ...value.split(",").map((duration) => {
          const normalized = duration.trim();
          return normalized.endsWith("ms")
            ? Number.parseFloat(normalized)
            : Number.parseFloat(normalized) * 1_000;
        }),
      );
    return {
      mediaMatches: window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches,
      signalAnimation: signal ? getComputedStyle(signal).animationName : null,
      cardTransitionMs: card
        ? maxDurationMs(getComputedStyle(card).transitionDuration)
        : null,
      searchTransitionMs: search
        ? maxDurationMs(getComputedStyle(search).transitionDuration)
        : null,
    };
  });
  expect(motion.mediaMatches).toBe(true);
  expect(motion.signalAnimation).toBe("none");
  expect(motion.cardTransitionMs).not.toBeNull();
  expect(motion.cardTransitionMs!).toBeLessThanOrEqual(10);
  expect(motion.searchTransitionMs).not.toBeNull();
  expect(motion.searchTransitionMs!).toBeLessThanOrEqual(10);

  await expectNoHorizontalOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expectReadOnlyGiftContract(harness);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "gift-history-reduced-motion");
  await attachJson(
    testInfo,
    "gift-history-reduced-motion-measurements",
    motion,
  );
});

test("forced colors preserve selected summary and keyboard-focus evidence", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active" });
  const renderer = observeRenderer(page);
  const harness = await openGiftHistory(page, bootApp, setTheme, {
    width: 700,
    height: 900,
  });
  await expectPopulatedArchive(page);

  const selected = page.locator('.ghs-summary button[aria-pressed="true"]');
  await selected.focus();
  await expect(selected).toBeFocused();
  const contrastEvidence = await selected.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      mediaMatches: window.matchMedia("(forced-colors: active)").matches,
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      borderStyle: style.borderStyle,
    };
  });
  expect(contrastEvidence.mediaMatches).toBe(true);
  expect(contrastEvidence.outlineStyle).toBe("solid");
  expect(contrastEvidence.outlineWidth).toBeGreaterThanOrEqual(2);

  await expectNoHorizontalOverflow(page);
  expect(
    await seriousAxeViolations(page, { disableColorContrast: true }),
  ).toEqual([]);
  expectReadOnlyGiftContract(harness);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "gift-history-forced-colors");
  await attachJson(
    testInfo,
    "gift-history-forced-colors-measurements",
    contrastEvidence,
  );
});

test("the route-level network guard catches forbidden gift/provider endpoints, mutations, request bodies, raw identifiers, and PII", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openGiftHistory(page, bootApp, setTheme);
  await expectPopulatedArchive(page);
  await page.getByRole("button", { name: `Inspect ${PRIMARY_LABEL}` }).click();
  await expect(page.getByRole("dialog", { name: PRIMARY_LABEL })).toBeVisible();

  await expectNoUnsupportedActions(page);
  await expectNoSensitiveDom(page, { forbiddenValues: FORBIDDEN_VALUES });
  expectReadOnlyGiftContract(harness);
  const forbiddenRequests = harness.requests.filter(
    ({ method, pathname, body }) =>
      method !== "GET" ||
      body !== null ||
      /(?:attribution|redeem|checkout|stripe|provider|public|create|cancel|edit|export)/iu.test(
        pathname,
      ),
  );
  expect(forbiddenRequests).toEqual([]);
  renderer.expectClean();
  await attachJson(testInfo, "gift-history-network-guard", {
    allowedRequests: harness.requests,
    forbiddenRequests,
    rawIdsChecked: ALL_RECORDS.length,
    forbiddenValuesChecked: FORBIDDEN_VALUES,
    hero: HERO_TITLE,
  });
});
