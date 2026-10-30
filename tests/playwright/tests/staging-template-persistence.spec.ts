import { expect, test, type Page } from "@playwright/test";

/**
 * Opt-in staging write smoke. It only creates disposable records in the
 * dedicated staging account, deletes its campaign draft, and archives its
 * exact templates in finally. Archived templates remain recoverable.
 * Keep this separate from the read-only release smoke so CI never writes to a
 * shared environment by accident.
 */
const email = process.env.MOOSEWAVE_STAGING_TEST_EMAIL;
const password = process.env.MOOSEWAVE_STAGING_TEST_PASSWORD;
const writesEnabled = process.env.MOOSEWAVE_STAGING_WRITE_SMOKE === "1";

async function browserMutation(
  page: Page,
  path: string,
  method: "DELETE" | "PATCH",
  etag?: string,
): Promise<number> {
  // Session-cookie mutations require the browser's same-origin Origin header.
  // Playwright's APIRequestContext omits it, which correctly earns a CSRF 403.
  return page.evaluate(async ({ path, method, etag }) => {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: etag ? { "If-Match": etag } : undefined,
    });
    return response.status;
  }, { path, method, etag });
}

test.describe("staging template persistence", () => {
  test.use({ baseURL: "https://app.staging.moosewave.com", serviceWorkers: "block" });
  test.skip(!email || !password || !writesEnabled,
    "Set disposable staging credentials and MOOSEWAVE_STAGING_WRITE_SMOKE=1.");

  test("create, reopen, edit, duplicate, and create a campaign draft", async ({ page }) => {
    const runID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const name = `QA template ${runID}`;
    const updatedName = `${name} edited`;
    const subject = `QA subject ${runID}`;
    const templateIDs: string[] = [];
    let campaignID: string | undefined;

    await page.goto("/login?next=%2Fapp%2Ftemplates%2Fnew%3Fmode%3Dimport");
    await page.getByLabel("Email").fill(email!);
    await page.getByLabel("Password", { exact: true }).fill(password!);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    try {
      await expect(page.getByRole("heading", { name: "Create template" })).toBeVisible({ timeout: 30_000 });
      await page.getByLabel("Import HTML or MJML file").setInputFiles({
        name: "qa-template.html",
        mimeType: "text/html",
        buffer: Buffer.from(`<!doctype html><html><body><h1>${name}</h1><p>Safe staging QA.</p></body></html>`),
      });
      const importConfirmation = page.getByRole("dialog", { name: "Replace template source?" });
      await importConfirmation.getByRole("button", { name: "Replace source" }).click();
      await expect(importConfirmation).toBeHidden();
      await expect(page.getByLabel("HTML source")).toHaveValue(new RegExp(name));
      await page.getByLabel("Name", { exact: true }).fill(name);
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue(name);
      await page.getByLabel("Subject", { exact: true }).fill(subject);
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue(name);
      await expect(page.getByLabel("Subject", { exact: true })).toHaveValue(subject);

      const createResponsePromise = page.waitForResponse((response) =>
        response.url().endsWith("/api/v1/campaign-templates") &&
        response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Create template" }).first().click();
      const createResponse = await createResponsePromise;
      expect(createResponse.status(), await createResponse.text()).toBe(201);
      const created = await createResponse.json() as { id: string };
      expect(created.id).toBeTruthy();
      templateIDs.push(created.id);
      await expect(page).toHaveURL(new RegExp(`/app/templates/${created.id}$`));
      await expect(page.getByRole("heading", { name })).toBeVisible();

      await page.reload();
      await expect(page.getByRole("heading", { name })).toBeVisible();
      await page.goto(`/app/templates/${created.id}/edit`);
      await expect(page.getByRole("heading", { name: "Edit template" })).toBeVisible();
      await page.getByLabel("Name", { exact: true }).fill(updatedName);
      const updateResponsePromise = page.waitForResponse((response) =>
        response.url().endsWith(`/api/v1/campaign-templates/${created.id}`) &&
        response.request().method() === "PATCH",
      );
      await page.getByRole("button", { name: "Save changes" }).first().click();
      const updateResponse = await updateResponsePromise;
      expect(updateResponse.ok(), await updateResponse.text()).toBe(true);
      await expect(page.getByRole("heading", { name: updatedName })).toBeVisible();

      await page.getByRole("button", { name: `Actions for ${updatedName}` }).click();
      const cloneResponsePromise = page.waitForResponse((response) =>
        response.url().includes(`/api/v1/campaign-templates/${created.id}/clone`) &&
        response.request().method() === "POST",
      );
      await page.getByRole("menuitem", { name: "Duplicate" }).click();
      const cloneResponse = await cloneResponsePromise;
      expect(cloneResponse.ok(), await cloneResponse.text()).toBe(true);
      const cloned = await cloneResponse.json() as { id: string };
      expect(cloned.id).toBeTruthy();
      templateIDs.push(cloned.id);
      await expect(page).toHaveURL(new RegExp(`/app/templates/${cloned.id}$`));

      await page.getByRole("button", { name: "Use template" }).click();
      await expect(page.getByRole("dialog", { name: new RegExp("Start from") })).toBeVisible();
      const campaignResponsePromise = page.waitForResponse((response) =>
        response.url().includes("/api/v1/campaigns") &&
        response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Create campaign draft" }).click();
      const campaignResponse = await campaignResponsePromise;
      expect(campaignResponse.ok(), await campaignResponse.text()).toBe(true);
      const campaign = await campaignResponse.json() as { id: string };
      expect(campaign.id).toBeTruthy();
      campaignID = campaign.id;
      await expect(page).toHaveURL(new RegExp(`/app/campaigns/${campaign.id}$`));
    } finally {
      const cleanupFailures: string[] = [];
      if (campaignID) {
        try {
          const status = await browserMutation(page, `/api/v1/campaigns/${encodeURIComponent(campaignID)}`, "DELETE");
          if (status !== 204) cleanupFailures.push(`campaign ${campaignID}: HTTP ${status}`);
        } catch (error) {
          cleanupFailures.push(`campaign ${campaignID}: ${String(error)}`);
        }
      }
      for (const id of templateIDs.reverse()) {
        try {
          const current = await page.request.get(`/api/v1/campaign-templates/${encodeURIComponent(id)}`);
          if (!current.ok()) throw new Error(`read: HTTP ${current.status()}`);
          const template = await current.json() as { etag?: string; archived_at?: string };
          if (!template.archived_at) {
            if (!template.etag) throw new Error("no concurrency token");
            const status = await browserMutation(page,
              `/api/v1/campaign-templates/${encodeURIComponent(id)}/archive`, "PATCH", template.etag);
            if (status !== 200) throw new Error(`archive: HTTP ${status}`);
          }
        } catch (error) {
          cleanupFailures.push(`template ${id}: ${String(error)}`);
        }
      }
      if (cleanupFailures.length) {
        throw new Error(`Staging QA cleanup incomplete: ${cleanupFailures.join("; ")}`);
      }
    }
  });
});
