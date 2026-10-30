// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import test from "node:test";

import {
  collectPerformanceContractIssues,
  loadPerformanceContracts,
} from "./check-performance-contracts.mjs";

function clone(value) {
  return structuredClone(value);
}

test("checked-in performance contracts pass", () => {
  assert.deepEqual(
    collectPerformanceContractIssues(loadPerformanceContracts()),
    [],
  );
});

test("a non-blocking user-centric assertion fails closed", () => {
  const inputs = clone(loadPerformanceContracts());
  inputs.mobile.ci.assert.assertions.interactive[0] = "warn";
  assert.ok(
    collectPerformanceContractIssues(inputs).some((issue) =>
      issue.includes("mobile Lighthouse assertion interactive"),
    ),
  );
});

test("optimistic Lighthouse aggregation fails closed", () => {
  const inputs = clone(loadPerformanceContracts());
  delete inputs.mobile.ci.assert.assertions["csp-xss"][1].aggregationMethod;
  assert.ok(
    collectPerformanceContractIssues(inputs).some((issue) =>
      issue.includes("mobile every Lighthouse assertion"),
    ),
  );
});

test("a relaxed memory-growth ceiling fails closed", () => {
  const inputs = clone(loadPerformanceContracts());
  inputs.budgets.browser.desktop.maxHeapGrowthMiB = 100;
  assert.ok(
    collectPerformanceContractIssues(inputs).some((issue) =>
      issue.includes("desktop browser interaction/memory budgets"),
    ),
  );
});

test("an uncovered public route fails closed", () => {
  const inputs = clone(loadPerformanceContracts());
  inputs.desktop.ci.collect.url.pop();
  assert.ok(
    collectPerformanceContractIssues(inputs).some((issue) =>
      issue.includes("desktop Lighthouse must cover"),
    ),
  );
});

test("a route override cannot silently raise the reviewed maximum", () => {
  const inputs = clone(loadPerformanceContracts());
  inputs.budgets.routeGraph.overrides[0].maxGzipKiB = 221;
  assert.ok(
    collectPerformanceContractIssues(inputs).some((issue) =>
      issue.includes("route graph override 0 must be positive and no looser"),
    ),
  );
});

test("a declared CSS budget cannot be loosened past the reviewed maximum", () => {
  const inputs = clone(loadPerformanceContracts());
  inputs.budgets.routeGraph.overrides = [
    {
      name: "editor",
      pattern: "^/\\(dashboard\\)/app/editor/page$",
      maxRawKiB: 700,
      maxGzipKiB: 220,
      maxJsRequests: 24,
      maxCssRawKiB: 200,
      maxCssGzipKiB: 41,
      maxCssRequests: 3,
    },
  ];
  assert.ok(
    collectPerformanceContractIssues(inputs).some((issue) =>
      issue.includes("route graph override 0 CSS budgets must be positive"),
    ),
  );
});

test("a partially declared CSS budget fails closed", () => {
  const inputs = clone(loadPerformanceContracts());
  // Build the partial state by REMOVING keys, not by adding one. Adding
  // maxCssGzipKiB only produces a partial declaration while the checked-in
  // config happens to declare no CSS budget at all, so the moment those
  // budgets were filled in this test started asserting nothing and failed.
  // Deleting is true regardless of what is checked in.
  delete inputs.budgets.routeGraph.default.maxCssRawKiB;
  delete inputs.budgets.routeGraph.default.maxCssRequests;
  inputs.budgets.routeGraph.default.maxCssGzipKiB = 40;
  assert.ok(
    collectPerformanceContractIssues(inputs).some((issue) =>
      issue.includes(
        "default route graph must declare maxCssRawKiB, maxCssGzipKiB and maxCssRequests together",
      ),
    ),
  );
});

test("a CSS budget within the reviewed maximum is accepted", () => {
  // Compared against the checked-in contract's own verdict rather than [] so
  // this stays a statement about the CSS keys alone.
  const baseline = collectPerformanceContractIssues(loadPerformanceContracts());
  const inputs = clone(loadPerformanceContracts());
  inputs.budgets.routeGraph.default.maxCssRawKiB = 150;
  inputs.budgets.routeGraph.default.maxCssGzipKiB = 26;
  inputs.budgets.routeGraph.default.maxCssRequests = 2;
  assert.deepEqual(collectPerformanceContractIssues(inputs), baseline);
});

test("the parser-backed sanitizer must stay out of initial route graphs", () => {
  const inputs = clone(loadPerformanceContracts());
  inputs.budgets.routeGraph.forbiddenInitialModuleSignatures =
    inputs.budgets.routeGraph.forbiddenInitialModuleSignatures.filter(
      (entry) => entry.name !== "sanitize-html parser",
    );
  assert.ok(
    collectPerformanceContractIssues(inputs).some((issue) =>
      issue.includes("parser-backed campaign HTML sanitizer"),
    ),
  );
});
