// SPDX-License-Identifier: AGPL-3.0-only
//
// Per-resource FIFO invariant for the web offline outbox drain.
// Regression guard for the silent write-reordering bug: a conflict or
// failure on an item must STOP its resource bucket so later edits to the
// same resource never replay over the stuck one (matching desktop
// outbox.ts). Cross-bucket items still drain concurrently.

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OfflineMutation, OfflineReplayStatus } from "@/lib/offline-store";

// Mutable seed the mocked readOfflineQueue returns.
let QUEUE: OfflineMutation[] = [];

vi.mock("@/lib/offline-store", () => ({
  OFFLINE_QUEUE_CHANGED_EVENT: "postwave:offline-queue-changed",
  OUTBOX_MAX_ATTEMPTS: 6,
  readOfflineQueue: () => QUEUE,
  resourceOfPath: (p: string) => p.split("/")[1] ?? "misc",
  enqueueOfflineMutation: vi.fn(),
  removeOfflineMutation: vi.fn(),
  updateOfflineMutation: vi.fn(),
}));

import { drainOutbox } from "@/lib/outbox";
import { parseRetryAfter } from "@/lib/api";

function item(
  id: string,
  resource: string,
  status: OfflineReplayStatus = "pending",
  attempts = 0,
): OfflineMutation {
  return {
    id,
    method: "POST",
    path: `/${resource}/x`,
    idempotencyKey: id,
    queuedAt: "2026-01-01T00:00:00Z",
    attempts,
    status,
    resource,
  };
}

beforeEach(() => {
  QUEUE = [];
});

describe("drainOutbox per-resource FIFO", () => {
  it("stops a bucket on a fresh conflict — later same-resource edits are NOT replayed over it", async () => {
    QUEUE = [item("a", "campaigns"), item("b", "campaigns"), item("c", "campaigns")];
    const seen: string[] = [];
    await drainOutbox(async (it) => {
      seen.push(it.id);
      return it.id === "a" ? "conflict" : "replayed";
    });
    expect(seen).toEqual(["a"]); // b and c never attempted
  });

  it("stops a bucket on a fresh failure", async () => {
    QUEUE = [item("a", "subscribers"), item("b", "subscribers")];
    const seen: string[] = [];
    await drainOutbox(async (it) => {
      seen.push(it.id);
      return it.id === "a" ? "failed" : "replayed";
    });
    expect(seen).toEqual(["a"]);
  });

  it("keeps draining a bucket while items succeed", async () => {
    QUEUE = [item("a", "lists"), item("b", "lists"), item("c", "lists")];
    const seen: string[] = [];
    await drainOutbox(async (it) => {
      seen.push(it.id);
      return "replayed";
    });
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("drains independent buckets concurrently — a stuck bucket does not block others", async () => {
    QUEUE = [item("a", "campaigns"), item("b", "campaigns"), item("d", "subscribers")];
    const seen: string[] = [];
    await drainOutbox(async (it) => {
      seen.push(it.id);
      return it.id === "a" ? "conflict" : "replayed";
    });
    expect(seen).toContain("d"); // subscribers bucket drained
    expect(seen).not.toContain("b"); // campaigns bucket parked at the conflict
  });

  it("parks a bucket whose head is a pre-existing unresolved conflict", async () => {
    QUEUE = [item("x", "templates", "conflict"), item("y", "templates")];
    const seen: string[] = [];
    await drainOutbox(async (it) => {
      seen.push(it.id);
      return "replayed";
    });
    expect(seen).toEqual([]); // y not replayed over the parked conflict
  });

  it("skips a dead-letter head but still drains later items (dead-letter must not strand the bucket)", async () => {
    QUEUE = [item("z", "tags", "dead-letter"), item("w", "tags")];
    const seen: string[] = [];
    await drainOutbox(async (it) => {
      seen.push(it.id);
      return "replayed";
    });
    expect(seen).toEqual(["w"]);
  });

  it("RE-ATTEMPTS a pre-existing non-exhausted `failed` head (transient failure stays resumable; retry budget reachable)", async () => {
    // Regression guard: a prior-drain transient `failed` (attempts < MAX)
    // must be retried, not treated as a terminal park — else one transient
    // error permanently strands the bucket and the retry budget is unusable.
    QUEUE = [item("a", "campaigns", "failed", 2), item("b", "campaigns")];
    const seen: string[] = [];
    await drainOutbox(async (it) => {
      seen.push(it.id);
      return "replayed";
    });
    expect(seen).toEqual(["a", "b"]); // a retried + succeeds, then b proceeds
  });

  it("converts a `failed` + budget-exhausted head to dead-letter, then drains later items", async () => {
    // attempts >= OUTBOX_MAX_ATTEMPTS(6): abandoned, must not strand the
    // bucket, and must not be re-attempted.
    QUEUE = [item("a", "lists", "failed", 6), item("b", "lists")];
    const seen: string[] = [];
    await drainOutbox(async (it) => {
      seen.push(it.id);
      return "replayed";
    });
    expect(seen).toEqual(["b"]); // a not re-attempted; b still drains
  });
});

describe("parseRetryAfter (delta-seconds)", () => {
  it("parses a numeric Retry-After header into seconds", () => {
    expect(parseRetryAfter("120")).toBe(120);
  });
  it("prefers a positive body value over the header", () => {
    expect(parseRetryAfter("120", 30)).toBe(30);
  });
  it("returns a future HTTP-date as a positive delta", () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const secs = parseRetryAfter(future);
    expect(secs).toBeGreaterThan(0);
    expect(secs).toBeLessThanOrEqual(60);
  });
  it("returns undefined for missing/garbage/past", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});
