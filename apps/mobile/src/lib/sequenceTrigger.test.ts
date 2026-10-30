import { describe, expect, it } from "vitest";

import {
  goalSummary,
  stuckThresholdSummary,
  triggerSummary,
} from "./sequenceTrigger";

describe("triggerSummary", () => {
  it("distinguishes 'the field was absent' from 'no trigger is set'", () => {
    // The Voice service does not persist `trigger` yet, so an absent field
    // says NOTHING about tenant state. Reporting it as "nothing enrolls into
    // this journey" would be a manufactured negative claim.
    const absent = triggerSummary(undefined);
    expect(absent).toMatchObject({ known: false, incomplete: false });
    expect(absent.label).toBe("Entry trigger not reported");
    expect(absent.detail).toContain("can't say");

    const empty = triggerSummary(null);
    expect(empty).toMatchObject({
      label: "No entry trigger",
      incomplete: true,
      known: true,
    });
  });

  it("names each stored kind with its configured value", () => {
    expect(triggerSummary({ kind: "list_subscribe", list_id: 42 })).toEqual({
      label: "When subscriber joins list",
      detail: "List #42",
      incomplete: false,
      known: true,
    });
    expect(
      triggerSummary({ kind: "custom_event", event_name: "checkout.completed" }),
    ).toEqual({
      label: "On custom event",
      detail: 'Event "checkout.completed"',
      incomplete: false,
      known: true,
    });
    expect(triggerSummary({ kind: "tag_removed", tag_name: "vip" })).toEqual({
      label: "When tag is removed",
      detail: 'Tag "vip"',
      incomplete: false,
      known: true,
    });
  });

  it("prefers a one-shot run_at over a cron for schedule triggers", () => {
    expect(
      triggerSummary({ kind: "schedule", run_at: "2026-08-01T09:00:00Z", cron: "0 9 * * *" }),
    ).toMatchObject({ detail: "Runs once at 2026-08-01T09:00:00Z" });
    expect(triggerSummary({ kind: "schedule", cron: "0 9 * * *" })).toMatchObject({
      detail: "Cron: 0 9 * * *",
    });
    expect(triggerSummary({ kind: "schedule" })).toMatchObject({
      incomplete: true,
    });
  });

  it("flags half-configured triggers instead of implying they are ready", () => {
    expect(triggerSummary({ kind: "list_subscribe" }).incomplete).toBe(true);
    expect(triggerSummary({ kind: "segment_match", segment_id: "  " }).incomplete).toBe(
      true,
    );
    // list_id: 0 is a real id-shaped value, not a blank.
    expect(triggerSummary({ kind: "list_subscribe", list_id: 0 })).toMatchObject({
      detail: "List #0",
      incomplete: false,
    });
  });

  it("reports an unknown kind as unknown rather than guessing a label", () => {
    const summary = triggerSummary({ kind: "webhook_received" });
    expect(summary.label).toBe("Unrecognised trigger");
    expect(summary.detail).toContain("webhook_received");
    expect(summary.incomplete).toBe(true);
  });
});

describe("goalSummary", () => {
  it("returns null when no goal is stored", () => {
    expect(goalSummary(null)).toBeNull();
    expect(goalSummary(undefined)).toBeNull();
  });

  it("discloses that conversion goals are stored but never evaluated", () => {
    expect(goalSummary({ kind: "conversion" })?.detail).toContain(
      "never evaluated",
    );
  });

  it("discloses that exit-on-goal cannot actually stop sends here", () => {
    expect(goalSummary({ kind: "click", exit_on_goal: true })?.detail).toContain(
      "not actually stopped",
    );
    expect(goalSummary({ kind: "click" })?.detail).not.toContain(
      "not actually stopped",
    );
  });

  it("labels an unrecognised goal kind honestly", () => {
    expect(goalSummary({ kind: "revenue" })?.label).toBe("Goal · unrecognised");
  });
});

describe("stuckThresholdSummary", () => {
  it("treats 0, negatives and non-numbers as disabled", () => {
    expect(stuckThresholdSummary(0)).toBe("Stuck detection off");
    expect(stuckThresholdSummary(-3)).toBe("Stuck detection off");
    expect(stuckThresholdSummary(undefined)).toBe("Stuck detection off");
    expect(stuckThresholdSummary(Number.NaN)).toBe("Stuck detection off");
  });

  it("singularises one day", () => {
    expect(stuckThresholdSummary(1)).toBe("Stuck after 1 day");
    expect(stuckThresholdSummary(7)).toBe("Stuck after 7 days");
    expect(stuckThresholdSummary(2.9)).toBe("Stuck after 2 days");
  });
});
