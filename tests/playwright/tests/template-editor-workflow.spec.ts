import { expect, test } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

const HTML =
  '<!doctype html><html><body><main><h1>Moosewave digest</h1><p>One useful story.</p></main></body></html>';

test.describe("template authoring workflow", () => {
  test.beforeEach(async ({ page, request }) => {
    // The local browser stack can have an intentionally unmigrated database.
    // Keep unrelated shell polling from turning this editor-focused suite into
    // a notification/onboarding integration test.
    await page.route("**/api/v1/notifications?*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], unread_count: 0 }),
      }),
    );
    await page.route("**/api/v1/onboarding/steps", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ steps: {} }),
      }),
    );
    await page.addInitScript(() => {
      (
        window as typeof window & {
          __POSTWAVE_FORCE_REAL_API_FOR_E2E__?: boolean;
        }
      ).__POSTWAVE_FORCE_REAL_API_FOR_E2E__ = true;
    });
    // Next dev compiles this RSC route on demand. Warm it before typing so a
    // concurrent worker cannot trigger Fast Refresh during the first edit.
    const response = await request.get("/app/templates/new");
    expect(response.ok()).toBe(true);
  });

  test("starts in the visual editor and keeps optional details out of the way", async ({ page }) => {
    await loginAsDemo(page, { startPath: "/app/templates/new" });
    await expect(page.getByRole("button", { name: "Design (blocks)" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Preview text")).toBeHidden();
    await page.getByText("Template details and personalization").click();
    await expect(page.getByLabel("Preview text")).toBeVisible();
  });

  test("opens the import path directly in source mode", async ({ page }) => {
    await loginAsDemo(page, { startPath: "/app/templates/new?mode=import" });
    await expect(page.getByRole("button", { name: "Code / import" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("HTML source")).toBeVisible();
  });

  test("does not offer AI design when the API has not enabled it", async ({ page }) => {
    await page.route("**/api/v1/campaign-template-designs?*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [], generation_available: false }),
      }),
    );
    await loginAsDemo(page, { startPath: "/app/templates" });
    await expect(page.getByRole("button", { name: "AI designs · Coming soon" })).toBeDisabled();
  });

  test("imports HTML and submits the complete source", async ({
    page,
  }, testInfo) => {
    await loginAsDemo(page, { startPath: "/app/templates/new" });
    await expect(page.getByRole("heading", { name: "Create template" })).toBeVisible();

    const name = `Browser editor ${testInfo.project.name} ${Date.now()}`;
    let submitted: Record<string, unknown> | null = null;
    await page.route("**/api/v1/campaign-templates", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      submitted = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: "template-browser-contract" }),
      });
    });
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Subject", { exact: true }).fill("A useful weekly digest");
    await page.getByRole("button", { name: "Code / import" }).click();
    await page.getByLabel("Import HTML or MJML file").setInputFiles({
      name: "digest.html",
      mimeType: "text/html",
      buffer: Buffer.from(HTML),
    });
    const confirm = page.getByRole("dialog", { name: "Replace template source?" });
    await expect(confirm).toBeVisible();
    await confirm.getByRole("button", { name: "Replace source" }).click();
    await expect(page.getByLabel("HTML source")).toHaveValue(HTML);
    await page.getByRole("button", { name: "Create template" }).click();
    await expect.poll(() => submitted).not.toBeNull();
    expect(submitted).toMatchObject({
      name,
      subject: "A useful weekly digest",
      body_html: HTML,
      body_mjml: "",
    });
  });

  test("cross-client rendering is explicit and invalidates on source edits", async ({
    page,
  }) => {
    await loginAsDemo(page, { startPath: "/app/templates/new" });
    await page.getByRole("button", { name: "Code / import" }).click();
    let renderRequests = 0;
    await page.route("**/api/v1/render", async (route) => {
      renderRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ renders: [], cache_hit: false }),
      });
    });

    await page.getByLabel("HTML source").fill(HTML);
    await expect(page.getByLabel("HTML source")).toHaveValue(HTML);
    expect(renderRequests).toBe(0);
    await page.getByRole("button", { name: "Check client simulations" }).click();
    await expect(page.getByRole("heading", { name: "Mailbox simulations" })).toBeVisible();
    await expect.poll(() => renderRequests).toBe(1);

    await page.getByLabel("HTML source").fill(`${HTML}\n<!-- revised -->`);
    await expect(page.getByRole("heading", { name: "Mailbox simulations" })).toHaveCount(0);
    expect(renderRequests).toBe(1);
  });

  test("MJML source must compile before it can request mailbox renders", async ({
    page,
  }) => {
    await loginAsDemo(page, { startPath: "/app/templates/new" });
    await page.getByRole("button", { name: "Code / import" }).click();
    let renderRequests = 0;
    // The compile route requires a real pw_session even in the tenant-bypass
    // harness. Stub only that boundary; the separate route tests exercise its
    // authentication and real compiler contract.
    await page.route("**/api/mjml", async (route) => {
      const request = route.request().postDataJSON() as { mjml: string };
      const valid = request.mjml.trim().endsWith("</mjml>");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          html: valid ? HTML : "",
          errors: valid
            ? []
            : [{ message: "Unclosed MJML document", formattedMessage: "Unclosed MJML document" }],
        }),
      });
    });
    await page.route("**/api/v1/render", async (route) => {
      renderRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ renders: [], cache_hit: false }),
      });
    });
    await page.getByRole("button", { name: "MJML", exact: true }).click();
    const source = page.getByRole("textbox", { name: "MJML source", exact: true });
    const render = page.getByRole("button", { name: "Check client simulations" });
    await source.fill(
      "<mjml><mj-body><mj-section><mj-column><mj-text>Fresh MJML</mj-text></mj-column></mj-section></mj-body></mjml>",
    );
    await expect(render).toBeEnabled({ timeout: 20_000 });
    expect(renderRequests).toBe(0);
    await render.click();
    await expect.poll(() => renderRequests).toBe(1);
    await source.fill("<mjml><mj-body>");
    await expect(render).toBeDisabled();
    await expect(page.getByRole("heading", { name: "Mailbox simulations" })).toHaveCount(0);
    expect(renderRequests).toBe(1);
  });
});
