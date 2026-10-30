import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

import type {
  ConsoleMessage,
  Locator,
  Page,
  Route,
  TestInfo,
} from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const FIXED_NOW = "2026-08-11T09:30:00.000Z";
const SECRET_CANARY = "ROUTE35_RAW_PROVIDER_SECRET_CANARY_7f91";
const PRIMARY_APPROVAL_ID = "approval-pending-campaign";
const SECONDARY_APPROVAL_ID = "approval-pending-sequence";

type Role = "admin" | "viewer";
type Theme = "dark" | "light";
type BootApp = (page: Page) => Promise<void>;
type SetTheme = (
  page: Page,
  theme: "system" | "dark" | "light",
) => Promise<void>;

interface ApprovalWireRow {
  id: string;
  resourceType: string;
  resourceId: string;
  requestedByActorType?: string;
  requestedByActorLabel?: string;
  requestedByApiKeyId?: string;
  status: string;
  requestedAt: string;
  decidedAt?: string;
  decidedByUserId?: string;
  notes?: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

interface RequestReceipt {
  method: string;
  pathname: string;
  search: string;
  body: unknown;
}

interface ApprovalHarness {
  role: Role;
  requests: RequestReceipt[];
  decisionWrites: RequestReceipt[];
  privilegedRequestsFromViewer: RequestReceipt[];
  unsafeRequests: RequestReceipt[];
  externalRequests: string[];
  consoleErrors: string[];
  pageErrors: string[];
}

const PENDING_ROWS: readonly ApprovalWireRow[] = [
  {
    id: PRIMARY_APPROVAL_ID,
    resourceType: "campaign",
    resourceId: "campaign-autumn-release",
    requestedByActorType: "user",
    requestedByActorLabel: "Mira Chen",
    status: "pending",
    requestedAt: "2026-08-11T08:42:00.000Z",
    expiresAt: "2026-08-12T08:42:00.000Z",
    notes: "Confirm the audience exclusion and final delivery window.",
    metadata: {
      provider_token: SECRET_CANARY,
      raw_response: { authorization: SECRET_CANARY },
    },
  },
  {
    id: SECONDARY_APPROVAL_ID,
    resourceType: "sequence",
    resourceId: "sequence-onboarding-pro",
    requestedByActorType: "api_key",
    requestedByActorLabel: "Lifecycle release bot",
    requestedByApiKeyId: "key-release-automation-2026",
    status: "pending",
    requestedAt: "2026-08-11T07:35:00.000Z",
    expiresAt: "2026-08-12T07:35:00.000Z",
    notes: "Validate wait timing after the trial-conversion branch.",
    metadata: { private_trace: SECRET_CANARY },
  },
];

const RESOLVED_ROWS: readonly ApprovalWireRow[] = [
  {
    id: "approval-approved-automation",
    resourceType: "automation_send",
    resourceId: "automation-renewal-reminder",
    requestedByActorType: "user",
    requestedByActorLabel: "Jordan Lee",
    status: "approved",
    requestedAt: "2026-08-10T08:10:00.000Z",
    decidedAt: "2026-08-10T09:04:00.000Z",
    decidedByUserId: "reviewer-admin-1",
    notes: "Suppression evidence and schedule reviewed.",
  },
  {
    id: "approval-rejected-sequence",
    resourceType: "sequence",
    resourceId: "sequence-winback-dormant",
    requestedByActorType: "user",
    requestedByActorLabel: "Samira Patel",
    status: "rejected",
    requestedAt: "2026-08-09T10:20:00.000Z",
    decidedAt: "2026-08-09T11:12:00.000Z",
    decidedByUserId: "reviewer-admin-2",
    notes: "The exclusion cohort was not attached to the request.",
  },
  {
    id: "approval-expired-campaign",
    resourceType: "campaign",
    resourceId: "campaign-summer-last-call",
    requestedByActorType: "user",
    requestedByActorLabel: "Alex Morgan",
    status: "expired",
    requestedAt: "2026-08-07T12:00:00.000Z",
    expiresAt: "2026-08-08T12:00:00.000Z",
    notes: "No decision was recorded inside the review window.",
  },
];

function copyRow(row: ApprovalWireRow): ApprovalWireRow {
  return {
    ...row,
    ...(row.metadata ? { metadata: { ...row.metadata } } : {}),
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

function requestBody(route: Route): unknown {
  const raw = route.request().postData();
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return "[invalid-json-body]";
  }
}

function receipt(route: Route): RequestReceipt {
  const request = route.request();
  const url = new URL(request.url());
  return {
    method: request.method(),
    pathname: url.pathname,
    search: url.search,
    body: requestBody(route),
  };
}

async function installApprovalHarness(
  page: Page,
  role: Role,
): Promise<ApprovalHarness> {
  let pendingRows = PENDING_ROWS.map(copyRow);
  let allRows = [...pendingRows, ...RESOLVED_ROWS.map(copyRow)];
  const requests: RequestReceipt[] = [];
  const decisionWrites: RequestReceipt[] = [];
  const privilegedRequestsFromViewer: RequestReceipt[] = [];
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
      !["localhost", "127.0.0.1", "api.moosewave.com"].includes(url.hostname)
    ) {
      externalRequests.push(request.url());
    }
  });

  await page.route("**/api/v1/auth/me", async (route) => {
    await json(route, {
      user_id: `approvals-${role}`,
      tenant_id: "approvals-qualification-tenant",
      email: `${role}@approvals.example.invalid`,
      role,
      effective_role: role,
      auth_provider: "password",
      email_verified: true,
      workspace_name: "Approvals qualification",
      workspace_slug: "approvals-qualification",
    });
  });

  await page.route(
    "**/api/v1/agent-routines/runs/by-approval/**",
    async (route) => {
      const entry = receipt(route);
      requests.push(entry);
      if (role === "viewer") privilegedRequestsFromViewer.push(entry);
      await json(
        route,
        {
          error: {
            code: "agent_run_not_found",
            message: `No run was found. Internal provider trace: ${SECRET_CANARY}`,
          },
        },
        role === "viewer" ? 403 : 404,
      );
    },
  );

  await page.route("**/api/v1/approvals**", async (route) => {
    const entry = receipt(route);
    requests.push(entry);
    if (role === "viewer") {
      privilegedRequestsFromViewer.push(entry);
      await json(
        route,
        { error: { code: "forbidden", message: "Admin role required" } },
        403,
      );
      return;
    }

    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const decisionMatch = url.pathname.match(
      /^\/api\/v1\/approvals\/([^/]+)\/decision$/u,
    );
    if (decisionMatch && method === "POST") {
      decisionWrites.push(entry);
      const id = decodeURIComponent(decisionMatch[1]!);
      const body = entry.body as {
        decision?: unknown;
        notes?: unknown;
        reason?: unknown;
      } | null;
      const row = pendingRows.find((candidate) => candidate.id === id);
      if (
        !row ||
        body?.decision !== "reject" ||
        typeof body.notes !== "string" ||
        body.notes !== body.reason
      ) {
        unsafeRequests.push(entry);
        await json(
          route,
          { error: { code: "invalid_decision", message: "Invalid decision" } },
          422,
        );
        return;
      }
      const rejected: ApprovalWireRow = {
        ...row,
        status: "rejected",
        notes: body.notes,
        decidedAt: FIXED_NOW,
        decidedByUserId: "approvals-admin-reviewer",
      };
      pendingRows = pendingRows.filter((candidate) => candidate.id !== id);
      allRows = allRows.map((candidate) =>
        candidate.id === id ? rejected : candidate,
      );
      await json(route, rejected);
      return;
    }

    if (url.pathname === "/api/v1/approvals" && method === "GET") {
      const pendingOnly = url.searchParams.get("status") === "pending";
      await json(route, {
        approvals: (pendingOnly ? pendingRows : allRows).map(copyRow),
      });
      return;
    }

    const detailMatch = url.pathname.match(/^\/api\/v1\/approvals\/([^/]+)$/u);
    if (detailMatch && method === "GET") {
      const id = decodeURIComponent(detailMatch[1]!);
      const row = allRows.find((candidate) => candidate.id === id);
      if (!row) {
        await json(
          route,
          {
            error: {
              code: "approval_not_found",
              message: `Approval unavailable. Provider trace: ${SECRET_CANARY}`,
            },
          },
          404,
        );
        return;
      }
      await json(route, {
        ...copyRow(row),
        metadata: {
          provider_token: SECRET_CANARY,
          provider_payload: { authorization: SECRET_CANARY },
        },
      });
      return;
    }

    unsafeRequests.push(entry);
    await json(
      route,
      {
        error: {
          code: "unexpected_approval_transport",
          message: "Unexpected approval transport",
        },
      },
      501,
    );
  });

  return {
    role,
    requests,
    decisionWrites,
    privilegedRequestsFromViewer,
    unsafeRequests,
    externalRequests,
    consoleErrors,
    pageErrors,
  };
}

async function installRoleSessionBroker(page: Page, role: Role): Promise<void> {
  await page.addInitScript((currentRole) => {
    const install = (): void => {
      const target = window as typeof window & {
        __TAURI_INTERNALS__?: {
          invoke: (
            command: string,
            args?: Record<string, unknown>,
          ) => Promise<unknown>;
          __approvalsRoleBroker?: boolean;
          [key: string]: unknown;
        };
      };
      const current = target.__TAURI_INTERNALS__;
      if (!current) {
        queueMicrotask(install);
        return;
      }
      if (current.__approvalsRoleBroker) return;

      const originalInvoke = current.invoke.bind(current);
      Object.defineProperty(target, "__TAURI_INTERNALS__", {
        configurable: true,
        writable: false,
        value: {
          ...current,
          __approvalsRoleBroker: true,
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
              const pathname = new URL(
                request?.url ?? window.location.href,
                window.location.href,
              ).pathname;
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
                        user_id: `approvals-${currentRole}`,
                        tenant_id: "approvals-qualification-tenant",
                        email: `${currentRole}@approvals.example.invalid`,
                        role: currentRole,
                        effective_role: currentRole,
                        auth_provider: "password",
                        email_verified: true,
                        workspace_name: "Approvals qualification",
                        workspace_slug: "approvals-qualification",
                      }),
                      {
                        status: 200,
                        headers: { "content-type": "application/json" },
                      },
                    )
                  : await fetch(request?.url ?? window.location.href, {
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
  }, role);
}

async function openApprovals(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  options: {
    role?: Role;
    theme?: Theme;
    width?: number;
    height?: number;
    path?: string;
  } = {},
): Promise<ApprovalHarness> {
  const role = options.role ?? "admin";
  await setTheme(page, options.theme ?? "dark");
  await page.setViewportSize({
    width: options.width ?? 1440,
    height: options.height ?? 1000,
  });
  await page.clock.setFixedTime(new Date(FIXED_NOW));
  await bootApp(page);
  await installRoleSessionBroker(page, role);
  await page.addInitScript(
    ({ currentRole }) => {
      window.sessionStorage.setItem(
        "postwave_session_user",
        JSON.stringify({
          user_id: `approvals-${currentRole}`,
          tenant_id: "approvals-qualification-tenant",
          role: currentRole,
          effective_role: currentRole,
          auth_provider: "password",
        }),
      );
    },
    { currentRole: role },
  );
  const harness = await installApprovalHarness(page, role);
  await page.goto(options.path ?? "/app/approvals");
  await waitForPrimaryNavigation(page);
  if (role === "admin") {
    await expect(
      page.getByRole("heading", { name: "Approvals", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".approvals-page")).toHaveAttribute(
      "data-active-tab",
      /pending|history|governance/u,
    );
  } else {
    await expect(
      page.getByRole("heading", {
        name: "Access required",
        exact: true,
      }),
    ).toBeVisible();
  }
  return harness;
}

function approvalTab(
  page: Page,
  label: "Pending" | "History" | "Governance",
): Locator {
  return page
    .getByRole("tablist", { name: "Approval workspaces" })
    .getByRole("tab")
    .filter({
      has: page
        .locator("strong")
        .filter({ hasText: new RegExp(`^${label}$`, "u") }),
    });
}

function approvalRow(page: Page, id: string): Locator {
  return page.locator(`tr[data-approval-id="${id}"]`).filter({ visible: true });
}

async function activateTab(
  page: Page,
  label: "Pending" | "History" | "Governance",
): Promise<void> {
  const tab = approvalTab(page, label);
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

async function axeViolations(
  page: Page,
  options: { root?: string; disableColorContrast?: boolean } = {},
): Promise<unknown[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async ({ root, disableColorContrast }) => {
    const axe = (
      window as unknown as {
        axe: {
          run: (
            root: Document | Element,
            options: {
              runOnly: { type: "tag"; values: string[] };
              rules?: Record<string, { enabled: boolean }>;
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
    const owner = root ? document.querySelector(root) : document;
    if (!owner) throw new Error(`Axe root was not found: ${root}`);
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
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        failure: node.failureSummary,
      })),
    }));
  }, options);
}

async function expectNoDocumentOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const route = document.querySelector<HTMLElement>(".approvals-page");
    return {
      document: document.documentElement.scrollWidth - window.innerWidth,
      body: document.body.scrollWidth - window.innerWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
      route: route ? route.scrollWidth - route.clientWidth : 0,
    };
  });
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.content).toBeLessThanOrEqual(1);
  expect(overflow.route).toBeLessThanOrEqual(1);
}

async function expectNoSecretReflection(page: Page): Promise<void> {
  const reflection = await page.evaluate((secret) => {
    const storage = [
      ...Object.values(window.localStorage),
      ...Object.values(window.sessionStorage),
    ];
    return {
      html: document.documentElement.outerHTML.includes(secret),
      storage: storage.some((value) => value.includes(secret)),
    };
  }, SECRET_CANARY);
  expect(reflection).toEqual({ html: false, storage: false });
}

function expectHarnessClean(harness: ApprovalHarness): void {
  expect(harness.unsafeRequests).toEqual([]);
  expect(harness.externalRequests).toEqual([]);
  expect(harness.pageErrors).toEqual([]);
  expect(
    harness.consoleErrors.filter(
      (message) =>
        !message.includes("404 (Not Found)") &&
        !message.includes("status of 404"),
    ),
  ).toEqual([]);
  if (harness.role === "viewer") {
    expect(harness.privilegedRequestsFromViewer).toEqual([]);
  }
}

async function saveEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await page.evaluate(async () => {
    const main = document.querySelector<HTMLElement>(".main");
    const content = document.querySelector<HTMLElement>(".content");
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    main?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    content?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
  });
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({
    path,
    fullPage: false,
    animations: "disabled",
    caret: "hide",
  });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function attachReceipt(
  testInfo: TestInfo,
  name: string,
  harness: ApprovalHarness,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const body = Buffer.from(
    `${JSON.stringify(
      {
        role: harness.role,
        requests: harness.requests,
        decisionWrites: harness.decisionWrites,
        privilegedRequestsFromViewer: harness.privilegedRequestsFromViewer,
        unsafeRequests: harness.unsafeRequests,
        externalRequests: harness.externalRequests,
        consoleErrors: harness.consoleErrors,
        pageErrors: harness.pageErrors,
        ...extra,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const path = testInfo.outputPath(`${name}.json`);
  writeFileSync(path, body);
  await testInfo.attach(name, { path, contentType: "application/json" });
}

function maxDurationMs(value: string): number {
  return Math.max(
    0,
    ...value.split(",").map((duration) => {
      const normalized = duration.trim();
      const amount = Number.parseFloat(normalized) || 0;
      return normalized.endsWith("ms") ? amount : amount * 1_000;
    }),
  );
}

test.describe.configure({ timeout: 120_000 });

test("pending, history, and governance remain populated, truthful, fail-closed, and all-impact Axe clean", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openApprovals(page, bootApp, setTheme, {
    theme: "dark",
  });

  const pendingTable = page.getByRole("table", {
    name: "Pending approval records",
  });
  await expect(pendingTable).toBeVisible();
  await expect(pendingTable.locator("tbody tr")).toHaveCount(2);
  await expect(
    page
      .getByText("Approval execution is release-held")
      .filter({ visible: true })
      .first(),
  ).toBeVisible();
  await expect(
    pendingTable.getByText("Exact review required", { exact: true }),
  ).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Approve", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Approve request", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Workspace guarantees")).toContainText(
    "Raw metadata withheld",
  );
  expect(await axeViolations(page)).toEqual([]);
  await expectNoSecretReflection(page);
  await saveEvidence(page, testInfo, "approvals-pending-populated-dark");

  await activateTab(page, "History");
  const historyTable = page.getByRole("table", {
    name: "Resolved approval records",
  });
  await expect(historyTable).toBeVisible();
  await expect(historyTable.locator("tbody tr")).toHaveCount(3);
  await expect(historyTable).toContainText("Approved");
  await expect(historyTable).toContainText("Rejected");
  await expect(historyTable).toContainText("Expired");
  await expect(
    page
      .getByText(/Showing 3 of 3 loaded resolved records\./u)
      .filter({ visible: true }),
  ).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await saveEvidence(page, testInfo, "approvals-history-populated-dark");

  const unsafeBeforeGovernance = harness.unsafeRequests.length;
  const writesBeforeGovernance = harness.decisionWrites.length;
  await activateTab(page, "Governance");
  await expect(
    page
      .getByText("Release hold: governance execution is not exposed")
      .filter({ visible: true }),
  ).toBeVisible();
  await expect(page.locator(".approval-governance-card")).toHaveCount(3);
  await expect(page.getByText("Held fail-closed", { exact: true })).toHaveCount(
    3,
  );
  await expect(
    page.getByRole("button", { name: /chain|delegate|signed/iu }),
  ).toHaveCount(0);
  expect(harness.unsafeRequests).toHaveLength(unsafeBeforeGovernance);
  expect(harness.decisionWrites).toHaveLength(writesBeforeGovernance);
  expect(await axeViolations(page)).toEqual([]);
  await expectNoDocumentOverflow(page);
  await expectNoSecretReflection(page);
  await saveEvidence(page, testInfo, "approvals-governance-held-dark");

  const listReads = harness.requests.filter(
    ({ method, pathname }) =>
      method === "GET" && pathname === "/api/v1/approvals",
  );
  expect(
    listReads.some(({ search }) => {
      const params = new URLSearchParams(search);
      return (
        params.get("status") === "pending" && params.get("limit") === "200"
      );
    }),
  ).toBe(true);
  expect(
    listReads.some(({ search }) => {
      const params = new URLSearchParams(search);
      return !params.has("status") && params.get("limit") === "200";
    }),
  ).toBe(true);
  expectHarnessClean(harness);
  await attachReceipt(testInfo, "approvals-workspace-receipt", harness);
});

test("exact detail routing owns GETs, opener focus, history traversal, close, revisit, and teardown", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openApprovals(page, bootApp, setTheme);
  const row = approvalRow(page, PRIMARY_APPROVAL_ID);
  const opener = row.getByRole("button", {
    name: "Details for Campaign campaign-autumn-release",
    exact: true,
  });
  const bodyOverflowBefore = await page
    .locator("body")
    .evaluate((element) => element.style.overflow);
  await opener.focus();
  await opener.click();

  const detail = page.getByRole("dialog", { name: "Campaign approval" });
  await expect(detail).toBeVisible();
  await expect(detail.locator(".approval-detail-truth")).toBeFocused();
  await expect(detail).toContainText("Exact record verified");
  await expect(detail).toContainText("Approval record boundary");
  await expect(detail).toContainText("no agent-run lookup was made");
  await expect
    .poll(() =>
      page.locator("body").evaluate((element) => element.style.overflow),
    )
    .toBe("hidden");
  const detailUrl = page.url();
  expect(new URL(detailUrl).searchParams.get("overlay")).toBe(
    "approval-detail",
  );
  expect(new URL(detailUrl).searchParams.get("overlayId")).toBe(
    PRIMARY_APPROVAL_ID,
  );
  await expect
    .poll(
      () =>
        harness.requests.filter(
          ({ method, pathname }) =>
            method === "GET" &&
            pathname === `/api/v1/approvals/${PRIMARY_APPROVAL_ID}`,
        ).length,
    )
    .toBeGreaterThanOrEqual(1);
  expect(
    harness.requests.filter(({ pathname }) =>
      pathname.includes("/agent-routines/runs/by-approval/"),
    ),
  ).toHaveLength(0);
  expect(await axeViolations(page, { root: ".approval-detail-shell" })).toEqual(
    [],
  );
  await expectNoSecretReflection(page);
  await saveEvidence(page, testInfo, "approvals-exact-detail-dark");

  await detail
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await expect(detail).toBeHidden();
  await expect(page).toHaveURL(/\/app\/approvals$/u);
  await expect(opener).toBeFocused();
  await expect
    .poll(() =>
      page.locator("body").evaluate((element) => element.style.overflow),
    )
    .toBe(bodyOverflowBefore);

  await opener.click();
  await expect(detail).toBeVisible();
  await page.goBack();
  await expect(detail).toBeHidden();
  await expect(page).toHaveURL(/\/app\/approvals$/u);
  await page.goForward();
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Exact record verified");
  await page.goBack();
  await expect(detail).toBeHidden();

  await page.goto(detailUrl);
  await expect(detail).toBeVisible();
  await expect(detail.locator(".approval-detail-truth")).toBeFocused();
  await detail
    .getByRole("button", { name: "Close details", exact: true })
    .click();
  await expect(detail).toBeHidden();
  await expect(page).toHaveURL(/\/app\/approvals$/u);

  const teardown = await page.evaluate(() => ({
    bodyOverflow: document.body.style.overflow,
    dialogCount: document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"]',
    ).length,
    inertCount: document.querySelectorAll("[inert]").length,
  }));
  expect(teardown).toEqual({ bodyOverflow: "", dialogCount: 0, inertCount: 0 });
  await expectNoSecretReflection(page);
  expectHarnessClean(harness);
  await attachReceipt(
    testInfo,
    "approvals-detail-navigation-receipt",
    harness,
    {
      detailUrl,
      teardown,
    },
  );
});

test("rejection cancel, validation, one write, and bounded-window reconciliation stay exact", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openApprovals(page, bootApp, setTheme, {
    theme: "light",
  });
  const row = approvalRow(page, PRIMARY_APPROVAL_ID);
  const detailOpener = row.getByRole("button", {
    name: "Details for Campaign campaign-autumn-release",
    exact: true,
  });
  await detailOpener.click();
  const detail = page.getByRole("dialog", { name: "Campaign approval" });
  await expect(detail).toContainText("Exact record verified");
  const reject = detail.getByRole("button", {
    name: "Reject request",
    exact: true,
  });
  await reject.focus();
  await reject.click();

  const modal = page.getByRole("alertdialog", { name: "Record a rejection" });
  const reason = modal.getByRole("textbox", { name: "Reason" });
  await expect(modal).toBeVisible();
  await expect(reason).toBeFocused();
  await modal.getByRole("button", { name: "Record rejection" }).click();
  await expect(
    modal.getByText("Add a reason so the requester can correct the gate."),
  ).toBeVisible();
  await expect(reason).toHaveAttribute("aria-invalid", "true");
  expect(harness.decisionWrites).toHaveLength(0);
  expect(await axeViolations(page, { root: ".modal-card" })).toEqual([]);

  await modal.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(reject).toBeFocused();

  await reject.click();
  const rejectionReason =
    "Audience evidence is incomplete; attach the exclusion cohort and request review again.";
  await reason.fill(rejectionReason);
  await saveEvidence(page, testInfo, "approvals-rejection-review-light");
  await modal.getByRole("button", { name: "Record rejection" }).click();
  await expect(modal).toBeHidden();
  await expect(
    page.getByText(
      "Rejection decision recorded. Downstream notification status is not yet verified.",
    ),
  ).toBeVisible();
  await expect(approvalRow(page, PRIMARY_APPROVAL_ID)).toHaveCount(0);

  expect(harness.decisionWrites).toHaveLength(1);
  expect(harness.decisionWrites[0]).toMatchObject({
    method: "POST",
    pathname: `/api/v1/approvals/${PRIMARY_APPROVAL_ID}/decision`,
    body: {
      decision: "reject",
      notes: rejectionReason,
      reason: rejectionReason,
    },
  });

  await activateTab(page, "History");
  const reconciled = approvalRow(page, PRIMARY_APPROVAL_ID);
  await expect(reconciled).toBeVisible();
  await expect(reconciled).toContainText("Rejected");
  await expect(reconciled).toContainText(rejectionReason);
  await expect(
    page.getByRole("button", { name: "Reject request" }),
  ).toHaveCount(0);
  await expectNoSecretReflection(page);
  expect(await axeViolations(page)).toEqual([]);
  await saveEvidence(page, testInfo, "approvals-rejection-reconciled-light");
  expectHarnessClean(harness);
  await attachReceipt(testInfo, "approvals-rejection-receipt", harness);
});

test("viewer direct-detail navigation stays fail-closed and makes zero privileged approval calls", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openApprovals(page, bootApp, setTheme, {
    role: "viewer",
    theme: "light",
    path: `/app/approvals?overlay=approval-detail&overlayId=${PRIMARY_APPROVAL_ID}`,
  });

  await expect(
    page.locator(".capability-gate").getByText(/requires the admin role/iu),
  ).toBeVisible();
  await expect(page.locator(".approvals-page")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    harness.requests.filter(({ pathname }) =>
      /(?:^\/api\/v1\/approvals|agent-routines\/runs\/by-approval)/u.test(
        pathname,
      ),
    ),
  ).toEqual([]);
  expect(harness.decisionWrites).toEqual([]);
  expect(await axeViolations(page)).toEqual([]);
  await expectNoDocumentOverflow(page);
  await expectNoSecretReflection(page);
  await saveEvidence(page, testInfo, "approvals-viewer-boundary-light");
  expectHarnessClean(harness);
  await attachReceipt(testInfo, "approvals-viewer-boundary-receipt", harness);
});

test("390px cards retain semantic headers, manual APG tabs, contained detail, and no root overflow", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  const harness = await openApprovals(page, bootApp, setTheme, {
    theme: "light",
    width: 390,
    height: 844,
  });
  const table = page.getByRole("table", { name: "Pending approval records" });
  await expect(table).toBeVisible();
  await expect(table.getByRole("columnheader")).toHaveCount(6);
  await expect(table.locator("tbody tr")).toHaveCount(2);
  const responsiveHeader = await table.locator("thead").evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      display: style.display,
      position: style.position,
      width: element.getBoundingClientRect().width,
    };
  });
  expect(responsiveHeader.display).not.toBe("none");
  expect(responsiveHeader.position).toBe("absolute");

  const pending = approvalTab(page, "Pending");
  const history = approvalTab(page, "History");
  await pending.focus();
  await page.keyboard.press("ArrowRight");
  await expect(history).toBeFocused();
  await expect(pending).toHaveAttribute("aria-selected", "true");
  await expect(history).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("Enter");
  await expect(history).toHaveAttribute("aria-selected", "true");
  await pending.click();

  const opener = approvalRow(page, PRIMARY_APPROVAL_ID).getByRole("button", {
    name: "Details for Campaign campaign-autumn-release",
  });
  await opener.click();
  const detail = page.getByRole("dialog", { name: "Campaign approval" });
  await expect(detail).toBeVisible();
  await expect
    .poll(async () => {
      const box = await detail.boundingBox();
      return box ? box.x : Number.NEGATIVE_INFINITY;
    })
    .toBeGreaterThanOrEqual(-0.5);
  await expect
    .poll(async () => {
      const box = await detail.boundingBox();
      return box ? box.x + box.width : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(390.5);
  const detailBox = await detail.boundingBox();
  await expectNoDocumentOverflow(page);
  await detail.getByRole("button", { name: "Close details" }).click();
  await expect(detail).toBeHidden();

  expect(await axeViolations(page)).toEqual([]);
  await expectNoDocumentOverflow(page);
  await expectNoSecretReflection(page);
  await saveEvidence(page, testInfo, "approvals-responsive-390-light");
  expectHarnessClean(harness);
  await attachReceipt(testInfo, "approvals-responsive-receipt", harness, {
    responsiveHeader,
    detailWidth: detailBox?.width,
  });
});

test("reduced motion collapses route and detail transitions without weakening interaction", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const harness = await openApprovals(page, bootApp, setTheme, {
    width: 820,
    height: 900,
  });
  const opener = approvalRow(page, PRIMARY_APPROVAL_ID).getByRole("button", {
    name: "Details for Campaign campaign-autumn-release",
  });
  await opener.click();
  const detail = page.getByRole("dialog", { name: "Campaign approval" });
  await expect(detail).toBeVisible();
  const motion = await page.evaluate(() => {
    const tab = document.querySelector<HTMLElement>(".approvals-route-tab");
    const row = document.querySelector<HTMLElement>(
      ".approvals-table tbody tr",
    );
    const panel = document.querySelector<HTMLElement>(".approval-detail-shell");
    const overlay = document.querySelector<HTMLElement>(
      ".slideover-overlay-v2",
    );
    const duration = (element: HTMLElement | null): string | null =>
      element ? getComputedStyle(element).transitionDuration : null;
    const animation = (element: HTMLElement | null): string | null =>
      element ? getComputedStyle(element).animationDuration : null;
    return {
      mediaMatches: matchMedia("(prefers-reduced-motion: reduce)").matches,
      tabTransition: duration(tab),
      rowTransition: duration(row),
      panelAnimation: animation(panel),
      overlayAnimation: animation(overlay),
    };
  });
  expect(motion.mediaMatches).toBe(true);
  for (const value of [
    motion.tabTransition,
    motion.rowTransition,
    motion.panelAnimation,
    motion.overlayAnimation,
  ]) {
    expect(value).not.toBeNull();
    expect(maxDurationMs(value!)).toBeLessThanOrEqual(10);
  }
  await expect(
    detail.getByRole("button", { name: "Close details" }),
  ).toBeEnabled();
  expect(await axeViolations(page)).toEqual([]);
  await expectNoSecretReflection(page);
  await saveEvidence(page, testInfo, "approvals-reduced-motion-detail");
  await detail.getByRole("button", { name: "Close details" }).click();
  await expect(detail).toBeHidden();
  expectHarnessClean(harness);
  await attachReceipt(testInfo, "approvals-reduced-motion-receipt", harness, {
    motion,
  });
});

test("forced colors preserve selected, status, focus, semantics, and containment evidence", async ({
  page,
  bootApp,
  setTheme,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  const harness = await openApprovals(page, bootApp, setTheme, {
    width: 820,
    height: 900,
  });
  const pending = approvalTab(page, "Pending");
  await pending.focus();
  await expect(pending).toBeFocused();
  const forced = await pending.evaluate((element) => {
    const style = getComputedStyle(element);
    const status = document.querySelector<HTMLElement>(".approval-status");
    const statusStyle = status ? getComputedStyle(status) : null;
    return {
      mediaMatches: matchMedia("(forced-colors: active)").matches,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      focusVisible: element.matches(":focus-visible"),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      statusBorderStyle: statusStyle?.borderStyle ?? null,
      statusBorderWidth: statusStyle
        ? Number.parseFloat(statusStyle.borderWidth)
        : null,
    };
  });
  expect(forced.mediaMatches).toBe(true);
  expect(forced.reducedMotion).toBe(true);
  expect(forced.focusVisible).toBe(true);
  expect(forced.outlineStyle).toBe("solid");
  expect(forced.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(forced.statusBorderStyle).toBe("solid");
  expect(forced.statusBorderWidth).toBeGreaterThanOrEqual(1);
  expect(await axeViolations(page, { disableColorContrast: true })).toEqual([]);
  await expectNoDocumentOverflow(page);
  await expectNoSecretReflection(page);
  await saveEvidence(page, testInfo, "approvals-forced-colors-reduced-motion");
  expectHarnessClean(harness);
  await attachReceipt(testInfo, "approvals-forced-colors-receipt", harness, {
    forced,
  });
});
