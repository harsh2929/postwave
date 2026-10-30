/**
 * lib/auditExportSchedules — the client mirror of
 * handlers/audit_export_schedules.go's validator and wire shapes.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_EXPORT_SCHEDULE_RECIPIENTS,
  buildExportScheduleBody,
  exportScheduleLine,
  parseAuditExportSchedules,
  splitRecipients,
  validateExportScheduleInput,
} from "./auditExportSchedules";

describe("parseAuditExportSchedules", () => {
  it("reads the {schedules} envelope and drops idless rows", () => {
    const rows = parseAuditExportSchedules({
      schedules: [
        {
          id: "s1",
          cadence: "weekly",
          recipients: ["a@b.co"],
          enabled: true,
          created_at: "2026-08-01T00:00:00Z",
        },
        { cadence: "monthly" },
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(["s1"]);
    expect(rows[0]?.recipients).toEqual(["a@b.co"]);
  });

  it("a malformed body is an empty list, never a throw", () => {
    expect(parseAuditExportSchedules(null)).toEqual([]);
  });

  it("treats a never-run schedule's zero time as absent", () => {
    const rows = parseAuditExportSchedules({
      schedules: [
        { id: "s1", cadence: "weekly", last_enqueued_at: "0001-01-01T00:00:00Z" },
      ],
    });
    expect(rows[0]?.lastEnqueuedAt).toBeNull();
  });
});

describe("recipient handling mirrors the server", () => {
  it("splits on commas and whitespace and dedupes case-insensitively", () => {
    expect(splitRecipients("a@b.co, B@c.co  a@B.CO;d@e.fo")).toEqual([
      "a@b.co",
      "B@c.co",
      "d@e.fo",
    ]);
  });

  it("requires at least one recipient and a real cadence", () => {
    expect(validateExportScheduleInput("weekly", "")).toContain(
      "At least one recipient email is required.",
    );
    expect(
      validateExportScheduleInput("daily", "a@b.co").some((e) =>
        e.includes("cadence"),
      ),
    ).toBe(true);
    expect(validateExportScheduleInput("monthly", "a@b.co")).toEqual([]);
  });

  it("caps the fan-out at the server's 20", () => {
    const many = Array.from({ length: 21 }, (_, i) => `r${i}@example.com`).join(
      ",",
    );
    expect(
      validateExportScheduleInput("weekly", many).some((e) =>
        e.includes(String(MAX_EXPORT_SCHEDULE_RECIPIENTS)),
      ),
    ).toBe(true);
  });

  it("names the address it refuses", () => {
    expect(validateExportScheduleInput("weekly", "not-an-email")).toContain(
      '"not-an-email" is not an email address.',
    );
  });
});

describe("buildExportScheduleBody", () => {
  it("is null for refused input, and the normalised body otherwise", () => {
    expect(buildExportScheduleBody("weekly", "")).toBeNull();
    expect(buildExportScheduleBody("weekly", "a@b.co, a@B.CO")).toEqual({
      cadence: "weekly",
      recipients: ["a@b.co"],
    });
  });
});

describe("exportScheduleLine", () => {
  it("says cadence, destination, and whether it has ever run", () => {
    const [row] = parseAuditExportSchedules({
      schedules: [
        { id: "s1", cadence: "weekly", recipients: ["a@b.co"], enabled: true },
      ],
    });
    expect(exportScheduleLine(row!)).toBe(
      "Weekly → a@b.co · has not run yet",
    );
  });

  it("says paused when the schedule is disabled", () => {
    const [row] = parseAuditExportSchedules({
      schedules: [
        {
          id: "s1",
          cadence: "monthly",
          recipients: ["a@b.co", "c@d.eu"],
          enabled: false,
          last_enqueued_at: "2026-08-01T00:00:00Z",
        },
      ],
    });
    expect(exportScheduleLine(row!)).toBe("Monthly → 2 recipients · paused");
  });
});
