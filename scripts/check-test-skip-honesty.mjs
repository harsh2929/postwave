#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
//
// A test that SKIPS when its fixture fails reports PASS.
//
// This is not a hypothetical. Twice in one working session a Go test file was
// mutated five ways, all five mutations "passed", and the reason both times was
// that every test in the file had skipped on a seed error nobody read:
//
//     if _, err := tx.Exec(ctx, `INSERT INTO ...`); err != nil {
//         t.Skipf("lists shape differs here: %v", err)   // <- reports PASS
//     }
//
// The intent is reasonable — "this environment may not have that table" — and
// the effect is a suite that is green over code it never executed. Worse, it is
// green in exactly the situation where you most need it to be red: the schema
// moved under the feature.
//
// A LEGITIMATE SKIP IS ABOUT THE ENVIRONMENT, NOT THE FIXTURE.
//
//   legitimate:  no DATABASE_URL, no docker, no tzdata, wrong GOOS, no network
//   not:         the seed INSERT failed, the table is missing, the shape differs
//
// The first says "this machine cannot run this test". The second says "this
// test tried to run and could not set itself up", which is a failure wearing a
// skip's clothes. The distinction is the whole check.
//
// ENUMERATED, NOT COUNTED. The offenders are listed by file rather than
// totalled, for the reason this repo has already learned twice: a stored number
// drifts in silence, while a list fails loudly when a NEW one appears and
// shrinking it is a diff that names exactly what was fixed.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOT = join(repoRoot, "apps/api/internal");

// Words that mean "this machine cannot run the test". A skip whose message
// contains one of these is about the environment and is left alone.
const ENVIRONMENT_MARKERS = [
  "database_url",
  // With a space, too: "admin database URL is required for ..." is the same
  // gate written in prose. Matching only the identifier form classified those
  // as fixture failures.
  "database url",
  "not set",
  "unset",
  "skipping short",
  "short mode",
  "-short",
  "docker",
  "testcontainer",
  "no network",
  "network access",
  "tzdata",
  "time zone database",
  "tz database",
  "not installed",
  "not available on",
  "requires linux",
  "requires darwin",
  "goos",
  "binary not found",
  "no such binary",
  "credentials not configured",
  "api key not set",
  "env var",
  "environment variable",
];

// Words that mean "there is genuinely nothing here to exercise" — a CAPABILITY
// statement, not a failure.
//
// This is a third category and it earns its place. "no migration issues its own
// COMMIT; nothing to check" is a test whose subject does not exist in the tree;
// "automation_flows is not part of this service's schema" names a table no
// migration creates and no Go file references. Neither is a fixture that broke,
// and neither becomes a false green: there is no assertion being skipped past,
// because there is nothing to assert. Forcing these to t.Fatalf would fail the
// build over the absence of something nobody built.
//
// The distinction from a FIXTURE skip is that a capability skip is decided by
// ASKING (a lookup, a count, a probe) and never carries an error from a
// statement that was supposed to work.
const CAPABILITY_MARKERS = [
  "nothing to check",
  "not part of this service's schema",
  "has been retired",
  "no rows to",
  "nothing to exercise",
];

// Words that mean "the test tried to set itself up and failed". These are the
// ones that turn a broken fixture into a green run.
const FIXTURE_MARKERS = [
  "shape differs",
  "seed",
  "insert",
  "create table",
  "does not exist",
  "missing table",
  "migration",
  "fixture",
  "setup failed",
  "could not create",
  "cannot create",
  "failed to insert",
  "no such table",
  "schema",
];

function goTestFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "testdata") continue;
      goTestFiles(full, out);
    } else if (entry.endsWith("_test.go")) {
      out.push(full);
    }
  }
  return out;
}

// A skip is fixture-shaped when its message names a setup failure, OR when it
// carries an error value (`%v`, err) and says nothing about the environment.
//
// The second half matters: `t.Skipf("cannot proceed: %v", err)` names no marker
// at all and is exactly the silent case. A skip that formats an ERROR is
// reporting something that went wrong, and something going wrong is a failure.
export function classifySkip(message, hasErrorArg) {
  const lower = message.toLowerCase();
  if (ENVIRONMENT_MARKERS.some((m) => lower.includes(m))) return "environment";
  // A capability statement only counts when it carries no error. A message that
  // says "nothing to check: %v, err" IS a failure wearing a capability's words.
  if (!hasErrorArg && CAPABILITY_MARKERS.some((m) => lower.includes(m))) return "environment";
  if (FIXTURE_MARKERS.some((m) => lower.includes(m))) return "fixture";
  if (hasErrorArg) return "fixture";
  return "unclear";
}

const SKIP_CALL = /\bt\.Skipf?\(\s*("(?:[^"\\]|\\.)*")([^)]*)\)/g;

export function scanSource(source) {
  const found = [];
  for (const match of source.matchAll(SKIP_CALL)) {
    const raw = match[1];
    const rest = match[2] || "";
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      message = raw;
    }
    // An error is being formatted into the message: `, err)` or `, perr)`.
    const hasErrorArg = /%[vsw]/.test(message) && /\b\w*err\w*\b/i.test(rest);
    const kind = classifySkip(message, hasErrorArg);
    const line = source.slice(0, match.index).split("\n").length;
    found.push({ line, message, kind });
  }
  return found;
}

// Files known to contain fixture-shaped skips, and permitted to keep them for
// now. This list may only SHRINK. A new entry means a new way for a suite to be
// green over code it never ran.
//
// IT IS NOW EMPTY. It began at 90 files and 407 skips. Emptying it was not
// bookkeeping: the conversions surfaced eight real production bugs and three
// migrations that were never applied, because a test that skips when its own
// setup fails reports PASS — and reports it precisely when the schema has moved
// under the feature. Adding an entry here is a regression, not a TODO.
const KNOWN_FIXTURE_SKIPS = new Set([
]);

// A floor, so this cannot pass by finding nothing. If the scan silently stopped
// matching — a regex typo, a moved directory — reporting "no fixture skips
// anywhere" is the same false green this check exists to prevent.
const MIN_TEST_FILES = 300;

function selfTest() {
  const cases = [
    ["DATABASE_URL not set; skipping", false, "environment"],
    ["skipping in short mode", false, "environment"],
    ["tz database unavailable", false, "environment"],
    ["lists shape differs here: %v", true, "fixture"],
    ["seed campaign on list: %v", true, "fixture"],
    ["relation does not exist", false, "fixture"],
    // No marker at all, but an error is being formatted: still a failure.
    ["cannot proceed: %v", true, "fixture"],
    // No marker and no error: genuinely ambiguous, reported but not failed.
    ["nothing to do here", false, "unclear"],
    // Capability statements are environmental...
    ["no migration issues its own COMMIT; nothing to check", false, "environment"],
    ["automation_flows is not part of this service's schema", false, "environment"],
    // ...but only when they carry no error. This one is a failure in disguise.
    ["nothing to check: %v", true, "fixture"],
    // A DSN gate written in prose rather than as an identifier.
    ["admin database URL is required for reconciliation fixture", false, "environment"],
    ["superuser database URL is required for grandfathered-row fixture", false, "environment"],
  ];
  let failures = 0;
  for (const [message, hasErr, want] of cases) {
    const got = classifySkip(message, hasErr);
    if (got !== want) {
      console.error(`self-test: classify(${JSON.stringify(message)}) = ${got}, want ${want}`);
      failures++;
    }
  }
  // The scanner must actually find a skip, and must read its message.
  const src = `func TestX(t *testing.T) {\n\tt.Skipf("seed thing: %v", err)\n}\n`;
  const found = scanSource(src);
  if (found.length !== 1 || found[0].kind !== "fixture") {
    console.error(`self-test: scanSource found ${JSON.stringify(found)}`);
    failures++;
  }
  // And must NOT flag a legitimate environment gate.
  const env = `t.Skip("DATABASE_URL not set; skipping")`;
  const envFound = scanSource(env);
  if (envFound.length !== 1 || envFound[0].kind !== "environment") {
    console.error(`self-test: environment skip misclassified: ${JSON.stringify(envFound)}`);
    failures++;
  }
  if (failures > 0) {
    console.error(`test-skip-honesty self-test FAILED (${failures})`);
    process.exit(1);
  }
  console.log("check-test-skip-honesty self-test OK (15 assertions)");
}

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }
  const files = goTestFiles(SCAN_ROOT);
  if (files.length < MIN_TEST_FILES) {
    console.error(
      `Only ${files.length} Go test files found under ${relative(repoRoot, SCAN_ROOT)}, ` +
        `expected at least ${MIN_TEST_FILES}. The scan is not reaching the tree, and ` +
        `reporting a clean result over nothing is the failure this check exists to prevent.`,
    );
    process.exit(1);
  }

  const offenders = new Map();
  let fixtureSkips = 0;
  let environmentSkips = 0;
  for (const file of files) {
    const rel = relative(repoRoot, file);
    const found = scanSource(readFileSync(file, "utf8"));
    for (const skip of found) {
      if (skip.kind === "environment") {
        environmentSkips++;
        continue;
      }
      if (skip.kind !== "fixture") continue;
      fixtureSkips++;
      if (!offenders.has(rel)) offenders.set(rel, []);
      offenders.get(rel).push(skip);
    }
  }

  const newOffenders = [...offenders.keys()].filter((f) => !KNOWN_FIXTURE_SKIPS.has(f)).sort();
  const fixed = [...KNOWN_FIXTURE_SKIPS].filter((f) => !offenders.has(f)).sort();

  if (fixed.length > 0) {
    console.error(
      `These files no longer contain fixture-shaped skips and must be removed from ` +
        `KNOWN_FIXTURE_SKIPS, so the list keeps meaning what it says:\n  - ${fixed.join("\n  - ")}`,
    );
    process.exit(1);
  }

  if (newOffenders.length > 0) {
    console.error(
      `Fixture-shaped t.Skip in ${newOffenders.length} file(s) not on the known list.\n\n` +
        `A test that skips when its own setup fails reports PASS. The suite is then ` +
        `green over code it never executed — and green precisely when the schema has ` +
        `moved under the feature, which is when you needed it red.\n\n` +
        `Use t.Fatalf for a seed failure. The suite already skips wholesale when there ` +
        `is no DATABASE_URL, so reaching a failed INSERT means a database IS present ` +
        `and rejected what the feature writes.\n`,
    );
    for (const file of newOffenders) {
      for (const skip of offenders.get(file)) {
        console.error(`  ${file}:${skip.line}  ${JSON.stringify(skip.message)}`);
      }
    }
    process.exit(1);
  }

  console.log(
    `Test skip honesty OK: ${files.length} test files, ${environmentSkips} legitimate ` +
      `environment skips, ${fixtureSkips} fixture-shaped skips in ${offenders.size} ` +
      `known file(s) awaiting conversion.`,
  );
}

main();
