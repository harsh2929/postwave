/**
 * feed-sources-helpers — pure logic behind FeedSourcesSection (R1).
 *
 * High-stakes invariants:
 *   1. Schedule whitelist is manual|daily|weekly — no monthly (the
 *      server 400s on anything else).
 *   2. A FAILED poll arrives as HTTP 200 with status:"failed" + error
 *      text — summarizePollResult must surface the error verbatim and
 *      never claim a draft was created.
 *   3. Targeting round-trips: list/segment ids are sent as explicit
 *      nulls when targeting flips back to "everyone" so edit actually
 *      clears the stored columns.
 *   4. Honest copy: success details say DRAFT campaign, never "sent".
 */

import { describe, expect, it } from "vitest";

import type { FeedPollResult, FeedSource } from "../../lib/api-client";
import {
  EMPTY_FEED_DRAFT,
  FEED_SCHEDULES,
  draftToInput,
  fmtRunTimestamp,
  lastPolledLabel,
  runStatusBadgeClass,
  runStatusLabel,
  sourceToDraft,
  summarizePollResult,
  unwrapLists,
  validateFeedSourceDraft,
  type FeedSourceDraft,
} from "../../components/feedsources/feed-sources-helpers";

function draft(over: Partial<FeedSourceDraft> = {}): FeedSourceDraft {
  return {
    ...EMPTY_FEED_DRAFT,
    name: "Blog",
    url: "https://example.com/rss.xml",
    ...over,
  };
}

function source(over: Partial<FeedSource> = {}): FeedSource {
  return {
    id: "fs1",
    name: "Blog",
    url: "https://example.com/rss.xml",
    schedule: "daily",
    subject_template: "{{title}}",
    enabled: true,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...over,
  };
}

function pollResult(over: Partial<FeedPollResult> = {}): FeedPollResult {
  return {
    run_id: "r1",
    status: "ok",
    items_seen: 10,
    new_items: 0,
    ...over,
  };
}

describe("FEED_SCHEDULES", () => {
  it("offers exactly manual|daily|weekly — no monthly", () => {
    expect(FEED_SCHEDULES.map((s) => s.value)).toEqual([
      "manual",
      "daily",
      "weekly",
    ]);
  });
});

describe("validateFeedSourceDraft", () => {
  it("accepts a complete draft", () => {
    expect(validateFeedSourceDraft(draft())).toEqual({ ok: true, errors: {} });
  });

  it("requires name, url, and subject template", () => {
    const v = validateFeedSourceDraft(
      draft({ name: "  ", url: "", subjectTemplate: " " }),
    );
    expect(v.ok).toBe(false);
    expect(v.errors.name).toBeTruthy();
    expect(v.errors.url).toBeTruthy();
    expect(v.errors.subjectTemplate).toBeTruthy();
  });

  it("rejects non-http(s) feed URLs", () => {
    expect(
      validateFeedSourceDraft(draft({ url: "ftp://feed" })).errors.url,
    ).toBeTruthy();
    expect(
      validateFeedSourceDraft(draft({ url: "example.com/rss" })).errors.url,
    ).toBeTruthy();
    expect(
      validateFeedSourceDraft(draft({ url: "http://x.test/rss" })).ok,
    ).toBe(true);
  });

  it("requires a picked id when targeting a list or segment", () => {
    expect(
      validateFeedSourceDraft(draft({ targetKind: "list", listId: "" })).errors
        .target,
    ).toBeTruthy();
    expect(
      validateFeedSourceDraft(draft({ targetKind: "segment", segmentId: "" }))
        .errors.target,
    ).toBeTruthy();
    expect(
      validateFeedSourceDraft(draft({ targetKind: "list", listId: "7" })).ok,
    ).toBe(true);
  });
});

describe("draftToInput", () => {
  it("trims strings and nulls the non-selected target", () => {
    const input = draftToInput(
      draft({
        name: " Blog ",
        url: " https://example.com/rss.xml ",
        subjectTemplate: " {{title}} ",
        targetKind: "list",
        listId: "7",
        segmentId: "s1", // stale from a previous radio flip — must drop
      }),
    );
    expect(input.name).toBe("Blog");
    expect(input.url).toBe("https://example.com/rss.xml");
    expect(input.subject_template).toBe("{{title}}");
    expect(input.list_id).toBe("7");
    expect(input.segment_id).toBeNull();
  });

  it('flipping back to "everyone" clears BOTH targets explicitly', () => {
    const input = draftToInput(
      draft({ targetKind: "all", listId: "7", segmentId: "s1" }),
    );
    expect(input.list_id).toBeNull();
    expect(input.segment_id).toBeNull();
  });
});

describe("sourceToDraft", () => {
  it("round-trips list targeting", () => {
    const d = sourceToDraft(source({ list_id: "7", segment_id: null }));
    expect(d.targetKind).toBe("list");
    expect(d.listId).toBe("7");
  });

  it("segment targeting wins when both ids are present", () => {
    const d = sourceToDraft(source({ list_id: "7", segment_id: "s1" }));
    expect(d.targetKind).toBe("segment");
    expect(d.segmentId).toBe("s1");
  });

  it("no targets → everyone; unknown schedule degrades to manual", () => {
    const d = sourceToDraft(
      source({ schedule: "hourly" as FeedSource["schedule"] }),
    );
    expect(d.targetKind).toBe("all");
    expect(d.schedule).toBe("manual");
  });
});

describe("summarizePollResult", () => {
  it("failed → bad tone with the server's error text verbatim", () => {
    const o = summarizePollResult(
      pollResult({ status: "failed", error: "fetch: 404 Not Found" }),
    );
    expect(o.tone).toBe("bad");
    expect(o.detail).toBe("fetch: 404 Not Found");
  });

  it("failed without error text still says something honest", () => {
    const o = summarizePollResult(pollResult({ status: "failed" }));
    expect(o.tone).toBe("bad");
    expect(o.detail).toBeTruthy();
  });

  it("new items + campaign id → good tone, DRAFT-only copy", () => {
    const o = summarizePollResult(
      pollResult({ new_items: 3, items_seen: 12, campaign_id: "c9" }),
    );
    expect(o.tone).toBe("good");
    expect(o.headline).toContain("3 new items");
    expect(o.detail).toMatch(/draft campaign/i);
    expect(o.detail).toMatch(/nothing sends automatically/i);
  });

  it("new items WITHOUT a campaign id never claims a draft exists", () => {
    const o = summarizePollResult(pollResult({ new_items: 1, items_seen: 4 }));
    expect(o.tone).toBe("good");
    expect(o.headline).toContain("1 new item");
    expect(o.detail).not.toMatch(/was created/i);
  });

  it("no new items → neutral, says no draft was created", () => {
    const o = summarizePollResult(
      pollResult({ status: "no_new_items", items_seen: 12 }),
    );
    expect(o.tone).toBe("neutral");
    expect(o.headline).toContain("No new items");
    expect(o.detail).toMatch(/no draft campaign/i);
  });
});

describe("run status rendering", () => {
  it("maps known statuses and passes unknown ones through", () => {
    expect(runStatusLabel("ok")).toBe("Succeeded");
    expect(runStatusLabel("succeeded")).toBe("Succeeded");
    expect(runStatusLabel("failed")).toBe("Failed");
    expect(runStatusLabel("no_new_items")).toBe("No new items");
    expect(runStatusLabel("rate_limited")).toBe("rate limited");
    expect(runStatusLabel(undefined)).toBe("—");
  });

  it("badge classes: failed=danger, ok=accent, unknown=plain", () => {
    expect(runStatusBadgeClass("failed")).toBe("badge danger");
    expect(runStatusBadgeClass("ok")).toBe("badge accent");
    expect(runStatusBadgeClass("no_new_items")).toBe("badge");
    expect(runStatusBadgeClass("whatever")).toBe("badge");
  });
});

describe("timestamp labels", () => {
  it('lastPolledLabel says "Never" for absent/garbage values', () => {
    expect(lastPolledLabel(null)).toBe("Never");
    expect(lastPolledLabel(undefined)).toBe("Never");
    expect(lastPolledLabel("not-a-date")).toBe("Never");
    expect(lastPolledLabel("2026-06-01T12:00:00Z")).not.toBe("Never");
  });

  it("fmtRunTimestamp em-dashes absent/garbage values", () => {
    expect(fmtRunTimestamp(null)).toBe("—");
    expect(fmtRunTimestamp("garbage")).toBe("—");
    expect(fmtRunTimestamp("2026-06-01T12:00:00Z")).not.toBe("—");
  });
});

describe("unwrapLists", () => {
  const lists = [{ id: 1, name: "Main" }];

  it("handles bare arrays, {items}, {results}, and Listmonk {data:{results}}", () => {
    expect(unwrapLists(lists)).toEqual(lists);
    expect(unwrapLists({ items: lists })).toEqual(lists);
    expect(unwrapLists({ results: lists })).toEqual(lists);
    expect(unwrapLists({ data: { results: lists } })).toEqual(lists);
    expect(unwrapLists({ data: lists })).toEqual(lists);
  });

  it("degrades to [] on junk", () => {
    expect(unwrapLists(null)).toEqual([]);
    expect(unwrapLists("nope")).toEqual([]);
    expect(unwrapLists({ data: { results: "nope" } })).toEqual([]);
  });
});
