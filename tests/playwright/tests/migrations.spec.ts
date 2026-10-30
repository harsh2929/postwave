import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

import { mockCapabilities } from "../../../apps/web/src/lib/migration-mocks";
import {
  SOURCE_LABELS,
  type SourcePlatform,
} from "../../../apps/web/src/lib/types";
import { loginAsDemo } from "../helpers/auth";

const CAPABILITIES = mockCapabilities();
const BLOCKING_IMPACTS = new Set(["critical", "serious"]);

async function gotoHeading(
  page: Page,
  path: string,
  heading: string,
  expectedTitle: string,
) {
  const response = await page.goto(path, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  expect(response?.status() ?? 0, `${path}: document response`).toBeLessThan(
    400,
  );
  await expect(page.locator("main#main-content")).toHaveCount(1);
  const root = page.locator('#main-content [data-slot="page-transition"]');
  await expect(
    root.getByRole("heading", { level: 1, name: heading }),
  ).toBeVisible({
    timeout: 60_000,
  });
  // DashboardShell deliberately marks its server-rendered controls inert until
  // React owns them. Waiting on the public readiness contract prevents a fast
  // fill from targeting the truthful pre-hydration placeholder and then being
  // replaced when the controlled input hydrates.
  await expect(page.locator("[data-dashboard-hydrated]")).toHaveAttribute(
    "data-dashboard-hydrated",
    "true",
    { timeout: 60_000 },
  );
  await expect(root.getByText("Loading migration source…")).toHaveCount(0, {
    timeout: 60_000,
  });
  await expect(page).toHaveTitle(
    new RegExp(expectedTitle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"),
  );
  return root;
}

async function auditSurface(page: Page, path: string, mobile: boolean) {
  const root = page.locator('#main-content [data-slot="page-transition"]');
  const layout = await root.evaluate((routeRoot, requireTouchTargets) => {
    const visible = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const ids = Array.from(routeRoot.querySelectorAll<HTMLElement>("[id]")).map(
      (element) => element.id,
    );
    const undersized = requireTouchTargets
      ? Array.from(
          routeRoot.querySelectorAll<HTMLElement>(
            'button:not(:disabled), a[href], input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [role="button"]:not([aria-disabled="true"])',
          ),
        )
          .filter(visible)
          .map((element) => {
            const hitTarget =
              element instanceof HTMLInputElement &&
              ["checkbox", "radio"].includes(element.type)
                ? (element.closest<HTMLElement>("label") ?? element)
                : element;
            const rect = hitTarget.getBoundingClientRect();
            return {
              label:
                element.getAttribute("aria-label") ??
                element.textContent
                  ?.trim()
                  .replace(/\s+/gu, " ")
                  .slice(0, 70) ??
                element.tagName,
              width: Math.round(rect.width * 10) / 10,
              height: Math.round(rect.height * 10) / 10,
            };
          })
          .filter(({ width, height }) => width < 43.5 || height < 43.5)
      : [];
    const main = document.querySelector<HTMLElement>("main#main-content");
    const clipped = Array.from(routeRoot.querySelectorAll<HTMLElement>("*"))
      .filter((element) => {
        if (!visible(element)) return false;
        const rect = element.getBoundingClientRect();
        if (rect.left >= -1 && rect.right <= window.innerWidth + 1)
          return false;
        let parent = element.parentElement;
        while (parent && parent !== routeRoot) {
          if (
            ["auto", "scroll", "hidden", "clip"].includes(
              getComputedStyle(parent).overflowX,
            )
          ) {
            return false;
          }
          parent = parent.parentElement;
        }
        return true;
      })
      .slice(0, 10)
      .map((element) => ({
        tag: element.tagName,
        label:
          element.getAttribute("aria-label") ??
          element.textContent?.trim().replace(/\s+/gu, " ").slice(0, 70),
      }));
    return {
      mainCount: document.querySelectorAll("main").length,
      h1Count: routeRoot.querySelectorAll("h1").length,
      duplicateIds: ids.filter((id, index) => ids.indexOf(id) !== index),
      documentOverflow:
        Math.max(
          document.documentElement.scrollWidth,
          document.body.scrollWidth,
        ) - window.innerWidth,
      mainOverflow: main ? main.scrollWidth - main.clientWidth : -1,
      clipped,
      undersized,
    };
  }, mobile);

  const axe = await new AxeBuilder({ page })
    .include('#main-content [data-slot="page-transition"]')
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = axe.violations.filter(
    (violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact),
  );

  expect.soft(layout.mainCount, `${path}: one main`).toBe(1);
  expect.soft(layout.h1Count, `${path}: one h1`).toBe(1);
  expect.soft(layout.duplicateIds, `${path}: duplicate ids`).toEqual([]);
  expect
    .soft(layout.documentOverflow, `${path}: document overflow`)
    .toBeLessThanOrEqual(1);
  expect
    .soft(layout.mainOverflow, `${path}: main overflow`)
    .toBeLessThanOrEqual(1);
  expect.soft(layout.clipped, `${path}: clipped content`).toEqual([]);
  expect.soft(layout.undersized, `${path}: mobile touch targets`).toEqual([]);
  expect.soft(blocking, `${path}: blocking axe violations`).toEqual([]);
}

function credentialFieldName(source: SourcePlatform): RegExp {
  switch (source) {
    case "activecampaign":
      return /^API token$/iu;
    case "hubspot":
      return /private app access token/iu;
    case "mailerlite":
      return /MailerLite API token/iu;
    case "klaviyo":
      return /Klaviyo private API key/iu;
    case "customerio":
      return /Customer\.io App API key/iu;
    default:
      return /^API key$/iu;
  }
}

async function expectConnectionBranch(
  page: Page,
  source: SourcePlatform,
  authMethod: "oauth2" | "api_key" | "csv_upload",
) {
  if (authMethod === "oauth2") {
    await expect(
      page.getByRole("button", {
        name: `Continue with ${SOURCE_LABELS[source]}`,
      }),
    ).toBeVisible();
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    return;
  }
  if (authMethod === "api_key") {
    await expect(page.getByLabel(credentialFieldName(source))).toBeVisible();
    return;
  }
  await expect(
    page.getByRole("button", { name: "Choose or drop a file to upload" }),
  ).toBeVisible();
}

function completedCsvJob(jobId: string) {
  const now = new Date().toISOString();
  return {
    id: jobId,
    tenant_id: "tenant_local",
    source: "csv",
    status: "completed",
    progress: {
      subscribers_total: 2,
      subscribers_done: 2,
      segments_total: 0,
      segments_done: 0,
      automations_total: 0,
      automations_done: 0,
      archive_total: 0,
      archive_done: 0,
      paid_subs_total: 0,
      paid_subs_done: 0,
    },
    cursor: {},
    started_at: now,
    completed_at: now,
    rollback_until: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    verification_report: {
      subscribers_imported: 2,
      suppression_list_size: 0,
      custom_fields_mapped: ["name"],
      custom_fields_unmapped: [],
      segments_translated: 0,
      segments_with_warnings: [],
      automations_translated: 0,
      automations_unsupported: [],
      paid_subs_imported: 0,
      archive_imported: 0,
      data_loss_estimate_pct: 0,
    },
    error: null,
  };
}

test.describe.serial("migration surface quality", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      }),
    );
    await loginAsDemo(page, { navigate: false });
  });

  for (const viewport of [
    { label: "desktop", width: 1280, height: 900 },
    { label: "320px", width: 320, height: 800 },
  ]) {
    test(`${viewport.label}: source catalogue is complete, searchable, and accessible`, async ({
      page,
    }) => {
      test.slow();
      await page.setViewportSize(viewport);
      await gotoHeading(page, "/app/migrations", "Migrations", "Migrations");

      const picker = page.getByTestId("migration-source-picker");
      for (const capability of CAPABILITIES) {
        await expect(
          picker.getByTestId(`source-${capability.source}`),
        ).toBeVisible();
      }

      await page.getByLabel("Search migration sources").fill("Klaviyo");
      await expect(picker.getByTestId("source-klaviyo")).toBeVisible();
      await expect(picker.locator('[data-testid^="source-"]')).toHaveCount(1);
      await page.getByLabel("Search migration sources").clear();

      const klaviyoCard = picker.locator(
        '[aria-labelledby="migration-source-klaviyo-title"]',
      );
      const details = klaviyoCard.getByRole("button", { name: "Details" });
      await details.click();
      await expect(
        klaviyoCard.getByRole("button", { name: "Show less" }),
      ).toHaveAttribute("aria-expanded", "true");
      if (viewport.width === 320) {
        const capabilities = klaviyoCard.getByRole("button", {
          name: "Capabilities",
        });
        await capabilities.click();
        await expect(capabilities).toHaveAttribute("aria-expanded", "true");
      }

      await auditSurface(page, "/app/migrations", viewport.width === 320);
    });

    test(`${viewport.label}: every one of the 20 source routes renders its real connection branch`, async ({
      page,
    }) => {
      test.slow();
      test.setTimeout(600_000);
      await page.setViewportSize(viewport);

      for (const capability of CAPABILITIES) {
        const path = `/app/migrations/new/${capability.source}`;
        await gotoHeading(
          page,
          path,
          `Migrate from ${SOURCE_LABELS[capability.source]}`,
          "New migration",
        );
        await expectConnectionBranch(
          page,
          capability.source,
          capability.auth_method,
        );
        await auditSurface(page, path, viewport.width === 320);
      }
    });

    test(`${viewport.label}: direct redirect, invalid source, callback, and job-detail routes are certified`, async ({
      page,
    }) => {
      test.slow();
      test.setTimeout(240_000);
      await page.setViewportSize(viewport);

      await page.goto("/app/migrations/new");
      await expect(page).toHaveURL(/\/app\/migrations$/u);
      await expect(
        page.getByRole("heading", { level: 1, name: "Migrations" }),
      ).toBeVisible();
      await expect(page).toHaveTitle(/Migrations/iu);
      await auditSurface(
        page,
        "/app/migrations/new → /app/migrations",
        viewport.width === 320,
      );

      await gotoHeading(
        page,
        "/app/migrations/new/not-a-provider",
        "Unsupported migration source",
        "New migration",
      );
      await expect(page.getByText("not-a-provider")).toBeVisible();
      await auditSurface(
        page,
        "/app/migrations/new/not-a-provider",
        viewport.width === 320,
      );

      await gotoHeading(
        page,
        "/app/migrations/oauth/callback?error=access_denied&source=mailchimp",
        "Connection needs attention",
        "Migration connection",
      );
      await expect(page.getByText(/You declined access/iu)).toBeVisible();
      await auditSurface(
        page,
        "/app/migrations/oauth/callback",
        viewport.width === 320,
      );

      const certificationJob = completedCsvJob("job_csv_certification");
      await page.route("**/api/v1/migrations/job_csv_certification", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(certificationJob),
        }),
      );
      await page.route(
        "**/api/v1/migrations/job_csv_certification/events",
        (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/event-stream",
            headers: { "cache-control": "no-cache" },
            body: `event: done\ndata: ${JSON.stringify({
              status: "completed",
              resources: {
                subscribers: { imported: 2, skipped: 0, failed: 0 },
              },
              job: certificationJob,
            })}\n\n`,
          }),
      );
      await gotoHeading(
        page,
        "/app/migrations/job_csv_certification",
        "CSV upload migration",
        "Migration details",
      );
      await auditSurface(
        page,
        "/app/migrations/job_csv_certification",
        viewport.width === 320,
      );
    });
  }

  test("320px: OAuth, API-key, and file entry failures recover without duplicate work", async ({
    page,
  }) => {
    test.slow();
    test.setTimeout(240_000);
    await page.addInitScript(() => {
      (
        window as typeof window & {
          __POSTWAVE_FORCE_REAL_API_FOR_E2E__?: boolean;
        }
      ).__POSTWAVE_FORCE_REAL_API_FOR_E2E__ = true;
    });
    await page.setViewportSize({ width: 320, height: 800 });
    await page.route("**/api/v1/migrations/sources", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(CAPABILITIES),
      }),
    );

    let oauthStarts = 0;
    await page.route(
      "**/api/v1/migrations/mailchimp/oauth/start",
      async (route) => {
        oauthStarts += 1;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            authorize_url: "javascript:alert(document.cookie)",
            state: "unsafe-state",
          }),
        });
      },
    );
    await gotoHeading(
      page,
      "/app/migrations/new/mailchimp",
      "Migrate from Mailchimp",
      "New migration",
    );
    const oauth = page.getByRole("button", {
      name: "Continue with Mailchimp",
    });
    await oauth.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    const oauthAlert = page.getByRole("alert").filter({
      hasText: "unsafe OAuth URL",
    });
    await expect(oauthAlert).toBeVisible();
    await expect(oauthAlert).toBeFocused();
    expect(oauthStarts).toBe(1);
    await expect
      .poll(() =>
        page.evaluate(() => sessionStorage.getItem("postwave:oauth-pending")),
      )
      .toBeNull();
    await auditSurface(page, "/app/migrations/new/mailchimp error", true);

    let credentialAttempts = 0;
    await page.route(
      "**/api/v1/migrations/customerio/credentials",
      async (route) => {
        credentialAttempts += 1;
        await route.fulfill({
          status: 422,
          contentType: "text/plain",
          body: "Workspace token was rejected",
        });
      },
    );
    await gotoHeading(
      page,
      "/app/migrations/new/customerio",
      "Migrate from Customer.io",
      "New migration",
    );
    await page.getByLabel(/Customer\.io App API key/iu).fill("app-secret");
    await page.getByLabel(/Workspace ID/iu).fill("12345");
    await page.getByLabel("App API region").selectOption("eu");
    const connect = page.getByRole("button", { name: "Connect" });
    await connect.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
    const apiAlert = page.getByRole("alert").filter({
      hasText: "Workspace token was rejected",
    });
    await expect(apiAlert).toBeVisible();
    await expect(apiAlert).toBeFocused();
    expect(credentialAttempts).toBe(1);
    await page
      .getByLabel(/Customer\.io App API key/iu)
      .fill("replacement-secret");
    await expect(apiAlert).toHaveCount(0);
    await auditSurface(page, "/app/migrations/new/customerio error", true);

    await gotoHeading(
      page,
      "/app/migrations/new/substack",
      "Migrate from Substack",
      "New migration",
    );
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "substack-export.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("not-an-archive"),
    });
    const fileAlert = page.getByRole("alert").filter({
      hasText: "official Substack ZIP",
    });
    await expect(fileAlert).toBeVisible();
    await expect(fileAlert).toBeFocused();
    await fileInput.setInputFiles({
      name: "substack-export.zip",
      mimeType: "application/zip",
      buffer: Buffer.from("zip-content"),
    });
    await expect(
      page.getByRole("button", { name: "Use this file" }),
    ).toBeEnabled();
    await expect(fileAlert).toHaveCount(0);
    await auditSurface(page, "/app/migrations/new/substack selected", true);
  });

  test("OAuth callback succeeds once and then rejects replay", async ({
    page,
  }) => {
    await page.goto("/app/migrations");
    await page.evaluate(() => {
      sessionStorage.setItem(
        "postwave:oauth-pending",
        JSON.stringify({ source: "mailchimp", startedAt: Date.now() }),
      );
    });

    const callback =
      "/app/migrations/oauth/callback?code=provider-code&state=nonce&source=mailchimp";
    await page.goto(callback);
    await expect(page).toHaveURL(
      /\/app\/migrations\/new\/mailchimp\?step=discover&job_id=/u,
      { timeout: 30_000 },
    );
    await expect(
      page.getByRole("heading", { level: 1, name: "Migrate from Mailchimp" }),
    ).toBeVisible();
    await expect(page).toHaveTitle(/New migration/iu);

    await page.goto(callback);
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Connection needs attention",
      }),
    ).toBeVisible();
    await expect(page.getByText(/no pending OAuth flow/iu)).toBeVisible();
  });

  test("CSV upload, column confirmation, dry-run, import progress, and done state work end to end", async ({
    page,
  }) => {
    test.slow();
    test.setTimeout(180_000);
    await page.route("**/api/v1/migrations/*/events", async (route: Route) => {
      const segments = new URL(route.request().url()).pathname.split("/");
      const jobId = segments.at(-2) ?? "job_csv_certification";
      const job = completedCsvJob(jobId);
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
        body: [
          `event: progress\ndata: ${JSON.stringify({
            resource: "subscribers",
            completed: 1,
            total: 2,
            current_step: "Importing subscribers",
            snapshot: { ...job.progress, subscribers_done: 1 },
            at: new Date().toISOString(),
          })}\n\n`,
          `event: done\ndata: ${JSON.stringify({
            status: "completed",
            resources: { subscribers: { imported: 2, skipped: 0, failed: 0 } },
            job,
          })}\n\n`,
        ].join(""),
      });
    });

    await gotoHeading(
      page,
      "/app/migrations/new/csv",
      "Migrate from CSV upload",
      "New migration",
    );
    await page.locator('input[type="file"]').setInputFiles({
      name: "subscribers.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "email,name\nalice@example.com,Alice\nbob@example.com,Bob\n",
      ),
    });
    await expect(page.getByText("Confirm columns")).toBeVisible();
    await expect(page.getByLabel("Email column")).toHaveValue("0");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page.getByRole("button", { name: "Run dry-run" })).toBeVisible(
      {
        timeout: 30_000,
      },
    );
    await page.getByRole("button", { name: "Run dry-run" }).click();
    await expect(page.getByTestId("dry-run-preview")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("resource-card").first()).toBeVisible();
    await page
      .getByRole("button", { name: "Looks good — start the real import" })
      .click();

    const progress = page.getByTestId("migration-progress");
    await expect(progress).toBeVisible();
    await expect(
      progress.getByRole("progressbar", { name: "Overall migration progress" }),
    ).toBeVisible();
    await expect(page.getByText("You're on Moosewave")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/100\.0% fidelity/iu)).toBeVisible();
    await page.getByRole("button", { name: "View migration" }).click();
    await expect(page).toHaveURL(/\/app\/migrations\/job_csv_/u);
  });

  test("migration detail rename and cancellation dialog preserve keyboard focus", async ({
    page,
  }) => {
    await gotoHeading(
      page,
      "/app/migrations/job_csv_interactions",
      "CSV upload migration",
      "Migration details",
    );

    await page.getByRole("button", { name: "Rename migration" }).click();
    await page.getByLabel("Migration name").fill("August audience transfer");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "August audience transfer" }),
    ).toBeVisible();

    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    await cancel.click();
    await expect(
      page.getByRole("dialog", { name: "Cancel this migration?" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(cancel).toBeFocused();
  });
});
