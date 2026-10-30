// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { parseAssuranceRuns, runHealth } from "./campaignAssurance";

// The ops console is read during an incident, so the parser is fail-loud: an
// unexpected shape is an error, never a partially-rendered row. A row that
// silently drops a field would show an operator a run that looks healthier
// than it is.

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: "11111111-1111-4111-8111-111111111111",
    campaign_id: "22222222-2222-4222-8222-222222222222",
    run_id: "33333333-3333-4333-8333-333333333333",
    run_no: 4,
    trigger_kind: "explicit",
    profile: "full",
    state: "running",
    gate_decision: "pending",
    attempt_count: 1,
    max_attempts: 3,
    required_extraction_count: 8,
    terminal_extraction_count: 2,
    extraction_error_count: 0,
    blocking_finding_count: 0,
    cost_microunits: 1500,
    max_modeled_cost_microunits: 9000,
    created_at: "2026-08-14T10:00:00Z",
    updated_at: "2026-08-14T10:05:00Z",
    ...over,
  };
}

function body(rows: unknown[], extra: Record<string, unknown> = {}) {
  return { runs: rows, ...extra };
}

describe("parseAssuranceRuns", () => {
  it("accepts a well-formed page", () => {
    const result = parseAssuranceRuns(200, body([row()]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.run_id).toBe("33333333-3333-4333-8333-333333333333");
    expect(result.nextCursor).toBe("");
  });

  it("carries the pagination cursor so an operator can page without losing order", () => {
    const result = parseAssuranceRuns(200, body([row()], { next_cursor: "abc" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextCursor).toBe("abc");
  });

  it("rejects a non-200 rather than rendering an empty board", () => {
    expect(parseAssuranceRuns(503, body([])).ok).toBe(false);
  });

  // The anti-drift device: a field added server-side must fail here rather than
  // be silently ignored, because an ignored field is one the console will never
  // show and nobody will notice is missing.
  it("rejects an unknown field", () => {
    expect(parseAssuranceRuns(200, body([row({ surprise: 1 })])).ok).toBe(false);
  });

  it("rejects a missing required field", () => {
    const bad = row();
    delete bad.state;
    expect(parseAssuranceRuns(200, body([bad])).ok).toBe(false);
  });

  it("rejects a malformed identifier", () => {
    expect(parseAssuranceRuns(200, body([row({ run_id: "not-a-uuid" })])).ok).toBe(false);
  });

  it("rejects a malformed timestamp", () => {
    expect(parseAssuranceRuns(200, body([row({ created_at: "2026-13-01T00:00:00Z" })])).ok).toBe(false);
  });

  it("rejects a duplicated run so a paging bug cannot double-count", () => {
    expect(parseAssuranceRuns(200, body([row(), row()])).ok).toBe(false);
  });
});

// runHealth is what the operator actually reads. Each state below is a
// different action, so collapsing any two would send someone the wrong way.
describe("runHealth", () => {
  it("calls a blocked run blocked, not failed", () => {
    // A blocked run WORKED — assurance did its job and refused the send. The
    // action is to fix the campaign, not to investigate the platform.
    expect(runHealth(row({ state: "complete", gate_decision: "block", blocking_finding_count: 2 }) as never))
      .toBe("blocked");
  });

  it("calls an incomplete run incomplete, never passing", () => {
    // Evidence was unavailable. Reporting this as healthy is the exact failure
    // the whole programme exists to prevent.
    expect(runHealth(row({ state: "incomplete", gate_decision: "unavailable" }) as never))
      .toBe("incomplete");
  });

  it("flags a run that has burned its attempts", () => {
    expect(runHealth(row({ state: "failed", attempt_count: 3, max_attempts: 3 }) as never))
      .toBe("failed");
  });

  it("flags a run whose spend reached its frozen ceiling", () => {
    // The ceiling is reserved before the first provider call, so hitting it
    // means the run stopped for budget rather than for a verdict.
    expect(runHealth(row({ state: "running", cost_microunits: 9000, max_modeled_cost_microunits: 9000 }) as never))
      .toBe("at-cost-ceiling");
  });

  it("calls an ordinary running run running", () => {
    expect(runHealth(row() as never)).toBe("running");
  });

  it("calls a clean complete run complete", () => {
    expect(runHealth(row({ state: "complete", gate_decision: "pass" }) as never)).toBe("complete");
  });
});
