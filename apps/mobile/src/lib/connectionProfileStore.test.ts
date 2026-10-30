/**
 * The connection record's storage contract: it survives a round trip, it is
 * re-validated on the way out, and a storage failure degrades to "no saved
 * connections" instead of throwing inside a More-screen render.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
let failGet = false;
let failSet = false;

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => {
      if (failGet) throw new Error("device locked");
      return store.get(key) ?? null;
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      if (failSet) throw new Error("disk full");
      store.set(key, value);
    }),
  },
}));

const {
  CONNECTION_PROFILES_KEY,
  readConnectionProfiles,
  writeConnectionProfiles,
} = await import("./connectionProfileStore");

const PROD = {
  id: "p1",
  name: "Acme production",
  baseUrl: "https://api.acme.com",
};

beforeEach(() => {
  store.clear();
  failGet = false;
  failSet = false;
});

describe("readConnectionProfiles", () => {
  it("reads nothing on a fresh install", async () => {
    expect(await readConnectionProfiles()).toEqual({
      profiles: [],
      activeId: null,
    });
  });

  it("round-trips what was written", async () => {
    expect(
      await writeConnectionProfiles({ profiles: [PROD], activeId: "p1" }),
    ).toBe(true);
    expect(await readConnectionProfiles()).toEqual({
      profiles: [PROD],
      activeId: "p1",
    });
  });

  it("re-validates on the way out: a stored ftp:// row never comes back", async () => {
    store.set(
      CONNECTION_PROFILES_KEY,
      JSON.stringify({
        profiles: [PROD, { id: "x", name: "Sketchy", baseUrl: "ftp://x.com" }],
        activeId: "x",
      }),
    );
    const read = await readConnectionProfiles();
    expect(read.profiles).toEqual([PROD]);
    expect(read.activeId).toBeNull();
  });

  it("treats malformed JSON as no connections", async () => {
    store.set(CONNECTION_PROFILES_KEY, "{not json");
    expect(await readConnectionProfiles()).toEqual({
      profiles: [],
      activeId: null,
    });
  });

  it("refuses an over-long record instead of parsing it", async () => {
    store.set(
      CONNECTION_PROFILES_KEY,
      JSON.stringify({
        profiles: Array.from({ length: 2000 }, (_, i) => ({
          id: `id-${i}`,
          name: `Server ${i}`,
          baseUrl: `https://api-${i}.acme.com`,
        })),
      }),
    );
    expect((await readConnectionProfiles()).profiles).toEqual([]);
  });

  it("degrades to no connections when the read throws", async () => {
    await writeConnectionProfiles({ profiles: [PROD], activeId: "p1" });
    failGet = true;
    expect(await readConnectionProfiles()).toEqual({
      profiles: [],
      activeId: null,
    });
  });
});

describe("writeConnectionProfiles", () => {
  it("reports a failed write so the caller can say the save did not land", async () => {
    failSet = true;
    expect(
      await writeConnectionProfiles({ profiles: [PROD], activeId: null }),
    ).toBe(false);
  });

  it("persists only the two fields of the record", async () => {
    await writeConnectionProfiles({
      profiles: [PROD],
      activeId: "p1",
      ...({ secret: "pw_live" } as object),
    });
    expect(store.get(CONNECTION_PROFILES_KEY)).not.toContain("pw_live");
  });
});
