import {
  captureDeliverabilityEvidence,
  deliverabilityAxeViolations,
  expectDeliverabilitySafety,
  expectNoDeliverabilityOverflow,
  expectVerificationReadLedger,
  openDeliverabilityHub,
  positionDeliverabilityActiveTab,
  scrollDeliverabilityTargetIntoFrame,
  scrollDeliverabilityWorkspaceIntoView,
} from "./deliverability-hub-evidence-harness";
import { expect, test } from "../visual/fixture";

test.describe("Deliverability Hub maturity", () => {
  test("qualified evidence is keyboard-complete, route-persistent, accessible, and contained", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openDeliverabilityHub(page, bootApp, setTheme);
    await expect(
      page.getByText(
        "Couldn't load your saved Dashboard layout. The default layout is shown.",
        { exact: true },
      ),
    ).toHaveCount(0);

    await expect(
      page.getByRole("heading", {
        name: "Protect every send before reputation pays the price.",
      }),
    ).toBeVisible();
    await expect(page.getByText("92", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Healthy", { exact: true })).toBeVisible();
    await expect(page.getByText("Up 2 points", { exact: true })).toBeVisible();
    expect(await deliverabilityAxeViolations(page)).toEqual([]);
    await expectNoDeliverabilityOverflow(page);
    await captureDeliverabilityEvidence(
      page,
      testInfo,
      "deliverability-qualified-overview-dark",
      harness,
    );

    const overview = page.getByRole("tab", { name: /Overview/u });
    const identity = page.getByRole("tab", { name: /Identity & providers/u });
    const diagnostics = page.getByRole("tab", { name: /Diagnostics/u });
    const verification = page.getByRole("tab", { name: /Verification/u });
    await overview.focus();
    await page.keyboard.press("ArrowRight");
    await expect(identity).toBeFocused();
    await expect(overview).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await expect(verification).toBeFocused();
    await expect(overview).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(overview).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(identity).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(identity).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("tab"))
      .toBe("identity");
    await expect(
      page.getByRole("heading", { name: "Identity and provider health" }),
    ).toBeVisible();
    await expect(
      page.getByText("mail.example.test", { exact: true }),
    ).toBeVisible();
    expect(await deliverabilityAxeViolations(page)).toEqual([]);
    await expectNoDeliverabilityOverflow(page);
    await scrollDeliverabilityWorkspaceIntoView(page);
    await captureDeliverabilityEvidence(
      page,
      testInfo,
      "deliverability-qualified-identity-dark",
      harness,
    );

    const controls = page.getByRole("tab", { name: /Sending controls/u });
    await controls.click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("tab"))
      .toBe("controls");
    await expect(
      page.getByRole("heading", { name: "Sending guardrails" }),
    ).toBeVisible();
    await expect(
      page.getByText("Deliverability controls", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No configured plan returned", { exact: true }),
    ).toBeVisible();
    expect(await deliverabilityAxeViolations(page)).toEqual([]);
    await expectNoDeliverabilityOverflow(page);
    const controlsLeadCard = page
      .locator(
        '.dhw-panel:not([hidden]) .dhw-control-evidence:has-text("Domain warmup plans")',
      )
      .first();
    await scrollDeliverabilityTargetIntoFrame(page, controlsLeadCard);
    await expect(
      page.getByRole("heading", { name: "Domain warmup plans" }),
    ).toBeInViewport();
    await captureDeliverabilityEvidence(
      page,
      testInfo,
      "deliverability-qualified-controls-dark",
      harness,
    );

    const recovery = page.getByRole("tab", { name: /Recovery/u });
    await recovery.click();
    await expect(
      page.getByRole("heading", { name: "Failure evidence and repair" }),
    ).toBeVisible();
    await expect(
      page.getByText("No deferred recipient event is recorded.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(await deliverabilityAxeViolations(page)).toEqual([]);
    await expectNoDeliverabilityOverflow(page);
    const recoveryLeadCard = page
      .locator('.dhw-panel:not([hidden]) .card:has-text("Spam-trap guard")')
      .first();
    await scrollDeliverabilityTargetIntoFrame(page, recoveryLeadCard);
    await expect(
      page.getByRole("heading", { name: "Spam-trap guard" }),
    ).toBeInViewport();
    await captureDeliverabilityEvidence(
      page,
      testInfo,
      "deliverability-qualified-recovery-dark",
      harness,
    );

    await diagnostics.click();
    await expect(
      page.getByRole("heading", { name: "Placement diagnostics" }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: /August product update/u }).first(),
    ).toBeAttached();
    // Axe must inspect the settled panel, not a transient alpha frame from the
    // 220 ms entrance animation or the deliberately dimmed loading control.
    await expect(
      page.getByRole("tabpanel", { name: /Diagnostics/u }),
    ).toHaveCSS("opacity", "1");
    await expect(
      page.getByLabel("Campaign for ISP breakdown", { exact: true }),
    ).toBeEnabled();
    expect(await deliverabilityAxeViolations(page)).toEqual([]);
    await expectNoDeliverabilityOverflow(page);
    const diagnosticsLeadCard = page
      .locator('.dhw-panel:not([hidden]) .card:has-text("ISP breakdown")')
      .first();
    await scrollDeliverabilityTargetIntoFrame(page, diagnosticsLeadCard);
    await expect(
      page.getByText("ISP breakdown", { exact: true }).first(),
    ).toBeInViewport();
    await captureDeliverabilityEvidence(
      page,
      testInfo,
      "deliverability-qualified-diagnostics-dark",
      harness,
    );
    const diagnosticsURL = new URL(page.url()).toString();

    await verification.click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("tab"))
      .toBe("verification");
    const verificationPanel = page.getByRole("tabpanel", {
      name: /Verification/u,
    });
    await expect(
      page.getByRole("heading", { name: "Email verification" }),
    ).toBeVisible();
    await expect(
      verificationPanel.getByRole("heading", { name: "Verification provider" }),
    ).toBeVisible();
    await expect(
      verificationPanel.getByText("Connected", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("ZeroBounce", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByLabel("Public signup forms", { exact: true }),
    ).toHaveValue("local");
    await expect(page.getByLabel("Import commit", { exact: true })).toHaveValue(
      "off",
    );
    await expect(
      page.getByRole("heading", { name: "Credits and savings" }),
    ).toBeVisible();
    await expect(page.getByText("1,240", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Measured credits saved", { exact: true }).locator(".."),
    ).toContainText("1,060");
    await expect(
      page.getByText("New bulk runs are temporarily unavailable", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start verification" }),
    ).toHaveCount(0);
    const completedRun = page.getByRole("button", {
      name: /View completed verification run/u,
    });
    await expect(completedRun).toBeVisible();
    await completedRun.click();
    await expect(
      page.getByRole("heading", { name: "Run progress" }),
    ).toBeVisible();
    await expect(
      page.getByText("p••••••••@example.invalid", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("private.recipient@example.invalid", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText(
        "2 masked rows loaded. The latest page returned no additional row for this filter.",
        { exact: true },
      ),
    ).toBeVisible();
    expectVerificationReadLedger(harness);
    expect(await deliverabilityAxeViolations(page)).toEqual([]);
    await expectNoDeliverabilityOverflow(page);
    await scrollDeliverabilityWorkspaceIntoView(page);
    await expect(
      page.getByRole("heading", { name: "Email verification" }),
    ).toBeInViewport();
    await expect(
      verificationPanel.getByRole("heading", { name: "Verification provider" }),
    ).toBeInViewport();
    await captureDeliverabilityEvidence(
      page,
      testInfo,
      "deliverability-qualified-verification-dark",
      harness,
    );
    const verificationGateCard = verificationPanel
      .locator(".verification-bulk-workspace > .verification-card")
      .first();
    await scrollDeliverabilityTargetIntoFrame(page, verificationGateCard);
    await expect(
      page.getByText("New bulk runs are temporarily unavailable", {
        exact: true,
      }),
    ).toBeInViewport();
    await captureDeliverabilityEvidence(
      page,
      testInfo,
      "deliverability-qualified-verification-bulk-gate-dark",
      harness,
    );
    const maskedResults = verificationPanel.locator(".verification-results");
    await scrollDeliverabilityTargetIntoFrame(page, maskedResults);
    await expect(
      page.getByRole("heading", { name: "Masked result ledger" }),
    ).toBeInViewport();
    await expect(
      page.getByText("p••••••••@example.invalid", { exact: true }),
    ).toBeInViewport();
    await captureDeliverabilityEvidence(
      page,
      testInfo,
      "deliverability-qualified-verification-masked-results-dark",
      harness,
    );
    const verificationURL = new URL(page.url()).toString();

    await page.evaluate(() => window.history.back());
    await expect(diagnostics).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(diagnosticsURL);
    await page.evaluate(() => window.history.forward());
    await expect(verification).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(verificationURL);
    await page.reload();
    await expect(verification).toHaveAttribute("aria-selected", "true");
    await expect(
      page.getByRole("heading", { name: "Email verification" }),
    ).toBeVisible();

    await page.setViewportSize({ width: 400, height: 820 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const [name, heading] of [
      [/Overview/u, "Reputation at a glance"],
      [/Identity & providers/u, "Identity and provider health"],
      [/Sending controls/u, "Sending guardrails"],
      [/Recovery/u, "Failure evidence and repair"],
      [/Diagnostics/u, "Placement diagnostics"],
      [/Verification/u, "Email verification"],
    ] as const) {
      await page.getByRole("tab", { name }).click();
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      await expectNoDeliverabilityOverflow(page);
      expect(await deliverabilityAxeViolations(page)).toEqual([]);
    }
    await overview.click();
    await positionDeliverabilityActiveTab(page);
    await expectNoDeliverabilityOverflow(page);
    expect(await deliverabilityAxeViolations(page)).toEqual([]);
    const pageScroll = page.locator(".content");
    await pageScroll.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect
      .poll(() => pageScroll.evaluate((element) => element.scrollTop))
      .toBe(0);
    await captureDeliverabilityEvidence(
      page,
      testInfo,
      "deliverability-qualified-overview-narrow-reduced-motion",
      harness,
    );
    await verification.click();
    await page.emulateMedia({
      forcedColors: "active",
      reducedMotion: "reduce",
    });
    await positionDeliverabilityActiveTab(page);
    await expect(verification).toHaveAttribute("aria-selected", "true");
    await expectNoDeliverabilityOverflow(page);
    expect(await deliverabilityAxeViolations(page)).toEqual([]);
    await captureDeliverabilityEvidence(
      page,
      testInfo,
      "deliverability-qualified-verification-forced-colors",
      harness,
    );
    await expectDeliverabilitySafety(page, harness);
  });

  test("an under-sampled workspace never receives a score or grade verdict", async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openDeliverabilityHub(
      page,
      bootApp,
      setTheme,
      "unqualified",
      { theme: "light" },
    );

    await expect(
      page.getByText("Insufficient data", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("sample pending", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("N/A", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Rate sample is not qualified yet", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No qualified 7-day baseline", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No comparable samples yet", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Couldn't load your saved Dashboard layout. The default layout is shown.",
        { exact: true },
      ),
    ).toHaveCount(0);
    await expect(page.locator(".dhw-model .dhw-score-ring strong")).toHaveText(
      "—",
    );
    expect(await deliverabilityAxeViolations(page)).toEqual([]);
    await captureDeliverabilityEvidence(
      page,
      testInfo,
      "deliverability-unqualified-overview-light",
      harness,
    );
    await expectDeliverabilitySafety(page, harness);
  });

  test("a malformed score is contained without hiding independent DNS evidence", async ({
    page,
    bootApp,
    setTheme,
  }) => {
    const harness = await openDeliverabilityHub(
      page,
      bootApp,
      setTheme,
      "malformed-summary",
    );

    await expect(
      page.getByText("The current score could not be verified.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Inputs unavailable" }),
    ).toBeVisible();
    await page.getByRole("tab", { name: /Identity & providers/u }).click();
    await expect(
      page.getByText("mail.example.test", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Verified", { exact: true }).first(),
    ).toBeVisible();
    expect(await deliverabilityAxeViolations(page)).toEqual([]);
    await expectNoDeliverabilityOverflow(page);
    await expectDeliverabilitySafety(page, harness);
  });

  test("viewer access cannot initiate recipient-level or administrative mutations", async ({
    page,
    bootApp,
    setTheme,
  }) => {
    const harness = await openDeliverabilityHub(
      page,
      bootApp,
      setTheme,
      "viewer",
    );
    await page.getByRole("tab", { name: /Recovery/u }).click();
    await expect(
      page.getByText("Admin access required", { exact: false }),
    ).toBeVisible();
    expect(
      harness.requests.some((request) =>
        request.pathname.startsWith("/api/v1/feedback"),
      ),
    ).toBe(false);
    await page.getByRole("tab", { name: /Sending controls/u }).click();
    await expect(
      page.getByText(
        "Admin access is required to change this workspace policy.",
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Change policy/u }),
    ).toHaveCount(0);
    await page.getByRole("tab", { name: /Verification/u }).click();
    const verificationPanel = page.getByRole("tabpanel", {
      name: /Verification/u,
    });
    await expect(
      verificationPanel
        .getByText("Admin access required", { exact: true })
        .first(),
    ).toBeVisible();
    await expect(
      verificationPanel.getByText("Admin access required", { exact: true }),
    ).toHaveCount(2);
    expect(harness.verificationReads).toEqual([]);
    expect(harness.billableVerificationCreates).toEqual([]);
    expect(await deliverabilityAxeViolations(page)).toEqual([]);
    await expectNoDeliverabilityOverflow(page);
    await expectDeliverabilitySafety(page, harness);
  });
});
