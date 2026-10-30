import type { Locator, Page } from "@playwright/test";

import {
  attachSendingEvidence,
  expectNoSendingHorizontalOverflow,
  expectSendingHarnessClean,
  openSendingSettings,
  ROUTE46_CLEARED_AT,
  ROUTE46_DEMO_PROFILE,
  ROUTE46_IP_POOL,
  ROUTE46_SAVED_AT,
  ROUTE46_UPDATED_AT,
  saveSendingEvidence,
  seriousSendingAxeViolations,
} from "./sending-settings-99p9-harness";
import { expect, test } from "./fixture";

function sendingTabs(page: Page): {
  list: Locator;
  overview: Locator;
  limits: Locator;
  frequency: Locator;
  identity: Locator;
} {
  const navigation = page.getByRole("navigation", {
    name: "Sending settings sections",
  });
  const list = navigation.getByRole("tablist");
  return {
    list,
    overview: list.getByRole("tab", { name: /^Overview/u }),
    limits: list.getByRole("tab", { name: /^Limits & quiet hours/u }),
    frequency: list.getByRole("tab", { name: /^Frequency caps/u }),
    identity: list.getByRole("tab", { name: /^Sending identity/u }),
  };
}

async function activateLimits(page: Page): Promise<void> {
  const { limits } = sendingTabs(page);
  await limits.click();
  await expect(limits).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "Limits & quiet hours", exact: true }),
  ).toBeVisible();
}

test.use({ locale: "en-US", timezoneId: "UTC" });
test.describe.configure({ timeout: 180_000 });

for (const theme of ["dark", "light"] as const) {
  test(`configured admin overview is coherent in ${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const harness = await openSendingSettings(page, bootApp, setTheme, {
      theme,
      width: 1_440,
      height: 960,
    });

    await expect(
      page.getByText("5,000", { exact: false }).first(),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Live shared-counter telemetry is unavailable; no usage value is inferred.",
      ),
    ).toBeVisible();
    await expect(
      page.locator(".sending-evidence-chip", {
        hasText: ROUTE46_DEMO_PROFILE
          ? /^Demo fixture$/u
          : /^Configuration only$/u,
      }),
    ).toBeVisible();
    await expect(
      page.locator(".sending-status-value", {
        hasText: ROUTE46_DEMO_PROFILE
          ? /^Illustrative fixture$/u
          : /^Configuration only$/u,
      }),
    ).toBeVisible();
    await expect(
      page.locator(".sending-status-value", {
        hasText: ROUTE46_DEMO_PROFILE
          ? /^Illustrative authority$/u
          : /^Policy synchronized$/u,
      }),
    ).toBeVisible();
    await expect(page.getByText("Shared counter verified")).toHaveCount(0);
    await expect(page.getByText(/counted/u)).toHaveCount(0);
    await expect(
      page.getByText("22:00–07:00", { exact: false }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("America/New_York", { exact: false }).first(),
    ).toBeVisible();
    await expect(
      page.getByText(ROUTE46_IP_POOL, { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("Admin only", { exact: true })).toBeVisible();
    await expect(
      page.locator(".sending-header-meta .sending-updated"),
    ).toHaveCSS(
      "white-space",
      "nowrap",
    );
    await expectNoSendingHorizontalOverflow(page);
    const axeViolations = await seriousSendingAxeViolations(page);
    expectSendingHarnessClean(harness);

    await saveSendingEvidence(
      page,
      testInfo,
      `sending-configured-overview-${theme}-1440`,
    );
    await attachSendingEvidence(
      testInfo,
      `sending-configured-overview-${theme}-requests`,
      harness,
      { axeViolations },
    );
    expect(axeViolations).toEqual([]);
  });
}

test("390px limits layout reflows without root overflow under reduced motion", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const harness = await openSendingSettings(page, bootApp, setTheme, {
    theme: "light",
    width: 390,
    height: 844,
  });
  await activateLimits(page);

  await expect(page.getByLabel("Hourly sending ceiling")).toHaveValue("5000");
  await expect(
    page.getByRole("checkbox", { name: "Quiet hours", exact: true }),
  ).toBeChecked();
  await expect(page.getByLabel("Starts")).toHaveValue("22:00");
  await expect(page.getByLabel("Ends")).toHaveValue("07:00");
  await expect(page.getByLabel("Workspace fallback timezone")).toHaveValue(
    "America/New_York",
  );
  await expect(
    page.getByLabel("Evaluate each recipient's timezone"),
  ).toBeChecked();
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
  await expectNoSendingHorizontalOverflow(page);
  expect(
    await seriousSendingAxeViolations(page, { root: ".sending-editor" }),
  ).toEqual([]);
  expectSendingHarnessClean(harness);

  await saveSendingEvidence(
    page,
    testInfo,
    "sending-limits-light-390-reduced-motion",
    page.locator(".sending-editor"),
  );
  await attachSendingEvidence(
    testInfo,
    "sending-limits-light-390-requests",
    harness,
  );
});

test("tabs expose APG relationships and automatic keyboard activation in forced colors", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  const harness = await openSendingSettings(page, bootApp, setTheme, {
    theme: "dark",
    width: 1_024,
    height: 900,
  });
  const { list, overview, limits, frequency, identity } = sendingTabs(page);

  await expect(list).toHaveCount(1);
  await expect(list.getByRole("tab")).toHaveCount(4);
  await expect(overview).toHaveAttribute("aria-selected", "true");
  await expect(overview).toHaveAttribute("tabindex", "0");
  await expect(list.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);

  await overview.focus();
  await overview.press("ArrowRight");
  await expect(limits).toBeFocused();
  await expect(limits).toHaveAttribute("aria-selected", "true");
  let panel = page.getByRole("tabpanel");
  const limitsID = await limits.getAttribute("id");
  const limitsPanelID = await limits.getAttribute("aria-controls");
  expect(limitsID).not.toBeNull();
  expect(limitsPanelID).not.toBeNull();
  await expect(panel).toHaveAttribute("aria-labelledby", limitsID!);
  await expect(panel).toHaveAttribute("id", limitsPanelID!);

  await limits.press("ArrowRight");
  await expect(frequency).toBeFocused();
  await expect(frequency).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "Frequency caps", exact: true }),
  ).toBeVisible();

  await frequency.press("End");
  await expect(identity).toBeFocused();
  await expect(identity).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(ROUTE46_IP_POOL, { exact: true })).toBeVisible();
  await identity.press("Home");
  await expect(overview).toBeFocused();
  await expect(overview).toHaveAttribute("aria-selected", "true");
  await overview.press("ArrowLeft");
  await expect(identity).toBeFocused();
  await expect(identity).toHaveAttribute("aria-selected", "true");
  panel = page.getByRole("tabpanel");
  await expect(panel).toHaveCount(1);
  expect(
    await page.evaluate(() => ({
      forcedColors: matchMedia("(forced-colors: active)").matches,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    })),
  ).toEqual({ forcedColors: true, reducedMotion: true });
  expect(
    await seriousSendingAxeViolations(page, { disableColorContrast: true }),
  ).toEqual([]);
  await expectNoSendingHorizontalOverflow(page);
  expectSendingHarnessClean(harness);

  await saveSendingEvidence(
    page,
    testInfo,
    "sending-tabs-dark-1024-forced-colors",
  );
  await attachSendingEvidence(
    testInfo,
    "sending-tabs-keyboard-requests",
    harness,
  );
});

test("frequency rules and the create dialog remain legible, validated, and keyboard-contained", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  test.skip(
    ROUTE46_DEMO_PROFILE,
    "The demo profile intentionally removes frequency-cap mutations.",
  );
  const harness = await openSendingSettings(page, bootApp, setTheme, {
    theme: "light",
    width: 1_024,
    height: 900,
  });
  const { frequency } = sendingTabs(page);
  await frequency.click();

  const table = page.getByRole("table", { name: "Configured frequency caps" });
  await expect(table).toBeVisible();
  await expect(
    table.getByText("Marketing messages", { exact: true }),
  ).toBeVisible();
  await expect(table.getByText("3 per 24h", { exact: true })).toBeVisible();
  await expect(table.getByText("Email", { exact: true })).toBeVisible();

  const trigger = page.getByRole("button", { name: "New cap" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "New frequency cap" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Maximum sends")).toHaveValue("3");
  await expect(dialog.getByLabel("Window (hours)")).toHaveValue("24");
  await expect(dialog.getByRole("checkbox", { name: "Email" })).toBeChecked();
  await dialog.getByRole("button", { name: "Create cap" }).click();
  await expect(dialog.getByText(/label is required/iu)).toBeVisible();
  expect(harness.mutations).toEqual([]);
  expect(
    await seriousSendingAxeViolations(page, { root: '[role="dialog"]' }),
  ).toEqual([]);
  await expectNoSendingHorizontalOverflow(page);
  expectSendingHarnessClean(harness);

  await saveSendingEvidence(
    page,
    testInfo,
    "sending-frequency-create-validation-light-1024",
    dialog,
  );
  await attachSendingEvidence(
    testInfo,
    "sending-frequency-create-validation-requests",
    harness,
  );

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("an initial settings GET failure keeps every editor closed", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openSendingSettings(page, bootApp, setTheme, {
    initialSettingsRead: "error",
    theme: "light",
  });

  await expect(
    page.locator('[data-remote-state="initial-error"]'),
  ).toContainText("Couldn’t verify sending settings");
  await expect(page.getByLabel("Hourly sending ceiling")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(
    0,
  );
  await sendingTabs(page).limits.click();
  await expect(
    page.getByRole("heading", { name: "No verified policy to edit" }),
  ).toBeVisible();
  await expect(page.getByLabel("Hourly sending ceiling")).toHaveCount(0);
  expect(harness.mutations).toEqual([]);
  expect(harness.settingsReadCount()).toBeGreaterThanOrEqual(1);
  expect(
    await seriousSendingAxeViolations(page, { root: ".sending-unverified" }),
  ).toEqual([]);
  expectSendingHarnessClean(harness, [503]);

  await saveSendingEvidence(page, testInfo, "sending-initial-read-fail-closed");
  await attachSendingEvidence(
    testInfo,
    "sending-initial-read-failure-requests",
    harness,
  );
});

test("a failed refresh retains a dirty verified draft", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  test.skip(
    ROUTE46_DEMO_PROFILE,
    "The demo profile intentionally disables sending-policy editing.",
  );
  const harness = await openSendingSettings(page, bootApp, setTheme, {
    theme: "dark",
  });
  await activateLimits(page);
  const cap = page.getByLabel("Hourly sending ceiling");
  await cap.fill("6400");
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeVisible();

  const readsBeforeRefresh = harness.settingsReadCount();
  harness.setSettingsReadMode("error");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator('[data-remote-state="stale-error"]')).toContainText(
    "Showing last verified sending settings",
  );
  await expect(cap).toHaveValue("6400");
  await expect(
    page.getByRole("button", { name: "Save changes" }),
  ).toBeVisible();
  expect(harness.settingsReadCount()).toBeGreaterThan(readsBeforeRefresh);
  expect(harness.mutations).toEqual([]);
  expectSendingHarnessClean(harness, [503]);

  await saveSendingEvidence(
    page,
    testInfo,
    "sending-stale-refresh-retains-draft",
    page.locator('[data-remote-state="stale-error"]'),
  );
  await attachSendingEvidence(
    testInfo,
    "sending-stale-refresh-requests",
    harness,
    { retainedDraft: "6400" },
  );
});

test("viewer deep link makes zero sending-policy requests", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openSendingSettings(page, bootApp, setTheme, {
    role: "viewer",
    theme: "light",
    width: 390,
    height: 844,
  });

  const gate = page.locator(".capability-gate");
  await expect(gate).toContainText("Access required");
  await expect(gate).toContainText(/admin role/iu);
  await expect(page.locator(".sending-page")).toHaveCount(0);
  expect(harness.protectedRequests).toEqual([]);
  expect(
    await seriousSendingAxeViolations(page, { root: ".capability-gate" }),
  ).toEqual([]);
  expectSendingHarnessClean(harness);

  await saveSendingEvidence(page, testInfo, "sending-viewer-fail-closed-390");
  await attachSendingEvidence(
    testInfo,
    "sending-viewer-fail-closed-requests",
    harness,
  );
});

test("save and clear mutations carry exact CAS revisions and omit legacy fallback", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  test.skip(
    ROUTE46_DEMO_PROFILE,
    "The demo profile intentionally disables sending-policy mutations.",
  );
  const harness = await openSendingSettings(page, bootApp, setTheme, {
    theme: "light",
  });
  await activateLimits(page);
  await page.getByLabel("Hourly sending ceiling").fill("6400");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(() => harness.mutations.length).toBe(1);
  await expect(
    page.getByRole("button", { name: "Clear limit & quiet hours" }),
  ).toBeEnabled();

  await page.getByRole("button", { name: "Clear limit & quiet hours" }).click();
  const dialog = page.getByRole("alertdialog", {
    name: "Clear hourly limit and quiet hours?",
  });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    "The workspace will no longer have this hourly ceiling",
  );
  await expect(dialog).toContainText(
    "Provider, quota, and safety controls still apply",
  );
  await expect(dialog).not.toContainText(/gateway default/iu);
  await dialog
    .getByRole("button", { name: "Clear limit & quiet hours" })
    .click();
  await expect.poll(() => harness.mutations.length).toBe(2);

  expect(harness.mutations[0]).toMatchObject({
    idempotencyKey: null,
    method: "PUT",
    pathname: "/api/v1/settings/sending",
    search: "",
    body: {
      max_sends_per_hour: 6_400,
      quiet_hours_start: "22:00",
      quiet_hours_end: "07:00",
      quiet_hours_tz: "America/New_York",
      quiet_hours_per_recipient: true,
      expected_updated_at: ROUTE46_UPDATED_AT,
    },
  });
  expect(harness.mutations[1]).toMatchObject({
    idempotencyKey: null,
    method: "PUT",
    pathname: "/api/v1/settings/sending",
    search: "",
    body: {
      max_sends_per_hour: null,
      quiet_hours_start: "",
      quiet_hours_end: "",
      quiet_hours_tz: "",
      quiet_hours_per_recipient: true,
      expected_updated_at: ROUTE46_SAVED_AT,
    },
  });
  for (const mutation of harness.mutations) {
    expect(mutation.body).not.toHaveProperty("fallback_hour_utc");
  }
  expect(harness.currentSettings()).toMatchObject({
    fallback_hour_utc: 4,
    ip_pool: { name: ROUTE46_IP_POOL, dedicated: false },
    updated_at: ROUTE46_CLEARED_AT,
  });
  await expect(page.getByLabel("Hourly sending ceiling")).toHaveValue("");
  await expect(page.locator(".sending-editor")).toContainText(
    "Leave blank for no workspace-specific hourly ceiling",
  );
  expectSendingHarnessClean(harness);

  await saveSendingEvidence(
    page,
    testInfo,
    "sending-cleared-policy-after-cas",
    page.locator(".sending-editor"),
  );
  await attachSendingEvidence(
    testInfo,
    "sending-save-clear-cas-payloads",
    harness,
  );
});

test("demo profile exposes the configured policy as read-only", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  test.skip(
    !ROUTE46_DEMO_PROFILE,
    "The canonical optimized visual-test build is not the optional demo profile.",
  );
  const harness = await openSendingSettings(page, bootApp, setTheme, {
    theme: "light",
  });
  await expect(page.getByText("Read-only demo", { exact: true })).toBeVisible();
  await activateLimits(page);
  await expect(page.locator(".sending-demo-notice")).toBeVisible();
  await expect(page.getByLabel("Hourly sending ceiling")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(
    0,
  );
  expect(harness.mutations).toEqual([]);
  expectSendingHarnessClean(harness);
  await saveSendingEvidence(page, testInfo, "sending-demo-read-only");
  await attachSendingEvidence(testInfo, "sending-demo-requests", harness);
});
