// Tests for the outbox drain semantics (audit §3.2–§3.3):
//   - 'failed' is NOT terminal — drains retry failed items while
//     attempts < OUTBOX_MAX_ATTEMPTS, with jitter between attempts.
//   - Items at/over the budget go to dead-letter via moveToDeadLetter.
//   - Per-resource FIFO: a failure/conflict skips the REST of its
//     bucket for the drain; other buckets proceed independently.
//   - An unresolved 'conflict' from a PREVIOUS drain blocks its bucket
//     (FIFO until resolved); 'dead-letter' items are skipped over so an
//     abandoned item doesn't strand the bucket.
//   - reissueAsOverwrite re-issues at the item's ORIGINAL position.

import { webcrypto } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type OfflineMutation,
  OUTBOX_MAX_ATTEMPTS,
  clearOfflineStores,
  offlineQueueIdle,
  parkOfflineStores,
  readOfflineJournal,
  readOfflineQueue,
  setOfflineIdentity,
  updateOfflineMutation,
  writeOfflineQueue,
} from "../../lib/offline-store";
import {
  drainOutbox,
  completeOutboxItem,
  discardOutboxItem,
  effectiveReplayDelay,
  isTerminalStatus,
  moveToDeadLetter,
  reissueAsOverwrite,
  restoreOutboxItem,
} from "../../lib/outbox";

function queueItem(
  over: Partial<OfflineMutation> & { id: string },
): OfflineMutation {
  return {
    method: "PATCH",
    path: "/api/v1/forms/form_1",
    body: { name: "Edit" },
    idempotencyKey: `idem_${over.id}`,
    queuedAt: new Date().toISOString(),
    attempts: 0,
    status: "pending",
    ...over,
  };
}

describe("desktop outbox", () => {
  const storage = new Map<string, string>();

  beforeEach(async () => {
    storage.clear();
    const localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    };
    vi.stubGlobal("window", {
      localStorage,
      crypto: webcrypto as unknown as Crypto,
    });
    vi.stubGlobal("crypto", webcrypto as unknown as Crypto);
    // Node ≥24 ships a real navigator.locks — pin these tests to the
    // synchronous passthrough path (the lock guard has its own suite in
    // offline-store.test.ts).
    vi.stubGlobal("navigator", {});
    await clearOfflineStores();
    await setOfflineIdentity("test-user:test-tenant");
    await offlineQueueIdle();
  });

  afterEach(async () => {
    await clearOfflineStores();
    await offlineQueueIdle();
    vi.unstubAllGlobals();
  });

  it("treats 'failed' as retryable, not terminal", () => {
    expect(isTerminalStatus("failed")).toBe(false);
    expect(isTerminalStatus("pending")).toBe(false);
    expect(isTerminalStatus("replaying")).toBe(false);
    expect(isTerminalStatus("conflict")).toBe(true);
    expect(isTerminalStatus("dead-letter")).toBe(true);
  });

  it("retries a previously-failed item on the next drain", async () => {
    writeOfflineQueue([
      queueItem({
        id: "mut_1",
        status: "failed",
        attempts: 2,
        lastError: "HTTP 503",
      }),
    ]);

    const replay = vi.fn(async (item: OfflineMutation) => {
      updateOfflineMutation(item.id, {
        status: "replaying",
        attempts: item.attempts + 1,
      });
      // Simulate api-client success: item removed from the queue.
      writeOfflineQueue(readOfflineQueue().filter((it) => it.id !== item.id));
      return "replayed" as const;
    });

    const totals = await drainOutbox(replay, { retryDelay: () => 0 });

    expect(replay).toHaveBeenCalledTimes(1);
    expect(totals).toMatchObject({ replayed: 1, conflicts: 0, failed: 0 });
    expect(readOfflineQueue()).toEqual([]);
  });

  it("retries within a drain and dead-letters once the budget is burned", async () => {
    writeOfflineQueue([queueItem({ id: "mut_1" })]);

    // Mirror api-client's attempt accounting: bump attempts per call,
    // dead-letter at the budget, park as 'failed' below it.
    const replay = vi.fn(async (item: OfflineMutation) => {
      const nextAttempts = item.attempts + 1;
      updateOfflineMutation(item.id, {
        status: "replaying",
        attempts: nextAttempts,
      });
      if (nextAttempts >= OUTBOX_MAX_ATTEMPTS) {
        moveToDeadLetter(item.id, "Replay failed with HTTP 500.");
      } else {
        updateOfflineMutation(item.id, {
          status: "failed",
          lastError: "HTTP 500",
        });
      }
      return "failed" as const;
    });

    const totals = await drainOutbox(replay, { retryDelay: () => 0 });

    expect(replay).toHaveBeenCalledTimes(OUTBOX_MAX_ATTEMPTS);
    expect(totals.failed).toBe(1);
    expect(totals.dead).toBe(1);
    expect(readOfflineQueue()[0]?.status).toBe("dead-letter");
  });

  it("skips the rest of a resource bucket after a failure, but drains other buckets", async () => {
    writeOfflineQueue([
      queueItem({ id: "mut_form_1", path: "/api/v1/forms/form_1" }),
      queueItem({ id: "mut_form_2", path: "/api/v1/forms/form_2" }),
      queueItem({
        id: "mut_seg_1",
        path: "/api/v1/segments/seg_1",
        body: { name: "Segment edit" },
      }),
    ]);

    const replayed: string[] = [];
    const replay = vi.fn(async (item: OfflineMutation) => {
      replayed.push(item.id);
      if (item.id === "mut_form_1") {
        const nextAttempts = item.attempts + 1;
        updateOfflineMutation(item.id, { attempts: nextAttempts });
        if (nextAttempts >= OUTBOX_MAX_ATTEMPTS) {
          moveToDeadLetter(item.id, "HTTP 500");
        } else {
          updateOfflineMutation(item.id, {
            status: "failed",
            lastError: "HTTP 500",
          });
        }
        return "failed" as const;
      }
      writeOfflineQueue(readOfflineQueue().filter((it) => it.id !== item.id));
      return "replayed" as const;
    });

    const totals = await drainOutbox(replay, { retryDelay: () => 0 });

    // mut_form_2 must NOT replay over mut_form_1's failure; the
    // segments bucket drains independently.
    expect(replayed).not.toContain("mut_form_2");
    expect(replayed).toContain("mut_seg_1");
    expect(totals.replayed).toBe(1);
    expect(totals.failed).toBe(1);
    expect(
      readOfflineQueue().find((it) => it.id === "mut_form_2")?.status,
    ).toBe("pending");
  });

  it("skips the rest of a resource bucket after a conflict", async () => {
    writeOfflineQueue([
      queueItem({ id: "mut_form_1", path: "/api/v1/forms/form_1" }),
      queueItem({ id: "mut_form_2", path: "/api/v1/forms/form_2" }),
    ]);

    const replayed: string[] = [];
    const replay = vi.fn(async (item: OfflineMutation) => {
      replayed.push(item.id);
      updateOfflineMutation(item.id, { status: "conflict" });
      return "conflict" as const;
    });

    const totals = await drainOutbox(replay, { retryDelay: () => 0 });

    expect(replayed).toEqual(["mut_form_1"]);
    expect(totals.conflicts).toBe(1);
  });

  it("blocks a bucket behind an unresolved conflict from a previous drain", async () => {
    writeOfflineQueue([
      queueItem({
        id: "mut_form_conflict",
        path: "/api/v1/forms/form_1",
        status: "conflict",
        attempts: 1,
        lastError: "Server reported a write conflict (412).",
      }),
      queueItem({ id: "mut_form_2", path: "/api/v1/forms/form_2" }),
      queueItem({
        id: "mut_seg_1",
        path: "/api/v1/segments/seg_1",
        body: { name: "Segment edit" },
      }),
    ]);

    const replayed: string[] = [];
    const replay = vi.fn(async (item: OfflineMutation) => {
      replayed.push(item.id);
      writeOfflineQueue(readOfflineQueue().filter((it) => it.id !== item.id));
      return "replayed" as const;
    });

    await drainOutbox(replay, { retryDelay: () => 0 });

    // The later same-bucket edit must NOT replay over the unresolved
    // conflict (FIFO preserved until the user resolves it); other
    // buckets drain independently.
    expect(replayed).not.toContain("mut_form_2");
    expect(replayed).not.toContain("mut_form_conflict");
    expect(replayed).toContain("mut_seg_1");
    expect(
      readOfflineQueue().find((it) => it.id === "mut_form_2")?.status,
    ).toBe("pending");
    expect(
      readOfflineQueue().find((it) => it.id === "mut_form_conflict")?.status,
    ).toBe("conflict");
  });

  it("skips dead-letter items without stranding the rest of their bucket", async () => {
    writeOfflineQueue([
      queueItem({
        id: "mut_form_dead",
        path: "/api/v1/forms/form_1",
        status: "dead-letter",
        attempts: OUTBOX_MAX_ATTEMPTS,
        lastError: "Retry budget exhausted.",
      }),
      queueItem({ id: "mut_form_2", path: "/api/v1/forms/form_2" }),
    ]);

    const replayed: string[] = [];
    const replay = vi.fn(async (item: OfflineMutation) => {
      replayed.push(item.id);
      writeOfflineQueue(readOfflineQueue().filter((it) => it.id !== item.id));
      return "replayed" as const;
    });

    const totals = await drainOutbox(replay, { retryDelay: () => 0 });

    // The abandoned dead-letter item is skipped over — the later edit in
    // the same bucket still replays.
    expect(replayed).toEqual(["mut_form_2"]);
    expect(totals.replayed).toBe(1);
    expect(
      readOfflineQueue().find((it) => it.id === "mut_form_dead")?.status,
    ).toBe("dead-letter");
  });

  it("dead-letters items already at the budget without replaying them", async () => {
    writeOfflineQueue([
      queueItem({
        id: "mut_1",
        status: "failed",
        attempts: OUTBOX_MAX_ATTEMPTS,
        lastError: "HTTP 500",
      }),
    ]);

    const replay = vi.fn(async () => "replayed" as const);
    await drainOutbox(replay, { retryDelay: () => 0 });

    expect(replay).not.toHaveBeenCalled();
    expect(readOfflineQueue()[0]?.status).toBe("dead-letter");
  });

  it("drains the new subscriber + campaign-draft buckets independently", async () => {
    // Safe-write expansion: singleton subscriber PATCH and campaign
    // DRAFT PATCH are queueable; they bucket as `subscribers` and
    // `campaigns` so a failure in one never blocks the other.
    writeOfflineQueue([
      queueItem({
        id: "mut_sub_1",
        path: "/api/v1/subscribers/sub_1",
        body: { merge_fields: { name: "Ada" } },
      }),
      queueItem({
        id: "mut_cmp_1",
        path: "/api/v1/campaigns/cmp_1",
        body: { subject: "Draft v2" },
      }),
    ]);

    // Both survive sanitize as live pending items in their buckets.
    expect(readOfflineQueue()).toMatchObject([
      { id: "mut_sub_1", status: "pending", resource: "subscribers" },
      { id: "mut_cmp_1", status: "pending", resource: "campaigns" },
    ]);

    const replayed: string[] = [];
    const replay = vi.fn(async (item: OfflineMutation) => {
      replayed.push(item.id);
      if (item.id === "mut_sub_1") {
        updateOfflineMutation(item.id, { status: "conflict" });
        return "conflict" as const;
      }
      writeOfflineQueue(readOfflineQueue().filter((it) => it.id !== item.id));
      return "replayed" as const;
    });

    const totals = await drainOutbox(replay, { retryDelay: () => 0 });

    // The subscriber conflict does not block the campaigns bucket.
    expect(replayed).toContain("mut_cmp_1");
    expect(totals).toMatchObject({ replayed: 1, conflicts: 1 });
  });

  it("isolates subscriber FIFO by record so one conflict cannot park another subscriber", async () => {
    writeOfflineQueue([
      queueItem({
        id: "mut_sub_a_conflict",
        path: "/api/v1/subscribers/subscriber-a",
        body: { tags: ["needs-review"] },
        baseVersion: '"subscriber:subscriber-a:v1"',
      }),
      queueItem({
        id: "mut_sub_a_later",
        path: "/api/v1/subscribers/subscriber-a",
        body: { display_name: "Later A" },
        baseVersion: '"subscriber:subscriber-a:v1"',
      }),
      queueItem({
        id: "mut_sub_b",
        path: "/api/v1/subscribers/subscriber-b",
        body: { tags: ["safe"] },
        baseVersion: '"subscriber:subscriber-b:v1"',
      }),
    ]);

    const replayed: string[] = [];
    const replay = vi.fn(async (item: OfflineMutation) => {
      replayed.push(item.id);
      if (item.id === "mut_sub_a_conflict") {
        updateOfflineMutation(item.id, { status: "conflict" });
        return "conflict" as const;
      }
      completeOutboxItem(item.id);
      return "replayed" as const;
    });

    const totals = await drainOutbox(replay, { retryDelay: () => 0 });

    expect(replayed).toContain("mut_sub_a_conflict");
    expect(replayed).not.toContain("mut_sub_a_later");
    expect(replayed).toContain("mut_sub_b");
    expect(totals).toMatchObject({ replayed: 1, conflicts: 1 });
  });

  it("hands a successful subscriber ETag to the next same-record edit", async () => {
    writeOfflineQueue([
      queueItem({
        id: "mut_sub_1",
        path: "/api/v1/subscribers/subscriber-1",
        body: { tags: ["first"] },
        headers: { "if-match": '"subscriber:subscriber-1:v1"' },
        baseVersion: '"subscriber:subscriber-1:v1"',
      }),
      queueItem({
        id: "mut_sub_2",
        path: "/api/v1/subscribers/subscriber-1",
        body: { display_name: "Second" },
        headers: { "if-match": '"subscriber:subscriber-1:v1"' },
        baseVersion: '"subscriber:subscriber-1:v1"',
      }),
    ]);

    const observedVersions: string[] = [];
    const replay = vi.fn(async (item: OfflineMutation) => {
      observedVersions.push(item.baseVersion ?? "");
      completeOutboxItem(
        item.id,
        item.id === "mut_sub_1"
          ? '"subscriber:subscriber-1:v2"'
          : '"subscriber:subscriber-1:v3"',
      );
      return "replayed" as const;
    });

    const totals = await drainOutbox(replay, { retryDelay: () => 0 });

    expect(observedVersions).toEqual([
      '"subscriber:subscriber-1:v1"',
      '"subscriber:subscriber-1:v2"',
    ]);
    expect(totals).toMatchObject({ replayed: 2, conflicts: 0, failed: 0 });
    expect(readOfflineQueue()).toEqual([]);
  });

  it("persists completion and successor rebasing in one crash-recoverable snapshot", async () => {
    writeOfflineQueue([
      queueItem({
        id: "mut_sub_persisted_1",
        path: "/api/v1/subscribers/subscriber-1",
        body: { tags: ["first"] },
        headers: { "if-match": '"subscriber:subscriber-1:v1"' },
        baseVersion: '"subscriber:subscriber-1:v1"',
      }),
      queueItem({
        id: "mut_sub_persisted_2",
        path: "/api/v1/subscribers/subscriber-1",
        body: { display_name: "Second" },
        headers: { "if-match": '"subscriber:subscriber-1:v1"' },
        baseVersion: '"subscriber:subscriber-1:v1"',
      }),
    ]);

    completeOutboxItem("mut_sub_persisted_1", '"subscriber:subscriber-1:v2"');
    await offlineQueueIdle();
    await parkOfflineStores();
    await setOfflineIdentity("test-user:test-tenant");
    await offlineQueueIdle();

    expect(readOfflineQueue()).toEqual([
      expect.objectContaining({
        id: "mut_sub_persisted_2",
        headers: { "if-match": '"subscriber:subscriber-1:v2"' },
        baseVersion: '"subscriber:subscriber-1:v2"',
      }),
    ]);
    expect(readOfflineJournal()).toEqual([
      expect.objectContaining({
        id: "mut_sub_persisted_1",
        status: "synced",
      }),
    ]);
  });

  it("never lets a send-like campaign mutation into a drain", async () => {
    // Defense in depth: even if a send-like PATCH lands in storage, the
    // sanitizer quarantines it (status failed + body stripped) so the
    // drain skips its bucket instead of replaying a send.
    writeOfflineQueue([
      queueItem({
        id: "mut_cmp_send",
        path: "/api/v1/campaigns/cmp_1",
        body: { status: "sending" },
      }),
    ]);

    const [item] = readOfflineQueue();
    expect(item).toMatchObject({ id: "mut_cmp_send", status: "failed" });
    expect(item?.body).toBeUndefined();
  });

  it("reissueAsOverwrite keeps the item at its original queue position", () => {
    writeOfflineQueue([
      queueItem({
        id: "mut_old",
        status: "conflict",
        attempts: 3,
        headers: { "if-match": "rev-1" },
        baseVersion: "rev-1",
        lastError: "Server reported a write conflict (412).",
      }),
      queueItem({ id: "mut_newer", path: "/api/v1/forms/form_2" }),
    ]);

    const next = reissueAsOverwrite("mut_old");

    expect(next).not.toBeNull();
    const queue = readOfflineQueue();
    // Original position preserved — the newer edit still replays AFTER
    // the overwrite, so the overwrite can't clobber it.
    expect(queue[0]?.id).toBe("mut_old");
    expect(queue[1]?.id).toBe("mut_newer");
    expect(queue[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      baseVersion: "*",
      idempotencyKey: "idem_mut_old",
    });
    expect(queue[0]?.headers).toEqual({ "if-match": "*" });
    expect(queue[0]?.lastError).toBeUndefined();
  });

  it("retains non-sensitive synced/discarded outcomes and supports undo", async () => {
    const synced = queueItem({
      id: "mut_synced",
      actionLabel: "Update form",
      recordLabel: "Newsletter",
    });
    const discarded = queueItem({
      id: "mut_discarded",
      path: "/api/v1/tags/tag_1",
      actionLabel: "Update tag",
      recordLabel: "VIP",
    });
    writeOfflineQueue([synced, discarded]);

    completeOutboxItem(synced.id);
    discardOutboxItem(discarded.id);
    await offlineQueueIdle();

    expect(readOfflineQueue()).toEqual([]);
    expect(readOfflineJournal()).toEqual([
      expect.objectContaining({ id: "mut_discarded", status: "discarded" }),
      expect.objectContaining({ id: "mut_synced", status: "synced" }),
    ]);
    expect(JSON.stringify(readOfflineJournal())).not.toContain("body");

    restoreOutboxItem(discarded);
    expect(readOfflineQueue()).toEqual([
      expect.objectContaining({ id: "mut_discarded", status: "pending" }),
    ]);
    expect(
      readOfflineJournal().some((entry) => entry.id === discarded.id),
    ).toBe(false);
  });
});

describe("effectiveReplayDelay (Retry-After honoring)", () => {
  const CAP = 10_000; // MAX_BACKOFF_MS in outbox.ts

  it("returns the jitter when there's no Retry-After", () => {
    expect(effectiveReplayDelay(450)).toBe(450);
    expect(effectiveReplayDelay(450, undefined)).toBe(450);
  });

  it("treats 0/negative Retry-After as absent (falls back to jitter)", () => {
    expect(effectiveReplayDelay(450, 0)).toBe(450);
    expect(effectiveReplayDelay(450, -1000)).toBe(450);
  });

  it("honors a Retry-After larger than the jitter", () => {
    expect(effectiveReplayDelay(450, 3000)).toBe(3000);
  });

  it("keeps the jitter when it already exceeds a small Retry-After", () => {
    // Never go FASTER than the decorrelated cascade wanted.
    expect(effectiveReplayDelay(5000, 1000)).toBe(5000);
  });

  it("clamps a long/hostile Retry-After to the backoff ceiling", () => {
    // A server saying "retry in 60s" must not stall the bucket drain;
    // the item still retries on a later drain.
    expect(effectiveReplayDelay(450, 60_000)).toBe(CAP);
  });
});
