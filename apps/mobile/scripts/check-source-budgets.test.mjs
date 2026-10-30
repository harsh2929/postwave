// Drives the real source-budget CLI, the way CI runs it (ci.yml and
// mobile-release.yml both call `pnpm quality:source-budgets`).
//
// The ratchet is only a ratchet if its values are EXACT. A ceiling left above
// the measured size is slack a later change can spend without failing the
// gate: settings.tsx had 151 lines of it, so a 151-line regression inside
// Settings() exited 0. These cases pin that a shrink is reported with the
// number to lower the allowance to, and that the committed file carries no
// slack today.
//
// Every fixture baseline below is derived from the tree's own measurement
// (`--print-baseline`) with ONE value changed, so each case expects exactly one
// error and a concurrent refactor elsewhere in the tree cannot turn it red.

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const appRoot = join(scriptsDir, "..");
const checker = join(scriptsDir, "check-source-budgets.mjs");
const committedPath = join(scriptsDir, "source-budgets.json");
// Each spawn parses every production file with the TypeScript compiler
// (~1.5 s alone; several times that while other suites share the CPUs).
const CASE_TIMEOUT_MS = 90_000;

function runChecker(...args) {
  const result = spawnSync(process.execPath, [checker, ...args], {
    cwd: appRoot,
    encoding: "utf8",
    timeout: CASE_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  return result;
}

/** The "- ..." lines the checker prints under its failure header. */
function reportedErrors(stderr) {
  return stderr
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

const scratchDirs = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

let measured;
let committed;

beforeAll(() => {
  const printed = runChecker("--print-baseline");
  expect(printed.status, printed.stderr).toBe(0);
  measured = JSON.parse(printed.stdout);
  committed = JSON.parse(readFileSync(committedPath, "utf8"));
}, CASE_TIMEOUT_MS);

/** Writes the measured baseline with `edit` applied and returns its path. */
function fixtureBaseline(edit) {
  const baseline = structuredClone(measured);
  edit(baseline);
  const dir = mkdtempSync(join(tmpdir(), "source-budgets-"));
  scratchDirs.push(dir);
  const path = join(dir, "source-budgets.json");
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
  return path;
}

function firstLegacyFile() {
  const [path] = Object.keys(measured.legacyFiles);
  if (path === undefined) {
    throw new Error(
      "no file carries a legacy line allowance any more; the legacyFiles cases have nothing to exercise",
    );
  }
  return { path, lines: measured.legacyFiles[path] };
}

/** A legacy-function entry that still carries debt, and a non-zero metric of it. */
function firstInDebtFunctionMetric() {
  for (const [path, debt] of Object.entries(measured.legacyFunctions)) {
    if (debt.longCount > 0)
      return { path, metric: "maxLines", value: debt.maxLines };
    if (debt.complexCount > 0) {
      return { path, metric: "maxComplexity", value: debt.maxComplexity };
    }
  }
  throw new Error(
    "no file carries legacy function debt any more; the legacyFunctions cases have nothing to exercise",
  );
}

/** A production route under every hard limit, with no legacy entry of its own. */
function cleanSmallFile() {
  for (const entry of readdirSync(join(appRoot, "app")).sort()) {
    if (!/\.tsx?$/u.test(entry) || /\.(?:test|spec)\./u.test(entry)) continue;
    const path = `app/${entry}`;
    const lines = readFileSync(join(appRoot, path), "utf8").split(
      /\r?\n/u,
    ).length;
    if (
      lines <= measured.hardLimits.fileLines &&
      !(path in measured.legacyFiles) &&
      !(path in measured.legacyFunctions)
    ) {
      return path;
    }
  }
  throw new Error("no clean top-level route file to use as a fixture");
}

describe("source-budget ratchet (scripts/check-source-budgets.mjs)", () => {
  it(
    "commits allowances equal to what the tree measures, with no slack to spend",
    () => {
      expect({
        legacyFiles: committed.legacyFiles,
        legacyFunctions: committed.legacyFunctions,
      }).toEqual({
        legacyFiles: measured.legacyFiles,
        legacyFunctions: measured.legacyFunctions,
      });
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "passes the committed baseline through the real CLI",
    () => {
      const result = runChecker();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/source budgets pass/u);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "reports a legacy file that shrank below its allowance with the number to lower it to",
    () => {
      const { path, lines } = firstLegacyFile();
      const baseline = fixtureBaseline((b) => {
        b.legacyFiles[path] = lines + 50;
      });

      const result = runChecker("--baseline", baseline);

      expect(result.status).toBe(1);
      const errors = reportedErrors(result.stderr);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(path);
      expect(errors[0]).toContain(`${lines + 50}-line allowance`);
      expect(errors[0]).toContain(`lower legacyFiles["${path}"] to ${lines}`);
      // The closing advice must never suggest raising a value or regenerating
      // the file (which writes actuals and would raise any file that grew).
      expect(result.stderr).toMatch(/never raise/u);
      expect(result.stderr).not.toMatch(/--print-baseline/u);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "reports a legacy function metric that fell with the number to lower it to",
    () => {
      const { path, metric, value } = firstInDebtFunctionMetric();
      const baseline = fixtureBaseline((b) => {
        b.legacyFunctions[path][metric] = value + 5;
      });

      const result = runChecker("--baseline", baseline);

      expect(result.status).toBe(1);
      const errors = reportedErrors(result.stderr);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(path);
      expect(errors[0]).toContain(
        `legacy function debt ${metric} fell from ${value + 5} to ${value}`,
      );
      expect(errors[0]).toContain(
        `lower legacyFunctions["${path}"].${metric} to ${value}`,
      );
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "still fails a legacy file that grew past its allowance",
    () => {
      const { path, lines } = firstLegacyFile();
      const baseline = fixtureBaseline((b) => {
        b.legacyFiles[path] = lines - 1;
      });

      const result = runChecker("--baseline", baseline);

      expect(result.status).toBe(1);
      expect(reportedErrors(result.stderr)).toEqual([
        `${path}: ${lines} lines exceeds its ${lines - 1}-line ceiling`,
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "still fails a legacy function metric that grew past its allowance",
    () => {
      const { path, metric, value } = firstInDebtFunctionMetric();
      const baseline = fixtureBaseline((b) => {
        b.legacyFunctions[path][metric] = value - 1;
      });

      const result = runChecker("--baseline", baseline);

      expect(result.status).toBe(1);
      expect(reportedErrors(result.stderr)).toEqual([
        `${path}: legacy function debt ${metric} increased from ${value - 1} to ${value}`,
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "tells a file back under the hard limit to drop its allowance, not to lower it",
    () => {
      const path = cleanSmallFile();
      const baseline = fixtureBaseline((b) => {
        b.legacyFiles[path] = 900;
      });

      const result = runChecker("--baseline", baseline);

      expect(result.status).toBe(1);
      expect(reportedErrors(result.stderr)).toEqual([
        `${path}: stale legacy file allowance; remove it from source-budgets.json`,
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "tells a file whose function debt is paid off to drop its entry, not to lower each metric",
    () => {
      const path = cleanSmallFile();
      const baseline = fixtureBaseline((b) => {
        b.legacyFunctions[path] = {
          longCount: 1,
          lineExcess: 10,
          maxLines: 310,
          complexCount: 1,
          complexityExcess: 2,
          maxComplexity: 27,
        };
      });

      const result = runChecker("--baseline", baseline);

      expect(result.status).toBe(1);
      expect(reportedErrors(result.stderr)).toEqual([
        `${path}: function debt is now clean; remove its legacy allowance`,
      ]);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "refuses --baseline without a path instead of checking the default file",
    () => {
      const result = runChecker("--baseline");

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/--baseline <path>/u);
    },
    CASE_TIMEOUT_MS,
  );
});
