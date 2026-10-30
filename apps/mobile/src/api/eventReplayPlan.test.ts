import { describe, expect, it } from "vitest";

import {
  buildEventReplayPath,
  EVENT_REPLAY_MAX_PAGES,
  parseEventReplayPage,
  planNextReplayStep,
} from "./eventReplayPlan";

describe("buildEventReplayPath", () => {
  it("omits topics so the server cursor stays monotonic", () => {
    expect(buildEventReplayPath(42, 200)).toBe(
      "/api/v1/events/replay?since=42&limit=200",
    );
    expect(buildEventReplayPath(42, 200)).not.toContain("topics");
  });

  it("clamps a hostile cursor or limit into the server's accepted range", () => {
    expect(buildEventReplayPath(-9, 0)).toBe(
      "/api/v1/events/replay?since=0&limit=1",
    );
    expect(buildEventReplayPath(Number.NaN, 10_000)).toBe(
      "/api/v1/events/replay?since=0&limit=500",
    );
    expect(buildEventReplayPath(7.9, 200.6)).toBe(
      "/api/v1/events/replay?since=7&limit=200",
    );
  });
});

describe("parseEventReplayPage", () => {
  it("normalises a well-formed page", () => {
    const page = parseEventReplayPage({
      events: [
        {
          sequence_id: 11,
          topic: "campaign.sent",
          at: "2026-07-25T10:00:00Z",
          payload: { id: "c1" },
        },
      ],
      next_cursor: 11,
      has_more: false,
    });
    expect(page).toEqual({
      events: [
        {
          sequenceId: 11,
          topic: "campaign.sent",
          at: "2026-07-25T10:00:00Z",
          payload: { id: "c1" },
        },
      ],
      nextCursor: 11,
      hasMore: false,
    });
  });

  it("returns null for a body that is not a replay page", () => {
    expect(parseEventReplayPage(null)).toBeNull();
    expect(parseEventReplayPage({ events: [] })).toBeNull();
    expect(parseEventReplayPage({ next_cursor: 3 })).toBeNull();
    expect(parseEventReplayPage({ events: {}, next_cursor: 3 })).toBeNull();
    expect(
      parseEventReplayPage({ events: [], next_cursor: "3" }),
    ).toBeNull();
  });

  it("drops malformed rows rather than the whole page", () => {
    const page = parseEventReplayPage({
      events: [null, { topic: "" }, { topic: "list.updated" }, 7],
      next_cursor: 4,
      has_more: true,
    });
    expect(page?.events).toEqual([
      { sequenceId: 0, topic: "list.updated", at: "" },
    ]);
    expect(page?.hasMore).toBe(true);
  });

  it("ignores a non-object payload", () => {
    const page = parseEventReplayPage({
      events: [{ topic: "audit.written", payload: [1, 2] }],
      next_cursor: 1,
    });
    expect(page?.events[0]).not.toHaveProperty("payload");
    expect(page?.hasMore).toBe(false);
  });
});

describe("planNextReplayStep", () => {
  const page = (nextCursor: number, hasMore: boolean) => ({
    events: [],
    nextCursor,
    hasMore,
  });

  it("stops with caught-up when the server has nothing more", () => {
    expect(
      planNextReplayStep({
        previousCursor: 5,
        pageIndex: 0,
        page: page(9, false),
        maxPages: EVENT_REPLAY_MAX_PAGES,
      }),
    ).toEqual({ cursor: 9, done: true, reason: "caught-up" });
  });

  it("continues while there is more and the cursor advances", () => {
    expect(
      planNextReplayStep({
        previousCursor: 5,
        pageIndex: 0,
        page: page(205, true),
        maxPages: 5,
      }),
    ).toEqual({ cursor: 205, done: false, reason: null });
  });

  it("stops when the cursor does not advance despite has_more", () => {
    // ReadSince advances `latest` only over matching rows, so a page with no
    // forward progress must not be requested again.
    expect(
      planNextReplayStep({
        previousCursor: 5,
        pageIndex: 0,
        page: page(5, true),
        maxPages: 5,
      }),
    ).toEqual({ cursor: 5, done: true, reason: "cursor-stalled" });
  });

  it("never rewinds the cursor", () => {
    const step = planNextReplayStep({
      previousCursor: 500,
      pageIndex: 0,
      page: page(12, true),
      maxPages: 5,
    });
    expect(step.cursor).toBe(500);
    expect(step.reason).toBe("cursor-stalled");
  });

  it("stops at the page budget and keeps the furthest cursor", () => {
    expect(
      planNextReplayStep({
        previousCursor: 100,
        pageIndex: 1,
        page: page(300, true),
        maxPages: 2,
      }),
    ).toEqual({ cursor: 300, done: true, reason: "page-budget" });
  });

  it("stops on a malformed page without moving the cursor", () => {
    expect(
      planNextReplayStep({
        previousCursor: 100,
        pageIndex: 0,
        page: null,
        maxPages: 5,
      }),
    ).toEqual({ cursor: 100, done: true, reason: "malformed" });
  });

  it("treats a zero page budget as one page", () => {
    expect(
      planNextReplayStep({
        previousCursor: 0,
        pageIndex: 0,
        page: page(10, true),
        maxPages: 0,
      }).done,
    ).toBe(true);
  });
});

// --- wire-contract change, 2026-08-04 ----------------------------------------
// The gateway now answers `next_cursor: null` instead of `0` when a page has no
// sequence cursor to hand back. The web client was folding that 0 in and
// resuming from `sequence_id > 0` — the oldest page of the whole retained log —
// on every reconnect. Mobile has its own replay client, so the fix has to be
// read on this side too: to THIS parser a null looked like a malformed body,
// which turned an ordinary "caught up, nothing to do" into an abort.

describe("next_cursor: null (gateway no longer answers 0)", () => {
  it("is a page with no cursor, not a malformed body", () => {
    const page = parseEventReplayPage({
      events: [],
      next_cursor: null,
      has_more: false,
    });
    expect(page).not.toBeNull();
    expect(page?.nextCursor).toBe(0);
  });

  it("still rejects a body with no cursor field at all", () => {
    // Absent is different from explicitly null: one is a shape this client has
    // never seen, the other is the gateway saying "there is no cursor".
    expect(parseEventReplayPage({ events: [], has_more: false })).toBeNull();
  });

  it("reports caught-up rather than malformed when the log is empty", () => {
    const page = parseEventReplayPage({
      events: [],
      next_cursor: null,
      has_more: false,
    });
    expect(
      planNextReplayStep({ previousCursor: 0, pageIndex: 0, page, maxPages: 5 }),
    ).toEqual({ cursor: 0, done: true, reason: "caught-up" });
  });
});
