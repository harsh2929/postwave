import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { Page, Route } from "@playwright/test";

import { expect, test, waitForPrimaryNavigation } from "./fixture";

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const NOW = "2026-07-22T10:00:00.000Z";
const TENANT_ID = "templates-qualification-tenant";
const TRACKER_HOST = "tracker.templates.example.invalid";
const PLATFORM_ID = "11111111-1111-4111-8111-111111111111";
const OWN_ID = "22222222-2222-4222-8222-222222222222";
const TEAM_ID = "33333333-3333-4333-8333-333333333333";
const REFERENCE_ID = "44444444-4444-4444-8444-444444444444";

type TemplateRow = Record<string, unknown> & {
  id: string;
  name: string;
  subject: string;
  slug: string;
};

const PLATFORM_CAPABILITIES = {
  can_preview: true,
  can_favorite: true,
  can_adapt: false,
  can_use_directly: true,
  can_create_campaign: true,
  can_edit_directly: false,
  can_clone: true,
  can_delete: false,
  can_archive: false,
  can_restore: false,
  has_source_html: true,
  has_source_mjml: false,
  has_desktop_preview: false,
  has_mobile_preview: false,
};

const WORKSPACE_CAPABILITIES = {
  can_preview: true,
  can_favorite: true,
  can_adapt: false,
  can_use_directly: true,
  can_create_campaign: true,
  can_edit_directly: true,
  can_clone: true,
  can_delete: true,
  can_archive: true,
  can_restore: false,
  has_source_html: true,
  has_source_mjml: false,
  has_desktop_preview: false,
  has_mobile_preview: false,
};

const REFERENCE_CAPABILITIES = {
  can_preview: false,
  can_favorite: true,
  can_adapt: true,
  can_use_directly: false,
  can_create_campaign: false,
  can_edit_directly: false,
  can_clone: false,
  can_delete: false,
  can_archive: false,
  can_restore: false,
  has_source_html: true,
  has_source_mjml: false,
  has_desktop_preview: false,
  has_mobile_preview: false,
};

const TEMPLATE_ROWS: TemplateRow[] = [
  {
    id: PLATFORM_ID,
    slug: "postwave-lifecycle-welcome",
    name: "Lifecycle welcome sequence",
    description: "A curated first-week onboarding story.",
    category: "newsletter",
    subject: "Welcome, {{first_name}} — here is what happens next",
    preview_text: "Three useful steps for your first week.",
    body_html: `<main><h1>Welcome, {{first_name}}</h1><img src="https://${TRACKER_HOST}/pixel.gif"><a href="https://${TRACKER_HOST}/leave">Continue</a><form action="https://${TRACKER_HOST}/collect"><button>Submit</button></form></main>`,
    variables: [{ name: "first_name", label: "First name", default: "Morgan" }],
    tags: ["kind:automation", "onboarding"],
    goal: "welcome",
    is_featured: true,
    usage_count: 984,
    last_used_at: "2026-07-20T08:20:00.000Z",
    is_favorited: true,
    template_kind: "editable",
    review_status: "approved",
    capabilities: PLATFORM_CAPABILITIES,
    updated_at: NOW,
  },
  {
    id: OWN_ID,
    tenant_id: TENANT_ID,
    slug: "monthly-product-research-digest-with-an-intentionally-long-record-identifier",
    name: "Monthly product research digest — editorial edition",
    description: "A research-led monthly newsletter.",
    category: "newsletter",
    subject:
      "What customers taught us this month, including the details worth carrying forward",
    preview_text: "Research themes, decisions, and the next set of questions.",
    body_html:
      "<main><h1>Research notes</h1><p>Evidence before assumptions.</p><p>{{summary}}</p></main>",
    variables: [
      { name: "summary", label: "Research summary", default: "Five signals" },
    ],
    tags: ["kind:regular", "research", "monthly"],
    goal: "newsletter",
    usage_count: 48,
    last_used_at: "2026-07-18T09:30:00.000Z",
    is_favorited: false,
    template_kind: "editable",
    review_status: "approved",
    version: 1,
    etag: `"campaign-template:${OWN_ID}:v1"`,
    capabilities: WORKSPACE_CAPABILITIES,
    updated_at: "2026-07-21T08:00:00.000Z",
  },
  {
    id: TEAM_ID,
    tenant_id: TENANT_ID,
    slug: "renewal-announcement",
    name: "Renewal announcement",
    description: "A teammate-authored renewal message.",
    category: "promotional",
    subject: "A clearer renewal, built around what you use",
    preview_text: "Your plan, explained without surprises.",
    body_html:
      "<main><h1>Your renewal</h1><p>Everything in one place.</p></main>",
    tags: ["kind:broadcast", "renewal"],
    goal: "announcement",
    usage_count: 16,
    is_favorited: false,
    template_kind: "editable",
    review_status: "pending",
    capabilities: {
      ...WORKSPACE_CAPABILITIES,
      can_edit_directly: false,
      can_delete: false,
      can_archive: false,
    },
    updated_at: "2026-07-20T07:00:00.000Z",
  },
  {
    id: REFERENCE_ID,
    tenant_id: TENANT_ID,
    slug: "acme-editorial-reference",
    name: "Acme editorial reference",
    description: "A licensed reference that must be adapted before use.",
    category: "promotional",
    subject: "A design reference, not send-ready content",
    preview_text: "Adapt this reference into an original design.",
    body_html: "<main><h1>Reference composition</h1></main>",
    tags: ["kind:regular", "reference"],
    goal: "promotional",
    usage_count: 0,
    is_favorited: false,
    template_kind: "reference",
    source_provider: "Licensed catalog",
    source_brand: "Acme Studio",
    source_external_id: "acme-reference-998877665544332211",
    source_url: "https://catalog.example.invalid/acme-editorial",
    source_license_status: "reviewed",
    review_status: "approved",
    capabilities: REFERENCE_CAPABILITIES,
    updated_at: "2026-07-19T07:00:00.000Z",
  },
];

const SAVED_BLOCK = {
  id: "saved-block-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  tenant_id: TENANT_ID,
  name: "Research digest footer",
  kind: "section",
  body_html: "<footer><p>Why you received this message.</p></footer>",
  body_json: { block_id: "research-footer", version: 3 },
  created_at: "2026-07-18T08:00:00.000Z",
  updated_at: NOW,
};

interface DeferredRequest {
  promise: Promise<void>;
  release: () => void;
}

interface TemplatesApiOptions {
  empty?: boolean;
  holdInitialCatalog?: boolean;
  initialCatalogFailure?: boolean;
  role?: "admin" | "viewer";
}

interface TemplatesApiControl {
  deferNextPatch: () => () => void;
  failNextCatalog: () => void;
  getAiGenerateCount: () => number;
  getCatalogCount: () => number;
  getCloneCount: () => number;
  getFavoriteCount: () => number;
  getLeaderboardCount: () => number;
  getMutationCount: () => number;
  getReviewedSaves: () => Record<string, unknown>[];
  getSavedBlockCount: () => number;
  getThumbnailCount: () => number;
  getTrackerRequests: () => string[];
  getUseInCampaignCount: () => number;
  releaseInitialCatalog: () => void;
}

function deferredRequest(): DeferredRequest {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function templateSearchRows(url: URL, rows: TemplateRow[]): TemplateRow[] {
  let filtered = [...rows];
  const source = url.searchParams.get("source");
  const query = url.searchParams.get("query")?.trim().toLocaleLowerCase();
  const goal = url.searchParams.get("goal");
  if (source === "platform")
    filtered = filtered.filter((row) => !row.tenant_id);
  if (source === "team")
    filtered = filtered.filter((row) => row.id === TEAM_ID);
  if (source === "mine") filtered = filtered.filter((row) => row.id === OWN_ID);
  if (url.searchParams.get("favorited") === "1") {
    filtered = filtered.filter((row) => row.is_favorited === true);
  }
  if (goal) filtered = filtered.filter((row) => row.goal === goal);
  if (query) {
    filtered = filtered.filter((row) =>
      [row.name, row.subject].some((value) =>
        value.toLocaleLowerCase().includes(query),
      ),
    );
  }
  return filtered;
}

async function installTemplatesApi(
  page: Page,
  options: TemplatesApiOptions = {},
): Promise<TemplatesApiControl> {
  let catalogCount = 0;
  let favoriteCount = 0;
  let cloneCount = 0;
  let leaderboardCount = 0;
  let mutationCount = 0;
  let savedBlockCount = 0;
  let thumbnailCount = 0;
  let useInCampaignCount = 0;
  let aiGenerateCount = 0;
  const reviewedSaves: Record<string, unknown>[] = [];
  let listFailuresRemaining = options.initialCatalogFailure ? 3 : 0;
  let nextPatchGate: DeferredRequest | null = null;
  const initialGate = options.holdInitialCatalog ? deferredRequest() : null;
  const trackerRequests: string[] = [];
  const rows = options.empty
    ? []
    : TEMPLATE_ROWS.map((row) => {
        const copy = { ...row };
        if (options.role === "viewer") {
          const capabilities = row.capabilities as Record<string, boolean>;
          copy.capabilities = {
            ...capabilities,
            can_favorite: false,
            can_adapt: false,
            can_use_directly: false,
            can_create_campaign: false,
            can_edit_directly: false,
            can_clone: false,
            can_delete: false,
            can_archive: false,
            can_restore: false,
          };
        }
        return copy;
      });
  const details = new Map(rows.map((row) => [row.id, row]));

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname === TRACKER_HOST) trackerRequests.push(request.url());
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    const method = request.method();

    if (pathname === "/api/v1/auth/me") {
      const role = options.role ?? "admin";
      await json(route, {
        user_id: `templates-${role}`,
        tenant_id: TENANT_ID,
        email: `${role}@templates.example.invalid`,
        role,
        effective_role: role,
        auth_provider: "password",
        email_verified: true,
        workspace_name: "Templates qualification",
        workspace_slug: TENANT_ID,
      });
      return;
    }

    if (pathname === "/api/v1/dashboard/layout" && method === "GET") {
      await json(route, {
        order: [
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
        ],
      });
      return;
    }

    if (/^\/api\/v1\/templates\/[^/]+\/thumbnail\.png$/u.test(pathname)) {
      thumbnailCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        headers: { "Cache-Control": "private, no-store" },
        body: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 360"><rect width="600" height="360" fill="#18212f"/><rect x="48" y="44" width="504" height="42" rx="10" fill="#2dd4bf" opacity=".75"/><rect x="48" y="116" width="392" height="20" rx="8" fill="#f8fafc" opacity=".9"/><rect x="48" y="158" width="470" height="12" rx="6" fill="#94a3b8"/><rect x="48" y="186" width="430" height="12" rx="6" fill="#94a3b8"/><rect x="48" y="242" width="156" height="46" rx="12" fill="#f05a6e"/></svg>`,
      });
      return;
    }

    if (pathname === "/api/v1/campaign-templates/search" && method === "GET") {
      catalogCount += 1;
      if (catalogCount === 1 && initialGate) await initialGate.promise;
      if (listFailuresRemaining > 0) {
        listFailuresRemaining -= 1;
        await json(
          route,
          {
            error: {
              code: "templates_catalog_unavailable",
              message: "Private database detail must not render",
            },
          },
          503,
        );
        return;
      }
      const filtered = templateSearchRows(url, rows);
      const pageNumber = Number(url.searchParams.get("page") ?? "1");
      const pageRows =
        pageNumber === 1 ? filtered.slice(0, 3) : filtered.slice(3);
      await json(route, {
        items: pageRows,
        page: pageNumber,
        per_page: 48,
        total: filtered.length,
        facets: {
          goals: [],
          categories: [],
          providers: [],
          industries: [],
          styles: [],
          layouts: [],
        },
      });
      return;
    }

    if (pathname === "/api/v1/campaign-templates/stats" && method === "GET") {
      await json(route, {
        total: rows.length,
        mine: rows.filter((row) => row.id === OWN_ID).length,
        featured: rows.filter((row) => row.is_featured === true).length,
        favorites: rows.filter((row) => row.is_favorited === true).length,
        used_last_30d: 3,
        top_template_id: PLATFORM_ID,
        top_template_name: "Lifecycle welcome sequence",
        top_usage_count: 984,
        last_used_at: NOW,
      });
      return;
    }

    if (pathname === "/api/v1/campaign-templates/goals" && method === "GET") {
      await json(route, [
        {
          goal: "welcome",
          count: rows.filter((row) => row.goal === "welcome").length,
        },
        {
          goal: "newsletter",
          count: rows.filter((row) => row.goal === "newsletter").length,
        },
        {
          goal: "announcement",
          count: rows.filter((row) => row.goal === "announcement").length,
        },
        {
          goal: "promotional",
          count: rows.filter((row) => row.goal === "promotional").length,
        },
        { goal: "re_engagement", count: 0 },
        { goal: "transactional", count: 0 },
        { goal: "automation", count: 0 },
      ]);
      return;
    }

    if (
      pathname === "/api/v1/analytics/template-leaderboard" &&
      method === "GET"
    ) {
      leaderboardCount += 1;
      await json(route, {
        items: [
          {
            template_id: PLATFORM_ID,
            template_name: "Lifecycle welcome sequence",
            campaigns_used: 12,
            sent: 24_000,
            opens: 12_240,
            clicks: 3_120,
            open_rate: 0.51,
            click_rate: 0.13,
          },
        ],
      });
      return;
    }

    if (pathname === "/api/v1/blocks/saved" && method === "GET") {
      savedBlockCount += 1;
      await json(route, { items: options.empty ? [] : [SAVED_BLOCK] });
      return;
    }

    if (pathname === "/api/v1/blocks/saved" && method === "POST") {
      mutationCount += 1;
      await json(route, SAVED_BLOCK, 201);
      return;
    }

    if (
      pathname === "/api/v1/campaign-templates/recent" &&
      method === "GET"
    ) {
      await json(route, { items: [] });
      return;
    }

    const recentViewMatch = pathname.match(
      /^\/api\/v1\/campaign-templates\/([^/]+)\/view$/u,
    );
    if (recentViewMatch && method === "POST") {
      const template =
        details.get(decodeURIComponent(recentViewMatch[1]!)) ?? rows[0]!;
      await json(route, {
        template,
        view_count: 1,
        first_viewed_at: NOW,
        last_viewed_at: NOW,
      });
      return;
    }

    if (pathname === "/api/v1/campaign-template-designs" && method === "POST") {
      aiGenerateCount += 1;
      const body = request.postDataJSON() as Record<string, unknown>;
      await json(
        route,
        {
          id: "durable-design-1",
          mode: "generate",
          status: "ready",
          reference_template_ids: [],
          current_revision: 1,
          revision: {
            id: "durable-design-1-revision-1",
            draft_id: "durable-design-1",
            revision: 1,
            operation: "initial",
            output: {
              name: "AI-assisted retention note",
              subject: "A useful reason to come back",
              preview_text: "A reviewed draft, grounded in the operator brief.",
              body_html:
                "<main><h1>Welcome back</h1><p>Here is what changed.</p></main>",
              variables: {},
              unresolved_variables: [],
              reference_template_ids: [],
              warnings: [],
            },
            output_hash: "a".repeat(64),
            validation: {
              status: "pass",
              checks: [
                {
                  code: "active_content",
                  status: "pass",
                  message: "No active browser content was found.",
                },
              ],
            },
            warnings: [],
            created_at: NOW,
          },
          attempt_count: 1,
          capabilities: {
            can_refine: true,
            can_retry: false,
            can_save: true,
            can_create_campaign: true,
            can_archive: true,
          },
          recommended_action: "review_campaign_template_design",
          expires_at: "2026-08-22T10:00:00.000Z",
          created_at: NOW,
          updated_at: NOW,
          request: body,
        },
        202,
      );
      return;
    }

    if (
      pathname === "/api/v1/campaign-template-designs/durable-design-1/save" &&
      method === "POST"
    ) {
      mutationCount += 1;
      const body = request.postDataJSON() as Record<string, unknown>;
      reviewedSaves.push(body);
      const created: TemplateRow = {
        id: `reviewed-template-${mutationCount}`,
        tenant_id: TENANT_ID,
        slug: String(body.slug ?? "reviewed-template"),
        name: String(body.name ?? "Reviewed template"),
        subject: String(body.subject ?? ""),
        preview_text: String(body.preview_text ?? ""),
        body_html:
          "<main><h1>Welcome back</h1><p>Here is what changed.</p></main>",
        tags: ["kind:regular"],
        goal: body.goal ?? "newsletter",
        template_kind: "editable",
        review_status: "approved",
        source_provider: "postwave",
        source_license_status: "owned",
        reference_template_ids: Array.isArray(body.reference_template_ids)
          ? body.reference_template_ids
          : [],
        is_favorited: false,
        usage_count: 0,
        updated_at: NOW,
      };
      rows.unshift(created);
      details.set(created.id, created);
      await json(route, created, 201);
      return;
    }

    if (pathname === "/api/v1/campaign-templates" && method === "POST") {
      mutationCount += 1;
      const body = request.postDataJSON() as Record<string, unknown>;
      const created: TemplateRow = {
        id: `created-template-${mutationCount}`,
        tenant_id: TENANT_ID,
        slug: String(body.slug ?? "created-template"),
        name: String(body.name ?? "Created template"),
        subject: String(body.subject ?? ""),
        preview_text: String(body.preview_text ?? ""),
        body_html: String(body.body_html ?? ""),
        tags: Array.isArray(body.tags) ? body.tags : [],
        goal: body.goal ?? "",
        template_kind: "editable",
        is_favorited: false,
        usage_count: 0,
        updated_at: NOW,
      };
      rows.unshift(created);
      details.set(created.id, created);
      await json(route, created, 201);
      return;
    }

    if (pathname === "/api/v1/campaigns/from-template" && method === "POST") {
      mutationCount += 1;
      useInCampaignCount += 1;
      await json(
        route,
        {
          id: `campaign-from-template-${useInCampaignCount}`,
          name: "Draft from qualified template",
          status: "draft",
          subject: "Qualified subject",
          created_at: NOW,
          updated_at: NOW,
        },
        201,
      );
      return;
    }

    const favoriteMatch = pathname.match(
      /^\/api\/v1\/campaign-templates\/([^/]+)\/(favorite|unfavorite)$/u,
    );
    if (favoriteMatch && method === "POST") {
      favoriteCount += 1;
      mutationCount += 1;
      const row = details.get(decodeURIComponent(favoriteMatch[1]!));
      if (row) row.is_favorited = favoriteMatch[2] === "favorite";
      await json(route, {
        ok: true,
        favorited: favoriteMatch[2] === "favorite",
      });
      return;
    }

    const cloneMatch = pathname.match(
      /^\/api\/v1\/campaign-templates\/([^/]+)\/clone$/u,
    );
    if (cloneMatch && method === "POST") {
      cloneCount += 1;
      mutationCount += 1;
      const source =
        details.get(decodeURIComponent(cloneMatch[1]!)) ?? rows[0]!;
      const copy = {
        ...source,
        id: `cloned-template-${mutationCount}`,
        tenant_id: TENANT_ID,
        name: `${source.name} (copy)`,
        template_kind: "editable",
      };
      rows.unshift(copy);
      details.set(copy.id, copy);
      await json(route, copy, 201);
      return;
    }

    const regionMatch = pathname.match(
      /^\/api\/v1\/campaign-templates\/([^/]+)\/regions$/u,
    );
    if (regionMatch && method === "GET") {
      await json(route, {
        regions: [
          {
            name: "hero",
            default_html: "<h1>Research notes</h1>",
            position: 6,
            length: 23,
          },
        ],
        count: 1,
      });
      return;
    }

    const templateMatch = pathname.match(
      /^\/api\/v1\/campaign-templates\/([^/]+)$/u,
    );
    if (templateMatch) {
      const id = decodeURIComponent(templateMatch[1]!);
      const current = details.get(id) ?? rows[0]!;
      if (method === "GET") {
        await json(route, current);
        return;
      }
      if (method === "PATCH") {
        mutationCount += 1;
        const patch = request.postDataJSON() as Record<string, unknown>;
        const updated = { ...current, ...patch, updated_at: NOW };
        const gate = nextPatchGate;
        nextPatchGate = null;
        if (gate) await gate.promise;
        details.set(id, updated);
        const rowIndex = rows.findIndex((row) => row.id === id);
        if (rowIndex >= 0) rows[rowIndex] = updated;
        await json(route, updated);
        return;
      }
      if (method === "DELETE") {
        mutationCount += 1;
        details.delete(id);
        await json(route, { ok: true });
        return;
      }
    }

    await route.fallback();
  });

  return {
    deferNextPatch: () => {
      const gate = deferredRequest();
      nextPatchGate = gate;
      return gate.release;
    },
    failNextCatalog: () => {
      listFailuresRemaining = 3;
    },
    getAiGenerateCount: () => aiGenerateCount,
    getCatalogCount: () => catalogCount,
    getCloneCount: () => cloneCount,
    getFavoriteCount: () => favoriteCount,
    getLeaderboardCount: () => leaderboardCount,
    getMutationCount: () => mutationCount,
    getReviewedSaves: () => [...reviewedSaves],
    getSavedBlockCount: () => savedBlockCount,
    getThumbnailCount: () => thumbnailCount,
    getTrackerRequests: () => [...trackerRequests],
    getUseInCampaignCount: () => useInCampaignCount,
    releaseInitialCatalog: () => initialGate?.release(),
  };
}

async function navigateToTemplates(page: Page): Promise<void> {
  await page.goto("/");
  await waitForPrimaryNavigation(page);
  await page
    .getByRole("navigation", { name: "Primary" })
    .locator('button[data-section="templates"]')
    .click();
  await expect(
    page.getByRole("heading", { name: "Templates", exact: true }),
  ).toBeVisible();
}

async function openTemplates(
  page: Page,
  bootApp: (page: Page) => Promise<void>,
  options: TemplatesApiOptions = {},
): Promise<TemplatesApiControl> {
  await bootApp(page);
  const control = await installTemplatesApi(page, options);
  await navigateToTemplates(page);
  if (!options.holdInitialCatalog && !options.initialCatalogFailure) {
    if (options.empty) {
      await expect(page.getByText("Don't start from blank.")).toBeVisible();
    } else {
      await expect(
        page.getByRole("button", {
          name: "Open template Lifecycle welcome sequence",
        }),
      ).toBeVisible();
    }
  }
  return control;
}

async function seriousAxeViolations(
  page: Page,
  options: { disableColorContrast?: boolean } = {},
): Promise<unknown[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  return page.evaluate(async (disableColorContrast) => {
    const result = await (
      window as unknown as {
        axe: {
          run: (
            root: Document | Element,
            options?: Record<string, unknown>,
          ) => Promise<{
            violations: Array<{
              id: string;
              impact: string | null;
              nodes: Array<{ target: string[]; failureSummary?: string }>;
            }>;
          }>;
        };
      }
    ).axe.run(document.querySelector(".content") ?? document, {
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
      },
      ...(disableColorContrast
        ? { rules: { "color-contrast": { enabled: false } } }
        : {}),
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
          failure: node.failureSummary,
        })),
      }));
  }, options.disableColorContrast ?? false);
}

for (const theme of ["dark", "light"] as const) {
  test(`Templates renders a safe, populated, axe-clean catalog in ${theme} theme`, async ({
    page,
    bootApp,
    setTheme,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1_000 });
    await setTheme(page, theme);
    const control = await openTemplates(page, bootApp);

    await expect(page.getByText("3 of 4 templates")).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Open template Lifecycle welcome sequence",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Open template Monthly product research digest — editorial edition",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Open template Renewal announcement",
      }),
    ).toBeVisible();
    await expect(page.getByText("In your library")).toBeVisible();
    await expect(page.getByText("Used (30d)")).toBeVisible();
    await page.waitForTimeout(100);
    expect(control.getTrackerRequests()).toEqual([]);
    expect(control.getThumbnailCount()).toBe(0);
    await expect(page.locator(".tpl-card-visual")).toHaveCount(3);
    await expect(page.locator(".tpl-card img, .tpl-card iframe")).toHaveCount(
      0,
    );
    await page.screenshot({
      path: testInfo.outputPath(`templates-${theme}.png`),
      fullPage: true,
    });
    expect(await seriousAxeViolations(page)).toEqual([]);
  });
}

test("Templates exposes deterministic loading, empty, initial-error, and stale-refresh truth", async ({
  page,
  bootApp,
}, testInfo) => {
  const loading = await openTemplates(page, bootApp, {
    holdInitialCatalog: true,
  });
  await expect(
    page.getByRole("status", { name: "Loading templates" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refreshing…" }),
  ).toHaveAttribute("aria-disabled", "true");
  await page.screenshot({ path: testInfo.outputPath("templates-loading.png") });
  loading.releaseInitialCatalog();
  await expect(
    page.getByRole("button", {
      name: "Open template Lifecycle welcome sequence",
    }),
  ).toBeVisible();

  loading.failNextCatalog();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText(/previous verified catalog remains visible/u),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Open template Lifecycle welcome sequence",
    }),
  ).toBeVisible();
  await expect(page.getByText("Private database detail")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("templates-stale.png") });
});

test("Templates initial failure is distinct from an empty library", async ({
  page,
  bootApp,
}) => {
  await openTemplates(page, bootApp, { initialCatalogFailure: true });
  await expect(
    page.getByRole("heading", { name: "Template catalog unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Retry template catalog" }),
  ).toBeVisible();
  await expect(page.getByText("Don't start from blank.")).toHaveCount(0);
  await expect(page.getByText("Private database detail")).toHaveCount(0);
});

test("Templates renders a verified empty library as an onboarding opportunity", async ({
  page,
  bootApp,
}, testInfo) => {
  await openTemplates(page, bootApp, { empty: true });
  await expect(page.getByText("Don't start from blank.")).toBeVisible();
  await expect(
    page.getByText(
      /Browse inspiration, make a design your own, and customize it in the editor/u,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("list", { name: "Template catalog" }),
  ).toHaveCount(0);
  await expect(
    page.locator(".tpl-header-buttons").getByRole("button", {
      name: "New template",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("templates-empty.png") });
  expect(await seriousAxeViolations(page)).toEqual([]);
});

test("Template library and personal discovery views, filters, pagination, and saved blocks work by keyboard", async ({
  page,
  bootApp,
}) => {
  const control = await openTemplates(page, bootApp);
  await page.getByRole("button", { name: "Open library tools" }).click();
  const discoveryTabs = page.getByRole("tablist", {
    name: "Personal template library tools",
  });
  const recent = discoveryTabs.getByRole("tab", { name: "Recent" });
  const compare = discoveryTabs.getByRole("tab", { name: "Compare" });
  await expect(
    page.getByRole("heading", { name: "No recent templates yet" }),
  ).toBeVisible();
  await recent.focus();
  await recent.press("ArrowRight");
  await expect(compare).toBeFocused();
  await expect(compare).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("heading", { name: "Compare templates" }),
  ).toBeVisible();
  await compare.press("Home");
  await expect(recent).toBeFocused();
  await expect(recent).toHaveAttribute("aria-selected", "true");

  const libraryView = page.getByRole("group", {
    name: "Template library view",
  });
  const all = libraryView.getByRole("radio", { name: /^All templates/u });
  const inspiration = libraryView.getByRole("radio", {
    name: /^Inspiration/u,
  });
  const savedBlocks = libraryView.getByRole("radio", {
    name: /^Saved blocks/u,
  });

  await all.focus();
  await all.press("ArrowRight");
  await expect(inspiration).toBeFocused();
  await expect(inspiration).toBeChecked();
  await expect(
    page.getByRole("button", {
      name: "Open template Lifecycle welcome sequence",
    }),
  ).toBeVisible();
  await inspiration.press("Home");
  await expect(all).toBeChecked();

  await page.getByRole("button", { name: /Newsletter, 1 template/u }).click();
  await expect(
    page.getByRole("button", {
      name: "Open template Monthly product research digest — editorial edition",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Open template Lifecycle welcome sequence",
    }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "All goals" }).click();

  const search = page.getByLabel("Search templates");
  await search.fill("Acme");
  await expect(page.getByText("Search update pending…")).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Open template Acme editorial reference",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Open template Renewal announcement" }),
  ).toHaveCount(0);
  await search.press("Escape");
  await expect(search).toHaveValue("");

  await page.getByRole("button", { name: "Load more templates" }).click();
  await expect(
    page.getByRole("button", {
      name: "Open template Acme editorial reference",
    }),
  ).toBeVisible();

  await all.focus();
  await all.press("End");
  await expect(savedBlocks).toBeFocused();
  await expect(savedBlocks).toBeChecked();
  await expect(page.getByText("Research digest footer")).toBeVisible();
  await expect(page.getByLabel("Search saved blocks")).toBeVisible();
  expect(control.getSavedBlockCount()).toBe(1);
});

test("Template performance stays lazy, switches attribution windows, and renders bounded rates", async ({
  page,
  bootApp,
}) => {
  const control = await openTemplates(page, bootApp);
  expect(control.getLeaderboardCount()).toBe(0);
  const performance = page.getByRole("button", { name: /^Performance/u });
  await expect(performance).toHaveAttribute("aria-expanded", "false");
  await performance.click();
  await expect(performance).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("table", { name: "Template performance leaderboard" }),
  ).toBeVisible();
  await expect(page.getByText("51.0%", { exact: true })).toBeVisible();
  await expect(page.getByText("13.0%", { exact: true })).toBeVisible();
  expect(control.getLeaderboardCount()).toBe(1);

  await page.getByRole("button", { name: "90d" }).click();
  await expect(page.getByText(/last 90 days/u)).toBeVisible();
  expect(control.getLeaderboardCount()).toBe(2);
});

test("Saved-block copy has complete keyboard feedback without rendering stored markup", async ({
  page,
  bootApp,
}) => {
  await openTemplates(page, bootApp);
  await page
    .getByRole("group", { name: "Template library view" })
    .getByRole("radio", { name: /^Saved blocks/u })
    .check({ force: true });
  await expect(page.getByText("Research digest footer")).toBeVisible();
  await expect(
    page.locator(".pw-saved-block-card iframe, .pw-saved-block-card img"),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Copy block content" }).click();
  await expect(
    page.getByText(
      /Research digest footer copied\. Paste it into a template body/u,
    ),
  ).toBeVisible();
});

test("Template favorite and create flows are single-action, validated, and explicit about discard", async ({
  page,
  bootApp,
}) => {
  const control = await openTemplates(page, bootApp);
  const favorite = page.getByRole("button", {
    name: "Add Monthly product research digest — editorial edition to favorites",
  });
  await favorite.click();
  await expect(
    page.getByRole("button", {
      name: "Remove Monthly product research digest — editorial edition from favorites",
    }),
  ).toBeVisible();
  expect(control.getFavoriteCount()).toBe(1);

  await page.getByRole("button", { name: "New template", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New template" });
  await expect(
    dialog.getByRole("button", { name: "Create template" }),
  ).toHaveAttribute("aria-disabled", "true");
  await dialog.getByLabel("Name").fill("Research follow-up");
  await expect(dialog.getByLabel("Slug")).toHaveValue("research-follow-up");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  const discard = page.getByRole("alertdialog", {
    name: "Discard this template?",
  });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Discard template" }).click();
  await expect(dialog).toBeHidden();
});

test("Template detail uses manual keyboard tabs and a sandboxed, request-free device preview", async ({
  page,
  bootApp,
}, testInfo) => {
  const control = await openTemplates(page, bootApp);
  await page
    .getByRole("button", { name: "Open template Lifecycle welcome sequence" })
    .click();
  const dialog = page
    .locator(".slideover")
    .filter({ has: page.getByLabel("Template name") });
  await expect(dialog).toBeVisible();
  const preview = dialog.getByTitle("Template preview");
  await expect(preview).toHaveAttribute("sandbox", "");
  await expect(preview).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(
    dialog.getByText(
      /external assets, links, forms, and tracking requests are blocked/u,
    ),
  ).toBeVisible();

  const device = dialog.getByRole("group", { name: "Device preview" });
  const desktopWidth = (await preview.boundingBox())?.width ?? 0;
  await device.locator('label:has(input[value="mobile"])').click();
  await expect(device.getByRole("radio", { name: "Mobile" })).toBeChecked();
  const mobileWidth = (await preview.boundingBox())?.width ?? 0;
  expect(mobileWidth).toBeGreaterThan(0);
  expect(mobileWidth).toBeLessThanOrEqual(390);
  expect(mobileWidth).toBeLessThan(desktopWidth);
  await dialog
    .getByRole("button", { name: "Use dark preview rendering" })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Use light preview rendering" }),
  ).toBeVisible();

  const tabs = dialog.getByRole("tablist", { name: "Template view" });
  const previewTab = tabs.getByRole("tab", { name: "Preview" });
  const editTab = tabs.getByRole("tab", { name: "Edit" });
  const regionsTab = tabs.getByRole("tab", { name: "Regions" });
  await previewTab.focus();
  await previewTab.press("ArrowRight");
  await expect(editTab).toBeFocused();
  await expect(previewTab).toHaveAttribute("aria-selected", "true");
  await editTab.press("Enter");
  await expect(editTab).toHaveAttribute("aria-selected", "true");
  await editTab.press("ArrowRight");
  await regionsTab.press("Enter");
  await expect(regionsTab).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByText("hero", { exact: true })).toBeVisible();

  await page.waitForTimeout(100);
  expect(control.getTrackerRequests()).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("templates-detail.png") });
  expect(await seriousAxeViolations(page)).toEqual([]);
});

test("Template detail blocks Escape while saving and requires confirmation before discarding local edits", async ({
  page,
  bootApp,
}) => {
  const control = await openTemplates(page, bootApp);
  await page
    .getByRole("button", {
      name: "Open template Monthly product research digest — editorial edition",
    })
    .click();
  const dialog = page.locator(".slideover");
  await dialog.getByRole("tab", { name: "Edit" }).click();
  const html = dialog.getByLabel("HTML body");
  await html.fill("<main><h1>Unsaved qualification draft</h1></main>");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("alertdialog")).toContainText(
    /discard|unsaved/iu,
  );
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /keep editing|cancel/i })
    .click();

  const releasePatch = control.deferNextPatch();
  await dialog.getByRole("button", { name: "Save HTML" }).click();
  await expect(dialog.getByRole("button", { name: "Saving…" })).toBeVisible();
  const close = dialog.getByRole("button", { name: "Close template details" });
  await expect(close).toBeVisible();
  await page.keyboard.press("Escape");
  const remainedOpen = await dialog.isVisible();
  await expect(
    dialog.getByText(
      /Wait for the current template operation to finish before closing/u,
    ),
  ).toBeVisible();
  releasePatch();
  expect(remainedOpen).toBe(true);
  await expect(dialog.getByRole("button", { name: "Save HTML" })).toBeVisible();
});

test("Verified template actions clone once and create a campaign only after server acknowledgement", async ({
  page,
  bootApp,
}) => {
  const control = await openTemplates(page, bootApp);
  await page
    .getByRole("button", {
      name: "Open template Monthly product research digest — editorial edition",
    })
    .click();
  let dialog = page.locator(".slideover");
  await expect(dialog.getByText(/Full record verified/u)).toBeVisible();
  await dialog.getByRole("button", { name: "Duplicate" }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Template name" }),
  ).toHaveValue(/\(copy\)$/u);
  await expect(dialog.getByText(/Full record verified/u)).toBeVisible();
  expect(control.getCloneCount()).toBe(1);
  await dialog.getByRole("button", { name: "Close template details" }).click();
  await expect(dialog).toBeHidden();

  await page
    .getByRole("button", { name: "Open template Lifecycle welcome sequence" })
    .click();
  dialog = page.locator(".slideover");
  await expect(dialog.getByText(/Full record verified/u)).toBeVisible();
  await dialog.getByRole("button", { name: "Use in campaign" }).click();
  await expect(dialog).toBeHidden();
  expect(control.getUseInCampaignCount()).toBe(1);
});

test("Templates AI generation stays review-first and saves the exact reviewed design once", async ({
  page,
  bootApp,
}) => {
  const control = await openTemplates(page, bootApp);
  await page.getByRole("button", { name: "Generate with AI" }).click();
  const dialog = page.getByRole("dialog", { name: "Generate with AI" });
  await expect(
    dialog.getByRole("button", { name: "Generate draft" }),
  ).toBeDisabled();
  await dialog
    .getByLabel("What should this email do?")
    .fill("Create a concise, evidence-led retention note for trial customers.");
  await dialog.getByLabel(/^Tone/u).fill("Warm, direct, no hype");
  await dialog.getByRole("button", { name: "Generate draft" }).click();
  await expect(dialog.getByLabel("Name")).toHaveValue(
    "AI-assisted retention note",
  );
  await expect(dialog.getByLabel("Subject")).toHaveValue(
    "A useful reason to come back",
  );
  await dialog.getByLabel("Subject").fill("A reviewed reason to come back");
  await dialog
    .getByLabel("Preview text (optional)")
    .fill("The operator-reviewed preview text.");
  await expect(dialog.getByTitle("Template preview")).toHaveAttribute(
    "sandbox",
    "",
  );
  await expect(
    dialog.getByRole("button", { name: "Save as template" }),
  ).toBeVisible();
  expect(control.getAiGenerateCount()).toBe(1);
  expect(control.getMutationCount()).toBe(0);
  await dialog.getByRole("button", { name: "Save as template" }).click();
  await expect(
    dialog.getByRole("button", { name: "Open saved template" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Open saved template" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Template name")).toHaveValue(
    "AI-assisted retention note",
  );
  expect(control.getAiGenerateCount()).toBe(1);
  expect(control.getMutationCount()).toBe(1);
  expect(control.getReviewedSaves()).toEqual([
    expect.objectContaining({
      name: "AI-assisted retention note",
      subject: "A reviewed reason to come back",
      preview_text: "The operator-reviewed preview text.",
      revision: 1,
      output_hash: "a".repeat(64),
    }),
  ]);
});

test("A viewer can inspect Templates but cannot trigger write-side effects", async ({
  page,
  bootApp,
}) => {
  const control = await openTemplates(page, bootApp, { role: "viewer" });
  await expect(
    page.getByText("Viewer role can browse templates but cannot create them."),
  ).toBeVisible();
  for (const name of ["Generate with AI", "New template"] as const) {
    const action = page.getByRole("button", { name, exact: true });
    await expect(action).toHaveAttribute("aria-disabled", "true");
    await action.click({ force: true });
  }
  await expect(
    page.getByRole("dialog", { name: "Generate with AI" }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "New template" })).toHaveCount(
    0,
  );

  await page
    .getByRole("button", { name: "Open template Lifecycle welcome sequence" })
    .click();
  const dialog = page.locator(".slideover");
  await expect(
    dialog.getByText(/Viewer role can inspect verified templates/u),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Use in campaign" }),
  ).toHaveAttribute("aria-disabled", "true");
  await dialog.getByRole("tab", { name: "Edit" }).click();
  await expect(dialog.getByLabel("HTML body")).toBeDisabled();
  expect(control.getMutationCount()).toBe(0);
  expect(await seriousAxeViolations(page)).toEqual([]);
});

test("Templates contains the route and detail workspace at a 320px viewport", async ({
  page,
  bootApp,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await openTemplates(page, bootApp);
  const content = page.locator(".content");
  const routeMeasurements = await content.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    contained: element.scrollWidth <= element.clientWidth + 1,
  }));
  expect(routeMeasurements.contained).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("templates-narrow.png"),
    fullPage: true,
  });

  await page
    .getByRole("button", {
      name: "Open template Monthly product research digest — editorial edition",
    })
    .click();
  const detail = page.locator(".slideover");
  await detail.evaluate(async (element) => {
    await Promise.all(
      element
        .getAnimations({ subtree: false })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  const detailMeasurements = await detail.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      viewportWidth: window.innerWidth,
      contained: rect.left >= -1 && rect.right <= window.innerWidth + 1,
    };
  });
  await testInfo.attach("templates-narrow-measurements.json", {
    body: JSON.stringify({ routeMeasurements, detailMeasurements }, null, 2),
    contentType: "application/json",
  });
  // eslint-disable-next-line no-console -- qualification evidence in CI output
  console.info(
    `[templates-measurement:narrow] ${JSON.stringify({ routeMeasurements, detailMeasurements })}`,
  );
  await page.screenshot({
    path: testInfo.outputPath("templates-narrow-detail.png"),
  });
  expect(detailMeasurements.contained).toBe(true);
  expect(await seriousAxeViolations(page)).toEqual([]);
});

test("Templates preserves visible boundaries in forced colors and removes decorative motion", async ({
  page,
  bootApp,
}, testInfo) => {
  await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
  await openTemplates(page, bootApp);
  const media = await page.evaluate(() => {
    const selectedSource = document.querySelector<HTMLElement>(
      '.tpl-tab[data-selected="true"]',
    );
    const unselectedSource = document.querySelector<HTMLElement>(
      '.tpl-tab:not([data-selected="true"])',
    );
    const favorite = document.querySelector<HTMLElement>(".tpl-fav");
    return {
      forced: window.matchMedia("(forced-colors: active)").matches,
      reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      selectedBorder: selectedSource
        ? getComputedStyle(selectedSource).borderBottomColor
        : "",
      unselectedBorder: unselectedSource
        ? getComputedStyle(unselectedSource).borderBottomColor
        : "",
      sourceTransition: selectedSource
        ? getComputedStyle(selectedSource).transitionDuration
        : "",
      favoriteAnimation: favorite
        ? getComputedStyle(favorite).animationName
        : "",
    };
  });
  expect(media.forced).toBe(true);
  expect(media.reduced).toBe(true);
  expect(media.selectedBorder).not.toBe(media.unselectedBorder);
  expect(Number.parseFloat(media.sourceTransition)).toBeLessThanOrEqual(0.01);
  expect(media.favoriteAnimation).toBe("none");
  expect(
    await seriousAxeViolations(page, { disableColorContrast: true }),
  ).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("templates-forced-colors-reduced-motion.png"),
    fullPage: true,
  });
});
