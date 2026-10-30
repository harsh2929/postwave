import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type {
  ConsoleMessage,
  Page,
  Request,
  Route,
  TestInfo,
} from "@playwright/test";
import { expect } from "@playwright/test";

import { waitForPrimaryNavigation } from "../visual/fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export const DATA_PLATFORM_FIXED_TIME = "2026-08-10T09:30:00.000Z";
export const DATA_PLATFORM_TENANT_ID = "34000000-0000-4000-8000-000000000001";
export const DATA_PLATFORM_SECRET_CANARY =
  "pw_live_data_platform_secret_must_never_render";
export const PRIMARY_CONNECTION_ID = "wh-34000000-primary";
export const STREAMING_CONNECTION_ID = "wh-34000000-streaming";
export const CUSTOM_OBJECT_TYPE_ID = "cot-34000000-order";

export type DataPlatformRole = "admin" | "viewer";
export type EndpointMode = "success" | "error" | "deferred";

export interface DataPlatformRequestEvidence {
  body: string | null;
  method: string;
  pathname: string;
  search: string;
}

interface DeferredGate {
  promise: Promise<void>;
  release: () => void;
}

export interface DataPlatformHarness {
  adminRequestsFromViewer: string[];
  blockedExternalRequests: string[];
  expectedHttpFailures: string[];
  requests: DataPlatformRequestEvidence[];
  runtimeErrors: string[];
  unexpectedRequests: string[];
  releaseEndpoint: (
    pathname: string,
    nextMode?: EndpointMode,
    method?: string,
  ) => void;
  setEndpointMode: (
    pathname: string,
    mode: EndpointMode,
    method?: string,
  ) => void;
  setEndpointPayload: (
    pathname: string,
    payload: unknown,
    method?: string,
  ) => void;
}

type BootApp = (page: Page) => Promise<void>;
type SetTheme = (
  page: Page,
  theme: "system" | "dark" | "light",
) => Promise<void>;

export interface OpenDataPlatformOptions {
  height?: number;
  initialModes?: Partial<Record<string, EndpointMode>>;
  payloads?: Partial<Record<string, unknown>>;
  role?: DataPlatformRole;
  theme?: "system" | "dark" | "light";
  width?: number;
}

const AUTH_PATH = "/api/v1/auth/me";
const HEALTH_PATH = "/api/health";
const CATALOG_PATH = "/api/v1/warehouse/catalog";
const CONNECTIONS_PATH = "/api/v1/warehouse/connections";
const RUNS_PATH = "/api/v1/warehouse/runs";
const CUSTOM_TYPES_PATH = "/api/v1/custom-objects/types";
const TRANSFORM_OPS_PATH = "/api/v1/cdp/transforms/ops";
const TRANSFORM_PREVIEW_PATH = "/api/v1/cdp/transforms/preview";

export const DATA_PLATFORM_PATHS = {
  auth: AUTH_PATH,
  catalog: CATALOG_PATH,
  connections: CONNECTIONS_PATH,
  customTypes: CUSTOM_TYPES_PATH,
  health: HEALTH_PATH,
  runs: RUNS_PATH,
  transformOps: TRANSFORM_OPS_PATH,
  transformPreview: TRANSFORM_PREVIEW_PATH,
} as const;

const CATALOG = {
  schema_version: "2026-08-data-platform-evidence",
  providers: [
    {
      key: "snowflake",
      label: "Snowflake",
      runtime_status: "available",
      auth_mode: "credentials_reference",
      managed: true,
      capabilities: ["export", "import", "provider_check"],
    },
    {
      key: "bigquery",
      label: "BigQuery",
      runtime_status: "delegated",
      auth_mode: "credentials_reference",
      managed: false,
      capabilities: ["manifest_export"],
    },
    {
      key: "azure_synapse",
      label: "Azure Synapse",
      runtime_status: "planned",
      auth_mode: "not_available",
      managed: false,
      capabilities: [],
    },
  ],
  directions: ["export", "import", "bidirectional"],
  cadences: ["manual", "hourly", "daily", "weekly"],
  objects: [
    { key: "subscribers", label: "Subscribers", runtime_status: "available" },
    { key: "events", label: "Events", runtime_status: "partial" },
  ],
  import_targets: [
    { key: "profiles", label: "Profiles", runtime_status: "available" },
    { key: "events", label: "Events", runtime_status: "available" },
  ],
  workers: [
    {
      key: "warehouse_scheduler",
      label: "Warehouse scheduler",
      runtime_status: "available",
    },
    {
      key: "streaming_export",
      label: "Streaming export worker",
      runtime_status: "partial",
    },
  ],
} as const;

const CONNECTIONS = [
  {
    id: PRIMARY_CONNECTION_ID,
    tenant_id: DATA_PLATFORM_TENANT_ID,
    name: "Customer 360 warehouse",
    provider: "snowflake",
    direction: "bidirectional",
    status: "active",
    credentials_ref: "vault://warehouse/customer-360",
    config: {
      account: "postwave_evidence",
      database: "CUSTOMER_360",
      schema: "PUBLIC",
      warehouse: "POSTWAVE_SYNC",
    },
    object_selection: ["subscribers", "events"],
    cadence: "hourly",
    backfill_days: 30,
    created_at: "2026-07-20T08:00:00.000Z",
    updated_at: "2026-08-10T09:10:00.000Z",
  },
  {
    id: "wh-34000000-paused",
    tenant_id: DATA_PLATFORM_TENANT_ID,
    name: "Finance manifest handoff",
    provider: "bigquery",
    direction: "export",
    status: "paused",
    object_selection: ["subscribers"],
    cadence: "daily",
    backfill_days: 7,
    error: `credential rejected: ${DATA_PLATFORM_SECRET_CANARY}`,
    created_at: "2026-07-22T08:00:00.000Z",
    updated_at: "2026-08-09T14:00:00.000Z",
  },
  {
    id: STREAMING_CONNECTION_ID,
    tenant_id: DATA_PLATFORM_TENANT_ID,
    name: "Lifecycle event batches",
    provider: "streaming_export",
    direction: "export",
    status: "active",
    object_selection: ["events"],
    cadence: "hourly",
    backfill_days: 1,
    config: {
      destination_type: "s3",
      bucket: "postwave-evidence",
      prefix: "lifecycle",
      format: "parquet",
      compression: "snappy",
      batch_size: 5_000,
    },
    created_at: "2026-07-25T08:00:00.000Z",
    updated_at: "2026-08-10T09:00:00.000Z",
  },
] as const;

const WAREHOUSE_RUNS = [
  {
    id: "whr-34000000-completed",
    connection_id: PRIMARY_CONNECTION_ID,
    direction: "export",
    run_mode: "scheduled",
    status: "completed",
    object_selection: ["subscribers", "events"],
    rows_scanned: 4_820,
    rows_exported: 4_818,
    rows_imported: 0,
    rows_failed: 2,
    schema_errors: 2,
    retry_count: 0,
    started_at: "2026-08-10T09:00:00.000Z",
    completed_at: "2026-08-10T09:01:12.000Z",
    created_at: "2026-08-10T09:00:00.000Z",
    updated_at: "2026-08-10T09:01:12.000Z",
  },
  {
    id: "whr-34000000-failed",
    connection_id: "wh-34000000-paused",
    direction: "export",
    run_mode: "manual",
    status: "failed",
    object_selection: ["subscribers"],
    rows_scanned: 0,
    rows_exported: 0,
    rows_imported: 0,
    rows_failed: 0,
    schema_errors: 0,
    retry_count: 2,
    error: `authentication failed with ${DATA_PLATFORM_SECRET_CANARY}`,
    started_at: "2026-08-09T14:00:00.000Z",
    completed_at: "2026-08-09T14:00:03.000Z",
    created_at: "2026-08-09T14:00:00.000Z",
    updated_at: "2026-08-09T14:00:03.000Z",
  },
] as const;

const REVERSE_ETL_MAPPINGS = [
  {
    id: "retl-34000000-plan-tier",
    tenant_id: DATA_PLATFORM_TENANT_ID,
    connection_id: PRIMARY_CONNECTION_ID,
    source_table: "analytics.customer_traits",
    profile_key_column: "email",
    profile_key_target: "email",
    source_column: "plan_tier",
    target_field_key: "warehouse_plan_tier",
    cast_type: "string",
    status: "active",
    last_synced_at: null,
    last_row_count: 0,
    created_at: "2026-08-01T12:00:00.000Z",
    updated_at: "2026-08-01T12:00:00.000Z",
  },
] as const;

const CUSTOM_OBJECT_TYPES = [
  {
    id: CUSTOM_OBJECT_TYPE_ID,
    tenantId: DATA_PLATFORM_TENANT_ID,
    key: "order",
    label: "Orders",
    primaryKey: "external_id",
    schema: {
      type: "object",
      properties: {
        status: { type: "string" },
        total_cents: { type: "number" },
      },
      required: ["status"],
    },
    status: "active",
    createdAt: "2026-07-01T08:00:00.000Z",
    updatedAt: "2026-08-09T08:00:00.000Z",
  },
  {
    id: "cot-34000000-wishlist",
    tenantId: DATA_PLATFORM_TENANT_ID,
    key: "wishlist",
    label: "Wishlists",
    primaryKey: "external_id",
    schema: {},
    status: "deprecated",
    createdAt: "2026-06-01T08:00:00.000Z",
    updatedAt: "2026-08-02T08:00:00.000Z",
  },
] as const;

const CUSTOM_OBJECT_RECORDS = [
  {
    id: "cor-34000000-order-1001",
    tenantId: DATA_PLATFORM_TENANT_ID,
    objectTypeId: CUSTOM_OBJECT_TYPE_ID,
    externalId: "order-1001",
    properties: { status: "completed", total_cents: 12_900 },
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-09T15:30:00.000Z",
  },
] as const;

const TRANSFORM_OPS = ["trim", "lowercase", "uppercase", "regex_replace"];

function endpointKey(pathname: string, method = "GET"): string {
  return `${method.toUpperCase()} ${pathname}`;
}

function deferredGate(): DeferredGate {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function authPayload(role: DataPlatformRole) {
  return {
    user_id: `data-platform-${role}`,
    tenant_id: DATA_PLATFORM_TENANT_ID,
    email: `${role}@data-platform.example.invalid`,
    role,
    effective_role: role,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Data Platform Evidence",
    workspace_slug: "data-platform-evidence",
    can_use_viewer_mode: role === "admin",
  };
}

function requestEvidence(request: Request): DataPlatformRequestEvidence {
  const url = new URL(request.url());
  return {
    body: request.postData(),
    method: request.method(),
    pathname: url.pathname,
    search: url.search,
  };
}

async function json(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
}

function errorBody() {
  return {
    error: {
      code: "data_platform_evidence_unavailable",
      message: "The deterministic Data Platform endpoint is unavailable.",
      request_id: "req-data-platform-evidence",
    },
  };
}

function isOwnedPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/v1/warehouse") ||
    pathname.startsWith("/api/v1/custom-objects") ||
    pathname.startsWith("/api/v1/cdp/transforms")
  );
}

function requiresAdmin(pathname: string, method: string): boolean {
  if (pathname.startsWith("/api/v1/warehouse")) return true;
  if (pathname === TRANSFORM_PREVIEW_PATH) return true;
  return pathname.startsWith("/api/v1/custom-objects") && method !== "GET";
}

function defaultPayload(pathname: string, method: string, request: Request) {
  if (method === "GET" && pathname === CATALOG_PATH) return CATALOG;
  if (method === "GET" && pathname === "/api/v1/warehouse/providers") {
    return {
      items: [
        {
          provider: "snowflake",
          name: "Snowflake",
          auth_mode: "credentials_reference",
          managed: true,
          runtime_status: "available",
          sync_model: "inline",
          verification_mode: "provider_check",
          capabilities: ["export", "import"],
          required_settings: [
            { key: "account", label: "Account", required: true },
            { key: "database", label: "Database", required: true },
            { key: "schema", label: "Schema", required: true },
          ],
          optional_settings: [
            { key: "warehouse", label: "Warehouse", required: false },
          ],
          sync_objects: ["subscribers", "events"],
          docs_url: "https://docs.snowflake.com/",
        },
      ],
    };
  }
  if (method === "GET" && pathname === CONNECTIONS_PATH) {
    return { items: CONNECTIONS };
  }
  if (method === "GET" && pathname === RUNS_PATH) {
    return { items: WAREHOUSE_RUNS };
  }
  if (
    method === "GET" &&
    pathname ===
      `/api/v1/warehouse/connections/${PRIMARY_CONNECTION_ID}/mappings`
  ) {
    return {
      items: [
        {
          id: "wmap-34000000-subscribers",
          connection_id: PRIMARY_CONNECTION_ID,
          source_object: "subscribers",
          target_event_name: "profile.updated",
          profile_key_column: "email",
          occurred_at_column: "updated_at",
          property_map: { plan_tier: "plan_tier" },
          validation_rules: {},
          status: "active",
          created_at: "2026-08-01T08:00:00.000Z",
          updated_at: "2026-08-09T08:00:00.000Z",
        },
      ],
    };
  }
  if (
    method === "GET" &&
    pathname === `/api/v1/warehouse/connections/${PRIMARY_CONNECTION_ID}/health`
  ) {
    return {
      status: "active",
      health: "healthy",
      last_run_status: "completed",
      last_run_at: "2026-08-10T09:01:12.000Z",
      provider_runtime_status: "available",
      provider_driver_attachment: "attached",
      missing_required_settings: [],
      warnings: [],
      provider_health: {
        state: "provider_checked",
        live_state: "healthy",
        execution_mode: "inline",
        executable: true,
        statements_executed: 1,
        missing_required_settings: [],
        warnings: [],
      },
    };
  }
  if (
    method === "GET" &&
    pathname === `/api/v1/warehouse/connections/${PRIMARY_CONNECTION_ID}/runs`
  ) {
    return { items: WAREHOUSE_RUNS.slice(0, 1) };
  }
  if (
    method === "GET" &&
    pathname ===
      `/api/v1/warehouse/connections/${PRIMARY_CONNECTION_ID}/reverse-etl-mappings`
  ) {
    return { items: REVERSE_ETL_MAPPINGS };
  }
  if (
    method === "GET" &&
    pathname ===
      `/api/v1/warehouse/connections/wh-34000000-paused/reverse-etl-mappings`
  ) {
    return { items: [] };
  }
  if (
    method === "GET" &&
    pathname ===
      `/api/v1/warehouse/connections/${STREAMING_CONNECTION_ID}/streaming/runs`
  ) {
    return {
      items: [],
      last_shipped_at: null,
    };
  }
  if (method === "GET" && pathname === CUSTOM_TYPES_PATH) {
    return { items: CUSTOM_OBJECT_TYPES };
  }
  if (
    method === "GET" &&
    pathname === `/api/v1/custom-objects/types/${CUSTOM_OBJECT_TYPE_ID}/records`
  ) {
    return { items: CUSTOM_OBJECT_RECORDS };
  }
  if (method === "GET" && pathname === TRANSFORM_OPS_PATH) {
    return { ops: TRANSFORM_OPS };
  }
  if (method === "POST" && pathname === TRANSFORM_PREVIEW_PATH) {
    const parsed = JSON.parse(request.postData() ?? "{}") as {
      properties?: Record<string, unknown>;
    };
    return {
      properties: {
        ...(parsed.properties ?? {}),
        email: "ada.lovelace@example.com",
      },
      results: [
        {
          op: { type: "trim", field: "email" },
          changed: true,
          old_value: "  Ada.Lovelace@Example.COM ",
          new_value: "Ada.Lovelace@Example.COM",
        },
        {
          op: { type: "lowercase", field: "email" },
          changed: true,
          old_value: "Ada.Lovelace@Example.COM",
          new_value: "ada.lovelace@example.com",
        },
      ],
      success: 2,
      failed: 0,
    };
  }
  return undefined;
}

/**
 * The shared renderer fixture predates the native session broker. Make the
 * broker healthy but bind it to a deliberately different origin, which makes
 * the production client fall back to browser fetch. Playwright can then
 * inspect and fail-close every Data Platform request.
 */
async function installInspectableSessionTransport(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface EvidenceTauriInternals {
      invoke?: (
        command: string,
        args?: Record<string, unknown>,
      ) => Promise<unknown>;
      __dataPlatformEvidenceWrapped?: boolean;
    }

    const wrap = (internals: EvidenceTauriInternals): void => {
      if (internals.__dataPlatformEvidenceWrapped || !internals.invoke) return;
      const fixtureInvoke = internals.invoke.bind(internals);
      internals.invoke = async (command, args) => {
        if (command === "session_broker_initialize") {
          return {
            baseUrl: "https://data-platform-native-disabled.invalid",
          };
        }
        if (
          command === "session_broker_clear" ||
          command === "session_broker_clear_all" ||
          command === "session_broker_cancel"
        ) {
          return null;
        }
        return fixtureInvoke(command, args);
      };
      internals.__dataPlatformEvidenceWrapped = true;
    };

    const nativeDefineProperty = Object.defineProperty;
    const existing = (
      window as Window & { __TAURI_INTERNALS__?: EvidenceTauriInternals }
    ).__TAURI_INTERNALS__;
    if (existing) wrap(existing);
    if (!existing) {
      nativeDefineProperty(Object, "defineProperty", {
        configurable: true,
        value: function defineProperty<T>(
          target: T,
          property: PropertyKey,
          attributes: PropertyDescriptor & ThisType<unknown>,
        ): T {
          if (
            target === window &&
            property === "__TAURI_INTERNALS__" &&
            attributes.value &&
            typeof attributes.value === "object"
          ) {
            wrap(attributes.value as EvidenceTauriInternals);
            nativeDefineProperty(Object, "defineProperty", {
              configurable: true,
              value: nativeDefineProperty,
              writable: true,
            });
          }
          return nativeDefineProperty(target, property, attributes);
        },
        writable: true,
      });
    }
  });
}

export async function installDataPlatformHarness(
  page: Page,
  role: DataPlatformRole,
  options: Pick<OpenDataPlatformOptions, "initialModes" | "payloads"> = {},
): Promise<DataPlatformHarness> {
  const modes = new Map<string, EndpointMode>();
  const payloads = new Map<string, unknown>();
  const gates = new Map<string, DeferredGate[]>();

  for (const [rawKey, mode] of Object.entries(options.initialModes ?? {})) {
    if (!mode) continue;
    modes.set(rawKey.includes(" ") ? rawKey : endpointKey(rawKey), mode);
  }
  for (const [rawKey, payload] of Object.entries(options.payloads ?? {})) {
    payloads.set(rawKey.includes(" ") ? rawKey : endpointKey(rawKey), payload);
  }

  const harness: DataPlatformHarness = {
    adminRequestsFromViewer: [],
    blockedExternalRequests: [],
    expectedHttpFailures: [],
    requests: [],
    runtimeErrors: [],
    unexpectedRequests: [],
    releaseEndpoint(pathname, nextMode = "success", method = "GET") {
      const key = endpointKey(pathname, method);
      modes.set(key, nextMode);
      if (nextMode === "error") harness.expectedHttpFailures.push(pathname);
      for (const gate of gates.get(key) ?? []) gate.release();
      gates.delete(key);
    },
    setEndpointMode(pathname, mode, method = "GET") {
      modes.set(endpointKey(pathname, method), mode);
      if (mode === "error") harness.expectedHttpFailures.push(pathname);
    },
    setEndpointPayload(pathname, payload, method = "GET") {
      payloads.set(endpointKey(pathname, method), payload);
    },
  };

  for (const [key, mode] of modes) {
    if (mode === "error") {
      harness.expectedHttpFailures.push(key.slice(key.indexOf(" ") + 1));
    }
  }

  page.on("pageerror", (error) => harness.runtimeErrors.push(error.message));
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    const location = message.location().url;
    if (
      message.text().startsWith("Failed to load resource:") &&
      location &&
      harness.expectedHttpFailures.includes(new URL(location).pathname)
    ) {
      return;
    }
    harness.runtimeErrors.push(message.text());
  });

  // The shared fixture's broad **/api/** route also matches source module
  // paths. Source-mode evidence must always let Vite serve those modules.
  await page.route("**/src/lib/api/**", async (route) => {
    await route.continue();
  });

  await page.route("**/api/health", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      harness.unexpectedRequests.push(
        `${request.method()} ${HEALTH_PATH} (health is read-only)`,
      );
      await json(route, errorBody(), 405);
      return;
    }
    await json(route, {
      status: "ok",
      version: "0.1.0-data-platform-evidence",
      service: "postwave-api",
    });
  });

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();

    if (pathname === AUTH_PATH) {
      await json(route, authPayload(role));
      return;
    }
    if (pathname === "/api/v1/me") {
      await json(route, {
        user: `${role}@data-platform.example.invalid`,
        tenant: "Data Platform Evidence",
      });
      return;
    }
    if (pathname === "/api/v1/api-keys/me") {
      await json(route, {
        tenant_id: DATA_PLATFORM_TENANT_ID,
        tenant_slug: "data-platform-evidence",
        scopes: role === "admin" ? ["read", "write", "admin"] : ["read"],
        actor: `${role}@data-platform.example.invalid`,
      });
      return;
    }
    if (pathname === "/api/v1/audit/my-scopes") {
      await json(route, {
        scopes: role === "admin" ? ["audit:read", "audit:read_pii"] : [],
        auditScopes: role === "admin" ? ["audit:read", "audit:read_pii"] : [],
        isAdmin: role === "admin",
      });
      return;
    }
    if (!isOwnedPath(pathname)) {
      await route.fallback();
      return;
    }

    const evidence = requestEvidence(request);
    harness.requests.push(evidence);
    if (role === "viewer" && requiresAdmin(pathname, method)) {
      harness.adminRequestsFromViewer.push(`${method} ${pathname}`);
      await json(
        route,
        {
          error: {
            code: "forbidden",
            message: "Administrator access required.",
          },
        },
        403,
      );
      return;
    }

    const key = endpointKey(pathname, method);
    if ((modes.get(key) ?? "success") === "deferred") {
      const gate = deferredGate();
      gates.set(key, [...(gates.get(key) ?? []), gate]);
      await gate.promise;
    }
    if ((modes.get(key) ?? "success") === "error") {
      await json(route, errorBody(), 503);
      return;
    }

    const payload = payloads.has(key)
      ? payloads.get(key)
      : defaultPayload(pathname, method, request);
    if (payload === undefined) {
      harness.unexpectedRequests.push(
        `${method} ${pathname}${url.search} (unmocked Data Platform request)`,
      );
      await json(route, errorBody(), 501);
      return;
    }
    await json(route, payload, method === "POST" ? 200 : 200);
  });

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      await route.fallback();
      return;
    }
    const local =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1";
    if (local) {
      await route.fallback();
      return;
    }
    harness.blockedExternalRequests.push(
      `${route.request().method()} ${url.origin}${url.pathname}`,
    );
    await route.abort("blockedbyclient");
  });

  return harness;
}

export async function openDataPlatform(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  options: OpenDataPlatformOptions = {},
): Promise<DataPlatformHarness> {
  const role = options.role ?? "admin";
  await setTheme(page, options.theme ?? "dark");
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 1_000,
  });
  await bootApp(page);
  await installInspectableSessionTransport(page);
  await page.addInitScript(
    ({ identityRole, tenantId }) => {
      window.sessionStorage.setItem(
        "postwave_session_user",
        JSON.stringify({
          user_id: `data-platform-${identityRole}`,
          tenant_id: tenantId,
          role: identityRole,
          effective_role: identityRole,
          auth_provider: "password",
        }),
      );
      window.localStorage.setItem(
        `postwave_onboarding_dismissed_at:${tenantId}`,
        new Date().toISOString(),
      );
    },
    { identityRole: role, tenantId: DATA_PLATFORM_TENANT_ID },
  );
  await page.clock.setFixedTime(new Date(DATA_PLATFORM_FIXED_TIME));
  const harness = await installDataPlatformHarness(page, role, options);

  await page.goto("/app/data-platform");
  await waitForPrimaryNavigation(page, 30_000);
  await expect(
    page.getByRole("heading", { name: "Data platform", level: 1 }),
  ).toBeVisible();
  await expect(page.locator(".dp-page")).toBeVisible();
  return harness;
}

export async function dataPlatformAxeViolations(
  page: Page,
  selector = ".dp-page",
  options: { disableColorContrast?: boolean } = {},
): Promise<unknown[]> {
  await expect(page.locator(selector)).toBeVisible();
  if (!(await page.evaluate(() => "axe" in window))) {
    await page.addScriptTag({ content: AXE_SOURCE });
  }
  return page.evaluate(
    async ({ disableColorContrast, rootSelector }) => {
      const axe = (
        window as unknown as {
          axe: {
            run: (
              root: Element,
              options: unknown,
            ) => Promise<{
              violations: Array<{
                id: string;
                impact: string | null;
                nodes: Array<{
                  target: string[];
                  failureSummary?: string;
                }>;
              }>;
            }>;
          };
        }
      ).axe;
      const root = document.querySelector(rootSelector);
      if (!root) throw new Error(`Axe root not found: ${rootSelector}`);
      const result = await axe.run(root, {
        resultTypes: ["violations"],
        ...(disableColorContrast
          ? { rules: { "color-contrast": { enabled: false } } }
          : {}),
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
        nodes: violation.nodes.map((node) => ({
          target: node.target,
          failureSummary: node.failureSummary,
        })),
      }));
    },
    {
      disableColorContrast: options.disableColorContrast,
      rootSelector: selector,
    },
  );
}

export async function expectNoDataPlatformOverflow(page: Page): Promise<void> {
  const evidence = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const route = document.querySelector<HTMLElement>(".dp-page");
    const geometry = (element: HTMLElement | null) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        clientWidth: element.clientWidth,
        left: Math.round(rect.left * 100) / 100,
        marginLeft: style.marginLeft,
        marginRight: style.marginRight,
        offsetWidth: element.offsetWidth,
        overflowX: style.overflowX,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        right: Math.round(rect.right * 100) / 100,
        scrollWidth: element.scrollWidth,
        width: Math.round(rect.width * 100) / 100,
      };
    };
    const contentStyle = content ? getComputedStyle(content) : null;
    const intentionalRouteBleed = contentStyle
      ? Math.max(
          Number.parseFloat(contentStyle.paddingLeft) || 0,
          Number.parseFloat(contentStyle.paddingRight) || 0,
        )
      : 0;
    return {
      body: document.body.scrollWidth - window.innerWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
      contentGeometry: geometry(content),
      document: document.documentElement.scrollWidth - window.innerWidth,
      intentionalRouteBleed,
      route: route ? route.scrollWidth - route.clientWidth : 0,
      routeGeometry: geometry(route),
      viewportWidth: window.innerWidth,
    };
  });
  const detail = JSON.stringify(evidence, null, 2);
  expect(evidence.body, detail).toBeLessThanOrEqual(1);
  expect(evidence.content, detail).toBeLessThanOrEqual(1);
  expect(evidence.document, detail).toBeLessThanOrEqual(1);
  // The <=560px tab strip deliberately bleeds into (and no farther than) the
  // shell's inline padding so the horizontal scroller reaches the visual edge.
  // Body/document/.content are the user-scroll authorities; bound the route's
  // internal overflow to that measured gutter instead of treating it as a
  // viewport overflow.
  expect(evidence.route, detail).toBeLessThanOrEqual(
    evidence.intentionalRouteBleed + 1,
  );
}

export async function expectDataPlatformReducedMotion(
  page: Page,
): Promise<void> {
  expect(
    await page.evaluate(
      () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
  ).toBe(true);
  const runningAnimations = await page
    .locator(".dp-page")
    .evaluate(
      (root) =>
        root
          .getAnimations({ subtree: true })
          .filter((animation) => animation.playState === "running").length,
    );
  expect(runningAnimations).toBe(0);
}

export async function captureDataPlatformEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
): Promise<void> {
  await page.evaluate(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    document
      .querySelector<HTMLElement>(".content")
      ?.scrollTo({ top: 0, left: 0, behavior: "auto" });
  });
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

export async function attachDataPlatformJson(
  testInfo: TestInfo,
  name: string,
  value: unknown,
): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
    contentType: "application/json",
  });
}
