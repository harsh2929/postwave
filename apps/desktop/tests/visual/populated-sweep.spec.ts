/**
 * Populated-data + dual-theme sweep. Where the empty-data sweep tested
 * "no rows", this returns 3 rich rows for every list endpoint (and rich
 * scalars/points for stats/charts) so every page renders its TABLE,
 * BADGES, DATES, CHARTS, and PAGINATION — the per-row logic the empty
 * sweep never exercised. Runs each section in BOTH dark and light themes,
 * capturing render crashes per (section, theme).
 *
 *   pnpm exec playwright test populated-sweep.spec.ts --reporter=line
 */
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { test, expect, waitForPrimaryNavigation } from "./fixture";
import type { Page } from "@playwright/test";

import { PRIMARY_DESKTOP_SECTIONS } from "./sections";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reportDir = path.resolve(__dirname, "..", "..", "tests", "visual", "__report__");
const shotDir = path.resolve(__dirname, "..", "..", "..", "..", "audit-screenshots",
  new Date().toISOString().slice(0, 10), "populated");

interface Finding { area: string; kind: string; detail: string }
const findings: Finding[] = [];
const NOISE = ["unstubbed Tauri command", "Failed to load resource", "favicon", "Download the React DevTools", "MIME type", "controlled input", "Each child in a list"];
const isNoise = (s: string) => NOISE.some((n) => s.includes(n));

function collect(page: Page, area: string): () => void {
  const onErr = (e: Error) => findings.push({ area, kind: "pageerror", detail: `${e.name}: ${e.message}`.slice(0, 320) });
  const onCon = (m: { type(): string; text(): string }) => {
    const t = m.text();
    if ((m.type() === "error" || (m.type() === "warning" && /is not a function|is not iterable|Cannot read prop|TypeError|NaN/.test(t))) && !isNoise(t))
      findings.push({ area, kind: "console", detail: t.slice(0, 320) });
  };
  page.on("pageerror", onErr); page.on("console", onCon as never);
  return () => { page.off("pageerror", onErr); page.off("console", onCon as never); };
}

// One rich row, superset of fields seen across the app, all plausible types.
const ISO = "2026-05-10T12:00:00.000Z";
const richRow = (i: number): Record<string, unknown> => ({
  id: `00000000-0000-4000-8000-00000000000${i}`, uuid: `00000000-0000-4000-8000-00000000000${i}`,
  sub_id: `${i}`, subscriber_id: `${i}`, campaign_id: `c${i}`, list_id: `${i}`, tag: `tag${i}`,
  name: `Item ${i}`, label: `Label ${i}`, title: `Title ${i}`, subject: `Subject ${i}`,
  display_name: `User ${i}`, email: `user${i}@example.com`, phone_e164: `+1555000000${i}`, phone: `+1555000000${i}`,
  slug: `slug-${i}`, domain: `ex${i}.com`, url: `https://ex${i}.com/x`, keyword: `KW${i}`, code: `EU`,
  status: i % 2 ? "active" : "sent", state: "enabled", kind: "draft", reason: "bounce", action: "reply_only",
  framework: "gdpr", channel: "email", type: "email", severity: "info", pace: "on_track", schedule: "daily",
  variant_key: "A", current_step: 2, current_step_label: "Email 2", milestone: 1, rank: i,
  enabled: true, verified: i % 2 === 0, is_favorited: false, require_approval: true, dedicated: false,
  notify_slack: false, exit_on_goal: true, attested: true,
  created_at: ISO, updated_at: ISO, sent_at: ISO, scheduled_at: ISO, last_run_at: ISO, last_polled_at: ISO,
  computed_at: ISO, occurred_at: ISO, at: ISO, entered_at: ISO, last_event_at: ISO, anchored_at: ISO,
  date: "2026-05-10", started_at: ISO, finished_at: ISO, requested_at: ISO, expires_at: ISO,
  count: 3, total: 3, sent: 10, opens: 5, clicks: 2, bounces: 1, unsubscribes: 0, delivered: 9,
  score: 72, engagement_score: 72, weight_bp: 5000, amount_cents: 1999, revenue_cents: 4999, tree_size: 1024,
  rate: 0.42, open_rate: 0.42, click_rate: 0.12, conversion_rate: 0.05, pct: 42, value: 5, idle_days: 4,
  segments_per_message: 1, position: 1, days: 30, threshold_days: 5, new_items: 2, items_seen: 4,
  sent_count: 10, failed_count: 0, held_count: 1, rows_exported: 100, impressions: 50, submissions30d: 5, visits30d: 40,
  tags: ["vip"], scopes: ["read:subscribers"], descriptors: ["calm"], writing_rules: ["short"],
  sample_snippets: ["hi"], days_arr: [1, 2, 3], object_selection: ["orders"], recipients: ["a@b.com"],
  models: ["churn"], providers: ["snowflake"], objects: ["orders"], import_targets: ["subscribers"],
  directions: ["import"], cadences: ["daily"], schema_version: 1,
  goal: { kind: "open", exit_on_goal: true }, handle: `@actor${i}`, root_hash: "abc123",
  variants: [], steps: [], milestones: [], sources: [{ name: "form", count: 5 }],
});

const rows = [richRow(1), richRow(2), richRow(3)];
const point = (n: number) => ({ date: `2026-05-0${n}`, value: n * 3, count: n * 2, revenue_cents: n * 100, sends: n * 5, subscribers: n * 4 });
const POINTS = [point(1), point(2), point(3), point(4), point(5)];

// Endpoints whose wire is a BARE ARRAY — return rows directly, not an object.
const BARE_ARRAY = [
  "/affiliates", "/conversions", "/check-links", "/auth-checks", "/commerce/integrations",
  "/landing-pages", "/form-variants", "/feed-sources", "/scoring/rules",
];
const isBareArray = (p: string) => BARE_ARRAY.some((b) => p.endsWith(b) || p.includes(b + "?") || p.includes(b + "/"));

const OBJ = {
  items: rows, data: rows, results: rows, rows, schedules: rows, goals: rows, runs: rows,
  conversions: rows, profiles: rows, keys: rows, integrations: rows, regions: rows, pages: rows,
  sources: [{ name: "form", count: 5 }, { name: "import", count: 3 }],
  dsar_requests: rows, suppression_breakdown: rows, consent_proof_summary: rows,
  points: POINTS, series: [{ key: "k1", label: "Series 1", points: POINTS }],
  buckets: [{ range: "0-10", min: 0, max: 10, count: 4 }, { range: "10-20", min: 10, max: 20, count: 2 }],
  deciles: [{ sends_bucket: "1", subscribers: 10, open_rate: 0.4, unsub_rate: 0.01 }],
  progress: [{ goal: richRow(1), current: 5, target: 10, pct: 50, pace: "on_track", period_start: ISO, period_end: ISO, as_of: ISO }],
  catalog: { providers: ["snowflake"], objects: ["orders"], import_targets: ["subscribers"], directions: ["import"], cadences: ["daily"], schema_version: 1 },
  total: 3, count: 3, page: 1, per_page: 50, has_more: false, next_before: null,
  gpc_signaled_count: 1, do_not_sell_count: 0, double_optin_pending: 2,
  // dashboard stats-ish
  total_subscribers: 12345, active_campaigns: 3, campaigns_sent: 3, emails_sent: 5000, emails_sent_30d: 5000,
  opens_total: 2100, clicks_total: 420, bounces_total: 30, recent_audit: rows, anomalies: { bounces: false },
  enabled: true, available: false, window_days: 30, jaccard: 0.3, intersection: 2, a_count: 5, b_count: 4,
};

const INTEGRATIONS_CATALOG = {
  schema_version: "1",
  target_public_entries: 1,
  target_native_managed: 1,
  honest_badges: ["native"],
  categories: [{ key: "ecommerce", label: "Ecommerce" }],
  capabilities: ["catalog_sync"],
  items: [
    {
      slug: "renderer-shop",
      name: "Renderer Shop",
      category: "ecommerce",
      badge: "native",
      runtime_status: "available",
      summary: "A populated renderer-test commerce connection.",
      capabilities: ["catalog_sync"],
      native: true,
      featured: true,
      sources: ["commerce"],
    },
  ],
  counts: { total: 1, native: 1 },
};

function endpointSpecificBody(pathname: string): unknown | undefined {
  switch (pathname) {
    case "/api/v1/audit/my-scopes":
      return {
        scopes: ["audit:read", "audit:read_pii"],
        auditScopes: ["audit:read", "audit:read_pii"],
        isAdmin: true,
      };
    case "/api/v1/isp-breakdown":
      return {
        window_days: 30,
        buckets: [
          {
            isp: "Gmail",
            subscribers: 120,
            sent: 100,
            opens: 52,
            clicks: 11,
            bounces: 2,
            complaints: 0,
            open_rate: 0.52,
            click_rate: 0.11,
            bounce_rate: 0.02,
            complaint_rate: 0,
          },
        ],
      };
    case "/api/v1/integrations/catalog":
      return INTEGRATIONS_CATALOG;
    case "/api/v1/integrations/connections":
      return {
        items: [
          {
            slug: "renderer-shop",
            name: "Renderer Shop",
            category: "ecommerce",
            badge: "native",
            runtime_status: "available",
            connected: true,
            status: "active",
            count: 1,
            health_state: "healthy",
          },
        ],
        summary: { connected: 1 },
      };
    case "/api/v1/sms/suppressions":
      return {
        items: [
          {
            id: "sms-supp-1",
            phone_e164: "+14155550118",
            phone: "+1 (415) 555-0118",
            reason: "manual",
            source: "operator",
            created_at: ISO,
          },
        ],
        total: 1,
      };
    case "/api/v1/sms/quiet-hours":
      return {
        items: [
          {
            id: "quiet-1",
            label: "US overnight",
            country_code: "US",
            start_minute: 1260,
            end_minute: 540,
            start_local: "21:00",
            end_local: "09:00",
            days: [0, 1, 2, 3, 4, 5, 6],
            timezone: "America/New_York",
            enabled: true,
            created_at: ISO,
            updated_at: ISO,
          },
        ],
      };
    case "/api/v1/sms/keyword-responses":
      return {
        items: [
          {
            id: "keyword-1",
            keyword: "PROMO",
            response_body: "Thanks for your interest.",
            response_text: "Thanks for your interest.",
            action: "reply_only",
            enabled: true,
            created_at: ISO,
            updated_at: ISO,
          },
        ],
      };
    case "/api/v1/sms/senders":
      return { items: [] };
    default:
      return undefined;
  }
}

const BOOT = ["/api/v1/auth/me", "/api/v1/health"];

async function installPopulated(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (BOOT.includes(p)) return route.fallback();
    const body = endpointSpecificBody(p) ?? (isBareArray(p) ? rows : OBJ);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

for (const theme of ["dark", "light"] as const) {
  for (const s of PRIMARY_DESKTOP_SECTIONS) {
    test(`pop:${s.id}:${theme}`, async ({ page, bootApp, setTheme }) => {
      const area = `${s.id}:${theme}`;
      const findingStart = findings.length;
      const flush = collect(page, area);
      await setTheme(page, theme);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await bootApp(page);
      await installPopulated(page);
      await page.goto("/");
      await waitForPrimaryNavigation(page);
      if (s.id !== "dashboard") {
        const it = page
          .getByRole("navigation", { name: "Primary" })
          .locator(`button[data-section="${s.id}"]`);
        await it.click({ timeout: 8000 }).catch(() => findings.push({ area, kind: "nav", detail: "nav failed" }));
        await expect(it).toHaveAttribute("aria-current", "page");
      }
      await page.waitForTimeout(1000);
      if (await page.locator('.pw-screen[role="alert"]', { hasText: "Something went wrong" }).count())
        findings.push({ area, kind: "error-boundary", detail: "render crash with populated data" });
      await fs.mkdir(shotDir, { recursive: true });
      await page.screenshot({ path: path.join(shotDir, `${s.id}-${theme}.png`) }).catch(() => {});
      flush();
      const testFindings = findings.slice(findingStart);
      expect(testFindings, `Failures rendering ${area}:\n${JSON.stringify(testFindings, null, 2)}`).toEqual([]);
    });
  }
}

test.afterAll(async () => {
  await fs.mkdir(reportDir, { recursive: true });
  const crashes = findings.filter((f) => f.kind === "pageerror" || f.kind === "error-boundary" || f.kind === "console");
  await fs.writeFile(path.join(reportDir, "populated-sweep.json"), JSON.stringify({ total: findings.length, crashes: crashes.length, findings }, null, 2));
});
