/**
 * Roadmap click-through — comprehensive crash/render sweep.
 *
 * NOT a visual-regression test. Boots the full app (Tauri stubbed, admin
 * session, empty API responses) and drives every sidebar section plus the
 * key NEW-feature interactions added by the roadmap build, capturing:
 *   - uncaught exceptions (page errors)  → real crashes
 *   - console.error messages (filtered)  → likely bugs
 *   - error-boundary activation          → page white-screened
 *   - blank render (no header + no main) → page rendered nothing
 *
 * Findings are written to tests/visual/__report__/roadmap-clickthrough.json
 * and screenshots to audit-screenshots/<date>/clickthrough/.
 *
 *   pnpm exec playwright test roadmap-clickthrough.spec.ts
 */
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { test, expect, waitForPrimaryNavigation } from "./fixture";
import type { Page } from "@playwright/test";

import { PRIMARY_DESKTOP_SECTIONS } from "./sections";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const today = new Date().toISOString().slice(0, 10);
const shotDir = path.resolve(
  __dirname, "..", "..", "..", "..", "audit-screenshots", today, "clickthrough",
);
const reportDir = path.resolve(__dirname, "..", "..", "tests", "visual", "__report__");

interface Finding {
  area: string;
  kind: "pageerror" | "console.error" | "error-boundary" | "blank" | "nav-failed" | "interaction";
  detail: string;
}
const findings: Finding[] = [];

/** console.error noise we ignore (dev warnings, resource loads, the stub's own warning). */
const NOISE = [
  "unstubbed Tauri command",
  "Failed to load resource",
  "favicon",
  "Download the React DevTools",
  "act(...)",
  "ReactDOM.render",
  "validateDOMNesting",
  "non-boolean attribute",
  "Each child in a list should have a unique",
];
function isNoise(s: string): boolean {
  return NOISE.some((n) => s.includes(n));
}

/** Override the fixture's bare-`{}` stub with shape-friendly empties so a
 *  page that reads `res.data.items.map` against a genuinely-empty server
 *  response renders its empty state instead of throwing on a missing field.
 *  Boot endpoints fall through to the fixture's real stubs. */
const EMPTY = {
  items: [], data: [], results: [], rows: [], points: [], series: [],
  buckets: [], deciles: [], schedules: [], goals: [], progress: [],
  profiles: [], conversions: [], runs: [], variants: [], steps: [],
  total: 0, count: 0, has_more: false, next_before: null,
};
const BOOT_ENDPOINTS = [
  "/api/v1/auth/me",
  "/api/v1/audit/my-scopes",
  "/api/v1/dashboard/stats",
  "/api/v1/health",
];

async function installEmptyStub(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (BOOT_ENDPOINTS.includes(p)) return route.fallback(); // let fixture handle
    await route.fulfill({
      status: 200, contentType: "application/json", body: JSON.stringify(EMPTY),
    });
  });
}

/** Attach error collectors for an area; returns a flush() that records findings. */
function collect(page: Page, area: string): () => void {
  const onPageError = (e: Error) =>
    findings.push({ area, kind: "pageerror", detail: `${e.name}: ${e.message}`.slice(0, 400) });
  const SWALLOWED = ["is not a function", "is not iterable", "Cannot read properties", "TypeError", "derivation failed"];
  const onConsole = (msg: { type(): string; text(): string }) => {
    const t = msg.text();
    const ty = msg.type();
    if (ty === "error") {
      if (!isNoise(t)) findings.push({ area, kind: "console.error", detail: t.slice(0, 400) });
      return;
    }
    // Warnings that look like a swallowed empty-data crash (caught by a
    // try/catch and logged) — the same defensive-gap class as a hard crash.
    if (ty === "warning" && SWALLOWED.some((s) => t.includes(s)) && !isNoise(t)) {
      findings.push({ area, kind: "console.error", detail: "[swallowed] " + t.slice(0, 380) });
    }
  };
  page.on("pageerror", onPageError);
  page.on("console", onConsole as never);
  return () => {
    page.off("pageerror", onPageError);
    page.off("console", onConsole as never);
  };
}

async function bootToReady(page: Page, bootApp: (p: Page) => Promise<void>): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await bootApp(page);
  await installEmptyStub(page);
  await page.goto("/");
  await waitForPrimaryNavigation(page);
}

async function assertHealthy(page: Page, area: string): Promise<void> {
  // Error boundary?
  const boundary = page.locator('.pw-screen[role="alert"]', { hasText: "Something went wrong" });
  if (await boundary.count()) {
    findings.push({ area, kind: "error-boundary", detail: "ErrorScreen rendered (render crash)" });
    return;
  }
  // Blank? (no header AND no main content container)
  const header = await page.locator(".page-header-v2, .page-header, header").count();
  const main = await page.locator("main, .app-main, .page, [class*='-page']").count();
  if (header === 0 && main === 0) {
    findings.push({ area, kind: "blank", detail: "no header and no main content rendered" });
  }
}

test.describe("clickthrough-sections", () => {
  test("navigation inventory matches every primary renderer destination", async ({ page, bootApp }) => {
    await bootToReady(page, bootApp);
    const navigation = page.getByRole("navigation", { name: "Primary" });
    const items = navigation.locator("button[data-section]");
    await expect(items).toHaveCount(PRIMARY_DESKTOP_SECTIONS.length);
    const actualSections = await items.evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("data-section")),
    );
    expect(actualSections).toEqual(
      PRIMARY_DESKTOP_SECTIONS.map(({ id }) => id),
    );
    for (const section of PRIMARY_DESKTOP_SECTIONS) {
      await expect(
        navigation.locator(`button[data-section="${section.id}"]`),
      ).toHaveAccessibleName(
        new RegExp(
          `^${section.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s+—\\s+.+)?$`,
        ),
      );
    }
  });

  for (const s of PRIMARY_DESKTOP_SECTIONS) {
    test(`section:${s.id}`, async ({ page, bootApp }) => {
      const findingStart = findings.length;
      const flush = collect(page, `section:${s.id}`);
      await bootToReady(page, bootApp);
      if (s.id !== "dashboard") {
        const item = page
          .getByRole("navigation", { name: "Primary" })
          .locator(`button[data-section="${s.id}"]`);
        if (await item.count()) {
          await item.scrollIntoViewIfNeeded().catch(() => {});
          await item.click({ timeout: 8000 }).catch((e) => {
            findings.push({ area: `section:${s.id}`, kind: "nav-failed", detail: String(e).slice(0, 200) });
          });
          await expect(item).toHaveAttribute("aria-current", "page");
        } else {
          findings.push({ area: `section:${s.id}`, kind: "nav-failed", detail: "sidebar item not found" });
        }
      }
      await page.waitForTimeout(900);
      await assertHealthy(page, `section:${s.id}`);
      await fs.mkdir(shotDir, { recursive: true });
      await page.screenshot({ path: path.join(shotDir, `${s.id}.png`), fullPage: false }).catch(() => {});
      flush();
      const testFindings = findings.slice(findingStart);
      expect(testFindings, `Failures in ${s.id}:\n${JSON.stringify(testFindings, null, 2)}`).toEqual([]);
    });
  }
});

/** Deep interactions on key new-feature pages. Missing controls and failed
 * interactions are first-class failures so this sweep cannot pass without
 * exercising the renderer paths it claims to cover. */
async function nav(page: Page, sectionId: string): Promise<void> {
  const item = page
    .getByRole("navigation", { name: "Primary" })
    .locator(`button[data-section="${sectionId}"]`);
  await expect(
    item,
    `Missing navigation destination: ${sectionId}`,
  ).toBeVisible();
  await item.scrollIntoViewIfNeeded().catch(() => {});
  await item.click({ timeout: 8000 });
  await expect(item).toHaveAttribute("aria-current", "page");
  await page.waitForTimeout(700);
}
async function clickByText(page: Page, text: string | RegExp, area: string): Promise<boolean> {
  const accessibleControl = page
    .getByRole("button", { name: text })
    .or(page.getByRole("tab", { name: text }))
    .or(page.getByRole("link", { name: text }))
    .first();
  const semanticFallback = page
    .locator("button, [role='button'], [role='tab'], a, summary")
    .filter({ hasText: text })
    .first();

  let el = accessibleControl;
  const accessibleVisible = await accessibleControl
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true, () => false);
  if (!accessibleVisible) {
    el = semanticFallback;
  }
  const visible = accessibleVisible || await semanticFallback
    .waitFor({ state: "visible", timeout: 2_000 })
    .then(() => true, () => false);
  if (!visible) {
    findings.push({ area, kind: "interaction", detail: `control not found: ${text}` });
    return false;
  }
  await el.scrollIntoViewIfNeeded().catch(() => {});
  const clicked = await el.click({ timeout: 5000 }).then(
    () => true,
    (e) => {
      findings.push({ area, kind: "interaction", detail: `click failed (${text}): ${String(e).slice(0, 120)}` });
      return false;
    },
  );
  await page.waitForTimeout(500);
  return clicked;
}

async function requireSettingsSection(
  page: Page,
  title: string,
  area: string,
): Promise<boolean> {
  const sectionTitle = page
    .locator(".settings-section-title")
    .filter({ hasText: new RegExp(`^\\s*${title}\\s*$`, "i") })
    .first();
  const attached = await sectionTitle
    .waitFor({ state: "attached", timeout: 5_000 })
    .then(() => true, () => false);
  if (!attached) {
    findings.push({ area, kind: "interaction", detail: `settings section not found: ${title}` });
    return false;
  }
  await sectionTitle.scrollIntoViewIfNeeded();
  await sectionTitle.waitFor({ state: "visible", timeout: 2_000 });
  return true;
}

const INTERACTIONS: Array<{ id: string; run: (page: Page) => Promise<void> }> = [
  { id: "campaigns:rss", run: async (page) => {
    await nav(page, "campaigns");
    await clickByText(page, /Recurring|RSS/i, "campaigns:rss");
    await clickByText(page, /Control groups/i, "campaigns:controlgroups");
    await clickByText(page, /Repl(y|ies)/i, "campaigns:replies");
  }},
  { id: "dashboard:goals-layout", run: async (page) => {
    await clickByText(page, /Edit layout/i, "dashboard:layout");
    await clickByText(page, /New goal|Add goal|Create goal/i, "dashboard:goal");
    await page.keyboard.press("Escape").catch(() => {});
  }},
  { id: "subscribers:engagement", run: async (page) => {
    await nav(page, "subscribers");
    await clickByText(page, /Browse by score|Browse/i, "subscribers:engagement");
  }},
  { id: "segments:overlap-rfm", run: async (page) => {
    await nav(page, "segments");
    await page.waitForTimeout(400);
  }},
  { id: "analytics:nlq-revenue", run: async (page) => {
    await nav(page, "analytics");
    const box = page.locator("textarea, input[type=text]").first();
    await expect(box, "Analytics natural-language query input is missing").toBeVisible();
    await box.fill("top campaigns by opens");
  }},
  { id: "sms:broadcasts", run: async (page) => {
    await nav(page, "smsInbox");
    await clickByText(page, /Broadcasts/i, "sms:broadcasts");
    await clickByText(page, /New broadcast|Compose|Create broadcast/i, "sms:broadcast-compose");
    await page.keyboard.press("Escape").catch(() => {});
  }},
  { id: "automations:triggers", run: async (page) => {
    await nav(page, "automations");
    await clickByText(page, /New trigger|Add trigger|Create/i, "automations:trigger");
    await page.keyboard.press("Escape").catch(() => {});
  }},
  { id: "templates:ai-leaderboard", run: async (page) => {
    await nav(page, "templates");
    await clickByText(page, /Generate with AI|Generate/i, "templates:ai");
    await page.keyboard.press("Escape").catch(() => {});
    await clickByText(page, /Performance/i, "templates:leaderboard");
  }},
  { id: "settings:usage-keys", run: async (page) => {
    await nav(page, "settings");
    if (await requireSettingsSection(page, "Usage", "settings:usage")) {
      await clickByText(page, /^7d$/i, "settings:usage-window");
    }
    if (await requireSettingsSection(page, "Feature flags", "settings:flags")) {
      await clickByText(page, /Set flag/i, "settings:flag-form");
    }
    if (await requireSettingsSection(page, "API keys", "settings:apikeys")) {
      const opened = await clickByText(
        page,
        /^\+\s*Create key$/i,
        "settings:apikeys",
      );
      if (opened) {
        await expect(
          page.getByRole("button", { name: "Cancel", exact: true }),
        ).toBeVisible();
      }
    }
  }},
  { id: "ai:routines", run: async (page) => {
    await nav(page, "ai");
    await clickByText(page, /Routines/i, "ai:routines");
  }},
  { id: "commerce:tabs", run: async (page) => {
    await nav(page, "commerce");
    for (const t of [/Catalogs/i, /Recovery/i, /Lifecycle/i]) await clickByText(page, t, "commerce:tabs");
  }},
  { id: "dataplatform:tabs", run: async (page) => {
    await nav(page, "dataPlatform");
    for (const t of [/Custom objects/i, /Transforms|CDP/i]) await clickByText(page, t, "dataplatform:tabs");
  }},
  { id: "forms:sections", run: async (page) => {
    await nav(page, "forms");
    await page.waitForTimeout(400);
  }},
  { id: "retention:winback", run: async (page) => {
    await nav(page, "retentionOffers");
    await page.waitForTimeout(400);
  }},
  { id: "referrals:leaderboard", run: async (page) => {
    await nav(page, "referrals");
    await page.waitForTimeout(400);
  }},
];

test.describe("clickthrough-interactions", () => {
  for (const flow of INTERACTIONS) {
    test(`interact:${flow.id}`, async ({ page, bootApp }) => {
      const findingStart = findings.length;
      const flush = collect(page, `interact:${flow.id}`);
      await bootToReady(page, bootApp);
      await flow.run(page).catch((e) =>
        findings.push({ area: `interact:${flow.id}`, kind: "interaction", detail: `flow threw: ${String(e).slice(0, 200)}` }));
      await page.waitForTimeout(500);
      await assertHealthy(page, `interact:${flow.id}`);
      await fs.mkdir(shotDir, { recursive: true });
      await page.screenshot({ path: path.join(shotDir, `interact-${flow.id.replace(/[:/]/g, "-")}.png`) }).catch(() => {});
      flush();
      const testFindings = findings.slice(findingStart);
      expect(testFindings, `Failures in ${flow.id}:\n${JSON.stringify(testFindings, null, 2)}`).toEqual([]);
    });
  }
});

test.afterAll(async () => {
  await fs.mkdir(reportDir, { recursive: true });
  const summary = {
    generated_at: new Date().toISOString(),
    total_findings: findings.length,
    by_kind: findings.reduce<Record<string, number>>((a, f) => ((a[f.kind] = (a[f.kind] || 0) + 1), a), {}),
    findings,
  };
  await fs.writeFile(path.join(reportDir, "roadmap-clickthrough.json"), JSON.stringify(summary, null, 2));
  // eslint-disable-next-line no-console
  console.log("\n=== CLICKTHROUGH REPORT ===\n" + JSON.stringify(summary, null, 2) + "\n");
});
