import {
  DMARC_HEALTHY_DOMAIN,
  DMARC_PRIMARY_SOURCE,
  DMARC_RISKY_DOMAIN,
  auditDmarcA11y,
  captureDmarcEvidence,
  expectDmarcForcedColors,
  expectDmarcReducedMotion,
  expectDmarcSafety,
  expectNoDmarcOverflow,
  openDmarc,
  resetDmarcScroll,
  scrollDmarcTargetIntoFrame,
} from "./dmarc-evidence-harness";
import { expect, test } from "../visual/fixture";

const SOURCE_DIALOG_SELECTOR = ".dmarc-detail-slideover";

test.describe("DMARC maturity evidence", () => {
  test("risky overview communicates bounded truth and exposes keyboard-complete source evidence", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openDmarc(page, bootApp, setTheme);

    await expect(
      page.getByRole("heading", { name: "DMARC reports", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("complementary", {
        name: "How to interpret DMARC evidence",
      }),
    ).toContainText("inbox placement");
    const summary = page.getByRole("region", {
      name: "Validated DMARC aggregate summary",
    });
    await expect(summary).toContainText("78.8%");
    await expect(summary).toContainText("31,500 of 40,000 messages");
    await expect(
      summary.getByRole("img", { name: /1,000 unknown/u }),
    ).toBeVisible();
    await expect(summary).toContainText("742 reports");
    await expect(
      page.getByRole("heading", { name: "Multiple-domain scope", level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Tenant-wide views can combine several domains and policies.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("table", {
        name: "Highest-volume sources needing investigation",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "30 days", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");

    expect(await auditDmarcA11y(page, harness, "risky-overview")).toEqual([]);
    await expectNoDmarcOverflow(page);
    await captureDmarcEvidence(
      page,
      testInfo,
      "dmarc-risky-overview-dark",
      harness,
    );

    await page.getByRole("tab", { name: /^Sources/u }).click();
    await expect(page.getByText("Partial ranking", { exact: true })).toBeVisible();

    const opener = page.getByRole("button", {
      name: `Open aggregate evidence for source ${DMARC_PRIMARY_SOURCE}`,
      exact: true,
    });
    await opener.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: DMARC_PRIMARY_SOURCE,
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Source evidence");
    await expect(dialog).toContainText("8,000");
    await expect(dialog).toContainText("Per-report breakdown");
    await expect(
      dialog.getByRole("region", {
        name: "Per-report source contributions",
      }),
    ).toBeVisible();
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
    expect(
      await auditDmarcA11y(
        page,
        harness,
        "risky-source-detail",
        SOURCE_DIALOG_SELECTOR,
      ),
    ).toEqual([]);
    await expectNoDmarcOverflow(page);
    await captureDmarcEvidence(
      page,
      testInfo,
      "dmarc-risky-source-detail-dark",
      harness,
    );

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expectDmarcSafety(page, harness);
    expect(
      harness.dmarcReads.filter(
        ({ pathname }) =>
          pathname === "/api/v1/deliverability/dmarc-sources",
      ),
    ).toHaveLength(1);
  });

  test("reports workspace preserves filters, provenance, safe detail, and saved or cancelled CSV semantics", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openDmarc(page, bootApp, setTheme);
    const reportsTab = page.getByRole("tab", { name: /^Reports/u });
    await reportsTab.focus();
    await page.keyboard.press("Space");
    await expect(reportsTab).toHaveAttribute("aria-selected", "true");

    const table = page.getByRole("table", {
      name: "DMARC aggregate report receipts",
    });
    await expect(
      page.getByRole("heading", { name: "500 of 742 reports loaded" }),
    ).toBeVisible();
    await expect(table.getByRole("row")).toHaveCount(501);
    await expect(page.getByText("Partial list", { exact: true })).toBeVisible();
    await expect(
      page.getByText("This list and export are partial", { exact: true }),
    ).toBeVisible();

    const alignedFilter = page.getByRole("button", {
      name: "Fully aligned",
      exact: true,
    });
    await alignedFilter.click();
    await expect(alignedFilter).toHaveAttribute("aria-pressed", "true");
    await expect(table.getByRole("row")).toHaveCount(2);
    await expect(table).toContainText("Deterministic Receiver 001");
    await expect(table).not.toContainText("Deterministic Receiver 002");

    await page
      .getByRole("button", { name: "All loaded", exact: true })
      .click();
    const search = page.getByRole("searchbox", {
      name: "Find a loaded report",
      exact: true,
    });
    await search.fill("webservice");
    await expect(table.getByRole("row")).toHaveCount(2);
    await expect(table).toContainText("+SUM(1,1)");

    const reportOpener = page.getByRole("button", {
      name: /report from \+SUM\(1,1\) for northstar\.example$/u,
    });
    await reportOpener.click();
    const dialog = page.getByRole("dialog", {
      name: DMARC_RISKY_DOMAIN,
      exact: true,
    });
    await expect(dialog).toContainText("Validated report receipt");
    await expect(dialog).toContainText(
      '=WEBSERVICE("https://attacker.invalid")',
    );
    await expect(dialog).toContainText(
      "da100000-0000-4000-8000-000000000001",
    );
    await expect(dialog).toContainText("not a live DNS observation");
    expect(
      await auditDmarcA11y(
        page,
        harness,
        "report-detail",
        SOURCE_DIALOG_SELECTOR,
      ),
    ).toEqual([]);
    await expectNoDmarcOverflow(page);
    await captureDmarcEvidence(
      page,
      testInfo,
      "dmarc-report-detail-dark",
      harness,
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(reportOpener).toBeFocused();
    expect(await auditDmarcA11y(page, harness, "reports-workspace")).toEqual(
      [],
    );

    const exportButton = page.getByRole("button", {
      name: "Export 1 loaded row",
      exact: true,
    });
    await exportButton.click();
    await expect(
      page.getByText("CSV saved with its evidence receipt.", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => harness.exports.length).toBe(1);
    const saved = harness.exports[0];
    expect(saved).toBeDefined();
    expect(saved?.path).toBe("/deterministic/dmarc-evidence.csv");
    expect(saved?.byteLength).toBeGreaterThan(300);
    expect(saved?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(saved?.content).toMatch(
      /^export_created_at,snapshot_generated_at,scope_domain,scope_from,scope_to,scope_window_days,local_filter,local_query,scope_total_reports,partial_export,stale_snapshot,postwave_receipt_id,/u,
    );
    expect(saved?.content).toContain(
      "2026-08-03T08:30:00.000Z,2026-08-03T08:30:00.000Z,,2026-07-04T08:30:00.000Z,2026-08-03T08:30:00.000Z,30,all,webservice,742,true,false,da100000-0000-4000-8000-000000000001",
    );
    expect(saved?.content).not.toContain("# export_");
    expect(saved?.content).toContain("'+SUM");
    expect(saved?.content).toContain(
      "'=WEBSERVICE(\"\"https://attacker.invalid\"\")",
    );
    expect(saved?.content).not.toMatch(/(?:^|,)\+SUM\(/mu);
    expect(saved?.content).not.toMatch(/(?:^|,)=WEBSERVICE\(/mu);
    expect(harness.nativeCalls.map(({ command }) => command)).toEqual([
      "plugin:dialog|save",
      "transfer_begin_save",
      "transfer_write_chunk",
      "transfer_finish_save",
    ]);
    await scrollDmarcTargetIntoFrame(
      page,
      page.locator(".dmarc-export-receipt"),
      180,
    );
    await captureDmarcEvidence(
      page,
      testInfo,
      "dmarc-export-saved-dark",
      harness,
    );

    harness.setSaveMode("cancelled");
    await exportButton.click();
    await expect(
      page.getByText("Export cancelled; no destination was written.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(harness.exports).toHaveLength(1);
    expect(harness.nativeCalls.at(-1)?.command).toBe("plugin:dialog|save");
    await captureDmarcEvidence(
      page,
      testInfo,
      "dmarc-export-cancelled-dark",
      harness,
    );

    await expectNoDmarcOverflow(page);
    await expectDmarcSafety(page, harness);
  });

  test("healthy light-theme scope selection exposes one domain policy without implying live DNS", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openDmarc(page, bootApp, setTheme, {
      mode: "healthy",
      theme: "light",
    });

    await expect(
      page
        .getByRole("region", { name: "Validated DMARC aggregate summary" })
        .getByRole("heading", { name: "99.90%", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Multiple-domain scope", level: 2 }),
    ).toBeVisible();
    const domainInput = page.getByLabel("Sending domain", { exact: true });
    await domainInput.fill("not a hostname");
    await expect(domainInput).toHaveAttribute("aria-invalid", "true");
    await expect(
      page.getByRole("button", { name: "Apply", exact: true }),
    ).toBeDisabled();
    await domainInput.fill(DMARC_HEALTHY_DOMAIN.toUpperCase());
    await page.getByRole("button", { name: "Apply", exact: true }).click();

    await expect(domainInput).toHaveValue(DMARC_HEALTHY_DOMAIN);
    await expect(
      page.getByRole("heading", { name: "p=reject", level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByText("This value came from the latest aggregate report", {
        exact: false,
      }),
    ).toBeVisible();
    const scopeReceipts = page.locator(".dmarc-scope__receipt");
    await expect(scopeReceipts).toHaveCount(2);
    await expect(scopeReceipts.nth(0)).toContainText(
      "Contract-valid insights snapshot",
    );
    await expect(scopeReceipts.nth(1)).toContainText(
      "Contract-valid report-list snapshot",
    );
    expect(await auditDmarcA11y(page, harness, "healthy-domain-light")).toEqual(
      [],
    );
    await expectNoDmarcOverflow(page);
    await captureDmarcEvidence(
      page,
      testInfo,
      "dmarc-healthy-domain-light",
      harness,
    );
    await page.getByRole("tab", { name: /^Reports/u }).click();
    await expect(
      page.getByRole("heading", { name: "1 of 1 report loaded" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Export 1 loaded row", exact: true }),
    ).toBeEnabled();
    await expectDmarcSafety(page, harness);
    expect(
      harness.dmarcReads.some(
        ({ search }) => search.includes(`domain=${DMARC_HEALTHY_DOMAIN}`),
      ),
    ).toBe(true);
  });

  test("zero state preserves an unknown denominator and disables empty exports", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openDmarc(page, bootApp, setTheme, {
      mode: "zero",
      theme: "light",
    });
    await expect(
      page.getByRole("heading", {
        name: "No aggregate reports were ingested in this evidence window.",
      }),
    ).toBeVisible();
    const zeroSummary = page.getByRole("region", {
      name: "Validated DMARC aggregate summary",
    });
    await expect(zeroSummary).toBeVisible();
    await expect(zeroSummary).toContainText(
      "No message denominator exists for this validated scope",
    );
    await expect(zeroSummary).not.toContainText(/\b(?:0|100)(?:\.0+)?%\b/u);

    await page.getByRole("tab", { name: /^Reports/u }).click();
    await expect(
      page.getByText("No aggregate reports were returned for this validated scope."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Export 0 loaded rows", exact: true }),
    ).toBeDisabled();
    expect(await auditDmarcA11y(page, harness, "verified-zero")).toEqual([]);
    await expectNoDmarcOverflow(page);
    await captureDmarcEvidence(
      page,
      testInfo,
      "dmarc-verified-zero-light",
      harness,
    );
    await expectDmarcSafety(page, harness);
  });

  test("report receipts remain usable when aggregate insights fail independently", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openDmarc(page, bootApp, setTheme, {
      mode: "reports-ok-insights-500",
    });
    await expect(
      page.getByText("Aggregate insights could not be refreshed", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "1 report receipt available; aggregate insights are unavailable",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Overview unavailable" })).toBeVisible();
    await page.getByRole("tab", { name: /^Reports/u }).click();
    await expect(
      page.getByRole("table", { name: "DMARC aggregate report receipts" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "1 of 1 report loaded" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Export 1 loaded row", exact: true }),
    ).toBeEnabled();
    expect(harness.expectedHttpFailures).toHaveLength(3);
    expect(
      harness.expectedHttpFailures.every(
        ({ pathname, status }) =>
          pathname === "/api/v1/deliverability/dmarc-insights" && status === 500,
      ),
    ).toBe(true);
    expect(await auditDmarcA11y(page, harness, "insights-failure")).toEqual([]);
    await expectNoDmarcOverflow(page);
    await captureDmarcEvidence(
      page,
      testInfo,
      "dmarc-insights-failure-reports-intact-dark",
      harness,
    );
    await expectDmarcSafety(page, harness);
  });

  test("aggregate insights remain usable when report receipts fail independently", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openDmarc(page, bootApp, setTheme, {
      mode: "reports-500-insights-ok",
    });
    await expect(
      page.getByText("Report receipts could not be refreshed", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Validated DMARC aggregate summary" }),
    ).toBeVisible();
    await page.getByRole("tab", { name: /^Reports/u }).click();
    await expect(
      page.getByRole("heading", { name: "Report receipts unavailable" }),
    ).toBeVisible();
    await expect(page.locator(".dmarc-reports-table")).toHaveCount(0);
    expect(harness.expectedHttpFailures).toHaveLength(3);
    expect(
      harness.expectedHttpFailures.every(
        ({ pathname, status }) =>
          pathname === "/api/v1/deliverability/dmarc-reports" && status === 500,
      ),
    ).toBe(true);
    expect(await auditDmarcA11y(page, harness, "reports-failure")).toEqual([]);
    await expectNoDmarcOverflow(page);
    await captureDmarcEvidence(
      page,
      testInfo,
      "dmarc-reports-failure-insights-intact-dark",
      harness,
    );
    await expectDmarcSafety(page, harness);
  });

  test("malformed contracts fail closed without leaking diagnostics or false metrics", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openDmarc(page, bootApp, setTheme, {
      mode: "malformed-main",
    });
    await expect(
      page.getByText("Report receipts response withheld", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Aggregate insights response withheld", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".dmarc-health-cards")).toHaveCount(0);
    await expect(page.locator(".dmarc-reports-table")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(
      "dmarc-server-secret-must-never-reach-the-renderer",
    );
    expect(await auditDmarcA11y(page, harness, "malformed-contract")).toEqual([]);
    await expectNoDmarcOverflow(page);
    await captureDmarcEvidence(
      page,
      testInfo,
      "dmarc-malformed-contract-dark",
      harness,
    );
    await expectDmarcSafety(page, harness);
  });

  test("latest scope wins while superseded thirty-day reads are aborted", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openDmarc(page, bootApp, setTheme, {
      mode: "stale-race",
    });
    await expect(
      page.getByRole("status").filter({ hasText: "Loading aggregate evidence" }),
    ).toBeVisible();
    await captureDmarcEvidence(
      page,
      testInfo,
      "dmarc-stale-race-loading-dark",
      harness,
    );

    const sevenDays = page.getByRole("button", {
      name: "7 days",
      exact: true,
    });
    await sevenDays.click();
    await expect(sevenDays).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("777 messages", { exact: false }).first()).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Validated DMARC aggregate summary" }),
    ).toContainText("7 reports");
    harness.releaseInitialRace();
    await page.waitForTimeout(150);
    await expect(sevenDays).toHaveAttribute("aria-pressed", "true");
    await expect(
      page.getByRole("region", { name: "Validated DMARC aggregate summary" }),
    ).toContainText("777");
    await expect.poll(() => harness.apiAborts.length).toBeGreaterThanOrEqual(2);
    expect(await auditDmarcA11y(page, harness, "latest-scope-wins")).toEqual([]);
    await expectNoDmarcOverflow(page);
    await captureDmarcEvidence(
      page,
      testInfo,
      "dmarc-stale-race-latest-wins-dark",
      harness,
    );
    await expectDmarcSafety(page, harness);
  });

  test("narrow reduced-motion and forced-color modes retain complete semantics", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    await page.emulateMedia({
      forcedColors: "none",
      reducedMotion: "reduce",
    });
    const harness = await openDmarc(page, bootApp, setTheme, {
      width: 400,
      height: 820,
    });
    await resetDmarcScroll(page);
    await expectNoDmarcOverflow(page);
    await expectDmarcReducedMotion(page);
    expect(await auditDmarcA11y(page, harness, "narrow-reduced-motion")).toEqual(
      [],
    );
    await captureDmarcEvidence(
      page,
      testInfo,
      "dmarc-narrow-reduced-motion-dark",
      harness,
    );

    await page.setViewportSize({ width: 1_000, height: 820 });
    await page.emulateMedia({
      forcedColors: "active",
      reducedMotion: "reduce",
    });
    await resetDmarcScroll(page);
    await expectNoDmarcOverflow(page);
    await expectDmarcReducedMotion(page);
    expect(
      await auditDmarcA11y(page, harness, "forced-colors", ".dmarc-page", {
        includeColorContrast: false,
      }),
    ).toEqual([]);
    await expectDmarcForcedColors(page);
    await captureDmarcEvidence(
      page,
      testInfo,
      "dmarc-forced-colors-dark",
      harness,
    );
    await expectDmarcSafety(page, harness);
  });
});
