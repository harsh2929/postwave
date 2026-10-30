// SPDX-License-Identifier: AGPL-3.0-only
//
// Links are written two ways in this app:
//
//   <Link href="/app/flows">        — a JSX attribute
//   { label: "Flows", href: "/app/flows" }  — a property in a data array
//
// Next's typed routes cover the first. The second is just a string until it
// reaches <Link>, and the existing sweeps all matched on `href="` with an
// equals sign — so every nav array, side-link list and integrations entry went
// unchecked. That gap hid a dead empty-state link: the compatibility grid
// offered "Create an automation" pointing at /app/automations, which has never
// existed (the flow builder is /app/flows), so the one CTA shown to a tenant
// with zero automations 404'd.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const APP = join(SRC, "app");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Every route the app renders (pages and route handlers). */
function appRoutes(): Set<string> {
  const routes = new Set<string>();
  const visit = (dir: string): void => {
    let serves = false;
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) visit(p);
      else if (/^(page|route)\.tsx?$/.test(entry)) serves = true;
    }
    if (!serves) return;
    const segs = dir
      .slice(APP.length)
      .split("/")
      .filter((s) => s && !(s.startsWith("(") && s.endsWith(")")));
    routes.add(`/${segs.join("/")}`);
  };
  visit(APP);
  return routes;
}

function resolves(path: string, routes: Set<string>): boolean {
  const clean = path.split("#")[0]!.split("?")[0]!.replace(/\/$/, "") || "/";
  if (routes.has(clean)) return true;
  const want = clean.split("/").filter(Boolean);
  return [...routes].some((route) => {
    const have = route.split("/").filter(Boolean);
    if (have.length !== want.length) return false;
    return have.every((seg, i) => seg === want[i] || seg.startsWith("["));
  });
}

describe("property-style href values", () => {
  const routes = appRoutes();
  const found: { href: string; file: string }[] = [];
  for (const file of walk(SRC)) {
    for (const m of readFileSync(file, "utf8").matchAll(
      /href:\s*"(\/[^"]*)"/g,
    )) {
      found.push({ href: m[1]!, file: file.slice(SRC.length + 1) });
    }
  }

  it("finds routes and property hrefs to check", () => {
    // Guard the guard: either coming back empty would pass everything.
    expect(routes.size).toBeGreaterThan(50);
    expect(found.length).toBeGreaterThan(100);
  });

  it("points every one at a route that exists", () => {
    const dead = found
      // /api/* is served by the Go API, not this app.
      .filter(({ href }) => !href.startsWith("/api/"))
      .filter(({ href }) => !resolves(href, routes))
      .map(({ href, file }) => `${href}  (${file})`);
    expect([...new Set(dead)].sort()).toEqual([]);
  });
});
