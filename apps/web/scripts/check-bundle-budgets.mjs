// SPDX-License-Identifier: AGPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

import {
  forbiddenSignatureCoverage,
  matchingForbiddenSignatureNames,
} from "./lib/forbidden-signatures.mjs";
import { resolveNextDistDir } from "./lib/next-dist-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, "..");
const nextDir = resolveNextDistDir(
  appDir,
  process.env.POSTWAVE_NEXT_DIST_DIR,
);
const manifestPath = path.join(nextDir, "app-build-manifest.json");
const budgetsPath = path.join(appDir, "performance-budgets.json");
const reportPath = path.join(nextDir, "postwave-bundle-report.json");

const KiB = 1024;

function readJson(filePath, missingMessage) {
  if (!fs.existsSync(filePath)) {
    console.error(missingMessage);
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error(
      `[bundle-budget] Invalid ${path.relative(process.cwd(), filePath)}: ${error.message}`,
    );
    process.exit(1);
  }
}

const manifest = readJson(
  manifestPath,
  `[bundle-budget] Missing ${path.relative(process.cwd(), manifestPath)}. Run \`pnpm --filter @postwave/web build\` first.`,
);
const performanceBudgets = readJson(
  budgetsPath,
  `[bundle-budget] Missing ${path.relative(process.cwd(), budgetsPath)}.`,
);
const graphConfig = performanceBudgets?.routeGraph;
if (!graphConfig?.default || !Array.isArray(graphConfig.overrides)) {
  console.error("[bundle-budget] performance-budgets.json has no routeGraph contract");
  process.exit(1);
}

let compiledOverrides;
try {
  compiledOverrides = graphConfig.overrides.map((budget) => ({
    ...budget,
    regex: new RegExp(budget.pattern, "u"),
  }));
} catch (error) {
  console.error(`[bundle-budget] Invalid route budget pattern: ${error.message}`);
  process.exit(1);
}

function routeBudget(route) {
  return (
    compiledOverrides.find((budget) => budget.regex.test(route)) ?? {
      name: "default",
      ...graphConfig.default,
    }
  );
}

/**
 * app-build-manifest records page and layout entrypoints separately. A page
 * cannot execute without its root and ancestor layouts, so measuring only the
 * page entry materially understates the route graph. Return the exact ordered
 * layout + page entries whose JS files must be unioned for this source route.
 */
function graphEntriesForRoute(route, pages) {
  const segments = route.split("/").filter(Boolean);
  const entries = [];
  for (let depth = 0; depth < segments.length; depth += 1) {
    const prefix = depth === 0 ? "" : `/${segments.slice(0, depth).join("/")}`;
    const layout = `${prefix}/layout`;
    if (pages[layout]) entries.push(layout);
  }
  entries.push(route);
  return [...new Set(entries)];
}

const fileCache = new Map();
function fileInfo(file) {
  if (fileCache.has(file)) return fileCache.get(file);
  const fullPath = path.join(nextDir, file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`manifest references missing chunk ${file}`);
  }
  const content = fs.readFileSync(fullPath);
  const info = {
    rawBytes: content.byteLength,
    gzipBytes: gzipSync(content, { level: 9 }).byteLength,
    content,
  };
  fileCache.set(file, info);
  return info;
}

function emittedJavaScriptFiles(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        files.push(path.relative(nextDir, fullPath).split(path.sep).join("/"));
      }
    }
  };
  visit(rootDir);
  return files.sort();
}

const pages = manifest.pages;
if (!pages || typeof pages !== "object" || Array.isArray(pages)) {
  console.error("[bundle-budget] app-build-manifest.json has no pages map");
  process.exit(1);
}

const pageRoutes = Object.keys(pages).filter((route) => route.endsWith("/page"));
if (pageRoutes.length === 0) {
  console.error("[bundle-budget] no page entrypoints were found; refusing an empty pass");
  process.exit(1);
}

const forbiddenSignatures = graphConfig.forbiddenInitialModuleSignatures;
let emittedSignatureCoverage;
try {
  const allEmittedClientJs = emittedJavaScriptFiles(path.join(nextDir, "static"));
  emittedSignatureCoverage = forbiddenSignatureCoverage(
    forbiddenSignatures,
    allEmittedClientJs.map((file) => ({ file, content: fileInfo(file).content })),
  );
} catch (error) {
  console.error(`[bundle-budget] forbidden signature coverage failed: ${error.message}`);
  process.exit(1);
}
const missingSignatures = emittedSignatureCoverage.filter(
  (entry) => entry.matchedFile === null,
);
if (missingSignatures.length > 0) {
  console.error(
    "[bundle-budget] forbidden marker set missing from emitted client JavaScript; update the contract explicitly if the library was intentionally removed:",
  );
  for (const signature of missingSignatures) {
    console.error(`- ${signature.name}: ${signature.markers.join(", ")}`);
  }
  process.exit(1);
}
// A lazily-loaded library that is emitted more than once is a duplicated copy
// published to the CDN. It breaks no budget (no route graph loads both), so
// this reports rather than fails — but reporting only the first match hid the
// duplication entirely.
const duplicatedSignatures = emittedSignatureCoverage.filter(
  (entry) => (entry.matchedFiles?.length ?? 0) > 1,
);
for (const signature of duplicatedSignatures) {
  console.warn(
    `[bundle-budget] ${signature.name} is emitted in ${signature.matchedFiles.length} chunks: ${signature.matchedFiles.join(", ")}`,
  );
}

let routeGraphs;
try {
  routeGraphs = pageRoutes.map((route) => {
    const graphEntries = graphEntriesForRoute(route, pages);
    const graphFiles = graphEntries.flatMap((entry) => pages[entry] ?? []);
    const files = [
      ...new Set(graphFiles.filter((file) => file.endsWith(".js"))),
    ];
    // Stylesheets attached to the layout entries are render-blocking `<link>`
    // tags in `<head>`: nothing paints until they arrive and parse. Measuring
    // only .js understated every route by the whole CSS graph.
    const cssFiles = [
      ...new Set(graphFiles.filter((file) => file.endsWith(".css"))),
    ];
    if (files.length === 0) {
      throw new Error(`${route} has an empty JavaScript graph`);
    }
    const budget = routeBudget(route);
    const infos = files.map((file) => ({ file, ...fileInfo(file) }));
    const cssInfos = cssFiles.map((file) => ({ file, ...fileInfo(file) }));
    const forbiddenModules = matchingForbiddenSignatureNames(
      forbiddenSignatures,
      infos,
    );
    return {
      route,
      graphEntries,
      files,
      cssFiles,
      rawBytes: infos.reduce((total, info) => total + info.rawBytes, 0),
      gzipBytes: infos.reduce((total, info) => total + info.gzipBytes, 0),
      jsRequests: files.length,
      cssRawBytes: cssInfos.reduce((total, info) => total + info.rawBytes, 0),
      cssGzipBytes: cssInfos.reduce((total, info) => total + info.gzipBytes, 0),
      cssRequests: cssFiles.length,
      forbiddenModules,
      budget,
    };
  });
} catch (error) {
  console.error(`[bundle-budget] ${error.message}`);
  process.exit(1);
}

function failuresFor(entry) {
  const failures = [];
  if (entry.rawBytes > entry.budget.maxRawKiB * KiB) {
    failures.push(
      `${Math.round(entry.rawBytes / KiB)} KiB raw > ${entry.budget.maxRawKiB} KiB`,
    );
  }
  if (entry.gzipBytes > entry.budget.maxGzipKiB * KiB) {
    failures.push(
      `${Math.round(entry.gzipBytes / KiB)} KiB gzip > ${entry.budget.maxGzipKiB} KiB`,
    );
  }
  if (entry.jsRequests > entry.budget.maxJsRequests) {
    failures.push(
      `${entry.jsRequests} JS requests > ${entry.budget.maxJsRequests}`,
    );
  }
  // CSS budgets are opt-in per budget entry so a route can be certified for
  // render-blocking stylesheet weight without silently inventing a ceiling
  // for routes nobody has reviewed yet. Where a ceiling exists it is enforced
  // exactly like the JS ones.
  if (
    Number.isFinite(entry.budget.maxCssRawKiB) &&
    entry.cssRawBytes > entry.budget.maxCssRawKiB * KiB
  ) {
    failures.push(
      `${Math.round(entry.cssRawBytes / KiB)} KiB CSS raw > ${entry.budget.maxCssRawKiB} KiB`,
    );
  }
  if (
    Number.isFinite(entry.budget.maxCssGzipKiB) &&
    entry.cssGzipBytes > entry.budget.maxCssGzipKiB * KiB
  ) {
    failures.push(
      `${Math.round(entry.cssGzipBytes / KiB)} KiB CSS gzip > ${entry.budget.maxCssGzipKiB} KiB`,
    );
  }
  if (
    Number.isFinite(entry.budget.maxCssRequests) &&
    entry.cssRequests > entry.budget.maxCssRequests
  ) {
    failures.push(
      `${entry.cssRequests} CSS requests > ${entry.budget.maxCssRequests}`,
    );
  }
  if (entry.forbiddenModules.length > 0) {
    failures.push(
      `forbidden initial module(s): ${entry.forbiddenModules.join(", ")}`,
    );
  }
  return failures;
}

const failures = routeGraphs
  .map((entry) => ({ entry, reasons: failuresFor(entry) }))
  .filter(({ reasons }) => reasons.length > 0);
const largest = [...routeGraphs]
  .sort((left, right) => right.gzipBytes - left.gzipBytes)
  .slice(0, 12);

console.log("[bundle-budget] largest complete route JS graphs:");
for (const entry of largest) {
  console.log(
    `- ${entry.route}: ${Math.round(entry.rawBytes / KiB)} KiB raw, ${Math.round(entry.gzipBytes / KiB)} KiB gzip, ${entry.jsRequests} requests (${entry.budget.name})`,
  );
}

const heaviestCss = [...routeGraphs]
  .filter((entry) => entry.cssRequests > 0)
  .sort((left, right) => right.cssGzipBytes - left.cssGzipBytes)
  .slice(0, 6);
if (heaviestCss.length > 0) {
  console.log("[bundle-budget] heaviest render-blocking route CSS graphs:");
  for (const entry of heaviestCss) {
    const ceiling = Number.isFinite(entry.budget.maxCssGzipKiB)
      ? `${entry.budget.maxCssGzipKiB} KiB gzip budget`
      : "no CSS budget configured";
    console.log(
      `- ${entry.route}: ${Math.round(entry.cssRawBytes / KiB)} KiB raw, ${Math.round(entry.cssGzipBytes / KiB)} KiB gzip, ${entry.cssRequests} stylesheets (${entry.budget.name}, ${ceiling})`,
    );
  }
}

const routes = [...routeGraphs]
  .sort((left, right) => left.route.localeCompare(right.route))
  .map((entry) => ({
    route: entry.route,
    graphEntries: entry.graphEntries,
    rawKiB: Number((entry.rawBytes / KiB).toFixed(1)),
    gzipKiB: Number((entry.gzipBytes / KiB).toFixed(1)),
    jsRequests: entry.jsRequests,
    cssRawKiB: Number((entry.cssRawBytes / KiB).toFixed(1)),
    cssGzipKiB: Number((entry.cssGzipBytes / KiB).toFixed(1)),
    cssRequests: entry.cssRequests,
    budget: {
      name: entry.budget.name,
      maxRawKiB: entry.budget.maxRawKiB,
      maxGzipKiB: entry.budget.maxGzipKiB,
      maxJsRequests: entry.budget.maxJsRequests,
      maxCssRawKiB: entry.budget.maxCssRawKiB ?? null,
      maxCssGzipKiB: entry.budget.maxCssGzipKiB ?? null,
      maxCssRequests: entry.budget.maxCssRequests ?? null,
    },
    forbiddenModules: entry.forbiddenModules,
    withinBudget: failuresFor(entry).length === 0,
  }));

const report = {
  schemaVersion: 4,
  source: path.relative(appDir, manifestPath),
  budgets: path.relative(appDir, budgetsPath),
  routeCount: routes.length,
  forbiddenSignatureCoverage: emittedSignatureCoverage,
  largestRoutes: largest.map((entry) => ({
    route: entry.route,
    rawKiB: Number((entry.rawBytes / KiB).toFixed(1)),
    gzipKiB: Number((entry.gzipBytes / KiB).toFixed(1)),
    jsRequests: entry.jsRequests,
  })),
  heaviestCssRoutes: heaviestCss.map((entry) => ({
    route: entry.route,
    cssRawKiB: Number((entry.cssRawBytes / KiB).toFixed(1)),
    cssGzipKiB: Number((entry.cssGzipBytes / KiB).toFixed(1)),
    cssRequests: entry.cssRequests,
    cssFiles: entry.cssFiles,
  })),
  failureCount: failures.length,
  failures: failures.map(({ entry, reasons }) => ({
    route: entry.route,
    reasons,
  })),
  routes,
};

fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`[bundle-budget] wrote ${path.relative(process.cwd(), reportPath)}`);

if (failures.length > 0) {
  console.error("[bundle-budget] route graph budget failures:");
  for (const { entry, reasons } of failures) {
    console.error(`- ${entry.route}: ${reasons.join("; ")}`);
  }
  process.exit(1);
}

const cssBudgeted = routes.filter(
  (route) => route.budget.maxCssGzipKiB !== null,
).length;
console.log(
  `[bundle-budget] ok — ${routes.length} page graphs have raw, gzip, request-count, CSS-weight, and forbidden-module coverage (${cssBudgeted} with an enforced CSS ceiling)`,
);
