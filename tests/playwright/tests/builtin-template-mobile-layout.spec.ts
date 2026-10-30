import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

/**
 * The built-in campaign templates must fit a phone.
 *
 * Every built-in design used fixed 600px tables and rendered 600-1036px wide
 * on a 375px screen, so recipients on phones scrolled sideways through every
 * email made from a starter. Migration 2055 rewrote the 29 designs with fluid
 * tables and a mobile stylesheet; this spec renders the exact HTML that
 * migration stores, on a real mobile browser context, and measures layout.
 *
 * It needs no running app: each design is loaded with page.setContent.
 */

const MIGRATION_DIR = path.resolve(__dirname, "../../../infra/migrations");
const MIGRATION = readdirSync(MIGRATION_DIR).find((name) =>
  name.startsWith("2055_"),
);

interface BuiltInDesign {
  slug: string;
  html: string;
  defaults: Record<string, string>;
}

function builtInDesigns(): BuiltInDesign[] {
  if (!MIGRATION) throw new Error("migration 2055 not found");
  const sql = readFileSync(path.join(MIGRATION_DIR, MIGRATION), "utf8");
  // Each VALUES row: ('slug', 'md5', $s$…$s$, $p$…$p$, NULL|$d$…$d$,
  // $b$<body>$b$, $v$<variables json>$v$::jsonb)
  const row =
    /\(\s*'([a-z0-9-]+)',\s*'[0-9a-f]{32}',[\s\S]*?\$b\$([\s\S]*?)\$b\$,\s*\$v\$([\s\S]*?)\$v\$::jsonb\s*\)/g;
  const designs: BuiltInDesign[] = [];
  for (const match of sql.matchAll(row)) {
    const variables = JSON.parse(match[3]) as Array<{
      name: string;
      default?: string;
    }>;
    designs.push({
      slug: match[1],
      html: match[2],
      defaults: Object.fromEntries(
        variables
          .filter((variable) => typeof variable.default === "string")
          .map((variable) => [variable.name, variable.default as string]),
      ),
    });
  }
  return designs;
}

// What draft creation and the send loop put in the tags, at realistic,
// deliberately long-ish lengths: a real workspace name, a real address.
const WORKSPACE_AND_SEND_TIME: Record<string, string> = {
  brand_name: "Northwind Supply Company",
  sender_name: "Alexandra Rivera-Montgomery",
  reply_to_email: "hello@northwind-supply-company.example",
  first_name: "Maximilian",
  email: "maximilian.fairweather@example-customer.com",
  unsubscribe_url:
    "https://mail.northwind-supply-company.example/subscription/form/3f9c2b7e-8d41-4f0a-9c6e-1b2d3e4f5a6b",
  archive_url:
    "https://mail.northwind-supply-company.example/archive/campaign/9b8a7c6d-5e4f-3a2b-1c0d-ef9876543210",
};

function fill(design: BuiltInDesign): string {
  return design.html.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_tag, name: string) => {
    if (name in WORKSPACE_AND_SEND_TIME) return WORKSPACE_AND_SEND_TIME[name];
    if (design.defaults[name]) return design.defaults[name];
    return name.endsWith("_url")
      ? "https://www.northwind-supply-company.example/links/a-reasonably-long-landing-page"
      : "Sample text for this field";
  });
}

const DEVICE_WIDTH_VIEWPORT =
  '<meta name="viewport" content="width=device-width, initial-scale=1">';

/**
 * Mail apps lay a message out at the screen's width whatever its HTML says,
 * as the in-app mobile preview does. A browser would lay a design without a
 * viewport tag out at 980px and zoom out, hiding the overflow; give it the
 * mail app's viewport instead.
 */
function asMailAppRenders(html: string): string {
  if (/<meta[^>]+name=["']?viewport/i.test(html)) return html;
  if (/<head(?:\s[^>]*)?>/i.test(html)) {
    return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${DEVICE_WIDTH_VIEWPORT}`);
  }
  return `<!doctype html><html><head>${DEVICE_WIDTH_VIEWPORT}</head><body>${html}</body></html>`;
}

/**
 * How far the page scrolls sideways past the screen, in CSS pixels (0 = it
 * fits). Measured against the layout viewport: a mobile browser zooms out to
 * show an overflowing page, which widens innerWidth and would hide the very
 * overflow a recipient has to pan across.
 */
async function horizontalOverflow(page: Page, html: string): Promise<number> {
  await page.setContent(asMailAppRenders(html), { waitUntil: "load" });
  return page.evaluate(
    () =>
      Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
      ) - document.documentElement.clientWidth,
  );
}

const DESIGNS = builtInDesigns();
const WIDTHS = [375, 320];

test.describe("built-in templates on a phone", () => {
  // Layout, not the app, is under test: one mobile context per engine.
  test.beforeEach(({ browserName }, testInfo) => {
    test.skip(
      !testInfo.project.name.endsWith("-mobile"),
      `phone layout runs on the mobile projects, not ${testInfo.project.name} (${browserName})`,
    );
  });

  test("the migration carries all 29 built-in designs", () => {
    expect(DESIGNS.map((design) => design.slug)).toHaveLength(29);
    expect(new Set(DESIGNS.map((design) => design.slug)).size).toBe(29);
  });

  test("the measurement catches a fixed 600px design", async ({ page }) => {
    // Control: the shape every built-in had before 2055. If this ever reads
    // 0, the checks below prove nothing.
    await page.setViewportSize({ width: 375, height: 812 });
    const fixed =
      '<!doctype html><html><head></head><body style="margin:0">' +
      '<table width="600" style="width:600px"><tr><td>Hello</td></tr></table></body></html>';
    expect(await horizontalOverflow(page, fixed)).toBeGreaterThan(200);
  });

  for (const width of WIDTHS) {
    test(`every built-in design fits a ${width}px screen`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      const overflowing: string[] = [];
      for (const design of DESIGNS) {
        const overflow = await horizontalOverflow(page, fill(design));
        if (overflow > 1) overflowing.push(`${design.slug}: +${overflow}px`);
      }
      expect(overflowing, "designs that scroll sideways").toEqual([]);
    });
  }
});
