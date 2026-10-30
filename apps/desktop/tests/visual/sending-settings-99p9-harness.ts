import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type {
  ConsoleMessage,
  Locator,
  Page,
  Request,
  Route,
  TestInfo,
} from "@playwright/test";

import { expect, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export const ROUTE46_FIXED_TIME = "2026-08-30T12:00:00.000Z";
export const ROUTE46_TENANT_ID = "46464646-4646-4464-9464-464646464646";
export const ROUTE46_USER_ID = "46464646-4646-4464-8464-464646464646";
export const ROUTE46_UPDATED_AT = "2026-08-30T10:46:00.000Z";
export const ROUTE46_SAVED_AT = "2026-08-30T10:47:00.000Z";
export const ROUTE46_CLEARED_AT = "2026-08-30T10:48:00.000Z";
export const ROUTE46_IP_POOL = "route46-clear-pool";

export const ROUTE46_DEMO_PROFILE =
  (process.env.VITE_BUILD_PROFILE ?? "visual-test").trim().toLowerCase() ===
  "demo";

export type SendingEvidenceRole = "admin" | "viewer";
export type SendingReadMode = "ok" | "error";
export type SendingTheme = "dark" | "light";

export interface SendingRequestEvidence {
  body: unknown;
  idempotencyKey: string | null;
  method: string;
  pathname: string;
  search: string;
}

export interface SendingSettingsEvidenceHarness {
  role: SendingEvidenceRole;
  requests: SendingRequestEvidence[];
  protectedRequests: SendingRequestEvidence[];
  mutations: SendingRequestEvidence[];
  unexpected: SendingRequestEvidence[];
  consoleErrors: string[];
  pageErrors: string[];
  externalRequests: string[];
  setSettingsReadMode: (mode: SendingReadMode) => void;
  settingsReadCount: () => number;
  currentSettings: () => Record<string, unknown>;
}

interface OpenSendingSettingsOptions {
  height?: number;
  initialSettingsRead?: SendingReadMode;
  role?: SendingEvidenceRole;
  theme?: SendingTheme;
  width?: number;
}

type BootApp = (page: Page) => Promise<void>;
type SetTheme = (page: Page, theme: "system" | SendingTheme) => Promise<void>;

const SETTINGS_PATH = "/api/v1/settings/sending";
const STATUS_PATH = "/api/v1/settings/sending/status";
const FREQUENCY_PATH = "/api/v1/sending/frequency-caps";

const AUTH_ME = {
  user_id: ROUTE46_USER_ID,
  tenant_id: ROUTE46_TENANT_ID,
  email: "admin@route46.example.invalid",
  role: "admin",
  effective_role: "admin",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Route 46 Evidence Workspace",
  workspace_slug: "route-46-evidence",
} as const;

const CONFIGURED_SETTINGS: Record<string, unknown> = {
  tenant_id: ROUTE46_TENANT_ID,
  max_sends_per_hour: 5_000,
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  quiet_hours_tz: "America/New_York",
  quiet_hours_per_recipient: true,
  fallback_hour_utc: 4,
  ip_pool: { name: ROUTE46_IP_POOL, dedicated: false },
  updated_at: ROUTE46_UPDATED_AT,
};

const CONFIGURED_STATUS = {
  tenant_id: ROUTE46_TENANT_ID,
  max_sends_per_hour: 5_000,
  quiet_hours_start: "22:00",
  quiet_hours_end: "07:00",
  quiet_hours_tz: "America/New_York",
  quiet_hours_per_recipient: true,
  in_quiet_hours: false,
  quiet_changes_at: "2026-08-31T02:00:00.000Z",
  counter_authoritative: false,
  counter_source: "unavailable",
  counter_scope: "unavailable",
  cap_coordination_state: "ready",
  cap_coordination_ready: true,
  cap_coordination_cap: 5_000,
  cap_coordination_matches_settings: true,
  cap_coordination_fence_started_at: null,
} as const;

const FREQUENCY_CAPS = {
  rules: [
    {
      id: "46464646-4646-4464-8464-464646460001",
      label: "Marketing messages",
      max_sends: 3,
      window_hours: 24,
      active: true,
      channels: ["email"],
      created_at: "2026-08-29T10:46:00.000Z",
      updated_at: "2026-08-29T10:46:00.000Z",
    },
  ],
} as const;

function copySettings(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

function requestBody(request: Request): unknown {
  const raw = request.postData();
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return "[invalid-json-body]";
  }
}

function receipt(request: Request): SendingRequestEvidence {
  const url = new URL(request.url());
  return {
    body: requestBody(request),
    idempotencyKey: request.headers()["idempotency-key"] ?? null,
    method: request.method(),
    pathname: url.pathname,
    search: url.search,
  };
}

async function json(
  route: Route,
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "cache-control": "private, no-store",
      "x-postwave-context-epoch": "route46-evidence-epoch-1",
      "x-request-id": `route46-${String(status)}`,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function roleIdentity(role: SendingEvidenceRole): Record<string, unknown> {
  return {
    ...AUTH_ME,
    email: `${role}@route46.example.invalid`,
    role,
    effective_role: role,
  };
}

/**
 * The installed app resolves identity through the native session broker.
 * Override only that identity read; all other broker requests retain the
 * shared fixture's exact transport and therefore remain visible to routes.
 */
async function installRoleSessionBroker(
  page: Page,
  role: SendingEvidenceRole,
): Promise<void> {
  await page.addInitScript(
    ({ identity }) => {
      const install = (): void => {
        const target = window as typeof window & {
          __TAURI_INTERNALS__?: {
            invoke: (
              command: string,
              args?: Record<string, unknown>,
            ) => Promise<unknown>;
            __route46RoleBroker?: boolean;
            [key: string]: unknown;
          };
        };
        const current = target.__TAURI_INTERNALS__;
        if (!current) {
          queueMicrotask(install);
          return;
        }
        if (current.__route46RoleBroker) return;
        const originalInvoke = current.invoke.bind(current);
        Object.defineProperty(target, "__TAURI_INTERNALS__", {
          configurable: true,
          writable: false,
          value: {
            ...current,
            __route46RoleBroker: true,
            invoke: async (
              command: string,
              args?: Record<string, unknown>,
            ): Promise<unknown> => {
              if (command !== "session_broker_stream_request") {
                return originalInvoke(command, args);
              }
              const request = args?.request as { url?: string } | undefined;
              const pathname = new URL(
                request?.url ?? window.location.href,
                window.location.href,
              ).pathname;
              if (pathname !== "/api/v1/auth/me") {
                return originalInvoke(command, args);
              }
              const onEvent = args?.onEvent as
                | {
                    onmessage?: (
                      event:
                        | number[]
                        | { event: "complete" | "error"; message?: string },
                    ) => void;
                  }
                | undefined;
              const payload = new TextEncoder().encode(
                JSON.stringify(identity),
              );
              queueMicrotask(() => {
                onEvent?.onmessage?.(Array.from(payload));
                onEvent?.onmessage?.({ event: "complete" });
              });
              return {
                status: 200,
                statusText: "OK",
                headers: {
                  "content-type": "application/json",
                  "cache-control": "private, no-store",
                  "x-postwave-context-epoch": "route46-evidence-epoch-1",
                },
              };
            },
          },
        });
      };
      install();
    },
    { identity: roleIdentity(role) },
  );
}

function isProtectedPath(pathname: string): boolean {
  return (
    pathname === SETTINGS_PATH ||
    pathname === STATUS_PATH ||
    pathname === FREQUENCY_PATH ||
    pathname.startsWith(`${FREQUENCY_PATH}/`)
  );
}

export async function installSendingSettingsHarness(
  page: Page,
  {
    initialSettingsRead = "ok",
    role = "admin",
  }: Pick<OpenSendingSettingsOptions, "initialSettingsRead" | "role"> = {},
): Promise<SendingSettingsEvidenceHarness> {
  const requests: SendingRequestEvidence[] = [];
  const protectedRequests: SendingRequestEvidence[] = [];
  const mutations: SendingRequestEvidence[] = [];
  const unexpected: SendingRequestEvidence[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const externalRequests: string[] = [];
  let settingsReadMode = initialSettingsRead;
  let settingsReads = 0;
  let mutationSequence = 0;
  let settings = copySettings(CONFIGURED_SETTINGS);

  await installRoleSessionBroker(page, role);
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !["localhost", "127.0.0.1"].includes(url.hostname)
    ) {
      externalRequests.push(request.url());
    }
  });

  // Match only URLs whose path begins with /api/. Vite source modules and
  // optimized assets containing an API string in their query/body never enter
  // this handler. Unowned API paths pass through to the shared boot fixture.
  await page.route(/^https?:\/\/[^/]+\/api\/.*$/u, async (route) => {
    const item = receipt(route.request());
    if (isProtectedPath(item.pathname)) protectedRequests.push(item);

    if (item.pathname === "/api/v1/auth/me") {
      requests.push(item);
      await json(route, roleIdentity(role));
      return;
    }
    if (item.pathname === "/api/v1/me") {
      requests.push(item);
      await json(route, {
        user: `${role}@route46.example.invalid`,
        tenant: "Route 46 Evidence Workspace",
      });
      return;
    }
    if (item.pathname === "/api/v1/audit/my-scopes") {
      requests.push(item);
      await json(route, {
        scopes: role === "admin" ? ["admin"] : [],
        auditScopes: [],
        isAdmin: role === "admin",
      });
      return;
    }
    if (item.pathname === SETTINGS_PATH) {
      requests.push(item);
      if (item.method === "GET") {
        settingsReads += 1;
        if (settingsReadMode === "error") {
          await json(
            route,
            {
              error: {
                code: "sending_settings_temporarily_unavailable",
                message: "Sending settings are temporarily unavailable.",
              },
            },
            503,
          );
          return;
        }
        await json(route, copySettings(settings));
        return;
      }
      if (item.method === "PUT") {
        mutations.push(item);
        const input =
          item.body &&
          typeof item.body === "object" &&
          !Array.isArray(item.body)
            ? (item.body as Record<string, unknown>)
            : {};
        const expected = settings.updated_at ?? "";
        if (input.expected_updated_at !== expected) {
          await json(
            route,
            {
              error: {
                code: "sending_settings_conflict",
                message: "The sending settings revision changed.",
              },
            },
            409,
            { "x-postwave-sending-cap-outcome": "not-committed" },
          );
          return;
        }
        mutationSequence += 1;
        settings = {
          ...settings,
          max_sends_per_hour: input.max_sends_per_hour ?? null,
          quiet_hours_start: input.quiet_hours_start ?? "",
          quiet_hours_end: input.quiet_hours_end ?? "",
          quiet_hours_tz: input.quiet_hours_tz ?? "",
          quiet_hours_per_recipient: input.quiet_hours_per_recipient === true,
          updated_at:
            mutationSequence === 1 ? ROUTE46_SAVED_AT : ROUTE46_CLEARED_AT,
        };
        await json(route, copySettings(settings), 200, {
          "x-postwave-sending-cap-outcome": "committed",
        });
        return;
      }
      unexpected.push(item);
      await json(route, { error: { code: "method_not_allowed" } }, 405);
      return;
    }
    if (item.pathname === STATUS_PATH) {
      requests.push(item);
      if (item.method !== "GET") {
        unexpected.push(item);
        await json(route, { error: { code: "method_not_allowed" } }, 405);
        return;
      }
      await json(route, {
        ...CONFIGURED_STATUS,
        max_sends_per_hour: settings.max_sends_per_hour,
        cap_coordination_cap: settings.max_sends_per_hour,
        quiet_hours_start: settings.quiet_hours_start,
        quiet_hours_end: settings.quiet_hours_end,
        quiet_hours_tz: settings.quiet_hours_tz,
        quiet_hours_per_recipient: settings.quiet_hours_per_recipient,
      });
      return;
    }
    if (item.pathname === FREQUENCY_PATH) {
      requests.push(item);
      if (item.method !== "GET") {
        unexpected.push(item);
        await json(
          route,
          { error: { code: "unexpected_frequency_write" } },
          405,
        );
        return;
      }
      await json(route, FREQUENCY_CAPS);
      return;
    }

    await route.fallback();
  });

  return {
    role,
    requests,
    protectedRequests,
    mutations,
    unexpected,
    consoleErrors,
    pageErrors,
    externalRequests,
    setSettingsReadMode: (mode) => {
      settingsReadMode = mode;
    },
    settingsReadCount: () => settingsReads,
    currentSettings: () => copySettings(settings),
  };
}

export async function openSendingSettings(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  options: OpenSendingSettingsOptions = {},
): Promise<SendingSettingsEvidenceHarness> {
  const role = options.role ?? "admin";
  await setTheme(page, options.theme ?? "light");
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 960,
  });
  await page.clock.setFixedTime(new Date(ROUTE46_FIXED_TIME));
  await bootApp(page);
  const harness = await installSendingSettingsHarness(page, {
    initialSettingsRead: options.initialSettingsRead,
    role,
  });
  await page.goto("/app/sending");
  await waitForPrimaryNavigation(page, 60_000);

  if (role === "viewer") {
    await expect(page.locator(".capability-gate")).toBeVisible({
      timeout: 20_000,
    });
    return harness;
  }

  await expect(
    page.getByRole("heading", { name: "Sending settings", exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  if (options.initialSettingsRead === "error") {
    await expect(
      page.getByRole("heading", { name: "The editor is staying closed" }),
    ).toBeVisible({ timeout: 20_000 });
  } else {
    await expect(
      page.getByRole("heading", { name: "Saved workspace configuration" }),
    ).toBeVisible({ timeout: 20_000 });
  }
  return harness;
}

export async function seriousSendingAxeViolations(
  page: Page,
  {
    disableColorContrast = false,
    root = ".sending-page",
  }: { disableColorContrast?: boolean; root?: string } = {},
): Promise<unknown[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(
    async ({ disableColorContrast, root }) => {
      const axe = (
        window as typeof window & {
          axe: {
            run: (
              owner: Element,
              options: {
                runOnly: { type: "tag"; values: string[] };
                rules?: Record<string, { enabled: boolean }>;
              },
            ) => Promise<{
              violations: Array<{
                id: string;
                impact: string | null;
                nodes: Array<{ target: string[]; failureSummary?: string }>;
              }>;
            }>;
          };
        }
      ).axe;
      const owner = document.querySelector(root);
      if (!owner) throw new Error(`Route 46 axe root is missing: ${root}`);
      const result = await axe.run(owner, {
        runOnly: {
          type: "tag",
          values: [
            "wcag2a",
            "wcag2aa",
            "wcag21a",
            "wcag21aa",
            "wcag22a",
            "wcag22aa",
          ],
        },
        ...(disableColorContrast
          ? { rules: { "color-contrast": { enabled: false } } }
          : {}),
      });
      return result.violations
        .filter(
          (violation) =>
            violation.impact === "serious" || violation.impact === "critical",
        )
        .map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          nodes: violation.nodes.map((node) => ({
            target: node.target,
            failure: node.failureSummary,
          })),
        }));
    },
    { disableColorContrast, root },
  );
}

export async function expectNoSendingHorizontalOverflow(
  page: Page,
): Promise<void> {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const route = document.querySelector<HTMLElement>(".sending-page");
    return {
      body: document.body.scrollWidth - window.innerWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
      document: document.documentElement.scrollWidth - window.innerWidth,
      route: route ? route.scrollWidth - route.clientWidth : 0,
    };
  });
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.content).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.route).toBeLessThanOrEqual(1);
}

export async function saveSendingEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  focus?: Locator,
): Promise<void> {
  await page.evaluate(async () => {
    const main = document.querySelector<HTMLElement>(".main");
    const content = document.querySelector<HTMLElement>(".content");
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    main?.scrollTo({ top: 0, left: 0, behavior: "instant" });
    content?.scrollTo({ top: 0, left: 0, behavior: "instant" });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  if (focus) {
    await focus.evaluate((element) =>
      element.scrollIntoView({
        behavior: "instant",
        block: "start",
        inline: "nearest",
      }),
    );
  }
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({
    path,
    fullPage: false,
    animations: "disabled",
    caret: "hide",
  });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

export async function attachSendingEvidence(
  testInfo: TestInfo,
  name: string,
  harness: SendingSettingsEvidenceHarness,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(
      `${JSON.stringify(
        {
          role: harness.role,
          requests: harness.requests,
          protectedRequests: harness.protectedRequests,
          mutations: harness.mutations,
          unexpected: harness.unexpected,
          externalRequests: harness.externalRequests,
          consoleErrors: harness.consoleErrors,
          pageErrors: harness.pageErrors,
          currentSettings: harness.currentSettings(),
          ...extra,
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    contentType: "application/json",
  });
}

export function expectSendingHarnessClean(
  harness: SendingSettingsEvidenceHarness,
  allowedErrorStatuses: readonly number[] = [],
): void {
  const consoleErrors = harness.consoleErrors.filter(
    (message) =>
      !allowedErrorStatuses.some(
        (status) =>
          message.includes(`status of ${String(status)}`) ||
          message.includes(`status ${String(status)}`),
      ),
  );
  expect(harness.unexpected).toEqual([]);
  expect(harness.externalRequests).toEqual([]);
  expect(harness.pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
}
