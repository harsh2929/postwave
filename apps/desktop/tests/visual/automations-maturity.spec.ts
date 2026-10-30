import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Page, Route } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const NOW = "2026-07-21T10:00:00.000Z";
const ZERO_COPY_RUNTIME = {
  capability: "zero_copy_trigger_execution",
  runtime_status: "unavailable",
  execution_enabled: false,
  code: "zero_copy_runtime_unavailable",
  message: "Zero-copy execution is unavailable.",
  prerequisites: ["durable_execution_receipts"],
};

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

interface AutomationsApiControl {
  getDefinitionListCount: () => number;
  getMutationCount: () => number;
}

function triggerDefinition(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    description: "Synthetic qualification definition",
    status: "draft",
    provider: "snowflake",
    query: "SELECT email, created_at FROM orders WHERE created_at > :cursor",
    cursor_column: "created_at",
    profile_key_column: "email",
    polling_interval_seconds: 300,
    max_rows_per_tick: 500,
    consecutive_failures: 0,
    rows_fired_total: 0,
    config: { warehouse: { role: "reporting" } },
    created_at: NOW,
    updated_at: NOW,
    runtime: ZERO_COPY_RUNTIME,
  };
}

async function installAutomationsApi(
  page: Page,
  role: "admin" | "viewer" = "admin",
): Promise<AutomationsApiControl> {
  let mutationCount = 0;
  let definitionListCount = 0;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    if (pathname === "/api/v1/auth/me" && role === "viewer") {
      await json(route, {
        user_id: "automations-viewer",
        tenant_id: "automations-test-tenant",
        email: "viewer@automations.example.invalid",
        role: "viewer",
        effective_role: "viewer",
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Automations qualification",
        workspace_slug: "automations-test-tenant",
      });
      return;
    }
    if (pathname === "/api/v1/zero-copy-triggers") {
      if (request.method() !== "GET") {
        mutationCount += 1;
        await json(route, { error: { code: "fixture_mutation_blocked" } }, 409);
        return;
      }
      definitionListCount += 1;
      const cursor = url.searchParams.get("cursor");
      await json(route, {
        items:
          cursor === "qualification-page-2"
            ? [
                triggerDefinition(
                  "44444444-4444-4444-8444-444444444444",
                  "Renewal warehouse draft",
                ),
              ]
            : [
                triggerDefinition(
                  "11111111-1111-4111-8111-111111111111",
                  "High-value order draft",
                ),
              ],
        ...(cursor === "qualification-page-2"
          ? {}
          : { nextCursor: "qualification-page-2", totalEstimate: 2 }),
      });
      return;
    }
    if (
      pathname ===
      "/api/v1/zero-copy-triggers/11111111-1111-4111-8111-111111111111/fires"
    ) {
      await json(route, {
        items: [
          {
            id: 7,
            trigger_id: "11111111-1111-4111-8111-111111111111",
            status: "fired",
            fired_at: NOW,
            has_cursor: true,
            has_profile_key: true,
            has_subscriber: true,
            has_payload: true,
            has_flow_run: false,
            error_category: "execution_error",
          },
        ],
      });
      return;
    }
    if (
      pathname ===
      "/api/v1/zero-copy-triggers/11111111-1111-4111-8111-111111111111/alerts"
    ) {
      await json(route, {
        trigger_id: "11111111-1111-4111-8111-111111111111",
        runtime: ZERO_COPY_RUNTIME,
        consecutive_failures_threshold: 3,
        lag_seconds_threshold: 300,
        fires_per_tick_threshold: 100,
        webhook_configured: true,
        cooldown_seconds: 600,
        last_alert_fired_at: NOW,
        last_alert_kind: "failures",
        has_last_alert_message: true,
        created_at: NOW,
        updated_at: NOW,
      });
      return;
    }
    if (
      pathname ===
      "/api/v1/zero-copy-triggers/11111111-1111-4111-8111-111111111111/dlq"
    ) {
      await json(route, {
        items: [
          {
            id: 9,
            trigger_id: "11111111-1111-4111-8111-111111111111",
            reason: "enqueue_failed",
            retry_count: 1,
            last_retried_at: NOW,
            status: "pending",
            created_at: NOW,
            updated_at: NOW,
            has_cursor: true,
            has_profile_key: true,
            has_payload: true,
            last_error_category: "execution_error",
          },
        ],
      });
      return;
    }
    if (pathname === "/api/v1/omnichannel/catalog") {
      await json(route, {
        schema_version: "1",
        channels: [
          {
            key: "email",
            label: "Email",
            runtime_status: "available",
            fields: [],
          },
          {
            key: "sms",
            label: "SMS",
            runtime_status: "declared",
            fields: [],
          },
        ],
        send_strategies: [
          { key: "ordered", label: "Ordered", runtime_status: "declared" },
        ],
        recipient_snapshot_modes: [
          { key: "frozen", label: "Frozen", runtime_status: "declared" },
        ],
        path_statuses: ["draft"],
      });
      return;
    }
    if (pathname === "/api/v1/omnichannel/campaigns") {
      if (request.method() !== "GET") {
        mutationCount += 1;
        await json(route, { error: { code: "fixture_mutation_blocked" } }, 409);
        return;
      }
      await json(route, {
        items: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Renewal definition",
            status: "draft",
            recipient_snapshot_mode: "frozen",
            created_at: NOW,
            updated_at: NOW,
            paths: [
              {
                id: "33333333-3333-4333-8333-333333333333",
                path_key: "email-primary",
                name: "Primary email",
                channel: "email",
                status: "draft",
                sequence: 1,
                traffic_weight_basis_points: 10_000,
              },
            ],
          },
        ],
      });
      return;
    }
    if (
      pathname.startsWith("/api/v1/zero-copy-triggers/") ||
      pathname.startsWith("/api/v1/omnichannel/campaigns/")
    ) {
      if (request.method() !== "GET") mutationCount += 1;
      await json(route, { error: { code: "fixture_route_not_expected" } }, 409);
      return;
    }
    await route.fallback();
  });
  return {
    getDefinitionListCount: () => definitionListCount,
    getMutationCount: () => mutationCount,
  };
}

async function openAutomations(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
  role: "admin" | "viewer" = "admin",
): Promise<AutomationsApiControl> {
  await bootApp(page);
  const control = await installAutomationsApi(page, role);
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="automations"]')
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Design now. Run after qualification.",
      exact: true,
    }),
  ).toBeVisible();
  if (role === "admin") {
    await expect(
      page.getByRole("button", { name: "High-value order draft" }),
    ).toBeVisible();
  } else {
    await expect(page.getByText("Admin access required")).toBeVisible();
  }
  return control;
}

async function seriousAxeViolations(
  page: Page,
  options: { disableColorContrast?: boolean } = {},
): Promise<unknown[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async (disableColorContrast) => {
    const result = await (
      window as unknown as {
        axe: {
          run: (
            root: Document | Element,
            options?: Record<string, unknown>,
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ target: string[]; failureSummary?: string }>;
            }>;
          }>;
        };
      }
    ).axe.run(document.querySelector(".automations-page") ?? document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
      ...(disableColorContrast
        ? { rules: { "color-contrast": { enabled: false } } }
        : {}),
    });
    return result.violations
      .filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      )
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          failure: node.failureSummary,
        })),
      }));
  }, options.disableColorContrast ?? false);
}

for (const theme of ["dark", "light"] as const) {
  test(`Automations is axe-clean and visually contained in ${theme} theme`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1_000 });
    await setTheme(page, theme);
    await openAutomations(page, bootApp);

    await expect(
      page.getByText("Current boundary", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Tenant runtime not checked").first(),
    ).toBeVisible();
    expect(await seriousAxeViolations(page)).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath(`automations-${theme}.png`),
      fullPage: true,
    });
  });
}

test("unavailable runtime controls remain discoverable but issue no mutation", async ({
  page,
  bootApp,
}) => {
  const control = await openAutomations(page, bootApp);
  await page
    .getByRole("button", { name: "Poll unavailable" })
    .click({ force: true });
  await page
    .getByRole("button", { name: "New campaign unavailable" })
    .click({ force: true });
  expect(control.getMutationCount()).toBe(0);
});

test("cursor pagination appends a non-overlapping definition page", async ({
  page,
  bootApp,
}) => {
  const control = await openAutomations(page, bootApp);
  await expect(page.getByText(/1 definition loaded/)).toBeVisible();
  await page.getByRole("button", { name: "Load more definitions" }).click();
  await expect(
    page.getByRole("button", { name: "Renewal warehouse draft" }),
  ).toBeVisible();
  await expect(page.getByText(/2 definitions loaded/)).toBeVisible();
  expect(control.getDefinitionListCount()).toBe(2);
});

test("detail tabs render only redacted operational evidence", async ({
  page,
  bootApp,
}) => {
  await openAutomations(page, bootApp);
  await page.getByRole("button", { name: "High-value order draft" }).click();
  await expect(
    page.getByRole("region", { name: "Trigger enqueue records" }),
  ).toBeVisible();
  await expect(
    page.getByText("Execution error recorded · details hidden"),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Alert config" }).click();
  await expect(page.getByText("Configured (hidden)")).toBeVisible();
  await expect(page.getByText("Recorded (hidden)")).toBeVisible();

  await page.getByRole("tab", { name: "Recovery" }).click();
  await expect(
    page.getByText("Enqueue failed · execution error recorded"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry unavailable" }).click({
    force: true,
  });
  expect(await page.locator("body").innerText()).not.toContain(
    "synthetic-secret-canary",
  );
});

test("dirty trigger drafts require an explicit keyboard discard", async ({
  page,
  bootApp,
}) => {
  await openAutomations(page, bootApp);
  await page
    .getByRole("button", { name: "+ New trigger draft", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "New warehouse trigger draft",
  });
  await dialog.getByLabel("Name").fill("Synthetic lifecycle draft");
  await page.keyboard.press("Escape");
  const confirmation = page.getByRole("alertdialog", {
    name: "Discard unsaved trigger changes?",
  });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Keep editing" }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await page
    .getByRole("alertdialog", { name: "Discard unsaved trigger changes?" })
    .getByRole("button", { name: "Discard changes" })
    .click();
  await expect(dialog).toBeHidden();
});

test("Automations cards remain contained and keyboard reachable at 320 CSS pixels", async ({
  page,
  bootApp,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await openAutomations(page, bootApp);
  await expect(
    page.getByRole("region", { name: "Warehouse trigger definitions" }),
  ).toBeVisible();
  const tableRegion = page.getByRole("region", {
    name: "Warehouse trigger definitions",
  });
  await tableRegion.focus();
  await expect(tableRegion).toBeFocused();
  expect(
    await page.evaluate(() => {
      const pageRoot = document.querySelector<HTMLElement>(".automations-page");
      return Boolean(
        pageRoot && pageRoot.scrollWidth <= pageRoot.clientWidth + 1,
      );
    }),
  ).toBe(true);
  expect(await seriousAxeViolations(page)).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("automations-narrow.png"),
    fullPage: true,
  });
});

test("Automations preserves semantic boundaries in forced colors", async ({
  page,
  bootApp,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active" });
  await openAutomations(page, bootApp);
  await expect(
    page.getByText("Runtime readiness", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => ({
      forced: window.matchMedia("(forced-colors: active)").matches,
      shadow: getComputedStyle(
        document.querySelector<HTMLElement>(".automations-readiness")!,
      ).boxShadow,
    })),
  ).toEqual({ forced: true, shadow: "none" });
  expect(
    await seriousAxeViolations(page, { disableColorContrast: true }),
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("automations-forced-colors.png"),
    fullPage: true,
  });
});

test("Automations removes its spinner animation under reduced motion", async ({
  page,
  bootApp,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await openAutomations(page, bootApp);
  const motion = await page.evaluate(() => {
    const spinner = document.createElement("span");
    spinner.className = "automations-spinner";
    document.querySelector(".automations-page")?.append(spinner);
    const animationName = getComputedStyle(spinner).animationName;
    spinner.remove();
    return {
      reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      animationName,
    };
  });
  expect(motion).toEqual({ reduced: true, animationName: "none" });
  expect(await seriousAxeViolations(page)).toEqual([]);
});

test("a viewer makes no admin-only definition request", async ({
  page,
  bootApp,
}) => {
  const control = await openAutomations(page, bootApp, "viewer");
  expect(control.getDefinitionListCount()).toBe(0);
  await expect(page.getByText("Admin access required")).toBeVisible();
  await expect(page.getByText("High-value order draft")).toHaveCount(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
});
