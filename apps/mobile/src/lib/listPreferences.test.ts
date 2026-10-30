/**
 * The identity-scoping rule for saved list views. The other two clients both
 * shipped caches that bled across tenants on a shared device; these tests hold
 * the line here.
 */
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
  clearListPreferences,
  preferenceKey,
  readListPreferences,
  writeListPreferences,
} = await import("./listPreferences");

const ALICE = {
  baseUrl: "https://api.postwave.test",
  tenantId: "tenant-a",
  principalId: "user-alice",
};
const BOB = { ...ALICE, principalId: "user-bob" };
const OTHER_TENANT = { ...ALICE, tenantId: "tenant-b" };

beforeEach(() => store.clear());

describe("preferenceKey", () => {
  it("scopes by origin, tenant, and principal", () => {
    const alice = preferenceKey("suppressions", ALICE);
    expect(alice).toContain("tenant-a");
    expect(alice).toContain("user-alice");
    expect(alice).toContain("suppressions");
  });

  it("gives different accounts and tenants different keys", () => {
    expect(preferenceKey("suppressions", ALICE)).not.toBe(
      preferenceKey("suppressions", BOB),
    );
    expect(preferenceKey("suppressions", ALICE)).not.toBe(
      preferenceKey("suppressions", OTHER_TENANT),
    );
  });

  it("refuses a key when identity is incomplete rather than sharing one", () => {
    // Falling back to a shared key here is precisely how cross-account bleed
    // happens, so an incomplete identity must yield no storage at all.
    expect(preferenceKey("suppressions", { ...ALICE, tenantId: null })).toBeNull();
    expect(preferenceKey("suppressions", { ...ALICE, principalId: "" })).toBeNull();
    expect(preferenceKey("", ALICE)).toBeNull();
  });

  it("normalises a trailing slash on the origin so one account has one key", () => {
    expect(
      preferenceKey("s", { ...ALICE, baseUrl: "https://api.postwave.test/" }),
    ).toBe(preferenceKey("s", ALICE));
  });
});

describe("read/write", () => {
  const defaults = { sort: "name", filter: "all" };

  it("round-trips a preference", async () => {
    await writeListPreferences("tags", ALICE, { sort: "newest", filter: "all" });
    expect(await readListPreferences("tags", ALICE, defaults)).toEqual({
      sort: "newest",
      filter: "all",
    });
  });

  it("does not leak one account's view into another's", async () => {
    await writeListPreferences("tags", ALICE, { sort: "newest", filter: "mine" });
    expect(await readListPreferences("tags", BOB, defaults)).toEqual(defaults);
    expect(await readListPreferences("tags", OTHER_TENANT, defaults)).toEqual(
      defaults,
    );
  });

  it("returns defaults when identity is incomplete", async () => {
    await writeListPreferences("tags", { ...ALICE, tenantId: null }, {
      sort: "newest",
    });
    expect(
      await readListPreferences("tags", { ...ALICE, tenantId: null }, defaults),
    ).toEqual(defaults);
  });

  it("drops stored keys this screen no longer understands", async () => {
    await writeListPreferences("tags", ALICE, {
      sort: "newest",
      legacyMode: "gone",
    });
    const read = await readListPreferences("tags", ALICE, defaults);
    expect(read).toEqual({ sort: "newest", filter: "all" });
    expect("legacyMode" in read).toBe(false);
  });

  it("falls back to defaults on a corrupt blob instead of throwing", async () => {
    const key = preferenceKey("tags", ALICE) as string;
    store.set(key, "{not json");
    expect(await readListPreferences("tags", ALICE, defaults)).toEqual(defaults);
    store.set(key, "[1,2,3]");
    expect(await readListPreferences("tags", ALICE, defaults)).toEqual(defaults);
  });
});

describe("clearListPreferences", () => {
  it("removes every account's preferences and nothing else", async () => {
    await writeListPreferences("tags", ALICE, { sort: "newest" });
    await writeListPreferences("tags", BOB, { sort: "name" });
    store.set("unrelated.key", "keep me");

    await clearListPreferences();

    expect(store.has("unrelated.key")).toBe(true);
    expect(await readListPreferences("tags", ALICE, { sort: "name" })).toEqual({
      sort: "name",
    });
  });
});
