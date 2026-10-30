// SPDX-License-Identifier: AGPL-3.0-only
//
// Every internal link that points at a FILE (has an extension) must resolve to
// something that actually ships: a file under public/, or a route handler that
// serves that exact path.
//
// The DPIA page offered a "Download PDF" button for /legal/dpia.pdf. There is
// no public/legal directory and no route handler, so the button 404'd — on a
// GDPR Article 35 page whose own instructions tell an enterprise procurement
// team to download it first. Nothing catches this: it type-checks (a plain
// <a href>), it lints, and no test rendered the page.
//
// Route-shaped links (/pricing, /docs/quickstart) are excluded — those are
// covered by Next's typed routes. This is specifically about static assets,
// which typed routes cannot see.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../", import.meta.url).pathname;
const APP_ROOT = new URL("../../", import.meta.url).pathname;
const PUBLIC = join(APP_ROOT, "public");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** A route handler that serves this literal path, e.g. app/foo/bar.json/route.ts */
function servedByRouteHandler(href: string): boolean {
  const candidate = join(SRC, "app", href.replace(/^\//, ""), "route.ts");
  return existsSync(candidate) || existsSync(candidate.replace(/\.ts$/, ".tsx"));
}

const FILE_HREF = /href="(\/[^"{}\s]*\.[a-z0-9]{2,5})"/gi;

describe("internal file links resolve", () => {
  const offenders: string[] = [];

  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(FILE_HREF)) {
      const href = m[1]!;
      if (href.startsWith("/api/")) continue; // served by the API, not this app
      const onDisk = join(PUBLIC, href.replace(/^\//, ""));
      if (existsSync(onDisk) || servedByRouteHandler(href)) continue;
      offenders.push(`${href}  (${file.slice(SRC.length)})`);
    }
  }

  it("finds file links to check", () => {
    // Guard the guard: if the regex stops matching, this must fail loudly
    // rather than pass by finding nothing.
    const anyFileHrefs = walk(SRC).some((f) =>
      /href="\/[^"{}\s]*\.[a-z0-9]{2,5}"/i.test(readFileSync(f, "utf8")),
    );
    expect(anyFileHrefs).toBe(true);
  });

  it("has no link to a static file that does not ship", () => {
    expect(offenders).toEqual([]);
  });
});
