import assert from "node:assert/strict";
import test from "node:test";

import { GoLintRatchetError, checkGoLintBaseline } from "./check-go-lint-baseline.mjs";

const configSha256 = "a".repeat(64);
const scope = ["./apps/api/...", "./services/automation/..."];

function finding(overrides = {}) {
  return {
    linter: "govet",
    path: "apps/api/example.go",
    line: 12,
    column: 3,
    message: "shadow: declaration of err shadows declaration at line 4",
    sourceLines: ["\terr := work()"],
    ...overrides,
  };
}

function issue(value = finding()) {
  return {
    FromLinter: value.linter,
    Text: value.message,
    SourceLines: value.sourceLines,
    Pos: {
      Filename: value.path,
      Line: value.line,
      Column: value.column,
    },
  };
}

function fixture() {
  const accepted = finding();
  return {
    baseline: {
      schemaVersion: 1,
      tool: {
        name: "golangci-lint",
        version: "v2.12.2",
        config: ".golangci.yml",
        configSha256,
      },
      scope,
      categories: [
        {
          id: "govet-shadow",
          linter: "govet",
          owner: "API Platform",
          rationale: "Legacy shadow findings require scoped, behavior-preserving refactors.",
          expiresOn: "2026-08-15",
          findings: [accepted],
        },
      ],
    },
    report: { Issues: [issue(accepted)] },
  };
}

function run({ baseline, report }, overrides = {}) {
  return checkGoLintBaseline({
    baseline,
    report,
    toolVersion: "v2.12.2",
    configSha256,
    scope,
    today: new Date("2026-07-15T00:00:00.000Z"),
    ...overrides,
  });
}

function expectFailure(callback, pattern) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof GoLintRatchetError);
    assert.match(error.message, pattern);
    return true;
  });
}

test("accepts an exact report", () => {
  assert.deepEqual(run(fixture()), {
    total: 1,
    categories: [{ id: "govet-shadow", count: 1 }],
  });
});

test("rejects a new finding", () => {
  const data = fixture();
  data.report.Issues.push(issue(finding({ line: 20 })));
  expectFailure(() => run(data), /1 new\/moved, 0 stale\/resolved/);
});

test("rejects a moved finding as both new and stale", () => {
  const data = fixture();
  data.report.Issues[0].Pos.Line = 13;
  expectFailure(() => run(data), /1 new\/moved, 1 stale\/resolved/);
});

test("rejects a stale resolved finding so the ratchet must shrink", () => {
  const data = fixture();
  data.report.Issues = [];
  expectFailure(() => run(data), /0 new\/moved, 1 stale\/resolved/);
});

test("rejects an expired category", () => {
  const data = fixture();
  data.baseline.categories[0].expiresOn = "2026-07-14";
  expectFailure(() => run(data), /expired on 2026-07-14/);
});

test("rejects duplicate baseline fingerprints", () => {
  const data = fixture();
  data.baseline.categories[0].findings.push(finding());
  expectFailure(() => run(data), /duplicate baseline fingerprint/);
});

test("rejects tool, config, and scope drift", async (t) => {
  await t.test("tool", () => {
    expectFailure(() => run(fixture(), { toolVersion: "v2.13.0" }), /tool version mismatch/);
  });
  await t.test("config", () => {
    expectFailure(() => run(fixture(), { configSha256: "b".repeat(64) }), /config digest mismatch/);
  });
  await t.test("scope", () => {
    expectFailure(() => run(fixture(), { scope: ["./apps/api/..."] }), /lint scope mismatch/);
  });
});
