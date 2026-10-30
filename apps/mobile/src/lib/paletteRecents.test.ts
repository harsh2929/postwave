import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    getAllKeys: vi.fn(async () => [...store.keys()]),
    multiRemove: vi.fn(async (keys: string[]) => {
      for (const key of keys) store.delete(key);
    }),
  },
}));

const {
  MAX_PALETTE_RECENTS,
  paletteRecentsKey,
  parseRecents,
  readPaletteRecents,
  recordPaletteRecent,
  withRecent,
} = await import("./paletteRecents");

const ALICE = {
  baseUrl: "https://api.postwave.test",
  tenantId: "tenant-a",
  principalId: "user-alice",
};
const BOB = { ...ALICE, principalId: "user-bob" };
const OTHER_TENANT = { ...ALICE, tenantId: "tenant-b" };

beforeEach(() => store.clear());

describe("paletteRecentsKey", () => {
  it("is scoped by origin, tenant and principal", () => {
    expect(paletteRecentsKey(ALICE)).not.toBe(paletteRecentsKey(BOB));
    expect(paletteRecentsKey(ALICE)).not.toBe(paletteRecentsKey(OTHER_TENANT));
  });

  it("refuses to build a key from an incomplete identity", () => {
    expect(paletteRecentsKey({ ...ALICE, tenantId: null })).toBeNull();
    expect(paletteRecentsKey({ ...ALICE, principalId: "" })).toBeNull();
  });

  it("shares the wiped-on-sign-out preference namespace", () => {
    expect(paletteRecentsKey(ALICE)?.startsWith("postwave.listprefs.v1:")).toBe(
      true,
    );
  });
});

describe("withRecent", () => {
  it("puts the newest first", () => {
    expect(withRecent(["a", "b"], "c")).toEqual(["c", "a", "b"]);
  });

  it("de-duplicates by moving an existing entry to the front", () => {
    expect(withRecent(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });

  it("truncates to the cap", () => {
    const many = ["1", "2", "3", "4", "5", "6", "7"];
    expect(withRecent(many, "0")).toHaveLength(MAX_PALETTE_RECENTS);
  });

  it("ignores an empty id", () => {
    expect(withRecent(["a"], "   ")).toEqual(["a"]);
  });
});

describe("parseRecents", () => {
  it("returns [] for null, malformed JSON and non-arrays", () => {
    expect(parseRecents(null)).toEqual([]);
    expect(parseRecents("{oops")).toEqual([]);
    expect(parseRecents('{"a":1}')).toEqual([]);
  });

  it("drops non-string and empty entries written by an older build", () => {
    expect(parseRecents('["a",1,null,"","b"]')).toEqual(["a", "b"]);
  });
});

describe("storage round trip", () => {
  it("records and reads back per identity", async () => {
    await recordPaletteRecent(ALICE, "nav:lists");
    await recordPaletteRecent(ALICE, "nav:tags");
    expect(await readPaletteRecents(ALICE)).toEqual(["nav:tags", "nav:lists"]);
  });

  it("never leaks one principal's recents to another", async () => {
    await recordPaletteRecent(ALICE, "nav:lists");
    expect(await readPaletteRecents(BOB)).toEqual([]);
    expect(await readPaletteRecents(OTHER_TENANT)).toEqual([]);
  });

  it("is a no-op without a complete identity", async () => {
    expect(await recordPaletteRecent({ ...ALICE, tenantId: null }, "x")).toEqual(
      [],
    );
    expect(store.size).toBe(0);
  });
});
