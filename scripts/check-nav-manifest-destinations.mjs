#!/usr/bin/env node
//
// scripts/check-nav-manifest-destinations.mjs
//
// Proves that every route @postwave/nav claims exists, and reports the screens
// that exist but no nav entry reaches.
//
// The manifest is the canonical information architecture: one label, one icon
// concept, one required scope per destination, consumed by every client's
// primary navigation and by the command palette and search. Two failure modes
// matter, and only one of them is loud:
//
//   1. A route in the manifest that no longer exists — a nav item that goes
//      nowhere. Nobody notices until a user clicks it.
//   2. A shipped screen NO nav entry reaches — an orphan. Reachable only by
//      typing the URL, invisible to search and the palette. The 2026-06-21
//      ecosystem audit found several (Analytics was shipped on web and absent
//      from web's own sidebar) and nothing has stopped more appearing since.
//
// This checks (1) as an error and reports (2) against a declared allow-list, so
// an orphan is a decision someone wrote down rather than something nobody knew.
//
// Run `--self-test` to exercise the checker against synthetic trees.
//
// Exit non-zero on any breach.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const MANIFEST = "packages/nav/src/manifest.ts";
const WEB_APP_DIR = "apps/web/src/app/(dashboard)/app";
const MOBILE_TABS_DIR = "apps/mobile/app/(tabs)";
const WEB_ROUTE_REGISTRY = "apps/web/src/lib/dashboard-routes.ts";
const DESKTOP_ROUTER = "apps/desktop/src/lib/desktop-router.ts";

/**
 * Mobile's own secondary-route tables, which drive the More sheet.
 *
 * Mobile deliberately does not put 60 screens in a 5-slot tab bar: the shared
 * nav manifest models PRIMARY navigation, and everything else is reached from
 * More. A screen listed there is navigable, so counting it as an orphan would
 * report 50-odd false positives and make the real ones invisible.
 */
const MOBILE_ROUTE_TABLES = [
  "apps/mobile/src/lib/mobileRoutesCore.ts",
  "apps/mobile/src/lib/mobileRoutesAdmin.ts",
  "apps/mobile/src/lib/mobileRoutesTools.ts",
];

/** `routes: { web: "/app/x" | null, … }` per surface. */
const SURFACES = ["web", "desktop", "mobile"];

export function parseNavEntries(src) {
  const entries = [];
  const errors = [];
  // Count declared keys independently so a matcher miss fails closed rather
  // than silently shrinking the checked set.
  const declaredKeys = [...src.matchAll(/^\s{4}key:\s*"([^"]+)"/gm)].map(
    (m) => m[1],
  );

  const re =
    /key:\s*"([^"]+)"[\s\S]*?routes:\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const [, key, routesBody] = m;
    const routes = {};
    for (const surface of SURFACES) {
      const sm = new RegExp(`${surface}\\s*:\\s*(null|"([^"]*)")`).exec(routesBody);
      if (!sm) {
        errors.push(`${key}: routes.${surface} is missing`);
        continue;
      }
      routes[surface] = sm[1] === "null" ? null : sm[2];
    }
    entries.push({ key, routes });
  }

  const parsed = new Set(entries.map((e) => e.key));
  const dropped = declaredKeys.filter((k) => !parsed.has(k));
  if (dropped.length > 0) {
    errors.push(
      `${MANIFEST}: ${dropped.length} entr${dropped.length === 1 ? "y" : "ies"} ` +
        `(${dropped.join(", ")}) declare a \`key\` but did not parse — every ` +
        `check for them would have been skipped.`,
    );
  }
  return { entries, errors };
}

/** Values of desktop-router.ts SECTION_SLUGS. */
export function parseDesktopSlugs(src) {
  const start = src.indexOf("const SECTION_SLUGS");
  if (start === -1) return null;
  const open = src.indexOf("{", start);
  const close = src.indexOf("};", open);
  if (open === -1 || close === -1) return null;
  return new Set(
    [...src.slice(open, close).matchAll(/:\s*"([^"]+)"/g)].map((m) => m[1]),
  );
}

/** Entries the manifest deliberately omits, parsed from its own declaration. */
export function parseOrphanAck(src) {
  const block = /NAV_ORPHAN_ACK[^=]*=\s*\{([\s\S]*?)\n\}/.exec(
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""),
  );
  if (!block) return new Map();
  return new Map(
    [...block[1].matchAll(/"([^"]+)"\s*:\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]),
  );
}

export function runChecks(fs) {
  const errors = [];
  const manifestSrc = fs.read(MANIFEST);
  if (!manifestSrc) return [`cannot read ${MANIFEST}`];

  const { entries, errors: parseErrors } = parseNavEntries(manifestSrc);
  errors.push(...parseErrors);
  if (entries.length === 0) {
    return [...errors, `${MANIFEST}: parsed zero entries — format drift?`];
  }

  const desktopSrc = fs.read(DESKTOP_ROUTER);
  const desktopSlugs = desktopSrc ? parseDesktopSlugs(desktopSrc) : null;
  if (!desktopSlugs || desktopSlugs.size === 0) {
    errors.push(`${DESKTOP_ROUTER}: could not parse SECTION_SLUGS.`);
  }

  const seenKeys = new Set();
  const claimed = { web: new Set(), desktop: new Set(), mobile: new Set() };

  for (const { key, routes } of entries) {
    if (seenKeys.has(key)) errors.push(`${key}: duplicate nav key`);
    seenKeys.add(key);

    // --- web: /app/<slug> must be a real route directory -------------------
    if (routes.web) {
      const slug = routes.web.replace(/^\/app\/?/, "");
      claimed.web.add(slug);
      if (slug !== "" && !fs.dirExists(`${WEB_APP_DIR}/${slug}`)) {
        errors.push(
          `${key}: routes.web = "${routes.web}" but ${WEB_APP_DIR}/${slug} ` +
            `does not exist — the nav item goes nowhere.`,
        );
      }
    }

    // --- desktop: the slug must be a known section -------------------------
    if (routes.desktop && desktopSlugs) {
      const slug = routes.desktop.replace(/^\/app\/?/, "");
      claimed.desktop.add(slug);
      if (slug !== "" && !desktopSlugs.has(slug)) {
        errors.push(
          `${key}: routes.desktop = "${routes.desktop}" but "${slug}" is not in ` +
            `desktop's SECTION_SLUGS — it fails to parse as unknown-destination.`,
        );
      }
    }

    // --- mobile: the (tabs) screen must exist ------------------------------
    if (routes.mobile) {
      const screen = routes.mobile.replace(/^\/\(tabs\)\/?/, "");
      claimed.mobile.add(screen);
      const exists =
        fs.fileExists(`${MOBILE_TABS_DIR}/${screen}.tsx`) ||
        fs.fileExists(`${MOBILE_TABS_DIR}/${screen}/index.tsx`);
      if (screen !== "" && !exists) {
        errors.push(
          `${key}: routes.mobile = "${routes.mobile}" but neither ` +
            `${MOBILE_TABS_DIR}/${screen}.tsx nor ${screen}/index.tsx exists.`,
        );
      }
    }
  }

  // --- orphans: shipped screens NOTHING reaches ----------------------------
  // "Reached" means the shared nav manifest OR mobile's own More sheet. Only a
  // screen no affordance points at is an orphan.
  for (const table of MOBILE_ROUTE_TABLES) {
    const src = fs.read(table);
    if (!src) {
      // Swallowing this produced 53 false orphans when a table was renamed —
      // an avalanche of wrong findings instead of one true one.
      errors.push(
        `mobile route table ${table} could not be read. Every screen it lists ` +
          `would be reported as an orphan, so this is failed loudly instead.`,
      );
      continue;
    }
    for (const m of src.matchAll(/route:\s*"\/\(tabs\)\/([a-z0-9-]+)"/g)) {
      claimed.mobile.add(m[1]);
    }
  }

  // Web's OWN nav registry, read the way mobile's route tables already were.
  // Without this the guard could only see the filesystem, so every page not in
  // NAV_ENTRIES looked unreachable — and the fix was to write an excuse. Three
  // of the five excuses turned out to be false: two of those pages are sidebar
  // items and one is in the palette. A reachability check that has to be told
  // what is reachable is not a reachability check.
  const dashboardSrc = fs.read(WEB_ROUTE_REGISTRY) ?? "";
  for (const m of dashboardSrc.matchAll(/href:\s*"\/app\/([a-z0-9-]+)"/g)) {
    claimed.web.add(m[1]);
  }
  if (dashboardSrc === "") {
    errors.push(
      `${WEB_ROUTE_REGISTRY} could not be read, so every web page would look ` +
        `unreachable. Refusing to report orphans against a missing registry.`,
    );
  }

  const ack = parseOrphanAck(manifestSrc);
  const orphans = [];
  for (const slug of fs.webRoutes()) {
    if (!claimed.web.has(slug) && !ack.has(`web:${slug}`)) {
      orphans.push(`web:${slug}`);
    }
  }
  for (const screen of fs.mobileScreens()) {
    if (!claimed.mobile.has(screen) && !ack.has(`mobile:${screen}`)) {
      orphans.push(`mobile:${screen}`);
    }
  }
  if (orphans.length > 0) {
    errors.push(
      `${orphans.length} shipped screen(s) are reachable only by typing the ` +
        `URL — no nav entry, no command palette, no search:\n` +
        orphans.map((o) => `        ${o}`).join("\n") +
        `\n    Add a NAV_ENTRIES route, or record the reason in ` +
        `NAV_ORPHAN_ACK in ${MANIFEST}.`,
    );
  }
  // A stale acknowledgement is its own defect: it excuses a screen that is
  // either gone or now reachable, and hides the next real orphan behind it.
  for (const [entry] of ack) {
    const [surface, name] = entry.split(":");
    const live =
      surface === "web"
        ? fs.webRoutes().includes(name) && !claimed.web.has(name)
        : fs.mobileScreens().includes(name) && !claimed.mobile.has(name);
    if (!live) {
      errors.push(
        `NAV_ORPHAN_ACK lists "${entry}", which is no longer an orphan (it was ` +
          `removed, or a nav entry now reaches it). Delete the entry.`,
      );
    }
  }

  errors.push(...routeMapDivergence(manifestSrc, fs));

  return errors;
}

const ROUTE_MAP = "packages/route-map/src/entities.ts";

/** Self-test sentinel: this fixture is not exercising the cross-check. */
const SKIP_ROUTE_MAP = Symbol("skip-route-map");

/**
 * Nav key → route-map entity key, where the two model the SAME concept.
 *
 * Only concepts both contracts name. `dashboard`, `settings`, `audit`, `sms`,
 * `inboxReality`, `billing`, `analytics` and `notifications` have no
 * corresponding route-map entity, so the two contracts never make a claim about
 * each other there — which is different from agreeing.
 *
 * `subscribers` was missing behind the excuse that it "has no separate nav
 * concept beyond the one already listed". It is a nav key and it was not
 * listed: the same false-acknowledgement shape this guard exists to catch.
 */
const NAV_TO_ENTITY = {
  subscribers: "subscriber",
  approvals: "approval",
  campaigns: "campaign",
  sequences: "sequence",
  forms: "form",
  templates: "template",
  migrations: "migration",
  integrations: "integration",
  affiliates: "affiliate",
  flows: "flow",
  discounts: "discount",
  landingPages: "landing-page",
  inboundWebhooks: "inbound-webhook",
  sequenceTemplates: "sequence-template",
};

/**
 * Cross-check the two shared nav contracts.
 *
 * They answer different questions — route-map: "can you deep-link to ONE
 * record of this entity on this surface?", the manifest: "where does this nav
 * CONCEPT land?" — so divergence is legitimate. It is checked anyway because
 * two shared contracts that quietly disagree are indistinguishable from one of
 * them being wrong, and both are gated by the same CI job. An acknowledged
 * divergence passes; an unacknowledged one is a decision nobody made.
 */
function routeMapDivergence(manifestSrc, fs) {
  const errors = [];
  const src = fs.read(ROUTE_MAP);
  if (src === SKIP_ROUTE_MAP) return errors; // fixture opts out explicitly
  if (src === null) {
    // The same fail-loud discipline applied to the web registry and mobile
    // route tables. Returning quietly here made the cross-check vacuous the
    // moment the file moved, and a vacuous check reads exactly like a passing
    // one.
    errors.push(
      `${ROUTE_MAP} could not be read, so the nav manifest cannot be ` +
        `cross-checked against it. Refusing to report agreement with a file ` +
        `that is not there.`,
    );
    return errors;
  }
  // Scoped to its OWN block. A bare scan for `"x:y":` across the file also
  // matched NAV_ORPHAN_ACK's `"mobile:more"`, so an orphan excuse could have
  // silenced a contract divergence for a nav key called `mobile`.
  // Anchored on `export const`. Matching the bare name found the mention in a
  // comment 80 lines earlier, and `[^=]*` then ran forward to the NEXT `=` in
  // the file — so this read NAV_ORPHAN_ACK's body and silently acknowledged
  // nothing while looking like it worked.
  const ackBlock =
    /export const NAV_ROUTE_MAP_DIVERGENCE_ACK[^=]*=\s*\{([\s\S]*?)\n\}/.exec(
      manifestSrc,
    )?.[1] ?? "";
  const ack = new Set(
    [...ackBlock.matchAll(/"([a-zA-Z]+:[a-z]+)":/g)].map((m) => m[1]),
  );
  const surfaces = new Map();
  for (const m of src.matchAll(
    /key:\s*"([a-z-]+)",[\s\S]{0,400}?surfaces:\s*\{([^}]*)\}/g,
  )) {
    const body = m[2];
    const read = (name) =>
      new RegExp(`${name}:\\s*"([a-z]+)"`).exec(body)?.[1] ?? null;
    surfaces.set(m[1], { desktop: read("desktop"), mobile: read("mobile") });
  }
  const entries = parseNavEntries(manifestSrc).entries;
  for (const entry of entries) {
    const entityKey = NAV_TO_ENTITY[entry.key];
    if (!entityKey) continue;
    const entity = surfaces.get(entityKey);
    if (!entity) {
      errors.push(
        `${MANIFEST}: nav key "${entry.key}" is mapped to route-map entity ` +
          `"${entityKey}", which no longer exists in ${ROUTE_MAP}.`,
      );
      continue;
    }
    for (const surface of ["desktop", "mobile"]) {
      // ONE direction: the manifest routing a concept to a surface that
      // route-map says the entity does not exist on.
      //
      // The reverse — route-map has a route, the manifest does not — is not a
      // disagreement. "Deep-linkable" and "nav destination" are different
      // claims, and mobile has five tab slots for thirty concepts, so most
      // entities are reachable without being navigable. Flagging that
      // direction produced seven findings that all said the same thing, which
      // is how a guard trains people to write acknowledgements without
      // reading them. The over-claim direction is the one where a contract
      // asserts something the other contract denies.
      if (entry.routes[surface] === null) continue;
      if (entity[surface] !== "none") continue;
      if (ack.has(`${entry.key}:${surface}`)) continue;
      errors.push(
        `${entry.key} on ${surface}: the nav manifest routes it to ` +
          `${entry.routes[surface]}, while ${ROUTE_MAP} says ` +
          `${entityKey}.surfaces.${surface} = "none". Both are shared ` +
          `contracts gated by the same job, and they cannot both be right. ` +
          `Reconcile them, or record the reason in ` +
          `NAV_ROUTE_MAP_DIVERGENCE_ACK.`,
      );
    }
  }
  return errors;
}

// --- real filesystem --------------------------------------------------------

function realFs() {
  const abs = (p) => resolve(repoRoot, p);
  const dirNames = (p) => {
    try {
      return readdirSync(abs(p), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !/^[[(_]/.test(d.name))
        .map((d) => d.name);
    } catch {
      return [];
    }
  };
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
    /** Top-level `/app/<slug>` route directories that have a page.tsx. */
    webRoutes: () =>
      dirNames(WEB_APP_DIR).filter((name) =>
        existsSync(abs(`${WEB_APP_DIR}/${name}/page.tsx`)),
      ),
    /** Top-level (tabs) screens: `<name>.tsx` or `<name>/index.tsx`. */
    mobileScreens: () => {
      try {
        const out = new Set();
        for (const d of readdirSync(abs(MOBILE_TABS_DIR), { withFileTypes: true })) {
          if (d.isFile() && d.name.endsWith(".tsx") && !d.name.startsWith("_")) {
            out.add(d.name.replace(/\.tsx$/, ""));
          } else if (
            d.isDirectory() &&
            !d.name.startsWith("_") &&
            existsSync(abs(`${MOBILE_TABS_DIR}/${d.name}/index.tsx`))
          ) {
            out.add(d.name);
          }
        }
        return [...out];
      } catch {
        return [];
      }
    },
  };
}

// --- self-test --------------------------------------------------------------

const BASE_DESKTOP = `
const SECTION_SLUGS: Record<RoutableDesktopSection, string> = {
  widgets: "widgets",
  gadgets: "gadgets",
};
`;

function manifestSrc(entries, ack = {}, divergenceAck = {}) {
  const body = entries
    .map(
      (e) => `  {
    key: "${e.key}",
    routes: { web: ${e.web === null ? "null" : `"${e.web}"`}, desktop: ${
      e.desktop === null ? "null" : `"${e.desktop}"`
    }, mobile: ${e.mobile === null ? "null" : `"${e.mobile}"`} },
  },`,
    )
    .join("\n");
  const ackBody = Object.entries(ack)
    .map(([k, v]) => `  "${k}": "${v}",`)
    .join("\n");
  const divBody = Object.entries(divergenceAck)
    .map(([k, v]) => `  "${k}": "${v}",`)
    .join("\n");
  return (
    `export const NAV_ENTRIES = [\n${body}\n];\n` +
    `export const NAV_ORPHAN_ACK: Record<string, string> = {\n${ackBody}\n}\n` +
    `export const NAV_ROUTE_MAP_DIVERGENCE_ACK: Record<string, string> = {\n${divBody}\n}\n`
  );
}

function fakeFs({
  entries,
  ack = {},
  web = [],
  mobile = [],
  desktop = BASE_DESKTOP,
  raw = null,
  // route-map entity surfaces, as `{entityKey: {desktop, mobile}}`. Absent
  // means "no route-map in this fixture", which skips the cross-check.
  routeMap = null,
  divergenceAck = {},
  // Web pages reachable from the sidebar or the palette WITHOUT a manifest
  // entry, and mobile's own route tables. Both are read from source in the
  // real run, so the fixtures have to supply them or every case would fail on
  // "registry could not be read" rather than the defect it is testing.
  webRegistry = [],
  mobileTables = {},
}) {
  const files = {
    [MANIFEST]: raw ?? manifestSrc(entries, ack, divergenceAck),
    [DESKTOP_ROUTER]: desktop,
    ...(routeMap === null
      ? { [ROUTE_MAP]: SKIP_ROUTE_MAP }
      : {
          [ROUTE_MAP]: Object.entries(routeMap)
            .map(
              ([k, v]) =>
                `  {\n    key: "${k}",\n    surfaces: { web: "list", desktop: "${v.desktop}", mobile: "${v.mobile}" },\n  },`,
            )
            .join("\n"),
        }),
    [WEB_ROUTE_REGISTRY]: webRegistry
      .map((h) => `    href: "/app/${h}",`)
      .join("\n") || "// no unmodelled web routes",
    ...Object.fromEntries(
      MOBILE_ROUTE_TABLES.map((t) => [
        t,
        (mobileTables[t] ?? [])
          .map((r) => `    route: "/(tabs)/${r}",`)
          .join("\n") || "// empty table",
      ]),
    ),
  };
  return {
    read: (p) => files[p] ?? null,
    dirExists: (p) => web.some((w) => p === `${WEB_APP_DIR}/${w}`),
    fileExists: (p) =>
      mobile.some(
        (m) => p === `${MOBILE_TABS_DIR}/${m}.tsx` || p === `${MOBILE_TABS_DIR}/${m}/index.tsx`,
      ),
    webRoutes: () => web,
    mobileScreens: () => mobile,
  };
}

function selfTest() {
  const OK = { key: "widgets", web: "/app/widgets", desktop: "/app/widgets", mobile: "/(tabs)/widgets" };
  const cases = [
    {
      name: "a fully-backed entry passes",
      fs: fakeFs({ entries: [OK], web: ["widgets"], mobile: ["widgets"] }),
      expect: (e) => e.length === 0,
    },
    {
      name: "a web route that does not exist is caught",
      fs: fakeFs({ entries: [OK], web: [], mobile: ["widgets"] }),
      expect: (e) => e.some((x) => x.includes("goes nowhere")),
    },
    {
      name: "a desktop slug outside SECTION_SLUGS is caught",
      fs: fakeFs({
        entries: [{ ...OK, desktop: "/app/sprockets" }],
        web: ["widgets"],
        mobile: ["widgets"],
      }),
      expect: (e) => e.some((x) => x.includes("unknown-destination")),
    },
    {
      name: "a missing mobile screen is caught",
      fs: fakeFs({ entries: [OK], web: ["widgets"], mobile: [] }),
      expect: (e) => e.some((x) => x.includes("index.tsx exists")),
    },
    {
      name: "an ORPHANED shipped screen is caught",
      fs: fakeFs({ entries: [OK], web: ["widgets", "gadgets"], mobile: ["widgets"] }),
      expect: (e) => e.some((x) => x.includes("web:gadgets")),
    },
    {
      // The defect that produced three false excuses: the guard could not see
      // web's own nav, so a sidebar item looked like an unreachable page.
      name: "a web page reached from the SIDEBAR is not an orphan",
      fs: fakeFs({
        entries: [OK],
        web: ["widgets", "pilot"],
        mobile: ["widgets"],
        webRegistry: ["pilot"],
      }),
      expect: (e) => e.length === 0,
    },
    {
      name: "a missing web route registry fails loudly, not as 50 orphans",
      fs: (() => {
        const base = fakeFs({ entries: [OK], web: ["widgets", "pilot"], mobile: ["widgets"] });
        return { ...base, read: (p) => (p === WEB_ROUTE_REGISTRY ? null : base.read(p)) };
      })(),
      expect: (e) => e.some((x) => x.includes("Refusing to report orphans")),
    },
    {
      name: "a manifest route to a surface route-map calls \"none\" is caught",
      fs: fakeFs({
        entries: [{ key: "flows", web: "/app/flows", desktop: "/app/flows", mobile: null }],
        web: ["flows"],
        desktop: `const SECTION_SLUGS = {\n  flows: "flows",\n};`,
        routeMap: { flow: { desktop: "none", mobile: "none" } },
      }),
      expect: (e) => e.some((x) => x.includes("cannot both be right")),
    },
    {
      name: "…and passes once the divergence is declared",
      fs: fakeFs({
        entries: [{ key: "flows", web: "/app/flows", desktop: "/app/flows", mobile: null }],
        web: ["flows"],
        desktop: `const SECTION_SLUGS = {\n  flows: "flows",\n};`,
        routeMap: { flow: { desktop: "none", mobile: "none" } },
        divergenceAck: { "flows:desktop": "different questions" },
      }),
      expect: (e) => e.length === 0,
    },
    {
      name: "an acknowledged orphan passes",
      fs: fakeFs({
        entries: [OK],
        ack: { "web:gadgets": "internal pilot surface, reached from Settings" },
        web: ["widgets", "gadgets"],
        mobile: ["widgets"],
      }),
      expect: (e) => e.length === 0,
    },
    {
      name: "a STALE orphan acknowledgement is caught",
      fs: fakeFs({
        entries: [OK],
        ack: { "web:gone": "was a pilot" },
        web: ["widgets"],
        mobile: ["widgets"],
      }),
      expect: (e) => e.some((x) => x.includes("no longer an orphan")),
    },
    {
      name: "an entry the matcher silently DROPPED is caught",
      fs: fakeFs({
        entries: [OK],
        web: ["widgets"],
        mobile: ["widgets"],
        raw: `export const NAV_ENTRIES = [
  {
    key: "widgets",
  },
];
export const NAV_ORPHAN_ACK: Record<string, string> = {
}
`,
      }),
      expect: (e) => e.some((x) => x.includes("did not parse") || x.includes("zero entries")),
    },
    {
      name: "a duplicate nav key is caught",
      fs: fakeFs({ entries: [OK, OK], web: ["widgets"], mobile: ["widgets"] }),
      expect: (e) => e.some((x) => x.includes("duplicate nav key")),
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const errs = runChecks(c.fs);
    if (c.expect(errs)) console.log(`  ✓ ${c.name}`);
    else {
      failed += 1;
      console.error(`  ✗ ${c.name}\n      got: ${JSON.stringify(errs, null, 2)}`);
    }
  }
  if (failed > 0) {
    console.error(`\n✗ nav destination self-test: ${failed} case(s) failed.`);
    process.exit(1);
  }
  console.log(`\n✓ nav destination self-test: ${cases.length}/${cases.length} cases pass.`);
}

// --- entry point ------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (!invokedDirectly) {
  // Importer: pure helpers only.
} else if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const fs = realFs();
  const errors = runChecks(fs);
  if (errors.length > 0) {
    console.error("✗ nav manifest destination check FAILED:\n");
    for (const e of errors) console.error(`  - ${e}`);
    console.error(
      `\nThe manifest is the canonical IA: a route it claims must exist, and a\n` +
        `screen nothing reaches is invisible to nav, search and the palette.`,
    );
    process.exit(1);
  }
  const { entries } = parseNavEntries(readFileSync(resolve(repoRoot, MANIFEST), "utf8"));
  // Say what was actually scanned. "No unreachable screens" read as a claim
  // about the whole product, while the scan covers TOP-LEVEL web routes and
  // mobile tab screens only — desktop is checked for broken destinations but
  // never for orphans, and nested routes (/app/subscribers/duplicates and the
  // like) are outside it entirely. A guard that overstates its own coverage is
  // how the next gap gets filed under "already checked".
  console.log(
    `✓ nav manifest: ${entries.length} entries verified against the real tree.\n` +
      `  Orphan scan covers top-level web routes + mobile tab screens; nested ` +
      `routes and desktop-only screens are out of scope.`,
  );
}
