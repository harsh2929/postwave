import { beforeEach, describe, it, expect, vi } from "vitest";

// Stub the SDK-backed request layer so importing search.ts (which imports
// rawRequest → sdkClient → @postwave/sdk) resolves in the node test env.
const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("./request", () => ({ rawRequest }));

const {
  SEARCH_INDEX_LIMIT,
  fanOutSearch,
  globalSearch,
  groupSearchHits,
  searchHitRoute,
  searchHitTypeLabel,
} = await import("./search");
type MobileSearchHit = Awaited<
  ReturnType<typeof fanOutSearch>
>["hits"][number];

const hit = (
  type: MobileSearchHit["type"],
  id: string,
  title = "x",
): MobileSearchHit => ({ type, id, title });

const ok = <T,>(data: T) => ({ data, error: null });
const fail = (status = 500) => ({
  data: null,
  error: { status, message: "boom" },
});

// NOTE: the body must be a BLOCK. `() => rawRequest.mockReset()` returns the
// mock itself, and vitest treats a function returned from beforeEach as a
// cleanup hook — it would then CALL the mock with no arguments after every test.
beforeEach(() => {
  rawRequest.mockReset();
});

describe("searchHitRoute", () => {
  it("deep-links a subscriber to its detail screen via route-map", () => {
    expect(searchHitRoute(hit("subscriber", "sub_1"))).toEqual({
      pathname: "/(tabs)/subscribers/[id]",
      params: { id: "sub_1" },
    });
  });

  it("deep-links a campaign — the type the old index could not reach at all", () => {
    expect(searchHitRoute(hit("campaign", "camp_1"))).toEqual({
      pathname: "/(tabs)/campaigns/[id]",
      params: { id: "camp_1" },
    });
  });

  it("falls back to the list screen for a route-map-unsafe id", () => {
    expect(searchHitRoute(hit("subscriber", "../escape"))).toEqual({
      pathname: "/(tabs)/subscribers",
    });
  });

  it("carries the hit title so the destination can pre-filter", () => {
    expect(searchHitRoute(hit("list", "l1", "Newsletter"))).toEqual({
      pathname: "/(tabs)/lists",
      params: { q: "Newsletter" },
    });
    expect(searchHitRoute(hit("tag", "t1", "vip"))).toEqual({
      pathname: "/(tabs)/tags",
      params: { q: "vip" },
    });
  });

  it("deep-links a suppression to the detail screen addressed by its email", () => {
    // The index selects `id::text` and `email` (apps/api/internal/search/
    // index.go), so the hit id is a row UUID and the TITLE is the address —
    // and app/(tabs)/suppressions/[email].tsx is keyed by the address. Routing
    // the hit to the collection meant the one surface with a suppression
    // detail screen could never reach it from search.
    expect(
      searchHitRoute(hit("suppression", "0f0d5b4e-…", "ada@example.com")),
    ).toEqual({
      pathname: "/(tabs)/suppressions/[email]",
      params: { email: "ada@example.com" },
    });
  });

  it("falls back to the pre-filtered list when the title is not an address", () => {
    // route-map's `isAddressableHitId` owns the email shape; a title that
    // fails it must never be pushed into a path.
    expect(searchHitRoute(hit("suppression", "s1", "not an address"))).toEqual({
      pathname: "/(tabs)/suppressions",
      params: { q: "not an address" },
    });
    expect(searchHitRoute(hit("suppression", "s1", "../escape@x.com"))).toEqual({
      pathname: "/(tabs)/suppressions",
      params: { q: "../escape@x.com" },
    });
  });

  it("deep-links a segment to its detail screen, not to a name search", () => {
    // The index selects segments.id::text, so the hit id IS the UUID the
    // detail screen and GET /api/v1/segments/{id} take. Routing to the
    // subscribers list pre-searched for the NAME returned whoever happened
    // to carry that string in a tag or custom field.
    const id = "3f1a2b7c-9d4e-4a11-8b2c-77e0d1a45c9f";
    expect(searchHitRoute(hit("segment", id, "Engaged"))).toEqual({
      pathname: "/(tabs)/segments/[id]",
      params: { id },
    });
  });

  it("falls back to the segments catalogue for a non-UUID segment id", () => {
    expect(searchHitRoute(hit("segment", "seg_1", "Engaged"))).toEqual({
      pathname: "/(tabs)/segments",
      params: { q: "Engaged" },
    });
  });

  it("always returns a (tabs) route", () => {
    for (const type of [
      "subscriber",
      "campaign",
      "list",
      "suppression",
      "segment",
      "tag",
    ] as const) {
      expect(searchHitRoute(hit(type, "x1")).pathname.startsWith("/(tabs)/")).toBe(
        true,
      );
    }
  });
});

describe("searchHitTypeLabel", () => {
  it("labels every searchable type", () => {
    expect(searchHitTypeLabel("subscriber")).toBe("Subscriber");
    expect(searchHitTypeLabel("suppression")).toBe("Suppression");
    expect(searchHitTypeLabel("campaign")).toBe("Campaign");
    expect(searchHitTypeLabel("tag")).toBe("Tag");
  });
});

describe("globalSearch", () => {
  it("surfaces the error envelope instead of swallowing it", async () => {
    rawRequest.mockResolvedValueOnce(fail(500));
    const res = await globalSearch("ada");
    expect(res.error?.status).toBe(500);
  });

  it("url-encodes the query", async () => {
    rawRequest.mockResolvedValueOnce(ok({ query: "a b", results: [] }));
    await globalSearch("a b&c");
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      expect.stringContaining("q=a%20b%26c"),
    );
  });
});

describe("fanOutSearch", () => {
  const wire = (
    index: unknown,
    campaigns: unknown,
    tags: unknown,
  ): void => {
    rawRequest.mockImplementation((_method: string, path: string) => {
      if (path.startsWith("/api/v1/search")) return Promise.resolve(index);
      if (path.startsWith("/api/v1/campaigns")) return Promise.resolve(campaigns);
      return Promise.resolve(tags);
    });
  };

  it("merges index hits with the tag fan-out", async () => {
    // Campaigns come from the INDEX now, not a second request. They used to
    // come from both, and fanOutSearch concatenates without deduping, so every
    // matching campaign rendered twice.
    wire(
      ok({
        query: "n",
        results: [hit("subscriber", "s1"), hit("campaign", "c1")],
      }),
      ok([{ id: "c1", name: "Newsletter", subject: "Hello" }]),
      ok({ items: [{ id: "t1", name: "news" }] }),
    );
    const res = await fanOutSearch("n");
    expect(res.hits.map((h) => h.type).sort()).toEqual([
      "campaign",
      "subscriber",
      "tag",
    ]);
    expect(res.partial).toBe(false);
  });

  it("degrades to partial when one source fails", async () => {
    wire(
      ok({ query: "n", results: [hit("subscriber", "s1")] }),
      ok([]),
      fail(503),
    );
    const res = await fanOutSearch("n");
    expect(res.partial).toBe(true);
    expect(res.hits).toHaveLength(1);
  });

  it("throws only when every source fails, so the screen can show an error", async () => {
    wire(fail(500), fail(500), fail(500));
    await expect(fanOutSearch("n")).rejects.toThrow(/unavailable/iu);
  });

  it("flags truncation when the index returns its full cap", async () => {
    const many = Array.from({ length: SEARCH_INDEX_LIMIT }, (_, i) =>
      hit("subscriber", `s${i}`),
    );
    wire(ok({ query: "n", results: many }), ok([]), ok({ items: [] }));
    expect((await fanOutSearch("n")).truncated).toBe(true);
  });

  it("skips tag rows with no id rather than routing to undefined", async () => {
    // Was the campaigns fan-out's id guard; campaigns come from the index now,
    // so the same property is asserted on the one source that still fans out.
    wire(
      ok({ query: "n", results: [] }),
      ok([]),
      ok({ items: [{ name: "no id" }, { id: "t1", name: "ok" }] }),
    );
    const res = await fanOutSearch("n");
    expect(res.hits).toEqual([{ type: "tag", id: "t1", title: "ok" }]);
  });
});

describe("groupSearchHits", () => {
  it("groups by type in a stable order with subscribers first", () => {
    const sections = groupSearchHits([
      hit("tag", "t1"),
      hit("subscriber", "s1"),
      hit("campaign", "c1"),
      hit("subscriber", "s2"),
    ]);
    expect(sections.map((s) => s.type)).toEqual([
      "subscriber",
      "campaign",
      "tag",
    ]);
    expect(sections[0]?.data).toHaveLength(2);
    expect(sections[0]?.title).toBe("Subscribers");
  });

  it("omits empty groups", () => {
    expect(groupSearchHits([])).toEqual([]);
  });
});

describe("the server index and the client fan-out do not overlap", () => {
  // The server grew from four indexed types to eight. Mobile's fan-out was
  // written when campaigns were NOT indexed ("the server index covers exactly
  // four types — list, segment, suppression, subscriber — so campaigns ... were
  // unsearchable") and kept issuing its own campaigns request afterwards.
  //
  // fanOutSearch concatenates without deduping, so every matching campaign is
  // now returned twice and rendered twice.
  it("returns a campaign once, not once per source", async () => {
    rawRequest.mockImplementation((_method: string, path: string) => {
      if (path.startsWith("/api/v1/search")) {
        return Promise.resolve(
          ok({
            query: "spring",
            results: [{ type: "campaign", id: "c1", title: "Spring sale" }],
          }),
        );
      }
      if (path.startsWith("/api/v1/campaigns")) {
        return Promise.resolve(ok([{ id: "c1", name: "Spring sale" }]));
      }
      return Promise.resolve(ok({ items: [] }));
    });

    const { hits } = await fanOutSearch("spring");
    const campaigns = hits.filter((h) => h.type === "campaign");
    expect(
      campaigns.map((c) => c.id),
      "the same campaign came back from both the index and the fan-out",
    ).toEqual(["c1"]);
  });

  it("routes the types the server indexes that mobile ignored", async () => {
    // flow, template and form are indexed by the server and mobile ships a
    // screen for each, but MobileSearchType did not list them — so they were
    // dropped before anything could route them.
    rawRequest.mockImplementation((_method: string, path: string) => {
      if (path.startsWith("/api/v1/search")) {
        return Promise.resolve(
          ok({
            query: "welcome",
            results: [
              { type: "flow", id: "f1", title: "Welcome flow" },
              { type: "template", id: "t1", title: "Welcome template" },
              { type: "form", id: "fo1", title: "Welcome form" },
            ],
          }),
        );
      }
      return Promise.resolve(ok({ items: [] }));
    });

    const { hits } = await fanOutSearch("welcome");
    expect(hits.map((h) => h.type).sort()).toEqual(["flow", "form", "template"]);
    for (const h of hits) {
      const route = searchHitRoute(h);
      expect(route.pathname, `${h.type} has no route`).toBeTruthy();
      expect(route.pathname.startsWith("/(tabs)/")).toBe(true);
    }
  });
});
