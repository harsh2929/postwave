import type { Locator, Page } from "@playwright/test";

import {
  attachJson,
  catalogCard,
  expectNextMutation,
  expectNoHorizontalOverflow,
  HEALTHY_CONNECTION_ID,
  HEALTHY_SLUG,
  NATIVE_CRM_SLUG,
  observeRenderer,
  openIntegrations,
  READY_RECIPE_ID,
  saveEvidence,
  seriousAxeViolations,
  type IntegrationsHarness,
} from "./integrations-99p9-harness";
import { expect, test } from "./fixture";

const RESOURCE_PATHS = [
  "/api/v1/integrations/catalog",
  "/api/v1/integrations/connections",
  "/api/v1/integrations/coverage",
  "/api/v1/integrations/stacks",
  "/api/v1/integrations/readiness",
  "/api/v1/integrations/recipes",
] as const;

async function expectInitialEvidenceLoaded(
  page: Page,
  harness: IntegrationsHarness,
): Promise<void> {
  await expect
    .poll(() =>
      RESOURCE_PATHS.every((pathname) =>
        harness.requests.some(
          (request) =>
            request.method === "GET" && request.pathname === pathname,
        ),
      ),
    )
    .toBe(true);
  await expect(page.locator(".integrations-page")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
}

function expectHarnessClean(harness: IntegrationsHarness): void {
  expect(harness.expectedMutations).toEqual([]);
  expect(harness.unexpected).toEqual([]);
}

function viewRadio(page: Page, name: string): Locator {
  return page.getByRole("radio", { name: new RegExp(`^${name}\\b`, "u") });
}

function recipeCard(page: Page, name: string): Locator {
  return page.locator(".integrations-page article").filter({ hasText: name });
}

for (const variant of [
  { theme: "dark", width: 1440, height: 1000 },
  { theme: "light", width: 1440, height: 1000 },
  { theme: "dark", width: 1024, height: 900 },
  { theme: "light", width: 768, height: 900 },
  { theme: "dark", width: 390, height: 844 },
  { theme: "light", width: 390, height: 844 },
] as const) {
  test(`catalog truth states remain legible in ${variant.theme} at ${variant.width}px`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const renderer = observeRenderer(page);
    const harness = await openIntegrations(page, bootApp, setTheme, variant);
    await expectInitialEvidenceLoaded(page, harness);

    await expect(
      page.getByLabel("Integration workspace posture"),
    ).toContainText("Operator review");
    await expect(
      page.getByLabel("Integration catalog").locator("article"),
    ).toHaveCount(6);

    const healthy = catalogCard(page, "Mailchimp");
    await expect(healthy).toHaveAttribute("data-connected", "true");
    await expect(healthy).not.toHaveAttribute("data-attention", "true");
    await expect(healthy).toContainText("Healthy");

    const attention = catalogCard(page, "Zendesk");
    await expect(attention).toHaveAttribute("data-connected", "true");
    await expect(attention).toHaveAttribute("data-attention", "true");
    await expect(attention).toContainText("Credential reference expired");

    const ready = catalogCard(page, "Stripe");
    await expect(ready).toHaveAttribute("data-runtime", "delegated");
    await expect(
      ready.getByRole("button", { name: "Connect", exact: true }),
    ).toBeEnabled();

    const nativeCrm = catalogCard(page, "HubSpot");
    await expect(nativeCrm).toHaveAttribute("data-runtime", "available");
    await expect(nativeCrm).toContainText("Native");
    await expect(
      nativeCrm.getByRole("button", { name: "Configure", exact: true }),
    ).toBeEnabled();

    const planned = catalogCard(page, "Braze");
    await expect(planned).toHaveAttribute("data-runtime", "planned");
    const plannedAction = planned.getByRole("button", {
      name: "Planned",
      exact: true,
    });
    await expect(plannedAction).toBeDisabled();
    await expect(planned).toContainText(
      "This integration is planned and cannot connect yet.",
    );

    await expectNoHorizontalOverflow(page);
    expect(await seriousAxeViolations(page)).toEqual([]);
    expectHarnessClean(harness);
    renderer.expectClean();

    await saveEvidence(
      page,
      testInfo,
      `integrations-catalog-${variant.theme}-${variant.width}`,
    );
    await attachJson(
      testInfo,
      `integrations-requests-${variant.theme}-${variant.width}`,
      { requests: harness.requests, mutations: harness.mutations },
    );
  });
}

test("filter, sort, search, empty recovery, and reset expose deterministic catalog state", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openIntegrations(page, bootApp, setTheme, {
    theme: "light",
  });
  await expectInitialEvidenceLoaded(page, harness);

  const cardTitles = page.locator(".int-catalog-card h3");
  await expect(cardTitles).toHaveText([
    "Zendesk",
    "Mailchimp",
    "HubSpot",
    "Stripe",
    "Moosewave Webhook Relay",
    "Braze",
  ]);

  await page.getByRole("combobox", { name: "Sort" }).selectOption("name");
  await expect(cardTitles).toHaveText([
    "Braze",
    "HubSpot",
    "Mailchimp",
    "Moosewave Webhook Relay",
    "Stripe",
    "Zendesk",
  ]);

  const workspaceState = page.getByRole("combobox", {
    name: "Workspace state",
  });
  await workspaceState.selectOption("attention");
  await expect(cardTitles).toHaveText(["Zendesk"]);
  await expect(
    page.getByText("1 active filter", { exact: true }),
  ).toBeVisible();

  await workspaceState.selectOption("all");
  await page
    .getByRole("combobox", { name: "Category" })
    .selectOption("payments");
  await expect(cardTitles).toHaveText(["Stripe"]);

  const search = page.getByRole("searchbox", { name: "Search integrations" });
  await search.fill("no-such-provider");
  await expect(
    page.getByRole("heading", {
      name: "No integrations match this view",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(search).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Category" })).toHaveValue(
    "all",
  );
  await expect(page.getByRole("combobox", { name: "Sort" })).toHaveValue(
    "recommended",
  );
  await expect(cardTitles).toHaveCount(6);

  await search.fill("relay");
  await expect(cardTitles).toHaveText(["Moosewave Webhook Relay"]);
  await page.getByRole("button", { name: "Clear integration search" }).click();
  await expect(cardTitles).toHaveCount(6);
  await expect(
    page.getByText("No active filters", { exact: true }),
  ).toBeVisible();

  await expectNoHorizontalOverflow(page);
  expectHarnessClean(harness);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "integrations-filter-reset");
});

test("native CRM setup retries its registry, validates exact fields, rejects raw secrets, and preserves the draft", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page, [503]);
  const harness = await openIntegrations(page, bootApp, setTheme, {
    theme: "light",
    // Read requests use the shared bounded three-attempt retry policy. Exhaust
    // that budget so this browser test proves the modal's explicit recovery
    // affordance, then let the operator-initiated retry succeed.
    crmRegistryFailuresBeforeSuccess: 3,
  });
  await expectInitialEvidenceLoaded(page, harness);

  const nativeCard = catalogCard(page, "HubSpot");
  const connect = nativeCard.getByRole("button", {
    name: "Configure",
    exact: true,
  });
  await connect.focus();
  await connect.click();

  const dialog = page.getByRole("dialog", { name: "Configure HubSpot" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("alert")).toContainText(
    "Server error. Please try again.",
  );
  await expect(dialog.getByRole("alert")).toContainText(
    "crm_registry_temporarily_unavailable",
  );
  const retry = dialog.getByRole("button", { name: "Retry setup" });
  await expect(retry).toBeVisible();
  expect(
    harness.requests.filter(
      ({ method, pathname }) =>
        method === "GET" && pathname === "/api/v1/crm/providers",
    ),
  ).toHaveLength(3);

  await retry.click();
  const portal = dialog.getByRole("textbox", { name: /Portal ID/ });
  const credentialReference = dialog.getByRole("textbox", {
    name: /Credential reference/,
  });
  const pipeline = dialog.getByRole("textbox", { name: /Pipeline ID/ });
  const submit = dialog.getByRole("button", {
    name: "Save configuration",
    exact: true,
  });
  await expect(portal).toBeVisible();
  await expect(credentialReference).toBeVisible();
  await expect(dialog.getByLabel("Credential safety")).toContainText(
    "vault identifier, not the underlying password",
  );
  expect(
    harness.requests.filter(
      ({ method, pathname }) =>
        method === "GET" && pathname === "/api/v1/crm/providers",
    ),
  ).toHaveLength(4);
  expect(
    harness.requests.filter(
      ({ method, pathname }) =>
        method === "POST" && pathname === "/api/v1/crm/integrations",
    ),
  ).toHaveLength(0);

  await submit.click();
  await expect(portal).toBeFocused();
  await expect(portal).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByText("Portal ID is required.")).toBeVisible();

  await portal.fill("12345678");
  await credentialReference.fill("sk_live_not-a-real-secret-canary");
  await pipeline.fill("pipeline-enterprise");
  await submit.click();
  await expect(credentialReference).toBeFocused();
  await expect(credentialReference).toHaveAttribute("aria-invalid", "true");
  await expect(
    dialog.getByText("This looks like raw credential material", {
      exact: false,
    }),
  ).toBeVisible();
  expect(
    harness.requests.filter(
      ({ method, pathname }) =>
        method === "POST" && pathname === "/api/v1/crm/integrations",
    ),
  ).toHaveLength(0);

  await credentialReference.fill("vault://crm/hubspot-production");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  const discardReview = page.getByRole("alertdialog", {
    name: "Discard provider credentials?",
  });
  await expect(discardReview).toBeVisible();
  await expect(
    discardReview.getByRole("button", { name: "Keep editing" }),
  ).toBeFocused();
  await discardReview.getByRole("button", { name: "Keep editing" }).click();
  await expect(discardReview).toBeHidden();
  await expect(portal).toHaveValue("12345678");
  await expect(credentialReference).toHaveValue(
    "vault://crm/hubspot-production",
  );
  await expect(pipeline).toHaveValue("pipeline-enterprise");
  expect(await seriousAxeViolations(page)).toEqual([]);

  await saveEvidence(page, testInfo, "integrations-native-crm-vault-review");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await discardReview
    .getByRole("button", { name: "Discard credentials" })
    .click();
  await expect(dialog).toBeHidden();
  await expect(connect).toBeFocused();

  expect(
    harness.requests.filter(
      ({ method, pathname }) =>
        method === "POST" && pathname === "/api/v1/crm/integrations",
    ),
  ).toHaveLength(0);
  expectHarnessClean(harness);
  renderer.expectClean();
  await attachJson(testInfo, "integrations-native-crm-requests", {
    provider: NATIVE_CRM_SLUG,
    requests: harness.requests.filter(({ pathname }) =>
      pathname.startsWith("/api/v1/crm/"),
    ),
  });
});

test("all four views activate immediately from radio keyboard navigation", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openIntegrations(page, bootApp, setTheme, {
    theme: "light",
  });
  await expectInitialEvidenceLoaded(page, harness);

  const connections = viewRadio(page, "Connections");
  const recipes = viewRadio(page, "Recipes");
  const readiness = viewRadio(page, "Readiness");
  const useCases = viewRadio(page, "Use cases");

  await connections.focus();
  await page.keyboard.press("ArrowRight");
  await expect(recipes).toBeFocused();
  await expect(recipes).toBeChecked();
  await expect(
    page.getByRole("heading", { name: "Recipes", exact: true }),
  ).toBeVisible();
  await expect(
    recipeCard(page, "Mailchimp audience to welcome journey"),
  ).toBeVisible();
  await expect(
    recipeCard(page, "Braze events to Moosewave profiles"),
  ).toContainText("Planned playbook; blueprint review only.");

  await page.keyboard.press("ArrowRight");
  await expect(readiness).toBeFocused();
  await expect(readiness).toBeChecked();
  await expect(page.getByLabel("Integration coverage evidence")).toBeVisible();
  await expect(
    page.getByText("Portfolio distribution", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Connected provider health", { exact: true }),
  ).toBeVisible();

  await page.keyboard.press("End");
  await expect(useCases).toBeFocused();
  await expect(useCases).toBeChecked();
  await expect(page.getByLabel("Customer stack coverage")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Newsletter growth stack", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Support and payments stack",
      exact: true,
    }),
  ).toBeVisible();

  await page.keyboard.press("Home");
  await expect(connections).toBeFocused();
  await expect(connections).toBeChecked();
  await expect(page.getByLabel("Integration catalog")).toBeVisible();

  await expectNoHorizontalOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expectHarnessClean(harness);
  renderer.expectClean();
  await saveEvidence(
    page,
    testInfo,
    "integrations-four-view-keyboard-contract",
  );
});

test("detail slideover owns focus, traps keyboard navigation, and restores its opener", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openIntegrations(page, bootApp, setTheme);
  await expectInitialEvidenceLoaded(page, harness);

  const inspect = catalogCard(page, "Mailchimp").getByRole("button", {
    name: "Inspect",
    exact: true,
  });
  await inspect.focus();
  await inspect.click();

  const detail = page.getByRole("dialog", { name: "Mailchimp" });
  await expect(detail).toBeVisible();
  await expect(detail.locator(".slideover-body")).toBeFocused();
  await expect(
    detail.getByRole("heading", { name: "Contract assurance" }),
  ).toBeVisible();
  await expect(detail).toContainText("Delegated or planned contract");
  await expect(detail).toContainText(
    "Only an existing secure-vault reference is recorded.",
  );
  await expect(detail).toContainText("Bounded Exponential");
  await expect(detail).toContainText(HEALTHY_CONNECTION_ID);

  const focusables = detail.locator(
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  await focusables.first().focus();
  await page.keyboard.press("Shift+Tab");
  await expect(focusables.last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(focusables.first()).toBeFocused();

  expect(await seriousAxeViolations(page)).toEqual([]);
  await saveEvidence(page, testInfo, "integrations-mailchimp-detail");
  await page.keyboard.press("Escape");
  await expect(detail).toBeHidden();
  await expect(inspect).toBeFocused();

  expectHarnessClean(harness);
  renderer.expectClean();
});

test("recipe blueprint and preflight prepare only an exact delegated setup plan", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openIntegrations(page, bootApp, setTheme, {
    theme: "light",
  });
  await expectInitialEvidenceLoaded(page, harness);
  const recipesView = viewRadio(page, "Recipes");
  await recipesView.focus();
  await page.keyboard.press("Space");
  await expect(recipesView).toBeChecked();

  const readyCard = recipeCard(page, "Mailchimp audience to welcome journey");
  const blueprintButton = readyCard.getByRole("button", {
    name: "Review blueprint",
    exact: true,
  });
  await blueprintButton.focus();
  await blueprintButton.click();

  const blueprint = page.getByRole("dialog", {
    name: "Mailchimp audience to welcome journey",
  });
  await expect(blueprint).toBeVisible();
  await expect(
    blueprint.getByRole("region", { name: "Scrollable field mappings" }),
  ).toBeFocused();
  await expect(
    blueprint.getByRole("heading", {
      name: "Access, consent & data handling",
    }),
  ).toBeVisible();
  await expect(
    blueprint.getByRole("heading", { name: "Required scopes" }),
  ).toBeVisible();
  await expect(
    blueprint.getByRole("heading", { name: "Event bindings" }),
  ).toBeVisible();
  await expect(
    blueprint.getByRole("heading", { name: "Field mappings" }),
  ).toBeVisible();
  await expect(blueprint).toContainText("merge_fields.EMAIL");
  await expect(blueprint).toContainText("subscriber.email");
  await expect(blueprint).toContainText("redacted@example.invalid");

  const prepare = blueprint.getByRole("button", {
    name: "Prepare setup",
    exact: true,
  });
  expectNextMutation(harness, {
    target: READY_RECIPE_ID,
    action: "recipe/prepare",
  });
  await prepare.click();

  const preflight = page.getByRole("dialog", {
    name: "Prepare Mailchimp audience to welcome journey setup?",
  });
  await expect(preflight).toBeVisible();
  await expect(preflight.getByRole("button", { name: "Cancel" })).toBeFocused();
  expect(harness.mutations).toEqual([]);
  await expect(preflight.getByLabel("Recipe data path")).toContainText(
    "mailchimp→Moosewave Webhook Relay",
  );
  await expect(preflight).toContainText("audiences:read, subscribers:write");
  await expect(preflight).toContainText("mailchimp_oauth_reference");
  await expect(preflight).toContainText(
    "No automation is created during preparation",
  );
  await expect(
    preflight.getByRole("button", { name: "Prepare setup plan" }),
  ).toBeEnabled();

  await saveEvidence(page, testInfo, "integrations-recipe-preflight");
  await preflight.getByRole("button", { name: "Prepare setup plan" }).click();
  await expect(preflight).toBeHidden();
  await expect(
    blueprint.getByRole("heading", { name: "Setup plan prepared" }),
  ).toBeVisible();
  await expect(blueprint).toContainText("Delegated");
  await expect(blueprint).toContainText(
    "No automation or provider connection was created.",
  );
  await expect(
    page.getByText("setup plan is ready", { exact: false }),
  ).toBeVisible();

  expect(harness.mutations).toEqual([
    expect.objectContaining({
      target: READY_RECIPE_ID,
      action: "recipe/prepare",
      method: "POST",
      pathname: `/api/v1/integrations/recipes/${READY_RECIPE_ID}/apply`,
      body: "{}",
      responseStatus: "delegated",
    }),
  ]);
  expectHarnessClean(harness);
  expect(await seriousAxeViolations(page)).toEqual([]);
  renderer.expectClean();
  await attachJson(testInfo, "integrations-recipe-mutation", {
    mutations: harness.mutations,
  });
});

test("disconnect requires exact typing, re-verifies identity, and returns delegated evidence", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page);
  const harness = await openIntegrations(page, bootApp, setTheme);
  await expectInitialEvidenceLoaded(page, harness);

  await catalogCard(page, "Mailchimp")
    .getByRole("button", { name: "Inspect", exact: true })
    .click();
  const detail = page.getByRole("dialog", { name: "Mailchimp" });
  await expect(detail).toBeVisible();
  const disconnect = detail.getByRole("button", {
    name: "Disconnect",
    exact: true,
  });
  await disconnect.click();

  const confirmation = page.getByRole("alertdialog", {
    name: /(?:disconnect|disconnection).+Mailchimp/i,
  });
  await expect(confirmation).toBeVisible();
  await expect(
    confirmation.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  await expect(confirmation).toContainText(HEALTHY_CONNECTION_ID);
  await expect(confirmation).toContainText("1");
  await expect(confirmation).toContainText(
    "provider cleanup may continue asynchronously",
  );
  await expect(confirmation).toContainText("retained data remains subject");

  const confirm = confirmation.getByRole("button", {
    name: /Re-verify and (?:continue|disconnect)/,
  });
  await expect(confirm).toBeDisabled();
  const typeTarget = confirmation.getByRole("textbox", {
    name: `Type ${HEALTHY_SLUG} to confirm.`,
  });
  await typeTarget.fill(`${HEALTHY_SLUG}-wrong`);
  await expect(confirm).toBeDisabled();
  await typeTarget.fill(HEALTHY_SLUG);
  await expect(confirm).toBeEnabled();

  const detailReadsBefore = harness.requests.filter(
    (request) =>
      request.method === "GET" &&
      request.pathname === `/api/v1/integrations/${HEALTHY_SLUG}`,
  ).length;
  expectNextMutation(harness, { target: HEALTHY_SLUG, action: "disconnect" });
  await saveEvidence(page, testInfo, "integrations-disconnect-consequence");
  await confirm.click();

  await expect(confirmation).toBeHidden();
  await expect
    .poll(
      () =>
        harness.requests.filter(
          (request) =>
            request.method === "GET" &&
            request.pathname === `/api/v1/integrations/${HEALTHY_SLUG}`,
        ).length,
    )
    .toBe(detailReadsBefore + 1);
  await expect(
    page.getByText("disconnect handoff is ready", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Migrations", exact: true }),
  ).toBeVisible();
  await expect(detail).toBeHidden();

  expect(harness.mutations).toEqual([
    expect.objectContaining({
      target: HEALTHY_SLUG,
      action: "disconnect",
      method: "DELETE",
      pathname: `/api/v1/integrations/${HEALTHY_SLUG}`,
      body: null,
      responseStatus: "delegated",
    }),
  ]);
  expectHarnessClean(harness);
  renderer.expectClean();
  await attachJson(testInfo, "integrations-disconnect-mutation", {
    detailReadsBefore,
    detailReadsAfter: detailReadsBefore + 1,
    mutations: harness.mutations,
  });
});

test("partial coverage failure remains usable and represents unknown evidence as unknown", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observeRenderer(page, [503]);
  const harness = await openIntegrations(page, bootApp, setTheme, {
    theme: "light",
    failResources: ["coverage"],
  });
  await expectInitialEvidenceLoaded(page, harness);

  await expect(page.getByLabel("Integration workspace posture")).toContainText(
    "Partial verification",
  );
  await expect(
    page.getByText("Some evidence could not be refreshed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("coverage_evidence_unavailable", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Integration catalog").locator("article"),
  ).toHaveCount(6);

  const apiVerified = page.locator(".int-metric").filter({
    has: page.locator(".int-metric-label", { hasText: "API-verified" }),
  });
  await expect(apiVerified.locator(".int-metric-value")).toHaveText("—");
  await expect(apiVerified.locator(".int-metric-value")).not.toHaveText("0");

  const readinessView = viewRadio(page, "Readiness");
  await readinessView.focus();
  await page.keyboard.press("Space");
  await expect(readinessView).toBeChecked();
  await expect(
    page.getByRole("heading", {
      name: "Coverage evidence is unavailable",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("No maturity score is shown", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Integration coverage evidence")).toHaveCount(0);

  await expectNoHorizontalOverflow(page);
  expect(await seriousAxeViolations(page)).toEqual([]);
  expectHarnessClean(harness);
  renderer.expectClean();
  await saveEvidence(page, testInfo, "integrations-partial-coverage-unknown");
  await attachJson(testInfo, "integrations-partial-coverage-requests", {
    requests: harness.requests,
    unexpected: harness.unexpected,
  });
});

test("reduced motion and forced colors preserve route semantics, focus, and narrow operability", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({
    forcedColors: "active",
    reducedMotion: "reduce",
  });
  const renderer = observeRenderer(page);
  const harness = await openIntegrations(page, bootApp, setTheme, {
    theme: "dark",
    width: 390,
    height: 844,
  });
  await expectInitialEvidenceLoaded(page, harness);

  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => matchMedia("(forced-colors: active)").matches),
  ).toBe(true);

  const motion = await page.evaluate(() => {
    const durationMs = (value: string): number =>
      value
        .split(",")
        .map((part) => part.trim())
        .reduce((max, part) => {
          const parsed = Number.parseFloat(part);
          if (!Number.isFinite(parsed)) return max;
          return Math.max(max, part.endsWith("ms") ? parsed : parsed * 1_000);
        }, 0);
    return Array.from(
      document.querySelectorAll<HTMLElement>(".integrations-page *"),
    )
      .map((element) => {
        const style = getComputedStyle(element);
        return Math.max(
          durationMs(style.animationDuration),
          durationMs(style.transitionDuration),
        );
      })
      .reduce((max, value) => Math.max(max, value), 0);
  });
  expect(motion).toBeLessThanOrEqual(10.1);

  const firstRadio = viewRadio(page, "Connections");
  await firstRadio.focus();
  const focusStyle = await firstRadio.evaluate((element) => {
    const focusRingOwner = element.parentElement;
    if (!focusRingOwner) throw new Error("Choice-group label is missing.");
    const style = getComputedStyle(focusRingOwner);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
    };
  });
  expect(focusStyle.outlineStyle).not.toBe("none");
  expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(2);

  await expectNoHorizontalOverflow(page);
  expect(
    await seriousAxeViolations(page, { disableColorContrast: true }),
  ).toEqual([]);
  expectHarnessClean(harness);
  renderer.expectClean();
  await saveEvidence(
    page,
    testInfo,
    "integrations-forced-colors-reduced-motion-390",
  );
});
