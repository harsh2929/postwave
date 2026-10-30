import { afterEach, describe, expect, it } from "vitest";

import {
  RESTART_REMINDER_MS,
  blockedRestartMessage,
  clearRestartReminder,
  deferRestartReminder,
  restartPromptCopy,
  restartReminderAt,
  restartReminderDue,
  restartSafetyLines,
  scanRestartSafety,
} from "./restartSafetyScan";

const EMPTY = { unsavedLabels: [], queue: [], activeTransfers: 0 };

afterEach(() => clearRestartReminder());

describe("scanRestartSafety", () => {
  it("is safe when nothing registered reports a risk", () => {
    const scan = scanRestartSafety(EMPTY);
    expect(scan).toEqual({ concerns: [], blocking: [], warnings: [], safe: true });
    expect(restartPromptCopy(scan)).toBeNull();
    expect(restartSafetyLines(scan)).toEqual([]);
  });

  it("blocks on a write that is on the wire and on an open share sheet", () => {
    const scan = scanRestartSafety({
      unsavedLabels: [],
      queue: [{ status: "syncing" }, { status: "syncing" }, { status: "sent" }],
      activeTransfers: 1,
    });
    expect(scan.safe).toBe(false);
    expect(scan.blocking.map((c) => c.label)).toEqual([
      "2 changes syncing right now",
      "1 share still open",
    ]);
    expect(scan.warnings).toEqual([]);
    // A blocked scan never reaches a confirm.
    expect(restartPromptCopy(scan)).toBeNull();
    expect(blockedRestartMessage(scan)).toBe(
      "2 changes syncing right now. A restart tears down the request mid-flight and this phone would never learn whether it landed. The update stays ready in Diagnostics.",
    );
  });

  it("warns, by name, about unsaved edits and not-yet-persisted queued changes", () => {
    const scan = scanRestartSafety({
      unsavedLabels: ["Workspace", " ", "API connection", "Webhook"],
      queue: [{ status: "queued" }, { status: "failed" }],
      activeTransfers: 0,
    });
    expect(scan.blocking).toEqual([]);
    expect(scan.warnings.map((c) => c.label)).toEqual([
      "Unsaved edits in Workspace, API connection and Webhook",
      "1 queued change not yet on the server",
    ]);
    expect(
      scanRestartSafety({ ...EMPTY, unsavedLabels: ["Workspace"] }).warnings[0]?.label,
    ).toBe("Unsaved edits in Workspace");
  });

  it("writes the confirm sheet from the warnings and offers the 4-hour deferral", () => {
    const scan = scanRestartSafety({ ...EMPTY, unsavedLabels: ["Workspace"], queue: [{ status: "queued" }] });
    const copy = restartPromptCopy(scan);
    expect(copy).toMatchObject({
      title: "Restart with work in progress?",
      confirmLabel: "Restart anyway",
      cancelLabel: "Remind me in 4 hours",
      destructive: true,
    });
    expect(copy?.message.split("\n")).toHaveLength(2);
    expect(copy?.message).toContain("Unsaved edits in Workspace — ");
    expect(copy?.consequence).toContain("may be lost");
  });

  it("lists blocking concerns before warnings on the diagnostics card", () => {
    const scan = scanRestartSafety({
      unsavedLabels: ["Workspace"],
      queue: [{ status: "syncing" }],
      activeTransfers: 0,
    });
    expect(restartSafetyLines(scan)).toEqual([
      "Blocking · 1 change syncing right now",
      "Review · Unsaved edits in Workspace",
    ]);
  });
});

describe("restart reminder", () => {
  it("comes due exactly four hours after a deferral and clears", () => {
    expect(restartReminderAt()).toBeNull();
    expect(restartReminderDue(1_000)).toBe(false);
    const at = deferRestartReminder(1_000);
    expect(at).toBe(1_000 + RESTART_REMINDER_MS);
    expect(restartReminderAt()).toBe(at);
    expect(restartReminderDue(at - 1)).toBe(false);
    expect(restartReminderDue(at)).toBe(true);
    clearRestartReminder();
    expect(restartReminderDue(at + 1)).toBe(false);
  });
});
