import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Locator, Page, Request, Route } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

// Isolated invocation: pnpm --filter postwave-desktop-shell test:visual:sms-suppressions

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SNAPSHOT_AT = "2026-08-28T12:00:00Z";
const EXACT_PHONE = "+12025550101";

type Role = "admin" | "viewer";
type RegistryState = "populated" | "empty" | "error";

interface RequestReceipt {
  body: string | null;
  method: string;
  pathname: string;
  search: string;
}

interface Harness {
  consoleErrors: string[];
  pageErrors: string[];
  protectedRequests: RequestReceipt[];
  registryState: { current: RegistryState };
  requests: RequestReceipt[];
}

const SUPPRESSIONS = [
  {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    phone_e164: "+12025550103",
    reason: "carrier_block",
    source: "bandwidth",
    reversible: false,
    locked_reason: "carrier_or_system_authority",
    created_at: "2026-08-28T11:30:00Z",
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    phone_e164: "+12025550102",
    reason: "stop_keyword",
    source: "twilio",
    reversible: false,
    locked_reason: "carrier_or_system_authority",
    created_at: "2026-08-28T11:20:00Z",
  },
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    phone_e164: EXACT_PHONE,
    reason: "manual",
    source: "manual",
    reversible: true,
    created_at: "2026-08-28T11:10:00Z",
  },
] as const;

const QUIET_HOURS = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  tenant_id: TENANT_ID,
  label: "Synthetic overnight gate",
  country_code: "US",
  start_minute: 1260,
  end_minute: 540,
  start_local: "21:00",
  end_local: "09:00",
  days: [0, 1, 2, 3, 4, 5, 6],
  timezone: "Etc/UTC",
  enabled: true,
  created_at: "2026-08-20T12:00:00Z",
  updated_at: "2026-08-20T12:00:00Z",
};

const KEYWORD = {
  id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  tenant_id: TENANT_ID,
  keyword: "LEAVE",
  response_body:
    "You are unsubscribed from SMS marketing messages from this sender.",
  response_text:
    "You are unsubscribed from SMS marketing messages from this sender.",
  action: "opt_out",
  enabled: true,
  autoReplyDispatchAvailable: false,
  autoReplyDispatchUnavailableReason: "sms_auto_reply_dispatch_release_held",
  opt_in_count: 0,
  created_at: "2026-08-20T12:00:00Z",
  updated_at: "2026-08-20T12:00:00Z",
};

function receipt(request: Request): RequestReceipt {
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
      "x-postwave-context-epoch": "route42-visual-epoch-1",
    },
    body: JSON.stringify(body),
  });
}

async function installNativeSessionBroker(
  page: Page,
  role: Role,
): Promise<void> {
  await page.addInitScript(
    ({ activeRole, tenantId, userId }) => {
      const install = (): void => {
        const target = window as typeof window & {
          __TAURI_INTERNALS__?: {
            invoke: (
              command: string,
              args?: Record<string, unknown>,
            ) => Promise<unknown>;
            __route42SessionBroker?: boolean;
            [key: string]: unknown;
          };
        };
        const current = target.__TAURI_INTERNALS__;
        if (!current) {
          queueMicrotask(install);
          return;
        }
        if (current.__route42SessionBroker) return;
        const originalInvoke = current.invoke.bind(current);
        Object.defineProperty(target, "__TAURI_INTERNALS__", {
          configurable: true,
          value: {
            ...current,
            __route42SessionBroker: true,
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
                const pathname = new URL(requestUrl, window.location.href)
                  .pathname;
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
                          email: `${activeRole}@route42.example.invalid`,
                          role: activeRole,
                          effective_role: activeRole,
                          auth_provider: "password",
                          email_verified: true,
                          workspace_name: "Route42 Synthetic Workspace",
                          workspace_slug: "route42-synthetic",
                        }),
                        {
                          status: 200,
                          headers: {
                            "content-type": "application/json",
                            "x-postwave-context-epoch":
                              "route42-visual-epoch-1",
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
  const requests: RequestReceipt[] = [];
  const protectedRequests: RequestReceipt[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const registryState: { current: RegistryState } = { current: "populated" };
  let registryRows: Array<Record<string, unknown>> = SUPPRESSIONS.map(
    (row) => ({
      ...row,
    }),
  );
  await installNativeSessionBroker(page, role);
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const item = receipt(request);
    requests.push(item);
    if (
      item.pathname.startsWith("/api/v1/sms/suppressions") ||
      item.pathname === "/api/v1/sms/quiet-hours" ||
      item.pathname === "/api/v1/sms/keyword-responses"
    ) {
      protectedRequests.push(item);
    }
    if (item.pathname === "/api/v1/auth/me") {
      await json(route, {
        user_id: USER_ID,
        tenant_id: TENANT_ID,
        email: `${role}@route42.example.invalid`,
        role,
        effective_role: role,
        auth_provider: "password",
        email_verified: true,
      });
      return;
    }
    if (item.pathname === "/api/v1/me") {
      await json(route, {
        user: `${role}@route42.example.invalid`,
        tenant: "Route42 Synthetic Workspace",
      });
      return;
    }
    if (item.pathname === "/api/v1/audit/my-scopes") {
      await json(route, {
        scopes: role === "admin" ? ["admin"] : [],
        isAdmin: role === "admin",
      });
      return;
    }
    if (item.pathname === "/api/health" || item.pathname === "/api/v1/health") {
      await json(route, { ok: true });
      return;
    }
    if (item.pathname === "/api/v1/sms/suppressions/query") {
      const input = JSON.parse(item.body ?? "{}") as { phone?: string };
      await json(route, {
        tenantId: TENANT_ID,
        items: registryRows.filter((row) => row.phone_e164 === input.phone),
        total: registryRows.filter((row) => row.phone_e164 === input.phone)
          .length,
        snapshotAt: SNAPSHOT_AT,
      });
      return;
    }
    if (item.pathname === "/api/v1/sms/suppressions") {
      if (item.method === "POST") {
        const input = JSON.parse(item.body ?? "{}") as {
          phone?: string;
          reason?: string;
        };
        const created = {
          id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          phone_e164: input.phone,
          reason: "manual",
          source: "manual",
          reversible: true,
          created_at: "2026-08-28T11:40:00Z",
        };
        registryRows = [
          created,
          ...registryRows.filter((row) => row.phone_e164 !== input.phone),
        ];
        await json(route, created, 201);
        return;
      }
      if (registryState.current === "error") {
        await json(
          route,
          { error: { message: "SECRET upstream provider detail" } },
          503,
        );
      } else {
        const items =
          registryState.current === "empty" ? [] : [...registryRows];
        await json(route, {
          tenantId: TENANT_ID,
          items,
          total: items.length,
          snapshotAt: SNAPSHOT_AT,
        });
      }
      return;
    }
    const suppressionDelete = item.pathname.match(
      /^\/api\/v1\/sms\/suppressions\/([0-9a-f-]{36})$/u,
    );
    if (suppressionDelete && item.method === "DELETE") {
      const id = suppressionDelete[1] ?? "";
      registryRows = registryRows.filter((row) => row.id !== id);
      await json(route, { ok: true, tenantId: TENANT_ID, id });
      return;
    }
    if (item.pathname === "/api/v1/sms/quiet-hours") {
      await json(route, { tenantId: TENANT_ID, items: [QUIET_HOURS] });
      return;
    }
    if (item.pathname === "/api/v1/sms/keyword-responses") {
      await json(route, { tenantId: TENANT_ID, items: [KEYWORD] });
      return;
    }
    await json(route, {});
  });
  return {
    consoleErrors,
    pageErrors,
    protectedRequests,
    registryState,
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

async function scrollTargetToStart(target: Locator): Promise<void> {
  await target.evaluate((element) => {
    element.scrollIntoView({ block: "start", inline: "nearest" });
  });
  await expect(target).toBeInViewport();
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
    const result = await axe.run(".sms-suppressions-route", {
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

test("admin registry, active internal policies, local tool, and responsive states", async ({
  bootApp,
  context,
  page,
  setTheme,
}, testInfo) => {
  await bootApp(page);
  await setTheme(page, "light");
  const harness = await installHarness(page, "admin");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/app/sms-suppressions");
  await waitForPrimaryNavigation(page);
  await expect(
    page.getByRole("heading", { name: "Authoritative suppression registry" }),
  ).toBeVisible();
  await expect(page.getByText("Contains phone data")).toBeVisible();
  await expect(
    page.getByText("Internal policy active · hosted traffic held"),
  ).toBeVisible();
  await expect(page.getByText("No live enrollment claim")).toBeVisible();
  await expect(page.getByText("Synthetic overnight gate")).toBeVisible();
  await expect(page.getByText("LEAVE", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy link" })).toBeDisabled();
  await assertNoSeriousA11yViolations(page);
  await assertNoHorizontalOverflow(page);
  // The fixed shell owns the route's nested scroller, so this fullPage image is
  // viewport/theme evidence only. The explicitly scrolled policy, tool, and
  // dialog captures below are the canonical route-depth visual packet.
  await page.screenshot({
    path: testInfo.outputPath("sms-suppressions-1440.png"),
    fullPage: true,
    animations: "disabled",
  });

  const policyHeading = page.getByRole("heading", {
    name: "Stored policy controls",
  });
  const quietCardTitle = page.getByText("SMS quiet hours", { exact: true });
  await scrollTargetToStart(quietCardTitle);
  await page.screenshot({
    path: testInfo.outputPath("sms-suppressions-policy-quiet-1440.png"),
    fullPage: false,
    animations: "disabled",
  });

  const keywordCardTitle = page.getByText("SMS keyword state rules", {
    exact: true,
  });
  await scrollTargetToStart(keywordCardTitle);
  await page.screenshot({
    path: testInfo.outputPath("sms-suppressions-policy-keyword-1440.png"),
    fullPage: false,
    animations: "disabled",
  });

  const legacyCountryToggle = page.getByRole("checkbox", {
    name: "Synthetic overnight gate enabled",
  });
  await scrollTargetToStart(legacyCountryToggle);
  await legacyCountryToggle.click();
  await expect(
    page.getByRole("heading", { name: "Disable quiet-hours gate policy?" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath(
      "sms-suppressions-legacy-country-disable-confirm-1440.png",
    ),
    fullPage: false,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Cancel" }).click();

  const toolsHeading = page.getByRole("heading", {
    name: "Setup and local creative tools",
  });
  await scrollTargetToStart(toolsHeading);
  await page.screenshot({
    path: testInfo.outputPath("sms-suppressions-local-tools-1440.png"),
    fullPage: false,
    animations: "disabled",
  });

  await scrollTargetToStart(
    page.getByRole("heading", {
      name: "Authoritative suppression registry",
    }),
  );

  await page.evaluate(() => {
    // Dark is the renderer default; only the light theme has a data-theme
    // attribute. Let the global 200 ms color transition settle before axe so
    // it does not audit an intentionally transient mixed palette.
    document.documentElement.removeAttribute("data-theme");
  });
  await page.waitForTimeout(250);
  await assertNoSeriousA11yViolations(page);
  await page.screenshot({
    path: testInfo.outputPath("sms-suppressions-dark-1440.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await page.waitForTimeout(250);

  await page.getByRole("button", { name: "Add manual suppression" }).click();
  await expect(
    page.getByRole("heading", { name: "Add SMS suppression" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("sms-suppressions-add-dialog-1440.png"),
    fullPage: false,
    animations: "disabled",
  });
  await page.locator("#sms-supp-phone").fill("(202) 555-0104");
  await page.getByRole("button", { name: "Suppress" }).click();
  await expect
    .poll(() =>
      harness.requests.find(
        (request) =>
          request.pathname === "/api/v1/sms/suppressions" &&
          request.method === "POST",
      ),
    )
    .toMatchObject({
      body: JSON.stringify({ phone: "+12025550104", reason: "manual" }),
      search: "",
    });
  await expect(page.getByText("+1 (202) 555-0104")).toBeVisible();

  const addedRemove = page.getByRole("button", {
    name: "Remove suppression for +1 (202) 555-0104",
  });
  await addedRemove.focus();
  await addedRemove.click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(addedRemove).toBeFocused();
  await addedRemove.click();
  await page
    .locator('[role="alertdialog"] input[type="text"]')
    .fill("+12025550104");
  await page.getByRole("button", { name: "Remove manual suppression" }).click();
  await expect
    .poll(() =>
      harness.requests.find(
        (request) =>
          request.pathname ===
            "/api/v1/sms/suppressions/ffffffff-ffff-4fff-8fff-ffffffffffff" &&
          request.method === "DELETE",
      ),
    )
    .toMatchObject({ body: null, search: "" });
  await expect(page.getByText("+1 (202) 555-0104")).toHaveCount(0);

  const search = page.getByRole("searchbox", {
    name: "Filter by exact US/Canada phone",
  });
  await search.fill(EXACT_PHONE);
  await expect
    .poll(() =>
      harness.requests.find(
        (request) =>
          request.pathname === "/api/v1/sms/suppressions/query" &&
          request.method === "POST",
      ),
    )
    .toMatchObject({ search: "" });
  const exactLookup = harness.requests.find(
    (request) => request.pathname === "/api/v1/sms/suppressions/query",
  );
  expect(exactLookup?.body).toContain(EXACT_PHONE);
  expect(exactLookup?.pathname).not.toContain(EXACT_PHONE);
  expect(exactLookup?.search).not.toContain("12025550101");
  expect(
    `${exactLookup?.pathname ?? ""}${exactLookup?.search ?? ""}`,
  ).not.toContain(encodeURIComponent(EXACT_PHONE));
  await search.fill("");

  harness.registryState.current = "empty";
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(
    page.getByRole("heading", { name: "No SMS suppressions yet" }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("sms-suppressions-empty.png"),
    fullPage: false,
    animations: "disabled",
  });

  expect(harness.consoleErrors).toEqual([]);
  harness.registryState.current = "error";
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "last verified page remains visible",
  );
  await expect(page.getByText("SECRET upstream provider detail")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Add manual suppression" }),
  ).toBeDisabled();
  expect(harness.consoleErrors.length).toBeGreaterThan(0);
  expect(new Set(harness.consoleErrors)).toEqual(
    new Set([
      "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
    ]),
  );
  harness.consoleErrors.length = 0;

  harness.registryState.current = "populated";
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("+1 (202) 555-0101")).toBeVisible();
  await page.getByRole("button", { name: "Remove" }).click();
  await expect(
    page.getByRole("button", { name: "Remove manual suppression" }),
  ).toBeDisabled();
  await expect(page.getByText(`Type ${EXACT_PHONE} to confirm.`)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  for (const viewport of [
    { width: 720, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`sms-suppressions-${viewport.width}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }

  await scrollTargetToStart(policyHeading);
  await page.screenshot({
    path: testInfo.outputPath("sms-suppressions-policy-390.png"),
    fullPage: false,
    animations: "disabled",
  });
  await legacyCountryToggle.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "nearest" });
  });
  await expect(legacyCountryToggle).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath("sms-suppressions-legacy-country-row-390.png"),
    fullPage: false,
    animations: "disabled",
  });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await assertNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath("sms-suppressions-320-text-200.png"),
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
    path: testInfo.outputPath("sms-suppressions-forced-colors.png"),
    fullPage: false,
    animations: "disabled",
  });

  const requestsBeforeOffline = harness.protectedRequests.length;
  await context.setOffline(true);
  await expect(
    page.getByRole("heading", { name: "Connection required" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Authoritative suppression registry" }),
  ).toHaveCount(0);
  expect(harness.protectedRequests).toHaveLength(requestsBeforeOffline);
  await page.screenshot({
    path: testInfo.outputPath("sms-suppressions-offline-gate.png"),
    fullPage: false,
    animations: "disabled",
  });
  await context.setOffline(false);
  // The shared destination gate observes the browser `online` event and
  // retires its retry control as soon as it revalidates. Assert that automatic
  // recovery instead of racing a button that is intentionally unmounted.
  await expect(page.getByText("+1 (202) 555-0101")).toBeVisible();

  expect(harness.pageErrors).toEqual([]);
  expect(harness.consoleErrors).toEqual([]);
});

test("viewer route starts zero private SMS authority requests", async ({
  bootApp,
  page,
  setTheme,
}) => {
  await bootApp(page);
  await setTheme(page, "light");
  const harness = await installHarness(page, "viewer");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app/sms-suppressions");
  await waitForPrimaryNavigation(page);
  await expect(
    page.getByText("Authoritative suppression registry"),
  ).toHaveCount(0);
  await assertNoHorizontalOverflow(page);
  expect(harness.protectedRequests).toEqual([]);
  expect(harness.pageErrors).toEqual([]);
  expect(harness.consoleErrors).toEqual([]);
});
