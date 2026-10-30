import { describe, expect, it, vi } from "vitest";

import { nextBestSendOccurrence, parseBestHourUTC } from "./sendTime";

vi.mock("./request", () => ({ rawRequest: vi.fn() }));

describe("send-time recommendation contract", () => {
  it("parses the backend HH:00 UTC field", () => {
    expect(parseBestHourUTC("14:00")).toBe(14);
    expect(parseBestHourUTC("24:00")).toBeNull();
    expect(parseBestHourUTC("2:00")).toBeNull();
  });

  it("schedules the next occurrence of the recommended UTC hour", () => {
    const recommendation = {
      best_hour_utc: "14:00",
      computed_at: "2026-07-10T00:00:00Z",
    };
    expect(
      nextBestSendOccurrence(
        recommendation,
        new Date("2026-07-10T13:15:00Z"),
      ),
    ).toBe("2026-07-10T14:00:00.000Z");
    expect(
      nextBestSendOccurrence(
        recommendation,
        new Date("2026-07-10T14:15:00Z"),
      ),
    ).toBe("2026-07-11T14:00:00.000Z");
  });
});
