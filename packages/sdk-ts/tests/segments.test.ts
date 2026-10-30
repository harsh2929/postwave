/**
 * segments.list() must hand back the envelope it promises, whatever the
 * server sends.
 *
 * WHY. The Go handler writes Repo.List's slice straight out, so
 * `GET /api/v1/segments` responds with a BARE ARRAY while this method's
 * signature says `{ items, next_cursor }`. Probed against a live API on
 * 2026-08-19 to confirm it is still true, not folklore.
 *
 * The mismatch fails silently and expensively: a caller writing
 * `page.items.map(...)` gets `undefined` and renders an EMPTY SEGMENT LIST
 * indistinguishable from a workspace that genuinely has none. apps/mobile hit
 * this and had to abandon the SDK for segments entirely
 * (apps/mobile/src/api/segments.ts documents it).
 */
import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function clientReturning(body: unknown) {
  const fetch = vi.fn(async () => json(body));
  return new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });
}

const SEGMENT = { id: "s1", name: "Engaged", description: "" };

describe("SegmentsResource.list", () => {
  it("wraps the BARE ARRAY the server actually sends", async () => {
    const page = await clientReturning([SEGMENT]).segments.list();
    expect(page.items).toEqual([SEGMENT]);
    expect(page.next_cursor).toBeNull();
  });

  it("still accepts the envelope, if the server ever sends one", async () => {
    const page = await clientReturning({
      items: [SEGMENT],
      next_cursor: "c2",
    }).segments.list();
    expect(page.items).toEqual([SEGMENT]);
    expect(page.next_cursor).toBe("c2");
  });

  it("never returns a non-array `items` for a caller to .map()", async () => {
    for (const body of [null, {}, { items: null }, { items: { 0: SEGMENT } }]) {
      const page = await clientReturning(body).segments.list();
      expect(Array.isArray(page.items)).toBe(true);
    }
  });
});
