#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// Re-pin the Go lint baseline (config/go-lint-baseline.json) after a
// behavior-preserving refactor moved code around.
//
// scripts/check-go-lint-baseline.mjs is an EXACT ratchet: a finding is
// identified by linter, path, line, column, message and source line, so
// extracting a function or splitting a file moves every legacy finding it
// carries and the gate reports them as "new/moved". This tool carries each
// accepted finding over to its new location by matching the parts a move does
// not change (linter, message, source line) and, when a file was split, the
// path's package directory. It never admits a finding it cannot match: those
// are printed as NEW and the tool exits non-zero, so the refactor's author
// either fixes them or a reviewer adds them under a category on purpose.
// Baseline findings that no longer appear in the report are RESOLVED and are
// dropped (the gate would otherwise fail them as stale).
//
//   node scripts/rebase-go-lint-baseline.mjs --report <golangci json> \
//     [--baseline config/go-lint-baseline.json] [--write] \
//     [--renew <category-id>=<YYYY-MM-DD> --review-note "<text>"]... \
//     [--accept <review manifest json>]
//
// --accept is the reviewed way to admit NEW findings: a JSON array of
//   { "id", "linter", "messagePattern", "owner", "rationale", "expiresOn" }
// entries; each NEW finding whose linter matches and whose message matches the
// pattern is added under that category (created if absent). The manifest is
// committed next to the baseline as the record of who accepted what and why;
// findings no entry claims stay NEW and still block the write.
//
// Produce the report the way the gate does (see ci.yml "Run uncapped Go lint
// ratchet"): `golangci-lint cache clean` first, then from the repository root
// golangci-lint run --issues-exit-code=0 --max-issues-per-linter=0
// --max-same-issues=0 --output.json.path=<file> <scopes>. The cache clean is
// not optional on a developer machine: golangci-lint reuses issue records
// across checkouts, and a warm cache has produced reports with a hundred
// SA5011 findings and paths into another working tree that two clean runs
// of the same tree never showed.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const options = { baseline: "config/go-lint-baseline.json", report: "", write: false, renew: [], reviewNote: "", accept: "" };
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--report") options.report = args[++i];
  else if (arg === "--baseline") options.baseline = args[++i];
  else if (arg === "--write") options.write = true;
  else if (arg === "--renew") options.renew.push(args[++i]);
  else if (arg === "--review-note") options.reviewNote = args[++i];
  else if (arg === "--accept") options.accept = args[++i];
  else {
    console.error(`unknown argument ${arg}`);
    process.exit(64);
  }
}
if (!options.report) {
  console.error("--report <golangci json> is required");
  process.exit(64);
}

const root = process.cwd();
const baseline = JSON.parse(readFileSync(path.resolve(root, options.baseline), "utf8"));
const report = JSON.parse(readFileSync(path.resolve(root, options.report), "utf8"));
const issues = Array.isArray(report.Issues) ? report.Issues : [];

// Paths are repository-relative. golangci-lint's cache can hand back issue
// records from an earlier run in another checkout (an absolute path, or one
// climbing out of the current tree), so anything that is not already
// repository-relative is refused rather than normalised: it means the report
// was not produced from a clean cache on this tree.
const normalizePath = (value) => {
  const cleaned = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (path.posix.isAbsolute(cleaned) || cleaned.startsWith("../")) {
    console.error(
      `report path is not repository-relative: ${value}\n` +
        "run golangci-lint from the repository root after `golangci-lint cache clean`; a cached run from another checkout contaminated this report",
    );
    process.exit(66);
  }
  return cleaned;
};
const exactKey = (f) => JSON.stringify([f.linter, f.path, f.line, f.column, f.message, f.sourceLines]);
// A move keeps the linter, the message and the source line. Shadow messages
// embed the line of the shadowed declaration ("shadows declaration at line
// 233"), which a move changes too, so that number is masked for matching.
const maskLineRefs = (message) => message.replace(/\bline \d+\b/g, "line N");
const moveKey = (f) => JSON.stringify([f.linter, maskLineRefs(f.message), f.sourceLines]);
const dirOf = (p) => path.posix.dirname(normalizePath(p));

const reportFindings = issues.map((issue) => ({
  linter: issue.FromLinter,
  path: normalizePath(issue.Pos.Filename),
  line: issue.Pos.Line,
  column: issue.Pos.Column,
  message: issue.Text,
  sourceLines: issue.SourceLines ?? [],
}));

const reportByExact = new Map(reportFindings.map((f) => [exactKey(f), f]));
const unclaimed = new Set(reportFindings.map((f) => exactKey(f)));
const summary = { kept: 0, moved: 0, resolved: 0, new: 0 };

for (const category of baseline.categories) {
  const next = [];
  const pending = [];
  for (const finding of category.findings) {
    const key = exactKey({ ...finding, path: normalizePath(finding.path) });
    if (reportByExact.has(key) && unclaimed.has(key)) {
      unclaimed.delete(key);
      next.push(finding);
      summary.kept += 1;
    } else {
      pending.push(finding);
    }
  }
  // Second pass: same linter/message/source line, preferring the same file,
  // then the same package directory (a split file), then anywhere in scope.
  for (const finding of pending) {
    const wanted = moveKey(finding);
    const candidates = [...unclaimed]
      .map((k) => reportByExact.get(k))
      .filter((f) => moveKey(f) === wanted);
    const rank = (f) =>
      f.path === normalizePath(finding.path) ? 0 : dirOf(f.path) === dirOf(finding.path) ? 1 : 2;
    candidates.sort((a, b) => rank(a) - rank(b) || Math.abs(a.line - finding.line) - Math.abs(b.line - finding.line));
    const match = candidates[0];
    if (match) {
      unclaimed.delete(exactKey(match));
      next.push({ ...finding, path: match.path, line: match.line, column: match.column, message: match.message });
      summary.moved += 1;
    } else {
      summary.resolved += 1;
      console.log(`RESOLVED ${finding.linter} ${finding.path}:${finding.line} ${finding.message.replace(/\s*\n\s*/g, " ⏎ ")}`);
    }
  }
  next.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  category.findings = next;
}

let newFindings = [...unclaimed].map((k) => reportByExact.get(k));
summary.accepted = 0;
if (options.accept) {
  const manifest = JSON.parse(readFileSync(path.resolve(root, options.accept), "utf8"));
  if (!Array.isArray(manifest)) {
    console.error("--accept manifest must be a JSON array");
    process.exit(65);
  }
  for (const [index, entry] of manifest.entries()) {
    for (const key of ["id", "linter", "messagePattern", "owner", "rationale", "expiresOn"]) {
      if (typeof entry[key] !== "string" || entry[key].trim() === "") {
        console.error(`--accept: entry ${index} is missing ${key}`);
        process.exit(65);
      }
    }
    if (entry.rationale.trim().length < 20) {
      console.error(`--accept: entry ${index} (${entry.id}) needs a rationale of 20+ characters`);
      process.exit(65);
    }
    const pattern = new RegExp(entry.messagePattern, "u");
    const claimed = newFindings.filter((f) => f.linter === entry.linter && pattern.test(f.message));
    let category = baseline.categories.find((c) => c.id === entry.id);
    if (!category) {
      if (claimed.length === 0) continue;
      category = { id: entry.id, linter: entry.linter, owner: entry.owner, rationale: entry.rationale, expiresOn: entry.expiresOn, findings: [] };
      baseline.categories.push(category);
    } else if (category.linter !== entry.linter) {
      console.error(`--accept: category ${entry.id} is for linter ${category.linter}, not ${entry.linter}`);
      process.exit(65);
    } else {
      // An entry for an existing category is that category's review: the
      // manifest's owner, rationale and review date replace the old ones
      // whether or not new findings were claimed this time.
      category.owner = entry.owner;
      category.rationale = entry.rationale;
      category.expiresOn = entry.expiresOn;
      console.log(`REVIEWED ${entry.id}: expires ${entry.expiresOn}`);
    }
    if (claimed.length === 0) continue;
    category.findings.push(...claimed);
    category.findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
    const claimedKeys = new Set(claimed.map((f) => exactKey(f)));
    newFindings = newFindings.filter((f) => !claimedKeys.has(exactKey(f)));
    summary.accepted += claimed.length;
    console.log(`ACCEPTED ${claimed.length} ${entry.linter} finding(s) into ${entry.id} (expires ${entry.expiresOn})`);
  }
}
summary.new = newFindings.length;
const oneLine = (message) => message.replace(/\s*\n\s*/g, " ⏎ ");
for (const f of newFindings) {
  console.log(`NEW ${f.linter} ${f.path}:${f.line}:${f.column} ${oneLine(f.message)}`);
}

for (const spec of options.renew) {
  const [id, date] = spec.split("=");
  const category = baseline.categories.find((c) => c.id === id);
  if (!category) {
    console.error(`--renew: no category ${id}`);
    process.exit(65);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? "")) {
    console.error(`--renew: ${spec} needs <id>=<YYYY-MM-DD>`);
    process.exit(65);
  }
  if (!options.reviewNote || options.reviewNote.trim().length < 20) {
    console.error("--renew requires --review-note explaining the re-review (20+ characters)");
    process.exit(65);
  }
  category.expiresOn = date;
  category.rationale = `${category.rationale.replace(/\s*\[re-reviewed [^\]]*\]$/u, "")} [re-reviewed ${new Date().toISOString().slice(0, 10)}: ${options.reviewNote.trim()}]`;
}

console.log(
  `baseline rebase: kept ${summary.kept}, moved ${summary.moved}, resolved ${summary.resolved}, accepted ${summary.accepted}, new ${summary.new}`,
);
if (options.write) {
  if (summary.new > 0) {
    console.error("refusing to write: new findings must be fixed or added under a category by a reviewer");
    process.exit(1);
  }
  writeFileSync(path.resolve(root, options.baseline), `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`wrote ${options.baseline}`);
}
process.exit(summary.new > 0 ? 1 : 0);
