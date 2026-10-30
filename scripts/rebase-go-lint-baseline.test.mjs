// SPDX-License-Identifier: AGPL-3.0-only
// Proves the baseline rebase carries moved findings, drops resolved ones, and
// refuses to admit new ones — the three behaviours the exact ratchet relies on.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const script = path.resolve("scripts/rebase-go-lint-baseline.mjs");

function finding(p, line, message, source) {
  return { linter: "govet", path: p, line, column: 5, message, sourceLines: [source] };
}
function issue(p, line, message, source) {
  return { FromLinter: "govet", Pos: { Filename: p, Line: line, Column: 5 }, Text: message, SourceLines: [source] };
}

function run(baseline, report, extra = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "lint-rebase-"));
  const baselinePath = path.join(dir, "baseline.json");
  const reportPath = path.join(dir, "report.json");
  writeFileSync(baselinePath, JSON.stringify(baseline));
  writeFileSync(reportPath, JSON.stringify(report));
  const result = spawnSync(process.execPath, [script, "--report", reportPath, "--baseline", baselinePath, ...extra], {
    encoding: "utf8",
  });
  return { ...result, baselinePath };
}

const baseline = {
  schemaVersion: 1,
  categories: [
    {
      id: "govet-shadow",
      linter: "govet",
      owner: "API Platform",
      rationale: "Legacy shadow declarations require package-by-package control-flow review.",
      expiresOn: "2026-08-15",
      findings: [
        finding("apps/api/main.go", 100, 'shadow: declaration of "err" shadows declaration at line 90', "\tif err := a(); err != nil {"),
        finding("apps/api/main.go", 200, 'shadow: declaration of "ctx" shadows declaration at line 150', "\tctx := b()"),
      ],
    },
  ],
};

test("a moved finding keeps its category at the new path and line", () => {
  const report = {
    Issues: [
      issue("apps/api/routes_billing.go", 42, 'shadow: declaration of "err" shadows declaration at line 30', "\tif err := a(); err != nil {"),
      issue("apps/api/main.go", 180, 'shadow: declaration of "ctx" shadows declaration at line 130', "\tctx := b()"),
    ],
  };
  const result = run(baseline, report, ["--write"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /kept 0, moved 2, resolved 0, accepted 0, new 0/);
  const written = JSON.parse(readFileSync(result.baselinePath, "utf8"));
  const paths = written.categories[0].findings.map((f) => `${f.path}:${f.line}`).sort();
  assert.deepEqual(paths, ["apps/api/main.go:180", "apps/api/routes_billing.go:42"]);
});

test("a resolved finding is dropped and a new one blocks the write", () => {
  const report = {
    Issues: [
      issue("apps/api/main.go", 100, 'shadow: declaration of "err" shadows declaration at line 90', "\tif err := a(); err != nil {"),
      issue("apps/api/new.go", 7, 'shadow: declaration of "x" shadows declaration at line 3', "\tx := c()"),
    ],
  };
  const result = run(baseline, report, ["--write"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /RESOLVED govet apps\/api\/main.go:200/);
  assert.match(result.stdout, /NEW govet apps\/api\/new.go:7:5/);
  assert.match(result.stdout, /kept 1, moved 0, resolved 1, accepted 0, new 1/);
  assert.match(result.stderr, /refusing to write/);
  const unchanged = JSON.parse(readFileSync(result.baselinePath, "utf8"));
  assert.equal(unchanged.categories[0].findings.length, 2);
});

test("an acceptance manifest admits matching new findings under a dated category and nothing else", () => {
  const report = {
    Issues: [
      ...baseline.categories[0].findings.map((f) => issue(f.path, f.line, f.message, f.sourceLines[0])),
      issue("apps/api/x.go", 9, "ST1005: error strings should not be capitalized", "\treturn errors.New(\"Boom\")"),
      issue("apps/api/y.go", 3, "SA4000: identical expressions on both sides", "\tif a == a {"),
    ],
  };
  const dir = mkdtempSync(path.join(tmpdir(), "lint-accept-"));
  const manifest = path.join(dir, "accept.json");
  writeFileSync(
    manifest,
    JSON.stringify([
      {
        id: "staticcheck-error-string-style",
        linter: "staticcheck",
        messagePattern: "^ST1005:",
        owner: "API Platform",
        rationale: "Error-string capitalisation is style debt scheduled for package-level cleanup.",
        expiresOn: "2026-12-11",
      },
    ]),
  );
  const report2 = { Issues: report.Issues.map((i) => ({ ...i, FromLinter: i.Text.startsWith("S") ? "staticcheck" : i.FromLinter })) };
  const result = run(baseline, report2, ["--write", "--accept", manifest]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /ACCEPTED 1 staticcheck finding\(s\) into staticcheck-error-string-style/);

  // An entry for an EXISTING category re-reviews it: date and rationale move
  // even when it claims no new finding.
  const reviewOnly = path.join(dir, "review.json");
  writeFileSync(
    reviewOnly,
    JSON.stringify([
      { id: "govet-shadow", linter: "govet", messagePattern: "^shadow:", owner: "API Platform", rationale: "Re-read on 2026-09-13; the two shadow sites are err/ctx inside their own blocks.", expiresOn: "2026-12-11" },
    ]),
  );
  const reviewed = run(baseline, { Issues: report.Issues.slice(0, 2) }, ["--write", "--accept", reviewOnly]);
  assert.equal(reviewed.status, 0, reviewed.stdout + reviewed.stderr);
  assert.match(reviewed.stdout, /REVIEWED govet-shadow: expires 2026-12-11/);
  const after = JSON.parse(readFileSync(reviewed.baselinePath, "utf8"));
  assert.equal(after.categories[0].expiresOn, "2026-12-11");
  assert.match(after.categories[0].rationale, /Re-read on 2026-09-13/);
  assert.match(result.stdout, /NEW staticcheck apps\/api\/y.go:3:5 SA4000/);
  assert.match(result.stdout, /accepted 1, new 1/);
});

test("a report whose paths point outside the tree is refused (cache contamination)", () => {
  const report = {
    Issues: [
      issue("../../../../elsewhere/postwave/apps/api/x.go", 9, 'shadow: declaration of "err" shadows declaration at line 3', "\terr := a()"),
    ],
  };
  const result = run(baseline, report, ["--write"]);
  assert.equal(result.status, 66);
  assert.match(result.stderr, /not repository-relative/);
  const unchanged = JSON.parse(readFileSync(result.baselinePath, "utf8"));
  assert.equal(unchanged.categories[0].findings.length, 2);
});

test("renewing a category needs a substantive note and stamps the date", () => {
  const report = {
    Issues: baseline.categories[0].findings.map((f) => issue(f.path, f.line, f.message, f.sourceLines[0])),
  };
  const refused = run(baseline, report, ["--renew", "govet-shadow=2026-12-11", "--review-note", "short"]);
  assert.equal(refused.status, 65);
  const ok = run(baseline, report, [
    "--write",
    "--renew",
    "govet-shadow=2026-12-11",
    "--review-note",
    "Re-read every shadow site; all shadow err/ctx inside their own block.",
  ]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const written = JSON.parse(readFileSync(ok.baselinePath, "utf8"));
  assert.equal(written.categories[0].expiresOn, "2026-12-11");
  assert.match(written.categories[0].rationale, /\[re-reviewed \d{4}-\d{2}-\d{2}: Re-read every shadow site/);
});
