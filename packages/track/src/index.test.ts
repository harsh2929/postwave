import { describe, expect, it, vi } from "vitest";

import { createTracker, TrackError } from "./index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createTracker", () => {
  it("POSTs the endpoint contract and returns the ack", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> =>
      jsonResponse({ accepted: true, recorded: true, id: "evt_1", deduped: false }),
    );
    const pw = createTracker({
      endpoint: "/api/public/track/event",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      idGenerator: () => "fixed-id",
    });

    const res = await pw.track({
      email: "Shopper@Example.com ",
      eventName: "Placed Order",
      eventType: "order",
      externalId: "cust_9",
      properties: { value: 49.99 },
      occurredAt: new Date("2026-07-16T00:00:00.000Z"),
    });

    expect(res).toEqual({ accepted: true, recorded: true, id: "evt_1", deduped: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("/api/public/track/event");
    const body = JSON.parse(init!.body as string);
    expect(body).toEqual({
      email: "Shopper@Example.com", // trimmed
      event_name: "Placed Order",
      source_event_id: "fixed-id",
      event_type: "order",
      external_id: "cust_9",
      properties: { value: 49.99 },
      occurred_at: "2026-07-16T00:00:00.000Z",
    });
  });

  it("auto-generates a source_event_id when none is given (idempotency)", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> =>
      jsonResponse({ accepted: true, recorded: true }),
    );
    const pw = createTracker({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      idGenerator: () => "auto-123",
    });
    await pw.track({ email: "a@b.com", eventName: "Viewed" });
    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string);
    expect(body.source_event_id).toBe("auto-123");
  });

  it("treats an unknown subscriber (recorded=false) as a non-error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ accepted: true, recorded: false }));
    const pw = createTracker({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await pw.track({ email: "ghost@nowhere.com", eventName: "Viewed" });
    expect(res.accepted).toBe(true);
    expect(res.recorded).toBe(false);
  });

  it("rejects with TrackError on a 4xx", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: "unknown_host", message: "unrecognized tracking host" } }, 401),
    );
    const pw = createTracker({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(pw.track({ email: "a@b.com", eventName: "Viewed" })).rejects.toMatchObject({
      name: "TrackError",
      status: 401,
      code: "unknown_host",
    });
  });

  it("requires an email before any network call", async () => {
    const fetchImpl = vi.fn();
    const pw = createTracker({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(pw.track({ email: "  ", eventName: "Viewed" })).rejects.toBeInstanceOf(TrackError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("every failure leaves through TrackError, not a raw runtime error", () => {
  // The module's contract is that a caller can catch TrackError to "surface
  // real failures". Three paths broke it — and the asymmetry is what made them
  // easy to miss: a 503 with a non-JSON body produced a clean TrackError,
  // while a 200 with the SAME body threw a raw SyntaxError, because only the
  // error path wrapped res.json().
  //
  // This library runs on customers' own pages, so an escaping SyntaxError is
  // not an internal detail; it lands in their error tracking, or breaks a page
  // that called track() without a catch.
  const respond = (body: string, status = 200) =>
    ({ ok: status < 400, status, json: async () => JSON.parse(body) }) as unknown as Response;

  const trackerFor = (body: string, status = 200) =>
    createTracker({
      fetchImpl: async () => respond(body, status),
      idGenerator: () => "fixed-id",
    });

  it("rejects an Invalid Date with a TrackError, not a RangeError", async () => {
    // `new Date(<something the page had>)` is the normal way to get one.
    const t = trackerFor("{}");
    await expect(
      t.track({ email: "a@b.c", eventName: "E", occurredAt: new Date("not a date") }),
    ).rejects.toBeInstanceOf(TrackError);
    await expect(
      t.track({ email: "a@b.c", eventName: "E", occurredAt: new Date("not a date") }),
    ).rejects.toMatchObject({ code: "invalid_occurred_at" });
  });

  it("still accepts a valid occurredAt", async () => {
    // Guard the guard: a validator that rejected every date would satisfy the
    // assertion above.
    const t = trackerFor('{"accepted":true,"recorded":true}');
    await expect(
      t.track({ email: "a@b.c", eventName: "E", occurredAt: new Date("2026-08-16T00:00:00Z") }),
    ).resolves.toMatchObject({ accepted: true, recorded: true });
  });

  it.each([
    ["an empty body", ""],
    ["an HTML interstitial", "<html>maintenance</html>"],
    ["a bare word", "OK"],
  ])("turns a 200 with %s into a TrackError", async (_label, body) => {
    const t = trackerFor(body);
    await expect(t.track({ email: "a@b.c", eventName: "E" })).rejects.toBeInstanceOf(
      TrackError,
    );
    await expect(t.track({ email: "a@b.c", eventName: "E" })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("keeps the 5xx path reporting its HTTP code, not invalid_response", async () => {
    // The two wrappers must stay distinguishable: "the server refused" and
    // "the server answered something I cannot read" call for different
    // handling, and collapsing them would lose the status.
    const t = trackerFor("not json at all", 503);
    await expect(t.track({ email: "a@b.c", eventName: "E" })).rejects.toMatchObject({
      code: "http_503",
      status: 503,
    });
  });
});
