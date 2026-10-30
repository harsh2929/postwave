// audit-2026 session-replay-deeplink (UX, P1) — tests for the new
// view-mode helpers (timeline / heatmap / calendar projections).

import { describe, expect, it } from "vitest";

import type { AuditRow } from "../lib/api-client";
import {
  buildCalendar,
  computeHeatmapData,
  projectTimeline,
} from "../components/audit/auditViewModeHelpers";

const row = (id: number, atIso: string, action = "subscriber.delete"): AuditRow => ({
  id,
  action,
  actorType: "human",
  at: atIso,
});

describe("computeHeatmapData", () => {
  it("returns a zero matrix for empty input", () => {
    const { values, vMax, total } = computeHeatmapData([]);
    expect(total).toBe(0);
    expect(vMax).toBe(0);
    expect(values.length).toBe(7);
    expect(values[0].length).toBe(24);
    expect(values[0].every((v) => v === 0)).toBe(true);
  });

  it("buckets rows by UTC day-of-week and hour", () => {
    // 2026-06-04 is a Thursday → UTC dow = 4. Hour 12.
    const rows = [
      row(1, "2026-06-04T12:00:00Z"),
      row(2, "2026-06-04T12:30:00Z"),
      row(3, "2026-06-05T03:00:00Z"), // Friday 03:00 UTC
    ];
    const { values, vMax, total } = computeHeatmapData(rows);
    expect(total).toBe(3);
    expect(values[4][12]).toBe(2);
    expect(values[5][3]).toBe(1);
    expect(vMax).toBe(2);
  });

  it("skips rows with unparseable timestamps", () => {
    const { total } = computeHeatmapData([row(1, "not-a-date")]);
    expect(total).toBe(0);
  });
});

describe("projectTimeline", () => {
  it("returns an empty event list for empty input", () => {
    const { events } = projectTimeline([]);
    expect(events).toEqual([]);
  });

  it("assigns pos=0 to the earliest and pos=1 to the latest", () => {
    const rows = [
      row(1, "2026-06-04T00:00:00Z"),
      row(2, "2026-06-04T06:00:00Z"),
      row(3, "2026-06-04T12:00:00Z"),
    ];
    const { events, minMs, maxMs } = projectTimeline(rows);
    expect(events).toHaveLength(3);
    expect(events[0].pos).toBe(0);
    expect(events[2].pos).toBe(1);
    expect(events[1].pos).toBeCloseTo(0.5, 5);
    expect(minMs).toBe(new Date("2026-06-04T00:00:00Z").getTime());
    expect(maxMs).toBe(new Date("2026-06-04T12:00:00Z").getTime());
  });

  it("classifies severity per the AuditSeverity rules", () => {
    const rows = [
      row(1, "2026-06-04T00:00:00Z", "subscriber.delete"),
      row(2, "2026-06-04T01:00:00Z", "user.login"),
    ];
    const { events } = projectTimeline(rows);
    expect(events[0].severity).toBe("destructive");
    expect(events[1].severity).toBe("auth");
  });
});

describe("buildCalendar", () => {
  it("returns 42 cells (6×7 grid) for any month", () => {
    const { days } = buildCalendar([], new Date(Date.UTC(2026, 5, 1)));
    expect(days).toHaveLength(42);
  });

  it("marks cells outside the anchor month", () => {
    const anchor = new Date(Date.UTC(2026, 5, 1)); // June 2026
    const { days } = buildCalendar([], anchor);
    expect(days.some((d) => !d.inMonth)).toBe(true);
    expect(days.some((d) => d.inMonth)).toBe(true);
  });

  it("aggregates row counts into the right day cell", () => {
    const anchor = new Date(Date.UTC(2026, 5, 1));
    const rows = [
      row(1, "2026-06-04T12:00:00Z", "subscriber.delete"),
      row(2, "2026-06-04T14:00:00Z", "user.login"),
      row(3, "2026-06-05T03:00:00Z", "audit.read.export"),
    ];
    const { days } = buildCalendar(rows, anchor);
    const june4 = days.find((d) => d.date === "2026-06-04");
    const june5 = days.find((d) => d.date === "2026-06-05");
    expect(june4?.count).toBe(2);
    expect(june4?.mix.destructive).toBe(1);
    expect(june4?.mix.auth).toBe(1);
    expect(june5?.count).toBe(1);
    expect(june5?.mix.export).toBe(1);
  });
});
