/**
 * The goal edit mirrors desktop's window rule exactly: with an event set the
 * window defaults to 24; clearing the event sends window 0. The patch is
 * null when nothing changed, so the Save button can stay honest.
 */
import { describe, expect, it } from "vitest";

import {
  campaignGoalDraft,
  campaignGoalPatch,
  goalEventProblem,
} from "./campaignGoal";

describe("campaignGoalDraft", () => {
  it("reads the saved goal, defaulting the window to 24", () => {
    expect(
      campaignGoalDraft({ goal_event: "checkout.complete", goal_window_hours: 168 }),
    ).toEqual({ event: "checkout.complete", windowHours: 168 });
    expect(campaignGoalDraft({})).toEqual({ event: "", windowHours: 24 });
    expect(
      campaignGoalDraft({ goal_event: "x", goal_window_hours: 999 }),
    ).toEqual({ event: "x", windowHours: 24 });
  });
});

describe("campaignGoalPatch", () => {
  const original = { event: "", windowHours: 24 };

  it("setting an event defaults the window to 24", () => {
    expect(
      campaignGoalPatch(original, { event: "signup", windowHours: 24 }),
    ).toEqual({ goal_event: "signup", goal_window_hours: 24 });
  });

  it("clearing the event sends window 0 — desktop's rule", () => {
    expect(
      campaignGoalPatch(
        { event: "signup", windowHours: 24 },
        { event: "", windowHours: 24 },
      ),
    ).toEqual({ goal_event: "", goal_window_hours: 0 });
  });

  it("no change → null, so the save stays disabled", () => {
    expect(campaignGoalPatch(original, { event: " ", windowHours: 24 })).toBeNull();
    expect(
      campaignGoalPatch(
        { event: "signup", windowHours: 168 },
        { event: "signup", windowHours: 168 },
      ),
    ).toBeNull();
  });

  it("a window change alone is a change", () => {
    expect(
      campaignGoalPatch(
        { event: "signup", windowHours: 24 },
        { event: "signup", windowHours: 168 },
      ),
    ).toEqual({ goal_event: "signup", goal_window_hours: 168 });
  });
});

describe("goalEventProblem", () => {
  it("blank is fine (no goal), spaces are not", () => {
    expect(goalEventProblem("")).toBeNull();
    expect(goalEventProblem("checkout.complete")).toBeNull();
    expect(goalEventProblem("two words")).toMatch(/no spaces/);
    expect(goalEventProblem("x".repeat(97))).toMatch(/96/);
  });
});
