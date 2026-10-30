// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO = resolve(process.cwd(), "../..");
const PAGE = readFileSync(
  resolve(
    process.cwd(),
    "src/app/(dashboard)/app/campaigns/[id]/ab/campaign-ab-client.tsx",
  ),
  "utf8",
);
const HANDLERS = readFileSync(
  join(REPO, "apps/api/internal/abtests/handlers.go"),
  "utf8",
);
const QUALIFICATION = readFileSync(
  join(REPO, "packages/runtime/campaigndispatch/qualification.go"),
  "utf8",
);

describe("campaign A/B delivery boundary", () => {
  it("keeps scheduler-dependent rollout and bandit controls out of the web UI", () => {
    expect(QUALIFICATION).toContain("SchedulingQualified = false");
    expect(PAGE).toContain("CAMPAIGN_AB_ROLLOUT_RELEASE_HOLD");
    expect(PAGE).toContain("Fixed, full-audience experiment only");
    for (const control of [
      'id="samplepct"',
      'id="winnerpct"',
      'id="strategy"',
      'id="explorefloor"',
      'id="recompute"',
    ]) {
      expect(PAGE).not.toContain(control);
    }
  });

  it("persists the only delivery settings this web surface can represent honestly", () => {
    expect(PAGE).toContain("winner_recipients_pct: 0");
    expect(PAGE).toContain("sample_pct: 100");
    expect(PAGE).toContain('bandit_strategy: "fixed"');
    expect(HANDLERS).toContain("settings.SamplePct < 100");
  });

  it("keeps manual evaluation record-only", () => {
    expect(PAGE).toContain("It does not send messages or create a rollout");
    expect(PAGE).toContain("Evaluation records statistical evidence only");
    expect(PAGE).not.toContain("a new rollout send is created automatically");
    expect(PAGE).not.toContain("Evaluating a winner sends");
  });

  it("does not present a retained rollout id as proof of delivery", () => {
    expect(PAGE).toContain("Historical rollout record");
    expect(PAGE).toContain("does not prove");
    expect(PAGE).not.toContain("The winning variant was sent");
  });

  it("keeps the remaining evaluation slider accessibly named", () => {
    expect(PAGE).toContain("aria-label={label}");
    expect(PAGE).not.toMatch(/<Label htmlFor=\{id\}>\{label\}<\/Label>/);
  });
});
