import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";

import type { ConsoleMessage, Page, Request, Route } from "@playwright/test";

import {
  expect,
  HELPDESK_OPTIMIZED_DIST,
  test,
  waitForPrimaryNavigation,
} from "./fixture-helpdesk";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const EVIDENCE_DIR = resolve(
  process.cwd(),
  "test-results",
  "helpdesk-99p9-evidence",
);

const TENANT_ID = "10000000-0000-4000-8000-000000000041";
const USER_ID = "10000000-0000-4000-8000-000000000042";
const CONVERSATION_ID = "20000000-0000-4000-8000-000000000041";
const OTHER_CONVERSATION_ID = "20000000-0000-4000-8000-000000000042";
const TICKET_ID = "30000000-0000-4000-8000-000000000041";
const MACRO_ID = "40000000-0000-4000-8000-000000000041";
const VERSION = "2026-08-24T09:00:00Z";
const NEXT_VERSION = "2026-08-24T09:01:00Z";
const FIXED_NOW = Date.parse("2026-08-24T10:00:00Z");
const PRIVATE_SEARCH = "private.person@example.invalid";

type Role = "admin" | "viewer";
type Scenario = "complete" | "partial-tickets";

interface RequestReceipt {
  body: string | null;
  headers: Record<string, string>;
  method: string;
  pathname: string;
  search: string;
}

interface Harness {
  addLatestMessage: (body: string) => void;
  consoleErrors: string[];
  failNextMessageRefresh: () => void;
  pageErrors: string[];
  protectedRequests: RequestReceipt[];
  requests: RequestReceipt[];
  writes: RequestReceipt[];
}

interface EvidenceRecord {
  file: string;
  sha256: string;
  state: string;
  theme: "dark" | "light";
  viewport: { height: number; width: number };
}

interface ScenarioResult {
  durationMs: number;
  expectedStatus: string;
  retry: number;
  status: string;
  title: string;
}

const evidence: EvidenceRecord[] = [];
const scenarioResults: ScenarioResult[] = [];
let browserVersion = "not-captured";

const PAGE = {
  has_more: false,
  next_cursor: null,
  as_of: "2026-08-24T10:00:00Z",
  consistency: "mutable_window",
  may_reorder: true,
};

const MESSAGE_PAGE = { ...PAGE, consistency: "created_at_window" };

const CATALOG: unknown = JSON.parse(
  readFileSync(
    new URL(
      "../../../web/src/__tests__/fixtures/api/service-suite_catalog.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as unknown;

const BASE_CONVERSATION = {
  id: CONVERSATION_ID,
  tenantId: TENANT_ID,
  tenant_id: TENANT_ID,
  version: VERSION,
  channel_type: "web_chat",
  source_type: "manual",
  requester_name: "Casey Example",
  requester_email: "casey@example.invalid",
  requester_phone: "+12025550141",
  subject: "Synthetic return timing — مرحبا 👩🏽",
  status: "open",
  priority: "high",
  assignment_state: "legacy_unverified",
  tags: ["synthetic", "priority_review"],
  last_message_at: "2026-08-24T09:34:00Z",
  created_at: "2026-08-24T08:00:00Z",
  updated_at: VERSION,
};

const OTHER_CONVERSATION = {
  id: OTHER_CONVERSATION_ID,
  tenantId: TENANT_ID,
  tenant_id: TENANT_ID,
  version: VERSION,
  channel_type: "generic",
  source_type: "manual",
  requester_name: "River Example",
  requester_email: "river@example.invalid",
  subject: "A deliberately long synthetic subject " + "LongToken_".repeat(16),
  status: "pending",
  priority: "normal",
  assignment_state: "unassigned",
  tags: [],
  last_message_at: "2026-08-24T09:20:00Z",
  created_at: "2026-08-24T08:10:00Z",
  updated_at: VERSION,
};

const MESSAGES = [
  {
    id: "60000000-0000-4000-8000-000000000043",
    tenantId: TENANT_ID,
    tenant_id: TENANT_ID,
    conversation_id: CONVERSATION_ID,
    direction: "internal",
    sender_type: "agent",
    source_type: "manual",
    sender: "Operator note",
    body_text: "Private internal note.\nDelivery is not applicable.",
    record_kind: "internal_note",
    delivery_status: "not_applicable",
    attachment_count: 0,
    projection_truncated: false,
    sent_at: "2026-08-24T09:34:00Z",
    created_at: "2026-08-24T09:34:00Z",
  },
  {
    id: "60000000-0000-4000-8000-000000000042",
    tenantId: TENANT_ID,
    tenant_id: TENANT_ID,
    conversation_id: CONVERSATION_ID,
    direction: "outbound",
    sender_type: "agent",
    source_type: "manual",
    sender: "Historical agent record",
    body_text: "Stored outbound evidence; delivery is unverified.",
    record_kind: "outbound_record",
    delivery_status: "unverified",
    attachment_count: 0,
    projection_truncated: false,
    sent_at: "2026-08-24T09:33:00Z",
    created_at: "2026-08-24T09:33:00Z",
  },
  {
    id: "60000000-0000-4000-8000-000000000041",
    tenantId: TENANT_ID,
    tenant_id: TENANT_ID,
    conversation_id: CONVERSATION_ID,
    direction: "inbound",
    sender_type: "customer",
    source_type: "web_chat",
    sender: "Casey Example",
    body_text:
      "First line of a synthetic customer record.\n\tSecond line with emoji 🛰️ and Arabic مرحبا.",
    record_kind: "inbound_record",
    delivery_status: "received",
    attachment_count: 2,
    projection_truncated: true,
    sent_at: "2026-08-24T09:32:00Z",
    created_at: "2026-08-24T09:32:00Z",
  },
] as const;

const TICKET = {
  id: TICKET_ID,
  tenantId: TENANT_ID,
  tenant_id: TENANT_ID,
  version: VERSION,
  conversation_id: CONVERSATION_ID,
  ticket_number: 1041,
  title: "Synthetic recorded due-date evidence",
  status: "open",
  priority: "high",
  assignment_state: "unassigned",
  source_channel: "manual_record",
  due_at: "2026-08-24T10:50:00Z",
  resolved_at: null,
  created_at: "2026-08-24T08:30:00Z",
  updated_at: VERSION,
};

const MACRO = {
  id: MACRO_ID,
  tenantId: TENANT_ID,
  tenant_id: TENANT_ID,
  version: VERSION,
  name: "Acknowledge record",
  body: "Thanks — I added this as a private internal-note draft.",
  status: "active",
  usage_evidence_status: "unverified",
  channel_types: ["web_chat"],
  tags: ["synthetic"],
  created_at: "2026-08-24T08:00:00Z",
  updated_at: VERSION,
};

const CONFIG = {
  tenantId: TENANT_ID,
  tenant_id: TENANT_ID,
  version: VERSION,
  status: "draft",
  storefronts: [],
  content_blocks: [],
  personalization_rules: { mode: "record_only" },
  support_settings: { contact: "manual" },
  order_history_enabled: true,
  favorites_enabled: false,
  coupons_enabled: false,
  recommendations_enabled: false,
  customer_agent_enabled: false,
  runtime_available: false,
  runtime_status: "held",
  runtime_reason_code: "customer_hub_runtime_unavailable",
  customer_agent_effective_enabled: false,
  styling: { theme: "system" },
  metadata: { fixture: "route41" },
  created_at: "2026-08-24T08:00:00Z",
  updated_at: VERSION,
};

function receipt(request: Request): RequestReceipt {
  const url = new URL(request.url());
  return {
    body: request.postData(),
    headers: request.headers(),
    method: request.method(),
    pathname: url.pathname,
    search: url.search,
  };
}

async function json(
  route: Route,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "cache-control": "no-store, private",
      "x-postwave-context-epoch": "route41-visual-epoch-1",
      ...headers,
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
            __route41SessionBroker?: boolean;
            [key: string]: unknown;
          };
        };
        const current = target.__TAURI_INTERNALS__;
        if (!current) {
          queueMicrotask(install);
          return;
        }
        if (current.__route41SessionBroker) return;
        const originalInvoke = current.invoke.bind(current);
        Object.defineProperty(target, "__TAURI_INTERNALS__", {
          configurable: true,
          writable: false,
          value: {
            ...current,
            __route41SessionBroker: true,
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
                    ? new Response(
                        JSON.stringify({
                          user_id: userId,
                          tenant_id: tenantId,
                          email: `${activeRole}@route41.example.invalid`,
                          role: activeRole,
                          effective_role: activeRole,
                          auth_provider: "password",
                          email_verified: true,
                          workspace_name: "Route41 Synthetic Workspace",
                          workspace_slug: "route41-synthetic",
                        }),
                        {
                          status: 200,
                          headers: {
                            "content-type": "application/json",
                            "x-postwave-context-epoch":
                              "route41-visual-epoch-1",
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
    },
    { activeRole: role, tenantId: TENANT_ID, userId: USER_ID },
  );
}

function isProtectedRequest(pathname: string): boolean {
  return (
    pathname.startsWith("/api/v1/service-suite/") &&
    pathname !== "/api/v1/service-suite/catalog"
  );
}

async function installHarness(
  page: Page,
  role: Role,
  scenario: Scenario = "complete",
): Promise<Harness> {
  const requests: RequestReceipt[] = [];
  const protectedRequests: RequestReceipt[] = [];
  const writes: RequestReceipt[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let conversation = { ...BASE_CONVERSATION } as Record<string, unknown>;
  let config = { ...CONFIG } as Record<string, unknown>;
  let messages: Array<Record<string, unknown>> = MESSAGES.map((message) => ({
    ...message,
  }));
  let failNextMessages = false;

  await installNativeSessionBroker(page, role);
  await page.addInitScript(
    ({ now, tenantId }) => {
      Date.now = () => now;
      localStorage.setItem(
        `postwave_onboarding_dismissed_at:${tenantId}`,
        new Date(now).toISOString(),
      );
    },
    { now: FIXED_NOW, tenantId: TENANT_ID },
  );

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const item = receipt(request);
    requests.push(item);
    if (isProtectedRequest(item.pathname)) protectedRequests.push(item);
    if (item.method !== "GET" && isProtectedRequest(item.pathname)) {
      writes.push(item);
    }

    if (item.pathname === "/api/v1/auth/me") {
      await json(route, {
        user_id: USER_ID,
        tenant_id: TENANT_ID,
        email: `${role}@route41.example.invalid`,
        role,
        effective_role: role,
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Route41 Synthetic Workspace",
        workspace_slug: "route41-synthetic",
      });
      return;
    }
    if (item.pathname === "/api/v1/me") {
      await json(route, {
        user: `${role}@route41.example.invalid`,
        tenant: "Route41 Synthetic Workspace",
      });
      return;
    }
    if (item.pathname === "/api/health" || item.pathname === "/api/v1/health") {
      await json(route, { ok: true, status: "ok" });
      return;
    }
    if (item.pathname === "/api/v1/service-suite/catalog") {
      await json(route, CATALOG);
      return;
    }
    if (item.pathname === "/api/v1/service-suite/conversations") {
      const status = new URL(request.url()).searchParams.get("status");
      await json(route, {
        tenantId: TENANT_ID,
        items:
          status === "open"
            ? [conversation]
            : [conversation, OTHER_CONVERSATION],
        page: PAGE,
      });
      return;
    }
    if (item.pathname === "/api/v1/service-suite/tickets") {
      if (scenario === "partial-tickets") {
        await json(route, {
          tenantId: TENANT_ID,
          items: [
            {
              ...TICKET,
              tenantId: "10000000-0000-4000-8000-000000000099",
              tenant_id: "10000000-0000-4000-8000-000000000099",
            },
          ],
          page: PAGE,
        });
      } else {
        await json(route, { tenantId: TENANT_ID, items: [TICKET], page: PAGE });
      }
      return;
    }
    if (item.pathname === "/api/v1/service-suite/macros") {
      await json(route, {
        tenantId: TENANT_ID,
        items: [MACRO],
        page: PAGE,
      });
      return;
    }
    if (
      item.pathname === `/api/v1/service-suite/conversations/${CONVERSATION_ID}`
    ) {
      await json(route, conversation, 200, {
        etag: `"${String(conversation.version)}"`,
      });
      return;
    }
    if (
      item.pathname ===
      `/api/v1/service-suite/conversations/${CONVERSATION_ID}/messages`
    ) {
      if (failNextMessages) {
        failNextMessages = false;
        // Exercise retained-last-good behavior with a malformed success
        // projection. A deliberate 4xx makes Chromium emit a generic resource
        // console error, which would make the zero-unexpected-console gate
        // self-contradictory rather than testing renderer behavior.
        await json(route, {
          tenantId: TENANT_ID,
          items: "synthetic-invalid-message-window",
          page: MESSAGE_PAGE,
        });
        return;
      }
      await json(route, {
        tenantId: TENANT_ID,
        items: messages,
        page: MESSAGE_PAGE,
      });
      return;
    }
    if (
      item.pathname ===
      `/api/v1/service-suite/conversations/${CONVERSATION_ID}/assign`
    ) {
      conversation = {
        ...conversation,
        version: NEXT_VERSION,
        assignment_state: "tenant_active_user",
        assigned_to: USER_ID,
        assigned_to_user_id: USER_ID,
        updated_at: NEXT_VERSION,
      };
      await json(route, conversation, 200, { etag: `"${NEXT_VERSION}"` });
      return;
    }
    if (
      item.pathname ===
      `/api/v1/service-suite/conversations/${CONVERSATION_ID}/status`
    ) {
      const body = JSON.parse(item.body ?? "{}") as { status?: string };
      conversation = {
        ...conversation,
        version: "2026-08-24T09:02:00Z",
        status: body.status ?? conversation.status,
        updated_at: "2026-08-24T09:02:00Z",
      };
      await json(route, conversation, 200, {
        etag: '"2026-08-24T09:02:00Z"',
      });
      return;
    }
    if (item.pathname === "/api/v1/service-suite/config") {
      if (item.method === "PUT") {
        config = {
          ...(JSON.parse(item.body ?? "{}") as Record<string, unknown>),
          tenantId: TENANT_ID,
          tenant_id: TENANT_ID,
          version: NEXT_VERSION,
          runtime_available: false,
          runtime_status: "held",
          runtime_reason_code: "customer_hub_runtime_unavailable",
          customer_agent_effective_enabled: false,
          created_at: CONFIG.created_at,
          updated_at: NEXT_VERSION,
        };
      }
      await json(route, config, 200, {
        etag: `"${String(config.version)}"`,
      });
      return;
    }
    if (item.pathname === "/api/v1/service-suite/agent/draft-reply") {
      await json(
        route,
        {
          error: {
            code: "customer_agent_draft_write_held",
            message: "Customer Agent draft creation is source-held.",
          },
        },
        409,
      );
      return;
    }
    await json(route, {});
  });

  return {
    addLatestMessage: (body: string): void => {
      messages = [
        {
          id: "60000000-0000-4000-8000-000000000044",
          tenantId: TENANT_ID,
          tenant_id: TENANT_ID,
          conversation_id: CONVERSATION_ID,
          direction: "inbound",
          sender_type: "customer",
          source_type: "web_chat",
          sender: "Casey Example",
          body_text: body,
          record_kind: "inbound_record",
          delivery_status: "received",
          attachment_count: 0,
          projection_truncated: false,
          sent_at: "2026-08-24T09:35:00Z",
          created_at: "2026-08-24T09:35:00Z",
        },
        ...messages,
      ];
    },
    consoleErrors,
    failNextMessageRefresh: (): void => {
      failNextMessages = true;
    },
    pageErrors,
    protectedRequests,
    requests,
    writes,
  };
}

async function capture(
  page: Page,
  file: string,
  state: string,
  theme: "dark" | "light",
): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Route41 evidence requires a fixed viewport");
  browserVersion = page.context().browser()?.version() ?? "unavailable";
  const path = resolve(EVIDENCE_DIR, file);
  const bytes = await page.screenshot({
    path,
    fullPage: false,
    animations: "disabled",
    caret: "hide",
  });
  evidence.push({
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    state,
    theme,
    viewport,
  });
}

function sha256File(path: string | URL): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function aggregateDirectory(root: string): {
  fileCount: number;
  sha256: string;
} {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      const metadata = statSync(path);
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) files.push(path);
    }
  };
  visit(root);
  const aggregate = createHash("sha256");
  for (const file of files.sort()) {
    aggregate.update(`${sha256File(file)}  ${relative(root, file)}\n`);
  }
  return { fileCount: files.length, sha256: aggregate.digest("hex") };
}

function gitHead(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
  } catch {
    return "unavailable";
  }
}

async function settleEvidenceViewport(
  page: Page,
  targetSelector?: string,
): Promise<void> {
  const position = async (): Promise<void> => {
    await page.evaluate((selector) => {
      const main = document.querySelector<HTMLElement>("#main-content");
      if (!main) throw new Error("Route41 evidence requires the app scroller");
      const previousBehavior = main.style.scrollBehavior;
      main.style.scrollBehavior = "auto";
      if (selector) {
        const target = document.querySelector<HTMLElement>(selector);
        if (!target)
          throw new Error(`Route41 evidence target is missing: ${selector}`);
        target.scrollIntoView({ block: "start", inline: "nearest" });
      } else {
        main.scrollTop = 0;
      }
      const threadCard = document.querySelector<HTMLElement>(
        ".helpdesk-thread-card",
      );
      if (threadCard) threadCard.scrollTop = 0;
      main.style.scrollBehavior = previousBehavior;
      window.scrollTo(0, 0);
    }, targetSelector);
  };
  const waitForPaint = async (): Promise<void> =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  await position();
  await waitForPaint();
  // AppShell deliberately restores focused-tab context on its next frame.
  // Reapply the evidence position after that lifecycle settles.
  await position();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

async function dismissEvidenceToasts(page: Page): Promise<void> {
  const dismissButtons = page.locator(".toast-dismiss");
  while ((await dismissButtons.count()) > 0) {
    await dismissButtons.first().click();
  }
  await expect(page.locator(".toast")).toHaveCount(0);
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - window.innerWidth,
    document: document.documentElement.scrollWidth - window.innerWidth,
  }));
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
}

async function assertNoSeriousA11yViolations(
  page: Page,
  target = ".helpdesk-page",
): Promise<void> {
  await page.addScriptTag({ content: AXE_SOURCE });
  const violations = await page.evaluate(async (selector) => {
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
    const result = await axe.run(selector, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21aa"],
      },
    });
    return result.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    );
  }, target);
  expect(violations).toEqual([]);
}

async function privacySnapshot(page: Page): Promise<string> {
  return page.evaluate(() =>
    JSON.stringify({
      url: window.location.href,
      history: window.history.state,
      localStorage: { ...window.localStorage },
      sessionStorage: { ...window.sessionStorage },
    }),
  );
}

test.use({ locale: "en-US", timezoneId: "UTC" });
test.describe.configure({ mode: "serial", timeout: 90_000 });

test.beforeAll(() => {
  rmSync(EVIDENCE_DIR, { force: true, recursive: true });
  mkdirSync(EVIDENCE_DIR, { recursive: true });
});

test.afterEach(({}, testInfo) => {
  scenarioResults.push({
    durationMs: testInfo.duration,
    expectedStatus: testInfo.expectedStatus,
    retry: testInfo.retry,
    status: testInfo.status ?? "unknown",
    title: testInfo.title,
  });
});

test.afterAll(() => {
  const distRoot = resolve(process.cwd(), "dist");
  const rendererArtifact =
    HELPDESK_OPTIMIZED_DIST && existsSync(distRoot)
      ? aggregateDirectory(distRoot)
      : null;
  const sourceFiles = [
    {
      file: "tests/visual/helpdesk-99p9.spec.ts",
      sha256: sha256File(new URL(import.meta.url)),
    },
    {
      file: "tests/visual/fixture-helpdesk.ts",
      sha256: sha256File(new URL("./fixture-helpdesk.ts", import.meta.url)),
    },
    {
      file: "tests/visual/fixture.ts",
      sha256: sha256File(new URL("./fixture.ts", import.meta.url)),
    },
    {
      file: "playwright.helpdesk-optimized.config.ts",
      sha256: sha256File(
        new URL(
          "../../playwright.helpdesk-optimized.config.ts",
          import.meta.url,
        ),
      ),
    },
  ];
  writeFileSync(
    resolve(EVIDENCE_DIR, "manifest.json"),
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        fixtureClock: new Date(FIXED_NOW).toISOString(),
        sourceIdentity: {
          gitHead: gitHead(),
          workspaceState:
            "dirty mutable workspace; Route41 scoped content hashes are authoritative for this run",
          sourceFiles,
        },
        runner: {
          browser: { engine: "chromium", version: browserVersion },
          command:
            "VITE_API_URL=http://localhost:8080 VITE_BUILD_PROFILE=visual-test POSTWAVE_HELPDESK_OPTIMIZED_DIST=1 pnpm --filter postwave-desktop-shell exec playwright test --config playwright.helpdesk-optimized.config.ts",
          config: "playwright.helpdesk-optimized.config.ts",
          dependencyLock: {
            file: "pnpm-lock.yaml",
            sha256: sha256File(resolve(process.cwd(), "../../pnpm-lock.yaml")),
          },
          nodeVersion: process.version,
          axeSourceSha256: createHash("sha256")
            .update(AXE_SOURCE)
            .digest("hex"),
          optimizedDistIntercept: HELPDESK_OPTIMIZED_DIST,
          outcome:
            scenarioResults.length === 5 &&
            scenarioResults.every(
              (result) => result.status === result.expectedStatus,
            )
              ? "passed"
              : "not-passed",
          plannedScenarioTests: 5,
          completedScenarioTests: scenarioResults.length,
          scenarioResults,
          screenshotCount: evidence.length,
        },
        rendererBuild: {
          artifactRoot: "dist",
          command:
            "VITE_API_URL=http://localhost:8080 VITE_BUILD_PROFILE=visual-test pnpm --filter postwave-desktop-shell build",
          environment: {
            VITE_API_URL: "http://localhost:8080",
            VITE_BUILD_PROFILE: "visual-test",
          },
          artifact: rendererArtifact,
        },
        qualification: "Route41 Helpdesk desktop 99.9p",
        matrix: {
          access: ["exact-admin", "viewer-catalog-only"],
          capabilities: [
            "internal-note-only",
            "customer-delivery-held",
            "hub-runtime-held",
            "agent-create-held",
          ],
          presentation: [
            "1440-light-dark",
            "720-master-detail",
            "390-master-detail",
            "320-200%-text",
            "forced-colors",
          ],
          state: [
            "complete",
            "manual-latest-refresh",
            "terminal-review",
            "partial",
            "stale-offline",
            "invalid-route",
          ],
        },
        syntheticFixturePolicy:
          "example.invalid identities, 202-555-01xx phone, canonical synthetic UUIDs, no credentials or provider identifiers",
        screenshots: evidence,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
});

test("admin inbox contains route, identity, interaction, and responsive truth", async ({
  bootApp,
  page,
  setTheme,
}) => {
  await bootApp(page);
  await setTheme(page, "light");
  const harness = await installHarness(page, "admin");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/app/helpdesk/${CONVERSATION_ID}?f.status=open`);
  await waitForPrimaryNavigation(page);

  await expect(page.getByRole("heading", { name: "Helpdesk" })).toBeVisible();
  await expect(
    page.getByText("Historical assignment exists · identity unverified"),
  ).toBeVisible();
  await expect(
    page.getByText("Internal note · delivery not applicable"),
  ).toBeVisible();
  await expect(
    page.getByText("Stored outbound record · customer delivery unverified"),
  ).toBeVisible();
  await expect(page.getByText("Recorded due in 50m").first()).toBeVisible();
  await expect(
    page.getByText(/Customer delivery, Agent draft creation/u),
  ).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`/app/helpdesk/${CONVERSATION_ID}\\?f.status=open$`, "u"),
  );
  const threadHeading = page.getByRole("heading", { name: "Casey Example" });
  await expect(threadHeading).toBeFocused();

  const refreshLatest = page.getByRole("button", { name: "Refresh latest" });
  harness.addLatestMessage("Newest manually refreshed record.");
  await refreshLatest.focus();
  await refreshLatest.click();
  await expect(
    page.getByText("Newest manually refreshed record."),
  ).toBeVisible();
  await expect(refreshLatest).toBeFocused();
  expect(
    harness.requests.some(
      (item) =>
        item.pathname === "/api/v1/service-suite/tickets" &&
        new URLSearchParams(item.search).get("conversation_id") ===
          CONVERSATION_ID,
    ),
  ).toBe(true);

  harness.failNextMessageRefresh();
  await refreshLatest.click();
  await expect(
    page.getByText("Latest window is partial", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Newest manually refreshed record."),
  ).toBeVisible();
  await expect(refreshLatest).toBeFocused();
  await refreshLatest.click();
  await expect(page.locator(".helpdesk-thread-partial")).toHaveCount(0);

  const search = page.getByRole("searchbox", {
    name: "Search loaded conversations",
  });
  await search.fill(PRIVATE_SEARCH);
  await expect(page.getByText("0 of 1 loaded conversations")).toBeVisible();
  expect(await privacySnapshot(page)).not.toContain(PRIVATE_SEARCH);
  expect(
    harness.requests.some((item) => item.body?.includes(PRIVATE_SEARCH)),
  ).toBe(false);
  expect(harness.consoleErrors.join("\n")).not.toContain(PRIVATE_SEARCH);
  await search.fill("");

  const macro = page.getByLabel("Insert macro text into internal note");
  await macro.focus();
  await expect(
    macro.getByRole("option", { name: "Acknowledge record" }),
  ).toBeAttached();
  await macro.selectOption("0");
  const internalNote = page.getByRole("textbox", {
    name: "Internal note",
    exact: true,
  });
  await expect(
    page.getByText(
      /cannot currently be edited or deleted through Helpdesk.*complete privacy lifecycle remains held/u,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      /Delivery is not applicable and no customer channel is contacted/u,
    ),
  ).toBeVisible();
  await expect(internalNote).toHaveValue(MACRO.body);
  expect(
    harness.writes.some((item) => /macros?\/.+\/use$/u.test(item.pathname)),
  ).toBe(false);

  await internalNote.fill("😀".repeat(4097));
  await expect(
    page.getByRole("button", { name: "Add internal note" }),
  ).toBeDisabled();
  await expect(page.getByText(/16,388 \/ 16,384 UTF-8 bytes/u)).toBeVisible();
  await internalNote.fill("");

  const desktopLayout = await page.evaluate(() => {
    const assignmentControls = document.querySelector<HTMLElement>(
      ".helpdesk-assignment-controls",
    );
    const messageWindow = document.querySelector<HTMLElement>(
      ".helpdesk-message-scroll",
    );
    if (!assignmentControls || !messageWindow) {
      throw new Error("Route41 desktop layout evidence is incomplete");
    }
    return {
      assignmentDirection: getComputedStyle(assignmentControls).flexDirection,
      messageWindowHeight: messageWindow.clientHeight,
    };
  });
  expect(desktopLayout.assignmentDirection).toBe("row");
  expect(desktopLayout.messageWindowHeight).toBeGreaterThanOrEqual(120);
  await assertNoSeriousA11yViolations(page);
  await assertNoHorizontalOverflow(page);
  const refreshedMessage = page.getByText("Newest manually refreshed record.");
  await refreshedMessage.scrollIntoViewIfNeeded();
  await settleEvidenceViewport(page);
  await expect(refreshedMessage).toBeInViewport();
  await capture(
    page,
    "inbox-thread-1440-light.png",
    "selected verified thread",
    "light",
  );

  await page.getByRole("button", { name: "Assign to me" }).click();
  await expect(page.getByText(`Verified user ${USER_ID}`)).toBeVisible();
  const assign = harness.writes.find((item) =>
    item.pathname.endsWith("/assign"),
  );
  expect(assign?.headers["if-match"]).toBe(`"${VERSION}"`);
  expect(JSON.parse(assign?.body ?? "{}")).toEqual({ action: "assign_self" });

  await page.getByLabel("Conversation status").selectOption("pending");
  await expect(page.getByLabel("Conversation status")).toHaveValue("pending");
  const status = harness.writes.find((item) =>
    item.pathname.endsWith("/status"),
  );
  expect(status?.headers["if-match"]).toBe(`"${NEXT_VERSION}"`);
  expect(JSON.parse(status?.body ?? "{}")).toEqual({ status: "pending" });

  const writesBeforeTerminalReview = harness.writes.length;
  await page.getByLabel("Conversation status").selectOption("closed");
  const terminalReview = page.getByRole("alertdialog", {
    name: "Review recorded status change",
  });
  await expect(terminalReview).toContainText("Pending → Closed");
  await expect(
    terminalReview.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  expect(harness.writes).toHaveLength(writesBeforeTerminalReview);
  await assertNoSeriousA11yViolations(page, "body");
  await assertNoHorizontalOverflow(page);
  await capture(
    page,
    "inbox-terminal-status-review-1440-light.png",
    "cancel-first terminal status review",
    "light",
  );
  await terminalReview.getByRole("button", { name: "Cancel" }).press("Escape");
  await expect(terminalReview).toHaveCount(0);
  await expect(page.getByLabel("Conversation status")).toBeFocused();
  await dismissEvidenceToasts(page);

  await page.setViewportSize({ width: 720, height: 900 });
  await assertNoSeriousA11yViolations(page);
  await assertNoHorizontalOverflow(page);
  await settleEvidenceViewport(page);
  await capture(
    page,
    "inbox-thread-720-light.png",
    "bounded tablet detail",
    "light",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "← Queue" }).click();
  await expect(page.getByRole("heading", { name: "Queue" })).toBeVisible();
  const selectedQueueRow = page.getByRole("button", {
    name: /Open conversation record 1/u,
  });
  await expect(selectedQueueRow).toBeFocused();
  await assertNoSeriousA11yViolations(page);
  await assertNoHorizontalOverflow(page);
  await settleEvidenceViewport(page, ".helpdesk-inbox-layout");
  await capture(
    page,
    "inbox-queue-390-light.png",
    "mobile-width master queue",
    "light",
  );

  await selectedQueueRow.click();
  await expect(
    page.getByRole("heading", { name: "Casey Example" }),
  ).toBeFocused();
  await page.setViewportSize({ width: 320, height: 720 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
    const style = document.createElement("style");
    style.dataset.route41TextSpacing = "true";
    style.textContent =
      ".helpdesk-page *{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}.helpdesk-page p{margin-bottom:2em!important}";
    document.head.appendChild(style);
  });
  await assertNoSeriousA11yViolations(page);
  await assertNoHorizontalOverflow(page);
  await settleEvidenceViewport(page, ".helpdesk-tabs");
  await capture(
    page,
    "inbox-thread-320-text-spacing.png",
    "320px at 200 percent text spacing",
    "light",
  );

  await page.evaluate(() => {
    document.documentElement.style.removeProperty("font-size");
    document.querySelector("style[data-route41-text-spacing]")?.remove();
  });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  const narrowAssignmentInput = await page
    .getByPlaceholder("Assignment reason (optional)")
    .boundingBox();
  expect(narrowAssignmentInput?.height).toBeLessThanOrEqual(40);
  await assertNoSeriousA11yViolations(page);
  await assertNoHorizontalOverflow(page);
  await settleEvidenceViewport(page, ".helpdesk-thread-card");
  await capture(
    page,
    "inbox-thread-forced-colors-390.png",
    "forced colors and reduced motion",
    "light",
  );

  await page.emulateMedia({
    forcedColors: "none",
    reducedMotion: "no-preference",
  });
  await page.context().setOffline(true);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    window.dispatchEvent(new Event("offline"));
  });
  await expect(
    page.getByText("Helpdesk is offline", { exact: false }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add internal note" }),
  ).toBeDisabled();
  await assertNoSeriousA11yViolations(page);
  await assertNoHorizontalOverflow(page);
  await settleEvidenceViewport(page);
  await capture(
    page,
    "inbox-stale-offline-390.png",
    "stale retained thread offline",
    "light",
  );
  await page.context().setOffline(false);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    window.dispatchEvent(new Event("online"));
  });

  expect(
    harness.writes.filter((item) =>
      /\/messages$|\/internal-notes$|\/reply$|\/use$/u.test(item.pathname),
    ),
  ).toEqual([]);
  expect(harness.pageErrors).toEqual([]);
  expect(harness.consoleErrors).toEqual([]);
});

test("Hub replacement remains active while Agent create stays source-held", async ({
  bootApp,
  page,
  setTheme,
}) => {
  await bootApp(page);
  await setTheme(page, "dark");
  const harness = await installHarness(page, "admin");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/helpdesk?tab=hub");
  await waitForPrimaryNavigation(page);

  await expect(
    page.getByRole("heading", { name: "Customer Hub" }),
  ).toBeVisible();
  await expect(page.getByText("Runtime release held")).toBeVisible();
  await expect(
    page.getByRole("option", { name: /Active — publication release held/u }),
  ).toBeDisabled();
  await expect(
    page.getByRole("switch", { name: "Customer Agent" }),
  ).toBeDisabled();
  await page.getByRole("switch", { name: "Favorites" }).check();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("No unsaved changes.")).toBeVisible();

  const replacement = harness.writes.find(
    (item) => item.pathname === "/api/v1/service-suite/config",
  );
  expect(replacement?.method).toBe("PUT");
  expect(replacement?.headers["if-match"]).toBe(`"${VERSION}"`);
  expect(Object.keys(JSON.parse(replacement?.body ?? "{}")).sort()).toEqual(
    [
      "content_blocks",
      "coupons_enabled",
      "customer_agent_enabled",
      "favorites_enabled",
      "metadata",
      "order_history_enabled",
      "personalization_rules",
      "recommendations_enabled",
      "status",
      "storefronts",
      "styling",
      "support_settings",
    ].sort(),
  );
  await assertNoSeriousA11yViolations(page);
  await assertNoHorizontalOverflow(page);
  await settleEvidenceViewport(page);
  await capture(
    page,
    "hub-complete-replacement-1440-dark.png",
    "Hub configuration with runtime held",
    "dark",
  );

  await page.getByRole("tab", { name: "Agent" }).click();
  await dismissEvidenceToasts(page);
  await expect(page).toHaveURL(/\/app\/helpdesk\?tab=agent$/u);
  await expect(page.getByText("Draft creation unavailable")).toBeVisible();
  await expect(page.getByText("customer_agent_draft_write_held")).toBeVisible();
  await expect(page.getByText("Provider executed")).toBeVisible();
  await expect(page.getByText("No", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Generate draft — unavailable" }),
  ).toBeDisabled();
  await assertNoSeriousA11yViolations(page);
  await assertNoHorizontalOverflow(page);
  await settleEvidenceViewport(page);
  await capture(
    page,
    "agent-create-held-1440-dark.png",
    "source-held deterministic Agent declaration",
    "dark",
  );

  expect(
    harness.writes.some((item) =>
      /\/messages$|\/internal-notes$|\/reply$|\/use$|\/agent\/draft-reply$/u.test(
        item.pathname,
      ),
    ),
  ).toBe(false);
  expect(harness.pageErrors).toEqual([]);
  expect(harness.consoleErrors).toEqual([]);
});

test("partial ticket evidence and viewer access fail closed", async ({
  bootApp,
  page,
  setTheme,
}) => {
  await bootApp(page);
  await setTheme(page, "light");
  const partial = await installHarness(page, "admin", "partial-tickets");
  await page.setViewportSize({ width: 720, height: 900 });
  await page.goto(`/app/helpdesk/${CONVERSATION_ID}`);
  await waitForPrimaryNavigation(page);
  await expect(
    page
      .locator(".helpdesk-thread-partial")
      .getByText("Current verification is partial", { exact: false }),
  ).toBeVisible();
  await expect(
    page.locator(".helpdesk-thread-due-date").getByText("Due date unverified"),
  ).toBeVisible();
  await assertNoSeriousA11yViolations(page);
  await assertNoHorizontalOverflow(page);
  await settleEvidenceViewport(page, ".helpdesk-thread-card");
  await capture(
    page,
    "inbox-partial-ticket-720.png",
    "ticket timing evidence partial",
    "light",
  );
  expect(partial.pageErrors).toEqual([]);
  expect(partial.consoleErrors).toEqual([]);
});

test("viewer route starts no protected request", async ({
  bootApp,
  page,
  setTheme,
}) => {
  await bootApp(page);
  await setTheme(page, "light");
  const harness = await installHarness(page, "viewer");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `/app/helpdesk/${CONVERSATION_ID}?q=${encodeURIComponent(PRIVATE_SEARCH)}`,
  );
  await waitForPrimaryNavigation(page);
  await expect(
    page.locator(".helpdesk-access-badge").getByText("Catalog only", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Protected Helpdesk records are admin-only",
    }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/app\/helpdesk$/u);
  expect(harness.protectedRequests).toEqual([]);
  expect(await privacySnapshot(page)).not.toContain(PRIVATE_SEARCH);
  await assertNoSeriousA11yViolations(page);
  await assertNoHorizontalOverflow(page);
  await settleEvidenceViewport(page);
  await capture(
    page,
    "viewer-catalog-only-390.png",
    "viewer catalog-only boundary",
    "light",
  );

  expect(harness.pageErrors).toEqual([]);
  expect(harness.consoleErrors).toEqual([]);
});

test("malformed conversation routes clear before protected detail reads", async ({
  bootApp,
  page,
  setTheme,
}) => {
  await bootApp(page);
  await setTheme(page, "light");
  const harness = await installHarness(page, "admin");
  await page.setViewportSize({ width: 390, height: 844 });

  for (const hostileId of [
    "not-a-uuid",
    "%00control-prefix",
    "a".repeat(513),
  ]) {
    harness.protectedRequests.length = 0;
    await page.goto(`/app/helpdesk/${hostileId}`);
    await waitForPrimaryNavigation(page);
    await expect(page).toHaveURL(/\/app\/helpdesk$/u);
    await expect(page.getByRole("heading", { name: "Queue" })).toBeVisible();
    expect(
      harness.protectedRequests.filter((request) =>
        /^\/api\/v1\/service-suite\/conversations\//u.test(request.pathname),
      ),
    ).toEqual([]);
    expect(await privacySnapshot(page)).not.toContain(hostileId);
  }

  await assertNoSeriousA11yViolations(page);
  await assertNoHorizontalOverflow(page);
  await settleEvidenceViewport(page, ".helpdesk-inbox-layout");
  await capture(
    page,
    "invalid-conversation-route-cleared-390.png",
    "malformed identifier cleared before protected detail read",
    "light",
  );
  expect(harness.pageErrors).toEqual([]);
  expect(harness.consoleErrors).toEqual([]);
});
