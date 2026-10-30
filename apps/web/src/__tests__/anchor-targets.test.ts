// SPDX-License-Identifier: AGPL-3.0-only
//
// Links of the form /page#section were never actually checked. Next's typed
// routes validate the /page half and stop at the hash; every route sweep in
// this suite split on "#" and compared only the path. So an anchor pointing at
// a section that no longer exists would scroll nowhere and nothing would fail.
//
// The product mega-menu makes this an explicit promise — "every entry resolves
// to a real route or an in-page anchor of a capability page (no dead links)" —
// and six of its entries are anchors (/deliverability#domains,
// /features#editor, /features#archive, /audiences#referrals,
// /audiences#segments, /commerce#subscriptions). This is what holds the
// promise to the pages.
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

/** route path → the page file that serves it. */
function routeFiles(): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) visit(p);
      else if (/^page\.tsx?$/.test(entry)) {
        const segs = dir
          .slice(APP.length)
          .split("/")
          .filter((s) => s && !(s.startsWith("(") && s.endsWith(")")));
        out.set(`/${segs.join("/")}`, p);
      }
    }
  };
  visit(APP);
  return out;
}

/**
 * Ids a page can render. Covers literal id="x", id={"x"}, and the data-driven
 * `id={item.id}` / `id={item.slug}` shape the capability pages use, where the
 * value lives in an `id:`/`slug:` field of a SECTIONS array.
 */
function renderedIds(file: string): Set<string> {
  const text = readFileSync(file, "utf8");
  const ids = new Set<string>();
  for (const re of [
    /id="([A-Za-z0-9_-]+)"/g,
    /id=\{"([A-Za-z0-9_-]+)"\}/g,
    /\bid:\s*"([A-Za-z0-9_-]+)"/g,
    /\bslug:\s*"([A-Za-z0-9_-]+)"/g,
  ]) {
    for (const m of text.matchAll(re)) ids.add(m[1]!);
  }
  return ids;
}

describe("cross-page anchor targets", () => {
  const routes = routeFiles();
  const anchors: { route: string; anchor: string; file: string }[] = [];
  for (const file of walk(SRC)) {
    for (const m of readFileSync(file, "utf8").matchAll(
      /href[:=]\s*[{"\s]*"(\/[A-Za-z0-9/_-]*)#([A-Za-z0-9_-]+)"/g,
    )) {
      anchors.push({
        route: m[1]!,
        anchor: m[2]!,
        file: file.slice(SRC.length + 1),
      });
    }
  }

  it("finds anchors and routes to check", () => {
    // Guard the guard: either empty makes the sweep below prove nothing.
    expect(anchors.length).toBeGreaterThan(5);
    expect(routes.size).toBeGreaterThan(30);
  });

  it("points every one at a section the target page renders", () => {
    const dead = anchors
      .filter(({ route, anchor }) => {
        const file = routes.get(route);
        return !file || !renderedIds(file).has(anchor);
      })
      .map(({ route, anchor, file }) => `${route}#${anchor}  (${file})`);
    expect([...new Set(dead)].sort()).toEqual([]);
  });
});
