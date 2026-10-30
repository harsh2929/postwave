import { describe, expect, it } from "vitest";

import {
  describeOfflineExpiry,
  offlineQueueCounts,
  shortOperationId,
  statusTone,
} from "./offlineQueueView";

describe("offlineQueueCounts", () => {
  it("counts each status", () => {
    expect(
      offlineQueueCounts([
        { status: "queued" },
        { status: "queued" },
        { status: "syncing" },
        { status: "sent" },
      ]),
    ).toEqual({ queued: 2, syncing: 1, failed: 0, sent: 1 });
  });

  it("does not double-count a failure that is in the queue AND the journal", () => {
    const counts = offlineQueueCounts([{ status: "failed" }], 1);
    expect(counts.failed).toBe(1);
  });

  it("reports journalled failures that are no longer in the mutation cache", () => {
    // A failure survives an app restart in the vault long after the paused
    // mutation is gone; the summary must still admit it exists.
    expect(offlineQueueCounts([], 3).failed).toBe(3);
  });

  it("is zero for an empty queue", () => {
    expect(offlineQueueCounts([])).toEqual({
      queued: 0,
      syncing: 0,
      failed: 0,
      sent: 0,
    });
  });
});

describe("describeOfflineExpiry", () => {
  const now = 1_700_000_000_000;

  it("says plainly when a change will never be sent", () => {
    expect(describeOfflineExpiry(now - 1, now)).toContain("expired");
    expect(describeOfflineExpiry(now, now)).toContain("will not be sent");
  });

  it("rounds up so a live item never reads as zero minutes", () => {
    expect(describeOfflineExpiry(now + 1_000, now)).toBe("expires in 1m");
    expect(describeOfflineExpiry(now + 59_000, now)).toBe("expires in 1m");
  });

  it("switches to hours past the hour boundary", () => {
    expect(describeOfflineExpiry(now + 60 * 60_000, now)).toBe("expires in 1h");
    expect(describeOfflineExpiry(now + 95 * 60_000, now)).toBe(
      "expires in 1h 35m",
    );
  });

  it("treats a non-finite expiry as expired rather than rendering NaN", () => {
    expect(describeOfflineExpiry(Number.NaN, now)).toContain("expired");
  });
});

describe("shortOperationId", () => {
  it("keeps the tail support can match", () => {
    expect(shortOperationId("6f1a2b3c-4d5e-6f70-8899-aabbccddeeff")).toBe(
      "#ccddeeff",
    );
  });
});

describe("statusTone", () => {
  it("maps every status to a distinct enough tone", () => {
    expect(statusTone("failed")).toBe("danger");
    expect(statusTone("syncing")).toBe("info");
    expect(statusTone("sent")).toBe("success");
    expect(statusTone("queued")).toBe("warning");
  });
});
