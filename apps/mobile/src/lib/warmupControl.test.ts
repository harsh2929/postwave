import { describe, expect, it } from "vitest";

import {
  warmupControlFor,
  warmupControlLabel,
  warmupControlStatus,
  warmupPauseConsequence,
} from "./deliverabilityDiagnostics";

describe("warmupControlFor", () => {
  it("offers pause for an active ramp and resume for a paused one", () => {
    expect(warmupControlFor({ status: "active" })).toBe("pause");
    expect(warmupControlFor({ status: "paused" })).toBe("resume");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(warmupControlFor({ status: " ACTIVE " })).toBe("pause");
  });

  it("offers nothing for a terminal plan", () => {
    // Re-activating a finished warm-up would silently restart a ramp somebody
    // deliberately ended.
    expect(warmupControlFor({ status: "completed" })).toBe("none");
    expect(warmupControlFor({ status: "cancelled" })).toBe("none");
  });

  it("offers nothing for a status it does not recognise", () => {
    // An unknown status from a newer server must not be guessed at.
    expect(warmupControlFor({ status: "" })).toBe("none");
    expect(warmupControlFor({ status: "throttled" })).toBe("none");
  });
});

describe("warmupControlStatus", () => {
  it("maps each control to the value the server accepts", () => {
    expect(warmupControlStatus("pause")).toBe("paused");
    expect(warmupControlStatus("resume")).toBe("active");
    expect(warmupControlStatus("none")).toBeNull();
  });

  it("never emits completed or cancelled", () => {
    // Terminal transitions are deliberately unreachable from this platform.
    for (const c of ["pause", "resume", "none"] as const) {
      const v = warmupControlStatus(c);
      expect(v).not.toBe("completed");
      expect(v).not.toBe("cancelled");
    }
  });
});

describe("warmupControlLabel", () => {
  it("names both directions and stays silent otherwise", () => {
    expect(warmupControlLabel("pause")).toBe("Pause ramp");
    expect(warmupControlLabel("resume")).toBe("Resume ramp");
    expect(warmupControlLabel("none")).toBeNull();
  });
});

describe("warmupPauseConsequence", () => {
  it("names the daily target, not just 'it stops'", () => {
    const s = warmupPauseConsequence({ domain: "mail.example.com", targetDaily: 50000 });
    expect(s).toContain("mail.example.com");
    expect(s).toContain("50000");
  });

  it("says sending continues, because a pause is not a stop", () => {
    // Somebody who thinks they have frozen a counter will otherwise be
    // surprised by throttling.
    expect(
      warmupPauseConsequence({ domain: "d", targetDaily: 1 }),
    ).toContain("Sending is not stopped");
  });
});
