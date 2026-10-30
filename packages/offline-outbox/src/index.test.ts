import { describe, it, expect } from "vitest";

import {
  OUTBOX_MAX_ATTEMPTS,
  isDeadLetter,
  isTerminalStatus,
  type OfflineReplayStatus,
} from "./index.js";

describe("isTerminalStatus", () => {
  it("parks conflict + dead-letter, keeps everything else resumable", () => {
    expect(isTerminalStatus("conflict")).toBe(true);
    expect(isTerminalStatus("dead-letter")).toBe(true);
    // `failed` is transient — retries on later drains (matches both drains).
    expect(isTerminalStatus("failed")).toBe(false);
    expect(isTerminalStatus("pending")).toBe(false);
    expect(isTerminalStatus("replaying")).toBe(false);
  });
});

describe("isDeadLetter", () => {
  it("is true for an explicitly dead-lettered item", () => {
    expect(isDeadLetter({ status: "dead-letter", attempts: 0 })).toBe(true);
  });
  it("is true for a failed item at/over the attempt budget", () => {
    expect(isDeadLetter({ status: "failed", attempts: OUTBOX_MAX_ATTEMPTS })).toBe(true);
    expect(isDeadLetter({ status: "failed", attempts: OUTBOX_MAX_ATTEMPTS + 3 })).toBe(true);
  });
  it("is false for a failed item under budget (still retryable)", () => {
    expect(isDeadLetter({ status: "failed", attempts: OUTBOX_MAX_ATTEMPTS - 1 })).toBe(false);
  });
  it("is false for non-terminal statuses", () => {
    for (const s of ["pending", "replaying", "conflict"] as OfflineReplayStatus[]) {
      expect(isDeadLetter({ status: s, attempts: 99 })).toBe(false);
    }
  });
});

describe("contract", () => {
  it("pins the attempt budget both surfaces share", () => {
    expect(OUTBOX_MAX_ATTEMPTS).toBe(6);
  });
});
