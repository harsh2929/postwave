import { expect, test, type Page } from "@playwright/test";

const CHROMIUM_PROJECTS = new Set(["chromium-desktop", "chromium-mobile"]);
const RETIRED_CATALOG =
  /Studio Lifetime|Cloud Sending|Pro Sending|unlimited (?:AI|voice|Inbox Reality)/i;

function collectRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

test.describe("launch commercial gating", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(
      !CHROMIUM_PROJECTS.has(testInfo.project.name),
      "The release gate needs one desktop and one phone browser.",
    );
  });

  test("pricing publishes the finite catalog while paid checkout stays closed", async ({
    page,
  }) => {
    const runtimeErrors = collectRuntimeErrors(page);
    const response = await page.goto("/pricing", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });

    expect(response?.status()).toBeLessThan(400);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Predictable plans. Hard limits. No surprise bill.",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("body")).not.toContainText(RETIRED_CATALOG);

    await expect(
      page.getByRole("link", { name: "Request Sandbox access" }),
    ).toHaveAttribute("href", "/signup");

    for (const tier of ["Launch", "Growth", "Scale"] as const) {
      const link = page.getByRole("link", {
        name: `Join the ${tier} waitlist`,
      });
      const expectedTier = tier.toLowerCase();
      await expect(link).toHaveAttribute(
        "href",
        `mailto:sales@moosewave.com?subject=${encodeURIComponent(
          `Moosewave ${expectedTier} waitlist`,
        )}`,
      );
    }

    await expect(
      page.getByText(
        "Self-serve checkout is closed during production qualification. No payment is collected on the waitlist.",
      ),
    ).toHaveCount(3);
    await expect(page.getByLabel("Work email for checkout")).toHaveCount(0);

    const sizing = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      body: document.body.scrollWidth,
      main: document.querySelector("main")?.scrollWidth ?? 0,
    }));
    expect(Math.max(sizing.body, sizing.main)).toBeLessThanOrEqual(
      sizing.viewport + 1,
    );
    expect(runtimeErrors).toEqual([]);
  });

  for (const query of [
    "",
    "?session_id=attacker-controlled&card=4111111111111111",
  ]) {
    test(`checkout return fails closed for ${query || "a missing receipt"}`, async ({
      page,
    }) => {
      const runtimeErrors = collectRuntimeErrors(page);
      const response = await page.goto(`/pricing/success${query}`, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });

      expect(response?.status()).toBeLessThan(400);
      await expect(
        page.getByRole("heading", {
          level: 1,
          name: "We can't verify a payment from this page.",
        }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("body")).not.toContainText(
        /attacker-controlled|4111111111111111|Payment received|provisioning your workspace/i,
      );
      await expect(
        page.getByRole("link", { name: "Check billing status" }),
      ).toHaveAttribute("href", "/app/billing");
      await expect(
        page.getByRole("link", { name: "Back to pricing" }),
      ).toHaveAttribute("href", "/pricing");
      expect(runtimeErrors).toEqual([]);
    });
  }
});
