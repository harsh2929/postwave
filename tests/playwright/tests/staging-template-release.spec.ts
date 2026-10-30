import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const stagingUrl = "https://app.staging.moosewave.com";
const email = process.env.MOOSEWAVE_STAGING_TEST_EMAIL;
const password = process.env.MOOSEWAVE_STAGING_TEST_PASSWORD;

test.describe("authenticated staging template release", () => {
  test.use({ baseURL: stagingUrl, serviceWorkers: "allow" });
  test.skip(!email || !password, "Set disposable staging test credentials to run this release smoke.");

  test("library, visual editor, import, and unavailable AI work without browser errors", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.stack ?? error.message));

    await page.goto("/login?next=%2Fapp%2Ftemplates");
    await page.getByLabel("Email").fill(email!);
    await page.getByLabel("Password", { exact: true }).fill(password!);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Newsletter templates" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("link", { name: "Start with blocks" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Import HTML/MJML" })).toBeVisible();
    await expect(page.getByRole("button", { name: /AI designs · Coming soon|AI temporarily unavailable/ })).toBeDisabled();

    const firstDesign = page.getByRole("link", { name: "View design" }).first();
    if (await firstDesign.count()) {
      await firstDesign.click();
      await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
      await page.goto("/app/templates");
    }

    await page.getByRole("link", { name: "Start with blocks" }).click();
    await expect(page.getByRole("heading", { name: "Create template" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Design (blocks)" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Preview text")).toBeHidden();
    const accessibility = await new AxeBuilder({ page })
      .include("main")
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(accessibility.violations.filter((issue) =>
      issue.impact === "serious" || issue.impact === "critical"
    )).toEqual([]);

    await page.goto("/app/templates/new?mode=import");
    await expect(page.getByRole("button", { name: "Code / import" })).toHaveAttribute("aria-pressed", "true");
    await page.getByLabel("Import HTML or MJML file").setInputFiles({
      name: "staging-release-smoke.html",
      mimeType: "text/html",
      buffer: Buffer.from("<!doctype html><html><body><h1>Moosewave smoke</h1></body></html>"),
    });
    const confirmation = page.getByRole("dialog", { name: "Replace template source?" });
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "Replace source" }).click();
    await expect(page.getByLabel("HTML source")).toHaveValue(/Moosewave smoke/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

    let createPayload: Record<string, unknown> | null = null;
    await page.route("**/api/v1/campaign-templates", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      createPayload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: "staging-smoke-not-created" }),
      });
    });
    await page.getByLabel("Name", { exact: true }).fill("Staging release smoke — not saved");
    await page.getByLabel("Subject", { exact: true }).fill("A staging release smoke test");
    await page.getByRole("button", { name: "Create template" }).first().click();
    await expect.poll(() => createPayload).not.toBeNull();
    expect(createPayload).toMatchObject({
      name: "Staging release smoke — not saved",
      subject: "A staging release smoke test",
      body_html: expect.stringContaining("Moosewave smoke"),
    });

    expect(pageErrors).toEqual([]);
  });
});
