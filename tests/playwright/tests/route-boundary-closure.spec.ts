import { expect, test, type Page } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const UNKNOWN_PUBLIC_PATH = "/definitely-not-a-postwave-route-20260827";
const UNKNOWN_MARKETING_PATH =
  "/integrations/definitely-not-a-postwave-integration-20260827";
const UNKNOWN_TEMPLATE_PATH =
  "/app/templates/definitely-not-a-postwave-template-20260827";
const UNKNOWN_TEMPLATE_RESOURCE_PATH =
  "/api/v1/campaign-templates/definitely-not-a-postwave-template-20260827";

async function useCertificationViewport(
  page: Page,
  projectName: string,
): Promise<void> {
  if (projectName.includes("mobile")) {
    await page.setViewportSize({ width: 320, height: 720 });
  }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
}

async function expectPhoneSized(
  target: ReturnType<Page["locator"]>,
): Promise<void> {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
}

test.describe("route error and not-found closure", () => {
  test("global public 404 stays public, labelled, and usable at 320px", async ({
    page,
  }, testInfo) => {
    await useCertificationViewport(page, testInfo.project.name);
    const response = await page.goto(UNKNOWN_PUBLIC_PATH, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });

    expect(response?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "We couldn't find that page." }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Back to dashboard" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Request access" }),
    ).toHaveAttribute("href", "/signup");

    const skip = page.getByRole("link", { name: "Skip to content" });
    await skip.focus();
    await skip.click();
    await expect(page.locator("#not-found-main")).toBeFocused();
    await expectPhoneSized(page.getByRole("link", { name: "Back to home" }));
    await expectNoHorizontalOverflow(page);
  });

  test("marketing dynamic 404 retains marketing chrome and recovery", async ({
    page,
  }, testInfo) => {
    await useCertificationViewport(page, testInfo.project.name);
    const response = await page.goto(UNKNOWN_MARKETING_PATH, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });

    expect(response?.status()).toBe(404);
    await expect(
      page.getByRole("heading", { name: "We couldn't find that page." }),
    ).toBeVisible();
    await expect(page.locator("main#main-content")).toHaveAttribute(
      "tabindex",
      "-1",
    );
    await expect(
      page.getByRole("link", { name: "Back to home" }),
    ).toHaveAttribute("href", "/");
    await expect(
      page.getByRole("link", { name: "Browse features" }),
    ).toHaveAttribute("href", "/features");
    await expectNoHorizontalOverflow(page);
  });

  test("dashboard resource 404 remains inside the workspace with a safe exit", async ({
    page,
  }, testInfo) => {
    await useCertificationViewport(page, testInfo.project.name);
    await loginAsDemo(page, { navigate: false });

    // Keep the resource contract honest even when the App Router streams the
    // workspace shell. Next intentionally returns 200 for a streamed
    // notFound() after response headers have been sent, while preserving the
    // not-found marker and noindex directive in the document. The underlying
    // resource endpoint must still be an actual HTTP 404.
    // https://nextjs.org/docs/app/api-reference/file-conventions/not-found
    const resourceResponse = await page
      .context()
      .request.get(UNKNOWN_TEMPLATE_RESOURCE_PATH);
    expect(resourceResponse.status()).toBe(404);
    await expect(resourceResponse.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });

    const response = await page.goto(UNKNOWN_TEMPLATE_PATH, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });

    expect(response).not.toBeNull();
    if (response?.status() === 200) {
      await expect(
        page.locator('meta[name="next-error"]'),
        "a streamed 200 must retain Next's machine-readable not-found marker",
      ).toHaveAttribute("content", "not-found");
      await expect(
        page.locator('meta[name="robots"]'),
        "a streamed 200 must remain excluded from indexing",
      ).toHaveAttribute("content", /(?:^|,\s*)noindex(?:,|$)/u);
    } else {
      expect(response?.status()).toBe(404);
    }
    await expect(
      page.getByRole("heading", { name: "This page is not available." }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "We couldn't find that page." }),
    ).toHaveCount(0);
    const recovery = page.getByRole("link", { name: "Back to dashboard" });
    await expect(recovery).toHaveAttribute("href", "/app");
    await expectPhoneSized(recovery);
    await expectNoHorizontalOverflow(page);
  });
});
