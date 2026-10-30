#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(appDir, relativePath), "utf8"));
}

function sameArray(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function lighthouseRoutePaths(urls) {
  if (!Array.isArray(urls)) return null;
  try {
    return urls.map((value) => {
      const url = new URL(value);
      if (url.origin !== "http://localhost:3000") {
        throw new Error("unexpected Lighthouse origin");
      }
      return `${url.pathname}${url.search}`;
    });
  } catch {
    return null;
  }
}

function assertionMatches(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== 2) return false;
  if (actual[0] !== "error") return false;
  const options = actual[1];
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return false;
  }
  return (
    options.aggregationMethod === "pessimistic" &&
    Object.entries(expected).every(([key, value]) => options[key] === value)
  );
}

export function collectPerformanceContractIssues({ budgets, desktop, mobile }) {
  const issues = [];
  const requireContract = (condition, message) => {
    if (!condition) issues.push(message);
  };

  requireContract(
    budgets?.schemaVersion === 1,
    "performance-budgets.json must use schemaVersion 1",
  );
  requireContract(
    Array.isArray(budgets?.publicRoutes) && budgets.publicRoutes.length >= 5,
    "at least five representative public routes must be certified",
  );

  // Render-blocking stylesheet weight is budgeted with the same three-key
  // shape as JS. The keys are optional so a route can be certified for CSS
  // deliberately rather than by accident — but a budget that declares any of
  // them must declare all three, and none may be looser than the reviewed
  // maximum (a full dashboard route is ~133 KiB raw / 24 KiB gzip over two
  // stylesheets today, so these ceilings leave headroom without hiding a
  // vendor stylesheet regression).
  const requireCssContract = (label, budget) => {
    const keys = ["maxCssRawKiB", "maxCssGzipKiB", "maxCssRequests"];
    const declared = keys.filter((key) => budget?.[key] !== undefined);
    if (declared.length === 0) return;
    requireContract(
      declared.length === keys.length,
      `${label} must declare maxCssRawKiB, maxCssGzipKiB and maxCssRequests together`,
    );
    requireContract(
      Number(budget?.maxCssRawKiB) > 0 &&
        Number(budget?.maxCssRawKiB) <= 200 &&
        Number(budget?.maxCssGzipKiB) > 0 &&
        Number(budget?.maxCssGzipKiB) <= 40 &&
        Number(budget?.maxCssRequests) > 0 &&
        Number(budget?.maxCssRequests) <= 4,
      `${label} CSS budgets must be positive and no looser than 200 KiB raw, 40 KiB gzip, and 4 stylesheets`,
    );
  };

  const routeDefault = budgets?.routeGraph?.default;
  requireCssContract("default route graph", routeDefault);
  requireContract(
    Number(routeDefault?.maxRawKiB) > 0 &&
      Number(routeDefault?.maxRawKiB) <= 700 &&
      Number(routeDefault?.maxGzipKiB) > 0 &&
      Number(routeDefault?.maxGzipKiB) <= 220 &&
      Number(routeDefault?.maxJsRequests) > 0 &&
      Number(routeDefault?.maxJsRequests) <= 24,
    "default route graph budgets must be positive and no looser than 700 KiB raw, 220 KiB gzip, and 24 JS requests",
  );

  const overrides = budgets?.routeGraph?.overrides;
  requireContract(
    Array.isArray(overrides) && overrides.length > 0,
    "route graph overrides must explicitly name exceptional editors",
  );
  for (const [index, override] of (overrides ?? []).entries()) {
    try {
      new RegExp(override.pattern, "u");
    } catch {
      issues.push(`route graph override ${index} has an invalid pattern`);
    }
    requireContract(
      typeof override.name === "string" && override.name.trim() !== "",
      `route graph override ${index} must have a reviewable name`,
    );
    requireContract(
      Number(override.maxRawKiB) > 0 &&
        Number(override.maxRawKiB) <= 700 &&
        Number(override.maxGzipKiB) > 0 &&
        Number(override.maxGzipKiB) <= 220 &&
        Number(override.maxJsRequests) > 0 &&
        Number(override.maxJsRequests) <= 24,
      `route graph override ${index} must be positive and no looser than 700 KiB raw, 220 KiB gzip, and 24 JS requests`,
    );
    requireCssContract(`route graph override ${index}`, override);
  }

  const forbidden = budgets?.routeGraph?.forbiddenInitialModuleSignatures;
  requireContract(
    Array.isArray(forbidden) &&
      forbidden.some(
        (entry) =>
          entry.name === "Sentry browser SDK" &&
          Array.isArray(entry.markers) &&
          entry.markers.length >= 3,
      ),
    "initial route graphs must explicitly prohibit the lazy Sentry browser SDK",
  );
  requireContract(
    Array.isArray(forbidden) &&
      forbidden.some(
        (entry) =>
          entry.name === "sanitize-html parser" &&
          Array.isArray(entry.markers) &&
          entry.markers.length >= 3,
      ),
    "initial route graphs must prohibit the parser-backed campaign HTML sanitizer",
  );

  const configs = [
    ["desktop", desktop],
    ["mobile", mobile],
  ];
  for (const [profile, config] of configs) {
    const collect = config?.ci?.collect;
    const assertions = config?.ci?.assert?.assertions;
    const expected = budgets?.lighthouse?.[profile];
    requireContract(
      sameArray(
        lighthouseRoutePaths(collect?.url),
        budgets?.publicRoutes ?? [],
      ),
      `${profile} Lighthouse must cover the canonical public route matrix in order`,
    );
    requireContract(
      collect?.numberOfRuns === budgets?.lighthouse?.numberOfRuns &&
        collect.numberOfRuns >= 3,
      `${profile} Lighthouse must run the configured sample count`,
    );
    requireContract(
      config?.ci?.upload?.target === "filesystem" &&
        typeof config?.ci?.upload?.outputDir === "string",
      `${profile} Lighthouse reports must remain private filesystem artifacts`,
    );
    requireContract(
      assertions && typeof assertions === "object",
      `${profile} Lighthouse assertions are missing`,
    );
    requireContract(
      Object.values(assertions ?? {}).every(
        (assertion) =>
          Array.isArray(assertion) &&
          assertion[1]?.aggregationMethod === "pessimistic",
      ),
      `${profile} every Lighthouse assertion must use pessimistic aggregation`,
    );
    for (const [audit, limit] of Object.entries(expected ?? {})) {
      requireContract(
        assertionMatches(assertions?.[audit], limit),
        `${profile} Lighthouse assertion ${audit} must be blocking at the canonical limit`,
      );
    }
    requireContract(
      !JSON.stringify(config).includes('"off"') &&
        !Object.hasOwn(collect?.settings ?? {}, "skipAudits"),
      `${profile} Lighthouse must not disable or skip audits`,
    );
  }

  requireContract(
    desktop?.ci?.collect?.settings?.preset === "desktop",
    "desktop Lighthouse must use the desktop preset",
  );
  requireContract(
    mobile?.ci?.collect?.settings?.preset === undefined &&
      mobile?.ci?.collect?.settings?.throttlingMethod === "devtools",
    "mobile Lighthouse must use its default mobile profile with DevTools throttling",
  );
  requireContract(
    desktop?.ci?.upload?.outputDir !== mobile?.ci?.upload?.outputDir,
    "desktop and mobile Lighthouse evidence directories must be distinct",
  );

  const browser = budgets?.browser;
  requireContract(
    Number.isInteger(browser?.navigationCycles) &&
      browser.navigationCycles >= 2,
    "browser memory certification must perform at least two navigation cycles",
  );
  for (const profile of ["desktop", "mobile"]) {
    const limits = browser?.[profile];
    requireContract(
      Number(limits?.cpuSlowdown) >= (profile === "mobile" ? 4 : 2) &&
        Number(limits?.maxNavigationClickEventMs) > 0 &&
        Number(limits?.maxNavigationClickEventMs) <=
          (profile === "mobile" ? 250 : 150) &&
        Number(limits?.maxLongTaskTotalMs) > 0 &&
        Number(limits?.maxLongTaskTotalMs) <=
          (profile === "mobile" ? 500 : 300) &&
        Number(limits?.maxHeapMiB) > 0 &&
        Number(limits?.maxHeapMiB) <= 80 &&
        Number(limits?.maxHeapGrowthMiB) >= 0 &&
        Number(limits?.maxHeapGrowthMiB) <= 10 &&
        Number(limits?.maxDomNodes) > 0 &&
        Number(limits?.maxDomNodes) <= 3000,
      `${profile} browser interaction/memory budgets are missing or too loose`,
    );
  }

  return issues;
}

export function loadPerformanceContracts() {
  return {
    budgets: readJson("performance-budgets.json"),
    desktop: readJson("lighthouserc.json"),
    mobile: readJson("lighthouserc.mobile.json"),
  };
}

function main() {
  const issues = collectPerformanceContractIssues(loadPerformanceContracts());
  if (issues.length > 0) {
    for (const issue of issues)
      console.error(`[performance-contract] ${issue}`);
    process.exit(1);
  }
  console.log(
    "[performance-contract] route, startup, interaction, and memory budgets are fail-closed",
  );
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main();
}
