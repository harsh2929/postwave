import { describe, expect, it, vi } from "vitest";

import { runEventReplay } from "./eventReplay";
import type { MobileEventBusEvent } from "./eventBus";

type Page = { events: unknown[]; next_cursor: number; has_more: boolean };

function fakeServer(pages: Page[]) {
  const paths: string[] = [];
  let index = 0;
  const request = vi.fn(async (path: string) => {
    paths.push(path);
    const page = pages[index] ?? pages.at(-1);
    index += 1;
    return { data: page, error: null };
  });
  return { paths, request };
}

function row(sequenceId: number, topic: string) {
  return {
    sequence_id: sequenceId,
    topic,
    at: "2026-07-25T09:00:00Z",
    payload: { id: `e${sequenceId}` },
  };
}

describe("runEventReplay", () => {
  it("discovery walk advances the cursor without dispatching anything", async () => {
    const server = fakeServer([
      { events: [row(1, "campaign.sent")], next_cursor: 1, has_more: false },
    ]);
    const onEvent = vi.fn();
    const result = await runEventReplay({
      cursor: null,
      onEvent,
      request: server.request,
    });
    expect(result.discovery).toBe(true);
    expect(result.cursor).toBe(1);
    expect(result.read).toBe(1);
    expect(result.dispatched).toBe(0);
    expect(onEvent).not.toHaveBeenCalled();
    expect(server.paths[0]).toBe("/api/v1/events/replay?since=0&limit=500");
  });

  it("gap walk dispatches every recovered event in order", async () => {
    const server = fakeServer([
      {
        events: [row(11, "campaign.sent"), row(12, "subscriber.added")],
        next_cursor: 12,
        has_more: false,
      },
    ]);
    const seen: MobileEventBusEvent[] = [];
    const result = await runEventReplay({
      cursor: 10,
      onEvent: (event) => seen.push(event),
      request: server.request,
    });
    expect(result.dispatched).toBe(2);
    expect(result.cursor).toBe(12);
    expect(result.reason).toBe("caught-up");
    expect(seen.map((e) => e.topic)).toEqual([
      "campaign.sent",
      "subscriber.added",
    ]);
    expect(seen[0]?.payload).toEqual({ id: "e11" });
    expect(server.paths[0]).toBe("/api/v1/events/replay?since=10&limit=200");
  });

  it("follows has_more across pages up to the budget", async () => {
    const server = fakeServer([
      { events: [row(11, "list.updated")], next_cursor: 11, has_more: true },
      { events: [row(21, "list.updated")], next_cursor: 21, has_more: true },
      { events: [row(31, "list.updated")], next_cursor: 31, has_more: true },
      { events: [row(41, "list.updated")], next_cursor: 41, has_more: true },
      { events: [row(51, "list.updated")], next_cursor: 51, has_more: true },
      { events: [row(61, "list.updated")], next_cursor: 61, has_more: true },
    ]);
    const result = await runEventReplay({
      cursor: 1,
      onEvent: vi.fn(),
      request: server.request,
    });
    expect(server.request).toHaveBeenCalledTimes(5);
    expect(result.reason).toBe("page-budget");
    expect(result.cursor).toBe(51);
    expect(server.paths[1]).toBe("/api/v1/events/replay?since=11&limit=200");
  });

  it("stops when the server reports more but the cursor does not advance", async () => {
    // ReadSince filters AFTER the SQL LIMIT, so a page can report has_more
    // while leaving next_cursor untouched. Walking again would loop forever.
    const server = fakeServer([
      { events: [], next_cursor: 7, has_more: true },
    ]);
    const result = await runEventReplay({
      cursor: 7,
      onEvent: vi.fn(),
      request: server.request,
    });
    expect(server.request).toHaveBeenCalledTimes(1);
    expect(result.reason).toBe("cursor-stalled");
    expect(result.cursor).toBe(7);
  });

  it("keeps the previous cursor when the request fails", async () => {
    const request = vi.fn(async () => ({
      data: null,
      error: { status: 503, message: "unavailable" },
    }));
    const onEvent = vi.fn();
    const result = await runEventReplay({ cursor: 99, onEvent, request });
    expect(result).toMatchObject({
      cursor: 99,
      dispatched: 0,
      reason: "request-failed",
    });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("stops on a malformed page without moving the cursor", async () => {
    const request = vi.fn(async () => ({ data: { nope: true }, error: null }));
    const result = await runEventReplay({ cursor: 4, request });
    expect(result).toMatchObject({ cursor: 4, reason: "malformed" });
  });

  it("never rewinds a cursor the server reports lower than ours", async () => {
    const server = fakeServer([
      { events: [row(2, "audit.written")], next_cursor: 2, has_more: false },
    ]);
    const result = await runEventReplay({
      cursor: 500,
      onEvent: vi.fn(),
      request: server.request,
    });
    expect(result.cursor).toBe(500);
  });
});
