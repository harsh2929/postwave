// AI sequence draft → canvas-step conversion. The voice service's
// POST /voice/sequences/draft returns emails with a relative
// `delay_hours`; accepting the draft expands each positive wait into a
// standalone delay node ahead of its email, renumbered 1..n.

import { describe, expect, it } from "vitest";

import {
  DRAFT_STEP_COUNT_MAX,
  draftStepsToCanvasSteps,
  formatDraftDelay,
} from "../../components/sequence/draft-steps";
import type { SequenceDraftStep } from "../../lib/api-client";

const step = (
  position: number,
  delay_hours: number,
  subject = `Email ${position}`,
): SequenceDraftStep => ({
  subject,
  body: `body ${position}`,
  delay_hours,
  position,
});

describe("draftStepsToCanvasSteps", () => {
  it("expands delay_hours into delay nodes ahead of each email", () => {
    const out = draftStepsToCanvasSteps([step(1, 0), step(2, 48), step(3, 3)]);
    expect(out.map((s) => s.type)).toEqual([
      "email",
      "delay",
      "email",
      "delay",
      "email",
    ]);
    expect(out.map((s) => s.position)).toEqual([1, 2, 3, 4, 5]);
    // 48h → 2 days; 3h stays hours.
    expect(out[1].delay).toEqual({ seconds: 48 * 3600, value: 2, unit: "days" });
    expect(out[3].delay).toEqual({ seconds: 3 * 3600, value: 3, unit: "hours" });
  });

  it("carries subject and body onto email nodes with delay_seconds 0", () => {
    const out = draftStepsToCanvasSteps([step(1, 0, "Welcome!")]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("email");
    expect(out[0].email).toEqual({
      subject: "Welcome!",
      body: "body 1",
      delay_seconds: 0,
    });
  });

  it("orders by draft position even when the LLM response array is shuffled", () => {
    const out = draftStepsToCanvasSteps([step(3, 24), step(1, 0), step(2, 24)]);
    expect(out.filter((s) => s.type === "email").map((s) => s.email?.subject)).toEqual([
      "Email 1",
      "Email 2",
      "Email 3",
    ]);
  });

  it("clamps negative / fractional delays instead of emitting junk nodes", () => {
    const out = draftStepsToCanvasSteps([step(1, -5), step(2, 0.4)]);
    // -5 → 0 (no delay node); 0.4 → rounds to 0 (no delay node).
    expect(out.map((s) => s.type)).toEqual(["email", "email"]);
  });

  it("returns an empty list for an empty draft", () => {
    expect(draftStepsToCanvasSteps([])).toEqual([]);
  });
});

describe("formatDraftDelay", () => {
  it("renders immediately / hours / whole days", () => {
    expect(formatDraftDelay(0)).toBe("Immediately");
    expect(formatDraftDelay(1)).toBe("Wait 1 hour");
    expect(formatDraftDelay(36)).toBe("Wait 36 hours");
    expect(formatDraftDelay(24)).toBe("Wait 1 day");
    expect(formatDraftDelay(72)).toBe("Wait 3 days");
    expect(formatDraftDelay(-4)).toBe("Immediately");
  });
});

describe("DRAFT_STEP_COUNT_MAX", () => {
  it("mirrors the server cap (generation.DraftStepCountMax)", () => {
    expect(DRAFT_STEP_COUNT_MAX).toBe(10);
  });
});
