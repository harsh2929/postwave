import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ConsoleMessage, Locator, Page, Route } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_CSS = readFileSync(
  path.resolve(__dirname, "../../src/styles-consent.css"),
  "utf8",
);
const EVIDENCE_DIRECTORY = path.resolve(
  __dirname,
  "../../../../audit-screenshots/2026-08-20/route-38",
);

const FIXED_NOW = "2026-08-20T10:00:00.000Z";
const WORKSPACE_ID = "00000000-0000-7000-8000-000000000038";
const USER_ID = "00000000-0000-7000-8000-000000000138";
// Production cursors are opaque base64url payloads authenticated by a
// base64url HMAC. The qualification fixture does not inspect either part, but
// it must exercise the exact dotted wire contract accepted by strict clients.
const RECEIPT_CURSOR = "route-38-receipt-page-2.fixture-signature";
const EVENT_CURSOR = "route-38-event-page-2.fixture-signature";
const SNAPSHOT_AT = "2026-08-20T09:59:59.999999Z";

type Theme = "dark" | "light";
type BootApp = (page: Page) => Promise<void>;
type SetTheme = (
  page: Page,
  theme: "system" | "dark" | "light",
) => Promise<void>;

interface RequestReceipt {
  method: string;
  pathname: string;
  search: string;
}

interface Harness {
  consentRequests: RequestReceipt[];
  unsafeRequests: RequestReceipt[];
  externalRequests: string[];
  consoleErrors: string[];
  pageErrors: string[];
}

interface HarnessOptions {
  receiptFailure?: boolean;
  eventFailure?: boolean;
}

interface Qualification {
  id: string;
  theme: Theme;
  width: number;
  height: number;
  interactions?: boolean;
  textSpacing?: boolean;
}

const AUTH_ME = {
  user_id: USER_ID,
  tenant_id: WORKSPACE_ID,
  email: "consent-admin@example.invalid",
  role: "admin",
  effective_role: "admin",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Consent evidence qualification",
  workspace_slug: "consent-evidence-qualification",
};

const VIEWER_ME = {
  ...AUTH_ME,
  role: "viewer",
  effective_role: "viewer",
};

const RECEIPT_PAGE_ONE = [
  {
    id: "9042",
    subscriber_email: "avery@example.invalid",
    prev_state: "pending",
    new_state: "subscribed",
    source: "form:launch-list",
    source_detail: "https://example.invalid/join",
    ip: "192.0.2.42",
    user_agent: "Moosewave qualification browser",
    privacy_policy_version: "privacy-2026-08",
    captured_text: "Send me product updates.",
    at: "2026-08-20T09:42:00.000000Z",
    recorded_at: "2026-08-20T09:42:00.200000Z",
    kind: "receipt",
  },
  {
    id: "00000000-0000-7000-8000-000000000238",
    subscriber_email: "samira@example.invalid",
    new_state: "withdrawn",
    source: "csv_import",
    source_detail: "reviewed import batch",
    at: "2026-08-19T14:20:00.000000Z",
    recorded_at: "2026-08-19T14:20:00.100000Z",
    kind: "proof",
  },
  {
    id: "9039",
    subscriber_email: "jordan@example.invalid",
    new_state: "pending",
    source: "api:/v1/subscribers",
    at: "2026-08-18T08:00:00.000000Z",
    recorded_at: "2026-08-18T08:00:00.050000Z",
    kind: "receipt",
  },
] as const;

const RECEIPT_PAGE_TWO = [
  {
    id: "9030",
    subscriber_email: "older@example.invalid",
    prev_state: "subscribed",
    new_state: "unsubscribed",
    source: "public_preferences",
    at: "2026-08-01T10:00:00.000000Z",
    recorded_at: "2026-08-01T10:00:00.010000Z",
    kind: "receipt",
  },
] as const;

const DECISION_ID = "00000000-0000-8000-8000-000000000338";
const EVENT_PAGE_ONE = [
  {
    id: "00000000-0000-7000-8000-000000000348",
    decision_id: DECISION_ID,
    subject_type: "visitor",
    subject_id: "visitor_route_38_known",
    subject_email: "avery@example.invalid",
    channel: "web",
    category: "essential",
    action: "granted",
    source: "gpc",
    policy_version: "privacy-2026-08",
    preferences: { choice: "gpc", granted: true, gpc: true },
    created_at: "2026-08-20T09:40:00.000000Z",
    recorded_at: "2026-08-20T09:40:00.300000Z",
  },
  {
    id: "00000000-0000-7000-8000-000000000347",
    decision_id: DECISION_ID,
    subject_type: "visitor",
    subject_id: "visitor_route_38_known",
    subject_email: "avery@example.invalid",
    channel: "web",
    category: "analytics",
    action: "denied",
    source: "gpc",
    policy_version: "privacy-2026-08",
    preferences: { choice: "gpc", granted: false, gpc: true },
    created_at: "2026-08-20T09:40:00.000000Z",
    recorded_at: "2026-08-20T09:40:00.200000Z",
  },
  {
    id: "00000000-0000-7000-8000-000000000346",
    decision_id: DECISION_ID,
    subject_type: "visitor",
    subject_id: "visitor_route_38_known",
    subject_email: "avery@example.invalid",
    channel: "web",
    category: "marketing",
    action: "denied",
    source: "gpc",
    policy_version: "privacy-2026-08",
    preferences: { choice: "gpc", granted: false, gpc: true },
    created_at: "2026-08-20T09:40:00.000000Z",
    recorded_at: "2026-08-20T09:40:00.100000Z",
  },
  {
    id: "00000000-0000-7000-8000-000000000345",
    subject_type: "visitor",
    channel: "web",
    category: "marketing",
    action: "denied",
    source: "gpc",
    policy_version: "legacy-unattributed",
    preferences: { gpc: true },
    created_at: "2026-08-19T09:00:00.000000Z",
    recorded_at: "2026-08-19T09:00:00.100000Z",
  },
] as const;

const EVENT_PAGE_TWO = [
  {
    id: "00000000-0000-7000-8000-000000000344",
    subject_type: "subscriber",
    subject_id: "subscriber_route_38_older",
    subject_email: "older@example.invalid",
    channel: "email",
    category: "email_marketing",
    action: "revoked",
    source: "preference_center",
    policy_version: "privacy-2026-07",
    created_at: "2026-08-01T09:00:00.000000Z",
    recorded_at: "2026-08-01T09:00:00.100000Z",
  },
] as const;

const CASES: readonly Qualification[] = [
  {
    id: "1440x1000-dark",
    theme: "dark",
    width: 1440,
    height: 1000,
    interactions: true,
  },
  { id: "1440x1000-light", theme: "light", width: 1440, height: 1000 },
  {
    id: "390x844-dark",
    theme: "dark",
    width: 390,
    height: 844,
    interactions: true,
  },
  { id: "390x844-light", theme: "light", width: 390, height: 844 },
  {
    id: "320x800-dark-text-spacing",
    theme: "dark",
    width: 320,
    height: 800,
    textSpacing: true,
  },
  {
    id: "720x900-light-200pct-equivalent",
    theme: "light",
    width: 720,
    height: 900,
  },
];

function requestReceipt(route: Route): RequestReceipt {
  const request = route.request();
  const url = new URL(request.url());
  return {
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
      "cache-control": "private, no-store",
      vary: "Authorization, Cookie",
    },
    body: JSON.stringify(body),
  });
}

async function installNativeSessionBroker(
  page: Page,
  authMe: typeof AUTH_ME = AUTH_ME,
): Promise<void> {
  await page.addInitScript((authMe) => {
    const install = (): void => {
      const target = window as typeof window & {
        __TAURI_INTERNALS__?: {
          invoke: (
            command: string,
            args?: Record<string, unknown>,
          ) => Promise<unknown>;
          __consentRoute38Broker?: boolean;
          [key: string]: unknown;
        };
      };
      const current = target.__TAURI_INTERNALS__;
      if (!current) {
        queueMicrotask(install);
        return;
      }
      if (current.__consentRoute38Broker) return;
      const originalInvoke = current.invoke.bind(current);
      Object.defineProperty(target, "__TAURI_INTERNALS__", {
        configurable: true,
        writable: false,
        value: {
          ...current,
          __consentRoute38Broker: true,
          invoke: async (
            command: string,
            args?: Record<string, unknown>,
          ): Promise<unknown> => {
            const evidenceTarget = window as typeof window & {
              __consentRoute38NativeCommands?: string[];
            };
            evidenceTarget.__consentRoute38NativeCommands ??= [];
            evidenceTarget.__consentRoute38NativeCommands.push(command);
            if (command === "session_broker_initialize") {
              return { baseUrl: String(args?.baseUrl ?? "") };
            }
            if (command === "session_broker_stream_request") {
              const request = args?.request as
                | {
                    url?: string;
                    method?: string;
                    headers?: Record<string, string>;
                    body?: number[];
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
                  ? new Response(JSON.stringify(authMe), {
                      status: 200,
                      headers: { "content-type": "application/json" },
                    })
                  : await fetch(requestUrl, {
                      method: request?.method ?? "GET",
                      headers: request?.headers,
                      body:
                        request?.body && request.body.length > 0
                          ? new Uint8Array(request.body)
                          : undefined,
                    });
              const payload = new Uint8Array(await response.arrayBuffer());
              const responseHeaders: Record<string, string> = {};
              response.headers.forEach((value, name) => {
                responseHeaders[name] = value;
              });
              queueMicrotask(() => {
                onEvent?.onmessage?.(Array.from(payload));
                onEvent?.onmessage?.({ event: "complete" });
              });
              return {
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders,
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
  }, authMe);
}

async function installStructuredSessionUser(
  page: Page,
  authMe: typeof AUTH_ME = AUTH_ME,
): Promise<void> {
  await page.addInitScript((authMe) => {
    window.sessionStorage.setItem(
      "postwave_session_user",
      JSON.stringify({
        user_id: authMe.user_id,
        tenant_id: authMe.tenant_id,
        role: authMe.role,
        effective_role: authMe.effective_role,
        auth_provider: authMe.auth_provider,
      }),
    );
  }, authMe);
}

async function installHarness(
  page: Page,
  authMe: typeof AUTH_ME = AUTH_ME,
  options: HarnessOptions = {},
): Promise<Harness> {
  const consentRequests: RequestReceipt[] = [];
  const unsafeRequests: RequestReceipt[] = [];
  const externalRequests: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ) {
      externalRequests.push(request.url());
    }
  });

  await page.route("**/src/**", (route) => route.continue());
  await page.route("**/api/v1/auth/me", (route) => json(route, authMe));
  await page.route("**/api/v1/me", (route) =>
    json(route, { user: authMe.email, tenant: authMe.workspace_name }),
  );
  await page.route("**/api/v1/consent/receipts**", async (route) => {
    const entry = requestReceipt(route);
    consentRequests.push(entry);
    if (
      entry.method !== "GET" ||
      entry.pathname.includes("/by-email/") ||
      /export|download/iu.test(entry.pathname)
    ) {
      unsafeRequests.push(entry);
      await json(route, { error: { code: "unsafe_route_38_request" } }, 501);
      return;
    }
    if (options.receiptFailure) {
      await json(
        route,
        {
          error: {
            code: "receipt_evidence_unavailable",
            message: "Fixture detail must not be reflected.",
          },
        },
        503,
      );
      return;
    }
    const cursor = new URLSearchParams(entry.search).get("cursor");
    if (cursor === RECEIPT_CURSOR) {
      await json(route, {
        schema_version: 1,
        workspace_id: WORKSPACE_ID,
        snapshot_at: SNAPSHOT_AT,
        source_planes: ["consent_receipts", "consent_records"],
        receipts: RECEIPT_PAGE_TWO,
        count: RECEIPT_PAGE_TWO.length,
        has_more: false,
      });
      return;
    }
    await json(route, {
      schema_version: 1,
      workspace_id: WORKSPACE_ID,
      snapshot_at: SNAPSHOT_AT,
      source_planes: ["consent_receipts", "consent_records"],
      receipts: RECEIPT_PAGE_ONE,
      count: RECEIPT_PAGE_ONE.length,
      has_more: true,
      next_cursor: RECEIPT_CURSOR,
    });
  });
  await page.route("**/api/v1/consent/events**", async (route) => {
    const entry = requestReceipt(route);
    consentRequests.push(entry);
    if (entry.method !== "GET") {
      unsafeRequests.push(entry);
      await json(route, { error: { code: "unsafe_route_38_request" } }, 501);
      return;
    }
    if (options.eventFailure) {
      await json(
        route,
        {
          error: {
            code: "event_evidence_unavailable",
            message: "Fixture detail must not be reflected.",
          },
        },
        503,
      );
      return;
    }
    const cursor = new URLSearchParams(entry.search).get("cursor");
    if (cursor === EVENT_CURSOR) {
      await json(route, {
        schema_version: 1,
        workspace_id: WORKSPACE_ID,
        snapshot_at: SNAPSHOT_AT,
        source_planes: ["consent_events"],
        events: EVENT_PAGE_TWO,
        count: EVENT_PAGE_TWO.length,
        has_more: false,
      });
      return;
    }
    await json(route, {
      schema_version: 1,
      workspace_id: WORKSPACE_ID,
      snapshot_at: SNAPSHOT_AT,
      source_planes: ["consent_events"],
      events: EVENT_PAGE_ONE,
      count: EVENT_PAGE_ONE.length,
      has_more: true,
      next_cursor: EVENT_CURSOR,
    });
  });

  return {
    consentRequests,
    unsafeRequests,
    externalRequests,
    consoleErrors,
    pageErrors,
  };
}

async function openRoute(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  qualification: Qualification,
  harnessOptions: HarnessOptions = {},
): Promise<Harness> {
  await setTheme(page, qualification.theme);
  await page.setViewportSize({
    width: qualification.width,
    height: qualification.height,
  });
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await bootApp(page);
  await installNativeSessionBroker(page);
  await installStructuredSessionUser(page);
  const harness = await installHarness(page, AUTH_ME, harnessOptions);
  await page.goto("/app/consent");
  await waitForPrimaryNavigation(page);
  const workspace = page.getByTestId("consent-command-center");
  if (!(await workspace.isVisible().catch(() => false))) {
    await page
      .getByRole("navigation", { name: "Primary" })
      .locator('button[data-section="consent"]')
      .last()
      .click();
  }
  await expect(workspace).toBeVisible({ timeout: 20_000 });
  await expect(workspace).toContainText("3");
  await page.evaluate(async () => document.fonts.ready);
  return harness;
}

async function axeViolations(root: Locator): Promise<unknown[]> {
  const page = root.page();
  await page.addScriptTag({ content: AXE_SOURCE });
  return root.evaluate(async (element) => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            root: Element,
            options: { runOnly: { type: "tag"; values: string[] } },
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              help: string;
              nodes: Array<{ target: string[]; failureSummary?: string }>;
            }>;
          }>;
        };
      }
    ).axe;
    const result = await axe.run(element, {
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
    });
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        failure: node.failureSummary,
      })),
    }));
  });
}

async function expectNoTaskOverflow(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const shellRect = shell?.getBoundingClientRect();
    const selectors = [
      ["content", ".content"],
      ["workspace", ".consent-command-center"],
      ["register", ".consent-register"],
      ["drawer", ".consent-detail"],
    ] as const;
    return {
      document: document.documentElement.scrollWidth - window.innerWidth,
      body: document.body.scrollWidth - window.innerWidth,
      viewportHeight: window.innerHeight,
      shellTop: shellRect?.top ?? null,
      shellBottom: shellRect?.bottom ?? null,
      offenders: Array.from(
        document.querySelectorAll<HTMLElement>(
          ".consent-command-center *, .content > *",
        ),
      )
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          className: element.className,
          delta: element.scrollWidth - element.clientWidth,
          clientWidth: element.clientWidth,
        }))
        .filter((entry) => entry.delta > 1)
        .sort((left, right) => right.delta - left.delta)
        .slice(0, 12),
      surfaces: selectors.map(([name, selector]) => {
        const element = document.querySelector<HTMLElement>(selector);
        return {
          name,
          visible: Boolean(
            element && getComputedStyle(element).display !== "none",
          ),
          overflowX: element ? getComputedStyle(element).overflowX : "",
          delta: element ? element.scrollWidth - element.clientWidth : 0,
        };
      }),
    };
  });
  expect(result.document, JSON.stringify(result)).toBeLessThanOrEqual(1);
  expect(result.body, JSON.stringify(result)).toBeLessThanOrEqual(1);
  expect(result.shellTop, JSON.stringify(result)).not.toBeNull();
  expect(result.shellTop ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1);
  expect(
    Math.abs((result.shellBottom ?? 0) - result.viewportHeight),
    JSON.stringify(result),
  ).toBeLessThanOrEqual(1);
  for (const surface of result.surfaces) {
    if (
      surface.visible &&
      surface.overflowX !== "clip" &&
      surface.overflowX !== "hidden"
    ) {
      expect(
        surface.delta,
        `${surface.name}: ${JSON.stringify(result)}`,
      ).toBeLessThanOrEqual(1);
    }
  }
}

async function expectMinimumTarget(
  locator: Locator,
  label: string,
): Promise<void> {
  await expect(locator, `${label} should be visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} should have measurable geometry`).not.toBeNull();
  expect(box?.width ?? 0, `${label} width`).toBeGreaterThanOrEqual(44);
  expect(box?.height ?? 0, `${label} height`).toBeGreaterThanOrEqual(44);
}

async function capture(
  page: Page,
  qualification: Qualification,
  suffix: string,
): Promise<void> {
  await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
  await page.screenshot({
    path: path.join(
      EVIDENCE_DIRECTORY,
      `consent-receipts-${qualification.id}-${suffix}.png`,
    ),
    fullPage: false,
    animations: "disabled",
    caret: "hide",
  });
}

async function qualifyDrawer(
  page: Page,
  qualification: Qualification,
): Promise<void> {
  const desktopOpener = page.getByRole("button", {
    name: "Review state-change receipt for avery@example.invalid",
  });
  const mobileOpener = page
    .locator(".consent-evidence-card")
    .filter({ hasText: "avery@example.invalid" })
    .getByRole("button", { name: "Review recorded evidence" });
  const opener = qualification.width <= 760 ? mobileOpener : desktopOpener;
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "avery@example.invalid" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Review raw evidence" }),
  ).toBeFocused();
  expect(new URL(page.url()).searchParams.get("overlay")).toBe(
    "consent-receipt-evidence",
  );
  await expect(dialog).toContainText("2026-08-20T09:42:00.200Z");
  await expect(dialog).toContainText(
    "Stored evidence, not an independent assurance",
  );
  await expect(dialog).not.toContainText("Immutable record");
  await expect(dialog).not.toContainText("GPC respected");
  await expect(
    dialog.getByRole("button", { name: /copy|export|download/iu }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Review raw evidence" }).click();
  await expect(dialog.getByText("Sensitive personal data")).toBeVisible();
  await expect(dialog.getByLabel("Raw consent evidence JSON")).toContainText(
    "192.0.2.42",
  );
  expect(await axeViolations(dialog)).toEqual([]);
  await expectNoTaskOverflow(page);
  await capture(page, qualification, "drawer");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
}

async function expectHarnessClean(page: Page, harness: Harness): Promise<void> {
  expect(harness.unsafeRequests).toEqual([]);
  expect(
    harness.consentRequests.filter(({ method }) => method !== "GET"),
  ).toEqual([]);
  expect(
    harness.consentRequests.filter(({ pathname }) =>
      /by-email|export|download/iu.test(pathname),
    ),
  ).toEqual([]);
  const nativeSensitiveWrites = await page.evaluate(() => {
    const commands = (
      window as typeof window & {
        __consentRoute38NativeCommands?: string[];
      }
    ).__consentRoute38NativeCommands;
    return (commands ?? []).filter((command) =>
      /^(?:plugin:clipboard-manager\|write_text|transfer_begin_save|transfer_write_chunk|transfer_finish_save)$/u.test(
        command,
      ),
    );
  });
  expect(nativeSensitiveWrites).toEqual([]);
  expect(harness.externalRequests).toEqual([]);
  expect(harness.consoleErrors).toEqual([]);
  expect(harness.pageErrors).toEqual([]);
}

test.describe.configure({ timeout: 120_000 });

test("route-owned Consent CSS contains explicit reflow, reduced-motion, and forced-color boundaries", () => {
  expect(ROUTE_CSS).toContain("@media (max-width: 700px)");
  expect(ROUTE_CSS).toContain("@media (prefers-reduced-motion: reduce)");
  expect(ROUTE_CSS).toContain("@media (forced-colors: active)");
  expect(ROUTE_CSS).toContain(".consent-card-view");
});

test("viewer entry is denied before any consent evidence request", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const qualification: Qualification = {
    id: "390x844-viewer-denied",
    theme: "dark",
    width: 390,
    height: 844,
  };
  await setTheme(page, qualification.theme);
  await page.setViewportSize({
    width: qualification.width,
    height: qualification.height,
  });
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await bootApp(page);
  await installNativeSessionBroker(page, VIEWER_ME);
  await installStructuredSessionUser(page, VIEWER_ME);
  const harness = await installHarness(page, VIEWER_ME);

  await page.goto("/app/consent");
  await waitForPrimaryNavigation(page);

  await expect(
    page.getByRole("heading", { name: "Access required" }),
  ).toBeVisible();
  await expect(
    page
      .locator(".capability-gate")
      .getByText("This destination requires the admin role."),
  ).toBeVisible();
  await expect(page.getByTestId("consent-command-center")).toHaveCount(0);
  await expectNoTaskOverflow(page);
  await capture(page, qualification, "boundary");
  expect(harness.consentRequests).toEqual([]);
  await expectHarnessClean(page, harness);
});

test("receipt evidence remains bounded and usable when event correlation is unavailable", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const qualification: Qualification = {
    id: "1440x1000-dark-event-unavailable",
    theme: "dark",
    width: 1440,
    height: 1000,
  };
  const harness = await openRoute(page, bootApp, setTheme, qualification, {
    eventFailure: true,
  });
  const workspace = page.getByTestId("consent-command-center");

  await expect(workspace).toContainText("event unavailable");
  await expect(workspace).toContainText(
    "Couldn’t verify consent-event correlation.",
  );
  await expect(
    page.locator(
      'table[aria-label="Loaded receipt and proof evidence"] tbody tr',
    ),
  ).toHaveCount(3);
  const gpcStat = page
    .locator(".stat-strip-v2-cell")
    .filter({ hasText: "Known GPC subjects · 30d" });
  await expect(gpcStat.locator(".stat-strip-v2-value")).toHaveText("—");
  await expect(workspace).not.toContainText("GPC respected");
  await expect(workspace).not.toContainText("Fixture detail");
  await expectNoTaskOverflow(page);
  expect(await axeViolations(workspace)).toEqual([]);
  await capture(page, qualification, "boundary");
  expect(
    harness.consentRequests.some(
      ({ method, pathname }) =>
        method === "GET" && pathname === "/api/v1/consent/receipts",
    ),
  ).toBe(true);
  expect(
    harness.consentRequests.some(
      ({ method, pathname }) =>
        method === "GET" && pathname === "/api/v1/consent/events",
    ),
  ).toBe(true);
  expect(harness.consoleErrors.length).toBeGreaterThan(0);
  expect(
    harness.consoleErrors.every((message) =>
      /Failed to load resource:.*503 \(Service Unavailable\)/u.test(message),
    ),
  ).toBe(true);
  harness.consoleErrors.length = 0;
  await expectHarnessClean(page, harness);
});

for (const qualification of CASES) {
  test(`${qualification.id} qualifies the Route 38 Consent command center`, async ({
    page,
    bootApp,
    setTheme,
  }) => {
    const harness = await openRoute(page, bootApp, setTheme, qualification);
    const workspace = page.getByTestId("consent-command-center");
    await expect(
      page.getByRole("heading", { name: /^Consent evidence/u }),
    ).toBeVisible();
    await expect(workspace).toContainText(
      "Know exactly what this view can prove",
    );
    await expect(workspace).toContainText("Older pages available");
    await expect(workspace).toContainText("1 known GPC subject loaded");
    await expect(workspace).toContainText(
      "1 loaded 30-day GPC-tagged row has no stable subject ID or email",
    );
    await expect(workspace).toContainText("Evidence boundaries");
    await expect(workspace).not.toContainText("Every recorded opt-in");
    await expect(workspace).not.toContainText("Immutable record");
    await expect(workspace).not.toContainText("GPC respected");
    await expect(
      workspace.getByRole("button", { name: /export|download/iu }),
    ).toHaveCount(0);

    const narrow = qualification.width <= 760;
    if (narrow) {
      await expect(page.locator(".consent-evidence-card")).toHaveCount(3);
      await expect(page.locator(".consent-table-view")).toBeHidden();
      await expectMinimumTarget(
        page.getByRole("button", { name: "Refresh evidence" }),
        "refresh evidence",
      );
      await expectMinimumTarget(
        page.getByRole("button", { name: "Forms, 1 loaded" }),
        "source filter",
      );
      await expectMinimumTarget(
        page.getByRole("searchbox", { name: "Search loaded evidence" }),
        "evidence search",
      );
      await expectMinimumTarget(
        page
          .locator(".consent-evidence-card")
          .filter({ hasText: "avery@example.invalid" })
          .getByRole("button", { name: "Review recorded evidence" }),
        "evidence opener",
      );
    } else {
      await expect(
        page.locator(
          'table[aria-label="Loaded receipt and proof evidence"] tbody tr',
        ),
      ).toHaveCount(3);
    }

    await expectNoTaskOverflow(page);
    expect(await axeViolations(workspace)).toEqual([]);
    await capture(page, qualification, "overview");
    const register = page.locator(".consent-register");
    await register.evaluate((element) => {
      const scrollOwner = element.closest<HTMLElement>(".content");
      if (!scrollOwner) throw new Error("Consent content scroll owner missing");
      const ownerTop = scrollOwner.getBoundingClientRect().top;
      const elementTop = element.getBoundingClientRect().top;
      scrollOwner.scrollTo({
        top: scrollOwner.scrollTop + elementTop - ownerTop,
        behavior: "instant",
      });
    });
    await expect
      .poll(
        async () =>
          (await register.boundingBox())?.y ?? Number.POSITIVE_INFINITY,
      )
      .toBeLessThanOrEqual(qualification.height * 0.35);
    await expectNoTaskOverflow(page);
    await capture(page, qualification, "register");

    await page.getByRole("button", { name: "Forms, 1 loaded" }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("f.source"))
      .toBe("form");
    await expect(page.locator(".consent-result-count")).toContainText(
      "1 of 3 loaded",
    );
    await page.getByRole("button", { name: "All sources, 3 loaded" }).click();
    const search = page.getByRole("searchbox", {
      name: "Search loaded evidence",
    });
    await search.fill("samira");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("q"))
      .toBe("samira");
    await search.fill("");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("q"))
      .toBeNull();

    if (qualification.interactions) {
      await page.getByRole("button", { name: "Load older events" }).click();
      await expect(workspace).toContainText("5");
      await page.getByRole("button", { name: "Load more" }).click();
      await expect(workspace).toContainText("4");
      await expect(
        page.getByText("End of the loaded receipt / proof page family"),
      ).toBeVisible();
      expect(
        harness.consentRequests.filter(
          ({ pathname, search: query }) =>
            pathname === "/api/v1/consent/receipts" &&
            new URLSearchParams(query).has("cursor"),
        ),
      ).toHaveLength(1);
      expect(
        harness.consentRequests.filter(
          ({ pathname, search: query }) =>
            pathname === "/api/v1/consent/events" &&
            new URLSearchParams(query).has("cursor"),
        ),
      ).toHaveLength(1);
      await qualifyDrawer(page, qualification);
    }

    if (qualification.textSpacing) {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const spacingStyle = await page.addStyleTag({
        content:
          "*:not(svg):not(path) { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }",
      });
      await expectNoTaskOverflow(page);
      await spacingStyle.evaluate((element) =>
        element.parentNode?.removeChild(element),
      );
      await page.emulateMedia({
        forcedColors: "active",
        reducedMotion: "reduce",
      });
      await expectNoTaskOverflow(page);
      await page.emulateMedia({
        forcedColors: "none",
        reducedMotion: "no-preference",
      });
    }

    await expectNoTaskOverflow(page);
    await expectHarnessClean(page, harness);
  });
}
