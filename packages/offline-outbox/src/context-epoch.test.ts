import { describe, expect, it } from "vitest";

import { decideCacheForEpoch, isStaleContext, STALE_CONTEXT_MESSAGE } from "./context-epoch";

/**
 * A queued write belongs to the context it was made in.
 *
 * Replay authenticates as whoever is signed in NOW. Usually that is the same
 * person, same workspace, same role. Occasionally an admin demoted them while
 * their laptop was shut, or they switched workspace — and the write then
 * replays as somebody they no longer are.
 */

describe("a changed context is not the same context", () => {
  it("refuses a write queued under a different epoch", () => {
    expect(isStaleContext({ contextEpoch: "ce1-old" }, "ce1-new")).toBe(true);
  });

  it("allows a write queued under the same epoch", () => {
    expect(isStaleContext({ contextEpoch: "ce1-same" }, "ce1-same")).toBe(false);
  });
});

describe("not-yet-known is not the same as changed", () => {
  it("allows replay when the client has not seen an epoch yet", () => {
    // At boot, or offline, no response has carried one. Treating that as
    // "changed" would discard the whole queue on every cold start — precisely
    // the work the queue exists to protect.
    expect(isStaleContext({ contextEpoch: "ce1-old" }, undefined)).toBe(false);
    expect(isStaleContext({ contextEpoch: "ce1-old" }, null)).toBe(false);
    expect(isStaleContext({ contextEpoch: "ce1-old" }, "")).toBe(false);
  });

  it("allows a record persisted before the field existed", () => {
    // The rule needs both sides. Refusing on a missing value would discard work
    // for a context that may not have changed at all.
    expect(isStaleContext({}, "ce1-new")).toBe(false);
    expect(isStaleContext({ contextEpoch: "" }, "ce1-new")).toBe(false);
  });
});

describe("the message explains a fact, not a fault", () => {
  it("says what changed and what to do", () => {
    // "Something went wrong" would be false — nothing did. Their permissions or
    // workspace changed while the work waited, and if the sentence does not say
    // so the only available reading is "it broke".
    expect(STALE_CONTEXT_MESSAGE).toMatch(/permissions|workspace/i);
    expect(STALE_CONTEXT_MESSAGE).toMatch(/submit again|review/i);
    expect(STALE_CONTEXT_MESSAGE).not.toMatch(/error|failed|wrong/i);
  });
});

describe("decideCacheForEpoch", () => {
  it("clears when the persisted cache was built under a different context", () => {
    // THE CASE THIS EXISTS FOR: a demotion leaves the cache buster
    // (version:user:tenant) byte-identical, so the pre-demotion cache
    // rehydrates on relaunch and paints.
    expect(decideCacheForEpoch("ce1-before", "ce1-after")).toEqual({
      clearCache: true,
      persist: "ce1-after",
    });
  });

  it("keeps a cache built under the same context", () => {
    expect(decideCacheForEpoch("ce1-same", "ce1-same")).toEqual({
      clearCache: false,
      persist: "ce1-same",
    });
  });

  it("does not clear on the first launch that records an epoch", () => {
    // A build adding this field would otherwise wipe every user's cache exactly
    // once — which looks like a bug and teaches nothing. There is no evidence
    // the cache is stale; from here on the provenance is known.
    expect(decideCacheForEpoch(undefined, "ce1-new")).toEqual({
      clearCache: false,
      persist: "ce1-new",
    });
    expect(decideCacheForEpoch("", "ce1-new").clearCache).toBe(false);
  });

  it("changes nothing when the response carries no epoch", () => {
    // Unauthenticated responses carry none by design; treating that as evidence
    // would clear the cache on every public request.
    expect(decideCacheForEpoch("ce1-live", "")).toEqual({
      clearCache: false,
      persist: "ce1-live",
    });
    expect(decideCacheForEpoch("ce1-live", "   ").persist).toBe("ce1-live");
  });

  it("is deliberately STRICTER than isStaleContext, which governs queued work", () => {
    // A cache is disposable; a queued write is the person's work. The write
    // rule must never refuse on an unknown, so the two answers differ here on
    // purpose — and that difference is the whole reason both exist.
    const persistedUnknown = decideCacheForEpoch(undefined, "ce1-x");
    expect(persistedUnknown.clearCache).toBe(false);
    expect(isStaleContext({ contextEpoch: undefined }, "ce1-x")).toBe(false);
    // Where they diverge: a KNOWN-different persisted epoch drops the cache,
    // while a queued write with no recorded epoch is still replayed.
    expect(decideCacheForEpoch("ce1-w", "ce1-x").clearCache).toBe(true);
    expect(isStaleContext({}, "ce1-x")).toBe(false);
  });
});
