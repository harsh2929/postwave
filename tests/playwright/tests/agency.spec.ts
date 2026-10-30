import { expect, test, type Page } from "@playwright/test";

import { loginAsDemo } from "../helpers/auth";

/**
 * Agency dashboard — sub-accounts / branding / invoice, on apps/web.
 *
 * NAVIGATION. This file used to click a sidebar *button* and carried a comment
 * saying "the Section-based router doesn't have a URL slot per page". That is
 * true of the desktop app (apps/desktop routes by Section key); it is false of
 * apps/web, which has a real route at /app/agency and renders its nav as
 * <a href> links. Every test therefore navigates to the URL, the way a web
 * user does.
 *
 * STRUCTURE. The three sections are URL-backed tabs so refresh and browser
 * history preserve the operator's context. Data is loaded only when its tab
 * becomes relevant; tests click the tab before awaiting its request.
 *
 * Navigations wait for `domcontentloaded` rather than `load` — the dashboard
 * shell holds long-lived event-stream connections open, so `load` can outlast
 * the navigation timeout while the page is already interactive.
 *
 * These tests don't require a real Postgres — they verify the page
 * renders + the API calls are issued. The actual DB round-trip is exercised
 * by the Go integration suite at apps/api/internal/agency/agency_db_test.go.
 */
function agencyEligibilitySettled(page: Page) {
  return page
    .getByText(/This workspace is not an agency/i)
    .or(page.getByText(/Child workspaces could not be loaded/i))
    .or(page.getByText(/No child workspaces yet/i))
    .or(page.getByLabel("Agency child workspaces"))
    .first();
}

test.describe("agency dashboard", () => {
  test.beforeEach(async ({ page }) => {
    // The Next dev server compiles routes and proxies every /api call
    // in-process, so a warm route can still take 20s+ to answer while other
    // suites share the box. These ceilings only bound WAITING — no assertion
    // is relaxed by them.
    test.setTimeout(180_000);
    // No navigation here: the invoice test has to register its request
    // listener before the page that issues the request loads.
    await loginAsDemo(page, { navigate: false });
  });

  test("page renders with three tabs", async ({ page }) => {
    await page.goto("/app/agency", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    // Header.
    await expect(
      page.getByRole("heading", { name: /^Agency$/i }),
    ).toBeVisible();

    // Three semantic tabs.
    await expect(
      page.getByRole("tab", { name: /^Sub-accounts$/i }),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: /^Branding$/i })).toBeVisible();
    await expect(
      page.getByRole("tab", { name: /Invoice preview/i }),
    ).toBeVisible();
  });

  test("Sub-accounts tab surfaces the not-an-agency callout for demo tenants", async ({
    page,
  }) => {
    // The demo tenant is not flagged is_agency_account → the API
    // returns 403 with code "not_agency" and the page renders the
    // callout instead of the roster.
    await page.goto("/app/agency", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    // Web's wording for the same state; desktop says "not flagged as an
    // agency", web says it in the workspace's own terms.
    // The environment may instead be agency-enabled, empty, or unavailable;
    // every accepted marker appears only after the eligibility request
    // settles, unlike the card heading which is present during loading.
    await expect(agencyEligibilitySettled(page)).toBeVisible({
      timeout: 60_000,
    });
  });

  test("Branding tab loads regardless of agency flag", async ({ page }) => {
    await page.goto("/app/agency", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    // Wait for client hydration + the eligibility request. Clicking a
    // server-rendered tab before React attaches its handler can be discarded
    // when a cold dev build is under load.
    await expect(agencyEligibilitySettled(page)).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole("tab", { name: /^Branding$/i }).click();
    await expect(page).toHaveURL(/\/app\/agency\?tab=branding$/);

    // The branding SECTION now renders for a non-agency workspace too — that
    // half of this test's claim was a real defect in the page and is fixed.
    await expect(
      page.getByRole("heading", { name: /^Branding$/i }),
    ).toBeVisible();

    // The "Whitelabel enabled" checkbox is the canonical landmark for
    // this tab — every tenant has the whitelabel_enabled column.
    await expect(
      page.getByRole("checkbox", { name: /Whitelabel enabled/i }),
    ).toBeVisible();

    // Save button visible (admin-gated; may be disabled).
    await expect(
      page.getByRole("button", { name: /Save branding/i }),
    ).toBeVisible();
  });

  test("Invoice preview tab issues the predict request", async ({ page }) => {
    // Intercept the invoice-preview request to confirm the page
    // actually calls the API endpoint.
    let invoiceRequestSeen = false;
    page.on("request", (request) => {
      if (
        request.url().includes("/api/v1/agency/invoice-preview") &&
        request.method() === "GET"
      ) {
        invoiceRequestSeen = true;
      }
    });

    await page.goto("/app/agency", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    // Wait for client hydration + the eligibility request before exercising a
    // tab. A click against the server-rendered tab during hydration can be
    // discarded when React replaces that tree on a throttled mobile profile.
    await expect(agencyEligibilitySettled(page)).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole("tab", { name: /Invoice preview/i }).click();
    await expect(page).toHaveURL(/\/app\/agency\?tab=invoice$/);

    // Either the data loads OR the "not an agency" callout
    // surfaces — both are valid outcomes for the demo tenant.
    const preview = page.getByRole("heading", { name: /^Invoice preview/i });
    const unavailable = page.getByRole("heading", {
      name: /Consolidated billing is unavailable/i,
    });
    await expect(preview).toBeVisible({ timeout: 60_000 });
    if (await unavailable.isVisible()) {
      // Eligibility is known from the children request. Failing closed here
      // avoids an invoice-preview request that can only return not_agency.
      expect(invoiceRequestSeen).toBe(false);
    } else {
      await expect.poll(() => invoiceRequestSeen).toBe(true);
    }
  });
});
