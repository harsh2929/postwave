// SPDX-License-Identifier: AGPL-3.0-only
//
// Every static internal href in the app, checked against the routes that
// actually exist. This is the one sweep that covers a class this audit hit
// three separate times — a link that looks fine in review and 404s in
// production — and no single existing guard spans the whole app:
//
//   * /app/automations on the compatibility empty state (the route is /app/flows)
//   * a ⌘K shortcut pointing at /docs/integrations/paypal, which a dynamic-route
//     pattern happily matched because [integration] accepts any slug
//   * the /vs migration CTAs, built from a template literal that Next's typed
//     routes and every route sweep in this suite were blind to
//
// Two things this deliberately gets right that the first version did not.
// Static files in public/ are routes too — /.well-known/security.txt is served
// from disk, not from src/app, and was reported dead until public/ was walked.
// And hrefs inside comments are not links: components/editor/preview-pane.tsx
// documents a fixed XSS vector with `href="//attacker/leak"` in prose.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { visibleCode } from "./helpers/visible-code";

const ROOT = process.cwd();
const SRC = resolve(ROOT, "src");
const APP = join(SRC, "app");
const PUBLIC = resolve(ROOT, "public");

function walk(dir: string, re: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, re, out);
    else if (re.test(p)) out.push(p);
  }
  return out;
}

/** Everything the app can serve: app routes plus files under public/. */
function servable(): { literal: Set<string>; dynamic: RegExp[] } {
  const literal = new Set<string>();
  const dynamic: RegExp[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) visit(p);
      else if (/^(page|route)\.tsx?$/.test(entry)) {
        const segs = dir
          .slice(APP.length)
          .split("/")
          .filter((s) => s && !(s.startsWith("(") && s.endsWith(")")));
        const route = `/${segs.join("/")}`;
        if (route.includes("[")) {
          dynamic.push(
            new RegExp(
              `^${route.replace(/\[\.\.\..+?\]/g, ".+").replace(/\[[^\]]+\]/g, "[^/]+")}$`,
            ),
          );
        } else literal.add(route === "/" ? "/" : route.replace(/\/$/, ""));
      }
    }
  };
  visit(APP);
  for (const file of walk(PUBLIC, /./)) {
    literal.add(file.slice(PUBLIC.length));
  }
  return { literal, dynamic };
}

describe("internal links resolve", () => {
  const { literal, dynamic } = servable();

  it("enumerates routes and static files", () => {
    // Guard the guard: too few routes and every href would look dead, which
    // is loud; an empty href list would be silent, so check both.
    expect(literal.size).toBeGreaterThan(100);
    expect(dynamic.length).toBeGreaterThan(20);
    expect(literal.has("/.well-known/security.txt")).toBe(true);
  });

  it("points every static href at something servable", () => {
    const dead = new Map<string, Set<string>>();
    let checked = 0;
    for (const file of walk(SRC, /\.tsx?$/)) {
      const text = visibleCode(readFileSync(file, "utf8"));
      for (const m of text.matchAll(
        /href[:=]\s*\{?\s*"(\/[^"#?]*)(?:[#?][^"]*)?"/g,
      )) {
        const url = m[1]!.replace(/\/$/, "") || "/";
        checked += 1;
        if (literal.has(url) || dynamic.some((re) => re.test(url))) continue;
        dead.set(url, (dead.get(url) ?? new Set()).add(file.slice(SRC.length + 1)));
      }
    }
    expect(checked).toBeGreaterThan(100); // guard the guard
    const report = [...dead.entries()]
      .map(([url, files]) => `${url}  <- ${[...files].sort().join(", ")}`)
      .sort();
    expect(report).toEqual([]);
  });

  it("keeps security.txt and the security page on the same contact", () => {
    // A disclosure policy that names one address while the machine-readable
    // file names another sends a researcher to the wrong inbox.
    const txt = readFileSync(join(PUBLIC, ".well-known/security.txt"), "utf8");
    const contact = /Contact:\s*mailto:(\S+)/.exec(txt)?.[1];
    expect(contact).toBeDefined();
    const page = readFileSync(
      join(SRC, "app/(marketing)/security/page.tsx"),
      "utf8",
    );
    expect(page).toContain(contact!);
    // …and the policy URL it advertises has to be a real page.
    const policy = /Policy:\s*https:\/\/[^/]+(\/\S*)/.exec(txt)?.[1];
    expect(policy).toBeDefined();
    expect(literal.has(policy!.replace(/\/$/, ""))).toBe(true);
  });
});
