import {
  PENDING_DOMAIN_NAME,
  captureCustomDomainsEvidence,
  customDomainsAxeViolations,
  expectCustomDomainsForcedColors,
  expectCustomDomainsSafety,
  expectNoCustomDomainsOverflow,
  openCustomDomains,
  resetCustomDomainsScroll,
  scrollCustomDomainsTargetIntoFrame,
} from "./custom-domains-evidence-harness";
import { expect, test } from "../visual/fixture";

test.describe("Custom Domains maturity evidence", () => {
  test("populated registry is semantic, keyboard-complete, responsive, and permits one explicit verification", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openCustomDomains(page, bootApp, setTheme);

    await expect(
      page.getByRole("heading", { name: "Branded domains", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Know what is proven." }),
    ).toBeVisible();
    await expect(page.locator(".cd-kicker")).toContainText(
      "Evidence, not activation",
    );
    await expect(
      page.getByRole("button", { name: "Register hostname", exact: true }),
    ).toBeDisabled();

    await expect(
      page.locator(".cd-metric").filter({ hasText: "Registered" }),
    ).toContainText("3");
    await expect(
      page.locator(".cd-metric").filter({ hasText: "Latest check passed" }),
    ).toContainText("1");
    await expect(
      page.locator(".cd-metric").filter({ hasText: "Needs DNS" }),
    ).toContainText("2");

    const table = page.getByRole("table", {
      name: "Registered custom hostnames and DNS ownership evidence",
    });
    await expect(table.getByRole("columnheader")).toHaveCount(6);
    await expect(table.getByRole("row")).toHaveCount(4);
    await expect(
      page.getByRole("status").filter({ hasText: "Showing 3 of 3" }),
    ).toBeAttached();
    expect(await customDomainsAxeViolations(page)).toEqual([]);
    await expectNoCustomDomainsOverflow(page);
    await captureCustomDomainsEvidence(
      page,
      testInfo,
      "custom-domains-populated-dark",
      harness,
    );

    const needsDnsFilter = page.getByRole("button", {
      name: /Needs DNS\s+2/u,
    });
    await needsDnsFilter.focus();
    await page.keyboard.press("Space");
    await expect(needsDnsFilter).toHaveAttribute("aria-pressed", "true");
    await expect(table.getByRole("row")).toHaveCount(3);
    await expect(
      page.getByRole("status").filter({ hasText: "Showing 2 of 3" }),
    ).toBeAttached();

    const allFilter = page.getByRole("button", { name: /All\s+3/u });
    await allFilter.focus();
    await page.keyboard.press("Space");
    await expect(allFilter).toHaveAttribute("aria-pressed", "true");
    await expect(table.getByRole("row")).toHaveCount(4);
    await expect(
      page.getByRole("combobox", { name: "Sort", exact: true }),
    ).toHaveValue("newest");

    const opener = page.getByRole("button", {
      name: `Open DNS ownership details for ${PENDING_DOMAIN_NAME}`,
      exact: true,
    });
    await opener.focus();
    await page.keyboard.press("Enter");

    const dialog = page.getByRole("dialog", {
      name: PENDING_DOMAIN_NAME,
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText("Ownership evidence only", { exact: true }),
    ).toBeVisible();
    await expect(dialog.getByText("Needs DNS", { exact: true })).toBeVisible();
    expect(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
    ).toBe(true);
    expect(
      await customDomainsAxeViolations(page, ".cd-domain-slideover"),
    ).toEqual([]);
    await expectNoCustomDomainsOverflow(page);
    await captureCustomDomainsEvidence(
      page,
      testInfo,
      "custom-domains-pending-detail-dark",
      harness,
    );

    const verify = dialog.getByRole("button", {
      name: "Check DNS ownership",
      exact: true,
    });
    const chromeClose = dialog
      .getByRole("button", { name: "Close", exact: true })
      .first();
    await verify.focus();
    await page.keyboard.press("Tab");
    await expect(chromeClose).toBeFocused();

    const copyValue = dialog.getByRole("button", {
      name: "Copy value for CNAME record 1",
      exact: true,
    });
    await copyValue.click();
    await expect(copyValue).toContainText("Copied");
    await expect(
      dialog
        .getByRole("status")
        .filter({ hasText: "CNAME value copied to the clipboard." }),
    ).toBeAttached();
    await captureCustomDomainsEvidence(
      page,
      testInfo,
      "custom-domains-pending-detail-copied-dark",
      harness,
    );
    // Evidence capture may outlive the toast's own dwell timer. Either an
    // explicit dismissal or the documented auto-dismiss reaches the same
    // clean pre-verification state.
    await page
      .getByRole("button", {
        name: "Dismiss notification: CNAME value copied",
        exact: true,
      })
      .click({ timeout: 1_000 })
      .catch(() => undefined);
    await expect(page.locator(".toast")).toHaveCount(0);

    harness.armVerification();
    await verify.click();
    await expect.poll(() => harness.verificationMutations.length).toBe(1);
    await expect(dialog).toHaveAttribute("aria-busy", "true");
    await expect(
      dialog.getByRole("button", { name: "Checking DNS…", exact: true }),
    ).toBeVisible();
    await captureCustomDomainsEvidence(
      page,
      testInfo,
      "custom-domains-verification-in-flight-dark",
      harness,
    );

    harness.releaseVerification();
    await expect(
      dialog.getByText("Last check passed", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", {
        name: "Check ownership again",
        exact: true,
      }),
    ).toBeVisible();
    await expect(dialog).not.toHaveAttribute("aria-busy", "true");
    await expect(
      page.getByText("DNS ownership confirmed", { exact: true }),
    ).toBeVisible();
    await captureCustomDomainsEvidence(
      page,
      testInfo,
      "custom-domains-verified-transition-dark",
      harness,
    );
    expect(
      await customDomainsAxeViolations(page, ".cd-domain-slideover"),
    ).toEqual([]);
    await expectNoCustomDomainsOverflow(page);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(
      page.locator(".cd-metric").filter({ hasText: "Latest check passed" }),
    ).toContainText("2");
    await expect(
      page.locator(".cd-metric").filter({ hasText: "Needs DNS" }),
    ).toContainText("1");

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const dismissals = page.locator(".toast-dismiss");
      if ((await dismissals.count()) === 0) break;
      await dismissals.first().click();
    }
    await expect(page.locator(".toast")).toHaveCount(0);

    await page.setViewportSize({ width: 400, height: 820 });
    await page.emulateMedia({
      forcedColors: "none",
      reducedMotion: "reduce",
    });
    await resetCustomDomainsScroll(page);
    await expectNoCustomDomainsOverflow(page);
    expect(await customDomainsAxeViolations(page)).toEqual([]);
    await captureCustomDomainsEvidence(
      page,
      testInfo,
      "custom-domains-populated-narrow-reduced-motion",
      harness,
    );

    await page.setViewportSize({ width: 1_000, height: 820 });
    await page.emulateMedia({
      forcedColors: "active",
      reducedMotion: "reduce",
    });
    await resetCustomDomainsScroll(page);
    await expectNoCustomDomainsOverflow(page);
    expect(
      await customDomainsAxeViolations(page, ".custom-domains-route", {
        includeColorContrast: false,
      }),
    ).toEqual([]);
    await expectCustomDomainsForcedColors(page);
    await captureCustomDomainsEvidence(
      page,
      testInfo,
      "custom-domains-populated-forced-colors",
      harness,
    );
    await expectCustomDomainsSafety(page, harness, {
      expectedVerifications: 1,
    });
  });

  test("populated registry has a complete light-theme evidence state", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openCustomDomains(page, bootApp, setTheme, {
      theme: "light",
    });

    await expect(
      page.getByText("Latest check passed for every row", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("1 of 3 latest checks passed", { exact: true }),
    ).toBeVisible();
    expect(await customDomainsAxeViolations(page)).toEqual([]);
    await expectNoCustomDomainsOverflow(page);
    await captureCustomDomainsEvidence(
      page,
      testInfo,
      "custom-domains-populated-light",
      harness,
    );
    await expectCustomDomainsSafety(page, harness);
  });

  test("empty registry reports a truthful zero-state without inventing availability", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openCustomDomains(page, bootApp, setTheme, {
      mode: "empty",
      theme: "light",
    });

    await expect(
      page.getByText("No registrations", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Registration unavailable", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Register hostname", exact: true }),
    ).toBeDisabled();
    const emptyState = page.locator(".cd-empty-state");
    await scrollCustomDomainsTargetIntoFrame(page, emptyState);
    expect(await customDomainsAxeViolations(page)).toEqual([]);
    await expectNoCustomDomainsOverflow(page);
    await captureCustomDomainsEvidence(
      page,
      testInfo,
      "custom-domains-empty-registry-light",
      harness,
    );
    await expectCustomDomainsSafety(page, harness);
  });

  test("request failure remains explicit, retryable, and free of leaked diagnostics", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openCustomDomains(page, bootApp, setTheme, {
      mode: "request-failure",
    });

    await expect(
      page.getByRole("heading", {
        name: "The domain registry could not be reached.",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("No zero counts or empty state are being inferred.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retry registry", exact: true }),
    ).toBeVisible();
    expect(harness.expectedHttpFailures.length).toBeGreaterThanOrEqual(1);
    const errorState = page.locator(".cd-error-surface");
    await scrollCustomDomainsTargetIntoFrame(page, errorState);
    expect(await customDomainsAxeViolations(page)).toEqual([]);
    await expectNoCustomDomainsOverflow(page);
    await captureCustomDomainsEvidence(
      page,
      testInfo,
      "custom-domains-request-failure-dark",
      harness,
    );
    await expectCustomDomainsSafety(page, harness);
  });

  test("malformed list contract fails closed instead of presenting false registry truth", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openCustomDomains(page, bootApp, setTheme, {
      mode: "malformed-contract",
    });

    await expect(
      page.getByRole("heading", {
        name: "This response cannot be displayed safely.",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Moosewave rejected an unexpected server payload", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(page.locator(".cd-metrics")).toHaveCount(0);
    await expect(page.locator(".cd-table")).toHaveCount(0);
    const contractState = page.locator(".cd-error-surface");
    await scrollCustomDomainsTargetIntoFrame(page, contractState);
    expect(await customDomainsAxeViolations(page)).toEqual([]);
    await expectNoCustomDomainsOverflow(page);
    await captureCustomDomainsEvidence(
      page,
      testInfo,
      "custom-domains-malformed-contract-dark",
      harness,
    );
    await expectCustomDomainsSafety(page, harness);
  });
});
