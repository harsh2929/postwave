import { describe, expect, it, vi } from "vitest";

// useSubscribers.ts imports @/api/client + RN-bound vault/connectivity libs;
// the tests below only exercise the pure helpers, so stub those modules so
// the import graph resolves under the node environment.
vi.mock("@/api/client", () => ({ getClient: vi.fn() }));
vi.mock("@/hooks/useOnlineQueryGate", () => ({ useOnlineQueryGate: vi.fn() }));
vi.mock("@/lib/connectivity", () => ({ isProbablyOnline: () => true }));
vi.mock("@/lib/secureVault", () => ({
  vaultGetJSON: vi.fn(),
  vaultSetJSON: vi.fn(),
  vaultScopeForClient: vi.fn(),
}));
// useSubscribers re-exports the membership writes from useSubscriberLists,
// which now enqueue through the generic offline queue (AUDIENCE#33). That
// reaches expo-crypto / expo-secure-store / react-native, none of which the
// node environment can transform; the helpers exercised below touch none of
// it. Their own rules are tested in useSubscriberLists.test.ts.
vi.mock("@/lib/offlineEntityWrite", () => ({ executeEntityWrite: vi.fn() }));
vi.mock("@/lib/offlineMutations", () => ({
  newOfflineMutationMetadata: vi.fn(),
}));
vi.mock("@/lib/queryClient", () => ({
  offlineSafeMutationMeta: { offlineSafe: true },
}));
vi.mock("@/lib/deliverabilitySnapshots", () => ({
  REFERENCE_SNAPSHOT_MAX_BYTES: 18_000,
  capRowsForVault: (rows: unknown[]) => ({ rows, truncated: false }),
  loadSnapshotBacked: vi.fn(),
  snapshotScope: vi.fn(),
}));

// eslint-disable-next-line import/first
import {
  addSubscriberToList,
  nextTagsAfterAdd,
  nextTagsAfterRemove,
  subscriberDetailKey,
  subscriberListParams,
  subscriberMutationInvalidationKeys,
  subscriberTimelineKey,
  SUBSCRIBER_TIMELINE_KEY_ROOT,
} from "./useSubscribers";

describe("subscriberListParams", () => {
  it("combines paginated search and server-side status filtering", () => {
    expect(
      subscriberListParams("  alice@example.com  ", "disabled", 3),
    ).toEqual({
      page: 3,
      per_page: 25,
      q: "alice@example.com",
      status: "disabled",
    });
  });

  it("omits empty optional filters", () => {
    expect(subscriberListParams("   ", undefined, 1)).toEqual({
      page: 1,
      per_page: 25,
    });
  });
});

describe("addSubscriberToList", () => {
  it("uses the list-scoped endpoint that resolves Listmonk bigint ids", async () => {
    const request = vi.fn().mockResolvedValue({ added: 1, skipped: 0 });

    await expect(
      addSubscriberToList({ request }, "subscriber-uuid", 42),
    ).resolves.toEqual({ added: 1, skipped: 0 });

    expect(request).toHaveBeenCalledWith(
      "POST",
      "/api/v1/lists/42/subscribers",
      { body: { subscriber_ids: ["subscriber-uuid"] } },
    );
  });
});

describe("nextTagsAfterAdd", () => {
  it("appends a new tag preserving order and original casing", () => {
    expect(nextTagsAfterAdd(["vip"], "newsletter")).toEqual([
      "vip",
      "newsletter",
    ]);
  });

  it("trims the incoming tag", () => {
    expect(nextTagsAfterAdd([], "  spaced  ")).toEqual(["spaced"]);
  });

  it("treats undefined current as empty", () => {
    expect(nextTagsAfterAdd(undefined, "first")).toEqual(["first"]);
  });

  it("returns null (no-op) for a blank tag", () => {
    expect(nextTagsAfterAdd(["a"], "   ")).toBeNull();
    expect(nextTagsAfterAdd(["a"], "")).toBeNull();
  });

  it("returns null when the tag is already present (case-insensitive)", () => {
    expect(nextTagsAfterAdd(["VIP"], "vip")).toBeNull();
    expect(nextTagsAfterAdd(["vip"], "  VIP ")).toBeNull();
  });
});

describe("nextTagsAfterRemove", () => {
  it("removes a matching tag case-insensitively", () => {
    expect(nextTagsAfterRemove(["VIP", "news"], "vip")).toEqual(["news"]);
  });

  it("returns null (no-op) when the tag isn't present", () => {
    expect(nextTagsAfterRemove(["a", "b"], "c")).toBeNull();
  });

  it("treats undefined current as empty → null", () => {
    expect(nextTagsAfterRemove(undefined, "x")).toBeNull();
  });

  it("can empty the set", () => {
    expect(nextTagsAfterRemove(["only"], "only")).toEqual([]);
  });
});

describe("subscriberMutationInvalidationKeys", () => {
  // Regression for the HIGH finding: unsubscribe/resubscribe + tag add/remove
  // mutations must invalidate the TIMELINE query (which backs the status pill,
  // engagement gauge and lifetime-stats grid via stats.current_status), not
  // just the list + detail keys. Before the fix the timeline key was omitted,
  // so the status pill stayed stale after a successful mutation.
  it("includes the subscriber timeline key so the status pill refreshes", () => {
    const keys = subscriberMutationInvalidationKeys("tenant-1", "sub-42");
    expect(keys).toContainEqual([
      SUBSCRIBER_TIMELINE_KEY_ROOT,
      "tenant-1",
      "sub-42",
    ]);
    expect(keys).toContainEqual(subscriberTimelineKey("tenant-1", "sub-42"));
  });

  it("also invalidates the list (prefix) and detail keys", () => {
    const keys = subscriberMutationInvalidationKeys("tenant-1", "sub-42");
    // List key is a 2-element PREFIX so it matches every search/page variant
    // (["subs", tenantId, query]) under TanStack's prefix match — NOT the full
    // compound key with a trailing param.
    expect(keys).toContainEqual(["subs", "tenant-1"]);
    expect(keys).toContainEqual(["sub", "tenant-1", "sub-42"]);
  });

  it("scopes the list + detail keys to the tenant", () => {
    const keys = subscriberMutationInvalidationKeys("tenant-X", "sub-9");
    expect(keys.some((k) => k[0] === "subs" && k[1] === "tenant-X")).toBe(true);
    expect(
      keys.some(
        (k) => k[0] === "sub" && k[1] === "tenant-X" && k[2] === "sub-9",
      ),
    ).toBe(true);
    expect(
      keys.some(
        (k) =>
          k[0] === SUBSCRIBER_TIMELINE_KEY_ROOT &&
          k[1] === "tenant-X" &&
          k[2] === "sub-9",
      ),
    ).toBe(true);
  });

  it("exposes exactly the three roots (list, detail, timeline)", () => {
    const roots = subscriberMutationInvalidationKeys("t", "id").map(
      (k) => k[0],
    );
    expect(roots).toEqual(["subs", "sub", SUBSCRIBER_TIMELINE_KEY_ROOT]);
  });
});

describe("subscriberDetailKey", () => {
  // The detail query keys on [sub, tenantId, id, userId, effectiveRole, mode].
  // TanStack matches filters POSITIONALLY, so this prefix must stop at `id`:
  // any extra element would stop matching the mounted query and the
  // optimistic tag patch would silently no-op.
  it("is the 3-element positional prefix of the detail query", () => {
    expect(subscriberDetailKey("t1", "s1")).toEqual(["sub", "t1", "s1"]);
  });

  it("normalises a missing tenant or id to null rather than undefined", () => {
    // `undefined` in a query key serialises differently from `null` and would
    // silently fail to match.
    expect(subscriberDetailKey(undefined, undefined)).toEqual([
      "sub",
      null,
      null,
    ]);
  });

  it("is the same key the invalidation list uses", () => {
    const keys = subscriberMutationInvalidationKeys("t1", "s1");
    expect(keys).toContainEqual(subscriberDetailKey("t1", "s1"));
  });
});
