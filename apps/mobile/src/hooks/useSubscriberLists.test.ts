import { describe, expect, it, vi } from "vitest";

vi.mock("@/api/client", () => ({ getClient: vi.fn() }));
vi.mock("@/hooks/useOnlineQueryGate", () => ({ useOnlineQueryGate: vi.fn() }));
vi.mock("@/lib/connectivity", () => ({ isProbablyOnline: () => true }));
vi.mock("@/lib/secureVault", () => ({
  vaultGetJSON: vi.fn(),
  vaultSetJSON: vi.fn(),
  vaultScopeForClient: vi.fn(),
}));
// The offline queue reaches expo-crypto / expo-secure-store through the
// entity-write executor; the derivation helpers under test import none of it.
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
  addSubscriberToListPath,
  isSubscriberUuid,
  listIdFromAddPath,
  normalizeMemberships,
  removeSubscriberFromList,
  subscriberIdFromAddBody,
  subscriberListsKey,
} from "./useSubscriberLists";

describe("isSubscriberUuid", () => {
  it("accepts a canonical UUID in either case", () => {
    expect(isSubscriberUuid("3f7c1b2e-9a4d-4c11-8f22-0b1d2e3f4a5b")).toBe(true);
    expect(isSubscriberUuid("3F7C1B2E-9A4D-4C11-8F22-0B1D2E3F4A5B")).toBe(true);
  });

  it("rejects the EMAIL fallback the list uses for rows without an id", () => {
    // GET /lists/for-subscriber/{sub_id} answers 400 bad_id for a non-UUID,
    // so firing the request would be a guaranteed failure.
    expect(isSubscriberUuid("ada@example.com")).toBe(false);
  });

  it("rejects empty, undefined and near-misses", () => {
    expect(isSubscriberUuid(undefined)).toBe(false);
    expect(isSubscriberUuid(null)).toBe(false);
    expect(isSubscriberUuid("")).toBe(false);
    expect(isSubscriberUuid("3f7c1b2e9a4d4c118f220b1d2e3f4a5b")).toBe(false);
    expect(isSubscriberUuid("3f7c1b2e-9a4d-4c11-8f22-0b1d2e3f4a5")).toBe(false);
  });
});

describe("normalizeMemberships", () => {
  it("reads the { items, count } envelope the Go handler returns", () => {
    expect(
      normalizeMemberships({
        items: [
          { id: "l1", name: "Newsletter" },
          { id: "l2", name: "Beta" },
        ],
        count: 2,
      }),
    ).toEqual([
      { id: "l1", name: "Newsletter" },
      { id: "l2", name: "Beta" },
    ]);
  });

  it("stringifies a numeric list id", () => {
    expect(normalizeMemberships({ items: [{ id: 42, name: "Ops" }] })).toEqual([
      { id: "42", name: "Ops" },
    ]);
  });

  it("falls back to the id when the name is missing", () => {
    expect(normalizeMemberships({ items: [{ id: "l1" }] })).toEqual([
      { id: "l1", name: "l1" },
    ]);
  });

  it("returns [] for every non-envelope shape rather than throwing", () => {
    expect(normalizeMemberships(null)).toEqual([]);
    expect(normalizeMemberships(undefined)).toEqual([]);
    expect(normalizeMemberships({})).toEqual([]);
    expect(normalizeMemberships({ items: "nope" })).toEqual([]);
    expect(normalizeMemberships([{ id: "l1" }])).toEqual([]);
  });

  it("drops rows with no id", () => {
    expect(
      normalizeMemberships({ items: [{ name: "orphan" }, { id: "ok" }] }),
    ).toEqual([{ id: "ok", name: "ok" }]);
  });
});

describe("removeSubscriberFromList", () => {
  it("hits the list-scoped membership DELETE with both ids encoded", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    await removeSubscriberFromList({ request }, 42, "sub uuid");
    expect(request).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/lists/42/subscribers/sub%20uuid",
    );
  });
});

describe("subscriberListsKey", () => {
  it("is scoped by tenant and subscriber", () => {
    expect(subscriberListsKey("t1", "s1")).toEqual(["sub-lists", "t1", "s1"]);
  });

  it("normalises missing parts to null", () => {
    expect(subscriberListsKey(undefined, undefined)).toEqual([
      "sub-lists",
      null,
      null,
    ]);
  });
});

describe("queued add-to-list derivation (AUDIENCE#33)", () => {
  it("recovers the list id from a path a later process rehydrated", () => {
    expect(listIdFromAddPath("/api/v1/lists/12/subscribers")).toBe("12");
    expect(
      listIdFromAddPath(
        "/api/v1/lists/8f1a2b3c-0000-0000-0000-000000000000/subscribers",
      ),
    ).toBe("8f1a2b3c-0000-0000-0000-000000000000");
  });

  it("decodes an escaped list id", () => {
    expect(listIdFromAddPath("/api/v1/lists/a%2Fb/subscribers")).toBe("a/b");
  });

  it("returns null for anything that is not the membership-add path", () => {
    expect(listIdFromAddPath("/api/v1/lists/12/subscribers/abc")).toBeNull();
    expect(listIdFromAddPath("/api/v1/lists/12")).toBeNull();
    expect(listIdFromAddPath("")).toBeNull();
    expect(listIdFromAddPath(undefined as unknown as string)).toBeNull();
  });

  it("round-trips against the path builder", () => {
    for (const id of ["12", "abc-def", "a b"]) {
      expect(listIdFromAddPath(addSubscriberToListPath(id))).toBe(id);
    }
  });

  it("recovers the subscriber id from the queued body", () => {
    expect(subscriberIdFromAddBody({ subscriber_ids: ["sub-1"] })).toBe("sub-1");
  });

  it("returns null rather than a wrong id for a malformed body", () => {
    expect(subscriberIdFromAddBody(null)).toBeNull();
    expect(subscriberIdFromAddBody({})).toBeNull();
    expect(subscriberIdFromAddBody({ subscriber_ids: [] })).toBeNull();
    expect(subscriberIdFromAddBody({ subscriber_ids: [42] })).toBeNull();
    expect(subscriberIdFromAddBody("not an object")).toBeNull();
  });
});
