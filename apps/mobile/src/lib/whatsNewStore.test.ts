/**
 * The dismissal record's failure direction.
 *
 * Every branch here answers one question: when storage misbehaves, does the
 * user see one card again (safe) or does the announcement mechanism go dark
 * (a feature that silently stops existing)?
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
let failGet = false;
let failSet = false;

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => {
      if (failGet) throw new Error("keychain locked");
      return store.get(key) ?? null;
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      if (failSet) throw new Error("disk full");
      store.set(key, value);
    }),
  },
}));

const {
  WHATS_NEW_DISMISSED_KEY,
  dismissAnnouncement,
  readDismissedAnnouncements,
} = await import("./whatsNewStore");

beforeEach(() => {
  store.clear();
  failGet = false;
  failSet = false;
});

describe("readDismissedAnnouncements", () => {
  it("reads nothing on a fresh install", async () => {
    expect(await readDismissedAnnouncements()).toEqual([]);
  });

  it("round-trips what was dismissed", async () => {
    await dismissAnnouncement("billing-api-usage");
    expect(await readDismissedAnnouncements()).toEqual(["billing-api-usage"]);
  });

  it("treats malformed JSON as nothing dismissed", async () => {
    store.set(WHATS_NEW_DISMISSED_KEY, "{not json");
    expect(await readDismissedAnnouncements()).toEqual([]);
  });

  it("treats a non-array record as nothing dismissed", async () => {
    store.set(WHATS_NEW_DISMISSED_KEY, JSON.stringify({ a: 1 }));
    expect(await readDismissedAnnouncements()).toEqual([]);
  });

  it("refuses an over-long record instead of parsing it", async () => {
    store.set(
      WHATS_NEW_DISMISSED_KEY,
      JSON.stringify(Array.from({ length: 5000 }, (_, i) => `key-${i}`)),
    );
    expect(await readDismissedAnnouncements()).toEqual([]);
  });

  it("a read failure means nothing dismissed, never everything", async () => {
    await dismissAnnouncement("billing-api-usage");
    failGet = true;
    expect(await readDismissedAnnouncements()).toEqual([]);
  });
});

describe("dismissAnnouncement", () => {
  it("answers the new list so the card can advance without re-reading", async () => {
    expect(await dismissAnnouncement("a")).toEqual(["a"]);
    expect(await dismissAnnouncement("b")).toEqual(["a", "b"]);
  });

  it("still puts the card down for this session when the write fails", async () => {
    failSet = true;
    expect(await dismissAnnouncement("a")).toEqual(["a"]);
    expect(await readDismissedAnnouncements()).toEqual([]);
  });
});
