/**
 * Modal + tab sweep — exercises the net-new UI surfaces the empty-data
 * section sweep couldn't reach: secondary tabs (role=tab) and the
 * create/compose/generate modals. For each target page it clicks every
 * tab and every create-like button, capturing render crashes per click.
 *
 *   pnpm exec playwright test modal-tab-sweep.spec.ts --reporter=line
 */
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { test, expect, waitForPrimaryNavigation } from "./fixture";
import type { Page } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const reportDir = path.resolve(__dirname, "..", "..", "tests", "visual", "__report__");

interface Finding { area: string; kind: string; detail: string }
const findings: Finding[] = [];
const NOISE = ["unstubbed Tauri command", "Failed to load resource", "favicon", "Download the React DevTools", "MIME type", "controlled input"];
const isNoise = (s: string) => NOISE.some((n) => s.includes(n));

function collect(page: Page, area: string): () => void {
  const onErr = (e: Error) => findings.push({ area, kind: "pageerror", detail: `${e.name}: ${e.message}`.slice(0, 300) });
  const onCon = (m: { type(): string; text(): string }) => {
    const t = m.text();
    if ((m.type() === "error" || (m.type() === "warning" && /is not a function|is not iterable|Cannot read prop|TypeError/.test(t))) && !isNoise(t))
      findings.push({ area, kind: "console", detail: t.slice(0, 300) });
  };
  page.on("pageerror", onErr); page.on("console", onCon as never);
  return () => { page.off("pageerror", onErr); page.off("console", onCon as never); };
}

const EMPTY = { items: [], data: [], results: [], rows: [], points: [], series: [], buckets: [], deciles: [], schedules: [], goals: [], progress: [], profiles: [], conversions: [], runs: [], variants: [], steps: [], total: 0, count: 0, has_more: false, next_before: null };
const BOOT = ["/api/v1/auth/me", "/api/v1/dashboard/stats", "/api/v1/health"];

async function boot(page: Page, bootApp: (p: Page) => Promise<void>): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await bootApp(page);
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (BOOT.includes(p)) return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(EMPTY) });
  });
  await page.goto("/");
  await waitForPrimaryNavigation(page);
}
async function nav(page: Page, sectionId: string): Promise<void> {
  const it = page
    .getByRole("navigation", { name: "Primary" })
    .locator(`button[data-section="${sectionId}"]`);
  await expect(it, `Missing navigation destination: ${sectionId}`).toBeVisible();
  await it.scrollIntoViewIfNeeded();
  await it.click({ timeout: 8000 });
  await expect(it).toHaveAttribute("aria-current", "page");
  await page.waitForTimeout(700);
}
async function crashed(page: Page): Promise<boolean> {
  return (await page.locator('.pw-screen[role="alert"]', { hasText: "Something went wrong" }).count()) > 0;
}
const coverage: string[] = [];

/** Click every role=tab on the page in turn; record crash per tab. */
async function sweepTabs(page: Page, area: string): Promise<void> {
  const tabs = page.locator('[role="tab"]');
  const n = await tabs.count();
  coverage.push(`${area}: ${n} tabs`);
  if (n === 0) {
    findings.push({ area, kind: "coverage", detail: "expected at least one tab" });
    return;
  }
  for (let i = 0; i < n; i++) {
    const t = tabs.nth(i);
    const label = (await t.textContent().catch(() => "") ?? "").trim().slice(0, 24);
    await t.click({ timeout: 4000 }).catch((error) =>
      findings.push({ area: `${area}:tab[${label}]`, kind: "interaction", detail: String(error).slice(0, 200) }),
    );
    await page.waitForTimeout(500);
    if (await crashed(page)) findings.push({ area: `${area}:tab[${label}]`, kind: "error-boundary", detail: "crash after tab click" });
  }
}
/** Click create/compose/generate-like buttons, screenshot, Escape. */
async function sweepCreateButtons(page: Page, area: string, patterns: RegExp[]): Promise<void> {
  let openedCount = 0;
  for (const re of patterns) {
    const btn = page.getByRole("button", { name: re }).first();
    if (!(await btn.count())) { coverage.push(`${area}: btn NOT FOUND /${re.source}/`); continue; }
    await btn.scrollIntoViewIfNeeded();
    const clicked = await btn.click({ timeout: 4000 }).then(
      () => true,
      (error) => {
        findings.push({ area, kind: "interaction", detail: `/${re.source}/ click failed: ${String(error).slice(0, 180)}` });
        return false;
      },
    );
    if (!clicked) continue;
    await page.waitForTimeout(600);
    const dlg = await page.locator(".modal-card, [role=dialog]").count();
    coverage.push(`${area}: opened /${re.source}/ dialog=${dlg}`);
    if (dlg === 0) {
      findings.push({ area, kind: "coverage", detail: `/${re.source}/ did not open a dialog` });
      continue;
    }
    openedCount += 1;
    if (await crashed(page)) findings.push({ area: `${area}:modal[${re.source.slice(0, 20)}]`, kind: "error-boundary", detail: "crash after open" });
    await page.keyboard.press("Escape");
    await expect(page.locator(".modal-card, [role=dialog]").first()).toBeHidden();
    await page.waitForTimeout(200);
  }
  if (openedCount === 0) {
    findings.push({ area, kind: "coverage", detail: "no expected create dialog opened" });
  }
}

const TARGETS: Array<{ id: string; run: (p: Page) => Promise<void> }> = [
  { id: "commerce", run: async (p) => { await nav(p, "commerce"); await sweepTabs(p, "commerce"); } },
  { id: "dataPlatform", run: async (p) => { await nav(p, "dataPlatform"); await sweepTabs(p, "dataPlatform"); } },
  { id: "sms-broadcasts", run: async (p) => { await nav(p, "smsInbox"); await sweepTabs(p, "sms");
    await p.getByRole("tab", { name: /Broadcasts/i }).first().click({ timeout: 4000 });
    await p.waitForTimeout(600);
    await sweepCreateButtons(p, "sms", [/New broadcast/i, /Compose/i, /Create broadcast/i]); } },
  { id: "automations", run: async (p) => { await nav(p, "automations");
    await sweepCreateButtons(p, "automations", [/New trigger/i, /Add trigger/i, /New keyword/i, /New campaign/i]); } },
  { id: "templates", run: async (p) => { await nav(p, "templates"); await sweepCreateButtons(p, "templates", [/Generate with AI/i]); } },
  { id: "ai-routines", run: async (p) => { await nav(p, "ai");
    const routines = p.getByRole("tab", { name: /Routines/i }).first();
    await expect(routines).toBeVisible();
    await routines.click({ timeout: 4000 });
    await p.waitForTimeout(500);
    await sweepCreateButtons(p, "ai", [/New routine/i]); } },
  { id: "dashboard", run: async (p) => {
    await expect(p.getByRole("button", { name: /New goal/i }).first()).toBeVisible({ timeout: 15_000 });
    await sweepCreateButtons(p, "dashboard", [/New goal/i, /Add goal/i, /Set a goal/i]);
  } },
  { id: "campaigns", run: async (p) => { await nav(p, "campaigns"); await sweepCreateButtons(p, "campaigns", [/New campaign/i, /Create campaign/i]); } },
  { id: "sequences", run: async (p) => { await nav(p, "sequences"); await sweepCreateButtons(p, "sequences", [/New sequence/i, /Create sequence/i]); } },
  { id: "settings", run: async (p) => { await nav(p, "settings");
    for (const re of [/Usage/i, /Feature flags/i, /API keys/i, /Firewall/i]) {
      const h = p.locator(".settings-section-title").filter({ hasText: re }).first();
      await expect(h, `Missing settings section: ${re.source}`).toBeVisible();
      await h.scrollIntoViewIfNeeded();
      if (await crashed(p)) findings.push({ area: `settings:${re.source}`, kind: "error-boundary", detail: "crash on reveal" });
    } } },
];

for (const tgt of TARGETS) {
  test(`sweep:${tgt.id}`, async ({ page, bootApp }) => {
    const findingStart = findings.length;
    const flush = collect(page, `sweep:${tgt.id}`);
    await boot(page, bootApp);
    await tgt.run(page).catch((e) => findings.push({ area: `sweep:${tgt.id}`, kind: "threw", detail: String(e).slice(0, 200) }));
    if (await crashed(page)) findings.push({ area: `sweep:${tgt.id}`, kind: "error-boundary", detail: "page crashed" });
    flush();
    const testFindings = findings.slice(findingStart);
    expect(testFindings, `Failures while sweeping ${tgt.id}:\n${JSON.stringify(testFindings, null, 2)}`).toEqual([]);
  });
}

test.afterAll(async () => {
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "modal-tab-sweep.json"), JSON.stringify({ total: findings.length, findings, coverage }, null, 2));
  // eslint-disable-next-line no-console
  console.log("\n=== MODAL/TAB SWEEP ===\n" + JSON.stringify(findings, null, 2));
});
