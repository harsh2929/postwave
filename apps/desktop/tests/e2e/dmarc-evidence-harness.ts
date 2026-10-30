import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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

import { waitForPrimaryNavigation } from "../visual/fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export type DmarcEvidenceMode = "source" | "optimized";

function evidenceMode(): DmarcEvidenceMode {
  const mode = process.env["PW_EVIDENCE_MODE"] ?? "optimized";
  if (mode !== "source" && mode !== "optimized") {
    throw new Error(
      `PW_EVIDENCE_MODE must be source or optimized; received ${mode}`,
    );
  }
  return mode;
}

const EVIDENCE_MODE = evidenceMode();
const EVIDENCE_ROOT = fileURLToPath(
  new URL("../../../../.audit-screenshots/dmarc-evidence/", import.meta.url),
);
const EVIDENCE_DIR = join(EVIDENCE_ROOT, EVIDENCE_MODE);
const DECLARED_PLAYWRIGHT_TEST_COUNT = 9;
const DASHBOARD_LAYOUT_ERROR =
  "Couldn't load your saved Dashboard layout. The default layout is shown.";
const DASHBOARD_LAYOUT_ORDER = [
  "subs",
  "opens",
  "clicks",
  "bounces",
  "forecast",
  "anomalies",
  "goals",
  "benchmarks",
  "engagement",
  "parity",
  "inbox-health",
  "clv",
] as const;

export const DMARC_FIXED_TIME = "2026-08-03T08:30:00.000Z";
export const DMARC_TENANT_ID = "da000000-0000-4000-8000-000000000001";
export const DMARC_RISKY_DOMAIN = "northstar.example";
export const DMARC_HEALTHY_DOMAIN = "mail.atlas.example";
export const DMARC_PRIMARY_SOURCE = "192.0.2.10";
export const DMARC_SECRET_CANARY =
  "dmarc-server-secret-must-never-reach-the-renderer";

type JsonRecord = Record<string, unknown>;

export type DmarcFixtureMode =
  | "risky"
  | "healthy"
  | "zero"
  | "reports-ok-insights-500"
  | "reports-500-insights-ok"
  | "malformed-main"
  | "stale-race";

export type DmarcSaveMode = "saved" | "cancelled";

export interface DmarcRequestEvidence {
  body: string | null;
  headers: Record<string, string>;
  method: string;
  order: number;
  pathname: string;
  resourceType: string;
  search: string;
}

export interface DmarcHttpFailureEvidence {
  method: string;
  order: number;
  pathname: string;
  search: string;
  status: number;
}

export interface DmarcA11yRun {
  label: string;
  selector: string;
  violations: unknown[];
}

export interface DmarcNativeCallEvidence {
  command: string;
  order: number;
  summary: Record<string, unknown>;
}

export interface DmarcExportEvidence {
  byteLength: number;
  content: string;
  path: string;
  sha256: string;
}

export interface DmarcHarness {
  a11yRuns: DmarcA11yRun[];
  apiAborts: string[];
  assetFailures: string[];
  controls: DmarcRequestEvidence[];
  dmarcReads: DmarcRequestEvidence[];
  expectedConsoleErrors: string[];
  expectedHttpFailures: DmarcHttpFailureEvidence[];
  exports: DmarcExportEvidence[];
  nativeCalls: DmarcNativeCallEvidence[];
  productMutations: DmarcRequestEvidence[];
  requests: DmarcRequestEvidence[];
  runtimeErrors: string[];
  suggestionAcknowledgements: DmarcRequestEvidence[];
  unexpectedRequests: string[];
  releaseInitialRace: () => void;
  setSaveMode: (mode: DmarcSaveMode) => void;
}

type BootApp = (page: Page) => Promise<void>;
type SetTheme = (
  page: Page,
  theme: "system" | "dark" | "light",
) => Promise<void>;

async function waitForDmarcShell(page: Page): Promise<void> {
  try {
    await waitForPrimaryNavigation(page);
  } catch (error) {
    const diagnostic = await page.evaluate(async () => {
      const offlineModuleUrl = "/src/lib/offline-store.ts";
      const authModuleUrl = "/src/lib/auth.ts";
      const offline = (await import(offlineModuleUrl)) as {
        getOfflineIdentity: () => string | null;
        hydrateOfflineStores: () => Promise<void>;
      };
      const auth = (await import(authModuleUrl)) as {
        detectSession: () => Promise<{ kind: string }>;
      };
      const timed = async <T>(promise: Promise<T>): Promise<string> =>
        Promise.race([
          promise.then((value) => JSON.stringify(value ?? "resolved")),
          new Promise<string>((resolve) => {
            window.setTimeout(() => resolve("timed-out"), 1_000);
          }),
        ]);
      return {
        body: document.body.innerText.slice(0, 500),
        offlineIdentity: offline.getOfflineIdentity(),
        offlineHydration: await timed(offline.hydrateOfflineStores()),
        sessionDetection: await timed(auth.detectSession()),
      };
    });
    throw new Error(
      `DMARC shell did not become ready: ${JSON.stringify(diagnostic)}`,
      { cause: error },
    );
  }
}

const SOURCE_ROWS = [
  {
    sourceIp: DMARC_PRIMARY_SOURCE,
    messages: 8_000,
    dkimPass: 5_000,
    spfPass: 4_000,
    bothPass: 3_500,
    alignedPct: 0.6875,
    primaryDisposition: "quarantine",
    quarantined: 1_500,
    rejected: 1_000,
    envelopeFromDomain: "northstar.example",
  },
  {
    sourceIp: "198.51.100.40",
    messages: 7_000,
    dkimPass: 4_000,
    spfPass: 3_500,
    bothPass: 2_500,
    alignedPct: 5_000 / 7_000,
    primaryDisposition: "reject",
    quarantined: 1_600,
    rejected: 900,
    envelopeFromDomain: "atlas.example",
  },
  {
    sourceIp: "2001:db8::42",
    messages: 5_000,
    dkimPass: 4_000,
    spfPass: 3_500,
    bothPass: 3_000,
    alignedPct: 0.9,
    primaryDisposition: "none",
    quarantined: 900,
    rejected: 100,
  },
  {
    sourceIp: "198.51.100.50",
    messages: 4_000,
    dkimPass: 3_000,
    spfPass: 2_800,
    bothPass: 2_500,
    alignedPct: 0.825,
    primaryDisposition: "none",
    quarantined: 200,
    rejected: 100,
  },
  {
    sourceIp: "203.0.113.20",
    messages: 3_500,
    dkimPass: 2_500,
    spfPass: 2_200,
    bothPass: 1_800,
    alignedPct: 2_900 / 3_500,
    primaryDisposition: "none",
    quarantined: 100,
    rejected: 100,
  },
  {
    sourceIp: "192.0.2.30",
    messages: 3_000,
    dkimPass: 2_000,
    spfPass: 1_800,
    bothPass: 1_500,
    alignedPct: 2_300 / 3_000,
    primaryDisposition: "quarantine",
    quarantined: 500,
    rejected: 200,
  },
  {
    sourceIp: "2001:db8::70",
    messages: 2_500,
    dkimPass: 2_000,
    spfPass: 1_500,
    bothPass: 1_200,
    alignedPct: 0.92,
    primaryDisposition: "none",
    quarantined: 100,
    rejected: 0,
  },
  {
    sourceIp: "203.0.113.80",
    messages: 2_000,
    dkimPass: 1_200,
    spfPass: 1_100,
    bothPass: 800,
    alignedPct: 0.75,
    primaryDisposition: "reject",
    quarantined: 300,
    rejected: 500,
  },
  {
    sourceIp: "198.51.100.90",
    messages: 1_500,
    dkimPass: 1_000,
    spfPass: 800,
    bothPass: 600,
    alignedPct: 0.8,
    primaryDisposition: "none",
    quarantined: 100,
    rejected: 50,
  },
  {
    sourceIp: "192.0.2.100",
    messages: 1_000,
    dkimPass: 700,
    spfPass: 500,
    bothPass: 300,
    alignedPct: 0.9,
    primaryDisposition: "none",
    quarantined: 50,
    rejected: 0,
  },
] as const;

const REPORT_BASE_ROWS = [
  {
    id: "da100000-0000-4000-8000-000000000001",
    orgName: "+SUM(1,1)",
    reportId: '=WEBSERVICE("https://attacker.invalid")',
    domain: DMARC_RISKY_DOMAIN,
    policyP: "none",
    policyPct: 100,
    dateBegin: "2026-08-01T00:00:00.000Z",
    dateEnd: "2026-08-02T00:00:00.000Z",
    passCount: 5_500,
    failCount: 2_500,
    receivedAt: "2026-08-02T04:20:00.000Z",
  },
  {
    id: "da100000-0000-4000-8000-000000000002",
    orgName: "Atlas Mail Receiver",
    reportId: "atlas-aggregate-2026-08-01",
    domain: "atlas.example",
    policyP: "quarantine",
    policyPct: 75,
    dateBegin: "2026-07-31T00:00:00.000Z",
    dateEnd: "2026-08-01T00:00:00.000Z",
    passCount: 5_000,
    failCount: 2_000,
    receivedAt: "2026-08-01T05:10:00.000Z",
  },
  {
    id: "da100000-0000-4000-8000-000000000003",
    orgName: "Cascade Reporting",
    reportId: "cascade-aggregate-2026-07-31",
    domain: "cascade.example",
    policyP: "reject",
    policyPct: 100,
    dateBegin: "2026-07-30T00:00:00.000Z",
    dateEnd: "2026-07-31T00:00:00.000Z",
    passCount: 3_500,
    failCount: 1_500,
    receivedAt: "2026-07-31T06:00:00.000Z",
  },
] as const;

const REPORT_FILLER_ROWS = Array.from({ length: 497 }, (_, offset) => {
  const sequence = offset + 1;
  const suffix = sequence.toString(16).padStart(12, "0");
  const prefix = sequence.toString(16).padStart(6, "0");
  const dateEnd = new Date(
    Date.parse("2026-07-30T23:50:00.000Z") - offset * 10 * 60 * 1_000,
  );
  const dateBegin = new Date(dateEnd.getTime() - 5 * 60 * 1_000);
  const domain = [DMARC_RISKY_DOMAIN, "atlas.example", "cascade.example"][
    sequence % 3
  ];
  const fullyAligned = sequence === 1;
  const zeroMessageReceipt = sequence === 2;
  return {
    id: `db${prefix}-0000-4000-8000-${suffix}`,
    orgName: `Deterministic Receiver ${sequence.toString().padStart(3, "0")}`,
    reportId: `deterministic-aggregate-${sequence.toString().padStart(3, "0")}`,
    domain,
    policyP: sequence % 3 === 0 ? "reject" : "quarantine",
    policyPct: 100,
    dateBegin: dateBegin.toISOString(),
    dateEnd: dateEnd.toISOString(),
    passCount: zeroMessageReceipt ? 0 : fullyAligned ? 100 : 80,
    failCount: zeroMessageReceipt || fullyAligned ? 0 : 20,
    receivedAt: new Date(dateEnd.getTime() + 60 * 60 * 1_000).toISOString(),
  };
});

const REPORT_ROWS = [...REPORT_BASE_ROWS, ...REPORT_FILLER_ROWS];

function startForDays(days: number): string {
  return new Date(
    Date.parse(DMARC_FIXED_TIME) - days * 24 * 60 * 60 * 1_000,
  ).toISOString();
}

function reportsPayload(
  mode: DmarcFixtureMode,
  domain: string | undefined,
  from: string,
  to: string,
): JsonRecord {
  if (mode === "zero") {
    return {
      items: [],
      meta: {
        generatedAt: DMARC_FIXED_TIME,
        limit: 500,
        returned: 0,
        totalReports: 0,
        hasMore: false,
        availableDomains: [],
        domainInventoryTruncated: false,
        scope: { from, to, ...(domain ? { domain } : {}) },
      },
    };
  }

  if (mode === "healthy") {
    const healthyReport = {
      id: "da200000-0000-4000-8000-000000000001",
      orgName: "Atlas Receiver Network",
      reportId: "atlas-healthy-2026-08-02",
      domain: DMARC_HEALTHY_DOMAIN,
      policyP: "reject",
      policyPct: 100,
      dateBegin: "2026-08-01T00:00:00.000Z",
      dateEnd: "2026-08-02T00:00:00.000Z",
      passCount: 4_990,
      failCount: 10,
      receivedAt: "2026-08-02T03:30:00.000Z",
    };
    return {
      items: domain && domain !== DMARC_HEALTHY_DOMAIN ? [] : [healthyReport],
      meta: {
        generatedAt: DMARC_FIXED_TIME,
        limit: 500,
        returned: domain && domain !== DMARC_HEALTHY_DOMAIN ? 0 : 1,
        totalReports: domain && domain !== DMARC_HEALTHY_DOMAIN ? 0 : 1,
        hasMore: false,
        availableDomains: [DMARC_HEALTHY_DOMAIN],
        domainInventoryTruncated: false,
        scope: { from, to, ...(domain ? { domain } : {}) },
      },
    };
  }

  if (mode === "reports-ok-insights-500") {
    const item = REPORT_ROWS[0];
    if (!item) throw new Error("Missing deterministic DMARC report fixture.");
    return {
      items: [item],
      meta: {
        generatedAt: DMARC_FIXED_TIME,
        limit: 500,
        returned: 1,
        totalReports: 1,
        hasMore: false,
        availableDomains: [DMARC_RISKY_DOMAIN],
        domainInventoryTruncated: false,
        scope: { from, to, ...(domain ? { domain } : {}) },
      },
    };
  }

  if (mode === "stale-race") {
    const raceRows = REPORT_ROWS.slice(0, 7);
    return {
      items: raceRows,
      meta: {
        generatedAt: DMARC_FIXED_TIME,
        limit: 500,
        returned: raceRows.length,
        totalReports: raceRows.length,
        hasMore: false,
        availableDomains: [
          "atlas.example",
          "cascade.example",
          DMARC_RISKY_DOMAIN,
        ],
        domainInventoryTruncated: false,
        scope: { from, to, ...(domain ? { domain } : {}) },
      },
    };
  }

  const items = domain
    ? REPORT_ROWS.filter((report) => report.domain === domain)
    : [...REPORT_ROWS];
  const totalReports = domain ? items.length : 742;
  return {
    items,
    meta: {
      generatedAt: DMARC_FIXED_TIME,
      limit: 500,
      returned: items.length,
      totalReports,
      hasMore: totalReports > items.length,
      availableDomains: [
        "atlas.example",
        "cascade.example",
        DMARC_RISKY_DOMAIN,
      ],
      domainInventoryTruncated: true,
      scope: { from, to, ...(domain ? { domain } : {}) },
    },
  };
}

function riskyInsights(domain: string | undefined, days: number): JsonRecord {
  return {
    domain: domain ?? "",
    periodDays: days,
    generatedAt: DMARC_FIXED_TIME,
    windowStart: startForDays(days),
    windowEnd: DMARC_FIXED_TIME,
    latestReportAt: "2026-08-02T04:20:00.000Z",
    reportingDays: 3,
    reportCount: 742,
    totalMessages: 40_000,
    sourceCount: 14,
    sourceListTruncated: true,
    alignment: {
      bothPass: 24_000,
      dkimOnlyPass: 5_000,
      spfOnlyPass: 2_500,
      neitherPass: 8_500,
      alignedPct: 0.7875,
    },
    disposition: {
      none: 24_000,
      quarantine: 8_000,
      reject: 7_000,
      unknown: 1_000,
    },
    topSources: [...SOURCE_ROWS],
    topFailingSources: [
      SOURCE_ROWS[0],
      SOURCE_ROWS[1],
      SOURCE_ROWS[5],
      SOURCE_ROWS[7],
    ],
    suggestions: [
      {
        code: "alignment_low",
        severity: "action",
        action: "Confirm ownership of the highest-volume unaligned sources.",
        reason:
          "Eight thousand five hundred messages lacked aligned SPF and aligned DKIM in this bounded snapshot.",
      },
      {
        code: "policy_action_volume_high",
        severity: "action",
        action: "Review legitimate traffic affected by quarantine and reject.",
        reason:
          "Provider actions are evidence to investigate, not proof of spoofing or inbox placement.",
      },
    ],
    series: [
      {
        date: "2026-07-31",
        messages: 10_000,
        aligned: 7_875,
        alignedPct: 0.7875,
      },
      {
        date: "2026-08-01",
        messages: 14_000,
        aligned: 11_025,
        alignedPct: 0.7875,
      },
      {
        date: "2026-08-02",
        messages: 16_000,
        aligned: 12_600,
        alignedPct: 0.7875,
      },
    ],
    ...(domain ? { latestPolicy: "none" } : {}),
  };
}

function insightsPayload(
  mode: DmarcFixtureMode,
  domain: string | undefined,
  days: number,
): JsonRecord {
  if (mode === "zero") {
    return {
      domain: domain ?? "",
      periodDays: days,
      generatedAt: DMARC_FIXED_TIME,
      windowStart: startForDays(days),
      windowEnd: DMARC_FIXED_TIME,
      reportingDays: 0,
      reportCount: 0,
      totalMessages: 0,
      sourceCount: 0,
      sourceListTruncated: false,
      alignment: {
        bothPass: 0,
        dkimOnlyPass: 0,
        spfOnlyPass: 0,
        neitherPass: 0,
        alignedPct: 0,
      },
      disposition: { none: 0, quarantine: 0, reject: 0, unknown: 0 },
      topSources: [],
      topFailingSources: [],
      suggestions: [
        {
          code: "no_reports",
          severity: "info",
          action: "Wait for the first DMARC report.",
          reason:
            "No aggregate reports were ingested in this bounded evidence window.",
        },
      ],
      series: [],
    };
  }

  if (mode === "healthy") {
    const source = {
      sourceIp: "203.0.113.8",
      messages: 5_000,
      dkimPass: 4_990,
      spfPass: 4_995,
      bothPass: 4_990,
      alignedPct: 0.999,
      primaryDisposition: "none",
      quarantined: 0,
      rejected: 0,
      envelopeFromDomain: DMARC_HEALTHY_DOMAIN,
    };
    return {
      domain: domain ?? "",
      periodDays: days,
      generatedAt: DMARC_FIXED_TIME,
      windowStart: startForDays(days),
      windowEnd: DMARC_FIXED_TIME,
      latestReportAt: "2026-08-02T03:30:00.000Z",
      reportingDays: 2,
      reportCount: 1,
      totalMessages: 5_000,
      sourceCount: 1,
      sourceListTruncated: false,
      alignment: {
        bothPass: 4_990,
        dkimOnlyPass: 0,
        spfOnlyPass: 5,
        neitherPass: 5,
        alignedPct: 0.999,
      },
      disposition: { none: 5_000, quarantine: 0, reject: 0, unknown: 0 },
      topSources: [source],
      topFailingSources: [],
      suggestions: [],
      series: [
        { date: "2026-08-01", messages: 2_000, aligned: 1_998, alignedPct: 0.999 },
        { date: "2026-08-02", messages: 3_000, aligned: 2_997, alignedPct: 0.999 },
      ],
      ...(domain ? { latestPolicy: "reject" } : {}),
    };
  }

  if (mode === "stale-race" && days === 7) {
    const source = {
      sourceIp: "203.0.113.77",
      messages: 777,
      dkimPass: 400,
      spfPass: 177,
      bothPass: 0,
      alignedPct: 577 / 777,
      primaryDisposition: "quarantine",
      quarantined: 177,
      rejected: 100,
    };
    return {
      domain: domain ?? "",
      periodDays: 7,
      generatedAt: DMARC_FIXED_TIME,
      windowStart: startForDays(7),
      windowEnd: DMARC_FIXED_TIME,
      latestReportAt: "2026-08-02T04:20:00.000Z",
      reportingDays: 1,
      reportCount: 7,
      totalMessages: 777,
      sourceCount: 1,
      sourceListTruncated: false,
      alignment: {
        bothPass: 400,
        dkimOnlyPass: 100,
        spfOnlyPass: 77,
        neitherPass: 200,
        alignedPct: 577 / 777,
      },
      disposition: { none: 500, quarantine: 177, reject: 100, unknown: 0 },
      topSources: [source],
      topFailingSources: [source],
      suggestions: [
        {
          code: "alignment_low",
          severity: "action",
          action: "Review the latest seven-day source mix.",
          reason:
            "One hundred messages lacked aligned SPF and aligned DKIM in this bounded seven-day snapshot.",
        },
      ],
      series: [
        {
          date: "2026-08-02",
          messages: 777,
          aligned: 577,
          alignedPct: 577 / 777,
        },
      ],
      ...(domain ? { latestPolicy: "reject" } : {}),
    };
  }

  return riskyInsights(domain, days);
}

function sourceDetailPayload(
  ip: string,
  domain: string | undefined,
  days: number,
): JsonRecord | null {
  const source = SOURCE_ROWS.find((candidate) => candidate.sourceIp === ip);
  if (!source || source.sourceIp !== DMARC_PRIMARY_SOURCE) return null;
  const perReport = Array.from({ length: 200 }, (_, offset) => {
    const sequence = offset + 1;
    const prefix = sequence.toString(16).padStart(6, "0");
    const suffix = sequence.toString(16).padStart(12, "0");
    const dateEnd = new Date(
      Date.parse("2026-08-02T00:00:00.000Z") - offset * 30 * 60 * 1_000,
    );
    return {
      reportId: `dc${prefix}-0000-4000-8000-${suffix}`,
      orgName: `Source Receiver ${sequence.toString().padStart(3, "0")}`,
      dateBegin: new Date(dateEnd.getTime() - 15 * 60 * 1_000).toISOString(),
      dateEnd: dateEnd.toISOString(),
      messages: 35,
      dkimPass: 20,
      spfPass: 15,
      bothPass: 5,
      alignedPct: 30 / 35,
      primaryDisposition: sequence % 2 === 0 ? "quarantine" : "reject",
    };
  });
  return {
    sourceIp: ip,
    periodDays: days,
    ...(domain ? { domain } : {}),
    generatedAt: DMARC_FIXED_TIME,
    windowStart: startForDays(days),
    windowEnd: DMARC_FIXED_TIME,
    hasMore: true,
    summary: source,
    perReport,
  };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => {
        const normalized = name.toLowerCase();
        if (normalized === "authorization" || normalized === "cookie") {
          return [name, `sha256:${sha256(value)};length:${value.length}`];
        }
        return [name, value];
      }),
  );
}

async function requestEvidence(
  route: Route,
  order: number,
): Promise<DmarcRequestEvidence> {
  const request = route.request();
  const url = new URL(request.url());
  return {
    body: request.postData(),
    headers: safeHeaders(await request.allHeaders()),
    method: request.method(),
    order,
    pathname: url.pathname,
    resourceType: request.resourceType(),
    search: url.search,
  };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "cache-control": "no-store, private",
      expires: "0",
      pragma: "no-cache",
    },
    body: JSON.stringify(body),
  });
}

function controlPayload(pathname: string): JsonRecord | null {
  if (pathname === "/api/v1/auth/me") {
    return {
      user_id: "da400000-0000-4000-8000-000000000001",
      tenant_id: DMARC_TENANT_ID,
      email: "dmarc-auditor@example.invalid",
      role: "admin",
      effective_role: "admin",
      auth_provider: "password",
      email_verified: true,
      workspace_name: "DMARC evidence",
      workspace_slug: "dmarc-evidence",
    };
  }
  if (pathname === "/api/v1/me") {
    return {
      user: "dmarc-auditor@example.invalid",
      tenant: DMARC_TENANT_ID,
    };
  }
  if (pathname === "/api/v1/api-keys/me") {
    return {
      tenant_id: DMARC_TENANT_ID,
      tenant_slug: "dmarc-evidence",
      scopes: ["admin"],
      actor: "DMARC evidence browser harness",
    };
  }
  if (pathname === "/api/v1/audit/my-scopes") {
    return {
      scopes: ["audit:read", "audit:read_pii"],
      auditScopes: ["audit:read", "audit:read_pii"],
      isAdmin: true,
    };
  }
  if (pathname === "/api/v1/health" || pathname === "/api/health") {
    return { status: "ok", service: "api", version: "dmarc-evidence" };
  }
  if (pathname === "/api/v1/onboarding-progress") {
    return { steps: [], completed: 0, total: 0, percent: 0, all_done: false };
  }
  if (pathname === "/api/v1/dashboard/layout") {
    return {
      userId: "dmarc-evidence-user",
      tenantId: DMARC_TENANT_ID,
      order: DASHBOARD_LAYOUT_ORDER,
      updatedAt: DMARC_FIXED_TIME,
    };
  }
  return null;
}

function queryKeys(url: URL): string[] {
  return [...url.searchParams.keys()];
}

function hasExactKeys(url: URL, expected: readonly string[]): boolean {
  const actual = queryKeys(url);
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function requestSummary(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  const record = args as Record<string, unknown>;
  if (Array.isArray(record["chunk"])) {
    return {
      transferId: record["transferId"],
      offset: record["offset"],
      chunkBytes: record["chunk"].length,
      chunkSha256: sha256(Uint8Array.from(record["chunk"] as number[])),
    };
  }
  if (record["request"] && typeof record["request"] === "object") {
    const request = record["request"] as Record<string, unknown>;
    return {
      request: {
        targetPath: request["targetPath"],
        expectedBytes: request["expectedBytes"],
      },
    };
  }
  if (record["options"] && typeof record["options"] === "object") {
    const options = record["options"] as Record<string, unknown>;
    return {
      options: {
        title: options["title"],
        defaultPath: options["defaultPath"],
        filters: options["filters"],
      },
    };
  }
  return { keys: Object.keys(record).sort() };
}

async function installNativeExportBridge(
  page: Page,
  harness: DmarcHarness,
  getSaveMode: () => DmarcSaveMode,
): Promise<void> {
  let nativeOrder = 0;
  let expectedBytes = 0;
  let targetPath = "/deterministic/dmarc-evidence.csv";
  let chunks: number[] = [];

  await page.exposeBinding(
    "__dmarcNativeEvidence",
    (_source, payload: { args?: unknown; command: string }) => {
      nativeOrder += 1;
      harness.nativeCalls.push({
        command: payload.command,
        order: nativeOrder,
        summary: requestSummary(payload.args),
      });
      if (payload.command === "plugin:dialog|save") {
        return getSaveMode() === "cancelled" ? null : targetPath;
      }
      if (payload.command === "transfer_begin_save") {
        const args = payload.args as {
          request?: { expectedBytes?: number; targetPath?: string };
        };
        expectedBytes = args.request?.expectedBytes ?? 0;
        targetPath = args.request?.targetPath ?? targetPath;
        chunks = [];
        return {
          transferId: "dmarc-evidence-transfer",
          collision: false,
        };
      }
      if (payload.command === "transfer_write_chunk") {
        const args = payload.args as { chunk?: number[]; offset?: number };
        const next = args.chunk ?? [];
        if ((args.offset ?? -1) !== chunks.length) {
          throw new Error("DMARC export chunks arrived out of order.");
        }
        chunks.push(...next);
        return { writtenBytes: chunks.length, expectedBytes };
      }
      if (payload.command === "transfer_finish_save") {
        const bytes = Uint8Array.from(chunks);
        const content = new TextDecoder().decode(bytes);
        harness.exports.push({
          byteLength: bytes.byteLength,
          content,
          path: targetPath,
          sha256: sha256(bytes),
        });
        return null;
      }
      if (payload.command === "transfer_cancel_save") return null;
      throw new Error(`Unexpected DMARC native bridge command: ${payload.command}`);
    },
  );

  await page.addInitScript(() => {
    type NativeBridge = (payload: {
      args?: unknown;
      command: string;
    }) => Promise<unknown>;
    type TauriInternals = {
      invoke: (command: string, args?: unknown) => Promise<unknown>;
      [key: string]: unknown;
    };
    const host = window as unknown as {
      __dmarcNativeEvidence: NativeBridge;
      __TAURI_INTERNALS__?: TauriInternals;
    };
    const current = host.__TAURI_INTERNALS__;
    if (!current) throw new Error("DMARC harness could not find Tauri internals.");
    const originalInvoke = current.invoke.bind(current);
    const intercepted = new Set([
      "plugin:dialog|save",
      "transfer_begin_save",
      "transfer_write_chunk",
      "transfer_finish_save",
      "transfer_cancel_save",
    ]);
    Object.defineProperty(host, "__TAURI_INTERNALS__", {
      configurable: true,
      writable: false,
      value: {
        ...current,
        invoke: async (command: string, args?: unknown): Promise<unknown> =>
          intercepted.has(command)
            ? host.__dmarcNativeEvidence({ command, args })
            : originalInvoke(command, args),
      } satisfies TauriInternals,
    });
  });
}

export async function installDmarcHarness(
  page: Page,
  mode: DmarcFixtureMode,
): Promise<DmarcHarness> {
  let requestOrder = 0;
  let saveMode: DmarcSaveMode = "saved";
  let raceReleased = false;
  let releaseRace: (() => void) | null = null;
  const raceGate = new Promise<void>((resolve) => {
    releaseRace = resolve;
  });
  const harness: DmarcHarness = {
    a11yRuns: [],
    apiAborts: [],
    assetFailures: [],
    controls: [],
    dmarcReads: [],
    expectedConsoleErrors: [],
    expectedHttpFailures: [],
    exports: [],
    nativeCalls: [],
    productMutations: [],
    requests: [],
    runtimeErrors: [],
    suggestionAcknowledgements: [],
    unexpectedRequests: [],
    releaseInitialRace: () => {
      if (raceReleased || releaseRace === null) {
        throw new Error("The initial DMARC race gate was already released.");
      }
      raceReleased = true;
      releaseRace();
      releaseRace = null;
    },
    setSaveMode: (next) => {
      saveMode = next;
    },
  };

  await installNativeExportBridge(page, harness, () => saveMode);

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (
      /(?:status of 500|500 \(Internal Server Error\))/u.test(text) &&
      harness.expectedHttpFailures.length > 0
    ) {
      harness.expectedConsoleErrors.push(text);
      return;
    }
    harness.runtimeErrors.push(`console: ${text}`);
  });
  page.on("pageerror", (error) => {
    harness.runtimeErrors.push(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request: Request) => {
    const url = new URL(request.url());
    const failure = request.failure()?.errorText ?? "unknown request failure";
    if (url.pathname.startsWith("/api/") && failure.includes("ERR_ABORTED")) {
      harness.apiAborts.push(`${request.method()} ${url.pathname}${url.search}: ${failure}`);
      return;
    }
    harness.assetFailures.push(
      `${request.resourceType()} ${request.method()} ${url.pathname}${url.search}: ${failure}`,
    );
  });
  page.on("response", (response) => {
    const request = response.request();
    const url = new URL(response.url());
    if (
      response.status() >= 400 &&
      !url.pathname.startsWith("/api/") &&
      request.resourceType() !== "document"
    ) {
      harness.assetFailures.push(
        `${request.resourceType()} ${request.method()} ${url.pathname}${url.search}: HTTP ${response.status()}`,
      );
    }
  });

  const handler = async (route: Route): Promise<void> => {
    requestOrder += 1;
    const evidence = await requestEvidence(route, requestOrder);
    harness.requests.push(evidence);
    const url = new URL(route.request().url());
    const { method, pathname } = evidence;

    const control = controlPayload(pathname);
    if (control !== null && method === "GET" && url.search === "") {
      harness.controls.push(evidence);
      await json(route, control);
      return;
    }
    if (
      pathname === "/api/v1/streams/token" &&
      method === "POST" &&
      url.search === "" &&
      evidence.body === null
    ) {
      harness.controls.push(evidence);
      await json(route, {
        token: "dmarc-evidence-stream-token",
        expires_at: "2026-08-03T08:31:00.000Z",
        ttl_seconds: 60,
      });
      return;
    }
    if (
      pathname === "/api/v1/notifications" &&
      method === "GET" &&
      url.search === "?limit=50"
    ) {
      harness.controls.push(evidence);
      await json(route, { items: [], unread_count: 0 });
      return;
    }

    const isDmarc = pathname.startsWith("/api/v1/deliverability/dmarc-");
    if (method !== "GET") {
      if (isDmarc) harness.productMutations.push(evidence);
      if (pathname.includes("dmarc-suggestions/ack")) {
        harness.suggestionAcknowledgements.push(evidence);
      }
      harness.unexpectedRequests.push(
        `${method} ${pathname}${url.search} (all product mutations are blocked)`,
      );
      await route.abort("blockedbyclient");
      return;
    }

    if (!isDmarc) {
      harness.unexpectedRequests.push(`${method} ${pathname}${url.search}`);
      await route.abort("blockedbyclient");
      return;
    }
    harness.dmarcReads.push(evidence);

    if (pathname === "/api/v1/deliverability/dmarc-reports") {
      const domain = url.searchParams.get("domain") ?? undefined;
      const from = url.searchParams.get("from");
      const to = url.searchParams.get("to");
      const limit = url.searchParams.get("limit");
      const expectedKeys = domain
        ? ["domain", "from", "to", "limit"]
        : ["from", "to", "limit"];
      if (
        !hasExactKeys(url, expectedKeys) ||
        !from ||
        to !== DMARC_FIXED_TIME ||
        limit !== "500" ||
        ![7, 30, 90, 365].some((days) => from === startForDays(days))
      ) {
        harness.unexpectedRequests.push(`${method} ${pathname}${url.search}`);
        await route.abort("blockedbyclient");
        return;
      }
      if (mode === "reports-500-insights-ok") {
        harness.expectedHttpFailures.push({
          method,
          order: evidence.order,
          pathname,
          search: url.search,
          status: 500,
        });
        await json(
          route,
          {
            error: {
              code: "dmarc_reports_unavailable",
              message: "The report receipt store is temporarily unavailable.",
              details: { diagnostic: DMARC_SECRET_CANARY },
            },
          },
          500,
        );
        return;
      }
      if (mode === "malformed-main") {
        await json(route, {
          items: [{ ...REPORT_ROWS[0], passCount: -1 }],
          meta: {
            ...(reportsPayload("risky", domain, from, to)["meta"] as JsonRecord),
            returned: 1,
          },
          diagnostic: DMARC_SECRET_CANARY,
        });
        return;
      }
      if (mode === "stale-race" && from === startForDays(30)) {
        await raceGate;
      }
      await json(route, reportsPayload(mode, domain, from, to));
      return;
    }

    if (pathname === "/api/v1/deliverability/dmarc-insights") {
      const domain = url.searchParams.get("domain") ?? undefined;
      const rawDays = url.searchParams.get("days");
      const days = rawDays === null ? Number.NaN : Number(rawDays);
      const expectedKeys = domain ? ["domain", "days"] : ["days"];
      if (!hasExactKeys(url, expectedKeys) || ![7, 30, 90, 365].includes(days)) {
        harness.unexpectedRequests.push(`${method} ${pathname}${url.search}`);
        await route.abort("blockedbyclient");
        return;
      }
      if (mode === "reports-ok-insights-500") {
        harness.expectedHttpFailures.push({
          method,
          order: evidence.order,
          pathname,
          search: url.search,
          status: 500,
        });
        await json(
          route,
          {
            error: {
              code: "dmarc_insights_unavailable",
              message: "Aggregate insights are temporarily unavailable.",
              details: { diagnostic: DMARC_SECRET_CANARY },
            },
          },
          500,
        );
        return;
      }
      if (mode === "malformed-main") {
        const malformed = insightsPayload("risky", domain, days);
        await json(route, {
          ...malformed,
          alignment: {
            ...(malformed["alignment"] as JsonRecord),
            alignedPct: 1.25,
          },
          diagnostic: DMARC_SECRET_CANARY,
        });
        return;
      }
      if (mode === "stale-race" && days === 30) await raceGate;
      await json(route, insightsPayload(mode, domain, days));
      return;
    }

    if (pathname === "/api/v1/deliverability/dmarc-sources") {
      const ip = url.searchParams.get("ip");
      const domain = url.searchParams.get("domain") ?? undefined;
      const rawDays = url.searchParams.get("days");
      const days = rawDays === null ? Number.NaN : Number(rawDays);
      const expectedKeys = domain ? ["ip", "domain", "days"] : ["ip", "days"];
      const payload =
        ip &&
        hasExactKeys(url, expectedKeys) &&
        [7, 30, 90, 365].includes(days)
          ? sourceDetailPayload(ip, domain, days)
          : null;
      if (!payload) {
        harness.unexpectedRequests.push(`${method} ${pathname}${url.search}`);
        await route.abort("blockedbyclient");
        return;
      }
      await json(route, payload);
      return;
    }

    harness.unexpectedRequests.push(`${method} ${pathname}${url.search}`);
    await route.abort("blockedbyclient");
  };

  // The shared visual fixture's broad `**/api/**` fallback also matches Vite
  // source-module URLs under `/src/lib/api/`. Let those modules reach Vite;
  // otherwise Chromium receives JSON in place of JavaScript and the shell
  // correctly refuses to execute it.
  await page.route("**/src/lib/api/**", async (route) => {
    await route.continue();
  });
  await page.route("**/api/v1/**", handler);
  await page.route("**/api/health", handler);
  return harness;
}

export async function openDmarc(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  options: {
    height?: number;
    mode?: DmarcFixtureMode;
    theme?: "system" | "dark" | "light";
    width?: number;
  } = {},
): Promise<DmarcHarness> {
  const mode = options.mode ?? "risky";
  await setTheme(page, options.theme ?? "dark");
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 1_000,
  });
  await bootApp(page);
  // The shared visual fixture still writes the retired boolean session key.
  // Current desktop boot requires the bounded, non-secret identity hint in
  // sessionStorage so an unavailable native-cookie transport can open the
  // offline-capable authenticated shell without inventing a live session.
  await page.addInitScript(
    ({ tenantId }: { tenantId: string }) => {
      window.sessionStorage.setItem(
        "postwave_session_user",
        JSON.stringify({
          user_id: "da400000-0000-4000-8000-000000000001",
          tenant_id: tenantId,
          role: "admin",
          effective_role: "admin",
          auth_provider: "password",
        }),
      );
      window.localStorage.setItem(
        `postwave_onboarding_dismissed_at:${tenantId}`,
        new Date().toISOString(),
      );
    },
    { tenantId: DMARC_TENANT_ID },
  );
  await page.clock.setFixedTime(new Date(DMARC_FIXED_TIME));
  const harness = await installDmarcHarness(page, mode);
  await page.goto("/app/dmarc");
  await waitForDmarcShell(page);

  const destination = page
    .getByRole("region", { name: "Insights & delivery" })
    .locator('button[data-section="dmarc"]');
  await expect(destination).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".dmarc-page")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "DMARC reports", level: 1 }),
  ).toBeVisible();

  if (mode === "zero") {
    await expect(
      page.getByRole("heading", {
        name: "No aggregate reports were ingested in this evidence window.",
      }),
    ).toBeVisible();
  } else if (mode === "malformed-main") {
    await expect(page.getByText("Report receipts response withheld")).toBeVisible();
    await expect(page.getByText("Aggregate insights response withheld")).toBeVisible();
  } else if (
    mode !== "stale-race" &&
    mode !== "reports-ok-insights-500" &&
    mode !== "reports-500-insights-ok"
  ) {
    const scopeReceipts = page.locator(".dmarc-scope__receipt");
    await expect(scopeReceipts).toHaveCount(2);
    await expect(scopeReceipts.nth(0)).toContainText(
      "Contract-valid insights snapshot",
    );
    await expect(scopeReceipts.nth(1)).toContainText(
      "Contract-valid report-list snapshot",
    );
  } else if (mode !== "stale-race") {
    await expect(page.locator(".dmarc-resource-notices")).toBeVisible();
  }
  return harness;
}

async function settleAnimations(locator: Locator): Promise<void> {
  await locator.evaluate(async (element) => {
    const finite = element
      .getAnimations({ subtree: true })
      .filter((animation) => {
        const end = animation.effect?.getComputedTiming().endTime;
        return typeof end === "number" && Number.isFinite(end);
      });
    await Promise.race([
      Promise.all(
        finite.map((animation) => animation.finished.catch(() => undefined)),
      ),
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, 1_500);
      }),
    ]);
  });
}

export async function auditDmarcA11y(
  page: Page,
  harness: DmarcHarness,
  label: string,
  selector = ".dmarc-page",
  options: { includeColorContrast?: boolean } = {},
): Promise<unknown[]> {
  const surface = page.locator(selector);
  await expect(surface).toBeVisible();
  await settleAnimations(surface);
  const hasAxe = await page.evaluate(() => "axe" in window);
  if (!hasAxe) await page.addScriptTag({ content: AXE_SOURCE });
  const violations = await page.evaluate(
    async ({ includeColorContrast, rootSelector }) => {
      const axe = (
        window as unknown as {
          axe: {
            run: (
              context: string,
              options: unknown,
            ) => Promise<{ violations: unknown[] }>;
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
      return result.violations;
    },
    {
      includeColorContrast: options.includeColorContrast ?? true,
      rootSelector: selector,
    },
  );
  harness.a11yRuns.push({ label, selector, violations });
  return violations;
}

export async function expectNoDmarcOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const route = document.querySelector<HTMLElement>(".dmarc-page");
    const dialog = document.querySelector<HTMLElement>(".dmarc-detail-slideover");
    return {
      body: document.body.scrollWidth - window.innerWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
      dialog: dialog ? dialog.scrollWidth - dialog.clientWidth : 0,
      document: document.documentElement.scrollWidth - window.innerWidth,
      route: route ? route.scrollWidth - route.clientWidth : 0,
      windowScroll: window.scrollX,
    };
  });
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.content).toBeLessThanOrEqual(1);
  expect(overflow.dialog).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.route).toBeLessThanOrEqual(1);
  expect(overflow.windowScroll).toBe(0);
}

export async function expectDmarcForcedColors(page: Page): Promise<void> {
  const colors = await page.evaluate(() => {
    const scope = document.querySelector<HTMLElement>(".dmarc-scope");
    const card = document.querySelector<HTMLElement>(".dmarc-card");
    const selected = document.querySelector<HTMLElement>(
      '.dmarc-workspace-tabs [role="tab"][aria-selected="true"]',
    );
    if (!scope || !card || !selected) {
      throw new Error("Missing DMARC forced-colors evidence target.");
    }
    const canvas = document.createElement("span");
    canvas.style.cssText =
      "color: CanvasText; background: Canvas; forced-color-adjust: none";
    const highlight = document.createElement("span");
    highlight.style.cssText =
      "color: HighlightText; background: Highlight; forced-color-adjust: none";
    document.body.append(canvas, highlight);
    const canvasStyle = getComputedStyle(canvas);
    const highlightStyle = getComputedStyle(highlight);
    const scopeStyle = getComputedStyle(scope);
    const cardStyle = getComputedStyle(card);
    const selectedStyle = getComputedStyle(selected);
    const result = {
      actual: {
        cardBackground: cardStyle.backgroundColor,
        scopeBackground: scopeStyle.backgroundColor,
        selectedOutline: selectedStyle.outlineColor,
      },
      expected: {
        canvas: canvasStyle.backgroundColor,
        highlight: highlightStyle.backgroundColor,
      },
    };
    canvas.remove();
    highlight.remove();
    return result;
  });
  expect(colors.actual.cardBackground).toBe(colors.expected.canvas);
  expect(colors.actual.scopeBackground).toBe(colors.expected.canvas);
  expect(colors.actual.selectedOutline).toBe(colors.expected.highlight);
}

export async function expectDmarcReducedMotion(page: Page): Promise<void> {
  const animation = await page.locator(".dmarc-page").evaluate((element) => {
    const active = element
      .getAnimations({ subtree: true })
      .filter((candidate) => candidate.playState === "running")
      .map((candidate) => candidate.effect?.getComputedTiming().duration ?? 0);
    return { active };
  });
  expect(animation.active).toEqual([]);
}

export async function expectDmarcSafety(
  page: Page,
  harness: DmarcHarness,
): Promise<void> {
  expect(harness.unexpectedRequests).toEqual([]);
  expect(harness.productMutations).toEqual([]);
  expect(harness.suggestionAcknowledgements).toEqual([]);
  expect(harness.runtimeErrors).toEqual([]);
  expect(harness.assetFailures).toEqual([]);
  expect(harness.requests.map(({ order }) => order)).toEqual(
    harness.requests.map((_, index) => index + 1),
  );
  for (const request of harness.requests) {
    expect(Object.keys(request.headers)).toEqual(
      [...Object.keys(request.headers)].sort((left, right) =>
        left.localeCompare(right),
      ),
    );
  }
  for (const request of harness.dmarcReads) {
    expect(request.method).toBe("GET");
    expect(request.body).toBeNull();
    expect(request.headers["accept"]).toBe("application/json");
    expect(request.headers["x-postwave-client"]).toBe("desktop");
    const authorization = request.headers["authorization"];
    if (authorization !== undefined) {
      expect(authorization).toMatch(/^sha256:[0-9a-f]{64};length:\d+$/u);
    }
    expect(JSON.stringify(request.headers)).not.toContain("test-key");
  }
  expect(harness.dmarcReads.length).toBeGreaterThanOrEqual(2);
  const rendered = await page.locator("body").innerText();
  expect(rendered).not.toContain(DMARC_SECRET_CANARY);
}

export async function scrollDmarcTargetIntoFrame(
  page: Page,
  target: Locator,
  viewportTop = 96,
): Promise<void> {
  await expect(page.locator(".content")).toBeVisible();
  await expect(target).toBeVisible();
  await expect
    .poll(async () =>
      target.evaluate(async (element, top) => {
        const owner = document.querySelector<HTMLElement>(".content");
        if (!owner) throw new Error("Missing shell content scroll owner.");
        const requested = Math.max(
          0,
          element.getBoundingClientRect().top + owner.scrollTop - top,
        );
        owner.scrollTo({ top: requested, behavior: "instant" });
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        const bounds = element.getBoundingClientRect();
        return bounds.bottom > 72 && bounds.top < window.innerHeight - 72;
      }, viewportTop),
    )
    .toBe(true);
}

export async function resetDmarcScroll(page: Page): Promise<void> {
  const content = page.locator(".content");
  await content.evaluate((element) => {
    element.scrollTo({ top: 0, behavior: "instant" });
  });
  await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBe(0);
}

export async function captureDmarcEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  harness: DmarcHarness,
): Promise<void> {
  await expect(
    page.getByText(DASHBOARD_LAYOUT_ERROR, { exact: true }),
  ).toHaveCount(0);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const screenshotPath = join(EVIDENCE_DIR, `${name}.png`);
  await page.screenshot({
    path: screenshotPath,
    animations: "disabled",
    caret: "hide",
    fullPage: false,
  });

  const metadata = testInfo.config.metadata as Record<string, unknown>;
  const baseCommitSha =
    typeof metadata["dmarcBaseCommitSha"] === "string"
      ? metadata["dmarcBaseCommitSha"]
      : "unavailable";
  const media = await page.evaluate(() => ({
    colorScheme: matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
    forcedColors: matchMedia("(forced-colors: active)").matches,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  }));
  const receipt = {
    schemaVersion: 1,
    evidenceMode: EVIDENCE_MODE,
    baseCommitSha,
    command:
      `PW_EVIDENCE_MODE=${EVIDENCE_MODE} pnpm exec playwright test ` +
      "--config tests/e2e/dmarc.playwright.config.ts",
    declaredPlaywrightTestCount: DECLARED_PLAYWRIGHT_TEST_COUNT,
    fixedTimeUtc: DMARC_FIXED_TIME,
    timezoneId: "UTC",
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    project: testInfo.project.name,
    report: `../reports/${EVIDENCE_MODE}.json`,
  };
  const requestLedgerPath = join(EVIDENCE_DIR, `${name}.requests.json`);
  const qualityPath = join(EVIDENCE_DIR, `${name}.quality.json`);
  const exportPath = join(EVIDENCE_DIR, `${name}.exports.json`);
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
            ? "pnpm exec vite --port 1437 --strictPort"
            : "pnpm build && pnpm exec vite preview --port 1438 --strictPort",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    requestLedgerPath,
    `${JSON.stringify(
      {
        ...receipt,
        capturedAtFixedUtc: DMARC_FIXED_TIME,
        url: page.url(),
        viewport: page.viewportSize(),
        media,
        requests: harness.requests,
        controls: harness.controls,
        dmarcReads: harness.dmarcReads,
        productMutations: harness.productMutations,
        suggestionAcknowledgements: harness.suggestionAcknowledgements,
        expectedHttpFailures: harness.expectedHttpFailures,
        unexpectedRequests: harness.unexpectedRequests,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    qualityPath,
    `${JSON.stringify(
      {
        ...receipt,
        a11yRuns: harness.a11yRuns,
        runtimeErrors: harness.runtimeErrors,
        expectedConsoleErrors: harness.expectedConsoleErrors,
        assetFailures: harness.assetFailures,
        apiAborts: harness.apiAborts,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    exportPath,
    `${JSON.stringify(
      {
        ...receipt,
        nativeCalls: harness.nativeCalls,
        exports: harness.exports,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" });
  await testInfo.attach(`${name}-requests`, {
    path: requestLedgerPath,
    contentType: "application/json",
  });
  await testInfo.attach(`${name}-quality`, {
    path: qualityPath,
    contentType: "application/json",
  });
}
