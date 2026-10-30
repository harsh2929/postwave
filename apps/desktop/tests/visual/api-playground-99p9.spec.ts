import type { Locator, Page } from "@playwright/test";

import {
  expectHarnessClean,
  expectNoPlaygroundOverflow,
  observePlaygroundRenderer,
  openAPIPlayground,
  PRIVATE_BODY_VALUE,
  PRIVATE_HEADER_VALUE,
  savePlaygroundEvidence,
  seriousPlaygroundAxeViolations,
  type PlaygroundVisualHarness,
} from "./api-playground-99p9-harness";
import { expect, test } from "./fixture";

function endpointOption(page: Page, summary: string): Locator {
  return page.locator(".play-endpoint-option").filter({ hasText: summary });
}

function latestPlaygroundRequest(
  harness: PlaygroundVisualHarness,
  method: string,
) {
  return [...harness.playgroundRequests]
    .reverse()
    .find((request) => request.method === method);
}

test.use({ locale: "en-US", timezoneId: "UTC" });
test.describe.configure({ mode: "serial", timeout: 180_000 });

for (const variant of [
  { theme: "light", width: 1440, height: 960 },
  { theme: "dark", width: 1440, height: 960 },
  { theme: "dark", width: 1024, height: 900 },
  { theme: "light", width: 390, height: 844 },
] as const) {
  test(`populated Explore is legible in ${variant.theme} at ${variant.width}px`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    const renderer = observePlaygroundRenderer(page);
    const harness = await openAPIPlayground(page, bootApp, setTheme, variant);

    await expect(page.getByLabel("Catalog status")).toContainText(
      "81Reference operations",
    );
    await expect(page.getByLabel("Catalog status")).toContainText(
      "6Reviewed runner",
    );
    await expect(page.getByLabel("Catalog status")).toContainText(
      "1Release-held",
    );
    await expect(
      page.getByRole("heading", { name: "List workspace tags" }),
    ).toBeVisible();
    await expect(
      page.getByText("Reviewed read", { exact: true }),
    ).toBeVisible();
    const renderedOperations = await page
      .getByLabel("Filtered API operations")
      .locator(".pw-windowed-list__item")
      .count();
    expect(renderedOperations).toBeGreaterThan(0);
    expect(renderedOperations).toBeLessThan(81);
    await expectNoPlaygroundOverflow(page);

    if (variant.width === 1440 && variant.theme === "light") {
      expect(await seriousPlaygroundAxeViolations(page)).toEqual([]);
    }
    expectHarnessClean(harness);
    renderer.expectClean();
    await savePlaygroundEvidence(
      page,
      testInfo,
      `api-playground-explore-${variant.theme}-${String(variant.width)}`,
    );
  });
}

test("search, filters, favorites, keyboard tabs, and Reference metadata stay exact", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observePlaygroundRenderer(page);
  const harness = await openAPIPlayground(page, bootApp, setTheme, {
    theme: "light",
    width: 1024,
    height: 900,
  });

  await page.getByLabel("Search endpoints").fill("Create a workspace tag");
  await page
    .getByRole("combobox", { name: "Method", exact: true })
    .selectOption("post");
  await page
    .getByRole("combobox", { name: "Availability", exact: true })
    .selectOption("runnable");
  await page
    .getByRole("combobox", { name: "Tag", exact: true })
    .selectOption("00 Workspace tags");
  await expect(page.getByText("1 / 81", { exact: true })).toBeVisible();
  const createTag = endpointOption(page, "Create a workspace tag");
  await expect(createTag).toHaveCount(1);
  await createTag
    .getByRole("button", {
      name: "Add POST /api/v1/tags to favorites",
    })
    .click();
  await page.getByLabel("Favorites only").check();
  await expect(page.locator(".play-endpoint-option")).toHaveCount(1);

  const favoriteRecords = await page.evaluate(() =>
    Object.keys(window.localStorage)
      .filter((key) => key.startsWith("pw_api_playground_favorites_v2:"))
      .map((key) => window.localStorage.getItem(key)),
  );
  expect(favoriteRecords).toHaveLength(1);
  expect(JSON.parse(favoriteRecords[0] ?? "[]")).toEqual(["POST /api/v1/tags"]);

  const exploreTab = page.getByRole("tab", { name: "Explore", exact: true });
  const referenceTab = page.getByRole("tab", {
    name: "API Reference",
    exact: true,
  });
  await exploreTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(referenceTab).toBeFocused();
  await expect(referenceTab).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Enter");
  await expect(referenceTab).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("region", { name: "API reference", exact: true }),
  ).toBeVisible();

  await page
    .getByLabel("Search API operations")
    .fill("Create release-held export");
  await expect(
    page.getByText("1 of 81 operations", { exact: true }),
  ).toBeVisible();
  const detail = page.locator(".pwar__detail");
  await expect(detail).toContainText("Create release-held export");
  await expect(detail).toContainText("Release hold");
  await expect(detail).toContainText(
    "Production export authority is not yet independently evidenced.",
  );
  await expect(detail).toContainText("bearerAuth");
  await expect(detail).toContainText("sessionCookie");
  await expect(detail).toContainText("write:exports, read:pii");
  await expect(detail).toContainText("Private response");
  await expectNoPlaygroundOverflow(page);
  expect(await seriousPlaygroundAxeViolations(page)).toEqual([]);
  expectHarnessClean(harness);
  renderer.expectClean();
  await savePlaygroundEvidence(
    page,
    testInfo,
    "api-playground-reference-held-metadata-1024",
    detail.locator(".pwar__badges"),
  );
});

test("reviewed read sends one bounded same-authority request and renders the response", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observePlaygroundRenderer(page);
  const harness = await openAPIPlayground(page, bootApp, setTheme, {
    theme: "light",
    width: 1440,
    height: 960,
  });

  await page.getByRole("button", { name: "Send reviewed read" }).click();
  const response = page.locator(".play-response");
  await expect(response).toContainText("Latest response");
  await expect(response).toContainText("200");
  const jsonResponse = response.locator(".play-json");
  const collapsedRows = jsonResponse.locator(
    '.play-json-disclosure[aria-expanded="false"]',
  );
  await expect(collapsedRows).toHaveCount(3);
  await collapsedRows.first().click();
  await expect(collapsedRows).toHaveCount(2);
  await collapsedRows.first().click();
  await expect(response).toContainText("Product");
  await expect(response).toContainText("Priority");
  await page.getByRole("tab", { name: /Headers/ }).click();
  await expect(
    page.getByRole("table", { name: "Response headers" }),
  ).toContainText("x-request-id");
  await expect(
    page.getByRole("table", { name: "Response headers" }),
  ).toContainText("route44-read-request");

  const receipt = latestPlaygroundRequest(harness, "GET");
  expect(receipt).toMatchObject({
    body: null,
    method: "GET",
    pathname: "/api/v1/tags",
    search: "?include_archived=false",
  });
  expect(receipt?.headers.authorization).toBeUndefined();
  expect(receipt?.headers.cookie).toBeUndefined();
  expect(harness.playgroundRequests).toHaveLength(1);
  await expectNoPlaygroundOverflow(page);
  expectHarnessClean(harness);
  renderer.expectClean();
  await savePlaygroundEvidence(
    page,
    testInfo,
    "api-playground-reviewed-read-response-1440",
    response.locator(".play-response-summary"),
  );
});

test("mutation review is exact and encrypted History retains no request values", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observePlaygroundRenderer(page);
  const harness = await openAPIPlayground(page, bootApp, setTheme, {
    theme: "dark",
    width: 1440,
    height: 960,
  });

  await page.getByLabel("Search endpoints").fill("Create a workspace tag");
  const createTag = endpointOption(page, "Create a workspace tag");
  await createTag.locator(".play-endpoint-select").click();
  const body = page.getByLabel("JSON request body for Create a workspace tag");
  await body.fill(
    JSON.stringify(
      {
        name: PRIVATE_BODY_VALUE,
        color: "teal",
      },
      null,
      2,
    ),
  );
  await page.getByRole("button", { name: "+ Add header" }).click();
  await page.getByLabel("Header name 1").fill("If-Match");
  await page.getByLabel("Header value 1").fill(PRIVATE_HEADER_VALUE);
  await page.getByRole("button", { name: "Review exact request" }).click();

  const review = page.getByRole("dialog", {
    name: "Review Create a workspace tag",
  });
  await expect(review).toBeVisible();
  await expect(review).toContainText(
    "POST /api/v1/tags @ 44444444-4444-4444-9444-444444444444",
  );
  await expect(review).toContainText("http://localhost:8080/api/v1/tags");
  await expect(review).toContainText(PRIVATE_BODY_VALUE);
  await expect(review).toContainText(PRIVATE_HEADER_VALUE);
  await expect(review).toContainText("Values and response bodies are not");
  await savePlaygroundEvidence(
    page,
    testInfo,
    "api-playground-exact-mutation-review-dark-1440",
  );
  await review.getByRole("button", { name: "Send mutation" }).click();
  await expect(page.locator(".play-response")).toContainText("201");

  const receipt = latestPlaygroundRequest(harness, "POST");
  expect(receipt?.pathname).toBe("/api/v1/tags");
  expect(receipt?.search).toBe("");
  expect(receipt?.body).toContain(PRIVATE_BODY_VALUE);
  expect(receipt?.headers["if-match"]).toBe(PRIVATE_HEADER_VALUE);
  expect(receipt?.headers.authorization).toBeUndefined();
  expect(receipt?.headers.cookie).toBeUndefined();
  expect(receipt?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/u);
  expect(receipt?.headers["x-postwave-event-seq"]).toMatch(/^[1-9]\d*$/u);

  const historyTab = page.getByRole("tab", {
    name: "History",
    exact: true,
  });
  await historyTab.click();
  await expect(historyTab).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("alertdialog", { name: "Leave API Playground?" }),
  ).toHaveCount(0);
  const historyEntry = page.getByRole("button", {
    name: /Replay POST \/api\/v1\/tags/,
  });
  await expect(historyEntry).toBeVisible();
  await expect(historyEntry).toContainText("body private");
  await expect(historyEntry).toContainText("headers private");
  await expect(historyEntry).toContainText("values private");
  await expect(page.locator(".play-history")).not.toContainText(
    PRIVATE_BODY_VALUE,
  );
  await expect(page.locator(".play-history")).not.toContainText(
    PRIVATE_HEADER_VALUE,
  );

  const storage = await page.evaluate(() =>
    Object.keys(window.localStorage).map((key) => ({
      key,
      value: window.localStorage.getItem(key) ?? "",
    })),
  );
  const historyCiphertext = storage.filter(({ key }) =>
    key.includes("api-playground-history-v2"),
  );
  expect(historyCiphertext).toHaveLength(1);
  expect(historyCiphertext[0]?.value).toMatch(
    /^route44-encrypted-envelope-\d+$/u,
  );
  expect(JSON.stringify(storage)).not.toContain(PRIVATE_BODY_VALUE);
  expect(JSON.stringify(storage)).not.toContain(PRIVATE_HEADER_VALUE);
  await savePlaygroundEvidence(
    page,
    testInfo,
    "api-playground-private-history-dark-1440",
  );

  await historyEntry.click();
  await expect(
    page.getByRole("tab", { name: "Explore", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(body).toHaveValue("");
  await expect(page.getByLabel("Header name 1")).toHaveCount(0);
  await expect(page.getByText("Safe replay draft opened")).toBeVisible();
  await expectNoPlaygroundOverflow(page);
  expectHarnessClean(harness);
  renderer.expectClean();
});

test("destructive review requires the exact resolved phrase", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const renderer = observePlaygroundRenderer(page);
  const harness = await openAPIPlayground(page, bootApp, setTheme, {
    theme: "light",
    width: 1024,
    height: 900,
  });

  await page.getByLabel("Search endpoints").fill("Delete a workspace tag");
  await endpointOption(page, "Delete a workspace tag")
    .locator(".play-endpoint-select")
    .click();
  await page.locator(".api-playground-param input").fill("tag-route44-visible");
  await page.getByRole("button", { name: "Review exact request" }).click();
  const dialog = page.getByRole("alertdialog", {
    name: "Review Delete a workspace tag",
  });
  const phrase =
    "DELETE /api/v1/tags/tag-route44-visible @ 44444444-4444-4444-9444-444444444444";
  await expect(dialog).toContainText(phrase);
  const confirm = dialog.getByRole("button", {
    name: "Run destructive request",
  });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("textbox").fill(`${phrase} `);
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("textbox").fill(phrase);
  await expect(confirm).toBeEnabled();
  await savePlaygroundEvidence(
    page,
    testInfo,
    "api-playground-destructive-exact-phrase-1024",
  );
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(harness.playgroundRequests).toHaveLength(0);
  expectHarnessClean(harness);
  renderer.expectClean();
});

test("forced colors, reduced motion, and keyboard focus preserve the workbench", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({
    colorScheme: "dark",
    forcedColors: "active",
    reducedMotion: "reduce",
  });
  const renderer = observePlaygroundRenderer(page);
  const harness = await openAPIPlayground(page, bootApp, setTheme, {
    theme: "dark",
    width: 1024,
    height: 900,
  });

  expect(
    await page.evaluate(() => ({
      forcedColors: matchMedia("(forced-colors: active)").matches,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    })),
  ).toEqual({ forcedColors: true, reducedMotion: true });
  await page.getByLabel("Search endpoints").focus();
  await page.keyboard.press("Tab");
  const method = page.getByRole("combobox", {
    name: "Method",
    exact: true,
  });
  await expect(method).toBeFocused();
  const focusStyle = await method.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  expect(focusStyle.outlineStyle).not.toBe("none");
  expect(focusStyle.outlineWidth).not.toBe("0px");
  const transitionSeconds = await page
    .locator(".play-endpoint-option")
    .first()
    .evaluate((element) =>
      getComputedStyle(element)
        .transitionDuration.split(",")
        .map((value) => Number.parseFloat(value))
        .filter(Number.isFinite),
    );
  expect(Math.max(...transitionSeconds)).toBeLessThanOrEqual(0.01);
  await expectNoPlaygroundOverflow(page);
  expectHarnessClean(harness);
  renderer.expectClean();
  await savePlaygroundEvidence(
    page,
    testInfo,
    "api-playground-forced-colors-reduced-motion-focus-1024",
  );
});
