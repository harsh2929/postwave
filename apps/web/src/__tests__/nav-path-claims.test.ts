// SPDX-License-Identifier: AGPL-3.0-only
//
// Public copy that says "Settings → X" is giving a customer directions. If X
// is not a real settings page, the directions dead-end.
//
// This class was everywhere once we looked: the refund policy sent people to
// "Settings → Billing → Request refund" (Billing is top-level, and the control
// does not exist); the Terms offered "Settings → Account → Close account"
// while its own sibling legal page correctly said Settings → Privacy; the
// migration guides said "Settings → Migrations" eight times when Migrations is
// a top-level section; the integration guides pointed at a "Settings → Sending"
// screen that was never built.
//
// Truth comes from lib/dashboard-routes.ts — the same file that renders the
// sidebar — so the copy and the nav cannot drift apart silently.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");

function visibleCopy(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/&rarr;/g, "→")
    // Copy is written with three different arrows. "Settings -> Migrations"
    // in a Sendy guide was the same broken path as its eight → siblings and
    // survived the first sweep purely because the arrow was ASCII.
    .replace(/\s->\s/g, " → ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

/** label → href pairs, exactly as the sidebar renders them. */
function navEntries(): { label: string; href: string }[] {
  const src = readFileSync(join(SRC, "lib/dashboard-routes.ts"), "utf8");
  return [...src.matchAll(/label:\s*"([^"]+)",\s*\n\s*href:\s*"([^"]+)"/g)].map(
    (m) => ({ label: m[1]!, href: m[2]! }),
  );
}

function settingsLabels(): Set<string> {
  return new Set(
    navEntries()
      .filter((e) => e.href.startsWith("/app/settings/"))
      .map((e) => e.label.toLowerCase()),
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

function publicPages(): string[] {
  return [
    ...walk(join(SRC, "app/(marketing)")),
    ...walk(join(SRC, "app/(docs)")),
  ];
}

/** Every route the app actually renders, route-group markers stripped. */
function appRoutes(): Set<string> {
  const appDir = join(SRC, "app");
  const routes = new Set<string>();
  const visit = (dir: string): void => {
    let hasPage = false;
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) visit(p);
      else if (/^page\.tsx?$/.test(entry)) hasPage = true;
    }
    if (!hasPage) return;
    const segs = dir
      .slice(appDir.length)
      .split("/")
      .filter((s) => s && !(s.startsWith("(") && s.endsWith(")")));
    routes.add(`/${segs.join("/")}`);
  };
  visit(appDir);
  return routes;
}

/** Dynamic segments match anything; /app-prefixed equivalents count too. */
function routeExists(path: string, routes: Set<string>): boolean {
  if (routes.has(path) || routes.has(`/app${path}`)) return true;
  const want = path.split("/").filter(Boolean);
  return [...routes].some((route) => {
    const have = route.split("/").filter(Boolean);
    if (have.length !== want.length) return false;
    return have.every((seg, i) => seg === want[i] || seg.startsWith("["));
  });
}

// "Settings → X", with the preceding token captured so third-party consoles
// can be excluded. Our own sidebar path always begins with a bare "Settings";
// a vendor's does not — "Mailgun → Settings → API Keys" and "ConvertKit's
// Account Settings → Account info" are both someone else's UI.
const SETTINGS_HOP =
  /(\S+)?\s*\bSettings\s*→\s*([A-Za-z][A-Za-z &-]{1,28}?)(?=\s*(?:→|[.,"“”)]|$))/g;

/** True when the hop belongs to a third-party console rather than ours. */
function isThirdPartyPath(precedingToken: string | undefined): boolean {
  if (!precedingToken) return false;
  return (
    precedingToken === "→" || // "Mailgun → Settings → …"
    precedingToken.endsWith("'s") ||
    precedingToken.endsWith("’s") ||
    /^[A-Z][a-z]+$/.test(precedingToken) // "Account Settings", "Sendy Settings"
  );
}

describe("public copy points at settings pages that exist", () => {
  it("reads the nav and the public pages", () => {
    // Guard the guard: an empty label set would make every path "invalid" and
    // an empty page list would make the sweep pass vacuously.
    expect(settingsLabels().size).toBeGreaterThan(10);
    expect(publicPages().length).toBeGreaterThan(30);
  });

  it("names a real settings page in every Settings → X reference", () => {
    const valid = settingsLabels();
    const offenders: string[] = [];

    for (const file of publicPages()) {
      const copy = visibleCopy(file);
      for (const m of copy.matchAll(SETTINGS_HOP)) {
        if (isThirdPartyPath(m[1])) continue;
        const target = m[2]!.trim();
        if (valid.has(target.toLowerCase())) continue;
        offenders.push(
          `Settings → ${target}  (${file.slice(SRC.length + 1)})`,
        );
      }
    }

    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  it("resolves app paths written as URLs in prose", () => {
    // The same defect also shows up slash-shaped: a migration guide told users
    // to "Connect Stripe at /settings/integrations/stripe", which has no page —
    // Integrations is a single settings screen with no per-provider child.
    // href= links are excluded here; Next's typed routes already cover those,
    // and these are bare paths in body copy that nothing type-checks.
    const real = appRoutes();
    const offenders: string[] = [];

    for (const file of publicPages()) {
      const copy = readFileSync(file, "utf8")
        .replace(/href="[^"]*"/g, "")
        .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "");
      for (const m of copy.matchAll(
        /(?<![\w"/])(\/(?:settings|app|dashboard|subscribers|campaigns|migrations|billing)[a-z0-9/_-]*)/g,
      )) {
        const path = m[1]!.replace(/[/.,]+$/, "");
        if (routeExists(path, real)) continue;
        offenders.push(`${path}  (${file.slice(SRC.length + 1)})`);
      }
    }

    expect([...new Set(offenders)].sort()).toEqual([]);
  });
});
