import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import type { ConsoleMessage, Download, Page, Route } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const EVIDENCE_DIR = resolve(
  process.cwd(),
  "test-results",
  "mcp-99p9-evidence",
);
const TENANT_ID = "mcp-qualification-tenant";
const HOUR_MS = 3_600_000;
const QUALIFICATION_NOW = Date.parse("2026-08-20T12:00:00.000Z");

test.use({ locale: "en-US", timezoneId: "UTC" });

type HarnessMode = "ready" | "partial";
type HarnessRole = "admin" | "viewer";

interface McpHarness {
  apiKeyRequests: string[];
  downloads: Download[];
  mcpMutations: string[];
  mcpRequests: string[];
  pageErrors: string[];
  severeConsole: string[];
  streamTokenRequests: string[];
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "cache-control": "no-store",
      "x-postwave-context-epoch": "mcp-qualification-epoch-1",
    },
    body: JSON.stringify(body),
  });
}

function windowHours(url: URL): number {
  const value = url.searchParams.get("window");
  if (value === "24h") return 24;
  if (value === "30d") return 720;
  return 168;
}

function trend(hours: number): Array<{ bucket: string; calls: number }> {
  const currentHour = Math.floor(QUALIFICATION_NOW / HOUR_MS) * HOUR_MS;
  const start = currentHour - hours * HOUR_MS;
  return Array.from({ length: hours + 1 }, (_, index) => ({
    bucket: new Date(start + index * HOUR_MS).toISOString(),
    calls: index > hours - 5 ? ([2, 4, 1, 3, 2][index - (hours - 4)] ?? 0) : 0,
  }));
}

function stats(hours: number): Record<string, unknown> {
  return {
    tenantId: TENANT_ID,
    windowHours: hours,
    totalCalls: 12,
    successfulCalls: 10,
    successRate: 10 / 12,
    averageLatencyMs: 42.5,
    p95LatencyMs: 118,
    lastCallAt: new Date(QUALIFICATION_NOW - 60_000).toISOString(),
    topTools: [
      { toolName: "subscribers_list", calls: 7 },
      { toolName: "campaigns_report", calls: 3 },
    ],
    topApiKeys: [
      {
        apiKeyId: "qualification-key-a",
        apiKeyPrefix: "pw_live_a1",
        calls: 8,
      },
      {
        apiKeyId: "qualification-key-b",
        apiKeyPrefix: "pw_live_b2",
        calls: 4,
      },
    ],
    statusBreakdown: [
      { class: 2, calls: 9 },
      { class: 3, calls: 1 },
      { class: 4, calls: 1 },
      { class: 5, calls: 1 },
    ],
    totalCostMicros: 18_240,
  };
}

function executionRows(): Array<Record<string, unknown>> {
  return [
    {
      id: 104,
      tenantId: TENANT_ID,
      apiKeyId: "qualification-key-a",
      apiKeyPrefix: "pw_live_a1",
      method: "POST",
      path: "/api/v1/subscribers/import",
      queryString: "key_count=2",
      toolName: "subscribers_import",
      statusCode: 202,
      latencyMs: 47,
      userAgent: "postwave-mcp-server/0.1.0",
      remoteIp: "203.0.113.77",
      requestBody: {
        _summary: true,
        type: "object",
        key_count: 3,
        _truncated: false,
      },
      dryRun: true,
      dryRunAsserted: true,
      costMicros: 1_800,
      calledAt: new Date(QUALIFICATION_NOW - 60_000).toISOString(),
    },
    {
      id: 103,
      tenantId: TENANT_ID,
      apiKeyId: "qualification-key-b",
      apiKeyPrefix: "pw_live_b2",
      method: "GET",
      path: "/api/v1/campaigns/report",
      toolName: "campaigns_report",
      statusCode: 200,
      latencyMs: 29,
      userAgent: "postwave-mcp-server/0.1.0",
      dryRun: false,
      dryRunAsserted: false,
      costMicros: 420,
      calledAt: new Date(QUALIFICATION_NOW - 120_000).toISOString(),
    },
  ];
}

async function installBrowserInstrumentation(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // The shared visual bootstrap retains a legacy plaintext API key so
    // older surfaces can exercise their API-key shell. Route39 is qualified
    // against the cookie/session path instead: carrying that key into this
    // matrix would make the app probe the canonical key lifecycle before the
    // held MCP surface mounts and would confound the zero-provisioning proof.
    window.localStorage.removeItem("postwave_api_key");
    const visualWindow = window as typeof window & {
      __mcpClipboardWrites?: number;
      __mcpEventSourceUrls?: string[];
      __mcpEventSourceCloses?: number;
    };
    visualWindow.__mcpClipboardWrites = 0;
    visualWindow.__mcpEventSourceUrls = [];
    visualWindow.__mcpEventSourceCloses = 0;
    Date.now = () => Date.parse("2026-08-20T12:00:00.000Z");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          visualWindow.__mcpClipboardWrites =
            (visualWindow.__mcpClipboardWrites ?? 0) + 1;
        },
      },
    });

    class TerminalEventSource extends EventTarget {
      static readonly CLOSED = 2;
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      readonly CLOSED = 2;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly url: string;
      readonly withCredentials = true;
      readyState = 0;
      onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
      onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null =
        null;
      onopen: ((this: EventSource, ev: Event) => unknown) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        if (
          new URL(this.url, window.location.href).pathname.includes("/mcp/")
        ) {
          visualWindow.__mcpEventSourceUrls?.push(this.url);
        }
        window.setTimeout(() => {
          if (this.readyState === this.CLOSED) return;
          this.dispatchEvent(
            new MessageEvent("closed", {
              data: JSON.stringify({
                reason: "credential_expired",
              }),
            }),
          );
        }, 20);
      }

      close(): void {
        if (this.readyState === this.CLOSED) return;
        this.readyState = this.CLOSED;
        visualWindow.__mcpEventSourceCloses =
          (visualWindow.__mcpEventSourceCloses ?? 0) + 1;
      }
    }

    Object.defineProperty(window, "EventSource", {
      configurable: true,
      value: TerminalEventSource,
    });
  });
}

async function installNativeSessionBroker(
  page: Page,
  role: HarnessRole,
): Promise<void> {
  await page.addInitScript(
    ({ activeRole, tenantId }) => {
      const install = (): void => {
        const target = window as typeof window & {
          __TAURI_INTERNALS__?: {
            invoke: (
              command: string,
              args?: Record<string, unknown>,
            ) => Promise<unknown>;
            __mcpRoute39SessionBroker?: boolean;
            [key: string]: unknown;
          };
        };
        const current = target.__TAURI_INTERNALS__;
        if (!current) {
          queueMicrotask(install);
          return;
        }
        if (current.__mcpRoute39SessionBroker) return;

        const originalInvoke = current.invoke.bind(current);
        Object.defineProperty(target, "__TAURI_INTERNALS__", {
          configurable: true,
          writable: false,
          value: {
            ...current,
            __mcpRoute39SessionBroker: true,
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
                          user_id: `mcp-${activeRole}`,
                          tenant_id: tenantId,
                          email: `${activeRole}@mcp.example.invalid`,
                          role: activeRole,
                          effective_role: activeRole,
                          auth_provider: "password",
                          email_verified: true,
                          workspace_name: "MCP qualification",
                          workspace_slug: tenantId,
                        }),
                        {
                          status: 200,
                          headers: {
                            "content-type": "application/json",
                            "x-postwave-context-epoch": "mcp-visual-epoch-1",
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
    { activeRole: role, tenantId: TENANT_ID },
  );
}

async function installMcpHarness(
  page: Page,
  options: { mode?: HarnessMode; role?: HarnessRole } = {},
): Promise<McpHarness> {
  const mode = options.mode ?? "ready";
  const role = options.role ?? "admin";
  const apiKeyRequests: string[] = [];
  const downloads: Download[] = [];
  const mcpMutations: string[] = [];
  const mcpRequests: string[] = [];
  const pageErrors: string[] = [];
  const severeConsole: string[] = [];
  const streamTokenRequests: string[] = [];

  page.on("download", (download) => downloads.push(download));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") severeConsole.push(message.text());
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();

    if (pathname === "/api/health" || pathname === "/api/v1/health") {
      await json(route, { status: "ok", service: "api", version: "visual" });
      return;
    }

    if (pathname === "/api/v1/auth/me") {
      await json(route, {
        user_id: `mcp-${role}`,
        tenant_id: TENANT_ID,
        email: `${role}@mcp.example.invalid`,
        role,
        effective_role: role,
        auth_provider: "password",
        email_verified: true,
        workspace_name: "MCP qualification",
        workspace_slug: TENANT_ID,
      });
      return;
    }

    if (pathname.startsWith("/api/v1/api-keys")) {
      apiKeyRequests.push(`${method} ${pathname}`);
      await json(route, { error: { code: "release_held" } }, 503);
      return;
    }

    if (pathname === "/api/v1/streams/token") {
      streamTokenRequests.push(`${method} ${pathname}`);
      await json(route, { token: "visual-short-lived-token", ttl_seconds: 30 });
      return;
    }

    if (!pathname.startsWith("/api/v1/mcp/")) {
      await route.fallback();
      return;
    }

    mcpRequests.push(`${method} ${pathname}${url.search}`);
    if (method !== "GET") mcpMutations.push(`${method} ${pathname}`);
    if (role !== "admin") {
      await json(route, { error: { code: "forbidden" } }, 403);
      return;
    }
    if (pathname === "/api/v1/mcp/catalog") {
      await json(route, [
        {
          name: "subscribers_list",
          category: "Subscribers",
          description: "List bounded subscriber profile summaries.",
        },
        {
          name: "subscribers_import",
          category: "Subscribers",
          description: "Candidate bulk-import operation with side effects.",
        },
        {
          name: "campaigns_report",
          category: "Campaigns",
          description: "Read a retained campaign delivery report.",
        },
        {
          name: "campaigns_send",
          category: "Campaigns",
          description:
            "Candidate send operation; metadata is not authorization.",
        },
        {
          name: "sequences_list",
          category: "Sequences",
          description: "List lifecycle sequence definitions.",
        },
      ]);
      return;
    }
    const hours = windowHours(url);
    if (pathname === "/api/v1/mcp/stats") {
      const payload = stats(hours);
      if (mode === "partial") payload.successfulCalls = 99;
      await json(route, payload);
      return;
    }
    if (pathname === "/api/v1/mcp/trend") {
      await json(route, {
        tenantId: TENANT_ID,
        windowHours: hours,
        points: trend(hours),
      });
      return;
    }
    if (pathname === "/api/v1/mcp/quotas") {
      await json(route, {
        tenantId: TENANT_ID,
        quotas: [
          {
            toolName: "subscribers_import",
            dailyLimit: 100,
            estimatedCostMicros: 1_800,
            usedToday: 73,
          },
          {
            toolName: "campaigns_send",
            dailyLimit: 20,
            estimatedCostMicros: 4_200,
            usedToday: 19,
          },
        ],
        enforcementMode: "advisory_unverified",
        authoritative: false,
        releaseHold: "mcp_quota_enforcement_release_held",
      });
      return;
    }
    if (pathname === "/api/v1/mcp/executions") {
      await json(route, {
        tenantId: TENANT_ID,
        rows: executionRows(),
        detailPolicy: "minimized_v1",
        evidenceClass: "best_effort_observability",
      });
      return;
    }

    await json(route, { error: { code: "unexpected_mcp_route" } }, 404);
  });

  return {
    apiKeyRequests,
    downloads,
    mcpMutations,
    mcpRequests,
    pageErrors,
    severeConsole,
    streamTokenRequests,
  };
}

async function openMcp(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
  setTheme: (page: Page, theme: "system" | "dark" | "light") => Promise<void>,
  options: {
    height?: number;
    mode?: HarnessMode;
    motion?: "no-preference" | "reduce";
    role?: HarnessRole;
    tab?: "setup" | "tools" | "history";
    theme?: "dark" | "light";
    urlSuffix?: string;
    width?: number;
  } = {},
): Promise<McpHarness> {
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 1_000,
  });
  await page.emulateMedia({
    reducedMotion: options.motion ?? "no-preference",
  });
  await setTheme(page, options.theme ?? "dark");
  await bootApp(page);
  await installBrowserInstrumentation(page);
  await installNativeSessionBroker(page, options.role ?? "admin");
  const harness = await installMcpHarness(page, options);
  const tab = options.tab ?? "setup";
  await page.goto(`/app/mcp?tab=${tab}${options.urlSuffix ?? ""}`);
  await waitForPrimaryNavigation(page);
  if (options.role === "viewer") {
    await expect(page.locator(".capability-gate")).toBeVisible();
  } else {
    await expect(
      page.getByRole("heading", {
        name: "Model Context Protocol",
        exact: true,
      }),
    ).toBeVisible();
  }
  return harness;
}

async function axeViolations(page: Page, root = ".mcp-page") {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(
    async ({ selector }) => {
      const axe = (
        window as typeof window & {
          axe: {
            run: (
              context: string,
              options: unknown,
            ) => Promise<{
              violations: Array<{ impact: string | null; id: string }>;
            }>;
          };
        }
      ).axe;
      const result = await axe.run(selector, {
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
      return result.violations.filter(
        (violation) =>
          violation.impact === "serious" || violation.impact === "critical",
      );
    },
    { selector: root },
  );
}

async function resetContentScroll(page: Page): Promise<void> {
  await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    if (content) content.scrollTop = 0;
  });
}

async function capture(page: Page, name: string): Promise<void> {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: resolve(EVIDENCE_DIR, `${name}.png`) });
}

async function clipboardWrites(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as typeof window & { __mcpClipboardWrites?: number })
        .__mcpClipboardWrites ?? 0,
  );
}

async function liveMotionStyle(page: Page): Promise<{
  animationName: string;
  rowTransitionDuration: string;
}> {
  return page.locator(".mcp-live-state").evaluate((live) => {
    const owner = live as HTMLElement;
    const original = owner.className;
    owner.className = "mcp-live-state tone-live";
    const pulse = owner.querySelector<HTMLElement>(":scope > span");
    const row = document.querySelector<HTMLElement>(".mcp-exec-row");
    const result = {
      animationName: pulse ? getComputedStyle(pulse).animationName : "missing",
      rowTransitionDuration: row
        ? getComputedStyle(row).transitionDuration
        : "missing",
    };
    owner.className = original;
    return result;
  });
}

async function executionCardGeometry(page: Page): Promise<{
  labels: string[];
  overlaps: string[];
  overflow: number;
  desktopHeaderArea: number;
}> {
  return page
    .locator(".mcp-exec-row")
    .first()
    .evaluate((row) => {
      const cells = Array.from(
        row.querySelectorAll<HTMLElement>(":scope > td"),
      );
      const overlaps: string[] = [];
      for (let leftIndex = 0; leftIndex < cells.length; leftIndex += 1) {
        const left = cells[leftIndex]!.getBoundingClientRect();
        for (
          let rightIndex = leftIndex + 1;
          rightIndex < cells.length;
          rightIndex += 1
        ) {
          const right = cells[rightIndex]!.getBoundingClientRect();
          const intersectionWidth =
            Math.min(left.right, right.right) - Math.max(left.left, right.left);
          const intersectionHeight =
            Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
          if (intersectionWidth > 0.5 && intersectionHeight > 0.5) {
            overlaps.push(`${leftIndex}:${rightIndex}`);
          }
        }
      }
      const head = row.closest("table")?.querySelector("thead");
      const headRect = head?.getBoundingClientRect();
      return {
        labels: cells.map(
          (cell) =>
            cell.querySelector(".mcp-mobile-label")?.textContent?.trim() ?? "",
        ),
        overlaps,
        overflow: Math.max(
          row.scrollWidth - row.clientWidth,
          ...cells.map((cell) => cell.scrollWidth - cell.clientWidth),
        ),
        desktopHeaderArea: headRect ? headRect.width * headRect.height : 0,
      };
    });
}

function expectContained(harness: McpHarness): void {
  expect(harness.apiKeyRequests).toEqual([]);
  expect(harness.downloads).toEqual([]);
  expect(harness.mcpMutations).toEqual([]);
  expect(harness.pageErrors).toEqual([]);
  expect(harness.severeConsole).toEqual([]);
}

for (const theme of ["dark", "light"] as const) {
  test(`MCP setup is a non-runnable, axe-clean qualification outline in ${theme}`, async ({
    page,
    bootApp,
    setTheme,
  }) => {
    const harness = await openMcp(page, bootApp, setTheme, { theme });
    await expect(
      page.getByRole("heading", {
        name: "Know which execution path you are enabling.",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("Credential excluded", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Non-runnable outline", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /copy configuration/iu }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /save configuration/iu }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /mint|create.*key/iu }),
    ).toHaveCount(0);
    expect(harness.mcpRequests).toEqual([]);
    expect(await clipboardWrites(page)).toBe(0);
    expect(await axeViolations(page)).toEqual([]);
    await capture(page, `setup-${theme}-1440x1000`);

    if (theme === "dark") {
      const setup = page.getByRole("tab", { name: /^01 Setup/iu });
      const tools = page.getByRole("tab", { name: /^02 Tools/iu });
      await setup.focus();
      await page.keyboard.press("ArrowRight");
      await expect(tools).toBeFocused();
      await expect(setup).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");
      await expect(tools).toHaveAttribute("aria-selected", "true");
      await expect(
        page.getByText("campaigns_send", { exact: true }),
      ).toBeVisible();
    }
    expectContained(harness);
  });
}

test("MCP Tools restores filters, preserves Back semantics, and explains catalogue limits", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const harness = await openMcp(page, bootApp, setTheme, {
    tab: "tools",
    theme: "dark",
    urlSuffix: "&q=campaign&f.catalog-category=Campaigns",
  });
  const search = page.getByRole("searchbox", { name: "Search tools" });
  await expect(search).toHaveValue("campaign");
  await expect(page.getByText("campaigns_send", { exact: true })).toBeVisible();
  await expect(page.getByText("subscribers_list", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /^Campaigns 2$/u }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByText("Server-bundled candidate surface", { exact: true }),
  ).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await capture(page, "tools-filtered-dark-1440x1000");

  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(search).toHaveValue("");
  await page.goBack();
  await expect(search).toHaveValue("campaign");
  expect(
    harness.mcpRequests.every((request) => request.startsWith("GET ")),
  ).toBe(true);
  expect(await clipboardWrites(page)).toBe(0);
  expectContained(harness);
});

test("MCP History keeps minimized evidence, export, and replay boundaries explicit", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const harness = await openMcp(page, bootApp, setTheme, {
    tab: "history",
    theme: "dark",
  });
  await expect(
    page.getByRole("heading", {
      name: "Observe what the API-key telemetry recorder retained.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: /recorded telemetry rows/iu }),
  ).toBeVisible();
  await expect(
    page.getByText("No export action is mounted", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /export/iu })).toHaveCount(0);
  const normalMotion = await liveMotionStyle(page);
  expect(normalMotion.animationName).toBe("mcp-live-pulse");
  expect(normalMotion.rowTransitionDuration).not.toBe("0s");
  expect(await axeViolations(page)).toEqual([]);
  await resetContentScroll(page);
  await capture(page, "history-populated-dark-1440x1000");

  const view = page.getByRole("button", { name: "View execution 104 details" });
  await view.focus();
  await view.click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(
    drawer.getByText("Executable replay is release-held"),
  ).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: /replay|curl/iu }),
  ).toHaveCount(0);
  await expect(
    drawer.getByText("Removed before UI retention", { exact: true }),
  ).toBeVisible();
  await expect(
    drawer.getByText("subscriberOpaqueId", { exact: false }),
  ).toHaveCount(0);
  await expect(drawer.getByText("opaque-value", { exact: false })).toHaveCount(
    0,
  );
  await expect(drawer.getByText("203.0.113.77", { exact: false })).toHaveCount(
    0,
  );
  expect(page.url()).toContain("overlay=mcp-execution-detail");
  expect(await axeViolations(page, ".slideover")).toEqual([]);
  await drawer.locator(".slideover-body").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await capture(page, "history-detail-replay-hold-dark-1440x1000");

  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(view).toBeFocused();
  expect(page.url()).not.toContain("overlay=");
  expect(await clipboardWrites(page)).toBe(0);
  expect(harness.mcpRequests).toHaveLength(4);
  expectContained(harness);
});

test("MCP History renders typed live unavailability and partial telemetry honestly", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const harness = await openMcp(page, bootApp, setTheme, {
    tab: "history",
    theme: "light",
    mode: "partial",
    motion: "reduce",
  });
  await expect(
    page.getByText("MCP statistics unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: /recorded telemetry rows/iu }),
  ).toBeVisible();
  await expect(
    page.getByText("Not available", { exact: true }).first(),
  ).toBeVisible();
  const reducedMotion = await liveMotionStyle(page);
  expect(reducedMotion.animationName).toBe("none");
  expect(reducedMotion.rowTransitionDuration).toBe("0s");
  await capture(page, "history-partial-light-1440x1000");

  await page.getByRole("checkbox", { name: /live table updates/iu }).check();
  await expect(
    page.getByText(
      "Live stream is unavailable. Use Refresh for current records.",
    ),
  ).toBeVisible();
  const reconnect = page.getByRole("button", {
    name: "Reconnect live stream",
  });
  await expect(reconnect).toBeVisible();
  await page.locator(".mcp-live-state").scrollIntoViewIfNeeded();
  await capture(page, "history-live-unavailable-light-1440x1000");
  await reconnect.click();
  await expect.poll(() => harness.streamTokenRequests.length).toBe(2);
  expect(harness.streamTokenRequests).toEqual([
    "POST /api/v1/streams/token",
    "POST /api/v1/streams/token",
  ]);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as typeof window & { __mcpEventSourceCloses?: number })
            .__mcpEventSourceCloses ?? 0,
      ),
    )
    .toBeGreaterThanOrEqual(2);
  expect(await axeViolations(page)).toEqual([]);
  expectContained(harness);
});

test.describe("MCP mobile and coarse-pointer evidence", () => {
  test.use({ hasTouch: true });

  test("History reflows without document overflow and exposes 44px targets", async ({
    page,
    bootApp,
    setTheme,
  }) => {
    const harness = await openMcp(page, bootApp, setTheme, {
      tab: "history",
      theme: "dark",
      width: 390,
      height: 844,
    });
    await page
      .getByRole("table", { name: /recorded telemetry rows/iu })
      .scrollIntoViewIfNeeded();
    const mobileCards = await executionCardGeometry(page);
    expect(mobileCards.labels).toEqual([
      "When",
      "Execution ID",
      "Tool identifier",
      "Method · path",
      "API key",
      "Latency",
      "Status",
      "Details",
    ]);
    expect(mobileCards.overlaps).toEqual([]);
    expect(mobileCards.overflow).toBeLessThanOrEqual(1);
    expect(mobileCards.desktopHeaderArea).toBeLessThanOrEqual(1);
    const overflow = await page.evaluate(() => ({
      body: document.body.scrollWidth - window.innerWidth,
      document: document.documentElement.scrollWidth - window.innerWidth,
    }));
    expect(overflow.body).toBeLessThanOrEqual(1);
    expect(overflow.document).toBeLessThanOrEqual(1);
    const undersized = await page.locator(".mcp-page").evaluate((root) =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          "button:not([hidden]), input:not([type='checkbox']), select, .mcp-auto-refresh label",
        ),
      )
        .filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })
        .filter((node) => node.getBoundingClientRect().height < 43.5)
        .map((node) => ({
          height: node.getBoundingClientRect().height,
          text: node.textContent?.trim().slice(0, 80) ?? node.tagName,
        })),
    );
    expect(undersized).toEqual([]);
    expect(await axeViolations(page)).toEqual([]);
    await capture(page, "history-mobile-dark-390x844");

    await page.setViewportSize({ width: 640, height: 700 });
    await page
      .getByRole("table", { name: /recorded telemetry rows/iu })
      .scrollIntoViewIfNeeded();
    const reflowCards = await executionCardGeometry(page);
    expect(reflowCards.labels).toEqual(mobileCards.labels);
    expect(reflowCards.overlaps).toEqual([]);
    expect(reflowCards.overflow).toBeLessThanOrEqual(1);
    expect(reflowCards.desktopHeaderArea).toBeLessThanOrEqual(1);
    const reflow = await page.evaluate(() => ({
      body: document.body.scrollWidth - window.innerWidth,
      document: document.documentElement.scrollWidth - window.innerWidth,
    }));
    expect(reflow.body).toBeLessThanOrEqual(1);
    expect(reflow.document).toBeLessThanOrEqual(1);
    await capture(page, "history-200-percent-reflow-dark-640x700");
    expectContained(harness);
  });

  test("320px forced-colors plus hostile text spacing preserves setup containment", async ({
    page,
    bootApp,
    setTheme,
  }) => {
    const harness = await openMcp(page, bootApp, setTheme, {
      tab: "setup",
      theme: "light",
      motion: "reduce",
      width: 320,
      height: 720,
    });
    await page.emulateMedia({
      forcedColors: "active",
      reducedMotion: "reduce",
    });
    await page.addStyleTag({
      content: `
        .mcp-page, .mcp-page * {
          line-height: 1.5 !important;
          letter-spacing: 0.12em !important;
          word-spacing: 0.16em !important;
        }
        .mcp-page p { margin-bottom: 2em !important; }
      `,
    });
    await expect(
      page.getByRole("heading", {
        name: "Know which execution path you are enabling.",
      }),
    ).toBeVisible();
    const overflow = await page.evaluate(() => ({
      body: document.body.scrollWidth - window.innerWidth,
      document: document.documentElement.scrollWidth - window.innerWidth,
    }));
    expect(overflow.body).toBeLessThanOrEqual(1);
    expect(overflow.document).toBeLessThanOrEqual(1);
    await expect(
      page.getByRole("button", { name: /copy configuration/iu }),
    ).toHaveCount(0);
    expect(await axeViolations(page)).toEqual([]);
    await capture(page, "setup-forced-colors-text-spacing-light-320x720");
    expectContained(harness);
  });
});

test("viewer route entry mounts no MCP request owner", async ({
  page,
  bootApp,
  setTheme,
}) => {
  const harness = await openMcp(page, bootApp, setTheme, {
    role: "viewer",
    tab: "history",
    theme: "light",
  });
  await expect(
    page.getByText("Moosewave has not loaded", { exact: false }),
  ).toBeVisible();
  await page.waitForTimeout(150);
  expect(harness.mcpRequests).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        (
          window as typeof window & {
            __mcpEventSourceUrls?: string[];
          }
        ).__mcpEventSourceUrls ?? [],
    ),
  ).toEqual([]);
  expect(await axeViolations(page, ".capability-gate")).toEqual([]);
  await capture(page, "viewer-access-gate-light-1440x1000");
  expectContained(harness);
});
