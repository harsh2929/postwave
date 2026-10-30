import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ConsoleMessage, Locator, Page, Route } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const ROUTE_CSS = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../src/styles-privacy-incidents.css",
  ),
  "utf8",
);
const FIXED_NOW = "2026-08-19T10:00:00.000Z";
const PAGE_TWO_CURSOR = "privacy-route-37-page-2";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIRECTORY = path.resolve(
  __dirname,
  "../../../../audit-screenshots/2026-08-19/route-37",
);

type Theme = "dark" | "light";
type BootApp = (page: Page) => Promise<void>;
type SetTheme = (
  page: Page,
  theme: "system" | "dark" | "light",
) => Promise<void>;

interface Receipt {
  method: string;
  pathname: string;
  search: string;
}

interface Harness {
  privacyRequests: Receipt[];
  unsafeWrites: Receipt[];
  externalRequests: string[];
  consoleErrors: string[];
  pageErrors: string[];
}

interface Qualification {
  id: string;
  theme: Theme;
  width: number;
  height: number;
  interactionEvidence?: boolean;
  textSpacing?: boolean;
}

const AUTH_ME = {
  user_id: "privacy-route-37-admin",
  tenant_id: "privacy-route-37-tenant",
  email: "privacy-admin@example.invalid",
  role: "admin",
  effective_role: "admin",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Privacy qualification",
  workspace_slug: "privacy-qualification",
};

const IDS = {
  targetPassed: "00000000-0000-7000-8000-000000000371",
  critical: "00000000-0000-7000-8000-000000000372",
  incomplete: "00000000-0000-7000-8000-000000000373",
  closed: "00000000-0000-7000-8000-000000000374",
  later: "00000000-0000-7000-8000-000000000375",
} as const;

type IncidentState = "open" | "contained" | "notifications_pending" | "closed";
type Severity = "investigating" | "low" | "medium" | "high" | "critical";

function listIncident(
  id: string,
  summary: string,
  severity: Severity,
  status: IncidentState,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    severity,
    status,
    detected_at: "2026-08-18T08:00:00.000Z",
    discovered_at: "2026-08-18T08:20:00.000Z",
    clock_started_at: "2026-08-18T08:00:00.000Z",
    gdpr_72h_deadline: "2026-08-21T08:00:00.000Z",
    template_version: "privacy-route-37-v1",
    affected_regions: ["European Economic Area"],
    affected_data_categories: ["contact_data"],
    affected_subject_count: 0,
    notification_decisions: {},
    jurisdictions: ["GDPR"],
    summary,
    created_at: "2026-08-18T08:00:00.000Z",
    updated_at: "2026-08-18T09:00:00.000Z",
    ...overrides,
  };
}

const PAGE_ONE = [
  listIncident(
    IDS.targetPassed,
    "Priority vendor export exposure",
    "high",
    "open",
    {
      detected_at: "2026-08-18T10:00:00.000Z",
      gdpr_72h_deadline: "2026-08-19T08:00:00.000Z",
    },
  ),
  listIncident(
    IDS.critical,
    "Critical credential access under investigation",
    "critical",
    "contained",
    { detected_at: "2026-08-18T09:00:00.000Z" },
  ),
  listIncident(
    IDS.incomplete,
    "Subscriber contact-data scope still being assessed",
    "medium",
    "notifications_pending",
    {
      detected_at: "2026-08-18T08:00:00.000Z",
      affected_regions: [],
      affected_subject_count: undefined,
      jurisdictions: [],
    },
  ),
  listIncident(IDS.closed, "Historical processor incident", "low", "closed", {
    detected_at: "2026-08-18T07:00:00.000Z",
    gdpr_72h_deadline: "2026-08-15T08:00:00.000Z",
  }),
];

const PAGE_TWO = [
  PAGE_ONE[0],
  listIncident(
    IDS.later,
    "Additional loaded incident window",
    "investigating",
    "open",
  ),
];

const DETAIL = {
  ...PAGE_ONE[0],
  signoff_by: "legacy-unverified@example.invalid",
  counsel_signoff_at: "2026-08-18T11:00:00.000Z",
  jurisdiction_resolution: {
    status: "release_held",
    release_hold_code: "jurisdiction_rules_release_hold",
    recognized: [{ code: "GDPR", name: "European Union / EEA" }],
    unknown_jurisdictions: [],
  },
};

const EVENTS = [
  {
    event_id: "00000000-0000-7000-8000-000000000381",
    source: "incident_state_transitions",
    schema_version: 1,
    kind: "transition",
    at: "2026-08-18T09:00:00.000Z",
    from_state: "open",
    to_state: "contained",
    reason: "Containment reported by the response lead",
  },
  {
    event_id: "00000000-0000-7000-8000-000000000382",
    source: "incident_notifications",
    schema_version: 1,
    kind: "notification",
    at: "2026-08-18T12:00:00.000Z",
    audience: "authority",
    recipient_ref: "supervisory portal reference pending verification",
    template_key: "privacy-route-37-draft",
  },
];

const CASES: readonly Qualification[] = [
  {
    id: "1440x1000-dark",
    theme: "dark",
    width: 1440,
    height: 1000,
    interactionEvidence: true,
  },
  { id: "1440x1000-light", theme: "light", width: 1440, height: 1000 },
  {
    id: "390x844-dark",
    theme: "dark",
    width: 390,
    height: 844,
    interactionEvidence: true,
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

function receipt(route: Route): Receipt {
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
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
}

async function installNativeSessionBroker(page: Page): Promise<void> {
  await page.addInitScript((authMe) => {
    const install = (): void => {
      const target = window as typeof window & {
        __TAURI_INTERNALS__?: {
          invoke: (
            command: string,
            args?: Record<string, unknown>,
          ) => Promise<unknown>;
          __privacyRoute37Broker?: boolean;
          [key: string]: unknown;
        };
      };
      const current = target.__TAURI_INTERNALS__;
      if (!current) {
        queueMicrotask(install);
        return;
      }
      if (current.__privacyRoute37Broker) return;
      const originalInvoke = current.invoke.bind(current);
      Object.defineProperty(target, "__TAURI_INTERNALS__", {
        configurable: true,
        writable: false,
        value: {
          ...current,
          __privacyRoute37Broker: true,
          invoke: async (
            command: string,
            args?: Record<string, unknown>,
          ): Promise<unknown> => {
            const evidenceTarget = window as typeof window & {
              __privacyRoute37NativeCommands?: string[];
            };
            evidenceTarget.__privacyRoute37NativeCommands ??= [];
            evidenceTarget.__privacyRoute37NativeCommands.push(command);
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
  }, AUTH_ME);
}

async function installStructuredSessionUser(page: Page): Promise<void> {
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
  }, AUTH_ME);
}

async function installHarness(page: Page): Promise<Harness> {
  const privacyRequests: Receipt[] = [];
  const unsafeWrites: Receipt[] = [];
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
  await page.route("**/api/v1/auth/me", (route) => json(route, AUTH_ME));
  await page.route("**/api/v1/me", (route) =>
    json(route, { user: AUTH_ME.email, tenant: AUTH_ME.workspace_name }),
  );
  await page.route("**/api/v1/privacy/incidents**", async (route) => {
    const entry = receipt(route);
    privacyRequests.push(entry);
    const unsafeHeldPath =
      /\/(?:signoff|notifications|transition)(?:\/|$)/u.test(entry.pathname) ||
      /\/packet(?:\/|$)/u.test(entry.pathname);
    if (entry.method !== "GET" || unsafeHeldPath) {
      unsafeWrites.push(entry);
      await json(route, { error: { code: "unsafe_route_37_write" } }, 501);
      return;
    }
    const eventsMatch = entry.pathname.match(
      /^\/api\/v1\/privacy\/incidents\/([^/]+)\/events$/u,
    );
    if (eventsMatch) {
      await json(route, { incident_id: IDS.targetPassed, events: EVENTS });
      return;
    }
    const detailMatch = entry.pathname.match(
      /^\/api\/v1\/privacy\/incidents\/([^/]+)$/u,
    );
    if (detailMatch) {
      await json(route, DETAIL);
      return;
    }
    if (entry.pathname === "/api/v1/privacy/incidents") {
      const cursor = new URLSearchParams(entry.search).get("cursor");
      if (cursor === PAGE_TWO_CURSOR) {
        await json(route, {
          incidents: PAGE_TWO,
          known_jurisdictions: [
            { code: "CA", name: "California" },
            { code: "GDPR", name: "European Union / EEA" },
          ],
        });
        return;
      }
      await json(route, {
        incidents: PAGE_ONE,
        known_jurisdictions: [
          { code: "CA", name: "California" },
          { code: "GDPR", name: "European Union / EEA" },
        ],
        nextCursor: PAGE_TWO_CURSOR,
      });
      return;
    }
    await json(route, { error: { code: "unknown_privacy_route" } }, 404);
  });
  return {
    privacyRequests,
    unsafeWrites,
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
  const harness = await installHarness(page);
  await page.goto("/app/privacy-incidents");
  await waitForPrimaryNavigation(page);
  const workspace = page.getByTestId("privacy-incident-workspace");
  if (!(await workspace.isVisible().catch(() => false))) {
    await page
      .getByRole("navigation", { name: "Primary" })
      .locator('button[data-section="privacyIncidents"]')
      .last()
      .click();
  }
  await expect(workspace).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByTestId("privacy-incident-trust-masthead"),
  ).toContainText("4 rows loaded");
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
    const selectors = [
      ["content", ".content"],
      ["workspace", ".privacy-incident-workspace"],
      ["register", ".privacy-incident-register"],
      ["drawer", ".privacy-incident-detail"],
    ] as const;
    return {
      document: document.documentElement.scrollWidth - window.innerWidth,
      body: document.body.scrollWidth - window.innerWidth,
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

async function capture(
  page: Page,
  qualification: Qualification,
  suffix: string,
): Promise<void> {
  await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
  await page.screenshot({
    path: path.join(
      EVIDENCE_DIRECTORY,
      `privacy-incidents-${qualification.id}-${suffix}.png`,
    ),
    fullPage: false,
    animations: "disabled",
    caret: "hide",
  });
}

async function expectHarnessClean(page: Page, harness: Harness): Promise<void> {
  expect(harness.unsafeWrites).toEqual([]);
  expect(
    harness.privacyRequests.filter(({ method }) => method !== "GET"),
  ).toEqual([]);
  expect(
    harness.privacyRequests.filter(({ pathname }) =>
      /\/(?:signoff|notifications|transition|packet)(?:\/|$)/u.test(pathname),
    ),
  ).toEqual([]);
  const nativeFileWrites = await page.evaluate(() => {
    const commands = (
      window as typeof window & {
        __privacyRoute37NativeCommands?: string[];
      }
    ).__privacyRoute37NativeCommands;
    return (commands ?? []).filter((command) =>
      /^(?:transfer_begin_save|transfer_write_chunk|transfer_finish_save)$/u.test(
        command,
      ),
    );
  });
  expect(nativeFileWrites).toEqual([]);
  expect(harness.externalRequests).toEqual([]);
  expect(harness.consoleErrors).toEqual([]);
  expect(harness.pageErrors).toEqual([]);
}

async function qualifyCreateDraft(page: Page): Promise<void> {
  const opener = page.getByRole("button", { name: "New preliminary record" });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "New preliminary incident record",
  });
  await expect(dialog).toBeVisible();
  expect(new URL(page.url()).searchParams.get("overlay")).toBe(
    "privacy-incident-create",
  );
  await page.waitForTimeout(50);
  await dialog.getByLabel("Title").focus();
  await expect(dialog.getByLabel("Title")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(dialog.getByLabel("Severity")).toBeFocused();
  await dialog.getByLabel("Severity").selectOption("high");
  await expect(dialog.getByLabel("Severity")).toHaveValue("high");
  const submit = dialog.getByRole("button", {
    name: "Create preliminary record",
    exact: true,
  });
  await submit.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByLabel("Title")).toBeFocused();
  expect(
    await dialog
      .getByLabel("Title")
      .evaluate((element: HTMLInputElement) => element.validity.valueMissing),
  ).toBe(true);
  await page.keyboard.type("Keyboard draft remains local");
  await dialog.getByLabel("GDPR: European Union / EEA").focus();
  await page.keyboard.press("Space");
  await expect(dialog.getByLabel("GDPR: European Union / EEA")).toBeChecked();
  await page.keyboard.press("Escape");
  const discard = page.getByRole("alertdialog", {
    name: "Discard privacy-incident draft?",
  });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Discard draft" }).click();
  await expect(dialog).toBeHidden();
  expect(new URL(page.url()).searchParams.get("overlay")).toBeNull();
  await expect(
    page.getByRole("alertdialog", { name: "Leave Privacy incidents?" }),
  ).toHaveCount(0);
  await expect(opener).toBeFocused();
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

async function qualifyMobileTargets(page: Page): Promise<void> {
  await expectMinimumTarget(
    page.getByRole("button", { name: "New preliminary record" }),
    "create",
  );
  await expectMinimumTarget(
    page.getByRole("button", { name: "Refresh" }),
    "refresh",
  );
  await expectMinimumTarget(
    page.getByRole("button", { name: "All, 4 loaded" }),
    "filter",
  );
  await expectMinimumTarget(
    page.getByRole("searchbox", { name: "Search loaded incidents" }),
    "search",
  );
  await expectMinimumTarget(
    page
      .getByRole("button", {
        name: /Open privacy incident Priority vendor export exposure/u,
      })
      .first(),
    "incident opener",
  );
  await expectMinimumTarget(
    page.getByRole("button", { name: "Load more" }),
    "load more",
  );
}

async function qualifyDrawer(
  page: Page,
  qualification: Qualification,
): Promise<void> {
  const opener = page
    .getByRole("button", {
      name: /Open privacy incident Priority vendor export exposure/u,
    })
    .first();
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: /Priority vendor export exposure/u,
  });
  await expect(dialog).toBeVisible();
  expect(new URL(page.url()).searchParams.get("overlay")).toBe(
    "privacy-incident-detail",
  );
  expect(new URL(page.url()).searchParams.get("overlayId")).toBe(
    IDS.targetPassed,
  );
  await expect(dialog).toContainText("2026-08-18T08:00:00.000Z");
  await expect(dialog).toContainText("Actor not recorded");
  await expect(dialog).toContainText(
    "Recipient reference withheld in this view",
  );
  await expect(dialog).not.toContainText(
    "supervisory portal reference pending verification",
  );
  for (const testId of [
    "privacy-incident-close-release-hold",
    "privacy-incident-signoff-release-hold",
    "privacy-incident-notification-release-hold",
    "privacy-incident-packets-release-hold",
  ]) {
    const hold = page.getByTestId(testId);
    await expect(hold).toBeVisible();
    await expect(
      hold.locator("button, input, select, textarea, a[href]"),
    ).toHaveCount(0);
  }
  await expect(
    dialog.getByText("Not generated · not approved · not sent").first(),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", {
      name: /close incident|sign.?off|record.*sent|download.*packet|generate.*packet/iu,
    }),
  ).toHaveCount(0);
  await expectNoTaskOverflow(page);
  expect(await axeViolations(dialog)).toEqual([]);
  await capture(page, qualification, "drawer");

  if (qualification.width > 760) {
    const originalViewport = page.viewportSize();
    await page.setViewportSize({ width: qualification.width, height: 2_400 });
    await dialog
      .getByTestId("privacy-incident-close-release-hold")
      .evaluate((element) => element.scrollIntoView({ block: "start" }));
    for (const testId of [
      "privacy-incident-close-release-hold",
      "privacy-incident-signoff-release-hold",
      "privacy-incident-notification-release-hold",
      "privacy-incident-packets-release-hold",
    ]) {
      const box = await dialog.getByTestId(testId).boundingBox();
      expect(box, `${testId} should have geometry`).not.toBeNull();
      expect(box?.y ?? -1, `${testId} top`).toBeGreaterThanOrEqual(0);
      expect(
        (box?.y ?? 2_401) + (box?.height ?? 0),
        `${testId} bottom`,
      ).toBeLessThanOrEqual(2_400);
    }
    await capture(page, qualification, "drawer-holds");
    if (originalViewport) await page.setViewportSize(originalViewport);
  } else {
    await expect(
      dialog.locator(".privacy-incident-notification-table"),
    ).toBeHidden();
    await expect(
      dialog.locator(".privacy-incident-notification-cards > li"),
    ).toHaveCount(1);
    await dialog
      .locator(".privacy-incident-notification-cards")
      .scrollIntoViewIfNeeded();
    await expectNoTaskOverflow(page);
    await capture(page, qualification, "drawer-notification-evidence");
  }

  const transition = dialog.getByRole("button", { name: "Move to Contained" });
  if (qualification.width <= 760) {
    await expectMinimumTarget(transition, "drawer transition");
    await expectMinimumTarget(
      dialog.getByRole("button", { name: "Close" }),
      "drawer close",
    );
  }
  await transition.focus();
  await page.keyboard.press("Enter");
  const confirmation = page.getByRole("alertdialog", {
    name: "Transition to Contained?",
  });
  await expect(confirmation).toBeVisible();
  await confirmation
    .getByLabel("Reason")
    .fill("Keyboard-only local reason draft");
  await page.keyboard.press("Escape");
  const discard = page.getByRole("alertdialog", {
    name: "Discard transition reason?",
  });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Discard reason" }).click();
  await expect(confirmation).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(new URL(page.url()).searchParams.get("overlay")).toBeNull();
  await expect(opener).toBeFocused();

  // The response context is URL-owned: browser history reopens it, and a
  // reload/deep-link close has a deterministic route-owned focus fallback
  // even though no originating row element survives the reload.
  await opener.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.history.back());
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await page.evaluate(() => window.history.forward());
  await expect(dialog).toBeVisible();
  await page.reload({ waitUntil: "domcontentloaded" });
  const reloadedDialog = page.getByRole("dialog", {
    name: /Priority vendor export exposure/u,
  });
  await expect(reloadedDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(reloadedDialog).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Incident register" }),
  ).toBeFocused();
}

test.describe.configure({ timeout: 120_000 });

test("route-owned CSS includes explicit reduced-motion and forced-colors containment", () => {
  expect(ROUTE_CSS).toContain("@media (prefers-reduced-motion: reduce)");
  expect(ROUTE_CSS).toContain("@media (forced-colors: active)");
  expect(ROUTE_CSS).toContain(".privacy-incident-notification-cards");
  expect(ROUTE_CSS).toContain("@media (max-width: 760px)");
});

for (const qualification of CASES) {
  test(`${qualification.id} qualifies the Route 37 command center`, async ({
    page,
    bootApp,
    setTheme,
  }) => {
    const harness = await openRoute(page, bootApp, setTheme, qualification);
    const workspace = page.getByTestId("privacy-incident-workspace");
    await expect(
      page.getByRole("heading", { name: "Privacy incidents" }),
    ).toBeVisible();
    await expect(
      page.getByTestId("privacy-incident-trust-masthead"),
    ).toContainText("more rows exist beyond this window");
    await expect(page.getByText("Scope fields complete")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Closed, 1 loaded" }),
    ).toBeVisible();

    const narrow = qualification.width <= 760;
    if (narrow) {
      await expect(page.locator(".privacy-incident-mobile-card")).toHaveCount(
        4,
      );
      await expect(
        page.locator(".privacy-incident-register-table"),
      ).toBeHidden();
      await qualifyMobileTargets(page);
    } else {
      await expect(
        page.locator('table[aria-label="Privacy incidents"] tbody tr'),
      ).toHaveCount(4);
    }
    await expectNoTaskOverflow(page);
    expect(await axeViolations(workspace)).toEqual([]);
    await capture(page, qualification, "register");

    await page.getByRole("button", { name: "Closed, 1 loaded" }).click();
    expect(new URL(page.url()).searchParams.get("f.state")).toBe("closed");
    await expect(
      page.locator(".privacy-incident-register-count"),
    ).toContainText("1of 4 loaded");
    await page.getByRole("button", { name: "All, 4 loaded" }).click();
    expect(new URL(page.url()).searchParams.get("f.state")).toBeNull();
    const search = page.getByRole("searchbox", {
      name: "Search loaded incidents",
    });
    await search.fill("Priority");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("q"))
      .toBe("Priority");
    await search.fill("");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("q"))
      .toBeNull();

    if (qualification.interactionEvidence) {
      await page.getByRole("button", { name: "Load more" }).click();
      await expect(
        page.getByTestId("privacy-incident-trust-masthead"),
      ).toContainText("5 rows loaded");
      await expect(
        page.getByText("End of loaded incident register"),
      ).toBeVisible();
      expect(
        harness.privacyRequests.filter(({ search }) =>
          new URLSearchParams(search).has("cursor"),
        ),
      ).toHaveLength(1);
      await qualifyCreateDraft(page);
      await qualifyDrawer(page, qualification);
    }

    if (qualification.textSpacing) {
      await page.emulateMedia({ reducedMotion: "reduce" });
      const spacingStyle = await page.addStyleTag({
        content:
          "*:not(svg):not(path) { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }",
      });
      await expectNoTaskOverflow(page);
      const animationDuration = await page
        .locator(".privacy-incident-trust-icon")
        .evaluate((element) => getComputedStyle(element).animationDuration);
      expect(Number.parseFloat(animationDuration)).toBeLessThanOrEqual(0.00001);
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
