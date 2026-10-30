import { describe, it, expect } from "vitest";

import {
  EMPTY_REPLAY_CURSOR,
  REPLAY_PATH,
  advanceReplayCursor,
  parseReplayResponse,
  replayRequestPath,
  type ReplayCursor,
} from "./replay.js";

describe("advanceReplayCursor", () => {
  it("tracks the newest timestamp seen on the live stream", () => {
    // The live SSE payload carries `ts` but NOT sequence_id — the server's log
    // write is a best-effort hook decoupled from fanout, so a streaming client
    // has only a timestamp to resume from.
    let cursor: ReplayCursor = { sinceAt: null, sequenceId: null };
    cursor = advanceReplayCursor(cursor, { ts: "2026-08-04T09:00:00Z" });
    expect(cursor.sinceAt).toBe("2026-08-04T09:00:00Z");
    cursor = advanceReplayCursor(cursor, { ts: "2026-08-04T09:05:00Z" });
    expect(cursor.sinceAt).toBe("2026-08-04T09:05:00Z");
  });

  it("never moves BACKWARDS on an out-of-order event", () => {
    // Events can arrive out of order across a reconnect. Regressing the cursor
    // would replay a window the client already processed — harmless — but
    // worse, a later ADVANCE from the regressed point could skip the gap.
    let cursor: ReplayCursor = {
      sinceAt: "2026-08-04T09:05:00Z",
      sequenceId: null,
    };
    cursor = advanceReplayCursor(cursor, { ts: "2026-08-04T09:00:00Z" });
    expect(cursor.sinceAt).toBe("2026-08-04T09:05:00Z");
  });

  it("ignores an event with no usable timestamp", () => {
    const cursor: ReplayCursor = {
      sinceAt: "2026-08-04T09:05:00Z",
      sequenceId: null,
    };
    for (const bad of [{}, { ts: "" }, { ts: "not-a-date" }, { ts: null }]) {
      expect(advanceReplayCursor(cursor, bad as never)).toEqual(cursor);
    }
  });

  it("prefers an explicit sequence_id when replay supplies one", () => {
    // Replayed rows DO carry sequence_id; tracking it lets a client paginate a
    // backlog precisely instead of re-scanning by time.
    const cursor = advanceReplayCursor(
      { sinceAt: null, sequenceId: null },
      { ts: "2026-08-04T09:00:00Z", sequence_id: 42 },
    );
    expect(cursor.sequenceId).toBe(42);
  });

  it("never regresses the sequence id either", () => {
    const cursor = advanceReplayCursor(
      { sinceAt: null, sequenceId: 42 },
      { ts: "2026-08-04T09:00:00Z", sequence_id: 7 },
    );
    expect(cursor.sequenceId).toBe(42);
  });
});

describe("replayRequestPath", () => {
  it("uses the SEQUENCE cursor when one is known", () => {
    const path = replayRequestPath(
      { sinceAt: "2026-08-04T09:00:00Z", sequenceId: 42 },
      ["campaign.*"],
    );
    expect(path).toContain(`${REPLAY_PATH}?`);
    expect(path).toContain("since=42");
    // Sending both would be ambiguous; the server branches on since_at.
    expect(path).not.toContain("since_at=");
  });

  it("falls back to the TIME cursor for a client that was only streaming", () => {
    const path = replayRequestPath(
      { sinceAt: "2026-08-04T09:00:00Z", sequenceId: null },
      ["campaign.*"],
    );
    expect(path).toContain("since_at=2026-08-04T09%3A00%3A00Z");
    expect(path).not.toContain("since=");
  });

  it("returns null when there is no cursor at all", () => {
    // A client with no cursor has nothing to recover: replaying from zero would
    // deliver the entire retained log and invalidate every cache for nothing.
    expect(
      replayRequestPath({ sinceAt: null, sequenceId: null }, ["a.*"]),
    ).toBeNull();
  });

  it("encodes topics and bounds the limit", () => {
    const path = replayRequestPath(
      { sinceAt: null, sequenceId: 1 },
      ["campaign.*", "subscriber.*"],
      { limit: 9999 },
    );
    expect(path).toContain("topics=campaign.*%2Csubscriber.*");
    expect(path).toContain("limit=500"); // server's own maximum
  });

  it("drops topics the gateway would reject rather than sending them", () => {
    const path = replayRequestPath({ sinceAt: null, sequenceId: 1 }, [
      "campaign.*",
      "Campaign.Bad",
      "../x",
    ]);
    expect(path).toContain("topics=campaign.*");
    expect(path).not.toContain("Campaign.Bad");
  });
});

describe("parseReplayResponse", () => {
  const ok = {
    events: [
      { topic: "campaign.sent", ts: "2026-08-04T09:00:00Z", sequence_id: 7 },
    ],
    next_cursor: 7,
    next_since_at: "2026-08-04T09:00:00Z",
    has_more: false,
  };

  it("reads the page and its two cursors", () => {
    const page = parseReplayResponse(ok);
    expect(page.events).toHaveLength(1);
    expect(page.cursor).toEqual({
      sinceAt: "2026-08-04T09:00:00Z",
      sequenceId: 7,
    });
    expect(page.hasMore).toBe(false);
  });

  it("returns an empty page for a malformed body instead of throwing", () => {
    // A replay that fails must degrade to "no recovery", never crash the
    // reconnect path and leave the client with no live stream either.
    for (const bad of [null, undefined, {}, { events: "nope" }, 42]) {
      const page = parseReplayResponse(bad);
      expect(page.events).toEqual([]);
      expect(page.hasMore).toBe(false);
    }
  });

  it("drops event entries that are not usable", () => {
    const page = parseReplayResponse({
      ...ok,
      events: [{ topic: "campaign.sent", ts: "x" }, {}, { topic: 42 }, null],
    });
    expect(page.events).toEqual([{ topic: "campaign.sent", ts: "x" }]);
  });

  it("does not invent a cursor the server did not send", () => {
    const page = parseReplayResponse({ events: [], has_more: false });
    expect(page.cursor).toEqual({ sinceAt: null, sequenceId: null });
  });
});

// --- adversarial review, 2026-08-04 ------------------------------------------
// Three defects a review reproduced against the real client. Each one made
// recovery strictly WORSE than the silent gap it replaced, which is the only
// bar that matters for a best-effort path.

describe("cursor defects found by adversarial review", () => {
  it("does not accept next_cursor: 0 as a cursor", () => {
    // The server emits exactly this whenever a page scanned no rows, which is
    // every time-mode page on an idle tenant. Taken as a real cursor it means
    // `sequence_id > 0` — the oldest page of the entire retained log — and
    // because the sequence cursor is preferred, EVERY later reconnect asks for
    // it again. One idle reconnect converted the tab into a log replayer.
    const page = parseReplayResponse({
      events: [],
      next_cursor: 0,
      next_since_at: "",
      has_more: false,
    });
    expect(page.cursor.sequenceId).toBeNull();
  });

  it("a live event clears the sequence cursor it cannot advance", () => {
    // Live payloads carry `ts` and never `sequence_id`, so a sequence cursor
    // set by some earlier replay could never move again — while the stream
    // closes every 5 minutes, so the client reconnects and re-replays the whole
    // window it had just watched live. The cursor has to fall back to the one
    // clock both sides actually share.
    const afterReplay = { sinceAt: "2026-08-04T09:00:00Z", sequenceId: 500 };
    const afterLive = advanceReplayCursor(afterReplay, {
      ts: "2026-08-04T10:00:00Z",
    });
    expect(afterLive.sequenceId).toBeNull();
    expect(afterLive.sinceAt).toBe("2026-08-04T10:00:00Z");
    expect(replayRequestPath(afterLive, [])).toContain("since_at=");
  });

  it("keeps the sequence cursor while a replay walk is paginating", () => {
    // The same fold runs over replayed rows, which DO carry a sequence id.
    // Clearing it there would drop pagination back to the time cursor mid-walk.
    const walk = advanceReplayCursor(
      { sinceAt: "2026-08-04T09:00:00Z", sequenceId: 500 },
      { ts: "2026-08-04T09:30:00Z", sequence_id: 620 },
    );
    expect(walk.sequenceId).toBe(620);
  });

  it("can widen a time cursor to absorb inter-replica clock skew", () => {
    // `at` is stamped by the publishing replica; a lagging replica writes a row
    // whose `at` is already behind a cursor advanced from a leading one, and no
    // page will ever return it. Replay is idempotent, so re-reading a few
    // seconds costs nothing and closes a permanent hole.
    const path = replayRequestPath(
      { sinceAt: "2026-08-04T09:00:10Z", sequenceId: null },
      [],
      { skewGraceMs: 5_000 },
    );
    expect(path).toContain("since_at=2026-08-04T09%3A00%3A05.000Z");
  });

  it("ignores the skew grace when resuming by sequence", () => {
    // Sequence ids are assigned by the database, so they have no skew to
    // absorb — and widening an exact cursor would re-deliver a whole page.
    const path = replayRequestPath(
      { sinceAt: "2026-08-04T09:00:10Z", sequenceId: 42 },
      [],
      { skewGraceMs: 5_000 },
    );
    expect(path).toContain("since=42");
  });
});

describe("a sequence cursor is validated wherever it enters", () => {
  // parseReplayResponse already rejected a non-integer, zero or negative
  // `next_cursor`, and its comments spell out why. advanceReplayCursor — the
  // PRIMARY path, since it folds every live and replayed event — accepted any
  // finite number, so the same hostile values entered through the other door
  // and produced exactly the URLs those comments call catastrophic:
  //
  //   since=1.5  the gateway 400s, so every later recovery is rejected and the
  //              client stalls permanently with nothing said
  //   since=0    `sequence_id > 0` is the very start of the retained log — a
  //              full replay that invalidates every cache
  const at = "2026-08-16T00:00:00Z";

  it.each([
    ["a fractional id", 1.5],
    ["zero", 0],
    ["a negative id", -7],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a numeric string", "42"],
    ["null", null],
  ])("does not fold %s into the cursor", (_label, seq) => {
    const cursor = advanceReplayCursor(EMPTY_REPLAY_CURSOR, {
      ts: at,
      sequence_id: seq,
    });
    expect(cursor.sequenceId).toBeNull();
    // The time cursor must still advance — dropping the sequence id is not a
    // reason to lose the gap-recovery point entirely.
    expect(cursor.sinceAt).toBe(at);
    expect(replayRequestPath(cursor, [], {})).toContain("since_at=");
    expect(replayRequestPath(cursor, [], {})).not.toContain("since=");
  });

  it("still folds a real sequence id", () => {
    // Guard the guard: a predicate rejecting everything satisfies every
    // assertion above.
    const cursor = advanceReplayCursor(EMPTY_REPLAY_CURSOR, {
      ts: at,
      sequence_id: 42,
    });
    expect(cursor.sequenceId).toBe(42);
    expect(replayRequestPath(cursor, [], {})).toContain("since=42");
  });

  it("applies the same rule on both entry paths", () => {
    // The defect was one rule with two implementations. Assert they agree
    // rather than asserting each separately, so they cannot re-diverge.
    for (const value of [1.5, 0, -7, 42, 1]) {
      const viaEvent = advanceReplayCursor(EMPTY_REPLAY_CURSOR, {
        ts: at,
        sequence_id: value,
      }).sequenceId;
      const viaPage = parseReplayResponse({
        events: [],
        next_cursor: value,
        next_since_at: at,
      }).cursor.sequenceId;
      expect(viaEvent, `sequence_id ${value} disagreed between the two paths`).toBe(
        viaPage,
      );
    }
  });
});
