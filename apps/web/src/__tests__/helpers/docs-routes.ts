// SPDX-License-Identifier: AGPL-3.0-only
//
// Does a /docs URL actually resolve to a page?
//
// The naive version — collect every page.tsx, turn `[param]` into `[^/]+`, and
// pattern-match — reports success for anything shaped like a route. Pointing a
// ⌘K shortcut at /docs/integrations/paypal passed that check: the dynamic
// pattern matched, so the assertion was vacuous for precisely the links most
// likely to rot, since every per-guide URL is a dynamic param.
//
// So dynamic docs segments are resolved against the data that generates them —
// the same records the routes' own generateStaticParams read — and only
// genuinely unknown shapes fall back to pattern matching.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { listOperationSlugs } from "@/lib/docs/loadOpenAPI";
import { listSkillSlugs } from "@/lib/docs/loadSkills";

const SRC = resolve(process.cwd(), "src");
const APP = join(SRC, "app");

/** Top-level keys of a `const <name> = { … }` record in a route file. */
function recordKeys(rel: string, name: string, ignore: string[]): Set<string> {
  const text = readFileSync(join(SRC, rel), "utf8");
  const start = new RegExp(`const ${name}[^=]*=\\s*\\{`).exec(text);
  const body = start ? text.slice(start.index + start[0].length) : text;
  return new Set(
    [...body.matchAll(/^ {2}"?([a-z0-9-]+)"?:\s*\{/gm)]
      .map((m) => m[1]!)
      .filter((k) => !ignore.includes(k)),
  );
}

let cached: {
  literal: Set<string>;
  dynamic: RegExp[];
  params: Record<string, Set<string>>;
} | null = null;

function load(): NonNullable<typeof cached> {
  if (cached) return cached;
  const literal = new Set<string>();
  const dynamic: RegExp[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) visit(p);
      else if (/^page\.tsx?$/.test(entry)) {
        const route = `/${dir
          .slice(APP.length)
          .split("/")
          .filter((s) => s && !(s.startsWith("(") && s.endsWith(")")))
          .join("/")}`;
        if (route.includes("[")) {
          dynamic.push(
            new RegExp(`^${route.replace(/\[[^\]]+\]/g, "[^/]+")}$`),
          );
        } else literal.add(route);
      }
    }
  };
  visit(APP);

  cached = {
    literal,
    dynamic,
    params: {
      "/docs/integrations": recordKeys(
        "app/(docs)/docs/integrations/[integration]/page.tsx",
        "INTEGRATIONS",
        ["steps"],
      ),
      "/docs/migrations": recordKeys(
        "app/(docs)/docs/migrations/[source]/page.tsx",
        "GUIDES",
        ["steps", "errors"],
      ),
      "/docs/api": new Set(listOperationSlugs().map((s) => s.endpoint)),
      "/docs/skills": new Set(listSkillSlugs().map((s) => s.skill)),
    },
  };
  return cached;
}

/** True when `url` resolves to a page that will actually render. */
export function docsRouteExists(url: string): boolean {
  const { literal, dynamic, params } = load();
  if (literal.has(url)) return true;

  const cut = url.lastIndexOf("/");
  const parent = url.slice(0, cut);
  const slug = url.slice(cut + 1);
  const known = params[parent];
  if (known) return known.has(slug);

  return dynamic.some((re) => re.test(url));
}

/** Counts, so a caller can prove the tables it is checking against are real. */
export function docsRouteStats(): { literal: number; params: number } {
  const { literal, params } = load();
  return {
    literal: literal.size,
    params: Object.values(params).reduce((n, s) => n + s.size, 0),
  };
}
