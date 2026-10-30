import type { Page } from "@playwright/test";

import {
  catalogCard,
  expectNoHorizontalOverflow,
  observeRenderer,
  openIntegrations,
  seriousAxeViolations,
  type IntegrationsHarness,
} from "../visual/integrations-99p9-harness";
import { expect, test } from "../visual/fixture";

async function expectSettled(page: Page): Promise<void> {
  await expect(page.locator(".integrations-page")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(
    page.getByLabel("Integration catalog").locator("article"),
  ).toHaveCount(6);
}

function expectHarnessClean(harness: IntegrationsHarness): void {
  expect(harness.expectedMutations).toEqual([]);
  expect(harness.mutations).toEqual([]);
  expect(harness.unexpected).toEqual([]);
}

async function activateView(page: Page, name: string): Promise<void> {
  const choice = page.getByRole("radio", {
    name: new RegExp(`^${name}\\b`, "u"),
  });
  await choice.focus();
  await page.keyboard.press("Space");
  await expect(choice).toBeChecked();
}

for (const theme of ["dark", "light"] as const) {
  test(`integrations catalog and view controls are axe-clean in ${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }) => {
    const renderer = observeRenderer(page);
    const harness = await openIntegrations(page, bootApp, setTheme, {
      theme,
      width: 1440,
      height: 1000,
    });
    await expectSettled(page);

    await expect(
      page.getByRole("group", { name: "Integration view" }),
    ).toBeVisible();
    await expect(page.getByLabel("Filter integrations")).toBeVisible();
    expect(await seriousAxeViolations(page)).toEqual([]);
    await expectNoHorizontalOverflow(page);
    expectHarnessClean(harness);
    renderer.expectClean();
  });
}

test("the 390px integrations route stays semantically complete and axe-clean", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const renderer = observeRenderer(page);
  const harness = await openIntegrations(page, bootApp, setTheme, {
    theme: "light",
    width: 390,
    height: 844,
  });
  await expectSettled(page);

  await expect(
    page.getByRole("heading", { name: "Integrations", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Integration workspace posture")).toBeVisible();
  await expectNoHorizontalOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expectHarnessClean(harness);
  renderer.expectClean();
});

test("detail, disconnect review, playbook, and preparation dialog preserve modal accessibility", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const renderer = observeRenderer(page);
  const harness = await openIntegrations(page, bootApp, setTheme, {
    theme: "light",
  });
  await expectSettled(page);

  const inspect = catalogCard(page, "Mailchimp").getByRole("button", {
    name: "Inspect",
    exact: true,
  });
  await inspect.click();
  const detail = page.getByRole("dialog", { name: "Mailchimp" });
  await expect(detail).toBeVisible();
  await expect(detail.locator(".slideover-body")).toBeFocused();
  expect(await seriousAxeViolations(page)).toEqual([]);

  const disconnect = detail.getByRole("button", {
    name: "Disconnect",
    exact: true,
  });
  await disconnect.click();
  const disconnectReview = page.getByRole("alertdialog", {
    name: /(?:disconnect|disconnection).+Mailchimp/i,
  });
  await expect(disconnectReview).toBeVisible();
  await expect(
    disconnectReview.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  expect(await seriousAxeViolations(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(disconnectReview).toBeHidden();
  await expect(disconnect).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(inspect).toBeFocused();

  await activateView(page, "Recipes");
  const readyPlaybook = page
    .getByLabel("Setup playbooks")
    .locator("article")
    .filter({ hasText: "Mailchimp audience to welcome journey" });
  const reviewBlueprint = readyPlaybook.getByRole("button", {
    name: "Review blueprint",
    exact: true,
  });
  await reviewBlueprint.click();
  const playbook = page.getByRole("dialog", {
    name: "Mailchimp audience to welcome journey",
  });
  await expect(playbook).toBeVisible();
  expect(await seriousAxeViolations(page)).toEqual([]);

  const prepare = playbook.getByRole("button", {
    name: "Prepare setup",
    exact: true,
  });
  await prepare.click();
  const preflight = page.getByRole("dialog", {
    name: "Prepare Mailchimp audience to welcome journey setup?",
  });
  await expect(preflight).toBeVisible();
  await expect(preflight.getByRole("button", { name: "Cancel" })).toBeFocused();
  expect(await seriousAxeViolations(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(preflight).toBeHidden();
  await expect(prepare).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(playbook).toBeHidden();
  await expect(reviewBlueprint).toBeFocused();
  expectHarnessClean(harness);
  renderer.expectClean();
});

test("forced colors plus reduced motion retain focus and axe semantics", async ({
  page,
  bootApp,
  setTheme,
}) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  const renderer = observeRenderer(page);
  const harness = await openIntegrations(page, bootApp, setTheme, {
    theme: "dark",
    width: 390,
    height: 844,
  });
  await expectSettled(page);

  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => matchMedia("(forced-colors: active)").matches),
  ).toBe(true);

  const connections = page.getByRole("radio", {
    name: /^Connections\b/u,
  });
  await connections.focus();
  const focusRing = await connections.evaluate((element) => {
    const owner = element.parentElement;
    if (!owner) throw new Error("Choice-group label is missing.");
    const style = getComputedStyle(owner);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(focusRing.outlineStyle).not.toBe("none");
  expect(focusRing.outlineWidth).toBeGreaterThanOrEqual(2);

  expect(
    await seriousAxeViolations(page, { disableColorContrast: true }),
  ).toEqual([]);
  await expectNoHorizontalOverflow(page);
  expectHarnessClean(harness);
  renderer.expectClean();
});
