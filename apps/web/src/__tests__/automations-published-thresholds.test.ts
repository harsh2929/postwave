// SPDX-License-Identifier: AGPL-3.0-only
//
// /automations publishes operating thresholds as numbers: the holdout range,
// the churn bands and the lifecycle score range. Win-back dispatch is now
// rollout-held, so the page publishes stored evidence and the hold boundary,
// not dormant worker defaults. Each claim has exactly one source of truth in
// Go, and this guard keeps the marketing page on that boundary.
//
// One deliberate non-assertion: the page writes the lifecycle progression as
// "subscriber → lead → MQL → SQL → opportunity → customer → evangelist", seven
// stages, while lifecycle.AllStages has eight. The eighth is StageOther, an
// escape hatch rather than a step, and putting it in an arrow chain would
// misdescribe it. So the test checks the seven ordered stages are real and
// ordered, not that the page enumerates every constant.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");

const PAGE = readFileSync(
  join(SRC, "app/(marketing)/automations/page.tsx"),
  "utf8",
).replace(/\s+/g, " ");

function go(rel: string): string {
  return readFileSync(join(REPO, "apps/api/internal", rel), "utf8");
}

describe("automations published thresholds match the code", () => {
  it("states the holdout range the handler enforces", () => {
    const src = go("holdout/holdout.go");
    const m = /body\.Percent < (\d+) \|\| body\.Percent > (\d+)/.exec(src);
    expect(m, "holdout percent bounds not found").not.toBeNull();
    // The rejection message reaches the caller; it has to agree with the check.
    expect(src).toContain(`percent must be ${m![1]}..${m![2]}`);
    expect(PAGE).toContain(`${m![1]}–${m![2]}%`);
  });

  it("states the churn bands the fallback model produces", () => {
    const src = go("predictive/engagement_churn.go");
    const low = /EngagementChurnRecent\s*=\s*(0\.\d+)/.exec(src);
    const high = /EngagementChurnVeryHigh\s*=\s*(0\.\d+)/.exec(src);
    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    expect(Number(high![1])).toBeGreaterThan(Number(low![1]));
    expect(PAGE).toContain(`banded ${low![1]} → ${high![1]}`);
  });

  it("keeps dormant win-back thresholds behind the rollout hold", () => {
    const src = go("retention_offers/winback.go");
    const threshold = /defaultWinbackThreshold\s*=\s*(0?\.\d+|0\.\d+)/.exec(src);
    const cooldown = /defaultWinbackCooldownDays\s*=\s*(\d+)/.exec(src);
    expect(threshold, "win-back threshold not found").not.toBeNull();
    expect(cooldown, "win-back cooldown not found").not.toBeNull();
    expect(src).toMatch(/WinbackDispatchAvailable\s*=\s*false/);
    expect(PAGE).toContain("stored churn threshold");
    expect(PAGE).toContain("RETENTION_WINBACK_RELEASE_VERDICT");
    expect(PAGE).toContain("RETENTION_WINBACK_RELEASE_HOLD_CODE");
    expect(PAGE).toContain("no mounted worker currently selects or sends");
    expect(PAGE).not.toContain(`churn threshold (default ${threshold![1]})`);
    expect(PAGE).not.toContain(`${cooldown![1]}-day cooldown`);

    // The dormant implementation still carries both safety dependencies; they
    // are implementation evidence, not a production-delivery claim.
    expect(src).toMatch(/SuppressionChecker/);
    expect(src).toMatch(/consent/i);
  });

  it("states the lifecycle score range and a real stage progression", () => {
    const src = go("lifecycle/lifecycle.go");
    const bounds = /score < (\d+) \|\| score > (\d+)/.exec(src);
    expect(bounds, "lifecycle score bounds not found").not.toBeNull();
    expect(PAGE).toContain(`${bounds![1]}–${bounds![2]} stage score`);

    const ordered = [
      "subscriber",
      "lead",
      "mql",
      "sql",
      "opportunity",
      "customer",
      "evangelist",
    ];
    for (const stage of ordered) {
      expect(src, `Stage "${stage}" missing from lifecycle.go`).toContain(
        `Stage = "${stage}"`,
      );
    }
    // The arrow chain on the page must keep them in this order.
    const arrow = ordered.join(" → ").replace(/mql/, "MQL").replace(/sql/, "SQL");
    expect(PAGE).toContain(arrow);
  });
});
