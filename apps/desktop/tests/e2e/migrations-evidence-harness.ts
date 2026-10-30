import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ConsoleMessage,
  Locator,
  Page,
  Request,
  Route,
  TestInfo,
} from "@playwright/test";
import { expect } from "@playwright/test";

import type {
  MigrationDiscoveryReport,
  MigrationDoneEvent,
  MigrationJob,
  MigrationProgressEvent,
  MigrationSourceCapability,
  MigrationVerificationReport,
} from "../../src/lib/api-client";
import { waitForPrimaryNavigation } from "../visual/fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const AXE_VERSION = (require("axe-core/package.json") as { version: string })
  .version;
const PLAYWRIGHT_VERSION = (
  require("@playwright/test/package.json") as { version: string }
).version;

export type MigrationsEvidenceMode = "source" | "optimized";
export type MigrationsRole = "admin" | "viewer";
export type MigrationEndpointMode = "success" | "error" | "deferred";

interface DeferredGate {
  promise: Promise<void>;
  release: () => void;
}

interface A11yViolation {
  id: string;
  impact: string | null;
  nodes: Array<{ target: string[]; failureSummary?: string }>;
}

interface A11yRun {
  label: string;
  selector: string;
  violations: A11yViolation[];
}

export interface MigrationRequestEvidence {
  body: string | null;
  method: string;
  order: number;
  pathname: string;
  search: string;
}

export interface MigrationInteractionEvidence {
  action: "click" | "fill" | "press" | "select" | "stream" | "upload";
  detail?: string;
  order: number;
  target: string;
}

export interface MigrationLayoutEvidence {
  bodyOverflow: number;
  contentOverflow: number | null;
  documentOverflow: number;
  label: string;
  rootOverflow: number | null;
  viewport: { height: number; width: number };
  visibleViewportOffenders: Array<{
    bottom: number;
    left: number;
    right: number;
    selector: string;
    top: number;
  }>;
}

export interface MigrationsHarness {
  a11yRuns: A11yRun[];
  assetFailures: string[];
  expectedHttpFailures: string[];
  interactions: MigrationInteractionEvidence[];
  layoutRuns: MigrationLayoutEvidence[];
  maximumConcurrentRequests: Record<string, number>;
  observedHttpFailures: Array<{ pathname: string; status: number }>;
  requests: MigrationRequestEvidence[];
  runtimeErrors: string[];
  unauthorizedAdminRequests: string[];
  unexpectedRequests: string[];
  activeRequestCount: (pathname: string, method?: string) => number;
  emitStream: (
    event: "snapshot" | "progress" | "done" | "error",
    payload: unknown,
  ) => Promise<void>;
  releaseEndpoint: (
    pathname: string,
    nextMode?: MigrationEndpointMode,
    method?: string,
  ) => void;
  setEndpointMode: (
    pathname: string,
    mode: MigrationEndpointMode,
    method?: string,
  ) => void;
  setEndpointPayload: (
    pathname: string,
    payload: unknown,
    method?: string,
  ) => void;
  streamInstanceCount: () => Promise<number>;
}

type BootApp = (page: Page) => Promise<void>;
type SetTheme = (
  page: Page,
  theme: "system" | "dark" | "light",
) => Promise<void>;

function evidenceMode(): MigrationsEvidenceMode {
  const mode = process.env["PW_EVIDENCE_MODE"] ?? "optimized";
  if (mode !== "source" && mode !== "optimized") {
    throw new Error(`Unsupported Migrations evidence mode: ${mode}`);
  }
  return mode;
}

const EVIDENCE_MODE = evidenceMode();
const EVIDENCE_ROOT = fileURLToPath(
  new URL(
    "../../../../.audit-screenshots/migrations-evidence/",
    import.meta.url,
  ),
);
const EVIDENCE_DIR = join(EVIDENCE_ROOT, EVIDENCE_MODE);
const DECLARED_PLAYWRIGHT_TEST_COUNT = 10;
const OPTIMIZED_EVIDENCE_API_ORIGIN =
  "https://migrations-evidence.example.invalid";

export const MIGRATIONS_FIXED_TIME = "2026-08-09T10:00:00.000Z";
export const MIGRATIONS_RANDOM_SEED = 0x32e1_2026;
export const MIGRATIONS_TENANT_ID = "32000000-0000-4000-8000-000000000001";
export const MIGRATIONS_SECRET_CANARY =
  "migration-provider-secret-must-never-render-or-enter-ledgers";
export const MIGRATIONS_CREDENTIAL_SECRET =
  "pk_migrations_evidence_secret_never_persist";
export const MIGRATIONS_RECOVERY_SECRET =
  "beehiiv_migrations_recovery_secret_never_persist";
export const MIGRATION_FIXTURE_IDS = {
  importing: "mig-32000000-importing",
  awaiting: "mig-32000000-awaiting",
  rollingBack: "mig-32000000-rolling-back",
  completed: "mig-32000000-completed",
  cancelled: "mig-32000000-cancelled",
  failed: "mig-32000000-failed",
  rolledBack: "mig-32000000-rolled-back",
  wizard: "mig-32000000-wizard",
} as const;

export const MIGRATION_VERIFICATION_REPORT: MigrationVerificationReport = {
  subscribers_imported: 1_284,
  suppression_list_size: 93,
  custom_fields_mapped: [
    { source: "first_name", canonical: "first_name", type: "string" },
    { source: "plan", canonical: "plan", type: "string" },
  ],
  custom_fields_unmapped: ["provider_only_score"],
  segments_translated: 12,
  segments_with_warnings: [
    {
      name: "High-intent cohort",
      warning: "Frozen membership snapshot; provider predicates do not run.",
    },
  ],
  automations_translated: 0,
  automations_unsupported: [
    {
      name: "Lifecycle branch",
      reason: "Preserved for rebuild review; no source workflow is activated.",
    },
  ],
  archive_imported: 18,
  templates_imported: 7,
  source_archive_imported: 31,
  consent_known: 1_210,
  consent_unknown: 74,
  duplicate_subscribers_merged: 6,
  data_loss_estimate_pct: 2.4,
  discovery_warnings: [
    "Secondary email identities require consent and identity review before cutover.",
  ],
  resource_completeness: [
    {
      resource: "subscribers",
      label: "Primary-email subscribers",
      source_total: 1_284,
      imported: 1_284,
      supported: true,
      status: "imported_runtime",
    },
    {
      resource: "segments",
      label: "List and segment snapshots",
      source_total: 12,
      imported: 12,
      supported: true,
      status: "imported_runtime",
    },
    {
      resource: "campaigns",
      label: "Campaign archive",
      source_total: 18,
      imported: 18,
      supported: true,
      status: "imported_runtime",
    },
    {
      resource: "templates",
      label: "Email templates",
      source_total: 7,
      imported: 7,
      supported: true,
      status: "imported_runtime",
    },
    {
      resource: "automations",
      label: "Flow definitions",
      source_total: 4,
      imported: 4,
      supported: true,
      status: "preserved_for_rebuild",
      notes: [
        "Definitions remain evidence until rebuilt, tested, or retired by an operator.",
      ],
    },
    {
      resource: "source_archive",
      label: "Source-only ecosystem evidence",
      source_total: 31,
      imported: 31,
      supported: true,
      status: "preserved_for_rebuild",
    },
  ],
};

function progress(
  subscribersDone: number,
  subscribersTotal = 1_284,
): NonNullable<MigrationJob["progress"]> {
  return {
    subscribers_done: subscribersDone,
    subscribers_total: subscribersTotal,
    segments_done: Math.min(
      12,
      Math.round((subscribersDone / subscribersTotal) * 12),
    ),
    segments_total: 12,
    automations_done: 0,
    automations_total: 4,
    archive_done: Math.min(
      18,
      Math.round((subscribersDone / subscribersTotal) * 18),
    ),
    archive_total: 18,
    templates_done: Math.min(
      7,
      Math.round((subscribersDone / subscribersTotal) * 7),
    ),
    templates_total: 7,
    source_archive_done: Math.min(
      31,
      Math.round((subscribersDone / subscribersTotal) * 31),
    ),
    source_archive_total: 31,
  };
}

function job(
  id: string,
  source: MigrationJob["source"],
  status: MigrationJob["status"],
  overrides: Partial<MigrationJob> = {},
): MigrationJob {
  return {
    id,
    tenant_id: MIGRATIONS_TENANT_ID,
    source,
    status,
    started_at: "2026-08-09T08:00:00.000Z",
    cursor: { provider_cursor: "redacted-by-production-surface" },
    ...overrides,
  };
}

export const MIGRATION_JOBS: MigrationJob[] = [
  job(MIGRATION_FIXTURE_IDS.importing, "customerio", "importing", {
    started_at: "2026-08-09T09:45:00.000Z",
    source_session_expires_at: "2026-08-09T11:45:00.000Z",
    progress: progress(672),
  }),
  job(MIGRATION_FIXTURE_IDS.awaiting, "mailchimp", "awaiting_confirmation", {
    started_at: "2026-08-09T09:30:00.000Z",
    selected_audience_ids: ["aud-main", "aud-partners"],
    progress: progress(0),
    verification_report: MIGRATION_VERIFICATION_REPORT,
  }),
  job(MIGRATION_FIXTURE_IDS.rollingBack, "activecampaign", "rolling_back", {
    started_at: "2026-08-09T08:45:00.000Z",
    progress: progress(1_284),
  }),
  job(MIGRATION_FIXTURE_IDS.completed, "klaviyo", "completed", {
    started_at: "2026-08-09T07:30:00.000Z",
    completed_at: "2026-08-09T08:30:00.000Z",
    rollback_until: "2026-08-16T08:30:00.000Z",
    source_session_expires_at: "2026-09-30T10:00:00.000Z",
    progress: progress(1_284),
    verification_report: MIGRATION_VERIFICATION_REPORT,
  }),
  job(MIGRATION_FIXTURE_IDS.cancelled, "beehiiv", "failed", {
    started_at: "2026-08-09T06:30:00.000Z",
    progress: progress(411),
    rollback_until: "2026-08-16T06:30:00.000Z",
    source_session_expires_at: "2026-08-09T09:00:00.000Z",
    error: "Migration cancelled by operator at a durable checkpoint.",
  }),
  job(MIGRATION_FIXTURE_IDS.failed, "hubspot", "failed", {
    started_at: "2026-08-09T05:30:00.000Z",
    progress: progress(209),
    error: "Provider request stopped before completion.",
  }),
  job(MIGRATION_FIXTURE_IDS.rolledBack, "csv", "rolled_back", {
    started_at: "2026-08-08T09:00:00.000Z",
    completed_at: "2026-08-08T09:20:00.000Z",
    progress: progress(1_284),
    verification_report: MIGRATION_VERIFICATION_REPORT,
  }),
];

export const MIGRATION_CANCELLED_HEALTHY_JOB = job(
  MIGRATION_FIXTURE_IDS.cancelled,
  "beehiiv",
  "failed",
  {
    started_at: "2026-08-09T06:30:00.000Z",
    progress: progress(411),
    rollback_until: "2026-08-16T06:30:00.000Z",
    source_session_expires_at: "2026-09-30T10:00:00.000Z",
    error: "Migration cancelled by operator at a durable checkpoint.",
  },
);

export const MIGRATION_SOURCE_CAPABILITIES: MigrationSourceCapability[] = [
  {
    source: "mailchimp",
    auth_method: "oauth2",
    intake_available: true,
    commit_available: true,
    supports: {
      subscribers: true,
      segments: true,
      automations: true,
      automation_mode: "rebuild_review",
      campaign_archive: true,
    },
  },
  {
    source: "klaviyo",
    auth_method: "api_key",
    intake_available: true,
    commit_available: true,
    supports: {
      subscribers: true,
      segments: true,
      automations: true,
      automation_mode: "rebuild_review",
      templates: true,
      campaign_archive: true,
    },
  },
  {
    source: "customerio",
    auth_method: "api_key",
    intake_available: true,
    commit_available: true,
    supports: {
      subscribers: true,
      segments: true,
      automations: true,
      automation_mode: "rebuild_review",
      templates: true,
      campaign_archive: true,
      custom_objects: true,
    },
  },
  {
    source: "activecampaign",
    auth_method: "api_key",
    intake_available: true,
    commit_available: true,
    supports: {
      subscribers: true,
      segments: true,
      automations: true,
      automation_mode: "rebuild_review",
      crm: true,
      sms: true,
    },
  },
  {
    source: "hubspot",
    auth_method: "api_key",
    intake_available: true,
    commit_available: true,
    supports: {
      subscribers: true,
      segments: true,
      campaign_archive: true,
      crm: true,
      custom_objects: true,
    },
  },
  {
    source: "convertkit",
    auth_method: "oauth2",
    intake_available: true,
    commit_available: true,
    supports: {
      subscribers: true,
      segments: true,
      automations: true,
      automation_mode: "rebuild_review",
      campaign_archive: true,
      paid_subs: true,
      consent_timestamps: true,
      campaigns: true,
      reports: true,
      groups: true,
    },
  },
  {
    source: "substack",
    auth_method: "csv_upload",
    intake_available: true,
    commit_available: true,
    supports: {
      subscribers: true,
      campaign_archive: true,
      paid_subs: true,
      consent_timestamps: true,
      campaigns: true,
      reports: true,
    },
  },
  {
    source: "beehiiv",
    auth_method: "api_key",
    intake_available: true,
    commit_available: true,
    supports: {
      subscribers: true,
      segments: true,
      automations: true,
      automation_mode: "rebuild_review",
      campaign_archive: true,
      paid_subs: true,
    },
  },
  {
    source: "csv",
    auth_method: "csv_upload",
    intake_available: true,
    commit_available: true,
    supports: { subscribers: true, consent_timestamps: true },
  },
];

export const MIGRATION_DISCOVERY_REPORT: MigrationDiscoveryReport = {
  job_id: MIGRATION_FIXTURE_IDS.wizard,
  source: "klaviyo",
  subscribers_count: 1_284,
  segments_count: 12,
  automations_count: 4,
  archive_count: 18,
  paid_subs_count: 0,
  templates_count: 7,
  source_archive_count: 31,
  warnings: [
    "Cutover still requires a frozen final snapshot and review of preserved evidence.",
  ],
};

export const MIGRATION_WIZARD_READY_JOB = job(
  MIGRATION_FIXTURE_IDS.wizard,
  "klaviyo",
  "awaiting_confirmation",
  {
    started_at: "2026-08-09T09:58:00.000Z",
    rollback_until: "2026-08-16T09:58:00.000Z",
    source_session_expires_at: "2026-09-30T10:00:00.000Z",
    progress: progress(0),
    verification_report: MIGRATION_VERIFICATION_REPORT,
  },
);

export const MIGRATION_WIZARD_IMPORTING_JOB = job(
  MIGRATION_FIXTURE_IDS.wizard,
  "klaviyo",
  "importing",
  {
    started_at: "2026-08-09T09:58:00.000Z",
    rollback_until: "2026-08-16T09:58:00.000Z",
    source_session_expires_at: "2026-09-30T10:00:00.000Z",
    progress: progress(642),
  },
);

export const MIGRATION_WIZARD_COMPLETED_JOB = job(
  MIGRATION_FIXTURE_IDS.wizard,
  "klaviyo",
  "completed",
  {
    started_at: "2026-08-09T09:58:00.000Z",
    completed_at: "2026-08-09T10:00:00.000Z",
    rollback_until: "2026-08-16T09:58:00.000Z",
    source_session_expires_at: "2026-09-30T10:00:00.000Z",
    progress: progress(1_284),
    verification_report: MIGRATION_VERIFICATION_REPORT,
  },
);

function deferredGate(): DeferredGate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function endpointKey(pathname: string, method = "GET"): string {
  return `${method.toUpperCase()} ${pathname}`;
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function authPayload(role: MigrationsRole): Record<string, unknown> {
  return {
    user_id: `migrations-${role}`,
    tenant_id: MIGRATIONS_TENANT_ID,
    email: `${role}@migrations.example.invalid`,
    role,
    effective_role: role,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Migrations Evidence",
    workspace_slug: "migrations-evidence",
  };
}

function redactSensitiveBody(body: string | null): string | null {
  if (body === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return "[NON_JSON_BODY_REDACTED]";
  }
  const redact = (value: unknown, key = ""): unknown => {
    if (
      /(?:api[_-]?key|authorization|credential|password|secret|token|state)/iu.test(
        key,
      )
    ) {
      return "[REDACTED]";
    }
    if (Array.isArray(value)) return value.map((item) => redact(item));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([childKey, childValue]) => [childKey, redact(childValue, childKey)],
        ),
      );
    }
    return value;
  };
  return JSON.stringify(redact(parsed));
}

function requestEvidence(
  request: Request,
  order: number,
): MigrationRequestEvidence {
  const url = new URL(request.url());
  return {
    body: redactSensitiveBody(request.postData()),
    method: request.method(),
    order,
    pathname: url.pathname,
    search: url.search,
  };
}

function isOwnedMigrationPath(pathname: string): boolean {
  return (
    pathname === "/api/v1/streams/token" ||
    pathname === "/api/v1/migrations" ||
    pathname.startsWith("/api/v1/migrations/")
  );
}

function allowedMethod(pathname: string, method: string): boolean {
  if (pathname === "/api/v1/streams/token") return method === "POST";
  if (pathname === "/api/v1/migrations") return method === "GET";
  if (pathname === "/api/v1/migrations/sources") return method === "GET";
  if (
    /^\/api\/v1\/migrations\/[^/]+\/(?:credentials|discover|dry-run|commit)$/u.test(
      pathname,
    )
  ) {
    return method === "POST";
  }
  if (/^\/api\/v1\/migrations\/[^/]+\/verification$/u.test(pathname)) {
    return method === "GET";
  }
  if (
    /^\/api\/v1\/migrations\/[^/]+\/(?:rollback|resume|source-session)$/u.test(
      pathname,
    )
  ) {
    return method === "POST";
  }
  if (/^\/api\/v1\/migrations\/[^/]+$/u.test(pathname)) {
    return method === "GET" || method === "DELETE";
  }
  return false;
}

function requiresAdmin(pathname: string, method: string): boolean {
  if (pathname === "/api/v1/streams/token") return false;
  if (method === "GET") return false;
  return pathname.startsWith("/api/v1/migrations/");
}

function errorBody(): Record<string, unknown> {
  return {
    error: {
      code: "migration_evidence_unavailable",
      message:
        "Migration evidence is temporarily unavailable. Retry verification after the service recovers.",
      details: { diagnostic: MIGRATIONS_SECRET_CANARY },
    },
  };
}

function requestBody(request: Request): Record<string, unknown> {
  const raw = request.postData();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function pathJobId(pathname: string): string | null {
  const match = pathname.match(/^\/api\/v1\/migrations\/([^/]+)/u);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function dynamicPayload(pathname: string, request: Request): unknown {
  const method = request.method();
  const body = requestBody(request);
  const requestedJobId =
    typeof body["job_id"] === "string"
      ? body["job_id"]
      : (pathJobId(pathname) ?? MIGRATION_FIXTURE_IDS.wizard);

  if (pathname === "/api/v1/streams/token" && method === "POST") {
    return { token: "migration-evidence-stream-token", ttl_seconds: 30 };
  }
  if (pathname.endsWith("/credentials") && method === "POST") {
    return {
      job_id: MIGRATION_FIXTURE_IDS.wizard,
      account_id: "acct-redacted",
    };
  }
  if (pathname.endsWith("/discover") && method === "POST") {
    return MIGRATION_DISCOVERY_REPORT;
  }
  if (pathname.endsWith("/dry-run") && method === "POST") {
    return { job_id: requestedJobId };
  }
  if (pathname.endsWith("/commit") && method === "POST") {
    return { job_id: requestedJobId };
  }
  if (pathname.endsWith("/rollback") && method === "POST") {
    return { job_id: requestedJobId, state: "running" };
  }
  if (pathname.endsWith("/resume") && method === "POST") {
    return { job_id: requestedJobId, status: "importing" };
  }
  if (pathname.endsWith("/source-session") && method === "POST") {
    if (requestedJobId === MIGRATION_FIXTURE_IDS.cancelled) {
      return MIGRATION_CANCELLED_HEALTHY_JOB;
    }
    const current = MIGRATION_JOBS.find(
      (candidate) => candidate.id === requestedJobId,
    );
    return current
      ? {
          ...current,
          source_session_expires_at: "2026-09-30T10:00:00.000Z",
        }
      : undefined;
  }
  if (method === "DELETE") {
    return { job_id: requestedJobId, cancelled: true, status: "importing" };
  }
  if (pathname.endsWith("/verification") && method === "GET") {
    return MIGRATION_VERIFICATION_REPORT;
  }
  if (method === "GET") {
    const directId = pathJobId(pathname);
    if (directId === MIGRATION_FIXTURE_IDS.wizard) {
      return MIGRATION_WIZARD_READY_JOB;
    }
    return MIGRATION_JOBS.find((candidate) => candidate.id === directId);
  }
  return undefined;
}

function successStatus(pathname: string, method: string): number {
  if (
    method === "POST" &&
    (pathname.endsWith("/dry-run") ||
      pathname.endsWith("/commit") ||
      pathname.endsWith("/resume"))
  ) {
    return 202;
  }
  if (method === "POST" && pathname.endsWith("/credentials")) return 201;
  return 200;
}

async function installDeterministicEventSource(page: Page): Promise<void> {
  await page.addInitScript((initialRandomSeed: number) => {
    let randomState = initialRandomSeed >>> 0;
    Object.defineProperty(Math, "random", {
      configurable: true,
      value: () => {
        randomState ^= randomState << 13;
        randomState ^= randomState >>> 17;
        randomState ^= randomState << 5;
        return (randomState >>> 0) / 4_294_967_296;
      },
      writable: true,
    });

    interface TauriInternals {
      invoke?: (
        command: string,
        args?: Record<string, unknown>,
      ) => Promise<unknown>;
      __migrationEvidenceWrapped?: boolean;
    }

    const wrapTauriInternals = (tauriInternals: TauriInternals): void => {
      if (
        tauriInternals.__migrationEvidenceWrapped === true ||
        !tauriInternals.invoke
      ) {
        return;
      }
      const fixtureInvoke = tauriInternals.invoke.bind(tauriInternals);
      tauriInternals.invoke = async (command, args) => {
        if (command === "session_broker_initialize") {
          // Keep the native cookie broker structurally healthy without letting
          // it consume renderer HTTP calls. The intentionally different origin
          // makes production's exact-origin check fall back to browser fetch,
          // where Playwright can provide inspectable, fail-closed responses.
          return {
            baseUrl: "https://migrations-evidence-native-disabled.invalid",
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
      tauriInternals.__migrationEvidenceWrapped = true;
    };

    const nativeDefineProperty = Object.defineProperty;
    const existingTauriInternals = (
      window as Window & { __TAURI_INTERNALS__?: TauriInternals }
    ).__TAURI_INTERNALS__;
    if (existingTauriInternals) {
      wrapTauriInternals(existingTauriInternals);
    }

    // The shared visual fixture and this route harness both install page-init
    // scripts, whose relative execution order is intentionally unspecified by
    // Playwright. Intercept the fixture's global definition as well as patching
    // an already-installed object so native transport behavior is deterministic
    // in either order. All unrelated property definitions delegate unchanged.
    if (!existingTauriInternals) {
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
            wrapTauriInternals(attributes.value as TauriInternals);
            // The fixture has now been observed. Restore the native primitive
            // before application code runs so the test changes no other
            // property-definition behavior.
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

    interface EvidenceEventSourceWindow extends Window {
      __migrationEvidenceStreams?: EvidenceEventSource[];
      __migrationEvidenceEmit?: (event: string, payload: unknown) => void;
    }

    class EvidenceEventSource extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 2;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readonly url: string;
      readonly withCredentials = false;
      readyState = EvidenceEventSource.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        const evidenceWindow = window as EvidenceEventSourceWindow;
        evidenceWindow.__migrationEvidenceStreams = [
          ...(evidenceWindow.__migrationEvidenceStreams ?? []),
          this,
        ];
        window.setTimeout(() => {
          if (this.readyState === EvidenceEventSource.CLOSED) return;
          this.readyState = EvidenceEventSource.OPEN;
          const event = new Event("open");
          this.onopen?.(event);
          this.dispatchEvent(event);
        }, 0);
      }

      close(): void {
        this.readyState = EvidenceEventSource.CLOSED;
      }

      emit(eventName: string, payload: unknown): void {
        if (this.readyState === EvidenceEventSource.CLOSED) return;
        const event = new MessageEvent<string>(eventName, {
          data: JSON.stringify(payload),
        });
        if (eventName === "message") this.onmessage?.(event);
        if (eventName === "error") this.onerror?.(event);
        this.dispatchEvent(event);
      }
    }

    const evidenceWindow = window as EvidenceEventSourceWindow;
    evidenceWindow.__migrationEvidenceStreams = [];
    evidenceWindow.__migrationEvidenceEmit = (event, payload) => {
      for (const stream of evidenceWindow.__migrationEvidenceStreams ?? []) {
        stream.emit(event, payload);
      }
    };
    nativeDefineProperty(window, "EventSource", {
      configurable: true,
      get: () => EvidenceEventSource,
      // Ignore the shared visual fixture's static EventSource assignment when
      // its init script happens to execute after this route-specific harness.
      set: () => undefined,
    });
  }, MIGRATIONS_RANDOM_SEED);
}

export async function installMigrationsHarness(
  page: Page,
  role: MigrationsRole,
  initialModes: Partial<Record<string, MigrationEndpointMode>> = {},
): Promise<MigrationsHarness> {
  const endpointModes = new Map<string, MigrationEndpointMode>();
  for (const [key, mode] of Object.entries(initialModes)) {
    if (!mode) continue;
    endpointModes.set(key.includes(" ") ? key : endpointKey(key), mode);
  }
  const payloads = new Map<string, unknown>();
  payloads.set(endpointKey("/api/v1/migrations"), MIGRATION_JOBS);
  payloads.set(
    endpointKey("/api/v1/migrations/sources"),
    MIGRATION_SOURCE_CAPABILITIES,
  );
  const gates = new Map<string, DeferredGate[]>();
  const active = new Map<string, number>();

  const harness: MigrationsHarness = {
    a11yRuns: [],
    assetFailures: [],
    expectedHttpFailures: [],
    interactions: [],
    layoutRuns: [],
    maximumConcurrentRequests: {},
    observedHttpFailures: [],
    requests: [],
    runtimeErrors: [],
    unauthorizedAdminRequests: [],
    unexpectedRequests: [],
    activeRequestCount(pathname, method = "GET") {
      return active.get(endpointKey(pathname, method)) ?? 0;
    },
    async emitStream(event, payload) {
      harness.interactions.push({
        action: "stream",
        detail: event,
        order: harness.interactions.length + 1,
        target: "deterministic migration event stream",
      });
      await page.evaluate(
        ({ eventName, eventPayload }) => {
          const evidenceWindow = window as Window & {
            __migrationEvidenceEmit?: (
              emittedEvent: string,
              emittedPayload: unknown,
            ) => void;
          };
          if (!evidenceWindow.__migrationEvidenceEmit) {
            throw new Error("Deterministic migration stream is not installed.");
          }
          evidenceWindow.__migrationEvidenceEmit(eventName, eventPayload);
        },
        { eventName: event, eventPayload: payload },
      );
    },
    releaseEndpoint(pathname, nextMode = "success", method = "GET") {
      const key = endpointKey(pathname, method);
      endpointModes.set(key, nextMode);
      if (nextMode === "error") {
        harness.expectedHttpFailures.push(pathname);
      }
      for (const gate of gates.get(key) ?? []) gate.release();
      gates.delete(key);
    },
    setEndpointMode(pathname, mode, method = "GET") {
      endpointModes.set(endpointKey(pathname, method), mode);
      if (mode === "error") harness.expectedHttpFailures.push(pathname);
    },
    setEndpointPayload(pathname, payload, method = "GET") {
      payloads.set(endpointKey(pathname, method), payload);
    },
    async streamInstanceCount() {
      return page.evaluate(
        () =>
          (
            window as Window & {
              __migrationEvidenceStreams?: unknown[];
            }
          ).__migrationEvidenceStreams?.length ?? 0,
      );
    },
  };

  for (const [key, mode] of endpointModes) {
    if (mode === "error") {
      harness.expectedHttpFailures.push(key.slice(key.indexOf(" ") + 1));
    }
  }

  page.on("pageerror", (error) => harness.runtimeErrors.push(error.message));
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    const locationUrl = message.location().url;
    if (
      message.text().startsWith("Failed to load resource:") &&
      locationUrl &&
      harness.expectedHttpFailures.includes(new URL(locationUrl).pathname)
    ) {
      return;
    }
    harness.runtimeErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const pathname = new URL(response.url()).pathname;
    if (!isOwnedMigrationPath(pathname)) return;
    harness.observedHttpFailures.push({ pathname, status: response.status() });
  });
  page.on("requestfailed", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/assets/")) {
      harness.assetFailures.push(
        `${pathname}: ${request.failure()?.errorText ?? "failed"}`,
      );
    }
  });

  // The shared visual fixture owns a broad `**/api/**` JSON stub. In source
  // mode Vite module URLs such as `/src/lib/api/migrations.ts` also match that
  // pattern, so explicitly let source modules reach Vite before installing the
  // fail-closed HTTP API router below. Optimized chunks never need this branch.
  await page.route("**/src/lib/api/**", async (route) => {
    await route.continue();
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    if (pathname === "/api/v1/auth/me") {
      await json(route, authPayload(role));
      return;
    }
    if (pathname === "/api/v1/me") {
      await json(route, {
        user: `${role}@migrations.example.invalid`,
        tenant: "Migrations Evidence",
        role,
      });
      return;
    }
    if (pathname === "/api/v1/api-keys/me") {
      await json(route, {
        tenant_id: MIGRATIONS_TENANT_ID,
        tenant_slug: "migrations-evidence",
        scopes: role === "admin" ? ["admin"] : ["read:reports"],
        actor: `${role}@migrations.example.invalid`,
      });
      return;
    }
    if (!isOwnedMigrationPath(pathname)) {
      await route.fallback();
      return;
    }

    const evidence = requestEvidence(request, harness.requests.length + 1);
    harness.requests.push(evidence);
    const method = request.method();
    const key = endpointKey(pathname, method);
    if (url.search !== "" || !allowedMethod(pathname, method)) {
      harness.unexpectedRequests.push(
        `${method} ${pathname}${url.search} (method, route, or query mismatch)`,
      );
      await json(route, errorBody(), 405);
      return;
    }
    if (role === "viewer" && requiresAdmin(pathname, method)) {
      harness.unauthorizedAdminRequests.push(`${method} ${pathname}`);
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

    const count = (active.get(key) ?? 0) + 1;
    active.set(key, count);
    harness.maximumConcurrentRequests[key] = Math.max(
      harness.maximumConcurrentRequests[key] ?? 0,
      count,
    );
    try {
      if ((endpointModes.get(key) ?? "success") === "deferred") {
        const gate = deferredGate();
        gates.set(key, [...(gates.get(key) ?? []), gate]);
        await gate.promise;
      }
      if ((endpointModes.get(key) ?? "success") === "error") {
        await json(route, errorBody(), 503);
        return;
      }
      const payload = payloads.has(key)
        ? payloads.get(key)
        : dynamicPayload(pathname, request);
      if (payload === undefined) {
        harness.unexpectedRequests.push(
          `${method} ${pathname} (unmocked migration request)`,
        );
        await json(route, errorBody(), 501);
        return;
      }
      await json(route, payload, successStatus(pathname, method));
    } finally {
      active.set(key, Math.max(0, (active.get(key) ?? 1) - 1));
    }
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      await route.fallback();
      return;
    }
    const allowedPorts = new Set([
      "8080",
      EVIDENCE_MODE === "source" ? "1463" : "1464",
    ]);
    const localHost =
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "::1";
    const optimizedEvidenceApiRequest =
      EVIDENCE_MODE === "optimized" &&
      url.origin === OPTIMIZED_EVIDENCE_API_ORIGIN &&
      (url.pathname.startsWith("/api/v1/") ||
        (route.request().method() === "GET" && url.pathname === "/api/health"));
    if (
      (localHost && allowedPorts.has(url.port)) ||
      optimizedEvidenceApiRequest
    ) {
      await route.fallback();
      return;
    }
    harness.unexpectedRequests.push(
      `${route.request().method()} ${url.origin}${url.pathname} (external network blocked)`,
    );
    await route.abort("blockedbyclient");
  });

  return harness;
}

export async function openMigrations(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  options: {
    height?: number;
    initialModes?: Partial<Record<string, MigrationEndpointMode>>;
    jobs?: MigrationJob[];
    role?: MigrationsRole;
    sources?: MigrationSourceCapability[];
    theme?: "system" | "dark" | "light";
    width?: number;
  } = {},
): Promise<MigrationsHarness> {
  const role = options.role ?? "admin";
  await setTheme(page, options.theme ?? "dark");
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 1_000,
  });
  await bootApp(page);
  await installDeterministicEventSource(page);
  await page.addInitScript(
    ({
      identityRole,
      tenantId,
    }: {
      identityRole: MigrationsRole;
      tenantId: string;
    }) => {
      window.sessionStorage.setItem(
        "postwave_session_user",
        JSON.stringify({
          user_id: `migrations-${identityRole}`,
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
    { identityRole: role, tenantId: MIGRATIONS_TENANT_ID },
  );
  await page.clock.setFixedTime(new Date(MIGRATIONS_FIXED_TIME));
  const harness = await installMigrationsHarness(
    page,
    role,
    options.initialModes,
  );
  if (options.jobs) {
    harness.setEndpointPayload("/api/v1/migrations", options.jobs);
  }
  if (options.sources) {
    harness.setEndpointPayload("/api/v1/migrations/sources", options.sources);
  }
  await page.goto("/app/migrations");
  await waitForPrimaryNavigation(page, 30_000);
  await expect(
    page.getByRole("heading", { name: "Migrations", level: 1 }),
  ).toBeVisible();
  await expect(page.locator(".migration-surface")).toBeVisible();
  return harness;
}

export async function resetMigrationsEvidenceDirectory(): Promise<void> {
  await rm(EVIDENCE_DIR, { force: true, recursive: true });
  await mkdir(EVIDENCE_DIR, { recursive: true });
}

export async function clickMigration(
  harness: MigrationsHarness,
  target: string,
  locator: Locator,
): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
  harness.interactions.push({
    action: "click",
    order: harness.interactions.length + 1,
    target,
  });
}

export async function fillMigration(
  harness: MigrationsHarness,
  target: string,
  locator: Locator,
  value: string,
  options: { sensitive?: boolean } = {},
): Promise<void> {
  await locator.fill(value);
  harness.interactions.push({
    action: "fill",
    detail: options.sensitive ? `${value.length} characters (redacted)` : value,
    order: harness.interactions.length + 1,
    target,
  });
}

export async function pressMigration(
  harness: MigrationsHarness,
  target: string,
  locator: Locator,
  key: string,
): Promise<void> {
  await locator.press(key);
  harness.interactions.push({
    action: "press",
    detail: key,
    order: harness.interactions.length + 1,
    target,
  });
}

export async function selectMigration(
  harness: MigrationsHarness,
  target: string,
  locator: Locator,
  value: string,
): Promise<void> {
  await locator.selectOption(value);
  harness.interactions.push({
    action: "select",
    detail: value,
    order: harness.interactions.length + 1,
    target,
  });
}

export async function setMigrationFile(
  harness: MigrationsHarness,
  target: string,
  locator: Locator,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  const dataTransfer = await locator.page().evaluateHandle(
    ({ bytes, mimeType, name }) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Uint8Array(bytes)], name, { type: mimeType }),
      );
      return transfer;
    },
    {
      bytes: Array.from(file.buffer),
      mimeType: file.mimeType,
      name: file.name,
    },
  );
  try {
    await locator.locator("xpath=..").dispatchEvent("drop", { dataTransfer });
  } finally {
    await dataTransfer.dispose();
  }
  harness.interactions.push({
    action: "upload",
    detail: `${file.name} (${file.buffer.byteLength.toLocaleString("en-US")} bytes; contents omitted)`,
    order: harness.interactions.length + 1,
    target,
  });
}

export async function auditMigrationsLayout(
  page: Page,
  harness: MigrationsHarness,
  label: string,
  selector = ".migration-surface",
): Promise<MigrationLayoutEvidence> {
  await expect(page.locator(selector)).toBeVisible();
  const evidence = await page.evaluate(
    ({ rootSelector, runLabel }) => {
      const root = document.querySelector<HTMLElement>(rootSelector);
      const content = document.querySelector<HTMLElement>(".content");
      const visibleViewportOffenders = root
        ? [...root.querySelectorAll<HTMLElement>("*")]
            .filter((element) => {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              return (
                style.display !== "none" &&
                style.visibility !== "hidden" &&
                rect.width > 0 &&
                rect.height > 0 &&
                (rect.left < -1 || rect.right > innerWidth + 1)
              );
            })
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                bottom: Math.round(rect.bottom),
                left: Math.round(rect.left),
                right: Math.round(rect.right),
                selector:
                  element.dataset.testid ??
                  element.getAttribute("aria-label") ??
                  element.className ??
                  element.tagName.toLowerCase(),
                top: Math.round(rect.top),
              };
            })
            .slice(0, 12)
        : [];
      return {
        bodyOverflow: document.body.scrollWidth - innerWidth,
        contentOverflow: content
          ? content.scrollWidth - content.clientWidth
          : null,
        documentOverflow: document.documentElement.scrollWidth - innerWidth,
        label: runLabel,
        rootOverflow: root ? root.scrollWidth - root.clientWidth : null,
        viewport: { height: innerHeight, width: innerWidth },
        visibleViewportOffenders,
      };
    },
    { rootSelector: selector, runLabel: label },
  );
  harness.layoutRuns.push(evidence);
  return evidence;
}

export async function expectNoMigrationsOverflow(
  page: Page,
  harness: MigrationsHarness,
  label: string,
  selector = ".migration-surface",
  options: { includeShell?: boolean } = {},
): Promise<void> {
  const evidence = await auditMigrationsLayout(page, harness, label, selector);
  expect(evidence.rootOverflow).not.toBeNull();
  expect(evidence.rootOverflow ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    1,
  );
  if (options.includeShell ?? true) {
    expect(evidence.bodyOverflow).toBeLessThanOrEqual(1);
    expect(evidence.documentOverflow).toBeLessThanOrEqual(1);
    expect(evidence.contentOverflow ?? 0).toBeLessThanOrEqual(1);
  }
}

export async function auditMigrationsA11y(
  page: Page,
  harness: MigrationsHarness,
  label: string,
  selector = ".migration-surface",
  options: { includeColorContrast?: boolean } = {},
): Promise<A11yViolation[]> {
  await expect(page.locator(selector)).toBeVisible();
  if (!(await page.evaluate(() => "axe" in window))) {
    await page.addScriptTag({ content: AXE_SOURCE });
  }
  const violations = await page.evaluate(
    async ({ includeColorContrast, rootSelector }) => {
      const axe = (
        window as unknown as {
          axe: {
            run: (
              context: string,
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
      const result = await axe.run(rootSelector, {
        resultTypes: ["violations"],
        rules: includeColorContrast
          ? undefined
          : { "color-contrast": { enabled: false } },
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
            violation.impact === "critical" || violation.impact === "serious",
        )
        .map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          nodes: violation.nodes.map((node) => ({
            target: node.target,
            failureSummary: node.failureSummary,
          })),
        }));
    },
    {
      includeColorContrast: options.includeColorContrast ?? true,
      rootSelector: selector,
    },
  );
  harness.a11yRuns.push({ label, selector, violations });
  return violations;
}

export async function expectMigrationsReducedMotion(
  page: Page,
  selector = ".migration-surface",
): Promise<void> {
  const running = await page.locator(selector).evaluate((element) =>
    element
      .getAnimations({ subtree: true })
      .filter((animation) => animation.playState === "running")
      .map((animation) => {
        const duration = animation.effect?.getComputedTiming().duration ?? 0;
        return typeof duration === "number"
          ? duration
          : Number.POSITIVE_INFINITY;
      }),
  );
  expect(
    running.filter((duration) => !Number.isFinite(duration) || duration > 10),
  ).toEqual([]);
}

export async function expectMigrationsSafety(
  page: Page,
  harness: MigrationsHarness,
): Promise<void> {
  expect(harness.unexpectedRequests).toEqual([]);
  expect(harness.unauthorizedAdminRequests).toEqual([]);
  expect(harness.assetFailures).toEqual([]);
  expect(harness.runtimeErrors).toEqual([]);
  expect(
    harness.observedHttpFailures.filter(
      ({ pathname }) => !harness.expectedHttpFailures.includes(pathname),
    ),
  ).toEqual([]);
  for (const pathname of new Set(harness.expectedHttpFailures)) {
    expect(
      harness.observedHttpFailures.some(
        (failure) => failure.pathname === pathname,
      ),
    ).toBe(true);
  }
  expect(harness.requests.map(({ order }) => order)).toEqual(
    harness.requests.map((_, index) => index + 1),
  );
  expect(harness.interactions.map(({ order }) => order)).toEqual(
    harness.interactions.map((_, index) => index + 1),
  );
  for (const [endpoint, maximum] of Object.entries(
    harness.maximumConcurrentRequests,
  )) {
    expect(
      maximum,
      `${endpoint} exceeded the route's single-flight request contract`,
    ).toBeLessThanOrEqual(1);
  }
  const rendered = await page.locator("body").innerText();
  expect(rendered).not.toContain(MIGRATIONS_SECRET_CANARY);
  expect(rendered).not.toContain(MIGRATIONS_CREDENTIAL_SECRET);
  expect(rendered).not.toContain(MIGRATIONS_RECOVERY_SECRET);
  const serializedLedgers = JSON.stringify({
    interactions: harness.interactions,
    requests: harness.requests,
  });
  expect(serializedLedgers).not.toContain(MIGRATIONS_SECRET_CANARY);
  expect(serializedLedgers).not.toContain(MIGRATIONS_CREDENTIAL_SECRET);
  expect(serializedLedgers).not.toContain(MIGRATIONS_RECOVERY_SECRET);
  expect(rendered).not.toContain("Everything imported");
  expect(rendered).not.toContain("Cutover certified");
  expect(rendered).not.toContain("Nothing has been written to your tenant");
}

export async function captureMigrationsEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  harness: MigrationsHarness,
): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  await page.screenshot({
    path: join(EVIDENCE_DIR, `${name}.png`),
    animations: "disabled",
    caret: "hide",
    fullPage: false,
  });

  const metadata = testInfo.config.metadata as Record<string, unknown>;
  const baseCommitSha =
    typeof metadata["migrationsBaseCommitSha"] === "string"
      ? metadata["migrationsBaseCommitSha"]
      : "unavailable";
  const media = await page.evaluate(() => ({
    colorScheme: matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
    forcedColors: matchMedia("(forced-colors: active)").matches,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    viewport: { width: innerWidth, height: innerHeight },
  }));
  const receipt = {
    schemaVersion: 1,
    evidenceMode: EVIDENCE_MODE,
    baseCommitSha,
    command:
      `PW_EVIDENCE_MODE=${EVIDENCE_MODE} pnpm exec playwright test ` +
      "--config tests/e2e/migrations.playwright.config.ts",
    declaredPlaywrightTestCount: DECLARED_PLAYWRIGHT_TEST_COUNT,
    fixedTimeUtc: MIGRATIONS_FIXED_TIME,
    rendererRandomSeed: `0x${MIGRATIONS_RANDOM_SEED.toString(16)}`,
    timezoneId: "UTC",
    node: process.version,
    playwright: PLAYWRIGHT_VERSION,
    chromium: page.context().browser()?.version() ?? "unavailable",
    axeCore: AXE_VERSION,
    platform: process.platform,
    architecture: process.arch,
    project: testInfo.project.name,
    report: `../reports/${EVIDENCE_MODE}.json`,
    networkPolicy:
      EVIDENCE_MODE === "optimized"
        ? "Only the exact synthetic HTTPS origin's /api/v1/** requests and GET /api/health may enter fail-closed Playwright routers; every other external request is blocked."
        : "Only the local source server and local fixture API may enter Playwright routers; every external request is blocked.",
  };
  await writeFile(
    join(EVIDENCE_DIR, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(EVIDENCE_DIR, "command-receipt.json"),
    `${JSON.stringify(
      {
        ...receipt,
        webServerCommand:
          EVIDENCE_MODE === "source"
            ? "pnpm exec vite --port 1463 --strictPort"
            : "VITE_API_URL=https://migrations-evidence.example.invalid pnpm exec vite build && pnpm exec vite preview --port 1464 --strictPort",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(EVIDENCE_DIR, `${name}.requests.json`),
    `${JSON.stringify(harness.requests, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(EVIDENCE_DIR, `${name}.interactions.json`),
    `${JSON.stringify(harness.interactions, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(EVIDENCE_DIR, `${name}.quality.json`),
    `${JSON.stringify(
      {
        name,
        media,
        requestCount: harness.requests.length,
        interactionCount: harness.interactions.length,
        maximumConcurrentRequests: harness.maximumConcurrentRequests,
        a11yRuns: harness.a11yRuns,
        layoutRuns: harness.layoutRuns,
        runtimeErrors: harness.runtimeErrors,
        assetFailures: harness.assetFailures,
        unexpectedRequests: harness.unexpectedRequests,
        unauthorizedAdminRequests: harness.unauthorizedAdminRequests,
        observedHttpFailures: harness.observedHttpFailures,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export function migrationDoneEvent(
  jobSnapshot: MigrationJob = MIGRATION_WIZARD_COMPLETED_JOB,
): MigrationDoneEvent {
  return {
    status: jobSnapshot.status,
    resources: {
      subscribers: { imported: 1_284, skipped: 93, failed: 0 },
      segments: { imported: 12, skipped: 0, failed: 0 },
      automations: { imported: 0, skipped: 4, failed: 0, review: 4 },
      archive: { imported: 18, skipped: 0, failed: 0 },
    },
    job: jobSnapshot,
  };
}

export function migrationProgressEvent(): MigrationProgressEvent {
  return {
    resource: "subscribers",
    completed: 642,
    total: 1_284,
    current_step: "Importing verified subscriber batch",
    snapshot: progress(642),
    at: "2026-08-09T09:59:30.000Z",
  };
}

async function collectEvidenceFiles(
  directory: string,
  prefix: string,
): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await collectEvidenceFiles(absolute, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files.sort();
}

export async function writeMigrationsEvidenceManifest(): Promise<{
  manifestPath: string;
  manifestSha256: string;
}> {
  const artifactPaths = (
    await Promise.all(
      ["source", "optimized", "reports"].map((directory) =>
        collectEvidenceFiles(join(EVIDENCE_ROOT, directory), directory),
      ),
    )
  )
    .flat()
    .sort();
  const artifacts = await Promise.all(
    artifactPaths.map(async (path) => {
      const contents = await readFile(join(EVIDENCE_ROOT, path));
      return {
        path,
        bytes: contents.byteLength,
        sha256: createHash("sha256").update(contents).digest("hex"),
      };
    }),
  );
  const manifest = {
    schemaVersion: 1,
    sealedAtUtc: new Date().toISOString(),
    expectedModes: ["source", "optimized"],
    declaredPlaywrightTestsPerMode: DECLARED_PLAYWRIGHT_TEST_COUNT,
    fixedTimeUtc: MIGRATIONS_FIXED_TIME,
    rendererRandomSeed: `0x${MIGRATIONS_RANDOM_SEED.toString(16)}`,
    artifactCount: artifacts.length,
    artifacts,
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = join(EVIDENCE_ROOT, "manifest.json");
  const manifestSha256 = createHash("sha256").update(serialized).digest("hex");
  await mkdir(EVIDENCE_ROOT, { recursive: true });
  await writeFile(manifestPath, serialized, "utf8");
  await writeFile(
    join(EVIDENCE_ROOT, "manifest.sha256"),
    `${manifestSha256}  manifest.json\n`,
    "utf8",
  );
  return { manifestPath, manifestSha256 };
}
