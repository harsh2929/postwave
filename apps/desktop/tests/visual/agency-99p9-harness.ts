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

import {
  expect,
  unexpectedTauriCommands,
  waitForPrimaryNavigation,
} from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export const ROUTE47_FIXED_TIME = "2026-09-12T04:30:00.000Z";
export const ROUTE47_STANDARD_TENANT = "47474747-4747-4474-9474-474747474747";
export const ROUTE47_DEMO_TENANT = "00000000-0000-4000-8000-000000000099";
export const ROUTE47_DEMO_PROFILE =
  (process.env.VITE_BUILD_PROFILE ?? "visual-test").trim().toLowerCase() ===
  "demo";

export type AgencyEvidenceRole = "admin" | "viewer";
export type AgencyReadMode = "ok" | "error" | "malformed";
export type AgencyContinuationMode = "ok" | "error" | "loop" | "conflict";
export type AgencyTheme = "dark" | "light";

export interface AgencyRequestEvidence {
  method: string;
  pathname: string;
  search: string;
}

export interface AgencyEvidenceHarness {
  role: AgencyEvidenceRole;
  profile: "demo" | "standard";
  requests: AgencyRequestEvidence[];
  protectedRequests: AgencyRequestEvidence[];
  mutations: AgencyRequestEvidence[];
  unexpected: AgencyRequestEvidence[];
  externalRequests: string[];
  consoleErrors: string[];
  pageErrors: string[];
  setRosterReadMode: (mode: AgencyReadMode) => void;
  setBrandingReadMode: (mode: AgencyReadMode) => void;
  setContinuationMode: (mode: AgencyContinuationMode) => void;
  rosterReadCount: () => number;
  brandingReadCount: () => number;
}

interface OpenAgencyOptions {
  brandingReadMode?: AgencyReadMode;
  continuationMode?: AgencyContinuationMode;
  height?: number;
  role?: AgencyEvidenceRole;
  rosterReadMode?: AgencyReadMode;
  theme?: AgencyTheme;
  width?: number;
}

type BootApp = (page: Page) => Promise<void>;
type SetTheme = (page: Page, theme: "system" | AgencyTheme) => Promise<void>;

const CHILDREN_PATH = "/api/v1/agency/children";
const BRANDING_PATH = "/api/v1/agency/branding";
const PAGE_TWO_CURSOR = "route47_page_two";

function activeTenant(): string {
  return ROUTE47_DEMO_PROFILE ? ROUTE47_DEMO_TENANT : ROUTE47_STANDARD_TENANT;
}

function identity(role: AgencyEvidenceRole): Record<string, unknown> {
  const tenant = activeTenant();
  return {
    user_id: "47474747-4747-4474-8474-474747474747",
    tenant_id: tenant,
    email: `${role}@route47.example.invalid`,
    role,
    effective_role: role,
    auth_provider: "password",
    email_verified: true,
    workspace_name: ROUTE47_DEMO_PROFILE
      ? "Moosewave demo agency"
      : "Route 47 agency evidence",
    workspace_slug: ROUTE47_DEMO_PROFILE
      ? "postwave-demo-agency"
      : "route-47-agency",
  };
}

function agencyChild(
  suffix: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `47474747-4747-4474-9474-4747474747${suffix}`,
    slug: `route-47-client-${suffix}`,
    name: `Route 47 Client ${suffix}`,
    tier: "studio",
    parent_tenant_id: ROUTE47_STANDARD_TENANT,
    billing_mode: "parent",
    reseller_markup_bps: 1250,
    whitelabel_enabled: true,
    created_at: "2026-08-12T04:30:00.000Z",
    updated_at: "2026-09-11T04:30:00.000Z",
    ...overrides,
  };
}

const CHILD_ONE = agencyChild("01", {
  name: "Northstar Studio",
  slug: "northstar-studio",
  tier: "pro",
});
const CHILD_TWO = agencyChild("02", {
  name: "Acme Labs",
  slug: "acme-labs",
  tier: "sending",
  reseller_markup_bps: 1000,
});
const CHILD_THREE = agencyChild("03", {
  name: "Orbit Commerce",
  slug: "orbit-commerce",
  billing_mode: "self",
  reseller_markup_bps: 0,
  whitelabel_enabled: false,
});

const STANDARD_BRANDING = {
  whitelabel_enabled: true,
  brand_name: "Northstar Partner Cloud",
  custom_domain: "clients.northstar.example.com",
  logo_url: "https://assets.northstar.example.com/mark.svg",
  primary_color: "#7C183E",
  support_email: "support@northstar.example.com",
  legal_entity: "Northstar Media Ltd.",
  updated_at: "2026-09-11T05:06:07.123456Z",
  etag: `"agency-branding:${ROUTE47_STANDARD_TENANT}:v7"`,
} as const;

function receipt(request: Request): AgencyRequestEvidence {
  const url = new URL(request.url());
  return {
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
      "cache-control": "private, no-store",
      "x-postwave-context-epoch": "route47-evidence-epoch-1",
      "x-request-id": `route47-${String(status)}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function isAllowedAgencyRead(item: AgencyRequestEvidence): boolean {
  return (
    item.method === "GET" &&
    (item.pathname === CHILDREN_PATH || item.pathname === BRANDING_PATH)
  );
}

export async function installAgencyHarness(
  page: Page,
  {
    brandingReadMode: initialBrandingMode = "ok",
    continuationMode: initialContinuationMode = "ok",
    role = "admin",
    rosterReadMode: initialRosterMode = "ok",
  }: Pick<
    OpenAgencyOptions,
    "brandingReadMode" | "continuationMode" | "role" | "rosterReadMode"
  > = {},
): Promise<AgencyEvidenceHarness> {
  const requests: AgencyRequestEvidence[] = [];
  const protectedRequests: AgencyRequestEvidence[] = [];
  const mutations: AgencyRequestEvidence[] = [];
  const unexpected: AgencyRequestEvidence[] = [];
  const externalRequests: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  let rosterReadMode = initialRosterMode;
  let brandingReadMode = initialBrandingMode;
  let continuationMode = initialContinuationMode;
  let rosterReads = 0;
  let brandingReads = 0;

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !["localhost", "127.0.0.1"].includes(url.hostname)
    ) {
      externalRequests.push(request.url());
    }
  });

  await page.route(/^https?:\/\/[^/]+\/api\/.*$/u, async (route) => {
    const item = receipt(route.request());
    if (item.pathname === "/api/v1/auth/me") {
      await json(route, identity(role));
      return;
    }
    if (item.pathname.startsWith("/api/v1/agency")) {
      requests.push(item);
      protectedRequests.push(item);
      if (item.method !== "GET") mutations.push(item);
      if (!isAllowedAgencyRead(item)) unexpected.push(item);
    }

    if (item.pathname === CHILDREN_PATH && item.method === "GET") {
      rosterReads += 1;
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      if (ROUTE47_DEMO_PROFILE) {
        await json(route, { children: [], count: 0, has_more: false });
        return;
      }
      if (!cursor) {
        if (rosterReadMode === "error") {
          await json(
            route,
            { error: { code: "agency_roster_unavailable" } },
            503,
          );
          return;
        }
        if (rosterReadMode === "malformed") {
          await json(route, {
            children: [{ ...CHILD_ONE, parent_tenant_id: ROUTE47_DEMO_TENANT }],
            count: 1,
            has_more: false,
          });
          return;
        }
        await json(route, {
          children: [CHILD_ONE, CHILD_TWO],
          count: 2,
          has_more: true,
          next_cursor: PAGE_TWO_CURSOR,
        });
        return;
      }
      if (continuationMode === "error") {
        await json(
          route,
          { error: { code: "agency_roster_page_unavailable" } },
          503,
        );
        return;
      }
      if (continuationMode === "loop") {
        await json(route, {
          children: [CHILD_THREE],
          count: 1,
          has_more: true,
          next_cursor: cursor,
        });
        return;
      }
      if (continuationMode === "conflict") {
        await json(route, {
          children: [{ ...CHILD_THREE, slug: String(CHILD_ONE.slug) }],
          count: 1,
          has_more: false,
        });
        return;
      }
      await json(route, {
        children: [CHILD_ONE, CHILD_THREE],
        count: 2,
        has_more: false,
      });
      return;
    }

    if (item.pathname === BRANDING_PATH && item.method === "GET") {
      brandingReads += 1;
      if (ROUTE47_DEMO_PROFILE) {
        await json(route, {}, 200, {
          etag: `"agency-branding:${ROUTE47_DEMO_TENANT}:v1"`,
        });
        return;
      }
      if (brandingReadMode === "error") {
        await json(
          route,
          { error: { code: "agency_branding_unavailable" } },
          503,
        );
        return;
      }
      if (brandingReadMode === "malformed") {
        await json(route, { ...STANDARD_BRANDING, etag: "not-an-etag" }, 200, {
          etag: STANDARD_BRANDING.etag,
        });
        return;
      }
      await json(route, STANDARD_BRANDING, 200, {
        etag: STANDARD_BRANDING.etag,
      });
      return;
    }

    await route.fallback();
  });

  return {
    role,
    profile: ROUTE47_DEMO_PROFILE ? "demo" : "standard",
    requests,
    protectedRequests,
    mutations,
    unexpected,
    externalRequests,
    consoleErrors,
    pageErrors,
    setRosterReadMode: (mode) => {
      rosterReadMode = mode;
    },
    setBrandingReadMode: (mode) => {
      brandingReadMode = mode;
    },
    setContinuationMode: (mode) => {
      continuationMode = mode;
    },
    rosterReadCount: () => rosterReads,
    brandingReadCount: () => brandingReads,
  };
}

export async function openAgency(
  page: Page,
  bootApp: BootApp,
  setTheme: SetTheme,
  options: OpenAgencyOptions = {},
): Promise<AgencyEvidenceHarness> {
  const role = options.role ?? "admin";
  await setTheme(page, options.theme ?? "light");
  await page.setViewportSize({
    width: options.width ?? 1_440,
    height: options.height ?? 960,
  });
  await page.clock.setFixedTime(new Date(ROUTE47_FIXED_TIME));
  await bootApp(page);
  const harness = await installAgencyHarness(page, {
    brandingReadMode: options.brandingReadMode,
    continuationMode: options.continuationMode,
    role,
    rosterReadMode: options.rosterReadMode,
  });
  await page.goto("/app/agency");
  await waitForPrimaryNavigation(page, 60_000);

  if (role === "viewer") {
    await expect(page.locator(".capability-gate")).toBeVisible({
      timeout: 20_000,
    });
    return harness;
  }
  await expect(
    page.getByRole("heading", { name: "Agency", exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  return harness;
}

export async function seriousAgencyAxeViolations(
  page: Page,
  {
    disableColorContrast = false,
    root = ".agency-page",
  }: { disableColorContrast?: boolean; root?: string } = {},
): Promise<unknown[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(
    async ({ disableColorContrast, root }) => {
      const axe = (
        window as typeof window & {
          axe: {
            run: (
              owner: Element,
              options: {
                runOnly: { type: "tag"; values: string[] };
                rules?: Record<string, { enabled: boolean }>;
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
      const owner = document.querySelector(root);
      if (!owner) throw new Error(`Route 47 axe root is missing: ${root}`);
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
    },
    { disableColorContrast, root },
  );
}

export async function expectNoAgencyHorizontalOverflow(
  page: Page,
): Promise<void> {
  const overflow = await page.evaluate(() => {
    const content = document.querySelector<HTMLElement>(".content");
    const route = document.querySelector<HTMLElement>(".agency-page");
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

export async function expectAgencyHarnessClean(
  page: Page,
  harness: AgencyEvidenceHarness,
  allowedConsoleErrors: readonly string[] = [],
): Promise<void> {
  const unexpectedConsole = harness.consoleErrors.filter(
    (entry) => !allowedConsoleErrors.some((allowed) => entry.includes(allowed)),
  );
  expect(harness.mutations).toEqual([]);
  expect(harness.unexpected).toEqual([]);
  expect(harness.externalRequests).toEqual([]);
  expect(unexpectedConsole).toEqual([]);
  expect(harness.pageErrors).toEqual([]);
  expect(await unexpectedTauriCommands(page)).toEqual([]);
}

export async function saveAgencyEvidence(
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

export async function attachAgencyEvidence(
  testInfo: TestInfo,
  name: string,
  harness: AgencyEvidenceHarness,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await testInfo.attach(name, {
    body: Buffer.from(
      `${JSON.stringify(
        {
          role: harness.role,
          profile: harness.profile,
          requests: harness.requests,
          protectedRequests: harness.protectedRequests,
          mutations: harness.mutations,
          unexpected: harness.unexpected,
          externalRequests: harness.externalRequests,
          consoleErrors: harness.consoleErrors,
          pageErrors: harness.pageErrors,
          rosterReadCount: harness.rosterReadCount(),
          brandingReadCount: harness.brandingReadCount(),
          ...extra,
        },
        null,
        2,
      )}\n`,
    ),
    contentType: "application/json",
  });
}
