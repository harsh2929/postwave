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

export const ROUTE44_FIXED_TIME = "2026-08-29T10:44:00.000Z";
export const ROUTE44_USER_ID = "44444444-4444-4444-8444-444444444444";
export const ROUTE44_TENANT_ID = "44444444-4444-4444-9444-444444444444";
export const PRIVATE_BODY_VALUE = "private-tag-route44";
export const PRIVATE_HEADER_VALUE = "private-header-route44";

type BootApp = (page: Page) => Promise<void>;
type SetTheme = (
  page: Page,
  theme: "system" | "dark" | "light",
) => Promise<void>;

export interface PlaygroundRequestEvidence {
  body: string | null;
  headers: Record<string, string>;
  method: string;
  pathname: string;
  search: string;
}

export interface PlaygroundVisualHarness {
  catalogRequests: PlaygroundRequestEvidence[];
  playgroundRequests: PlaygroundRequestEvidence[];
  unexpectedRequests: PlaygroundRequestEvidence[];
}

interface OpenPlaygroundOptions {
  height?: number;
  theme?: "dark" | "light";
  width?: number;
}

const AUTH_ME = {
  user_id: ROUTE44_USER_ID,
  tenant_id: ROUTE44_TENANT_ID,
  email: "route44.operator@example.invalid",
  role: "admin",
  effective_role: "admin",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Route 44 Evidence Workspace",
  workspace_slug: "route-44-evidence",
} as const;

const JSON_RESPONSE = {
  description: "A bounded JSON response.",
  content: {
    "application/json": {
      schema: { type: "object", additionalProperties: true },
    },
  },
};

type OpenAPIRecord = Record<string, unknown>;

const CANONICAL_OPENAPI = JSON.parse(
  readFileSync(
    new URL("../../../../packages/openapi/openapi.json", import.meta.url),
    "utf8",
  ),
) as OpenAPIRecord;

function openAPIRecord(value: unknown, label: string): OpenAPIRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Route44 visual harness is missing ${label}`);
  }
  return value as OpenAPIRecord;
}

function canonicalPath(
  path: string,
  methods: readonly string[],
): OpenAPIRecord {
  const source = openAPIRecord(
    openAPIRecord(CANONICAL_OPENAPI.paths, "canonical paths")[path],
    path,
  );
  const selected: OpenAPIRecord = {};
  if (source.parameters !== undefined) {
    selected.parameters = structuredClone(source.parameters);
  }
  for (const method of methods) {
    if (source[method] === undefined) {
      throw new Error(`Route44 visual harness is missing ${method} ${path}`);
    }
    selected[method] = structuredClone(source[method]);
  }
  return selected;
}

function relabelCanonicalOperation(
  path: OpenAPIRecord,
  method: string,
  summary: string,
  tag: string,
): void {
  const operation = openAPIRecord(path[method], `${method} operation`);
  // Presentation copy and grouping are intentionally outside the reviewed
  // execution fingerprint. Every transport-relevant field stays byte-for-byte
  // canonical so visual evidence exercises the real allowlist boundary.
  operation.summary = summary;
  operation.tags = [tag];
}

function operation(
  operationId: string,
  summary: string,
  tag: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    operationId,
    summary,
    description: `${summary}. This deterministic Route 44 contract exercises normalized metadata without contacting a live service.`,
    tags: [tag],
    responses: { "200": JSON_RESPONSE },
    "x-required-role": "viewer",
    "x-required-scopes": ["read:reports"],
    "x-required-scope-mode": "all",
    "x-postwave-private-response": true,
    ...overrides,
  };
}

function buildOpenAPICatalog(): Record<string, unknown> {
  const tags = canonicalPath("/api/v1/tags", ["get", "post"]);
  const tag = canonicalPath("/api/v1/tags/{id}", ["patch", "delete"]);
  const tagHistory = canonicalPath("/api/v1/tags/{id}/history", ["get"]);
  const subscriber = canonicalPath("/api/v1/subscribers/{id}", ["get"]);
  relabelCanonicalOperation(
    tags,
    "get",
    "List workspace tags",
    "00 Workspace tags",
  );
  relabelCanonicalOperation(
    tags,
    "post",
    "Create a workspace tag",
    "00 Workspace tags",
  );
  relabelCanonicalOperation(
    tag,
    "patch",
    "Update a workspace tag",
    "00 Workspace tags",
  );
  relabelCanonicalOperation(
    tag,
    "delete",
    "Delete a workspace tag",
    "00 Workspace tags",
  );
  relabelCanonicalOperation(
    tagHistory,
    "get",
    "Inspect tag change history",
    "00 Workspace tags",
  );
  relabelCanonicalOperation(
    subscriber,
    "get",
    "Inspect one subscriber",
    "01 Subscribers",
  );
  const paths: Record<string, unknown> = {
    "/api/v1/tags": tags,
    "/api/v1/tags/{id}": tag,
    "/api/v1/tags/{id}/history": tagHistory,
    "/api/v1/subscribers/{id}": subscriber,
    "/api/v1/exports/release-held": {
      post: operation(
        "createHeldExport",
        "Create release-held export",
        "02 Governance",
        {
          security: [{ bearerAuth: [] }, { sessionCookie: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { format: { type: "string", enum: ["json"] } },
                },
              },
            },
          },
          "x-required-role": "admin",
          "x-required-scopes": ["write:exports", "read:pii"],
          "x-required-scope-mode": "all",
          "x-postwave-release-hold":
            "Production export authority is not yet independently evidenced.",
        },
      ),
    },
    "/api/v1/events/stream": {
      get: operation(
        "streamWorkspaceEvents",
        "Stream workspace events",
        "03 Streaming",
        {
          responses: {
            "200": {
              description: "An event stream.",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
          },
        },
      ),
    },
    "/api/v1/public/track": {
      post: operation(
        "publicTrack",
        "Track a public conversion",
        "04 Public callbacks",
        {
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: true },
              },
            },
          },
        },
      ),
    },
  };

  for (let index = 1; index <= 72; index += 1) {
    const suffix = String(index).padStart(2, "0");
    paths[`/api/v1/reports/route44-${suffix}`] = {
      get: operation(
        `getRoute44Report${suffix}`,
        `Inspect synthetic report ${suffix}`,
        index <= 36 ? "10 Reporting" : "11 Advanced reporting",
        {
          parameters: [
            {
              name: "window",
              in: "query",
              description: "Report window.",
              example: "30d",
              schema: { type: "string", enum: ["7d", "30d", "90d"] },
            },
          ],
        },
      ),
    };
  }

  return {
    ...CANONICAL_OPENAPI,
    info: {
      title: "Moosewave Route 44 Browser Evidence API",
      version: "2026-08-route44",
    },
    paths,
  };
}

function requestEvidence(request: Request): PlaygroundRequestEvidence {
  const url = new URL(request.url());
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers())) {
    headers[name.toLowerCase()] = value;
  }
  return {
    body: request.postData(),
    headers,
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
      "access-control-allow-origin": "http://localhost:1421",
      "access-control-expose-headers":
        "cache-control, content-length, content-type, etag, x-postwave-context-epoch, x-ratelimit-remaining, x-request-id",
      "cache-control": "private, no-store",
      "x-postwave-context-epoch": "route44-browser-evidence-epoch",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function installNativeBoundaries(page: Page): Promise<void> {
  await page.addInitScript((authMe) => {
    const target = window as typeof window & {
      __TAURI_INTERNALS__?: {
        invoke: (
          command: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
        __route44EvidenceBroker?: boolean;
        [key: string]: unknown;
      };
    };
    const current = target.__TAURI_INTERNALS__;
    if (!current || current.__route44EvidenceBroker) return;
    const originalInvoke = current.invoke.bind(current);
    const encryptedVault = new Map<string, string>();
    let vaultSequence = 0;
    Object.defineProperty(target, "__TAURI_INTERNALS__", {
      configurable: true,
      writable: false,
      value: {
        ...current,
        __route44EvidenceBroker: true,
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
                ? new Response(JSON.stringify(authMe), {
                    status: 200,
                    headers: {
                      "cache-control": "private, no-store",
                      "content-type": "application/json",
                    },
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
          if (command === "vault_seal") {
            const plaintext = String(args?.plaintext ?? "");
            vaultSequence += 1;
            const envelope = `route44-encrypted-envelope-${String(vaultSequence)}`;
            encryptedVault.set(envelope, plaintext);
            return envelope;
          }
          if (command === "vault_open") {
            return encryptedVault.get(String(args?.envelope ?? "")) ?? null;
          }
          if (command === "vault_purge_key") {
            encryptedVault.clear();
            return null;
          }
          return originalInvoke(command, args);
        },
      },
    });
  }, AUTH_ME);
}

export async function installPlaygroundHarness(
  page: Page,
): Promise<PlaygroundVisualHarness> {
  const harness: PlaygroundVisualHarness = {
    catalogRequests: [],
    playgroundRequests: [],
    unexpectedRequests: [],
  };
  const catalog = buildOpenAPICatalog();

  await page.route("**/api/**", async (route) => {
    const evidence = requestEvidence(route.request());
    const requestURL = new URL(route.request().url());
    if (
      requestURL.port === "1421" &&
      !requestURL.pathname.startsWith("/api/")
    ) {
      await route.continue();
      return;
    }
    if (evidence.pathname === "/api/v1/openapi.json") {
      harness.catalogRequests.push(evidence);
      await json(route, catalog);
      return;
    }
    if (evidence.pathname === "/api/v1/auth/me") {
      await json(route, AUTH_ME);
      return;
    }
    if (evidence.pathname === "/api/v1/me") {
      await json(route, {
        user: AUTH_ME.user_id,
        tenant: AUTH_ME.tenant_id,
      });
      return;
    }
    if (evidence.pathname === "/api/v1/audit/my-scopes") {
      await json(route, {
        scopes: ["admin", "read:tags", "write:tags"],
        auditScopes: [],
        isAdmin: true,
      });
      return;
    }
    if (evidence.pathname === "/api/v1/streams/token") {
      await json(route, {
        token: "route44-short-lived-stream-token",
        ttl_seconds: 30,
      });
      return;
    }
    if (evidence.pathname === "/api/v1/onboarding/steps") {
      await json(route, {
        step_key: "dashboard_tour",
        state: "dismissed",
      });
      return;
    }
    if (evidence.pathname === "/api/v1/tags") {
      harness.playgroundRequests.push(evidence);
      if (evidence.method === "GET") {
        await json(
          route,
          {
            items: [
              { id: "tag-product", name: "Product", color: "indigo" },
              { id: "tag-priority", name: "Priority", color: "amber" },
              { id: "tag-lifecycle", name: "Lifecycle", color: "emerald" },
            ],
            page: 1,
            per_page: 25,
            total: 3,
          },
          200,
          {
            etag: '"route44-tags-v3"',
            "x-request-id": "route44-read-request",
            "x-ratelimit-remaining": "997",
          },
        );
        return;
      }
      if (evidence.method === "POST") {
        await json(
          route,
          {
            id: "tag-route44-created",
            name: "Created by reviewed browser evidence",
            created: true,
          },
          201,
          {
            etag: '"route44-created-v1"',
            "x-request-id": "route44-mutation-request",
          },
        );
        return;
      }
      harness.unexpectedRequests.push(evidence);
      await json(route, { error: { code: "unexpected_tag_method" } }, 405);
      return;
    }
    if (/^\/api\/v1\/tags\/[^/]+$/u.test(evidence.pathname)) {
      harness.playgroundRequests.push(evidence);
      if (evidence.method === "DELETE") {
        await route.fulfill({
          status: 204,
          headers: {
            "cache-control": "private, no-store",
            "x-postwave-context-epoch": "route44-browser-evidence-epoch",
            "x-request-id": "route44-delete-request",
          },
          body: "",
        });
        return;
      }
      if (evidence.method === "PATCH") {
        await json(route, { updated: true });
        return;
      }
      harness.unexpectedRequests.push(evidence);
      await json(route, { error: { code: "unexpected_tag_method" } }, 405);
      return;
    }
    if (
      evidence.pathname.startsWith("/api/v1/reports/") ||
      evidence.pathname === "/api/v1/subscribers/subscriber-route44-visible" ||
      evidence.pathname === "/api/v1/tags/tag-route44-visible/history"
    ) {
      harness.playgroundRequests.push(evidence);
      await json(route, { items: [], total: 0 });
      return;
    }

    await route.fallback();
  });

  return harness;
}

export async function openAPIPlayground(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  options: OpenPlaygroundOptions = {},
): Promise<PlaygroundVisualHarness> {
  const startupErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") startupErrors.push(message.text());
  });
  page.on("pageerror", (error) => startupErrors.push(error.message));
  await setTheme(page, options.theme ?? "light");
  await page.setViewportSize({
    width: options.width ?? 1440,
    height: options.height ?? 960,
  });
  await page.clock.setFixedTime(new Date(ROUTE44_FIXED_TIME));
  await bootApp(page);
  await installNativeBoundaries(page);
  const harness = await installPlaygroundHarness(page);
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "postwave_onboarding_dismissed_at:44444444-4444-4444-9444-444444444444",
      "2026-08-29T10:44:00.000Z",
    );
    window.sessionStorage.setItem(
      "postwave_session_user",
      JSON.stringify({
        user_id: "44444444-4444-4444-8444-444444444444",
        tenant_id: "44444444-4444-4444-9444-444444444444",
        role: "admin",
        effective_role: "admin",
        auth_provider: "password",
      }),
    );
  });

  await page.goto("/app/api-playground");
  try {
    if (startupErrors.length > 0) {
      throw new Error(startupErrors.join(" | "));
    }
    await Promise.race([
      waitForPrimaryNavigation(page, 60_000),
      new Promise<never>((_resolve, reject) => {
        page.once("pageerror", (error) => reject(error));
      }),
    ]);
  } catch (error) {
    throw new Error(
      `API Playground shell did not become ready. Renderer errors: ${startupErrors.join(" | ") || "none captured"}`,
      { cause: error },
    );
  }
  await expect(
    page.getByRole("heading", { name: "API Playground", exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page.getByLabel("Catalog status")).toContainText(
    "Moosewave Route 44 Browser Evidence API",
    { timeout: 20_000 },
  );
  await expect(page.getByLabel("Endpoint catalog")).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByLabel("Request workbench")).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(() => harness.catalogRequests.length).toBe(1);
  return harness;
}

export async function seriousPlaygroundAxeViolations(
  page: Page,
): Promise<unknown[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async () => {
    const axe = (
      window as typeof window & {
        axe: {
          run: (
            root: Element,
            options: {
              runOnly: { type: "tag"; values: string[] };
              rules: Record<string, { enabled: boolean }>;
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
    const root = document.querySelector<HTMLElement>(".api-playground-page");
    if (!root) throw new Error("API Playground axe root is missing.");
    const result = await axe.run(root, {
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
      rules: { region: { enabled: false } },
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
  });
}

export async function expectNoPlaygroundOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const route = document.querySelector<HTMLElement>(".api-playground-page");
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

export async function savePlaygroundEvidence(
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
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
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

export function expectHarnessClean(harness: PlaygroundVisualHarness): void {
  expect(harness.unexpectedRequests).toEqual([]);
}

export function observePlaygroundRenderer(page: Page): {
  expectClean: () => void;
} {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  return {
    expectClean: () => {
      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    },
  };
}
