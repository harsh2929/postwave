// SPDX-License-Identifier: AGPL-3.0-only
//
// /analytics publishes hard API limits as numbers — "up to 25 campaigns side
// by side in one call", "the trailing 12 cohorts", "default 12, up to 26".
// These are contract statements a developer builds against: too high and they
// get a 400 they did not plan for, too low and they paginate work that one
// call would have done.
//
// All three were correct when this was written. The guard exists because the
// limits live in two files that move for unrelated reasons — the 25 is an
// inline literal in an HTTP handler, the cohort window is a clamp inside the
// service — and neither has any reason to look at the marketing page.
//
// The page's "first N weeks since signup (default 12, up to 26)" mirrors the
// API's own parameter name: with bucket=month the `weeks` param actually
// counts trailing months. That naming is confusing, but the copy matches the
// contract a caller has to write, which is the thing that matters here.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");

const PAGE = readFileSync(
  join(SRC, "app/(marketing)/analytics/page.tsx"),
  "utf8",
).replace(/\s+/g, " ");

const HANDLERS = readFileSync(
  join(REPO, "apps/api/internal/analytics/handlers.go"),
  "utf8",
);
const SERVICE = readFileSync(
  join(REPO, "apps/api/internal/analytics/service.go"),
  "utf8",
);

/** The clamps inside Service.Cohorts. */
function cohortBounds(): { fallback: number; ceiling: number } {
  const body = /func \(s \*Service\) Cohorts\([\s\S]*?\n}/.exec(SERVICE)?.[0];
  expect(body, "Service.Cohorts not found").toBeDefined();
  const fallback = /weeks <= 0 \{\s*weeks = (\d+)/.exec(body!);
  const ceiling = /weeks > (\d+) \{/.exec(body!);
  expect(fallback, "no default clamp in Cohorts").not.toBeNull();
  expect(ceiling, "no ceiling clamp in Cohorts").not.toBeNull();
  return { fallback: Number(fallback![1]), ceiling: Number(ceiling![1]) };
}

describe("published analytics limits match the API", () => {
  it("reads the bounds out of the service", () => {
    // Guard the guard: identical values would make the default/ceiling
    // distinction untestable.
    const { fallback, ceiling } = cohortBounds();
    expect(fallback).toBeGreaterThan(0);
    expect(ceiling).toBeGreaterThan(fallback);
  });

  it("states the campaign-comparison ceiling the handler enforces", () => {
    const m = /len\(ids\) > (\d+)/.exec(HANDLERS);
    expect(m, "compare id-count check not found").not.toBeNull();
    // The handler's own error string has to agree with its own check first —
    // they are written separately and only the message reaches the caller.
    expect(HANDLERS).toContain(`compare accepts up to ${m![1]} ids`);
    expect(PAGE).toContain(`up to ${m![1]} campaigns side by side`);
  });

  it("states the cohort default and ceiling", () => {
    const { fallback, ceiling } = cohortBounds();
    expect(PAGE).toContain(`trailing ${fallback} cohorts`);
    expect(PAGE).toContain(`default ${fallback}, up to ${ceiling}`);
  });

  it("names the same bounce buckets CategorizeBounce produces", () => {
    // Three buckets, and the order matters: "trap" is tested FIRST, so a 5xx
    // trap classifies as spam_trap rather than hard. The page says spam_trap
    // is "any bounce classification containing 'trap'", which only stays true
    // while that check comes first.
    const src = readFileSync(
      join(REPO, "apps/api/internal/analytics/devices.go"),
      "utf8",
    );
    const body = /func CategorizeBounce\([\s\S]*?\n}/.exec(src)?.[0] ?? "";
    expect(body).not.toBe("");
    const buckets = [...body.matchAll(/return "([a-z_]+)"/g)]
      .map((m) => m[1]!)
      .filter((b) => b !== "");
    expect(new Set(buckets).size).toBe(3); // guard the guard
    for (const bucket of new Set(buckets)) {
      expect(PAGE, `page omits the ${bucket} bucket`).toContain(bucket);
    }
    // trap must be resolved before the 4xx/5xx prefixes.
    expect(body.indexOf('"spam_trap"')).toBeLessThan(body.indexOf('"hard"'));
  });

  it("names the goal metrics and cadences the API accepts", () => {
    const src = readFileSync(
      join(REPO, "apps/api/internal/goals/goals.go"),
      "utf8",
    );
    const metrics = /ErrInvalidMetric[^"]*"goals: metric must be ([a-z_|]+)"/.exec(
      src,
    );
    const periods = /ErrInvalidPeriod[^"]*"goals: period must be ([a-z|]+)"/.exec(
      src,
    );
    expect(metrics, "metric error message not found").not.toBeNull();
    expect(periods, "period error message not found").not.toBeNull();
    // The error strings and the validity maps have to agree first.
    for (const m of metrics![1]!.split("|")) {
      expect(src, `validGoalMetrics missing ${m}`).toContain(`"${m}": true`);
    }
    for (const p of periods![1]!.split("|")) {
      expect(src, `validPeriods missing ${p}`).toContain(`"${p}": true`);
      expect(PAGE, `page omits the ${p} cadence`).toContain(p);
    }
    // revenue_cents is published as plain "revenue"; count the metrics rather
    // than matching an internal column name to prose.
    expect(metrics![1]!.split("|").length).toBe(4);
    for (const word of ["subscriber count", "open rate", "revenue", "list growth"]) {
      expect(PAGE, `page omits ${word}`).toContain(word);
    }
  });

  it("states the rolling windows the stats tool accepts", () => {
    const tools = readFileSync(
      join(REPO, "apps/api/internal/mcp/tools.go"),
      "utf8",
    );
    // Anchor on the "Rolling window" description. The first `"enum":
    // []string{…}` in this file belongs to a template-kind filter
    // ({editable, reference}) — matching it found two values and reported the
    // window enum as wrong.
    const enumBlock =
      /"description":\s*"Rolling window[^"]*",\s*"enum":\s*\[\]string\{([^}]*)\}/.exec(
        tools,
      );
    expect(enumBlock, "rolling-window enum not found").not.toBeNull();
    const windows = [...enumBlock![1]!.matchAll(/"([0-9a-z]+)"/g)].map((m) => m[1]!);
    expect(windows.length).toBe(3);
    // The handler's switch must accept exactly what the schema advertises,
    // or an agent picks a documented value and gets "invalid window".
    const handlers = readFileSync(
      join(REPO, "apps/api/internal/mcp/handlers_tools.go"),
      "utf8",
    );
    for (const w of windows) {
      expect(handlers, `handler rejects ${w}`).toContain(`"${w}"`);
    }
    expect(PAGE).toContain(windows.join(" / "));
  });
});
