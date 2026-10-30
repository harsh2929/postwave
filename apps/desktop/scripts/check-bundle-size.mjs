#!/usr/bin/env node
// Bundle-size guard for apps/desktop.
//
// Verifies the lazy-load invariant for `@sentry/react`: the critical-path
// entry chunk referenced from `dist/index.html` MUST NOT contain
// `@sentry/react`. Sentry is intended to land in a separate lazy chunk
// that the browser fetches only when `VITE_SENTRY_DSN_DESKTOP` is set
// AND the dynamic import in `lib/sentry.ts::initSentry` fires.
//
// Why this matters
// ----------------
// The original wiring did `import * as Sentry from "@sentry/react"` at
// the top of `lib/sentry.ts`, which pulled the full SDK into the entry
// chunk and added ~77KB minified (~26KB gzipped) to the synchronous
// bootstrap before first paint. Reducing critical-path JS is the single
// largest cold-start win on the desktop shell — the Tauri webview can't
// stream-parse until the entry script lands.
//
// What this script checks
// -----------------------
//   1. `dist/index.html` exists and references exactly one entry chunk.
//   2. That entry chunk + its modulepreload set do NOT contain the
//      `@sentry/react` literal string or any `__SENTRY__` global init.
//   3. There IS a separate lazy chunk that contains the Sentry runtime,
//      so the dynamic import resolves at runtime when DSN is set.
//   4. The entry, total critical-path JS, initial CSS, largest lazy chunk,
//      lazy Sentry chunk, and total JS stay under explicit raw-byte budgets.
//   5. Optional: when `BUNDLE_SIZE_BASELINE` env is set, the entry
//      chunk size hasn't regressed beyond a slack budget (default
//      +5% over baseline).
//
// Used in CI by `.github/workflows/desktop-ci.yml` after the Vite build
// step. Local invocation:
//
//   pnpm --filter postwave-desktop-shell run check:bundle-size
//
// Exit codes:
//   0 — all assertions pass
//   1 — invariant violation; logs the failing assertion to stderr

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import {
  buildChunkGraph,
  collectStaticImportClosure,
  findChunksOwningModule,
  findIneffectiveDynamicImports,
} from "./bundle-graph.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = process.env.BUNDLE_DIST_DIR
  ? resolve(process.env.BUNDLE_DIST_DIR)
  : resolve(SCRIPT_DIR, "..", "dist");
const ASSETS_DIR = join(DIST_DIR, "assets");
const INDEX_HTML = join(DIST_DIR, "index.html");
const BUNDLE_METADATA = join(DIST_DIR, "postwave-bundle-metadata.json");

// Slack budget over baseline. The entry chunk grows organically as the
// app gains features; we only fail CI if it grows >5% in a single PR.
const ENTRY_SIZE_SLACK_PCT = 5;

const MAX_ENTRY_BYTES = intFromEnv("BUNDLE_MAX_ENTRY_BYTES", 400_000);
const MAX_CRITICAL_JS_BYTES = intFromEnv("BUNDLE_MAX_CRITICAL_JS_BYTES", 670_000);
const MAX_INITIAL_CSS_BYTES = intFromEnv("BUNDLE_MAX_INITIAL_CSS_BYTES", 150_000);
const MAX_LAZY_JS_CHUNK_BYTES = intFromEnv("BUNDLE_MAX_LAZY_JS_CHUNK_BYTES", 220_000);
const MAX_SENTRY_LAZY_BYTES = intFromEnv("BUNDLE_MAX_SENTRY_LAZY_BYTES", 460_000);
const MAX_TOTAL_JS_BYTES = intFromEnv("BUNDLE_MAX_TOTAL_JS_BYTES", 5_000_000);
const MAX_ENTRY_GZIP_BYTES = intFromEnv("BUNDLE_MAX_ENTRY_GZIP_BYTES", 120_000);
const MAX_CRITICAL_JS_GZIP_BYTES = intFromEnv(
  "BUNDLE_MAX_CRITICAL_JS_GZIP_BYTES",
  190_000,
);
const MAX_INITIAL_CSS_GZIP_BYTES = intFromEnv(
  "BUNDLE_MAX_INITIAL_CSS_GZIP_BYTES",
  25_000,
);
const MAX_LAZY_JS_CHUNK_GZIP_BYTES = intFromEnv(
  "BUNDLE_MAX_LAZY_JS_CHUNK_GZIP_BYTES",
  70_000,
);
const MAX_SENTRY_LAZY_GZIP_BYTES = intFromEnv(
  "BUNDLE_MAX_SENTRY_LAZY_GZIP_BYTES",
  150_000,
);
const MAX_TOTAL_JS_GZIP_BYTES = intFromEnv(
  "BUNDLE_MAX_TOTAL_JS_GZIP_BYTES",
  1_400_000,
);
const MAX_CRITICAL_JS_CHUNKS = intFromEnv("BUNDLE_MAX_CRITICAL_JS_CHUNKS", 8);
const MAX_INITIAL_CSS_CHUNKS = intFromEnv("BUNDLE_MAX_INITIAL_CSS_CHUNKS", 2);

// Route-specific budgets make route splitting reviewable. A single generic
// "largest lazy chunk" limit allowed Subscribers to reach 347KB while still
// passing; these named limits bind the list/dashboard surfaces operators hit
// most often. Interaction-only detail chunks remain covered by the generic
// lazy-chunk budget above.
const ROUTE_CHUNK_BUDGETS = [
  routeBudget("Dashboard", 80_000, 26_000, 11),
  routeBudget("Subscribers", 220_000, 65_000, 15),
  routeBudget("Campaigns", 155_000, 48_000, 16),
  routeBudget("Analytics", 220_000, 65_000, 14),
  routeBudget("Settings", 225_000, 60_000, 9),
];

// Minimum savings expected from the lazy-load. If the entry chunk is
// SMALLER than this when compared to a baseline that includes Sentry,
// we know the lazy split worked. Used only when the baseline file is
// present (CI compares before / after).
const MIN_LAZY_SAVINGS_BYTES = 50_000; // ~50KB raw — well below the
// measured ~77KB savings, allows for legitimate fluctuation.

function fail(msg) {
  // eslint-disable-next-line no-console
  console.error(`[check-bundle-size] FAIL: ${msg}`);
  process.exit(1);
}

function info(msg) {
  // eslint-disable-next-line no-console
  console.log(`[check-bundle-size] ${msg}`);
}

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    fail(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

function routeBudget(name, rawFallback, gzipFallback, requestsFallback) {
  const envKey = name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  return {
    name,
    raw: intFromEnv(`BUNDLE_MAX_ROUTE_${envKey}_BYTES`, rawFallback),
    gzip: intFromEnv(
      `BUNDLE_MAX_ROUTE_${envKey}_GZIP_BYTES`,
      gzipFallback,
    ),
    requests: intFromEnv(
      `BUNDLE_MAX_ROUTE_${envKey}_REQUESTS`,
      requestsFallback,
    ),
  };
}

function readEntryRefs() {
  let html;
  try {
    html = readFileSync(INDEX_HTML, "utf8");
  } catch (err) {
    fail(`could not read ${INDEX_HTML}: ${err.message}`);
  }
  // Match the <script type="module" src="/assets/index-XXXX.js"> tag.
  const entryMatch = html.match(
    /<script[^>]+type="module"[^>]+src="\/assets\/([^"]+\.js)"/,
  );
  if (!entryMatch) {
    fail("dist/index.html has no <script type=module src=/assets/*.js> tag");
  }
  // Collect modulepreload refs — those load on first paint too, so
  // they're part of the critical path budget.
  const preloads = Array.from(
    html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="\/assets\/([^"]+\.js)"/g),
  ).map((m) => m[1]);
  const stylesheets = Array.from(
    html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/assets\/([^"]+\.css)"/g),
  ).map((m) => m[1]);
  return { entry: entryMatch[1], preloads, stylesheets };
}

function fileSize(name) {
  return statSync(join(ASSETS_DIR, name)).size;
}

function gzipSize(name) {
  return gzipSync(readFileSync(join(ASSETS_DIR, name)), { level: 9 }).length;
}

function fileContains(name, needle) {
  const content = readFileSync(join(ASSETS_DIR, name), "utf8");
  return content.includes(needle);
}

function listJsAssets() {
  return readdirSync(ASSETS_DIR).filter((f) => f.endsWith(".js"));
}

function readBundleMetadata(allJs) {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(BUNDLE_METADATA, "utf8"));
  } catch (error) {
    fail(`could not read emitted bundle metadata: ${error.message}`);
  }
  if (metadata?.schemaVersion !== 1 || typeof metadata.chunks !== "object") {
    fail("emitted bundle metadata has an unsupported schema");
  }
  for (const chunk of allJs) {
    const record = metadata.chunks[chunk];
    if (
      !record ||
      !Array.isArray(record.imports) ||
      !Array.isArray(record.dynamicImports) ||
      !Array.isArray(record.css) ||
      typeof record.modules !== "object"
    ) {
      fail(`emitted bundle metadata is missing chunk ${chunk}`);
    }
  }
  return metadata;
}

function bytesLabel(bytes) {
  return `${bytes} bytes (${(bytes / 1024).toFixed(1)} KB)`;
}

function assertUnderBudget(label, actual, maxAllowed) {
  if (actual > maxAllowed) {
    fail(`${label} is ${bytesLabel(actual)}, above budget ${bytesLabel(maxAllowed)}`);
  }
  info(`OK: ${label} ${bytesLabel(actual)} <= ${bytesLabel(maxAllowed)}`);
}

function assertAtMost(label, actual, maxAllowed) {
  if (actual > maxAllowed) {
    fail(`${label} is ${actual}, above budget ${maxAllowed}`);
  }
  info(`OK: ${label} ${actual} <= ${maxAllowed}`);
}

function main() {
  const { entry, preloads, stylesheets } = readEntryRefs();
  const criticalChunks = [entry, ...preloads];
  info(`entry chunk: ${entry}`);
  info(`modulepreload chunks: ${preloads.join(", ") || "(none)"}`);
  info(`initial CSS chunks: ${stylesheets.join(", ") || "(none)"}`);
  assertAtMost(
    "critical JS request count",
    criticalChunks.length,
    MAX_CRITICAL_JS_CHUNKS,
  );
  assertAtMost(
    "initial CSS request count",
    stylesheets.length,
    MAX_INITIAL_CSS_CHUNKS,
  );

  // (1) Critical-path chunks must NOT contain @sentry/react.
  //
  // We probe for two markers:
  //   - the npm package name (`@sentry/react`) as a string literal.
  //     Vite preserves bare package names in error / debug messages,
  //     so the literal survives minification.
  //   - the `__SENTRY__` global ID used by the Sentry SDK for its
  //     cross-version registry. This is present in EVERY Sentry build
  //     regardless of which `@sentry/*` package emitted the chunk, so
  //     it's a more robust detector if @sentry/react ever stops
  //     emitting its own name into the bundle.
  const SENTRY_PROBES = ["@sentry/react", "__SENTRY__"];
  for (const chunk of criticalChunks) {
    for (const probe of SENTRY_PROBES) {
      if (fileContains(chunk, probe)) {
        fail(
          `critical-path chunk ${chunk} contains "${probe}" — ` +
            `@sentry/react leaked into the cold-start bundle. Check ` +
            `that lib/sentry.ts only references @sentry/react via ` +
            `dynamic import() inside initSentry().`,
        );
      }
    }
  }
  info(`OK: no @sentry/react in critical-path chunks (${criticalChunks.length} probed)`);

  // (2) There MUST be a separate chunk that contains the Sentry
  //     runtime, otherwise the dynamic import will 404 when DSN is
  //     set at build time. We use `__SENTRY__` as the lookup token
  //     because the chunk name is content-hashed and unpredictable.
  const allJs = listJsAssets();
  const bundleMetadata = readBundleMetadata(allJs);
  const chunkGraph = buildChunkGraph(allJs, (chunk) =>
    readFileSync(join(ASSETS_DIR, chunk), "utf8"),
  );
  const ineffectiveImports = findIneffectiveDynamicImports(chunkGraph);
  if (ineffectiveImports.length > 0) {
    fail(
      "emitted chunks contain dynamic imports already reachable through " +
        `static imports: ${ineffectiveImports
          .map(({ chunk, target }) => `${chunk} -> ${target}`)
          .join(", ")}`,
    );
  }
  info("OK: emitted chunk graph has no ineffective dynamic imports");

  // Route-only method factories must remain a real lazy boundary. A broad
  // manualChunks prefix once folded api-client-route-runtime.ts back into the
  // eager api-client chunk while the source still looked dynamically loaded.
  const routeRuntimeChunks = findChunksOwningModule(
    bundleMetadata,
    "/src/lib/api-client-route-runtime.ts",
  );
  if (routeRuntimeChunks.length !== 1) {
    fail(
      "expected exactly one emitted route API runtime chunk, found " +
        `${routeRuntimeChunks.length}: ${routeRuntimeChunks.join(", ") || "(none)"}`,
    );
  }
  const [routeRuntimeChunk] = routeRuntimeChunks;
  if (criticalChunks.includes(routeRuntimeChunk)) {
    fail(`route API runtime ${routeRuntimeChunk} leaked into the critical path`);
  }
  const routeRuntimeImporters = Object.entries(bundleMetadata.chunks)
    .filter(([, record]) => record.dynamicImports.includes(routeRuntimeChunk))
    .map(([chunk]) => chunk)
    .sort();
  if (routeRuntimeImporters.length === 0) {
    fail(`route API runtime ${routeRuntimeChunk} has no emitted dynamic importer`);
  }
  info(
    `OK: route API runtime deferred to ${routeRuntimeChunk} from ` +
      routeRuntimeImporters.join(", "),
  );
  const sentryChunks = allJs.filter(
    (f) => !criticalChunks.includes(f) && fileContains(f, "__SENTRY__"),
  );
  if (sentryChunks.length === 0) {
    fail(
      "no lazy chunk contains the Sentry runtime — the dynamic " +
        "import in lib/sentry.ts won't resolve. Check that " +
        "`@sentry/react` is still a dependency and the import is " +
        "reachable from initSentry().",
    );
  }
  const sentrySize = sentryChunks.reduce((n, f) => n + fileSize(f), 0);
  const sentryGzipSize = sentryChunks.reduce((n, f) => n + gzipSize(f), 0);
  info(
    `OK: Sentry isolated to lazy chunk(s): ${sentryChunks.join(", ")} ` +
      `(${sentrySize} bytes total)`,
  );

  // (3) Entry chunk size — log for human review. Hard-fail only when
  //     it exceeds the explicit budget or when a baseline file is
  //     provided (CI step diffs main vs PR).
  const entrySize = fileSize(entry);
  const entryGzipSize = gzipSize(entry);
  info(`entry chunk size: ${entrySize} bytes (${(entrySize / 1024).toFixed(1)} KB)`);
  assertUnderBudget("entry chunk", entrySize, MAX_ENTRY_BYTES);
  assertUnderBudget("entry chunk (gzip)", entryGzipSize, MAX_ENTRY_GZIP_BYTES);

  // (4) Absolute bundle budgets. These are intentionally raw-byte
  // thresholds so they remain deterministic across local OSes and CI
  // runners. If a PR genuinely needs more budget, bump the number in
  // this file in the same change and explain why in review.
  const criticalJsSize = criticalChunks.reduce((n, f) => n + fileSize(f), 0);
  const initialCssSize = stylesheets.reduce((n, f) => n + fileSize(f), 0);
  const totalJsSize = allJs.reduce((n, f) => n + fileSize(f), 0);
  const criticalJsGzipSize = criticalChunks.reduce((n, f) => n + gzipSize(f), 0);
  const initialCssGzipSize = stylesheets.reduce((n, f) => n + gzipSize(f), 0);
  const totalJsGzipSize = allJs.reduce((n, f) => n + gzipSize(f), 0);
  const sentryChunkSet = new Set(sentryChunks);
  const lazyJs = allJs.filter((f) => !criticalChunks.includes(f));
  const nonSentryLazyJs = lazyJs.filter((f) => !sentryChunkSet.has(f));
  const largestLazy =
    nonSentryLazyJs
      .map((f) => ({ name: f, size: fileSize(f) }))
      .sort((a, b) => b.size - a.size)[0] ?? null;
  const largestLazyGzip =
    nonSentryLazyJs
      .map((f) => ({ name: f, size: gzipSize(f) }))
      .sort((a, b) => b.size - a.size)[0] ?? null;

  assertUnderBudget("critical JS", criticalJsSize, MAX_CRITICAL_JS_BYTES);
  assertUnderBudget(
    "critical JS (gzip)",
    criticalJsGzipSize,
    MAX_CRITICAL_JS_GZIP_BYTES,
  );
  assertUnderBudget("initial CSS", initialCssSize, MAX_INITIAL_CSS_BYTES);
  assertUnderBudget(
    "initial CSS (gzip)",
    initialCssGzipSize,
    MAX_INITIAL_CSS_GZIP_BYTES,
  );
  assertUnderBudget("lazy Sentry JS", sentrySize, MAX_SENTRY_LAZY_BYTES);
  assertUnderBudget(
    "lazy Sentry JS (gzip)",
    sentryGzipSize,
    MAX_SENTRY_LAZY_GZIP_BYTES,
  );
  assertUnderBudget("total JS", totalJsSize, MAX_TOTAL_JS_BYTES);
  assertUnderBudget("total JS (gzip)", totalJsGzipSize, MAX_TOTAL_JS_GZIP_BYTES);
  if (largestLazy) {
    assertUnderBudget(
      `largest non-Sentry lazy JS chunk (${largestLazy.name})`,
      largestLazy.size,
      MAX_LAZY_JS_CHUNK_BYTES,
    );
  }
  if (largestLazyGzip) {
    assertUnderBudget(
      `largest non-Sentry lazy JS chunk (gzip; ${largestLazyGzip.name})`,
      largestLazyGzip.size,
      MAX_LAZY_JS_CHUNK_GZIP_BYTES,
    );
  }

  for (const route of ROUTE_CHUNK_BUDGETS) {
    const matches = allJs.filter((name) => name.startsWith(`${route.name}-`));
    if (matches.length !== 1) {
      fail(
        `expected exactly one ${route.name} route chunk, found ${matches.length}: ` +
          `${matches.join(", ") || "(none)"}`,
      );
    }
    const [chunk] = matches;
    // A route facade can stay tiny while synchronously importing large shared
    // chunks. Budget its full incremental static closure (minus chunks already
    // fetched on the critical path), so extraction cannot game the gate.
    const staticClosure = collectStaticImportClosure(chunk, chunkGraph);
    const incrementalChunks = [...staticClosure]
      .filter((name) => !criticalChunks.includes(name))
      .sort();
    const incrementalCss = [
      ...new Set(
        [...staticClosure].flatMap(
          (name) => bundleMetadata.chunks[name]?.css ?? [],
        ),
      ),
    ]
      .filter((name) => !stylesheets.includes(name))
      .sort();
    const incrementalAssets = [...incrementalChunks, ...incrementalCss];
    const routeRawSize = incrementalAssets.reduce(
      (total, name) => total + fileSize(name),
      0,
    );
    const routeGzipSize = incrementalAssets.reduce(
      (total, name) => total + gzipSize(name),
      0,
    );
    info(
      `${route.name} incremental static closure: ` +
        `JS=[${incrementalChunks.join(", ")}], ` +
        `CSS=[${incrementalCss.join(", ") || "(none)"}] ` +
        `(${incrementalAssets.length} requests)`,
    );
    assertAtMost(
      `${route.name} route payload request count`,
      incrementalAssets.length,
      route.requests,
    );
    assertUnderBudget(
      `${route.name} route incremental static payload`,
      routeRawSize,
      route.raw,
    );
    assertUnderBudget(
      `${route.name} route incremental static payload (gzip)`,
      routeGzipSize,
      route.gzip,
    );
  }

  const baselineEnv = process.env.BUNDLE_SIZE_BASELINE;
  if (baselineEnv) {
    const baseline = parseInt(baselineEnv, 10);
    if (Number.isNaN(baseline) || baseline <= 0) {
      fail(`BUNDLE_SIZE_BASELINE must be a positive integer, got "${baselineEnv}"`);
    }
    const maxAllowed = Math.floor(baseline * (1 + ENTRY_SIZE_SLACK_PCT / 100));
    if (entrySize > maxAllowed) {
      fail(
        `entry chunk grew from ${baseline} → ${entrySize} bytes ` +
          `(+${entrySize - baseline}, +${(((entrySize - baseline) / baseline) * 100).toFixed(1)}%). ` +
          `Budget is ${ENTRY_SIZE_SLACK_PCT}% slack (max ${maxAllowed} bytes).`,
      );
    }
    info(
      `OK: entry chunk within ${ENTRY_SIZE_SLACK_PCT}% of baseline ` +
        `(${baseline} → ${entrySize}, ${maxAllowed} max)`,
    );
  }

  // (5) Optional lazy-savings assertion. When PR CI provides the
  //     pre-lazy baseline (a build of the codebase BEFORE this lazy
  //     refactor), assert the post-lazy entry chunk is at least
  //     MIN_LAZY_SAVINGS_BYTES smaller. This is the long-running
  //     regression guard: if anyone reintroduces a top-level
  //     `import * as Sentry from "@sentry/react"` later, the entry
  //     chunk will swell back up and CI catches it.
  const lazyBaselineEnv = process.env.BUNDLE_SIZE_PRE_LAZY_BASELINE;
  if (lazyBaselineEnv) {
    const preLazy = parseInt(lazyBaselineEnv, 10);
    if (Number.isNaN(preLazy) || preLazy <= 0) {
      fail(`BUNDLE_SIZE_PRE_LAZY_BASELINE must be positive, got "${lazyBaselineEnv}"`);
    }
    const savings = preLazy - entrySize;
    if (savings < MIN_LAZY_SAVINGS_BYTES) {
      fail(
        `entry chunk lazy-load savings dropped below ` +
          `${MIN_LAZY_SAVINGS_BYTES} bytes (got ${savings}). ` +
          `Pre-lazy baseline=${preLazy}, post-lazy=${entrySize}. ` +
          `Check that nothing reintroduced a top-level @sentry/react import.`,
      );
    }
    info(
      `OK: lazy-load savings ${savings} bytes ` +
        `(${(savings / 1024).toFixed(1)} KB, threshold ${MIN_LAZY_SAVINGS_BYTES})`,
    );
  }
}

main();
