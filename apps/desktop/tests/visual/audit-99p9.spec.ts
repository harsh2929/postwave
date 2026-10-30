import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ConsoleMessage, Page, Route } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const FIXED_NOW = "2026-08-13T09:30:00.000Z";
const EXPECTED_QUERY = "?since=2026-07-14T00%3A00%3A00.000Z";
const PAGE_TWO_CURSOR = "audit-route-36-page-2";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIRECTORY = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "audit-screenshots",
  "2026-08-13",
  "route-36",
);

type Theme = "dark" | "light";
type BootApp = (page: Page) => Promise<void>;
type SetTheme = (
  page: Page,
  theme: "system" | "dark" | "light",
) => Promise<void>;

interface AuditWireRow {
  id: number;
  action: string;
  resourceType?: string;
  resourceId?: string;
  actorType: string;
  actorLabel?: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown> | null;
  at: string;
  redactedFields?: string[];
  hasEncryptedMetadata?: boolean;
  legalHold?: boolean;
  retentionOverrideDays?: number | null;
}

interface RequestReceipt {
  method: string;
  pathname: string;
  search: string;
}

interface AuditHarness {
  requests: RequestReceipt[];
  unsafeAuditRequests: RequestReceipt[];
  externalRequests: string[];
  consoleErrors: string[];
  pageErrors: string[];
}

interface QualificationCase {
  id: string;
  theme: Theme;
  width: number;
  height: number;
  qualifyKeyboardDrawer?: boolean;
}

const AUTH_ME = {
  user_id: "audit-route-36-reviewer",
  tenant_id: "audit-route-36-tenant",
  email: "reviewer@audit-qualification.example.invalid",
  role: "viewer",
  effective_role: "viewer",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Audit qualification",
  workspace_slug: "audit-qualification",
};

const PAGE_ONE_ROWS: readonly AuditWireRow[] = [
  {
    id: 9108,
    action: "campaign.schedule_updated",
    resourceType: "campaign",
    resourceId: "campaign-autumn-release-2026",
    actorType: "human",
    actorLabel: "Mira Chen",
    userId: "user-mira-chen",
    ip: "203.0.113.42",
    userAgent: "Moosewave Desktop/0.1.0 (macOS 15.5)",
    metadata: {
      before: { scheduled_at: "2026-08-13T14:00:00.000Z" },
      after: { scheduled_at: "2026-08-13T15:30:00.000Z" },
      change_source: "release-review",
    },
    at: "2026-08-13T09:12:00.000Z",
    redactedFields: ["metadata.recipient_email"],
    hasEncryptedMetadata: true,
  },
  {
    id: 9107,
    action: "api_key.rotated",
    resourceType: "api_key",
    resourceId: "key-lifecycle-release-automation",
    actorType: "human",
    actorLabel: "Jordan Lee",
    userId: "user-jordan-lee",
    ip: "198.51.100.17",
    metadata: {
      rotation_reason: "scheduled security review",
      previous_fingerprint: "sha256:4b9b…",
    },
    at: "2026-08-13T08:48:00.000Z",
  },
  {
    id: 9106,
    action: "sequence.version_published",
    resourceType: "sequence",
    resourceId: "sequence-trial-conversion-v4",
    actorType: "agent",
    actorLabel: "Lifecycle release bot",
    ip: "192.0.2.81",
    metadata: {
      version: 4,
      review_state: "approved",
      messages: 7,
    },
    at: "2026-08-13T07:55:00.000Z",
  },
  {
    id: 9105,
    action: "role.audit_scopes_updated",
    resourceType: "role",
    resourceId: "role-security-reviewer",
    actorType: "human",
    actorLabel: "Samira Patel",
    userId: "user-samira-patel",
    ip: "203.0.113.19",
    metadata: {
      before: { scopes: ["audit:read"] },
      after: { scopes: ["audit:read", "audit:read_pii"] },
    },
    at: "2026-08-12T16:20:00.000Z",
  },
  {
    id: 9104,
    action: "subscriber.suppression_imported",
    resourceType: "suppression_batch",
    resourceId: "suppression-batch-2026-08-12",
    actorType: "system",
    actorLabel: "Suppression reconciler",
    metadata: { accepted: 184, rejected: 3, source: "verified-upload" },
    at: "2026-08-12T12:04:00.000Z",
  },
  {
    id: 9103,
    action: "audit.read.list",
    resourceType: "audit_query",
    resourceId: "query-soc2-weekly-review",
    actorType: "agent",
    actorLabel: "Compliance evidence collector",
    ip: "198.51.100.60",
    metadata: {
      result_count: 126,
      filter_window_days: 7,
      projection: "private",
    },
    at: "2026-08-12T10:36:00.000Z",
  },
];

const PAGE_TWO_ROWS: readonly AuditWireRow[] = [
  {
    id: 9102,
    action: "automation.run_completed",
    resourceType: "automation",
    resourceId: "automation-renewal-reminder",
    actorType: "agent",
    actorLabel: "Renewal orchestration agent",
    metadata: { recipients: 842, skipped: 19, outcome: "completed" },
    at: "2026-08-11T14:22:00.000Z",
  },
  {
    id: 9101,
    action: "domain.dkim_verified",
    resourceType: "sending_domain",
    resourceId: "updates.example.invalid",
    actorType: "human",
    actorLabel: "Alex Morgan",
    userId: "user-alex-morgan",
    ip: "192.0.2.44",
    metadata: { selector: "postwave2", status: "verified" },
    at: "2026-08-11T11:08:00.000Z",
    legalHold: true,
    retentionOverrideDays: 365,
  },
];

const QUALIFICATION_CASES: readonly QualificationCase[] = [
  {
    id: "1440x1000-dark",
    theme: "dark",
    width: 1440,
    height: 1000,
    qualifyKeyboardDrawer: true,
  },
  {
    id: "1440x1000-light",
    theme: "light",
    width: 1440,
    height: 1000,
  },
  {
    id: "390x844-dark",
    theme: "dark",
    width: 390,
    height: 844,
  },
  {
    id: "390x844-light",
    theme: "light",
    width: 390,
    height: 844,
  },
];

function receipt(route: Route): RequestReceipt {
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
          __auditRoute36SessionBroker?: boolean;
          [key: string]: unknown;
        };
      };
      const current = target.__TAURI_INTERNALS__;
      if (!current) {
        queueMicrotask(install);
        return;
      }
      if (current.__auditRoute36SessionBroker) return;

      const originalInvoke = current.invoke.bind(current);
      Object.defineProperty(target, "__TAURI_INTERNALS__", {
        configurable: true,
        writable: false,
        value: {
          ...current,
          __auditRoute36SessionBroker: true,
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

async function installAuditHarness(page: Page): Promise<AuditHarness> {
  const requests: RequestReceipt[] = [];
  const unsafeAuditRequests: RequestReceipt[] = [];
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

  // The shared fixture's production-oriented `**/api/**` fallback also
  // matches Vite source module paths such as `/src/lib/api/result.ts`. Keep
  // those module requests on the source server when this spec uses the
  // documented reuse-server qualification path.
  await page.route("**/src/**", (route) => route.continue());
  await page.route("**/api/v1/auth/me", async (route) => {
    requests.push(receipt(route));
    await json(route, AUTH_ME);
  });
  await page.route("**/api/v1/me", async (route) => {
    requests.push(receipt(route));
    await json(route, {
      user: AUTH_ME.email,
      tenant: AUTH_ME.workspace_name,
    });
  });
  await page.route("**/api/v1/audit**", async (route) => {
    const entry = receipt(route);
    requests.push(entry);
    const { method, pathname, search } = entry;

    if (method === "GET" && pathname === "/api/v1/audit/my-scopes") {
      await json(route, {
        scopes: ["audit:read", "audit:read_pii"],
        auditScopes: ["audit:read", "audit:read_pii"],
        isAdmin: false,
      });
      return;
    }
    if (method === "GET" && pathname === "/api/v1/audit/saved-views") {
      await json(route, {
        views: [
          {
            id: "saved-audit-security-mutations",
            name: "Security mutations",
            description: "Authentication, key, and role evidence",
            filters: {
              actorType: "any",
              actorLabel: "",
              actionQuery: "",
              resourceType: "",
              resourceId: "",
              days: 30,
              category: "auth",
            },
            createdAt: "2026-08-10T10:00:00.000Z",
            updatedAt: "2026-08-12T10:00:00.000Z",
            createdBy: "audit-route-36-reviewer",
          },
        ],
      });
      return;
    }
    if (method === "GET" && pathname === "/api/v1/audit/stats") {
      await json(route, {
        window: "30d",
        totalEvents: 8,
        byActorType: [
          { label: "human", count: 4 },
          { label: "agent", count: 3 },
          { label: "system", count: 1 },
        ],
        topActions: [
          { label: "campaign.schedule_updated", count: 1 },
          { label: "api_key.rotated", count: 1 },
          { label: "role.audit_scopes_updated", count: 1 },
          { label: "audit.read.list", count: 1 },
        ],
        daily: [
          { date: "2026-08-11", count: 2 },
          { date: "2026-08-12", count: 3 },
          { date: "2026-08-13", count: 3 },
        ],
      });
      return;
    }
    if (method === "GET" && pathname === "/api/v1/audit/count") {
      await json(route, { totalEstimate: 8, confidence: "exact" });
      return;
    }
    if (method === "GET" && pathname === "/api/v1/audit") {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      if (cursor === null) {
        await json(route, {
          rows: PAGE_ONE_ROWS,
          nextCursor: PAGE_TWO_CURSOR,
        });
        return;
      }
      if (cursor === PAGE_TWO_CURSOR) {
        await json(route, { rows: PAGE_TWO_ROWS });
        return;
      }
    }

    unsafeAuditRequests.push(entry);
    await json(
      route,
      {
        error: {
          code: "unexpected_audit_transport",
          message: `Unexpected audit request: ${method} ${pathname}${search}`,
        },
      },
      501,
    );
  });

  return {
    requests,
    unsafeAuditRequests,
    externalRequests,
    consoleErrors,
    pageErrors,
  };
}

async function openAudit(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  qualification: QualificationCase,
): Promise<AuditHarness> {
  await setTheme(page, qualification.theme);
  await page.setViewportSize({
    width: qualification.width,
    height: qualification.height,
  });
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await bootApp(page);
  await installNativeSessionBroker(page);
  await installStructuredSessionUser(page);
  const harness = await installAuditHarness(page);

  await page.goto("/app/audit");
  try {
    await waitForPrimaryNavigation(page);
  } catch (error) {
    throw new Error(
      `The desktop shell did not become ready: ${JSON.stringify({
        url: page.url(),
        body: (await page.locator("body").innerText()).slice(0, 2_000),
        consoleErrors: harness.consoleErrors,
        pageErrors: harness.pageErrors,
      })}`,
      { cause: error },
    );
  }
  const workspace = page.getByTestId("audit-workspace");
  const directRouteReady = await workspace
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!directRouteReady) {
    const auditNavigation = page
      .getByRole("navigation", { name: "Primary" })
      .locator('button[data-section="audit"]')
      .first();
    await auditNavigation.click();
  }
  await expect(workspace).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".audit-row")).toHaveCount(PAGE_ONE_ROWS.length);
  await expect(page.locator(".pw-data-table-pagination__summary")).toHaveText(
    "Showing 6 of 8",
  );
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Saved views" }),
  ).toBeVisible();
  await expect(
    page.getByRole("option", { name: "Security mutations" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "+ Save current", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Delete", exact: true }),
  ).toHaveCount(0);
  await page.evaluate(async () => document.fonts.ready);
  return harness;
}

async function seriousOrCriticalAxeViolations(page: Page): Promise<unknown[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            root: Document,
            options: {
              runOnly: { type: "tag"; values: string[] };
            },
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
    const result = await axe.run(document, {
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
    return result.violations
      .filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical",
      )
      .map((violation) => ({
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

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const widthDelta = (element: Element | null): number =>
      element instanceof HTMLElement
        ? element.scrollWidth - element.clientWidth
        : 0;
    const workspace = document.querySelector<HTMLElement>(".audit-workspace");
    const workspaceRight = workspace?.getBoundingClientRect().right ?? 0;
    return {
      deltas: {
        document: document.documentElement.scrollWidth - window.innerWidth,
        body: document.body.scrollWidth - window.innerWidth,
        content: widthDelta(document.querySelector(".content")),
        workspace: widthDelta(workspace),
        list: widthDelta(document.querySelector(".audit-list")),
      },
      offenders: workspace
        ? [...workspace.querySelectorAll<HTMLElement>("*")]
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                selector: `${element.tagName.toLowerCase()}${element.className ? `.${String(element.className).trim().replaceAll(/\s+/gu, ".")}` : ""}`,
                text: (element.textContent ?? "").trim().slice(0, 80),
                ownDelta: element.scrollWidth - element.clientWidth,
                clientWidth: element.clientWidth,
                scrollWidth: element.scrollWidth,
                rect: {
                  left: Math.round(rect.left),
                  right: Math.round(rect.right),
                  width: Math.round(rect.width),
                },
                workspaceRight: Math.round(workspaceRight),
                rightDelta: Math.round(rect.right - workspaceRight),
              };
            })
            .filter(
              ({ ownDelta, rightDelta }) => ownDelta > 1 || rightDelta > 1,
            )
            .slice(0, 12)
        : [],
    };
  });
  for (const [surface, delta] of Object.entries(overflow.deltas)) {
    expect(
      delta,
      `${surface} horizontal overflow: ${JSON.stringify(overflow)}`,
    ).toBeLessThanOrEqual(1);
  }
}

function expectAuditRequestsExact(harness: AuditHarness): void {
  const auditRequests = harness.requests.filter(({ pathname }) =>
    pathname.startsWith("/api/v1/audit"),
  );
  expect(
    auditRequests.filter(({ method }) => method !== "GET"),
    "read-only viewer must not issue audit mutation requests",
  ).toEqual([]);
  for (const pathname of [
    "/api/v1/audit/my-scopes",
    "/api/v1/audit",
    "/api/v1/audit/stats",
    "/api/v1/audit/count",
    "/api/v1/audit/saved-views",
  ]) {
    expect(
      auditRequests.some((request) => request.pathname === pathname),
      `${pathname} was requested`,
    ).toBe(true);
  }
  for (const pathname of [
    "/api/v1/audit",
    "/api/v1/audit/stats",
    "/api/v1/audit/count",
  ]) {
    const initialReads = auditRequests.filter(
      (request) =>
        request.pathname === pathname &&
        !new URLSearchParams(request.search).has("cursor"),
    );
    expect(
      initialReads.length,
      `${pathname} initial read count`,
    ).toBeGreaterThan(0);
    expect(
      initialReads.every((request) => request.search === EXPECTED_QUERY),
      `${pathname} canonical query`,
    ).toBe(true);
  }
  expect(harness.unsafeAuditRequests).toEqual([]);
}

function expectHarnessClean(harness: AuditHarness): void {
  expectAuditRequestsExact(harness);
  expect(harness.externalRequests).toEqual([]);
  expect(harness.consoleErrors).toEqual([]);
  expect(harness.pageErrors).toEqual([]);
}

async function scrollRootToTop(page: Page): Promise<void> {
  const positions = await page.evaluate(async () => {
    const candidates = [
      ["document", document.scrollingElement],
      ["html", document.documentElement],
      ["body", document.body],
      ["main", document.querySelector<HTMLElement>(".main")],
      ["content", document.querySelector<HTMLElement>(".content")],
    ] as const;
    const elements = [
      ...new Set(
        candidates
          .map(([, element]) => element)
          .filter((element): element is HTMLElement =>
            Boolean(element instanceof HTMLElement),
          ),
      ),
    ];
    const inlineScrollBehavior = elements.map((element) => ({
      element,
      value: element.style.getPropertyValue("scroll-behavior"),
      priority: element.style.getPropertyPriority("scroll-behavior"),
    }));
    for (const element of elements) {
      element.style.setProperty("scroll-behavior", "auto", "important");
      element.scrollTop = 0;
      element.scrollLeft = 0;
    }
    window.scrollTo(0, 0);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    for (const { element, value, priority } of inlineScrollBehavior) {
      if (value) element.style.setProperty("scroll-behavior", value, priority);
      else element.style.removeProperty("scroll-behavior");
    }
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    const scrollerPositions: Record<string, { top: number; left: number }> = {};
    for (const [name, element] of candidates) {
      if (!(element instanceof HTMLElement)) continue;
      scrollerPositions[name] = {
        top: element.scrollTop,
        left: element.scrollLeft,
      };
    }
    return {
      window: { top: window.scrollY, left: window.scrollX },
      ...scrollerPositions,
    };
  });
  for (const [scroller, position] of Object.entries(positions)) {
    expect(position, `${scroller} must be pinned before top evidence`).toEqual({
      top: 0,
      left: 0,
    });
  }
}

async function scrollEvidenceTargetIntoView(
  page: Page,
  selector: string,
): Promise<void> {
  const geometry = await page.evaluate(async (targetSelector) => {
    const target = document.querySelector<HTMLElement>(targetSelector);
    if (!target)
      throw new Error(`Evidence target not found: ${targetSelector}`);
    const elements = [
      document.documentElement,
      document.body,
      document.querySelector<HTMLElement>(".main"),
      document.querySelector<HTMLElement>(".content"),
      target,
    ].filter((element): element is HTMLElement =>
      Boolean(element instanceof HTMLElement),
    );
    const inlineScrollBehavior = elements.map((element) => ({
      element,
      value: element.style.getPropertyValue("scroll-behavior"),
      priority: element.style.getPropertyPriority("scroll-behavior"),
    }));
    for (const element of elements) {
      element.style.setProperty("scroll-behavior", "auto", "important");
    }
    target.scrollTop = 0;
    target.scrollLeft = 0;
    target.scrollIntoView({
      block: "start",
      inline: "nearest",
      behavior: "auto",
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    for (const { element, value, priority } of inlineScrollBehavior) {
      if (value) element.style.setProperty("scroll-behavior", value, priority);
      else element.style.removeProperty("scroll-behavior");
    }
    const rect = target.getBoundingClientRect();
    return {
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      width: Math.round(rect.width),
      targetScrollTop: target.scrollTop,
      targetScrollLeft: target.scrollLeft,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    };
  }, selector);
  expect(geometry.targetScrollTop).toBe(0);
  expect(geometry.targetScrollLeft).toBe(0);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.top).toBeLessThan(geometry.viewportHeight);
  expect(geometry.bottom).toBeGreaterThan(0);
  expect(geometry.width).toBeLessThanOrEqual(geometry.viewportWidth);
}

async function captureEvidence(
  page: Page,
  qualification: QualificationCase,
): Promise<void> {
  await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
  await scrollRootToTop(page);
  await page.screenshot({
    path: path.join(EVIDENCE_DIRECTORY, `audit-${qualification.id}-top.png`),
    fullPage: false,
    animations: "disabled",
    caret: "hide",
  });

  const events = page.locator(".audit-list");
  await scrollEvidenceTargetIntoView(page, ".audit-list");
  await expect(events).toBeVisible();
  await expect(events.locator(".audit-row").first()).toBeVisible();
  await page.screenshot({
    path: path.join(EVIDENCE_DIRECTORY, `audit-${qualification.id}-events.png`),
    fullPage: false,
    animations: "disabled",
    caret: "hide",
  });

  const releaseHolds = page.getByTestId("audit-release-holds");
  await scrollEvidenceTargetIntoView(
    page,
    '[data-testid="audit-release-holds"]',
  );
  await expect(releaseHolds).toBeVisible();
  await page.screenshot({
    path: path.join(
      EVIDENCE_DIRECTORY,
      `audit-${qualification.id}-release-holds.png`,
    ),
    fullPage: false,
    animations: "disabled",
    caret: "hide",
  });
}

async function qualifyKeyboardDrawer(
  page: Page,
  harness: AuditHarness,
): Promise<void> {
  const opener = page.getByRole("button", {
    name: /Open audit event campaign\.schedule_updated\./u,
  });
  await opener.focus();
  await expect(opener).toBeFocused();
  await page.keyboard.press("Enter");

  const dialog = page.getByRole("dialog", {
    name: "campaign.schedule_updated",
  });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("audit-event-release-boundary")).toContainText(
    "Read-only evidence view",
  );
  await expect(dialog).toContainText("Evidence identifier");
  await expect(dialog).toContainText("9108");
  await expect(
    dialog.getByRole("button", {
      name: /investigate|why high risk|reveal pii|generate proof|session replay|retention|aivs/iu,
    }),
  ).toHaveCount(0);
  await expect(dialog.getByText(/release hold/iu)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  expect(harness.unsafeAuditRequests).toEqual([]);
  await mkdir(EVIDENCE_DIRECTORY, { recursive: true });
  await page.screenshot({
    path: path.join(EVIDENCE_DIRECTORY, "audit-1440x1000-dark-drawer.png"),
    fullPage: false,
    animations: "disabled",
    caret: "hide",
  });

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
}

test.describe.configure({ timeout: 120_000 });

for (const qualification of QUALIFICATION_CASES) {
  test(`${qualification.id} keeps the Audit Log populated, exact, contained, responsive, and Axe clean`, async ({
    page,
    bootApp,
    setTheme,
  }) => {
    const harness = await openAudit(page, bootApp, setTheme, qualification);

    await expect(
      page.getByRole("heading", { name: "Audit log", exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("audit-visibility-banner")).toContainText(
      "Scope check passed",
    );
    await expect(page.getByTestId("audit-pii-route-boundary")).toHaveCount(0);
    await expect(page.getByTestId("audit-hard-error")).toHaveCount(0);
    await expect(page.locator('.pw-screen[role="alert"]')).toHaveCount(0);
    await expect(page.getByTestId("audit-pagination-header")).toHaveText(
      "Showing 1-6 of 8",
    );
    await expect(page.getByTestId("audit-release-holds")).toContainText(
      "Evidence tools held until proof exists",
    );
    await expect(page.locator(".audit-release-card")).toHaveCount(3);
    await expect(page.getByText("Release hold", { exact: true })).toHaveCount(
      3,
    );
    await expect(
      page.getByRole("button", {
        name: /export (?:csv|evidence|audit log)|schedule export|download (?:csv|manifest)|create manifest/iu,
      }),
    ).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    if (qualification.qualifyKeyboardDrawer) {
      await qualifyKeyboardDrawer(page, harness);
      await page.getByRole("button", { name: "Load more" }).click();
      await expect(page.locator(".audit-row")).toHaveCount(8);
      await expect(
        page.locator(".pw-data-table-pagination__summary"),
      ).toHaveText("Showing 8 of 8");
      await expect(page.getByText("End of log", { exact: true })).toBeVisible();
      const pageTwoReads = harness.requests.filter(({ pathname, search }) => {
        if (pathname !== "/api/v1/audit") return false;
        return new URLSearchParams(search).get("cursor") === PAGE_TWO_CURSOR;
      });
      expect(pageTwoReads).toHaveLength(1);
    }

    expect(await seriousOrCriticalAxeViolations(page)).toEqual([]);
    await expectNoHorizontalOverflow(page);
    await captureEvidence(page, qualification);
    expectHarnessClean(harness);
  });
}
