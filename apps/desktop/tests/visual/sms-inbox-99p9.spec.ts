import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import type { ConsoleMessage, Page, Request, Route } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const EVIDENCE_DIR = resolve(
  process.cwd(),
  "test-results",
  "sms-inbox-99p9-evidence",
);
const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000002";
const LIST_ID = "30000000-0000-4000-8000-000000000001";
const SENDER_ID = "40000000-0000-4000-8000-000000000001";
const BROADCAST_DRAFT_ID = "50000000-0000-4000-8000-000000000001";
const BROADCAST_SENDING_ID = "50000000-0000-4000-8000-000000000002";
const FIXED_NOW = Date.parse("2026-08-21T12:00:00.000Z");
const SNAPSHOT_AT = "2026-08-21T11:55:00.000Z";
const PRIVATE_SEARCH = "Synthetic private search \u202e321 CBA\u202c";
const HOSTILE_BODY =
  "Synthetic RTL \u202e321 CBA\u202c\n" +
  "LongToken_".repeat(24) +
  " مرحبا بالعالم 👩🏽‍💻🛰️";

const PHONES = ["+12025550101", "+12025550102", "+12025550103"] as const;

type Role = "admin" | "viewer";

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
  requests: RequestReceipt[];
  sendWrites: RequestReceipt[];
}

interface EvidenceRecord {
  file: string;
  sha256: string;
  state: string;
  viewport: { height: number; width: number };
}

const evidence: EvidenceRecord[] = [];

const CONVERSATIONS = [
  {
    phoneE164: PHONES[0],
    lastMessagePreview:
      "Can you confirm the synthetic pickup window? 👋\nReference: EXAMPLE-1042",
    lastMessageAt: "2026-08-21T11:50:00.000Z",
    lastDirection: "inbound",
    messageCount: 3,
    unreadCount: 2,
    oldestUnreadAt: "2026-08-21T11:45:00.000Z",
    subscriberEmail: "casey.one@example.invalid",
    identityAmbiguous: false,
  },
  {
    phoneE164: PHONES[1],
    lastMessagePreview: HOSTILE_BODY.slice(0, 420),
    lastMessageAt: "2026-08-21T11:35:00.000Z",
    lastDirection: "inbound",
    messageCount: 7,
    unreadCount: 1,
    oldestUnreadAt: "2026-08-21T11:35:00.000Z",
    identityAmbiguous: true,
  },
  {
    phoneE164: PHONES[2],
    lastMessagePreview: "",
    lastMessagePreviewOmittedReason: "body_exceeds_inbox_limit",
    lastMessageAt: "2026-08-21T11:20:00.000Z",
    lastDirection: "inbound",
    messageCount: 1,
    unreadCount: 0,
    subscriberEmail: "river.three@example.invalid",
    identityAmbiguous: false,
  },
] as const;

const BROADCASTS = [
  {
    id: BROADCAST_DRAFT_ID,
    tenant_id: TENANT_ID,
    sender_profile_id: SENDER_ID,
    name: "Synthetic release reminder",
    body: "Synthetic reminder: your example pickup window opens tomorrow.",
    list_ids: [LIST_ID],
    status: "draft",
    sent_count: 0,
    failed_count: 0,
    held_count: 0,
    segments_per_message: 1,
    created_at: "2026-08-21T10:00:00.000Z",
    updated_at: "2026-08-21T10:00:00.000Z",
  },
  {
    id: BROADCAST_SENDING_ID,
    tenant_id: TENANT_ID,
    sender_profile_id: SENDER_ID,
    name: "Synthetic service update",
    body: "Synthetic service update for the example audience.",
    list_ids: [],
    tag: "synthetic-support",
    status: "sending",
    sent_count: 17,
    failed_count: 2,
    held_count: 3,
    segments_per_message: 1,
    created_at: "2026-08-21T09:00:00.000Z",
    updated_at: "2026-08-21T11:54:00.000Z",
  },
] as const;

function requestReceipt(request: Request): RequestReceipt {
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
      "x-postwave-context-epoch": "route40-visual-epoch-1",
    },
    body: JSON.stringify(body),
  });
}

function messagesFor(phone: string): Array<Record<string, unknown>> {
  if (phone !== PHONES[0]) {
    return [
      {
        id: "20000000-0000-4000-8000-000000000011",
        tenant_id: TENANT_ID,
        phone_e164: phone,
        provider: "twilio",
        direction: "inbound",
        body: HOSTILE_BODY,
        segments: 3,
        status: "received",
        cost_micros: 0,
        received_at: "2026-08-21T11:35:00.000Z",
        created_at: "2026-08-21T11:35:00.000Z",
      },
    ];
  }
  return [
    {
      id: "20000000-0000-4000-8000-000000000001",
      tenant_id: TENANT_ID,
      phone_e164: phone,
      provider: "twilio",
      direction: "inbound",
      body: HOSTILE_BODY,
      segments: 3,
      status: "received",
      cost_micros: 0,
      received_at: "2026-08-21T11:50:00.000Z",
      created_at: "2026-08-21T11:50:00.000Z",
    },
    {
      id: "20000000-0000-4000-8000-000000000002",
      tenant_id: TENANT_ID,
      sender_profile_id: SENDER_ID,
      phone_e164: phone,
      provider: "twilio",
      provider_message_id: "synthetic-provider-message-002",
      direction: "outbound",
      body: "Synthetic reply retained by the inbox.",
      segments: 1,
      status: "sent",
      dispatch_state: "persisted",
      cost_micros: 8200,
      sent_at: "2026-08-21T11:45:00.000Z",
      created_at: "2026-08-21T11:45:00.000Z",
    },
    {
      id: "20000000-0000-4000-8000-000000000003",
      tenant_id: TENANT_ID,
      phone_e164: phone,
      provider: "twilio",
      direction: "inbound",
      body: "",
      body_omitted_reason: "body_exceeds_inbox_limit",
      segments: 8,
      status: "received",
      cost_micros: 0,
      received_at: "2026-08-21T11:40:00.000Z",
      created_at: "2026-08-21T11:40:00.000Z",
    },
  ];
}

function contextFor(phone: string): Record<string, unknown> {
  const ambiguous = phone === PHONES[1];
  return {
    tenantId: TENANT_ID,
    phoneE164: phone,
    ...(ambiguous ? {} : { subscriberEmail: "casey.one@example.invalid" }),
    consentStatus: "opted_in",
    consentSource: "web_form",
    consentAt: "2026-08-10T08:00:00.000Z",
    consentMixed: false,
    identityAmbiguous: ambiguous,
    consentEvidenceSufficient: !ambiguous,
    subscribedLists: ambiguous ? 0 : 1,
    firstSeenAt: "2026-08-10T08:00:00.000Z",
    totalMessages: phone === PHONES[0] ? 3 : 7,
    suppressed: false,
    suppressionReversible: false,
    hasInboundThread: true,
    eligibleLists: ambiguous
      ? []
      : [
          {
            id: LIST_ID,
            name: "Synthetic service notices",
            description: "Fictional consent list for Route40 evidence.",
            consentSource: "web_form",
            consentAt: "2026-08-10T08:00:00.000Z",
          },
        ],
    replyDispatchAvailable: false,
    replyDispatchUnavailableReason: "sms_reply_dispatch_release_held",
  };
}

function isProtectedSMSRequest(pathname: string): boolean {
  return (
    pathname.startsWith("/api/v1/sms/conversations") ||
    pathname.startsWith("/api/v1/sms/broadcasts") ||
    pathname === "/api/v1/sms/senders" ||
    pathname === "/api/v1/sms/lists"
  );
}

function isSendWrite(receipt: RequestReceipt): boolean {
  return (
    receipt.method !== "GET" &&
    (receipt.pathname.endsWith("/reply") ||
      receipt.pathname.endsWith("/send") ||
      receipt.pathname === "/api/v1/sms/broadcasts")
  );
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
            __route40SessionBroker?: boolean;
            [key: string]: unknown;
          };
        };
        const current = target.__TAURI_INTERNALS__;
        if (!current) {
          queueMicrotask(install);
          return;
        }
        if (current.__route40SessionBroker) return;
        const originalInvoke = current.invoke.bind(current);
        Object.defineProperty(target, "__TAURI_INTERNALS__", {
          configurable: true,
          writable: false,
          value: {
            ...current,
            __route40SessionBroker: true,
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
                          | {
                              event: "complete" | "error";
                              message?: string;
                            },
                      ) => void;
                    }
                  | undefined;
                const response =
                  pathname === "/api/v1/auth/me"
                    ? new Response(
                        JSON.stringify({
                          user_id: userId,
                          tenant_id: tenantId,
                          email: `${activeRole}@route40.example.invalid`,
                          role: activeRole,
                          effective_role: activeRole,
                          auth_provider: "password",
                          email_verified: true,
                          workspace_name: "Route40 Synthetic Workspace",
                          workspace_slug: "route40-synthetic",
                        }),
                        {
                          status: 200,
                          headers: {
                            "content-type": "application/json",
                            "x-postwave-context-epoch":
                              "route40-visual-epoch-1",
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

async function installHarness(page: Page, role: Role): Promise<Harness> {
  const requests: RequestReceipt[] = [];
  const protectedRequests: RequestReceipt[] = [];
  const sendWrites: RequestReceipt[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  await installNativeSessionBroker(page, role);

  await page.addInitScript(
    ({ now, tenantId }) => {
      Date.now = () => now;
      localStorage.setItem(
        `postwave_onboarding_dismissed_at:${tenantId}`,
        new Date(now).toISOString(),
      );
      const target = window as typeof window & {
        __route40ClipboardWrites?: string[];
      };
      target.__route40ClipboardWrites = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            target.__route40ClipboardWrites?.push(value);
          },
        },
      });
    },
    { now: FIXED_NOW, tenantId: TENANT_ID },
  );

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const receipt = requestReceipt(request);
    const { pathname } = receipt;
    requests.push(receipt);
    if (isProtectedSMSRequest(pathname)) protectedRequests.push(receipt);
    if (isSendWrite(receipt)) sendWrites.push(receipt);

    if (pathname === "/api/v1/auth/me") {
      await json(route, {
        user_id: USER_ID,
        tenant_id: TENANT_ID,
        email: `${role}@route40.example.invalid`,
        role,
        effective_role: role,
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Route40 Synthetic Workspace",
        workspace_slug: "route40-synthetic",
      });
      return;
    }
    if (pathname === "/api/v1/me") {
      await json(route, {
        user: `${role}@route40.example.invalid`,
        tenant: "Route40 Synthetic Workspace",
      });
      return;
    }
    if (pathname === "/api/health" || pathname === "/api/v1/health") {
      await json(route, { ok: true, status: "ok" });
      return;
    }
    if (pathname === "/api/v1/sms/conversations/search") {
      await json(route, {
        tenantId: TENANT_ID,
        conversations: [],
        snapshotAt: SNAPSHOT_AT,
      });
      return;
    }
    if (pathname === "/api/v1/sms/conversations") {
      await json(route, {
        tenantId: TENANT_ID,
        conversations: CONVERSATIONS,
        snapshotAt: SNAPSHOT_AT,
        unreadTotal: 2,
        unknownTotal: 0,
        totalConversations: 3,
        activeTotal: 3,
        snoozedTotal: 0,
        archivedTotal: 0,
      });
      return;
    }

    const conversationMatch = pathname.match(
      /^\/api\/v1\/sms\/conversations\/([^/]+)\/(messages|context|mark-read|tags|activity)$/u,
    );
    if (conversationMatch) {
      const phone = decodeURIComponent(conversationMatch[1] ?? "");
      const resource = conversationMatch[2];
      if (resource === "messages") {
        await json(route, {
          tenantId: TENANT_ID,
          messages: messagesFor(phone),
          snapshotAt: SNAPSHOT_AT,
        });
      } else if (resource === "context") {
        await json(route, contextFor(phone));
      } else if (resource === "mark-read") {
        const body = JSON.parse(request.postData() ?? "{}") as {
          message_ids?: unknown[];
        };
        await json(route, {
          ok: true,
          applied: Array.isArray(body.message_ids)
            ? body.message_ids.length
            : 0,
        });
      } else if (resource === "tags") {
        await json(route, {
          tenantId: TENANT_ID,
          phoneE164: phone,
          tags: [],
          snapshotAt: SNAPSHOT_AT,
          truncated: false,
        });
      } else {
        await json(route, {
          tenantId: TENANT_ID,
          phoneE164: phone,
          events: [],
          snapshotAt: SNAPSHOT_AT,
          truncated: false,
          sourcePlanes: ["sms_consent_events", "sms_subscriptions_current"],
          historyComplete: false,
        });
      }
      return;
    }

    if (pathname === "/api/v1/sms/senders") {
      await json(route, {
        tenantId: TENANT_ID,
        items: [
          {
            id: SENDER_ID,
            tenant_id: TENANT_ID,
            provider: "twilio",
            country: "US",
            sender_type: "long_code",
            phone_number: "+12025550109",
            registration_status: "approved",
            created_at: "2026-08-01T08:00:00.000Z",
            updated_at: "2026-08-20T08:00:00.000Z",
          },
        ],
      });
      return;
    }
    if (pathname === "/api/v1/sms/quick-replies") {
      await json(route, { replies: [] });
      return;
    }
    if (pathname === "/api/v1/sms/lists") {
      await json(route, {
        items: [
          {
            id: LIST_ID,
            name: "Synthetic service notices",
            description: "Fictional Route40 evidence audience.",
          },
        ],
      });
      return;
    }
    if (pathname === "/api/v1/segments") {
      await json(route, []);
      return;
    }
    if (pathname === "/api/v1/sms/broadcasts") {
      await json(route, {
        tenantId: TENANT_ID,
        items: BROADCASTS,
        snapshotAt: SNAPSHOT_AT,
        broadcastDispatchAvailable: false,
        broadcastDispatchUnavailableReason:
          "sms_broadcast_dispatch_release_held",
      });
      return;
    }
    if (
      pathname === `/api/v1/sms/broadcasts/${BROADCAST_SENDING_ID}/progress`
    ) {
      await json(route, {
        status: "sending",
        sent: 17,
        failed: 2,
        held: 3,
        total: 30,
      });
      return;
    }
    if (pathname === "/api/v1/tags") {
      await json(route, { items: [] });
      return;
    }
    await json(route, {});
  });

  return {
    consoleErrors,
    pageErrors,
    protectedRequests,
    requests,
    sendWrites,
  };
}

async function capture(page: Page, file: string, state: string): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Route40 evidence requires a fixed viewport");
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
    viewport,
  });
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - window.innerWidth,
    document: document.documentElement.scrollWidth - window.innerWidth,
  }));
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
}

async function assertNoCriticalA11yViolations(page: Page): Promise<void> {
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
    const result = await axe.run(".sms-inbox-page", {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21aa"],
      },
    });
    return result.violations.filter(
      (violation) =>
        violation.impact === "critical" || violation.impact === "serious",
    );
  });
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

function assertSyntheticFixtures(): void {
  for (const phone of PHONES) {
    expect(phone).toMatch(/^\+120255501(?:0[1-9]|1[0-9])$/u);
  }
  const fixtureText = JSON.stringify({
    broadcasts: BROADCASTS,
    conversations: CONVERSATIONS,
    hostileBody: HOSTILE_BODY,
    phones: PHONES,
  });
  const emails = fixtureText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+/giu) ?? [];
  expect(emails.every((email) => email.endsWith("@example.invalid"))).toBe(
    true,
  );
  expect(fixtureText).not.toMatch(
    /(?:AC|SK)[0-9a-f]{24,}|(?:pw|postwave)_(?:live|test)_[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._-]+/u,
  );
}

test.use({ locale: "en-US", timezoneId: "UTC" });
test.describe.configure({ mode: "serial", timeout: 90_000 });

test.beforeAll(() => {
  rmSync(EVIDENCE_DIR, { force: true, recursive: true });
  mkdirSync(EVIDENCE_DIR, { recursive: true });
});

test.afterAll(() => {
  writeFileSync(
    resolve(EVIDENCE_DIR, "manifest.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date(FIXED_NOW).toISOString(),
        qualification: "Route40 SMS Inbox and Broadcasts desktop 99.9p",
        syntheticFixturePolicy:
          "NANP 202-555-01xx, example.invalid, no provider SIDs or credentials",
        screenshots: evidence,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
});

test("synthetic fixtures are privacy-safe by construction", () => {
  assertSyntheticFixtures();
});

test("admin route preserves safe history while responsive evidence stays truthful", async ({
  bootApp,
  page,
  setTheme,
}) => {
  await bootApp(page);
  await setTheme(page, "light");
  const harness = await installHarness(page, "admin");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/sms-inbox");
  await waitForPrimaryNavigation(page);
  await expect(page.getByRole("heading", { name: "SMS Inbox" })).toBeVisible();
  await expect(page.getByText("3 conversations shown")).toBeVisible();
  await expect(page.getByText("Multiple linked identities")).toBeVisible();
  await expect(
    page.getByText("Message body unavailable · exceeded inbox evidence limit"),
  ).toBeVisible();

  const search = page.getByRole("searchbox", {
    name: "Search SMS conversations",
  });
  await search.fill(PRIVATE_SEARCH);
  await expect
    .poll(
      () =>
        harness.requests.some(
          (request) =>
            request.pathname === "/api/v1/sms/conversations/search" &&
            request.body?.includes(PRIVATE_SEARCH),
        ),
      { message: "server search receives the ephemeral term" },
    )
    .toBe(true);
  const privateState = await privacySnapshot(page);
  expect(privateState).not.toContain(PRIVATE_SEARCH);
  expect(decodeURIComponent(page.url())).not.toContain(PRIVATE_SEARCH);
  expect(harness.consoleErrors.join("\n")).not.toContain(PRIVATE_SEARCH);
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __route40ClipboardWrites?: string[] })
          .__route40ClipboardWrites ?? [],
    ),
  ).toEqual([]);

  await search.fill("");
  await expect(page.getByText("3 conversations shown")).toBeVisible();
  await page.locator(".sms-inbox-row-open").first().click();
  await expect(page.locator(".sms-bubble")).toHaveCount(3);
  await expect(
    page.getByText(
      "Message body unavailable: the retained content exceeded the inbox evidence limit. The record was not truncated for display.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();
  await expect(page).toHaveURL(/\/app\/sms-inbox$/u);
  expect(await privacySnapshot(page)).not.toContain(PHONES[0]);
  await assertNoCriticalA11yViolations(page);
  await assertNoHorizontalOverflow(page);
  await capture(page, "inbox-thread-1440.png", "selected retained thread");

  await page.getByRole("tab", { name: "Broadcasts" }).click();
  await expect(page).toHaveURL(/\/app\/sms-inbox\?tab=broadcasts$/u);
  await expect(
    page.getByText(
      "SMS broadcast dispatch is release-held while durable provider reconciliation and budget settlement are unavailable.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Send now" })).toBeDisabled();
  await page
    .getByRole("button", {
      name: "Show delivery progress for Synthetic service update",
    })
    .click();
  await expect(page).toHaveURL(
    new RegExp(
      `/app/sms-inbox\\?tab=broadcasts&overlay=sms-broadcast-progress&overlayId=${BROADCAST_SENDING_ID}$`,
      "u",
    ),
  );
  await expect(page.getByText("Accepted by provider")).toBeVisible();
  await expect(page.getByText("17", { exact: true })).toBeVisible();
  await assertNoCriticalA11yViolations(page);
  await capture(
    page,
    "broadcasts-held-progress-1440.png",
    "dispatch held with provider-accepted progress",
  );

  await page.goBack();
  await expect(page).toHaveURL(/\/app\/sms-inbox\?tab=broadcasts$/u);
  await expect(page.getByRole("heading", { name: "Broadcasts" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/app\/sms-inbox$/u);
  await expect(
    page.getByRole("heading", { name: "Pick a conversation" }),
  ).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/app\/sms-inbox\?tab=broadcasts$/u);
  await page.goForward();
  await expect(page).toHaveURL(
    new RegExp(
      `/app/sms-inbox\\?tab=broadcasts&overlay=sms-broadcast-progress&overlayId=${BROADCAST_SENDING_ID}$`,
      "u",
    ),
  );
  await page.goBack();
  await page.goBack();
  await expect(
    page.getByRole("heading", { name: "Pick a conversation" }),
  ).toBeVisible();

  await page.locator(".sms-inbox-row-open").nth(1).click();
  await expect(page.locator(".sms-bubble")).toHaveCount(1);
  await page.setViewportSize({ width: 720, height: 900 });
  await assertNoHorizontalOverflow(page);
  await capture(page, "inbox-thread-720.png", "tablet thread reflow");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "← Conversations" }).click();
  await expect(page.locator(".sms-inbox-row-open")).toHaveCount(3);
  await assertNoHorizontalOverflow(page);
  await capture(page, "inbox-list-390.png", "mobile master list");
  await page.locator(".sms-inbox-row-open").nth(1).click();
  await expect(page.locator(".sms-bubble")).toHaveCount(1);
  await assertNoHorizontalOverflow(page);
  await capture(
    page,
    "inbox-hostile-unicode-390.png",
    "mobile hostile Unicode thread",
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 720 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await assertNoHorizontalOverflow(page);
  expect(
    await page
      .locator(".sms-message-text")
      .last()
      .evaluate((node) => ({
        bidi: getComputedStyle(node).unicodeBidi,
        wrap: getComputedStyle(node).overflowWrap,
        whiteSpace: getComputedStyle(node).whiteSpace,
      })),
  ).toEqual({ bidi: "plaintext", wrap: "anywhere", whiteSpace: "pre-wrap" });
  await capture(
    page,
    "inbox-thread-320-text-200.png",
    "320px thread at 200 percent text and reduced motion",
  );

  await page.evaluate(() => {
    document.documentElement.style.removeProperty("font-size");
  });
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoHorizontalOverflow(page);
  await capture(
    page,
    "inbox-thread-forced-colors-390.png",
    "forced colors and reduced motion",
  );

  expect(harness.sendWrites).toEqual([]);
  expect(harness.pageErrors).toEqual([]);
  expect(harness.consoleErrors).toEqual([]);
});

test("viewer boundary starts zero protected SMS requests and normalizes history", async ({
  bootApp,
  page,
  setTheme,
}) => {
  await bootApp(page);
  await setTheme(page, "light");
  const harness = await installHarness(page, "viewer");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(
    `/app/sms-inbox?tab=broadcasts&overlay=sms-broadcast-progress&overlayId=${BROADCAST_SENDING_ID}`,
  );
  await waitForPrimaryNavigation(page);
  await expect(
    page.getByRole("heading", {
      name: "Your current role cannot open SMS conversations",
    }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/app\/sms-inbox$/u);
  await assertNoCriticalA11yViolations(page);
  await assertNoHorizontalOverflow(page);
  await capture(
    page,
    "inbox-viewer-boundary-390.png",
    "viewer access boundary",
  );
  expect(harness.protectedRequests).toEqual([]);
  expect(harness.sendWrites).toEqual([]);
  expect(harness.pageErrors).toEqual([]);
  expect(harness.consoleErrors).toEqual([]);
});
