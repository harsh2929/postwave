import { describe, expect, it } from "vitest";

import {
  AUDIENCE_MIX_CAMPAIGNS,
  audienceMixPanelUnavailable,
  audienceMixScopeCaption,
  audienceMixSources,
  audienceMixUnavailableNote,
  buildAudienceMix,
  hasSendHappened,
  mergeLinkTotals,
  mergeNamedTotals,
} from "./audienceMix";

const sent = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  status: "finished",
  sent_at: "2026-08-01T10:00:00Z",
  ...over,
});

describe("audienceMixSources", () => {
  it("keeps only campaigns that actually sent", () => {
    const rows = audienceMixSources([
      sent("a"),
      { id: "b", status: "draft", sent_at: null },
      { id: "c", status: "scheduled", sent_at: "" },
      { id: "d", status: "sending", sent_at: null },
    ]);
    expect(rows.map((row) => row.id)).toEqual(["a", "d"]);
  });

  it("counts a cancelled campaign only when it has a send timestamp", () => {
    expect(hasSendHappened({ id: "x", status: "cancelled", sent_at: null })).toBe(
      false,
    );
    expect(
      hasSendHappened({
        id: "x",
        status: "cancelled",
        sent_at: "2026-08-01T10:00:00Z",
      }),
    ).toBe(true);
  });

  it("caps at the desktop's five and drops rows with no id", () => {
    const many = ["a", "b", "c", "d", "e", "f"].map((id) => sent(id));
    expect(audienceMixSources(many)).toHaveLength(AUDIENCE_MIX_CAMPAIGNS);
    expect(audienceMixSources([{ id: "  ", status: "finished" }])).toEqual([]);
  });

  it("survives a non-array payload", () => {
    expect(audienceMixSources(undefined)).toEqual([]);
    expect(audienceMixSources({ items: [] } as never)).toEqual([]);
  });
});

describe("mergeNamedTotals", () => {
  it("sums the same client across campaigns", () => {
    const merged = mergeNamedTotals(
      [
        [{ client: "Apple Mail", opens: 10, clicks: 2 }],
        [
          { client: "Apple Mail", opens: 5, clicks: 1 },
          { client: "Gmail", opens: 4, clicks: 0 },
        ],
      ],
      "client",
    );
    expect(merged).toContainEqual({ client: "Apple Mail", opens: 15, clicks: 3 });
    expect(merged).toContainEqual({ client: "Gmail", opens: 4, clicks: 0 });
  });

  it("buckets blank and missing names into one Unknown row", () => {
    const merged = mergeNamedTotals(
      [[{ country: "  ", opens: 3 }], [{ opens: 2, clicks: 1 }]],
      "country",
    );
    expect(merged).toEqual([{ country: "Unknown", opens: 5, clicks: 1 }]);
  });

  it("ignores non-numeric counts and non-array payloads", () => {
    const merged = mergeNamedTotals(
      [null, "nope", [{ client: "Gmail", opens: "12" }]],
      "client",
    );
    expect(merged).toEqual([{ client: "Gmail", opens: 0, clicks: 0 }]);
  });
});

describe("mergeLinkTotals", () => {
  it("sums clicks per URL", () => {
    expect(
      mergeLinkTotals([
        [{ url: "https://a.example/x", clicks: 3, ctr: 0.5 }],
        [{ url: "https://a.example/x", clicks: 4, ctr: 0.1 }],
      ]),
    ).toEqual([{ url: "https://a.example/x", clicks: 7 }]);
  });

  it("never carries a per-campaign ctr onto a merged row", () => {
    const [row] = mergeLinkTotals([
      [{ url: "https://a.example/x", clicks: 3, ctr: 0.42, unique_clickers: 3 }],
    ]);
    expect(row).not.toHaveProperty("ctr");
    expect(row).not.toHaveProperty("unique_clickers");
  });

  it("drops rows with no URL rather than merging them together", () => {
    expect(mergeLinkTotals([[{ clicks: 9 }, { url: "", clicks: 4 }]])).toEqual([]);
  });
});

describe("copy", () => {
  it("says the scope is sent campaigns, not the reporting window", () => {
    expect(audienceMixScopeCaption(3, 10)).toBe(
      "Across 3 sent campaigns of the 10 most recent.",
    );
    expect(audienceMixScopeCaption(1, 10)).toBe(
      "Across 1 sent campaign of the 10 most recent.",
    );
    expect(audienceMixScopeCaption(0, 10)).toBe(
      "No sent campaigns in the recent list.",
    );
  });

  it("names failed reads once each, and stays silent when nothing failed", () => {
    expect(audienceMixUnavailableNote(["countries", "countries", "links"])).toBe(
      "Couldn't read countries, links — those opens are missing from these totals.",
    );
    expect(audienceMixUnavailableNote([])).toBe("");
    expect(audienceMixUnavailableNote(undefined)).toBe("");
  });
});

describe("buildAudienceMix", () => {
  const ok = (id: string) => ({
    campaignId: id,
    devices: [{ client: "Gmail", opens: 2, clicks: 1 }],
    geography: [{ country: "DE", opens: 2, clicks: 1 }],
    links: [{ url: "https://a.example", clicks: 1 }],
    failures: [],
    absent: [],
  });

  it("merges every campaign and reports a clean rollup", () => {
    const view = buildAudienceMix([ok("a"), ok("b")]);
    expect(view.devices).toEqual([{ client: "Gmail", opens: 4, clicks: 2 }]);
    expect(view.geography).toEqual([{ country: "DE", opens: 4, clicks: 2 }]);
    expect(view.links).toEqual([{ url: "https://a.example", clicks: 2 }]);
    expect(view.missing).toBe("");
    expect(view.absent).toEqual([]);
    expect(view.campaignsRead).toBe(2);
  });

  it("names a partial rollup instead of presenting it as complete", () => {
    const view = buildAudienceMix([
      ok("a"),
      {
        ...ok("b"),
        geography: [],
        failures: [{ read: "geography" as const, status: 500 }],
      },
    ]);
    expect(view.missing).toContain("countries");
    expect(view.campaignsRead).toBe(1);
    expect(view.failedReads).toEqual(["geography"]);
    // The panels that DID load still render.
    expect(view.devices).toEqual([{ client: "Gmail", opens: 4, clicks: 2 }]);
  });

  it("marks a wholly-failed read so its empty panel cannot claim a zero", () => {
    // Every campaign's geography read failed: the merged panel is empty, and
    // an empty panel that says "no opens recorded" is a claim about the
    // audience rather than about the request.
    const failed = (id: string) => ({
      ...ok(id),
      geography: [],
      failures: [{ read: "geography" as const, status: 502 }],
    });
    const view = buildAudienceMix([failed("a"), failed("b")]);
    expect(view.geography).toEqual([]);
    expect(view.failedReads).toContain("geography");
    expect(audienceMixPanelUnavailable("geography")).toBe(
      "Couldn't read countries for these sends. This is not a reading of zero.",
    );
  });

  it("stays silent about reads that only went absent, not failed", () => {
    const view = buildAudienceMix([
      { ...ok("a"), links: [], absent: ["links" as const], failures: [] },
    ]);
    expect(view.failedReads).toEqual([]);
    expect(view.absent).toEqual(["links"]);
  });

  it("ignores a read name this build no longer has", () => {
    // A persisted cache written by an older build. Indexing the label record
    // with it would print "Couldn't read undefined".
    const view = buildAudienceMix([
      {
        ...ok("a"),
        failures: [{ read: "heatmap", status: 500 }],
        absent: ["heatmap"],
      } as never,
    ]);
    expect(view.missing).toBe("");
    expect(view.failedReads).toEqual([]);
    expect(view.absent).toEqual([]);
  });

  it("calls a panel absent only when every campaign says the route is missing", () => {
    const absentOne = {
      ...ok("a"),
      links: [],
      absent: ["links" as const],
      failures: [],
    };
    expect(buildAudienceMix([absentOne, ok("b")]).absent).toEqual([]);
    expect(
      buildAudienceMix([absentOne, { ...absentOne, campaignId: "b" }]).absent,
    ).toEqual(["links"]);
  });

  it("returns empty panels for an empty rollup", () => {
    const view = buildAudienceMix([]);
    expect(view.devices).toEqual([]);
    expect(view.absent).toEqual([]);
    expect(view.campaignsRead).toBe(0);
  });
});
