import { describe, expect, it } from "vitest";

import {
  KILL_SWITCH_REASON_MAX,
  killSwitchConfirmCopy,
  killSwitchReasonUsable,
  parseSendingControl,
  sendingControlSummary,
} from "./sendingKillSwitch";

describe("parseSendingControl", () => {
  it("reads the server's shape", () => {
    expect(
      parseSendingControl({
        paused: true,
        pause_reason: "wrong link in the footer",
        pause_changed_at: "2026-08-17T21:00:00Z",
        pause_changed_by: "ada@example.com",
        source: "tenant",
      }),
    ).toEqual({
      paused: true,
      reason: "wrong link in the footer",
      changedAt: "2026-08-17T21:00:00Z",
      changedBy: "ada@example.com",
      source: "tenant",
    });
  });

  it("treats anything that is not exactly true as NOT paused", () => {
    // Rendering a malformed field as "sending is halted" would have an operator
    // stand down in the middle of an incident. Fail toward "active".
    for (const value of ["true", 1, {}, [], null, undefined]) {
      expect(parseSendingControl({ paused: value }).paused).toBe(false);
    }
    expect(parseSendingControl(null).paused).toBe(false);
    expect(parseSendingControl(undefined).paused).toBe(false);
  });

  it("trims text fields and tolerates non-strings", () => {
    const parsed = parseSendingControl({
      paused: true,
      pause_reason: "  spaced  ",
      pause_changed_by: 42,
    });
    expect(parsed.reason).toBe("spaced");
    expect(parsed.changedBy).toBe("");
  });
});

describe("killSwitchReasonUsable", () => {
  it("requires a reason even though the server does not", () => {
    // pauseInput.Reason is optional server-side (AllowEmptyBody). A tenant-wide
    // halt with no note cannot be handed over to the next shift.
    expect(killSwitchReasonUsable("")).toBe(false);
    expect(killSwitchReasonUsable("   ")).toBe(false);
    expect(killSwitchReasonUsable("wrong link")).toBe(true);
  });

  it("bounds the reason", () => {
    expect(killSwitchReasonUsable("x".repeat(KILL_SWITCH_REASON_MAX))).toBe(true);
    expect(killSwitchReasonUsable("x".repeat(KILL_SWITCH_REASON_MAX + 1))).toBe(
      false,
    );
  });
});

describe("sendingControlSummary", () => {
  it("says sending is active when it is", () => {
    expect(
      sendingControlSummary({
        paused: false,
        reason: "",
        changedAt: "",
        changedBy: "",
        source: "tenant",
      }),
    ).toContain("active");
  });

  it("never claims in-flight sends were stopped", () => {
    // The flag gates FUTURE sends. Saying "stopped" would be a promise the API
    // does not make, and the operator would stop looking.
    const summary = sendingControlSummary({
      paused: true,
      reason: "bad link",
      changedAt: "",
      changedBy: "ada@example.com",
      source: "tenant",
    });
    expect(summary).toContain("held");
    expect(summary).toContain("may still deliver");
    expect(summary).toContain("ada@example.com");
    expect(summary).toContain("bad link");
  });

  it("reads cleanly when the server gave no actor or reason", () => {
    const summary = sendingControlSummary({
      paused: true,
      reason: "",
      changedAt: "",
      changedBy: "",
      source: "tenant",
    });
    expect(summary).not.toContain("undefined");
    expect(summary).not.toContain(" by .");
    expect(summary).toContain("held for the whole workspace");
  });
});

describe("killSwitchConfirmCopy", () => {
  it("warns that the blast radius is the whole workspace, not one campaign", () => {
    const copy = killSwitchConfirmCopy(false);
    expect(copy.body).toContain("entire workspace");
    expect(copy.body).toContain("not just this campaign");
    expect(copy.confirmLabel).toBe("Hold all sending");
  });

  it("says what resuming releases", () => {
    const copy = killSwitchConfirmCopy(true);
    expect(copy.title).toContain("Resume");
    expect(copy.body).toContain("queued while sending was held");
  });

  it("gives the two directions different confirm labels", () => {
    expect(killSwitchConfirmCopy(true).confirmLabel).not.toBe(
      killSwitchConfirmCopy(false).confirmLabel,
    );
  });
});
