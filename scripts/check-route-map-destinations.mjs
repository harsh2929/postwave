#!/usr/bin/env node
//
// scripts/check-route-map-destinations.mjs
//
// Proves that every destination @postwave/route-map claims actually exists.
//
// The registry is the one place every surface builds entity links from — the
// dashboard resume card, the activity feed, "copy link", search results,
// notification routes, QR handoff and the `moosewave://` deep-link scheme. A
// wrong entry there is not a typo; it is a link that 404s or silently does
// nothing, on a surface nobody tested, for a user who was told to go there.
//
// That has already happened twice in this registry's short life:
//   - `approval.mobileDetail` sat at `false` after mobile shipped
//     app/(tabs)/approvals/[id].tsx, so "approve on your phone" dropped the
//     approver on a queue instead of the request they were notified about;
//   - web never had an `approvals/[id]` route at all, so the id-addressed path
//     the registry minted was a hard Next.js 404 on the web dashboard.
//
// Both were invisible to the type system and to every unit test, because the
// registry describes the filesystem and nothing checked it against one.
//
// What this verifies, per entity, against the real tree:
//   web     "detail" → apps/web/src/app/(dashboard)/app/<slug>/[<param>]/page.tsx
//           "list"   → .../<slug>/page.tsx and NO dynamic segment
//           "none"   → no .../<slug> route directory
//   mobile  "detail" → apps/mobile/app/(tabs)/<slug>/[id].tsx
//           "list"   → app/(tabs)/<slug>.tsx or <slug>/index.tsx, and no [id].tsx
//           "none"   → neither
//   desktop non-none → <slug> is a value in desktop-router.ts SECTION_SLUGS
//           "none"   → <slug> is NOT (so the path would hit unknown-destination)
//   rust             → deep_link.rs ENTITY_COLLECTIONS matches exactly the
//                      desktop-routable entities, with identical slugs
//   keys             → match the Rust action grammar [a-z][a-z-]* and are unique
//   slugs            → unique across entities
//
// Run `--self-test` to exercise the checker against synthetic registries.
//
// Exit non-zero on any breach.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const ENTITIES_SRC = "packages/route-map/src/entities.ts";
const DESKTOP_ROUTER = "apps/desktop/src/lib/desktop-router.ts";
const RUST_PARSER = "apps/desktop/src-tauri/src/deep_link.rs";
const WEB_APP_DIR = "apps/web/src/app/(dashboard)/app";
const MOBILE_TABS_DIR = "apps/mobile/app/(tabs)";
const SEARCH_UNION_SRC = "packages/route-map/src/search.ts";
const SEARCH_INDEX_GO = "apps/api/internal/search/index.go";

/**
 * Entities the Rust shell handles outside ENTITY_COLLECTIONS. `subscriber` is
 * addressed by email, not resource id, and routes to
 * `/app/subscribers?email=…` from its own match arm.
 */
const RUST_SPECIAL_CASED = new Set(["subscriber"]);

const SURFACE_SUPPORTS = new Set(["detail", "list", "none"]);
const ACTION_KEY_RE = /^[a-z][a-z-]*$/;

/**
 * Parse the ENTITIES literal. Deliberately a narrow regex rather than a TS
 * import: this script must run with plain node in CI before anything is built,
 * and the table is a flat literal by design.
 */
export function parseEntities(src) {
  const entities = [];
  const errors = [];

  // Fail CLOSED on a parse miss. The matcher below requires key → slug →
  // surfaces in that order and adjacency; a comment between two fields, or a
  // reordered `surfaces` before `slug`, silently yields one entity fewer and
  // every check for it is skipped with no error — the exact "looks verified,
  // isn't" failure this script exists to prevent. So count the members
  // independently (each `key: "…"` line) and demand the totals agree.
  const declaredKeys = [...src.matchAll(/^\s*key:\s*"([^"]+)"/gm)].map(
    (m) => m[1],
  );

  const re =
    /key:\s*"([^"]+)"\s*,\s*slug:\s*"([^"]+)"\s*,\s*surfaces:\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const [, key, slug, surfacesBody] = m;
    const surfaces = {};
    for (const s of ["web", "desktop", "mobile"]) {
      const sm = new RegExp(`${s}\\s*:\\s*"([^"]+)"`).exec(surfacesBody);
      if (!sm) {
        errors.push(`${key}: surfaces.${s} is missing`);
        continue;
      }
      if (!SURFACE_SUPPORTS.has(sm[1])) {
        errors.push(
          `${key}: surfaces.${s} = "${sm[1]}" is not a SurfaceSupport`,
        );
        continue;
      }
      surfaces[s] = sm[1];
    }
    entities.push({ key, slug, surfaces });
  }

  const parsed = new Set(entities.map((e) => e.key));
  const dropped = declaredKeys.filter((k) => !parsed.has(k));
  if (dropped.length > 0) {
    errors.push(
      `${ENTITIES_SRC}: ${dropped.length} entit${dropped.length === 1 ? "y" : "ies"} ` +
        `(${dropped.join(", ")}) declare a \`key\` but did not parse — this script ` +
        `would have skipped every check for them. Keep each entry as ` +
        `\`key\`, \`slug\`, \`surfaces\` in that order with no comment between the ` +
        `fields, or update the matcher.`,
    );
  }
  return { entities, errors };
}

/** Values of desktop-router.ts SECTION_SLUGS. */
export function parseDesktopSlugs(src) {
  const start = src.indexOf("const SECTION_SLUGS");
  if (start === -1) return null;
  const open = src.indexOf("{", start);
  const close = src.indexOf("};", open);
  if (open === -1 || close === -1) return null;
  const body = src.slice(open, close);
  return new Set([...body.matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]));
}

/** `(action, collection)` pairs from deep_link.rs ENTITY_COLLECTIONS. */
export function parseRustCollections(src) {
  const start = src.indexOf("const ENTITY_COLLECTIONS");
  if (start === -1) return null;
  const open = src.indexOf("[", start);
  const close = src.indexOf("];", open);
  if (open === -1 || close === -1) return null;
  const body = src.slice(open, close);
  return new Map(
    [...body.matchAll(/\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
}

/**
 * Run every check. `fs` supplies filesystem answers so the self-test can model
 * a synthetic tree:
 *   read(path)        → file contents or null
 *   dirExists(path)   → boolean
 *   fileExists(path)  → boolean
 *   dynamicSegments(dir) → the `[param]` child DIRECTORY names of `dir`
 *                          (web: `[id]/page.tsx`)
 *   dynamicRouteFiles(dir) → the `[param].tsx` child FILE names of `dir`
 *                          (mobile: expo-router puts the segment in the
 *                          filename, so a directory scan misses it entirely)
 */
/**
 * The types `GET /api/v1/search` actually emits, read off the Go source.
 *
 * `index.go` collects each type with a literal:
 *     r.collect(ctx, tx, &resp.Results, limit, "campaign", `…`)
 * so the fifth argument is the contract. Parsing it means the TypeScript union
 * cannot drift from the server in either direction — a type the server added
 * that no client wired, or a type a client still branches on that the server
 * stopped sending. Desktop carried a `tag` branch for a type the server has
 * never emitted, which read like coverage and was dead code.
 */
export function parseServerSearchTypes(goSrc) {
  const types = [];
  const re = /r\.collect\(\s*ctx\s*,\s*tx\s*,\s*&resp\.Results\s*,\s*limit\s*,\s*"([a-z_-]+)"/g;
  let m;
  while ((m = re.exec(goSrc)) !== null) types.push(m[1]);
  return types;
}

/** The union declared in search.ts, in source order. */
export function parseSearchUnion(tsSrc) {
  const block = /export const SEARCH_HIT_TYPES = \[([\s\S]*?)\] as const;/.exec(tsSrc);
  if (!block) return null;
  return [...block[1].matchAll(/"([a-z_-]+)"/g)].map((m) => m[1]);
}

export function runChecks(fs) {
  const errors = [];

  // --- search result-type union vs the server ------------------------------
  const goSrc = fs.read(SEARCH_INDEX_GO);
  const searchSrc = fs.read(SEARCH_UNION_SRC);
  if (goSrc && searchSrc) {
    const server = parseServerSearchTypes(goSrc);
    const union = parseSearchUnion(searchSrc);
    if (server.length === 0) {
      errors.push(
        `${SEARCH_INDEX_GO}: parsed zero search types — regex drift? The union ` +
          `check is silently passing.`,
      );
    } else if (union === null) {
      errors.push(`${SEARCH_UNION_SRC}: cannot parse SEARCH_HIT_TYPES.`);
    } else {
      const missing = server.filter((t) => !union.includes(t));
      const extra = union.filter((t) => !server.includes(t));
      for (const t of missing) {
        errors.push(
          `search type "${t}" is indexed by ${SEARCH_INDEX_GO} but absent from ` +
            `SEARCH_HIT_TYPES, so every client drops those hits with no error.`,
        );
      }
      for (const t of extra) {
        errors.push(
          `SEARCH_HIT_TYPES declares "${t}", which ${SEARCH_INDEX_GO} never ` +
            `emits — dead branches that read like coverage.`,
        );
      }
    }
  }

  const entitiesSrc = fs.read(ENTITIES_SRC);
  if (!entitiesSrc) return [`cannot read ${ENTITIES_SRC}`];
  const { entities, errors: parseErrors } = parseEntities(entitiesSrc);
  errors.push(...parseErrors);
  if (entities.length === 0) {
    return [...errors, `${ENTITIES_SRC}: parsed zero entities — regex drift?`];
  }

  // --- key / slug hygiene --------------------------------------------------
  const seenKeys = new Set();
  const seenSlugs = new Map();
  for (const { key, slug } of entities) {
    if (!ACTION_KEY_RE.test(key)) {
      errors.push(
        `${key}: entity keys double as \`moosewave://<action>/…\` actions and ` +
          `deep_link.rs accepts only [a-z-]. A camelCase key mints a link the ` +
          `desktop shell rejects as malformed.`,
      );
    }
    if (seenKeys.has(key)) errors.push(`${key}: duplicate entity key`);
    seenKeys.add(key);
    if (seenSlugs.has(slug)) {
      errors.push(
        `slug "${slug}" is used by both \`${seenSlugs.get(slug)}\` and \`${key}\` — ` +
          `entityForSlug() resolves a slug to exactly one entity, so the second ` +
          `is unreachable when parsing a universal link.`,
      );
    }
    seenSlugs.set(slug, key);
  }

  // Entities whose web route is deliberately nested under another section, so
  // `surfaces.web: "none"` is a known limitation of the single-slug model
  // rather than an overlooked route. Parsed from the registry so the
  // acknowledgement lives next to the entity it describes.
  // Comments are stripped first: the entries are documented with the real
  // route path, and a path like `.../segments/[id]/page.tsx` contains a `]`
  // that terminates the block match early — capturing nothing and silently
  // treating every acknowledgement as absent. Anchoring on `=` likewise avoids
  // the bracket pair in the `readonly string[]` annotation.
  const ackBlock = /WEB_NESTED_ROUTE_ACK[^=]*=\s*\[([\s\S]*?)\]/.exec(
    entitiesSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""),
  );
  const nestedAck = new Set(
    ackBlock ? [...ackBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [],
  );

  // --- web -----------------------------------------------------------------
  for (const { key, slug, surfaces } of entities) {
    const dir = `${WEB_APP_DIR}/${slug}`;
    const hasDir = fs.dirExists(dir);
    const hasList = fs.fileExists(`${dir}/page.tsx`);
    const dynamic = hasDir ? fs.dynamicSegments(dir) : [];
    const hasDetail = dynamic.some((seg) =>
      fs.fileExists(`${dir}/${seg}/page.tsx`),
    );

    switch (surfaces.web) {
      case "detail":
        if (!hasDetail) {
          errors.push(
            `${key}: surfaces.web = "detail" but ${dir} has no dynamic segment ` +
              `with a page.tsx. webPath() would mint /app/${slug}/<id>, which ` +
              `Next.js answers with a 404.`,
          );
        }
        break;
      case "list":
        if (!hasList) {
          errors.push(
            `${key}: surfaces.web = "list" but ${dir}/page.tsx does not exist.`,
          );
        }
        if (hasDetail) {
          errors.push(
            `${key}: surfaces.web = "list" but ${dir} DOES have a detail route ` +
              `(${dynamic.join(", ")}). Links are being downgraded to the ` +
              `collection for no reason — promote it to "detail".`,
          );
        }
        break;
      case "none": {
        if (hasDir) {
          errors.push(
            `${key}: surfaces.web = "none" but ${dir} exists — web can serve ` +
              `this entity and is being denied a link.`,
          );
          break;
        }
        // Web may ship the entity NESTED under another section
        // (`subscribers/segments/[id]`, `integrations/catalog/[slug]`). The
        // registry addresses everything as `/app/<slug>/<id>`, so it cannot
        // express those and correctly emits no web link — but "no link" must
        // be a KNOWN nesting rather than an unnoticed gap, or a future
        // top-level route would silently stay unlinked.
        const nested = fs.findNestedRoute(WEB_APP_DIR, slug);
        if (nested && !nestedAck.has(key)) {
          errors.push(
            `${key}: surfaces.web = "none", but web ships this entity at ` +
              `${nested} — a path the single-slug \`/app/<slug>/<id>\` model ` +
              `cannot express. If that nesting is intended, add "${key}" to ` +
              `WEB_NESTED_ROUTE_ACK in ${ENTITIES_SRC} with the real path; if ` +
              `it moved to a top-level route, set surfaces.web accordingly.`,
          );
        }
        if (!nested && nestedAck.has(key)) {
          errors.push(
            `${key}: listed in WEB_NESTED_ROUTE_ACK but web has no nested ` +
              `${slug} route any more — remove the acknowledgement and give ` +
              `the entity its real surfaces.web value.`,
          );
        }
        break;
      }
      default:
        break;
    }
  }

  // --- mobile --------------------------------------------------------------
  for (const { key, slug, surfaces } of entities) {
    // ANY single dynamic segment, not literally `[id].tsx`. An expo-router
    // dynamic segment matches one path component whatever its param is named,
    // so `[email].tsx` resolves /(tabs)/suppressions/<value> exactly as
    // `[id].tsx` would — the same reasoning this file already applies to web,
    // where the param name varies ([id], [jobId], [code]) without affecting the
    // emitted path. Requiring the literal name rejected a screen that works.
    const dynamicChildren = fs.dynamicRouteFiles(`${MOBILE_TABS_DIR}/${slug}`);
    const detailFile =
      dynamicChildren.length > 0
        ? `${MOBILE_TABS_DIR}/${slug}/${dynamicChildren[0]}`
        : `${MOBILE_TABS_DIR}/${slug}/[id].tsx`;
    const hasDetail = dynamicChildren.length > 0;
    const hasList =
      fs.fileExists(`${MOBILE_TABS_DIR}/${slug}.tsx`) ||
      fs.fileExists(`${MOBILE_TABS_DIR}/${slug}/index.tsx`);

    switch (surfaces.mobile) {
      case "detail":
        if (!hasDetail) {
          errors.push(
            `${key}: surfaces.mobile = "detail" but ${detailFile} does not ` +
              `exist. mobilePath() would mint /(tabs)/${slug}/<id> into a ` +
              `route expo-router cannot resolve.`,
          );
        }
        break;
      case "list":
        if (!hasList) {
          errors.push(
            `${key}: surfaces.mobile = "list" but neither ` +
              `${MOBILE_TABS_DIR}/${slug}.tsx nor ${slug}/index.tsx exists.`,
          );
        }
        if (hasDetail) {
          errors.push(
            `${key}: surfaces.mobile = "list" but ${detailFile} EXISTS. This is ` +
              `the exact staleness that sent approvers to a queue instead of ` +
              `the request they were notified about — promote it to "detail".`,
          );
        }
        break;
      case "none":
        if (hasDetail || hasList) {
          errors.push(
            `${key}: surfaces.mobile = "none" but mobile ships a ${slug} screen.`,
          );
        }
        break;
      default:
        break;
    }
  }

  // --- desktop -------------------------------------------------------------
  const desktopSrc = fs.read(DESKTOP_ROUTER);
  const desktopSlugs = desktopSrc ? parseDesktopSlugs(desktopSrc) : null;
  if (!desktopSlugs || desktopSlugs.size === 0) {
    errors.push(`${DESKTOP_ROUTER}: could not parse SECTION_SLUGS.`);
  } else {
    for (const { key, slug, surfaces } of entities) {
      const known = desktopSlugs.has(slug);
      if (surfaces.desktop !== "none" && !known) {
        errors.push(
          `${key}: surfaces.desktop = "${surfaces.desktop}" but "${slug}" is not ` +
            `in desktop's SECTION_SLUGS, so /app/${slug} fails to parse with ` +
            `unknown-destination.`,
        );
      }
      if (surfaces.desktop === "none" && known) {
        errors.push(
          `${key}: surfaces.desktop = "none" but "${slug}" IS a desktop section — ` +
            `desktop is being denied a link it can render.`,
        );
      }
    }
  }

  // --- rust deep-link table ------------------------------------------------
  const rustSrc = fs.read(RUST_PARSER);
  const rust = rustSrc ? parseRustCollections(rustSrc) : null;
  if (!rust) {
    errors.push(`${RUST_PARSER}: could not parse ENTITY_COLLECTIONS.`);
  } else {
    const expected = new Map(
      entities
        .filter(
          (e) =>
            e.surfaces.desktop !== "none" && !RUST_SPECIAL_CASED.has(e.key),
        )
        .map((e) => [e.key, e.slug]),
    );
    for (const [key, slug] of expected) {
      if (!rust.has(key)) {
        errors.push(
          `${key}: desktop routes it, but ${RUST_PARSER} ENTITY_COLLECTIONS has ` +
            `no entry — \`moosewave://${key}/<id>\` is rejected as an unknown ` +
            `action, so the deep link the registry mints does nothing.`,
        );
      } else if (rust.get(key) !== slug) {
        errors.push(
          `${key}: slug mismatch — registry "${slug}" vs ${RUST_PARSER} ` +
            `"${rust.get(key)}". The shell would navigate somewhere else.`,
        );
      }
    }
    for (const key of rust.keys()) {
      if (!expected.has(key)) {
        errors.push(
          `${RUST_PARSER}: ENTITY_COLLECTIONS routes "${key}", which the registry ` +
            `does not mark desktop-routable. Either add it to the registry or ` +
            `drop it here — the shell would open a section desktop may not have.`,
        );
      }
    }
  }

  return errors;
}

// --- real filesystem adapter ---------------------------------------------

function realFs() {
  const abs = (p) => resolve(repoRoot, p);
  return {
    read: (p) => {
      try {
        return readFileSync(abs(p), "utf8");
      } catch {
        return null;
      }
    },
    dirExists: (p) => {
      try {
        return statSync(abs(p)).isDirectory();
      } catch {
        return false;
      }
    },
    fileExists: (p) => existsSync(abs(p)) && statSync(abs(p)).isFile(),
    dynamicSegments: (p) => {
      try {
        return readdirSync(abs(p), { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^\[.+\]$/.test(d.name))
          .map((d) => d.name);
      } catch {
        return [];
      }
    },
    dynamicRouteFiles: (p) => {
      try {
        return readdirSync(abs(p), { withFileTypes: true })
          .filter((d) => d.isFile() && /^\[.+\]\.tsx$/.test(d.name))
          .map((d) => d.name);
      } catch {
        return [];
      }
    },
    /**
     * Find a `<slug>/[param]/page.tsx` anywhere BELOW `root`, skipping the
     * top-level `<slug>` (which the main checks already cover). Route groups
     * `(name)` are traversed, so a detail page inside one is still found.
     */
    findNestedRoute: (root, slug) => {
      const walk = (rel, depth) => {
        if (depth > 4) return null;
        let entries;
        try {
          entries = readdirSync(abs(rel), { withFileTypes: true });
        } catch {
          return null;
        }
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const child = `${rel}/${e.name}`;
          if (e.name === slug && rel !== root) {
            for (const seg of readdirSync(abs(child), {
              withFileTypes: true,
            })) {
              if (
                seg.isDirectory() &&
                /^\[.+\]$/.test(seg.name) &&
                existsSync(abs(`${child}/${seg.name}/page.tsx`))
              ) {
                return `${child}/${seg.name}/page.tsx`;
              }
            }
          }
          const found = walk(child, depth + 1);
          if (found) return found;
        }
        return null;
      };
      return walk(root, 0);
    },
  };
}

// --- self-test ------------------------------------------------------------

const BASE_DESKTOP_ROUTER = `
const SECTION_SLUGS: Record<RoutableDesktopSection, string> = {
  widgets: "widgets",
  gadgets: "gadgets",
};
`;

const BASE_RUST = `
const ENTITY_COLLECTIONS: &[(&str, &str)] = &[
    ("widget", "widgets"),
];
`;

function registrySrc(entries, { ack = [], raw = null } = {}) {
  if (raw !== null) return raw;
  const body = entries
    .map(
      (e) => `  ${e.key}: {
    key: "${e.key}",
    slug: "${e.slug}",
    surfaces: { web: "${e.web}", desktop: "${e.desktop}", mobile: "${e.mobile}" },
  },`,
    )
    .join("\n");
  return (
    `export const ENTITIES = {\n${body}\n} as const;\n` +
    `export const WEB_NESTED_ROUTE_ACK: readonly string[] = [${ack
      .map((k) => `"${k}"`)
      .join(", ")}];\n`
  );
}

/** Model a tree as a flat set of existing paths. */
function fakeFs({
  entries,
  paths = [],
  desktop = BASE_DESKTOP_ROUTER,
  rust = BASE_RUST,
  ack = [],
  rawRegistry = null,
  searchGo = null,
  searchUnion = null,
}) {
  const files = new Set(paths.filter((p) => !p.endsWith("/")));
  const dirs = new Set();
  for (const p of paths) {
    const parts = p.replace(/\/$/, "").split("/");
    for (let i = 1; i < parts.length; i += 1)
      dirs.add(parts.slice(0, i).join("/"));
    if (p.endsWith("/")) dirs.add(p.replace(/\/$/, ""));
  }
  return {
    read: (p) =>
      p === ENTITIES_SRC
        ? registrySrc(entries, { ack, raw: rawRegistry })
        : p === DESKTOP_ROUTER
          ? desktop
          : p === RUST_PARSER
            ? rust
            : p === SEARCH_INDEX_GO
              ? searchGo
              : p === SEARCH_UNION_SRC
                ? searchUnion
                : null,
    dirExists: (p) => dirs.has(p),
    fileExists: (p) => files.has(p),
    dynamicSegments: (p) =>
      [...dirs]
        .filter((d) => d.startsWith(`${p}/`))
        .map((d) => d.slice(p.length + 1).split("/")[0])
        .filter((n) => /^\[.+\]$/.test(n)),
    dynamicRouteFiles: (p) =>
      [...files]
        .filter((f) => f.startsWith(`${p}/`))
        .map((f) => f.slice(p.length + 1))
        .filter((n) => /^\[.+\]\.tsx$/.test(n)),
    findNestedRoute: (root, slug) =>
      [...files].find(
        (f) =>
          f.startsWith(`${root}/`) &&
          f.endsWith("/page.tsx") &&
          new RegExp(`/${slug}/\\[[^/]+\\]/page\\.tsx$`).test(f) &&
          !f.startsWith(`${root}/${slug}/`),
      ) ?? null,
  };
}

const OK_WIDGET = {
  key: "widget",
  slug: "widgets",
  web: "detail",
  desktop: "detail",
  mobile: "detail",
};
const OK_PATHS = [
  `${WEB_APP_DIR}/widgets/page.tsx`,
  `${WEB_APP_DIR}/widgets/[id]/page.tsx`,
  `${MOBILE_TABS_DIR}/widgets/index.tsx`,
  `${MOBILE_TABS_DIR}/widgets/[id].tsx`,
];

const GO_TWO_TYPES = `
	if err := r.collect(ctx, tx, &resp.Results, limit, "campaign", \`
SELECT id FROM campaigns\`); err != nil { return err }
	if err := r.collect(ctx, tx, &resp.Results, limit, "form", \`
SELECT id FROM forms\`); err != nil { return err }
`;

const unionSrc = (types) =>
  `export const SEARCH_HIT_TYPES = [\n${types
    .map((t) => `  "${t}",`)
    .join("\n")}\n] as const;\n`;

function selfTest() {
  const cases = [
    {
      name: "a fully-backed entity passes",
      fs: fakeFs({ entries: [OK_WIDGET], paths: OK_PATHS }),
      expect: (e) => e.length === 0,
    },
    {
      // The union check must be able to FAIL, in both directions. A guard that
      // only ever passes is indistinguishable from no guard.
      name: "search union matching the server passes",
      fs: fakeFs({
        entries: [OK_WIDGET],
        paths: OK_PATHS,
        searchGo: GO_TWO_TYPES,
        searchUnion: unionSrc(["campaign", "form"]),
      }),
      expect: (e) => e.length === 0,
    },
    {
      name: "a server search type missing from the union is caught",
      fs: fakeFs({
        entries: [OK_WIDGET],
        paths: OK_PATHS,
        searchGo: GO_TWO_TYPES,
        searchUnion: unionSrc(["campaign"]),
      }),
      expect: (e) => e.some((m) => m.includes('search type "form" is indexed')),
    },
    {
      name: "a union type the server never emits is caught (the dead `tag` branch)",
      fs: fakeFs({
        entries: [OK_WIDGET],
        paths: OK_PATHS,
        searchGo: GO_TWO_TYPES,
        searchUnion: unionSrc(["campaign", "form", "tag"]),
      }),
      expect: (e) => e.some((m) => m.includes('declares "tag"')),
    },
    {
      name: "a Go source the regex cannot parse is caught, not silently passed",
      fs: fakeFs({
        entries: [OK_WIDGET],
        paths: OK_PATHS,
        searchGo: "// the collect() shape changed\n",
        searchUnion: unionSrc(["campaign"]),
      }),
      expect: (e) => e.some((m) => m.includes("parsed zero search types")),
    },
    {
      name: 'web "detail" without a dynamic segment is caught (the approvals 404)',
      fs: fakeFs({
        entries: [OK_WIDGET],
        paths: OK_PATHS.filter((p) => !p.includes("[id]/page.tsx")),
      }),
      expect: (e) => e.some((x) => x.includes("404")),
    },
    {
      name: 'mobile "list" while an [id].tsx exists is caught (the stale-flag bug)',
      fs: fakeFs({
        entries: [{ ...OK_WIDGET, mobile: "list" }],
        paths: OK_PATHS,
      }),
      expect: (e) => e.some((x) => x.includes('promote it to "detail"')),
    },
    {
      name: 'mobile "detail" without an [id].tsx is caught',
      fs: fakeFs({
        entries: [OK_WIDGET],
        paths: OK_PATHS.filter((p) => !p.endsWith("(tabs)/widgets/[id].tsx")),
      }),
      expect: (e) => e.some((x) => x.includes("expo-router cannot resolve")),
    },
    {
      name: 'web "none" while web ships the route is caught',
      fs: fakeFs({ entries: [{ ...OK_WIDGET, web: "none" }], paths: OK_PATHS }),
      expect: (e) => e.some((x) => x.includes("being denied a link")),
    },
    {
      name: "desktop support for a slug outside SECTION_SLUGS is caught",
      fs: fakeFs({
        entries: [{ ...OK_WIDGET, slug: "sprockets" }],
        paths: [
          `${WEB_APP_DIR}/sprockets/page.tsx`,
          `${WEB_APP_DIR}/sprockets/[id]/page.tsx`,
          `${MOBILE_TABS_DIR}/sprockets/index.tsx`,
          `${MOBILE_TABS_DIR}/sprockets/[id].tsx`,
        ],
        rust: `const ENTITY_COLLECTIONS: &[(&str, &str)] = &[\n    ("widget", "sprockets"),\n];`,
      }),
      expect: (e) => e.some((x) => x.includes("unknown-destination")),
    },
    {
      name: 'desktop "none" for a slug desktop DOES have is caught',
      fs: fakeFs({
        entries: [{ ...OK_WIDGET, desktop: "none" }],
        paths: OK_PATHS,
        rust: `const ENTITY_COLLECTIONS: &[(&str, &str)] = &[\n];`,
      }),
      expect: (e) => e.some((x) => x.includes("IS a desktop section")),
    },
    {
      name: "a desktop-routable entity missing from the Rust table is caught",
      fs: fakeFs({
        entries: [OK_WIDGET],
        paths: OK_PATHS,
        rust: `const ENTITY_COLLECTIONS: &[(&str, &str)] = &[\n];`,
      }),
      expect: (e) =>
        e.some((x) => x.includes("unknown\n") || x.includes("unknown ")),
    },
    {
      name: "a Rust slug that disagrees with the registry is caught",
      fs: fakeFs({
        entries: [OK_WIDGET],
        paths: OK_PATHS,
        rust: `const ENTITY_COLLECTIONS: &[(&str, &str)] = &[\n    ("widget", "gadgets"),\n];`,
      }),
      expect: (e) => e.some((x) => x.includes("slug mismatch")),
    },
    {
      name: "a Rust action the registry does not route is caught",
      fs: fakeFs({
        entries: [OK_WIDGET],
        paths: OK_PATHS,
        rust: `const ENTITY_COLLECTIONS: &[(&str, &str)] = &[\n    ("widget", "widgets"),\n    ("ghost", "ghosts"),\n];`,
      }),
      expect: (e) => e.some((x) => x.includes('routes "ghost"')),
    },
    {
      name: "a camelCase key (rejected by the Rust action grammar) is caught",
      fs: fakeFs({
        entries: [{ ...OK_WIDGET, key: "widgetThing" }],
        paths: OK_PATHS,
        rust: `const ENTITY_COLLECTIONS: &[(&str, &str)] = &[\n    ("widgetThing", "widgets"),\n];`,
      }),
      expect: (e) => e.some((x) => x.includes("camelCase key")),
    },
    {
      name: "two entities sharing a slug are caught",
      fs: fakeFs({
        entries: [OK_WIDGET, { ...OK_WIDGET, key: "gizmo" }],
        paths: OK_PATHS,
        rust: `const ENTITY_COLLECTIONS: &[(&str, &str)] = &[\n    ("widget", "widgets"),\n    ("gizmo", "widgets"),\n];`,
      }),
      expect: (e) => e.some((x) => x.includes("unreachable when parsing")),
    },
    {
      name: "an unparseable registry fails loudly rather than passing empty",
      fs: fakeFs({ entries: [], paths: [] }),
      expect: (e) => e.some((x) => x.includes("parsed zero entities")),
    },
    {
      name: "an entity the matcher silently DROPPED is caught",
      // A comment between `key` and `slug` breaks the contiguous match. The
      // entity would vanish from the checked set with no error — every claim
      // for it unverified while the script reports success.
      fs: fakeFs({
        entries: [OK_WIDGET],
        paths: OK_PATHS,
        rawRegistry: `export const ENTITIES = {
  widget: {
    key: "widget",
    // an innocuous note
    slug: "widgets",
    surfaces: { web: "detail", desktop: "detail", mobile: "detail" },
  },
} as const;
export const WEB_NESTED_ROUTE_ACK: readonly string[] = [];`,
      }),
      expect: (e) => e.some((x) => x.includes("did not parse")),
    },
    {
      name: 'a NESTED web route hiding behind web:"none" is caught',
      fs: fakeFs({
        entries: [{ ...OK_WIDGET, web: "none" }],
        paths: [
          `${MOBILE_TABS_DIR}/widgets/index.tsx`,
          `${MOBILE_TABS_DIR}/widgets/[id].tsx`,
          // e.g. app/subscribers/segments/[id]/page.tsx
          `${WEB_APP_DIR}/gadgets/widgets/[id]/page.tsx`,
        ],
      }),
      expect: (e) => e.some((x) => x.includes("WEB_NESTED_ROUTE_ACK")),
    },
    {
      name: "an acknowledged nested web route passes",
      fs: fakeFs({
        entries: [{ ...OK_WIDGET, web: "none" }],
        ack: ["widget"],
        paths: [
          `${MOBILE_TABS_DIR}/widgets/index.tsx`,
          `${MOBILE_TABS_DIR}/widgets/[id].tsx`,
          `${WEB_APP_DIR}/gadgets/widgets/[id]/page.tsx`,
        ],
      }),
      expect: (e) => e.length === 0,
    },
    {
      name: "a STALE nested acknowledgement is caught",
      // The nested route moved or was deleted; the excuse for emitting no web
      // link must go with it, or the entity stays needlessly unlinked.
      fs: fakeFs({
        entries: [{ ...OK_WIDGET, web: "none" }],
        ack: ["widget"],
        paths: [
          `${MOBILE_TABS_DIR}/widgets/index.tsx`,
          `${MOBILE_TABS_DIR}/widgets/[id].tsx`,
        ],
      }),
      expect: (e) => e.some((x) => x.includes("no nested")),
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const errs = runChecks(c.fs);
    if (c.expect(errs)) {
      console.log(`  ✓ ${c.name}`);
    } else {
      failed += 1;
      console.error(
        `  ✗ ${c.name}\n      got: ${JSON.stringify(errs, null, 2)}`,
      );
    }
  }
  if (failed > 0) {
    console.error(
      `\n✗ route-map destination self-test: ${failed} case(s) failed.`,
    );
    process.exit(1);
  }
  console.log(
    `\n✓ route-map destination self-test: ${cases.length}/${cases.length} cases pass.`,
  );
}

// --- entry point ----------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (!invokedDirectly) {
  // Importer: expose the pure helpers only.
} else if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const errors = runChecks(realFs());
  if (errors.length > 0) {
    console.error("✗ route-map destination check FAILED:\n");
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      `\nEvery surface claim in ${ENTITIES_SRC} must match a real screen. A\n` +
        `wrong claim is a 404 or a dead deep link for a user who was told to\n` +
        `go there — not a lint nit.`,
    );
    process.exit(1);
  }
  const { entities } = parseEntities(
    readFileSync(join(repoRoot, ENTITIES_SRC), "utf8"),
  );
  console.log(
    `✓ route-map destinations: ${entities.length} entities × 3 surfaces verified ` +
      `against the real tree, plus the Rust deep-link table.`,
  );
}
