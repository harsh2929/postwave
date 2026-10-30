import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Page, Request, Route } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const TENANT_ID = "00000000-0000-0000-0000-000000000043";
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SNAPSHOT_AT = "2026-08-28T12:00:00Z";

type Role = "admin" | "viewer";
type RegistryState = "populated" | "empty" | "error" | "slow";

interface Receipt {
  body: string | null;
  method: string;
  pathname: string;
  search: string;
}

interface Harness {
  consoleErrors: string[];
  pageErrors: string[];
  protectedRequests: Receipt[];
  registryState: { current: RegistryState };
  releaseSlowRequest: () => void;
  requests: Receipt[];
}

const ROWS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    tenant_id: TENANT_ID,
    device_token_hash: "0123456789abcdef",
    platform: "apns",
    reason: "manual",
    source: "dashboard",
    created_at: "2026-08-28T11:30:00Z",
    updated_at: "2026-08-28T11:30:00Z",
    version: 3,
    reversible: true,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    tenant_id: TENANT_ID,
    device_token_hash: "1111222233334444",
    platform: "fcm",
    reason: "unregistered",
    source: "provider",
    created_at: "2026-08-28T11:20:00Z",
    updated_at: "2026-08-28T11:21:00Z",
    version: 2,
    reversible: false,
    locked_reason: "provider_authority",
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    tenant_id: TENANT_ID,
    device_token_hash: "aaaabbbbccccdddd",
    platform: "web",
    reason: "user_opt_out",
    source: "user",
    created_at: "2026-08-28T11:10:00Z",
    updated_at: "2026-08-28T11:10:00Z",
    version: 1,
    reversible: false,
    locked_reason: "user_opt_out_authority",
  },
] as const;

function receipt(request: Request): Receipt {
  const url = new URL(request.url());
  return {
    body: request.postData(),
    method: request.method(),
    pathname: url.pathname,
    search: url.search,
  };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "cache-control": "no-store, private",
      "x-postwave-context-epoch": "route43-visual-epoch-1",
    },
    body: JSON.stringify(body),
  });
}

async function installNativeSessionBroker(page: Page, role: Role): Promise<void> {
  await page.addInitScript(
    ({ activeRole, tenantId, userId }) => {
      const install = (): void => {
        const target = window as typeof window & {
          __TAURI_INTERNALS__?: {
            invoke: (
              command: string,
              args?: Record<string, unknown>,
            ) => Promise<unknown>;
            __route43SessionBroker?: boolean;
            [key: string]: unknown;
          };
        };
        const current = target.__TAURI_INTERNALS__;
        if (!current) {
          queueMicrotask(install);
          return;
        }
        if (current.__route43SessionBroker) return;
        const originalInvoke = current.invoke.bind(current);
        Object.defineProperty(target, "__TAURI_INTERNALS__", {
          configurable: true,
          value: {
            ...current,
            __route43SessionBroker: true,
            invoke: async (
              command: string,
              args?: Record<string, unknown>,
            ): Promise<unknown> => {
              if (command === "session_broker_initialize") {
                return { baseUrl: String(args?.baseUrl ?? "") };
              }
              if (command === "session_broker_stream_request") {
                const request = args?.request as
                  | {
                      body?: number[];
                      headers?: Record<string, string>;
                      method?: string;
                      url?: string;
                    }
                  | undefined;
                const requestUrl = request?.url ?? window.location.href;
                const pathname = new URL(requestUrl, window.location.href).pathname;
                const onEvent = args?.onEvent as
                  | {
                      onmessage?: (
                        event:
                          | number[]
                          | { event: "complete" | "error"; message?: string },
                      ) => void;
                    }
                  | undefined;
                const response =
                  pathname === "/api/v1/auth/me"
                    ? new Response(
                        JSON.stringify({
                          user_id: userId,
                          tenant_id: tenantId,
                          email: `${activeRole}@route43.example.invalid`,
                          role: activeRole,
                          effective_role: activeRole,
                          auth_provider: "password",
                          email_verified: true,
                          workspace_name: "Route43 Synthetic Workspace",
                          workspace_slug: "route43-synthetic",
                        }),
                        {
                          status: 200,
                          headers: {
                            "content-type": "application/json",
                            "x-postwave-context-epoch": "route43-visual-epoch-1",
                          },
                        },
                      )
                    : await fetch(requestUrl, {
                        method: request?.method ?? "GET",
                        headers: request?.headers,
                        body:
                          request?.body && request.body.length > 0
                            ? new Uint8Array(request.body)
                            : undefined,
                      });
                const payload = new Uint8Array(await response.arrayBuffer());
                const headers: Record<string, string> = {};
                response.headers.forEach((value, name) => {
                  headers[name] = value;
                });
                queueMicrotask(() => {
                  onEvent?.onmessage?.(Array.from(payload));
                  onEvent?.onmessage?.({ event: "complete" });
                });
                return {
                  status: response.status,
                  statusText: response.statusText,
                  headers,
                };
              }
              if (
                command === "session_broker_cancel" ||
                command === "session_broker_clear" ||
                command === "session_broker_clear_all"
              ) {
                return null;
              }
              return originalInvoke(command, args);
            },
          },
        });
      };
      install();
    },
    { activeRole: role, tenantId: TENANT_ID, userId: USER_ID },
  );
}

async function installHarness(page: Page, role: Role): Promise<Harness> {
  const requests: Receipt[] = [];
  const protectedRequests: Receipt[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const registryState: { current: RegistryState } = { current: "populated" };
  let rows: Array<Record<string, unknown>> = ROWS.map((row) => ({ ...row }));
  let releaseSlow = (): void => {};
  await installNativeSessionBroker(page, role);
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.port === "1421" && !requestUrl.pathname.startsWith("/api/")) {
      await route.continue();
      return;
    }
    const request = receipt(route.request());
    requests.push(request);
    if (request.pathname.startsWith("/api/v1/push/suppressions")) {
      protectedRequests.push(request);
    }
    if (request.pathname === "/api/v1/auth/me") {
      await json(route, {
        user_id: USER_ID,
        tenant_id: TENANT_ID,
        email: `${role}@route43.example.invalid`,
        role,
        effective_role: role,
        auth_provider: "password",
        email_verified: true,
      });
      return;
    }
    if (request.pathname === "/api/v1/me") {
      await json(route, {
        user: `${role}@route43.example.invalid`,
        tenant: "Route43 Synthetic Workspace",
      });
      return;
    }
    if (request.pathname === "/api/v1/audit/my-scopes") {
      await json(route, {
        scopes: role === "admin" ? ["admin"] : [],
        isAdmin: role === "admin",
      });
      return;
    }
    if (request.pathname === "/api/health" || request.pathname === "/api/v1/health") {
      await json(route, { ok: true });
      return;
    }
    if (request.pathname === "/api/v1/push/suppressions" && request.method === "POST") {
      const input = JSON.parse(request.body ?? "{}") as {
        platform?: string;
      };
      const created = {
        id: "44444444-4444-4444-8444-444444444444",
        tenant_id: TENANT_ID,
        device_token_hash: "ffffeeee11112222",
        platform: input.platform,
        reason: "manual",
        source: "dashboard",
        created_at: "2026-08-28T11:40:00Z",
        updated_at: "2026-08-28T11:40:00Z",
        version: 1,
        reversible: true,
      };
      rows = [created, ...rows];
      await json(route, created, 201);
      return;
    }
    if (request.pathname === "/api/v1/push/suppressions" && request.method === "GET") {
      if (registryState.current === "slow") {
        await new Promise<void>((resolve) => {
          releaseSlow = resolve;
        });
      }
      if (registryState.current === "error") {
        await json(route, { error: { message: "SECRET provider detail" } }, 503);
        return;
      }
      const params = new URLSearchParams(request.search);
      const prefix = params.get("hash_prefix") ?? "";
      const platform = params.get("platform") ?? "";
      const reason = params.get("reason") ?? "";
      const filtered =
        registryState.current === "empty"
          ? []
          : rows.filter(
              (row) =>
                (!prefix || String(row.device_token_hash).startsWith(prefix)) &&
                (!platform || row.platform === platform) &&
                (!reason || row.reason === reason),
            );
      await json(route, {
        tenantId: TENANT_ID,
        items: filtered,
        total: filtered.length,
        snapshotAt: SNAPSHOT_AT,
      });
      return;
    }
    const removal = request.pathname.match(
      /^\/api\/v1\/push\/suppressions\/([0-9a-f-]{36})$/u,
    );
    if (removal && request.method === "DELETE") {
      const id = removal[1] ?? "";
      const reviewed = rows.find((row) => row.id === id);
      const input = JSON.parse(request.body ?? "{}") as {
        expected_version?: number;
      };
      rows = rows.filter((row) => row.id !== id);
      await json(route, {
        ok: true,
        tenantId: TENANT_ID,
        id,
        version: (input.expected_version ?? Number(reviewed?.version ?? 0)) + 1,
        stillSuppressed: false,
      });
      return;
    }
    await json(route, {});
  });
  return {
    consoleErrors,
    pageErrors,
    protectedRequests,
    registryState,
    releaseSlowRequest: () => releaseSlow(),
    requests,
  };
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - window.innerWidth,
    document: document.documentElement.scrollWidth - window.innerWidth,
  }));
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
}

async function assertNoSeriousA11yViolations(page: Page): Promise<void> {
  await page.addScriptTag({ content: AXE_SOURCE });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as typeof window & {
        axe: {
          run: (
            target: string,
            options: Record<string, unknown>,
          ) => Promise<{
            violations: Array<{ id: string; impact: string | null }>;
          }>;
        };
      }
    ).axe;
    const result = await axe.run(".push-suppressions-route", {
      rules: { region: { enabled: false } },
    });
    return result.violations.filter(
      (violation) =>
        violation.impact === "serious" || violation.impact === "critical",
    );
  });
  expect(violations).toEqual([]);
}

test.use({ locale: "en-US", timezoneId: "UTC" });
test.describe.configure({ mode: "serial", timeout: 180_000 });

test("admin populated, empty, stale, detail, modal, and 99.9th-percentile layouts", async ({
  bootApp,
  context,
  page,
  setTheme,
}, testInfo) => {
  await bootApp(page);
  await setTheme(page, "light");
  const harness = await installHarness(page, "admin");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/push-suppressions");
  await page.waitForTimeout(500);
  expect(harness.pageErrors).toEqual([]);
  expect(harness.consoleErrors).toEqual([]);
  await waitForPrimaryNavigation(page);
  await expect
    .poll(() => harness.protectedRequests.length, {
      message: JSON.stringify(harness.requests),
    })
    .toBeGreaterThan(0);
  expect(harness.protectedRequests).toHaveLength(1);
  await expect(
    page.getByRole("heading", { name: "Verified suppression authorities" }),
  ).toBeVisible();
  await expect(page.getByText("Registry operational · dispatch held")).toBeVisible();
  await expect(page.getByText("Dashboard manual · reversible")).toBeVisible();
  await expect(page.getByText("Provider · locked")).toBeVisible();
  await assertNoSeriousA11yViolations(page);
  await assertNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("push-suppressions-populated-1440.png"),
    fullPage: true,
    animations: "disabled",
  });

  await page
    .getByRole("button", { name: "View details for fingerprint 1111222233334444" })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Provider");
  await assertNoSeriousA11yViolations(page);
  await page.screenshot({
    path: testInfo.outputPath("push-suppressions-detail-1440.png"),
    fullPage: false,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Close details" }).click();

  await page
    .getByRole("checkbox", { name: "Select suppression 0123456789abcdef" })
    .check();
  await page.getByRole("button", { name: "Review bulk removal" }).click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Review 1 current-page fingerprints",
  );
  await assertNoSeriousA11yViolations(page);
  await page.screenshot({
    path: testInfo.outputPath("push-suppressions-bulk-remove-review-1440.png"),
    fullPage: false,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Clear selection" }).click();

  await page
    .getByRole("button", {
      name: "Remove suppression for fingerprint 0123456789abcdef",
    })
    .click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "Expected version",
  );
  await assertNoSeriousA11yViolations(page);
  await page.screenshot({
    path: testInfo.outputPath("push-suppressions-remove-confirm-1440.png"),
    fullPage: false,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("button", { name: "Add manual suppression" }).click();
  await expect(
    page.getByRole("heading", { name: "Add a manual push suppression" }),
  ).toBeVisible();
  await expect(page.getByText("Manual (fixed)")).toBeVisible();
  await assertNoSeriousA11yViolations(page);
  await page.screenshot({
    path: testInfo.outputPath("push-suppressions-add-modal-1440.png"),
    fullPage: false,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Cancel" }).click();

  harness.registryState.current = "slow";
  await page.getByRole("button", { name: "Refresh registry" }).click();
  await expect(page.getByText("Refreshing…", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("0123456789abcdef").first()).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("push-suppressions-refresh-preserves-verified.png"),
    fullPage: false,
    animations: "disabled",
  });
  harness.registryState.current = "populated";
  harness.releaseSlowRequest();
  await expect(page.getByRole("button", { name: "Refresh registry" })).toBeEnabled();

  harness.registryState.current = "error";
  await page.getByRole("button", { name: "Refresh registry" }).click();
  await expect(page.getByRole("alert")).toContainText("Showing the last verified page");
  await expect(page.getByText("SECRET provider detail")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add manual suppression" })).toBeDisabled();
  await page.screenshot({
    path: testInfo.outputPath("push-suppressions-stale-error.png"),
    fullPage: false,
    animations: "disabled",
  });

  harness.registryState.current = "populated";
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("0123456789abcdef").first()).toBeVisible();
  const search = page.getByRole("searchbox", {
    name: "Device-token fingerprint prefix",
  });
  await search.fill("deadbeef");
  await expect(
    page.getByRole("heading", { name: "No suppressions match these filters" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("push-suppressions-filtered-empty.png"),
    fullPage: false,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Clear all filters" }).click();

  harness.registryState.current = "empty";
  await page.getByRole("button", { name: "Refresh registry" }).click();
  await expect(
    page.getByRole("heading", {
      name: "The registry has no suppression authorities yet.",
    }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("push-suppressions-empty.png"),
    fullPage: false,
    animations: "disabled",
  });

  harness.registryState.current = "populated";
  await page.getByRole("button", { name: "Refresh registry" }).click();
  for (const viewport of [
    { width: 720, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`push-suppressions-${viewport.width}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await assertNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("push-suppressions-320-text-200.png"),
    fullPage: true,
    animations: "disabled",
  });

  await page.evaluate(() => {
    document.documentElement.style.removeProperty("font-size");
  });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("push-suppressions-forced-colors.png"),
    fullPage: false,
    animations: "disabled",
  });

  const protectedBeforeOffline = harness.protectedRequests.length;
  await context.setOffline(true);
  await expect(page.getByRole("heading", { name: "Connection required" })).toBeVisible();
  expect(harness.protectedRequests).toHaveLength(protectedBeforeOffline);
  await context.setOffline(false);
  await expect(page.getByText("0123456789abcdef").first()).toBeVisible();

  expect(harness.pageErrors).toEqual([]);
  expect(harness.consoleErrors.every((message) => message.includes("503"))).toBe(true);
});

test("viewer destination starts zero private push-registry requests", async ({
  bootApp,
  page,
  setTheme,
}) => {
  await bootApp(page);
  await setTheme(page, "light");
  const harness = await installHarness(page, "viewer");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/push-suppressions");
  await page.waitForTimeout(500);
  expect(harness.pageErrors).toEqual([]);
  expect(harness.consoleErrors).toEqual([]);
  await waitForPrimaryNavigation(page);
  await expect(page.getByRole("heading", { name: "Access required" })).toBeVisible();
  expect(harness.protectedRequests).toEqual([]);
  await assertNoHorizontalOverflow(page);
  expect(harness.pageErrors).toEqual([]);
});
