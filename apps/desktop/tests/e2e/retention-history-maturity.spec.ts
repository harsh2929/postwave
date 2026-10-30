import {
  captureRetentionEvidence,
  expectAutomaticRetentionReadCount,
  expectNoRetentionOverflow,
  expectRetentionSafety,
  expectedHttpFailureCount,
  openRetentionHistory,
  requestCount,
  retentionAxeViolations,
  type RetentionHarness,
} from "./retention-history-evidence-harness";
import { expect, test } from "../visual/fixture";

const FOUNDER_OFFER_ID = "20000000-0000-4000-8000-000000000001";

async function settledRequestCount(
  harness: RetentionHarness,
  pathname: string,
): Promise<number> {
  let observed = requestCount(harness, pathname);
  let stableSince = Date.now();
  await expect
    .poll(
      () => {
        const current = requestCount(harness, pathname);
        if (current !== observed) {
          observed = current;
          stableSince = Date.now();
        }
        return Date.now() - stableSince;
      },
      { timeout: 5_000, intervals: [100] },
    )
    .toBeGreaterThanOrEqual(500);
  return observed;
}

test.describe("Retention history maturity", () => {
  test("desktop evidence workflow is truthful, read-only, keyboard-complete, and accessible", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openRetentionHistory(
      page,
      bootApp,
      setTheme,
      testInfo,
      { theme: "dark" },
    );

    await expect(
      page.getByText("Counts are event rows, not unique customers.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText("259", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("57", { exact: true }).first()).toBeVisible();
    await expect(
      page.getByText("22.0%", { exact: true }).first(),
    ).toBeVisible();
    await expectNoRetentionOverflow(page);
    expect(await retentionAxeViolations(page)).toEqual([]);
    await captureRetentionEvidence(
      page,
      testInfo,
      "retention-overview-desktop",
      harness,
    );

    const overview = page.getByRole("tab", { name: /Overview/u });
    const history = page.getByRole("tab", { name: /Offer history/u });
    await overview.focus();
    await page.keyboard.press("ArrowRight");
    await expect(history).toBeFocused();
    await expect(overview).toHaveAttribute("aria-selected", "true");
    // Chromium can finish the focus/scrollIntoView adjustment from roving-tab
    // navigation on the next rendered frame. Sample the settled activation
    // origin so this assertion tests the route commit, not an earlier frame.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    const tabActivationScrollTop = await page
      .locator("main#main-content")
      .evaluate((main) => main.scrollTop);
    await page.keyboard.press("Enter");
    await expect(history).toHaveAttribute("aria-selected", "true");
    await expect(history).toBeFocused();
    await expect
      .poll(() =>
        page.locator("main#main-content").evaluate((main) => main.scrollTop),
      )
      .toBe(tabActivationScrollTop);

    await expect(page.getByText("12.50 off", { exact: true })).toBeVisible();
    await expect(
      page.getByText("1 month · currency not stored", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("$12.50", { exact: true })).toHaveCount(0);
    await page.emulateMedia({ media: "print" });
    await expect(page.locator(".rhs-print-context")).toContainText(
      "This output contains 6 of 6 matching offer rows",
    );
    const printGeometry = await page
      .locator(".rhs-history-card")
      .evaluate((card) => {
        const table = card.querySelector("table");
        const wrap = card.querySelector<HTMLElement>(".rhs-table-wrap");
        if (!(table instanceof HTMLElement) || !wrap) {
          throw new Error("Missing printable history table");
        }
        return {
          cardWidth: card.getBoundingClientRect().width,
          tableWidth: table.getBoundingClientRect().width,
          tableDisplay: getComputedStyle(table).display,
          tableMinWidth: getComputedStyle(table).minWidth,
          wrapOverflow: getComputedStyle(wrap).overflowX,
        };
      });
    expect(printGeometry.tableDisplay).toBe("block");
    expect(printGeometry.tableMinWidth).toBe("0px");
    expect(printGeometry.wrapOverflow).toBe("visible");
    expect(printGeometry.tableWidth).toBeLessThanOrEqual(
      printGeometry.cardWidth,
    );
    const printShell = await page.evaluate(() => {
      const appShell = document.querySelector<HTMLElement>(".app-shell");
      const content = document.querySelector<HTMLElement>("main.content");
      const sidebar = document.querySelector<HTMLElement>(".sidebar");
      if (!appShell || !content || !sidebar) {
        throw new Error("Missing printable shell surfaces");
      }
      return {
        appShellDisplay: getComputedStyle(appShell).display,
        appShellOverflow: getComputedStyle(appShell).overflow,
        bodyScrollHeight: document.body.scrollHeight,
        bodyOverflow: getComputedStyle(document.body).overflow,
        contentOverflow: getComputedStyle(content).overflow,
        sidebarDisplay: getComputedStyle(sidebar).display,
        viewportHeight: window.innerHeight,
      };
    });
    expect(printShell.appShellDisplay).toBe("block");
    expect(printShell.appShellOverflow).toBe("visible");
    expect(printShell.bodyScrollHeight).toBeGreaterThan(
      printShell.viewportHeight,
    );
    expect(printShell.bodyOverflow).toBe("visible");
    expect(printShell.contentOverflow).toBe("visible");
    expect(printShell.sidebarDisplay).toBe("none");
    const printEvidence = await page.pdf({
      format: "A4",
      printBackground: true,
    });
    expect(printEvidence.byteLength).toBeGreaterThan(10_000);
    const pdfPageCount =
      printEvidence.toString("latin1").match(/\/Type\s*\/Page\b/gu)?.length ??
      0;
    expect(pdfPageCount).toBeGreaterThan(1);
    expect(pdfPageCount).toBeLessThan(20);
    await testInfo.attach("retention-history-a4-print", {
      body: printEvidence,
      contentType: "application/pdf",
    });
    await page.emulateMedia({ media: "screen" });
    expect(await retentionAxeViolations(page)).toEqual([]);

    const search = page.getByRole("searchbox", {
      name: "Search retained offers",
    });
    await search.fill("annual");
    await expect(
      page.getByText("1 matching offer", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Annual member save", { exact: true }),
    ).toBeVisible();
    await search.fill("");

    const opener = page
      .getByRole("button", { name: /Inspect Keep the founder rate/u })
      .first();
    await opener.click();
    const dialog = page.getByRole("dialog", {
      name: "Keep the founder rate",
    });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("20% off", { exact: true })).toBeVisible();
    await expect(dialog.getByText("24.2%", { exact: true })).toBeVisible();
    await expect(
      dialog.getByText("Not available from this API", { exact: true }).first(),
    ).toBeVisible();
    expect(await retentionAxeViolations(page, ".rhs-detail")).toEqual([]);
    await captureRetentionEvidence(
      page,
      testInfo,
      "retention-detail-desktop",
      harness,
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    const readiness = page.getByRole("tab", { name: /Readiness/u });
    await readiness.click();
    await expect(
      page.getByText("Stored facts do not become runtime promises.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Not certified", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "A stored switch is not proof of worker startup or safe delivery.",
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    expect(await retentionAxeViolations(page)).toEqual([]);
    await captureRetentionEvidence(
      page,
      testInfo,
      "retention-readiness-desktop",
      harness,
    );

    expectAutomaticRetentionReadCount(
      requestCount(harness, "/api/v1/retention-offers"),
    );
    expectAutomaticRetentionReadCount(
      requestCount(harness, "/api/v1/retention-offers/funnel"),
    );
    expectAutomaticRetentionReadCount(
      requestCount(harness, "/api/v1/retention-offers/winback-settings"),
    );
    expectAutomaticRetentionReadCount(
      requestCount(harness, "/api/v1/paywall/tiers"),
    );
    expect(harness.expectedHttpFailures).toEqual([]);
    expect(harness.expectedNetworkErrors).toEqual([]);
    await expectRetentionSafety(page, harness);
  });

  test("history controls and detail survive canonical URL navigation and reload", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openRetentionHistory(
      page,
      bootApp,
      setTheme,
      testInfo,
      { theme: "dark" },
    );

    const historyTab = page.getByRole("tab", { name: /Offer history/u });
    const search = page.getByRole("searchbox", {
      name: "Search retained offers",
    });
    const status = page.getByRole("combobox", {
      name: "Stored state",
      exact: true,
    });
    const discount = page.getByRole("combobox", {
      name: "Discount",
      exact: true,
    });
    const evidence = page.getByRole("combobox", {
      name: "Evidence",
      exact: true,
    });
    const order = page.getByRole("combobox", {
      name: "Order",
      exact: true,
    });

    await historyTab.click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("tab"))
      .toBe("history");
    await search.fill("founder");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("q"))
      .toBe("founder");
    await status.selectOption("active");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("f.status"))
      .toBe("active");
    await discount.selectOption("percent");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("f.discount"))
      .toBe("percent");
    await evidence.selectOption("measured");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("f.evidence"))
      .toBe("measured");
    await order.selectOption("oldest");

    const canonicalListPath =
      "/app/retention-offers?tab=history&q=founder&sort=recorded&dir=asc&f.discount=percent&f.evidence=measured&f.status=active";
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return `${url.pathname}${url.search}`;
      })
      .toBe(canonicalListPath);
    await expect(search).toHaveValue("founder");
    await expect(status).toHaveValue("active");
    await expect(discount).toHaveValue("percent");
    await expect(evidence).toHaveValue("measured");
    await expect(order).toHaveValue("oldest");
    await expect(
      page.getByText("1 matching offer", { exact: true }),
    ).toBeVisible();

    const opener = page.getByRole("button", {
      name: "Inspect Keep the founder rate for Founders",
      exact: true,
    });
    await opener.click();
    const dialog = page.getByRole("dialog", {
      name: "Keep the founder rate",
    });
    await expect(dialog).toBeVisible();
    const canonicalDetailPath = `${canonicalListPath}&overlay=retention-offer-detail&overlayId=${FOUNDER_OFFER_ID}`;
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return `${url.pathname}${url.search}`;
      })
      .toBe(canonicalDetailPath);
    const historyLengthAfterOpen = await page.evaluate(
      () => window.history.length,
    );

    await page.evaluate(() => window.history.back());
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return `${url.pathname}${url.search}`;
      })
      .toBe(canonicalListPath);
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(search).toHaveValue("founder");
    await expect(status).toHaveValue("active");
    await expect(discount).toHaveValue("percent");
    await expect(evidence).toHaveValue("measured");
    await expect(order).toHaveValue("oldest");
    await expect(
      page.getByText("Keep the founder rate", { exact: true }),
    ).toBeVisible();

    await page.evaluate(() => window.history.forward());
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return `${url.pathname}${url.search}`;
      })
      .toBe(canonicalDetailPath);
    await expect(dialog).toBeVisible();

    await dialog
      .getByRole("button", { name: "Close", exact: true })
      .last()
      .click();
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return `${url.pathname}${url.search}`;
      })
      .toBe(canonicalListPath);
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => window.history.length))
      .toBe(historyLengthAfterOpen);

    await page.evaluate(() => window.history.forward());
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return `${url.pathname}${url.search}`;
      })
      .toBe(canonicalDetailPath);
    await expect(dialog).toBeVisible();
    await page.evaluate(() => window.history.back());
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return `${url.pathname}${url.search}`;
      })
      .toBe(canonicalListPath);
    await expect(dialog).toBeHidden();
    await expect(opener).toBeFocused();

    await page.reload();
    await expect(
      page.getByRole("heading", {
        name: "See what the retention record can prove—and where it stops.",
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(() => {
        const url = new URL(page.url());
        return `${url.pathname}${url.search}`;
      })
      .toBe(canonicalListPath);
    await expect(historyTab).toHaveAttribute("aria-selected", "true");
    await expect(search).toHaveValue("founder");
    await expect(status).toHaveValue("active");
    await expect(discount).toHaveValue("percent");
    await expect(evidence).toHaveValue("measured");
    await expect(order).toHaveValue("oldest");
    await expect(
      page.getByText("1 matching offer", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Keep the founder rate", { exact: true }),
    ).toBeVisible();
    expect(await retentionAxeViolations(page)).toEqual([]);
    await page.locator(".rhs-controls").scrollIntoViewIfNeeded();
    await captureRetentionEvidence(
      page,
      testInfo,
      "retention-history-url-restored",
      harness,
    );
    await expectRetentionSafety(page, harness);
  });

  test("400px compact history and drawer remain contained and operable", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openRetentionHistory(
      page,
      bootApp,
      setTheme,
      testInfo,
      { width: 400, height: 844, theme: "light" },
    );
    await expectNoRetentionOverflow(page);
    const compactTabs = page.getByRole("tablist", {
      name: "Retention history views",
      exact: true,
    });
    await expect(compactTabs).toHaveAttribute("aria-orientation", "vertical");
    const compactOverview = page.getByRole("tab", { name: /Overview/u });
    const compactHistory = page.getByRole("tab", { name: /Offer history/u });
    await compactOverview.focus();
    await page.keyboard.press("ArrowDown");
    await expect(compactHistory).toBeFocused();
    await page.keyboard.press("Enter");
    const compactCards = page.getByRole("region", {
      name: "Retention offer cards",
      exact: true,
    });
    await expect(compactCards).not.toHaveAttribute("tabindex", "0");
    await expect(
      page.getByText("Keep the founder rate", { exact: true }),
    ).toBeVisible();
    expect(await retentionAxeViolations(page)).toEqual([]);
    await captureRetentionEvidence(
      page,
      testInfo,
      "retention-history-narrow-400",
      harness,
    );

    const opener = page
      .getByRole("button", { name: /Inspect Keep the founder rate/u })
      .first();
    await opener.click();
    const dialog = page.getByRole("dialog", {
      name: "Keep the founder rate",
    });
    await expect(dialog).toBeVisible();
    await expectNoRetentionOverflow(page);
    const geometry = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>(".rhs-detail");
      const close = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".rhs-detail button"),
      ).find((button) => button.textContent?.trim() === "Close");
      const dialogBox = dialog?.getBoundingClientRect();
      const closeBox = close?.getBoundingClientRect();
      return {
        closeBottom: closeBox?.bottom ?? Number.POSITIVE_INFINITY,
        closeTop: closeBox?.top ?? Number.NEGATIVE_INFINITY,
        dialogBottom: dialogBox?.bottom ?? Number.POSITIVE_INFINITY,
        dialogTop: dialogBox?.top ?? Number.NEGATIVE_INFINITY,
        viewportHeight: window.innerHeight,
      };
    });
    expect(geometry.dialogTop).toBeGreaterThanOrEqual(0);
    expect(geometry.dialogBottom).toBeLessThanOrEqual(
      geometry.viewportHeight + 1,
    );
    expect(geometry.closeTop).toBeGreaterThanOrEqual(0);
    expect(geometry.closeBottom).toBeLessThanOrEqual(
      geometry.viewportHeight + 1,
    );
    expect(await retentionAxeViolations(page, ".rhs-detail")).toEqual([]);
    await captureRetentionEvidence(
      page,
      testInfo,
      "retention-detail-narrow-400",
      harness,
    );
    await dialog
      .locator(".slideover-footer")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(opener).toBeFocused();

    await expectRetentionSafety(page, harness);
  });

  test("820px history table exposes a keyboard-scrollable labelled region", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openRetentionHistory(
      page,
      bootApp,
      setTheme,
      testInfo,
      { width: 820, height: 900, theme: "dark" },
    );
    await page.getByRole("tab", { name: /Offer history/u }).click();

    const tableRegion = page.getByRole("region", {
      name: "Scrollable retention offer table",
      exact: true,
    });
    await expect(tableRegion).toBeVisible();
    await expect(tableRegion).toHaveAttribute("tabindex", "0");
    const geometry = await tableRegion.evaluate((region) => ({
      clientWidth: region.clientWidth,
      scrollWidth: region.scrollWidth,
    }));
    expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);

    await tableRegion.focus();
    await expect(tableRegion).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(() => tableRegion.evaluate((region) => region.scrollLeft))
      .toBeGreaterThan(0);

    await expectNoRetentionOverflow(page);
    expect(await retentionAxeViolations(page)).toEqual([]);
    await tableRegion.scrollIntoViewIfNeeded();
    await captureRetentionEvidence(
      page,
      testInfo,
      "retention-history-midwidth-keyboard-scroll",
      harness,
    );
    await expectRetentionSafety(page, harness);
  });

  test("funnel outage preserves offer history and makes every metric unknown", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openRetentionHistory(
      page,
      bootApp,
      setTheme,
      testInfo,
      { mode: "funnel-error", theme: "dark" },
    );
    await expect(
      page.getByRole("heading", {
        name: "Offer records remain visible; outcome totals do not.",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Dashes mean unknown, never zero.", { exact: false }),
    ).toBeVisible();
    await page.getByRole("tab", { name: /Offer history/u }).click();
    await expect(
      page.getByText("Keep the founder rate", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Private aggregation detail")).toHaveCount(0);
    expect(await retentionAxeViolations(page)).toEqual([]);
    await captureRetentionEvidence(
      page,
      testInfo,
      "retention-funnel-outage",
      harness,
    );
    const funnelRequests = requestCount(
      harness,
      "/api/v1/retention-offers/funnel",
    );
    expectAutomaticRetentionReadCount(funnelRequests, {
      expectedFailure: true,
    });
    expect(
      expectedHttpFailureCount(harness, "/api/v1/retention-offers/funnel"),
    ).toBe(funnelRequests);
    expect(harness.expectedNetworkErrors).toHaveLength(funnelRequests);
    await expectRetentionSafety(page, harness);
  });

  test("integrity conflicts suppress aggregate rates while retaining row evidence", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openRetentionHistory(
      page,
      bootApp,
      setTheme,
      testInfo,
      { mode: "integrity-conflict", theme: "dark" },
    );
    await expect(
      page.getByRole("heading", {
        name: "1 reconciliation issue blocks aggregate claims.",
      }),
    ).toBeVisible();
    await expect(page.getByText("22.0%", { exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: /Offer history/u }).click();
    await expect(
      page.getByText("Outcome conflict", { exact: true }),
    ).toBeVisible();
    expect(await retentionAxeViolations(page)).toEqual([]);
    await captureRetentionEvidence(
      page,
      testInfo,
      "retention-integrity-conflict",
      harness,
    );
    await expectRetentionSafety(page, harness);
  });

  test("a valid empty offer response stays explicit while Readiness remains available", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openRetentionHistory(
      page,
      bootApp,
      setTheme,
      testInfo,
      { mode: "empty", theme: "dark" },
    );

    const emptyHeading = page.getByRole("heading", {
      name: "No current stored offer rows were returned.",
      exact: true,
    });
    await expect(emptyHeading).toBeVisible();
    await expect(
      page.getByText("Valid empty response", { exact: true }),
    ).toBeVisible();
    expect(await retentionAxeViolations(page)).toEqual([]);
    await emptyHeading.scrollIntoViewIfNeeded();
    await captureRetentionEvidence(
      page,
      testInfo,
      "retention-valid-empty",
      harness,
    );

    await page.getByRole("tab", { name: /Readiness/u }).click();
    const emptyReadinessHeading = page.getByText(
      "Stored facts do not become runtime promises.",
      {
        exact: true,
      },
    );
    await expect(emptyReadinessHeading).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Win-back setting observation",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText("Enabled", { exact: true })).toBeVisible();
    expect(await retentionAxeViolations(page)).toEqual([]);
    await emptyReadinessHeading.scrollIntoViewIfNeeded();
    await captureRetentionEvidence(
      page,
      testInfo,
      "retention-valid-empty-readiness",
      harness,
    );

    expectAutomaticRetentionReadCount(
      requestCount(harness, "/api/v1/retention-offers"),
    );
    expectAutomaticRetentionReadCount(
      requestCount(harness, "/api/v1/retention-offers/funnel"),
    );
    expectAutomaticRetentionReadCount(
      requestCount(harness, "/api/v1/paywall/tiers"),
    );
    expectAutomaticRetentionReadCount(
      requestCount(harness, "/api/v1/retention-offers/winback-settings"),
    );
    await expectRetentionSafety(page, harness);
  });

  test("a critical offer-read failure recovers only after an explicit retry", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openRetentionHistory(
      page,
      bootApp,
      setTheme,
      testInfo,
      { mode: "offers-retry", theme: "dark" },
    );

    const unavailableHeading = page.getByRole("heading", {
      name: "The stored offer-row response could not be verified.",
      exact: true,
    });
    await expect(unavailableHeading).toBeVisible();
    await expect(
      page.getByText("History unavailable", { exact: true }),
    ).toBeVisible();
    expect(await retentionAxeViolations(page)).toEqual([]);
    await unavailableHeading.scrollIntoViewIfNeeded();
    await captureRetentionEvidence(
      page,
      testInfo,
      "retention-offers-initial-503",
      harness,
    );

    const initialOfferRequests = await settledRequestCount(
      harness,
      "/api/v1/retention-offers",
    );
    expectAutomaticRetentionReadCount(initialOfferRequests, {
      expectedFailure: true,
    });
    expect(expectedHttpFailureCount(harness, "/api/v1/retention-offers")).toBe(
      initialOfferRequests,
    );

    harness.allowOffersRetry();
    await page
      .getByRole("button", { name: "Check again", exact: true })
      .click();
    await expect(page.getByText("259", { exact: true }).first()).toBeVisible();
    await expect(
      page.getByText("Counts are event rows, not unique customers.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(requestCount(harness, "/api/v1/retention-offers")).toBe(
      initialOfferRequests + 1,
    );
    expect(await retentionAxeViolations(page)).toEqual([]);
    await page.locator(".rhs-summary").scrollIntoViewIfNeeded();
    await captureRetentionEvidence(
      page,
      testInfo,
      "retention-offers-retry-recovered",
      harness,
    );

    expect(harness.expectedNetworkErrors).toHaveLength(initialOfferRequests);
    await expectRetentionSafety(page, harness);
  });

  test("optional tier-name and win-back failures preserve rows and disclose unknowns", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openRetentionHistory(
      page,
      bootApp,
      setTheme,
      testInfo,
      { mode: "optional-errors", theme: "dark" },
    );

    await expect(
      page.getByText(
        "Tier names are unavailable. Opaque tier references remain visible without blocking offer history.",
        { exact: true },
      ),
    ).toBeVisible();
    await page.getByRole("tab", { name: /Offer history/u }).click();
    const optionalHistoryRow = page.getByText("Keep the founder rate", {
      exact: true,
    });
    await expect(optionalHistoryRow).toBeVisible();
    await expect(
      page.getByText("Tier 30000000…0001", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Founders", { exact: true })).toHaveCount(0);
    expect(await retentionAxeViolations(page)).toEqual([]);
    await optionalHistoryRow.scrollIntoViewIfNeeded();
    await captureRetentionEvidence(
      page,
      testInfo,
      "retention-optional-reads-history",
      harness,
    );

    await page.getByRole("tab", { name: /Readiness/u }).click();
    const optionalSettingsUnknown = page.getByText(
      "Stored settings could not be verified.",
      {
        exact: true,
      },
    );
    await expect(optionalSettingsUnknown).toBeVisible();
    await expect(
      page.getByText(
        "No default state is inferred while this resource is unknown.",
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    await expect(page.getByText("Enabled", { exact: true })).toHaveCount(0);
    expect(await retentionAxeViolations(page)).toEqual([]);
    await optionalSettingsUnknown.scrollIntoViewIfNeeded();
    await captureRetentionEvidence(
      page,
      testInfo,
      "retention-optional-reads-readiness",
      harness,
    );

    const tierRequests = requestCount(harness, "/api/v1/paywall/tiers");
    const winbackRequests = requestCount(
      harness,
      "/api/v1/retention-offers/winback-settings",
    );
    expectAutomaticRetentionReadCount(tierRequests, {
      expectedFailure: true,
    });
    expectAutomaticRetentionReadCount(winbackRequests, {
      expectedFailure: true,
    });
    expect(expectedHttpFailureCount(harness, "/api/v1/paywall/tiers")).toBe(
      tierRequests,
    );
    expect(
      expectedHttpFailureCount(
        harness,
        "/api/v1/retention-offers/winback-settings",
      ),
    ).toBe(winbackRequests);
    expect(harness.expectedNetworkErrors).toHaveLength(
      tierRequests + winbackRequests,
    );
    await expectRetentionSafety(page, harness);
  });

  test("failed supporting refreshes retain verified rows and disclose every stale source", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openRetentionHistory(
      page,
      bootApp,
      setTheme,
      testInfo,
      { mode: "stale-refresh", theme: "dark" },
    );
    await page.getByRole("tab", { name: /Offer history/u }).click();
    await expect(
      page.getByText("Keep the founder rate", { exact: true }),
    ).toBeVisible();

    harness.beginStaleSupportingFailure();
    await page
      .getByRole("button", { name: "Refresh records", exact: true })
      .click();

    for (const warning of [
      "Funnel refresh failed.",
      "Tier-name refresh failed.",
      "Stored-setting refresh failed.",
    ]) {
      await expect(page.getByText(warning, { exact: true })).toBeVisible();
    }
    for (const source of ["Funnel", "Tier names", "Stored settings"]) {
      await expect(
        page.locator(".rhs-provenance > span").filter({
          hasText: new RegExp(`^${source} .+ · stale$`, "u"),
        }),
      ).toHaveCount(1);
    }
    await expect(
      page.getByText("Keep the founder rate", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Paired refresh incomplete.", { exact: true }),
    ).toBeVisible();
    await expect(
      page
        .locator(".rhs-support-notice")
        .filter({ hasText: "Paired refresh incomplete." }),
    ).toContainText(
      "Offer rows remain inspectable, but funnel joins, row evidence, totals, and rates are unknown until both critical reads verify in one refresh attempt.",
    );
    await expect(page.getByText("128", { exact: true })).toHaveCount(0);
    expect(await retentionAxeViolations(page)).toEqual([]);
    await page
      .getByText("Funnel refresh failed.", { exact: true })
      .scrollIntoViewIfNeeded();
    await captureRetentionEvidence(
      page,
      testInfo,
      "retention-supporting-reads-stale",
      harness,
    );

    const expectedFailures = harness.expectedHttpFailures.length;
    expect(expectedFailures).toBeGreaterThanOrEqual(6);
    await expect
      .poll(() => harness.expectedNetworkErrors.length)
      .toBe(expectedFailures);
    await expectRetentionSafety(page, harness);
  });

  test("viewer/editor authority blocks the route before any retention read", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openRetentionHistory(
      page,
      bootApp,
      setTheme,
      testInfo,
      { mode: "editor", theme: "dark" },
    );
    await expect(
      page
        .getByLabel("Retention history content")
        .getByText("This destination requires the admin role.", {
          exact: false,
        }),
    ).toBeVisible();
    expect(harness.requests).toEqual([]);
    await captureRetentionEvidence(
      page,
      testInfo,
      "retention-editor-denied",
      harness,
    );
    await expectRetentionSafety(page, harness);
  });
});
