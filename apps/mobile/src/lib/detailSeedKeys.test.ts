import { describe, expect, it } from "vitest";

import {
  campaignsQueryRootKey,
  firstMeaningful,
  sequencesQueryRootKey,
} from "./detailSeedKeys";
import { findCachedRow } from "./cachedRowSeed";

/**
 * The prefixes are asserted against the SHAPES the hooks actually register,
 * because a prefix that stops matching is a silent failure: the seed simply
 * returns nothing and the header goes back to being blank.
 */
describe("detailSeedKeys", () => {
  it("campaign root is a positional prefix of both campaign list keys", () => {
    const tenant = "11111111-1111-4111-8111-111111111111";
    const root = campaignsQueryRootKey(tenant);
    expect(root).toEqual(["campaigns", tenant]);

    // useCampaignsList
    const plain = ["campaigns", tenant];
    // useCampaignsPaginated
    const paged = ["campaigns", tenant, "paged", "", "u1", "admin", "network"];
    for (const key of [plain, paged]) {
      expect(key.slice(0, root.length)).toEqual([...root]);
    }
  });

  it("sequence root is a positional prefix of the sequences list key", () => {
    const tenant = "22222222-2222-4222-8222-222222222222";
    const root = sequencesQueryRootKey(tenant);
    expect(root).toEqual(["sequences", tenant]);
    const key = ["sequences", tenant, "u1", "editor", "network"];
    expect(key.slice(0, root.length)).toEqual([...root]);
  });

  it("normalises a missing tenant to null so the key is never [x, undefined]", () => {
    expect(campaignsQueryRootKey(null)).toEqual(["campaigns", null]);
    expect(campaignsQueryRootKey(undefined)).toEqual(["campaigns", null]);
    expect(sequencesQueryRootKey(undefined)).toEqual(["sequences", null]);
  });
});

describe("firstMeaningful", () => {
  it("prefers the earliest non-blank candidate", () => {
    expect(firstMeaningful(undefined, "seeded", "detail")).toBe("seeded");
  });

  it("skips empty and whitespace-only strings rather than rendering them", () => {
    expect(firstMeaningful("", "   ", "Sequence")).toBe("Sequence");
  });

  it("trims what it returns", () => {
    expect(firstMeaningful("  Welcome series  ")).toBe("Welcome series");
  });

  it("returns undefined, not an empty string, when nothing is usable", () => {
    expect(firstMeaningful(null, undefined, "")).toBeUndefined();
  });

  it("ignores non-strings that slipped through an untyped cache read", () => {
    expect(
      firstMeaningful(...([0, false, "ok"] as unknown as string[])),
    ).toBe("ok");
  });
});

/**
 * The end-to-end shape assertion: the cache entry a campaigns/sequences list
 * ACTUALLY stores, run through the same lookup the hook performs. This is the
 * half that a prefix test cannot cover — an infinite-query cache is
 * `{pages: [[row]]}` and a sequences list is `{items: [row]}`, and the seed is
 * worthless if `findCachedRow` cannot unwrap either.
 */
describe("seeding against the real cache shapes", () => {
  it("finds a campaign row inside an infinite-query cache", () => {
    const cache = {
      pages: [
        [{ id: "c1", name: "March newsletter", subject: "Hello" }],
        [{ id: "c2", name: "April newsletter" }],
      ],
      pageParams: [1, 2],
    };
    const row = findCachedRow([cache], "c2");
    expect(row?.name).toBe("April newsletter");
  });

  it("finds a sequence row inside the {items, fromSnapshot, error} payload", () => {
    const cache = {
      items: [
        { id: "s1", name: "Welcome series", status: "active" },
        { id: "s2", name: "Win-back", status: "paused" },
      ],
      fromSnapshot: false,
      error: null,
    };
    const row = findCachedRow([cache], "s1");
    expect(row?.name).toBe("Welcome series");
  });

  it("returns null for an id that is not cached rather than the first row", () => {
    expect(findCachedRow([{ items: [{ id: "s1", name: "A" }] }], "s9")).toBeNull();
  });
});
