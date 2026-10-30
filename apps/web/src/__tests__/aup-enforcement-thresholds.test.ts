// SPDX-License-Identifier: AGPL-3.0-only
//
// The AUP's enforcement ladder states spam-complaint thresholds as numbers,
// and campaigns/compliance.go is the only thing that acts on them.
//
// The published ladder had "soft warning, first complaint-rate excursion above
// 0.3%". 0.30% is not where we warn — it is where applyComplaintPolicy calls
// addBlocker and the send is refused. The warning line is 0.10%, which the
// policy never mentioned. So a customer reading the AUP expected an email and
// a banner at the exact rate that actually stops their send.
//
// The two thresholds are not measured the same way and the copy has to keep
// them distinct: block triggers on ANY single day in the trailing 7, warn on
// the window AGGREGATE, and days under complaintMinDailySends are skipped
// entirely so one complaint from a small test send cannot gate an account.
//
// eqscore/reputation.go carries the same pair independently
// (complaintRateWarn / complaintRateFail); it is checked here too, because two
// packages disagreeing about the ceiling would make the published number true
// of one code path and false of the other.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(process.cwd(), "src");
const REPO = resolve(process.cwd(), "../..");

const AUP = readFileSync(
  join(SRC, "app/(marketing)/legal/aup/page.tsx"),
  "utf8",
).replace(/\s+/g, " "); // prettier wraps JSX prose across lines

const COMPLIANCE = readFileSync(
  join(REPO, "apps/api/internal/campaigns/compliance.go"),
  "utf8",
);

function pct(name: string): string {
  const m = new RegExp(`${name}\\s*=\\s*([\\d.]+)`).exec(COMPLIANCE);
  expect(m, `${name} not found in compliance.go`).not.toBeNull();
  return Number(m![1]).toFixed(2);
}

describe("AUP enforcement thresholds match the gate", () => {
  it("reads both thresholds", () => {
    // Guard the guard: identical values would make the warn/block distinction
    // untestable, and a missing constant would make every check vacuous.
    expect(pct("complaintHarmPct")).toBe("0.10");
    expect(pct("complaintCeilingPct")).toBe("0.30");
    expect(pct("complaintHarmPct")).not.toBe(pct("complaintCeilingPct"));
  });

  it("publishes the warning line, not the ceiling, as the warning", () => {
    expect(AUP).toContain(`at or above ${pct("complaintHarmPct")}%`);
  });

  it("publishes the ceiling as the point sending is blocked", () => {
    const ceiling = pct("complaintCeilingPct");
    expect(AUP).toContain(`at or above ${ceiling}%`);
    // The ceiling must be described as a block, not a warning — the original
    // defect was exactly this mislabelling.
    expect(AUP).toMatch(
      new RegExp(`block[\\s\\S]{0,400}?${ceiling.replace(".", "\\.")}%`, "i"),
    );
  });

  it("states the small-send floor that keeps a test from tripping it", () => {
    const m = /complaintMinDailySends\s*=\s*(\d+)/.exec(COMPLIANCE);
    expect(m).not.toBeNull();
    expect(AUP).toContain(`fewer than ${m![1]} sends`);
  });

  it("keeps the second implementation on the same numbers", () => {
    // eqscore scores reputation off its own copy of the pair. If these drift,
    // the published figure is true of one code path and false of the other.
    const eq = readFileSync(
      join(REPO, "apps/api/internal/eqscore/reputation.go"),
      "utf8",
    );
    const warn = /complaintRateWarn\s*=\s*([\d.]+)/.exec(eq);
    const fail = /complaintRateFail\s*=\s*([\d.]+)/.exec(eq);
    expect(warn).not.toBeNull();
    expect(fail).not.toBeNull();
    expect((Number(warn![1]) * 100).toFixed(2)).toBe(pct("complaintHarmPct"));
    expect((Number(fail![1]) * 100).toFixed(2)).toBe(pct("complaintCeilingPct"));
  });
});
