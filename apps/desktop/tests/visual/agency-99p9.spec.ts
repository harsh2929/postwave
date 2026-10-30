import type { Locator, Page } from "@playwright/test";

import {
  attachAgencyEvidence,
  expectAgencyHarnessClean,
  expectNoAgencyHorizontalOverflow,
  openAgency,
  ROUTE47_DEMO_PROFILE,
  ROUTE47_DEMO_TENANT,
  ROUTE47_STANDARD_TENANT,
  saveAgencyEvidence,
  seriousAgencyAxeViolations,
} from "./agency-99p9-harness";
import { expect, test } from "./fixture";

function agencyTabs(page: Page): {
  list: Locator;
  children: Locator;
  branding: Locator;
  invoice: Locator;
} {
  const list = page.getByRole("tablist", { name: "Agency sections" });
  return {
    list,
    children: list.getByRole("tab", { name: "Sub-accounts", exact: true }),
    branding: list.getByRole("tab", { name: "Branding", exact: true }),
    invoice: list.getByRole("tab", {
      name: "Usage & invoices",
      exact: true,
    }),
  };
}

async function activate(
  page: Page,
  tab: Locator,
  heading: string,
): Promise<void> {
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: heading, exact: true }),
  ).toBeVisible();
}

async function clickVisibleHeldControls(page: Page): Promise<number> {
  const controls = page.locator("[data-agency-held-control]");
  let clicked = 0;
  for (let index = 0; index < (await controls.count()); index += 1) {
    const control = controls.nth(index);
    if (!(await control.isVisible())) continue;
    await expect(control).toHaveAttribute("aria-disabled", "true");
    await expect(control).toHaveAttribute("aria-describedby", /.+/u);
    await control.click();
    clicked += 1;
  }
  return clicked;
}

test.use({ locale: "en-US", timezoneId: "UTC" });
test.describe.configure({ timeout: 180_000 });

const profileLabel = ROUTE47_DEMO_PROFILE ? "demo" : "standard";

for (const theme of ["dark", "light"] as const) {
  test(`${profileLabel} roster is bounded and coherent at 1440 in ${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openAgency(page, bootApp, setTheme, {
      theme,
      width: 1_440,
      height: 960,
    });
    const table = page.getByRole("table", {
      name: /Loaded, verified sub-accounts/u,
    });
    await expect(table).toBeVisible();
    await expect(
      page.getByText("Loaded workspaces", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/not payer proof/u)).toBeVisible();
    await expect(
      page.getByText(/Counts are explicitly limited/u),
    ).toBeVisible();
    await expect(page.getByText(/portfolio total/iu)).toHaveCount(0);

    if (ROUTE47_DEMO_PROFILE) {
      await expect(table.locator("tbody tr")).toHaveCount(3);
      await expect(
        page.getByRole("button", { name: "Load next page" }),
      ).toHaveCount(0);
    } else {
      await expect(table.locator("tbody tr")).toHaveCount(2);
      await page.getByRole("button", { name: "Load next page" }).click();
      await expect(table.locator("tbody tr")).toHaveCount(3);
      await expect(
        page.getByText(/All 3 verified rows are loaded/u),
      ).toBeVisible();
    }

    expect(
      harness.requests.some((item) => item.pathname.includes("invoice")),
    ).toBe(false);
    await expectNoAgencyHorizontalOverflow(page);
    const axeViolations = await seriousAgencyAxeViolations(page);
    await expectAgencyHarnessClean(page, harness);
    expect(axeViolations).toEqual([]);

    await saveAgencyEvidence(
      page,
      testInfo,
      `agency-${profileLabel}-roster-${theme}-1440`,
    );
    await attachAgencyEvidence(
      testInfo,
      `agency-${profileLabel}-roster-${theme}-evidence`,
      harness,
      { axeViolations },
    );
  });
}

test(`${profileLabel} branding reflows at 390 under reduced motion`, async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const harness = await openAgency(page, bootApp, setTheme, {
    theme: "light",
    width: 390,
    height: 844,
  });
  await activate(
    page,
    agencyTabs(page).branding,
    "Audit portal branding record",
  );

  const expectedBrand = ROUTE47_DEMO_PROFILE
    ? "Moosewave Partner Cloud"
    : "Northstar Partner Cloud";
  const expectedTenant = ROUTE47_DEMO_PROFILE
    ? ROUTE47_DEMO_TENANT
    : ROUTE47_STANDARD_TENANT;
  await expect(page.getByText(expectedBrand, { exact: true })).toBeVisible();
  await expect(
    page.getByText(new RegExp(`agency-branding:${expectedTenant}:v`, "u")),
  ).toBeVisible();
  await expect(page.getByText(/One record, one narrow scope/u)).toBeVisible();
  await expect(page.getByText(/do not theme email, signup/u)).toBeVisible();
  await expect(page.getByText(/no current reader consumes/iu)).toBeVisible();
  await expect(page.locator(".agency-brand-preview img")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
  await expectNoAgencyHorizontalOverflow(page);
  const axeViolations = await seriousAgencyAxeViolations(page);
  await expectAgencyHarnessClean(page, harness);
  expect(axeViolations).toEqual([]);

  await saveAgencyEvidence(
    page,
    testInfo,
    `agency-${profileLabel}-branding-light-390-reduced-motion`,
  );
  await attachAgencyEvidence(
    testInfo,
    `agency-${profileLabel}-branding-mobile-evidence`,
    harness,
    { axeViolations },
  );
});

test(`${profileLabel} tabs follow manual APG keyboard semantics in forced colors`, async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  const harness = await openAgency(page, bootApp, setTheme, {
    theme: "dark",
    width: 1_024,
    height: 900,
  });
  const tabs = agencyTabs(page);
  await expect(tabs.list.getByRole("tab")).toHaveCount(3);
  await expect(tabs.children).toHaveAttribute("aria-selected", "true");
  await expect(tabs.children).toHaveAttribute("tabindex", "0");
  await expect(tabs.list.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);

  await tabs.children.focus();
  await tabs.children.press("ArrowRight");
  await expect(tabs.branding).toBeFocused();
  await expect(tabs.children).toHaveAttribute("aria-selected", "true");
  await expect(tabs.branding).toHaveAttribute("aria-selected", "false");
  await tabs.branding.press("Enter");
  await expect(tabs.branding).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "Audit portal branding record" }),
  ).toBeVisible();
  const afterBrandingRead = harness.requests.length;
  expect(await clickVisibleHeldControls(page)).toBe(1);
  expect(harness.requests).toHaveLength(afterBrandingRead);

  await tabs.branding.press("End");
  await expect(tabs.invoice).toBeFocused();
  await expect(tabs.branding).toHaveAttribute("aria-selected", "true");
  await tabs.invoice.press(" ");
  await expect(tabs.invoice).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "Usage and invoices", exact: true }),
  ).toBeVisible();
  const beforeHeld = harness.requests.length;
  expect(await clickVisibleHeldControls(page)).toBe(4);
  expect(harness.requests).toHaveLength(beforeHeld);
  await saveAgencyEvidence(
    page,
    testInfo,
    `agency-${profileLabel}-invoice-hold-forced-colors-1024`,
  );

  await tabs.invoice.press("Home");
  await expect(tabs.children).toBeFocused();
  await expect(tabs.invoice).toHaveAttribute("aria-selected", "true");
  await tabs.children.press("Enter");
  await expect(tabs.children).toHaveAttribute("aria-selected", "true");
  const beforeChildHeld = harness.requests.length;
  expect(await clickVisibleHeldControls(page)).toBeGreaterThanOrEqual(3);
  expect(harness.requests).toHaveLength(beforeChildHeld);

  expect(
    await page.evaluate(() => ({
      forcedColors: matchMedia("(forced-colors: active)").matches,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    })),
  ).toEqual({ forcedColors: true, reducedMotion: true });
  await expectNoAgencyHorizontalOverflow(page);
  const axeViolations = await seriousAgencyAxeViolations(page, {
    disableColorContrast: true,
  });
  await expectAgencyHarnessClean(page, harness);
  expect(axeViolations).toEqual([]);

  await saveAgencyEvidence(
    page,
    testInfo,
    `agency-${profileLabel}-forced-colors-keyboard-1024`,
  );
  await attachAgencyEvidence(
    testInfo,
    `agency-${profileLabel}-forced-colors-evidence`,
    harness,
    { axeViolations },
  );
});

test(`${profileLabel} viewer deep link makes zero agency requests`, async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openAgency(page, bootApp, setTheme, {
    role: "viewer",
    theme: "light",
    width: 390,
    height: 844,
  });
  await expect(page.locator(".capability-gate")).toContainText(
    "Access required",
  );
  await expect(page.locator(".agency-page")).toHaveCount(0);
  expect(harness.protectedRequests).toEqual([]);
  const axeViolations = await seriousAgencyAxeViolations(page, {
    root: ".capability-gate",
  });
  await expectAgencyHarnessClean(page, harness);
  expect(axeViolations).toEqual([]);

  await saveAgencyEvidence(
    page,
    testInfo,
    `agency-${profileLabel}-viewer-zero-request-390`,
  );
  await attachAgencyEvidence(
    testInfo,
    `agency-${profileLabel}-viewer-zero-request-evidence`,
    harness,
    { axeViolations },
  );
});

test("standard continuation errors and cursor loops retain loaded rows before deduped recovery", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  test.skip(
    ROUTE47_DEMO_PROFILE,
    "The demo fixture is a terminal roster and intentionally has no continuation.",
  );
  const harness = await openAgency(page, bootApp, setTheme, {
    continuationMode: "error",
    theme: "dark",
  });
  const table = page.getByRole("table", { name: /Loaded, verified/u });
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: "Load next page" }).click();
  await expect(
    page.getByText(/Showing the loaded roster window/u),
  ).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(2);

  harness.setContinuationMode("loop");
  await page.getByRole("button", { name: "Retry next page" }).click();
  await expect(page.getByText(/invalid response/u)).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(2);

  harness.setContinuationMode("ok");
  await page.getByRole("button", { name: "Retry next page" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(page.getByText(/All 3 verified rows are loaded/u)).toBeVisible();
  expect(harness.rosterReadCount()).toBeGreaterThanOrEqual(4);
  await expectNoAgencyHorizontalOverflow(page);
  const axeViolations = await seriousAgencyAxeViolations(page);
  await expectAgencyHarnessClean(page, harness);
  expect(axeViolations).toEqual([]);

  await saveAgencyEvidence(
    page,
    testInfo,
    "agency-standard-retained-continuation-recovery",
  );
  await attachAgencyEvidence(
    testInfo,
    "agency-standard-retained-continuation-evidence",
    harness,
    { axeViolations },
  );
});

test("standard malformed roster and branding responses fail closed", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  test.skip(
    ROUTE47_DEMO_PROFILE,
    "The demo build deliberately substitutes its strict read-only fixture for empty reads.",
  );
  const harness = await openAgency(page, bootApp, setTheme, {
    brandingReadMode: "malformed",
    rosterReadMode: "malformed",
    theme: "light",
  });
  await expect(
    page.locator('[data-remote-state="initial-error"]'),
  ).toContainText("Couldn’t verify sub-accounts");
  await expect(page.locator(".agency-table")).toHaveCount(0);
  await activate(
    page,
    agencyTabs(page).branding,
    "Audit portal branding record",
  );
  await expect(
    page.locator('[data-remote-state="initial-error"]'),
  ).toContainText("Couldn’t verify agency branding");
  await expect(page.locator(".agency-branding-facts")).toHaveCount(0);
  await expect(page.locator(".agency-brand-preview")).toHaveCount(0);
  await expectNoAgencyHorizontalOverflow(page);
  const axeViolations = await seriousAgencyAxeViolations(page);
  await expectAgencyHarnessClean(page, harness);
  expect(axeViolations).toEqual([]);

  await saveAgencyEvidence(
    page,
    testInfo,
    "agency-standard-malformed-fail-closed",
  );
  await attachAgencyEvidence(
    testInfo,
    "agency-standard-malformed-fail-closed-evidence",
    harness,
    { axeViolations },
  );
});

test("standard failed branding refresh retains the exact verified record", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  test.skip(
    ROUTE47_DEMO_PROFILE,
    "Demo GET failures intentionally resolve to the deterministic local fixture.",
  );
  const harness = await openAgency(page, bootApp, setTheme, { theme: "dark" });
  await activate(
    page,
    agencyTabs(page).branding,
    "Audit portal branding record",
  );
  await expect(
    page.getByText("Northstar Partner Cloud", { exact: true }),
  ).toBeVisible();
  harness.setBrandingReadMode("error");
  await page.getByRole("button", { name: "Refresh branding" }).click();
  await expect(
    page.getByText(/Showing last verified agency branding/u),
  ).toBeVisible();
  await expect(
    page.getByText("Northstar Partner Cloud", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(STANDARD_BRANDING_ETAG_PATTERN)).toBeVisible();
  await expectNoAgencyHorizontalOverflow(page);
  const axeViolations = await seriousAgencyAxeViolations(page);
  await expectAgencyHarnessClean(page, harness);
  expect(axeViolations).toEqual([]);

  await saveAgencyEvidence(
    page,
    testInfo,
    "agency-standard-branding-retained-error",
  );
  await attachAgencyEvidence(
    testInfo,
    "agency-standard-branding-retained-error-evidence",
    harness,
    { axeViolations },
  );
});

const STANDARD_BRANDING_ETAG_PATTERN =
  /agency-branding:47474747-4747-4474-9474-474747474747:v7/u;
