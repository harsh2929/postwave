import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ConsoleMessage,
  Locator,
  Page,
  Route,
  TestInfo,
} from "@playwright/test";
import { expect } from "@playwright/test";

import { waitForPrimaryNavigation } from "../visual/fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export type CustomDomainsEvidenceMode = "source" | "optimized";

function evidenceMode(): CustomDomainsEvidenceMode {
  const mode = process.env["PW_EVIDENCE_MODE"] ?? "optimized";
  if (mode !== "source" && mode !== "optimized") {
    throw new Error(
      `PW_EVIDENCE_MODE must be source or optimized; received ${mode}`,
    );
  }
  return mode;
}

const EVIDENCE_MODE = evidenceMode();
const EVIDENCE_DIR = fileURLToPath(
  new URL(
    `../../../../.audit-screenshots/custom-domains-evidence/${EVIDENCE_MODE}/`,
    import.meta.url,
  ),
);

export const CUSTOM_DOMAINS_FIXED_TIME = "2026-08-03T08:30:00.000Z";
export const CUSTOM_DOMAINS_TENANT_ID = "c1000000-0000-4000-8000-000000000001";
export const PENDING_DOMAIN_ID = "d1000000-0000-4000-8000-000000000001";
export const VERIFIED_DOMAIN_ID = "d1000000-0000-4000-8000-000000000002";
export const PENDING_DOMAIN_NAME = "forms.northstar.example";
export const VERIFIED_DOMAIN_NAME = "links.atlas.example";
export const CUSTOM_DOMAINS_SECRET_CANARY =
  "custom-domains-backend-secret-must-never-render";

const DECLARED_PLAYWRIGHT_TEST_COUNT = 5;
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

const PENDING_DOMAIN = {
  id: PENDING_DOMAIN_ID,
  tenantId: CUSTOM_DOMAINS_TENANT_ID,
  domain: PENDING_DOMAIN_NAME,
  purpose: "forms",
  verified: false,
  dns_records: [
    {
      type: "CNAME",
      name: PENDING_DOMAIN_NAME,
      value: "edge.moosewave.com",
      verified: false,
    },
    {
      type: "TXT",
      name: `_postwave-verify.${PENDING_DOMAIN_NAME}`,
      value: "pw-verify=0123456789abcdef0123456789abcdef",
      verified: false,
      error: "TXT lookup failed",
    },
  ],
  createdAt: "2026-07-29T10:15:00.000Z",
  verifiedAt: null,
} as const;

const VERIFIED_DOMAIN = {
  id: VERIFIED_DOMAIN_ID,
  tenantId: CUSTOM_DOMAINS_TENANT_ID,
  domain: VERIFIED_DOMAIN_NAME,
  purpose: "links",
  verified: true,
  dns_records: [
    {
      type: "CNAME",
      name: VERIFIED_DOMAIN_NAME,
      value: "edge.moosewave.com",
      verified: true,
    },
    {
      type: "TXT",
      name: `_postwave-verify.${VERIFIED_DOMAIN_NAME}`,
      value: "pw-verify=fedcba9876543210fedcba9876543210",
      verified: true,
    },
  ],
  createdAt: "2026-07-31T14:45:00.000Z",
  verifiedAt: "2026-08-02T06:20:00.000Z",
} as const;

const TRACKING_DOMAIN = {
  id: "d1000000-0000-4000-8000-000000000003",
  tenantId: CUSTOM_DOMAINS_TENANT_ID,
  domain: "events.cascade.example",
  purpose: "tracking",
  verified: false,
  dns_records: [
    {
      type: "CNAME",
      name: "events.cascade.example",
      value: "edge.moosewave.com",
      verified: false,
    },
    {
      type: "TXT",
      name: "_postwave-verify.events.cascade.example",
      value: "pw-verify=00112233445566778899aabbccddeeff",
      verified: false,
    },
  ],
  createdAt: "2026-07-24T09:10:00.000Z",
  verifiedAt: null,
} as const;

const POPULATED_DOMAINS = [
  VERIFIED_DOMAIN,
  PENDING_DOMAIN,
  TRACKING_DOMAIN,
] as const;

const VERIFIED_TRANSITION = {
  verified: true,
  records: [
    {
      type: "CNAME",
      name: PENDING_DOMAIN_NAME,
      value: "edge.moosewave.com",
      verified: true,
    },
    {
      type: "TXT",
      name: `_postwave-verify.${PENDING_DOMAIN_NAME}`,
      value: "pw-verify=0123456789abcdef0123456789abcdef",
      verified: true,
    },
  ],
} as const;

const VERIFIED_PENDING_DOMAIN = {
  ...PENDING_DOMAIN,
  verified: true,
  dns_records: VERIFIED_TRANSITION.records,
  verifiedAt: CUSTOM_DOMAINS_FIXED_TIME,
} as const;

export type CustomDomainsFixtureMode =
  | "populated"
  | "empty"
  | "request-failure"
  | "malformed-contract";

export interface CustomDomainsRequestEvidence {
  body: string | null;
  method: string;
  pathname: string;
  search: string;
}

export interface CustomDomainsHttpFailureEvidence {
  method: "GET";
  pathname: string;
  status: number;
}

export interface CustomDomainsHarness {
  armVerification: (domainId?: string) => void;
  controls: CustomDomainsRequestEvidence[];
  detailReads: CustomDomainsRequestEvidence[];
  expectedHttpFailures: CustomDomainsHttpFailureEvidence[];
  expectedNetworkErrors: string[];
  mutations: CustomDomainsRequestEvidence[];
  releaseVerification: () => void;
  requests: CustomDomainsRequestEvidence[];
  runtimeErrors: string[];
  unexpectedRequests: string[];
  verificationMutations: CustomDomainsRequestEvidence[];
}

type BootApp = (page: Page) => Promise<void>;
type SetTheme = (
  page: Page,
  theme: "system" | "dark" | "light",
) => Promise<void>;

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "cache-control": "no-store" },
    body: JSON.stringify(body),
  });
}

function requestEvidence(route: Route): CustomDomainsRequestEvidence {
  const request = route.request();
  const url = new URL(request.url());
  return {
    body: request.postData(),
    method: request.method(),
    pathname: url.pathname,
    search: url.search,
  };
}

function domainDetail(id: string): (typeof POPULATED_DOMAINS)[number] | null {
  return POPULATED_DOMAINS.find((domain) => domain.id === id) ?? null;
}

function customDomainRoute(
  pathname: string,
): { kind: "list" } | { kind: "detail" | "verify"; id: string } | null {
  if (pathname === "/api/v1/custom-domains") return { kind: "list" };
  const segments = pathname.split("/").filter(Boolean);
  if (
    segments.length !== 4 &&
    !(segments.length === 5 && segments[4] === "verify")
  ) {
    return null;
  }
  if (
    segments[0] !== "api" ||
    segments[1] !== "v1" ||
    segments[2] !== "custom-domains"
  ) {
    return null;
  }
  let id: string;
  try {
    id = decodeURIComponent(segments[3] ?? "");
  } catch {
    return null;
  }
  if (!id || id.includes("/") || id.includes("\\")) return null;
  return segments.length === 5
    ? { kind: "verify", id }
    : { kind: "detail", id };
}

export async function installCustomDomainsHarness(
  page: Page,
  mode: CustomDomainsFixtureMode,
): Promise<CustomDomainsHarness> {
  let armedDomainId: string | null = null;
  let verificationGate: Promise<void> = Promise.resolve();
  let releaseVerificationGate: (() => void) | null = null;
  let pendingDomainVerified = false;
  const pendingConsoleFailures: CustomDomainsHttpFailureEvidence[] = [];
  const harness: CustomDomainsHarness = {
    armVerification: (domainId = PENDING_DOMAIN_ID) => {
      if (armedDomainId !== null || releaseVerificationGate !== null) {
        throw new Error("A verification mutation is already armed.");
      }
      armedDomainId = domainId;
      verificationGate = new Promise<void>((resolve) => {
        releaseVerificationGate = resolve;
      });
    },
    controls: [],
    detailReads: [],
    expectedHttpFailures: [],
    expectedNetworkErrors: [],
    mutations: [],
    releaseVerification: () => {
      if (releaseVerificationGate === null) {
        throw new Error("No verification mutation is waiting for release.");
      }
      const release = releaseVerificationGate;
      releaseVerificationGate = null;
      release();
    },
    requests: [],
    runtimeErrors: [],
    unexpectedRequests: [],
    verificationMutations: [],
  };

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    const text = message.text();
    const statusMatch = /status of (\d{3})/u.exec(text);
    const status = statusMatch ? Number(statusMatch[1]) : null;
    const expectedIndex =
      status === null
        ? -1
        : pendingConsoleFailures.findIndex(
            (failure) => failure.status === status,
          );
    if (expectedIndex >= 0) {
      const [failure] = pendingConsoleFailures.splice(expectedIndex, 1);
      harness.expectedNetworkErrors.push(
        `${failure?.method ?? "GET"} ${failure?.pathname ?? "unknown"} -> ${status}: ${text}`,
      );
      return;
    }
    harness.runtimeErrors.push(`console: ${text}`);
  });
  page.on("pageerror", (error) => {
    harness.runtimeErrors.push(`pageerror: ${error.message}`);
  });

  // The shared fixture deliberately reports a Tauri environment. Make the
  // one copy operation exercised by this route deterministic without logging
  // an "unstubbed command" warning or touching the host clipboard.
  await page.addInitScript(() => {
    type TauriInternals = {
      invoke: (command: string, args?: unknown) => Promise<unknown>;
      [key: string]: unknown;
    };
    const host = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
    const current = host.__TAURI_INTERNALS__;
    if (!current) return;
    const originalInvoke = current.invoke.bind(current);
    Object.defineProperty(host, "__TAURI_INTERNALS__", {
      configurable: true,
      writable: false,
      value: {
        ...current,
        invoke: async (command: string, args?: unknown): Promise<unknown> => {
          if (command === "plugin:clipboard-manager|write_text") return null;
          return originalInvoke(command, args);
        },
      } satisfies TauriInternals,
    });
  });

  await page.route("**/src/lib/api/**", async (route) => {
    await route.continue();
  });

  await page.route("**/api/v1/**", async (route) => {
    const evidence = requestEvidence(route);
    const { method, pathname, search } = evidence;
    harness.requests.push(evidence);

    if (pathname === "/api/v1/auth/me" && method === "GET") {
      harness.controls.push(evidence);
      await json(route, {
        user_id: "c2000000-0000-4000-8000-000000000001",
        tenant_id: CUSTOM_DOMAINS_TENANT_ID,
        email: "custom-domains-admin@example.invalid",
        role: "admin",
        effective_role: "admin",
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Custom Domains evidence",
        workspace_slug: "custom-domains-evidence",
      });
      return;
    }
    if (pathname === "/api/v1/me" && method === "GET") {
      harness.controls.push(evidence);
      await json(route, {
        user: "custom-domains-admin@example.invalid",
        tenant: CUSTOM_DOMAINS_TENANT_ID,
      });
      return;
    }
    if (pathname === "/api/v1/audit/my-scopes" && method === "GET") {
      harness.controls.push(evidence);
      await json(route, {
        scopes: ["audit:read", "audit:read_pii"],
        auditScopes: ["audit:read", "audit:read_pii"],
        isAdmin: true,
      });
      return;
    }
    if (pathname === "/api/v1/health" && method === "GET") {
      harness.controls.push(evidence);
      await json(route, { status: "ok", service: "api", version: "evidence" });
      return;
    }
    if (pathname === "/api/v1/onboarding-progress" && method === "GET") {
      harness.controls.push(evidence);
      await json(route, {
        steps: [],
        completed: 0,
        total: 0,
        percent: 0,
        all_done: false,
      });
      return;
    }
    if (pathname === "/api/v1/dashboard/layout" && method === "GET") {
      harness.controls.push(evidence);
      await json(route, {
        userId: "custom-domains-evidence-user",
        tenantId: CUSTOM_DOMAINS_TENANT_ID,
        order: DASHBOARD_LAYOUT_ORDER,
        updatedAt: CUSTOM_DOMAINS_FIXED_TIME,
      });
      return;
    }
    if (pathname === "/api/v1/streams/token" && method === "POST") {
      // Token minting is a session-control request, not a product-state
      // mutation. It remains separately visible in every evidence ledger.
      harness.controls.push(evidence);
      await json(route, {
        token: "custom-domains-evidence-stream-token",
        expires_at: "2026-08-03T08:31:00.000Z",
        ttl_seconds: 60,
      });
      return;
    }

    const domainRoute = customDomainRoute(pathname);
    if (method !== "GET") harness.mutations.push(evidence);

    if (domainRoute?.kind === "verify" && method === "POST" && search === "") {
      const explicitlyAllowed =
        armedDomainId === domainRoute.id &&
        domainRoute.id === PENDING_DOMAIN_ID &&
        evidence.body === null &&
        harness.verificationMutations.length === 0;
      if (!explicitlyAllowed) {
        harness.unexpectedRequests.push(
          `${method} ${pathname}${search} (verification was not explicitly armed)`,
        );
        await json(
          route,
          {
            error: {
              code: "custom_domains_evidence_mutation_blocked",
              message: "Only the explicitly armed DNS verification is allowed.",
            },
          },
          405,
        );
        return;
      }
      armedDomainId = null;
      harness.verificationMutations.push(evidence);
      const gate = verificationGate;
      await gate;
      pendingDomainVerified = true;
      await json(route, VERIFIED_TRANSITION);
      return;
    }

    if (method !== "GET") {
      harness.unexpectedRequests.push(`${method} ${pathname}${search}`);
      await json(
        route,
        {
          error: {
            code: "custom_domains_evidence_mutation_blocked",
            message: "The evidence harness blocks every unapproved mutation.",
          },
        },
        405,
      );
      return;
    }

    if (domainRoute?.kind === "list" && search === "") {
      if (mode === "request-failure") {
        const failure: CustomDomainsHttpFailureEvidence = {
          method: "GET",
          pathname,
          status: 503,
        };
        harness.expectedHttpFailures.push(failure);
        pendingConsoleFailures.push(failure);
        await json(
          route,
          {
            error: {
              code: "custom_domains_temporarily_unavailable",
              message: "The registry is temporarily unavailable.",
              details: { diagnostic: CUSTOM_DOMAINS_SECRET_CANARY },
            },
          },
          503,
        );
        return;
      }
      if (mode === "malformed-contract") {
        await json(route, [
          {
            ...PENDING_DOMAIN,
            domain: `${CUSTOM_DOMAINS_SECRET_CANARY}.invalid`,
            verified: "yes",
          },
        ]);
        return;
      }
      await json(route, mode === "empty" ? [] : POPULATED_DOMAINS);
      return;
    }

    if (domainRoute?.kind === "detail" && search === "") {
      const detail =
        domainRoute.id === PENDING_DOMAIN_ID && pendingDomainVerified
          ? VERIFIED_PENDING_DOMAIN
          : domainDetail(domainRoute.id);
      if (detail) {
        harness.detailReads.push(evidence);
        await json(route, detail);
        return;
      }
    }

    harness.unexpectedRequests.push(`${method} ${pathname}${search}`);
    await json(
      route,
      {
        error: {
          code: "custom_domains_evidence_unexpected_request",
          message: "Only valid list, detail, and explicit verify routes exist.",
        },
      },
      404,
    );
  });

  return harness;
}

export async function openCustomDomains(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  options: {
    height?: number;
    mode?: CustomDomainsFixtureMode;
    theme?: "system" | "dark" | "light";
    width?: number;
  } = {},
): Promise<CustomDomainsHarness> {
  const mode = options.mode ?? "populated";
  await setTheme(page, options.theme ?? "dark");
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 1_000,
  });
  await page.clock.setFixedTime(new Date(CUSTOM_DOMAINS_FIXED_TIME));
  await bootApp(page);
  const harness = await installCustomDomainsHarness(page, mode);
  await page.goto("/app/domains");
  await waitForPrimaryNavigation(page);

  const destination = page
    .getByRole("region", { name: "Insights & delivery" })
    .locator('button[data-section="domains"]');
  await expect(destination).toHaveAttribute("aria-current", "page");
  await expect(page.locator(".custom-domains-route")).toBeVisible();

  if (mode === "populated") {
    await expect(
      page.getByRole("table", {
        name: "Registered custom hostnames and DNS ownership evidence",
      }),
    ).toBeVisible();
  } else if (mode === "empty") {
    await expect(
      page.getByRole("heading", { name: "The ownership registry is empty." }),
    ).toBeVisible();
  } else {
    await expect(page.locator(".cd-error-surface")).toBeVisible();
  }
  return harness;
}

async function settleAnimations(locator: Locator): Promise<void> {
  await locator.evaluate(async (element) => {
    const finiteAnimations = element
      .getAnimations({ subtree: true })
      .filter((animation) => {
        const endTime = animation.effect?.getComputedTiming().endTime;
        return typeof endTime === "number" && Number.isFinite(endTime);
      });
    await Promise.all(
      finiteAnimations.map((animation) =>
        animation.finished.catch(() => undefined),
      ),
    );
  });
}

export async function customDomainsAxeViolations(
  page: Page,
  selector = ".custom-domains-route",
  options: { includeColorContrast?: boolean } = {},
): Promise<unknown[]> {
  const surface = page.locator(selector);
  await expect(surface).toBeVisible();
  await settleAnimations(surface);
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(
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
}

export async function expectCustomDomainsForcedColors(
  page: Page,
): Promise<void> {
  const colors = await page.evaluate(() => {
    const hero = document.querySelector<HTMLElement>(".cd-hero");
    const metrics = document.querySelector<HTMLElement>(".cd-metrics");
    const activeFilter = document.querySelector<HTMLElement>(
      ".cd-filter-group button.is-active",
    );
    if (!hero || !metrics || !activeFilter) {
      throw new Error("Missing Custom Domains forced-color evidence target");
    }

    const probe = document.createElement("span");
    probe.style.cssText =
      "color: CanvasText; background: Canvas; border: 1px solid CanvasText; forced-color-adjust: none";
    const highlightProbe = document.createElement("span");
    highlightProbe.style.cssText =
      "color: HighlightText; background: Highlight; forced-color-adjust: none";
    document.body.append(probe, highlightProbe);

    const system = getComputedStyle(probe);
    const highlight = getComputedStyle(highlightProbe);
    const heroStyle = getComputedStyle(hero);
    const metricsStyle = getComputedStyle(metrics);
    const activeStyle = getComputedStyle(activeFilter);
    const result = {
      actual: {
        activeBackground: activeStyle.backgroundColor,
        activeColor: activeStyle.color,
        heroBackground: heroStyle.backgroundColor,
        heroBorder: heroStyle.borderTopColor,
        metricsBackground: metricsStyle.backgroundColor,
        metricsBorder: metricsStyle.borderTopColor,
      },
      expected: {
        canvas: system.backgroundColor,
        canvasText: system.color,
        highlight: highlight.backgroundColor,
        highlightText: highlight.color,
      },
    };
    probe.remove();
    highlightProbe.remove();
    return result;
  });

  expect(colors.actual).toEqual({
    activeBackground: colors.expected.highlight,
    activeColor: colors.expected.highlightText,
    heroBackground: colors.expected.canvas,
    heroBorder: colors.expected.canvasText,
    metricsBackground: colors.expected.canvas,
    metricsBorder: colors.expected.canvasText,
  });
}

export async function expectNoCustomDomainsOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const route = document.querySelector<HTMLElement>(".custom-domains-route");
    const dialog = document.querySelector<HTMLElement>(".cd-domain-slideover");
    const table = document.querySelector<HTMLElement>(".cd-table-shell");
    return {
      body: document.body.scrollWidth - window.innerWidth,
      content: content ? content.scrollWidth - content.clientWidth : 0,
      dialog: dialog ? dialog.scrollWidth - dialog.clientWidth : 0,
      document: document.documentElement.scrollWidth - window.innerWidth,
      route: route ? route.scrollWidth - route.clientWidth : 0,
      table: table ? table.scrollWidth - table.clientWidth : 0,
      windowScroll: window.scrollX,
    };
  });
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.content).toBeLessThanOrEqual(1);
  expect(overflow.dialog).toBeLessThanOrEqual(1);
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.route).toBeLessThanOrEqual(1);
  expect(overflow.table).toBeLessThanOrEqual(1);
  expect(overflow.windowScroll).toBe(0);
}

export async function expectCustomDomainsSafety(
  page: Page,
  harness: CustomDomainsHarness,
  options: { expectedVerifications?: number } = {},
): Promise<void> {
  const expectedVerifications = options.expectedVerifications ?? 0;
  expect(harness.unexpectedRequests).toEqual([]);
  expect(harness.runtimeErrors).toEqual([]);
  expect(harness.verificationMutations).toHaveLength(expectedVerifications);
  expect(harness.mutations).toEqual(harness.verificationMutations);
  for (const mutation of harness.verificationMutations) {
    expect(mutation).toEqual({
      body: null,
      method: "POST",
      pathname: `/api/v1/custom-domains/${PENDING_DOMAIN_ID}/verify`,
      search: "",
    });
  }
  if (expectedVerifications > 0) {
    expect(harness.detailReads).toEqual([
      {
        body: null,
        method: "GET",
        pathname: `/api/v1/custom-domains/${PENDING_DOMAIN_ID}`,
        search: "",
      },
    ]);
  } else {
    expect(harness.detailReads).toEqual([]);
  }
  expect(
    harness.requests.filter(
      ({ pathname }) => pathname === "/api/v1/custom-domains",
    ).length,
  ).toBeGreaterThanOrEqual(1);
  const rendered = await page.locator("body").innerText();
  expect(rendered).not.toContain(CUSTOM_DOMAINS_SECRET_CANARY);
}

export async function scrollCustomDomainsTargetIntoFrame(
  page: Page,
  target: Locator,
  viewportTop = 100,
): Promise<void> {
  await expect(page.locator(".content")).toBeVisible();
  await expect(target).toBeVisible();
  await expect
    .poll(async () =>
      target.evaluate(async (element, top) => {
        const scrollOwner = document.querySelector<HTMLElement>(".content");
        if (!scrollOwner) throw new Error("Missing shell content scroll owner");
        const requested = Math.max(
          0,
          element.getBoundingClientRect().top + scrollOwner.scrollTop - top,
        );
        scrollOwner.scrollTo({ top: requested, behavior: "instant" });
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        const bounds = element.getBoundingClientRect();
        return bounds.bottom > 72 && bounds.top < window.innerHeight - 72;
      }, viewportTop),
    )
    .toBe(true);
}

export async function resetCustomDomainsScroll(page: Page): Promise<void> {
  const content = page.locator(".content");
  await content.evaluate((element) => {
    element.scrollTo({ top: 0, behavior: "instant" });
  });
  await expect
    .poll(() => content.evaluate((element) => element.scrollTop))
    .toBe(0);
}

export async function captureCustomDomainsEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  harness: CustomDomainsHarness,
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
    typeof metadata["customDomainsBaseCommitSha"] === "string"
      ? metadata["customDomainsBaseCommitSha"]
      : "unavailable";
  const receipt = {
    schemaVersion: 1,
    evidenceMode: EVIDENCE_MODE,
    baseCommitSha,
    declaredPlaywrightTestCount: DECLARED_PLAYWRIGHT_TEST_COUNT,
    report: `../reports/${EVIDENCE_MODE}.json`,
  };
  const requestLedgerPath = join(EVIDENCE_DIR, `${name}.requests.json`);
  await writeFile(
    join(EVIDENCE_DIR, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    requestLedgerPath,
    `${JSON.stringify(
      {
        ...receipt,
        requests: harness.requests,
        controls: harness.controls,
        detailReads: harness.detailReads,
        mutations: harness.mutations,
        verificationMutations: harness.verificationMutations,
        expectedHttpFailures: harness.expectedHttpFailures,
        expectedNetworkErrors: harness.expectedNetworkErrors,
        unexpectedRequests: harness.unexpectedRequests,
        runtimeErrors: harness.runtimeErrors,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await testInfo.attach(name, {
    path: screenshotPath,
    contentType: "image/png",
  });
  await testInfo.attach(`${name}-requests`, {
    path: requestLedgerPath,
    contentType: "application/json",
  });
}
