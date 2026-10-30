import { describe, expect, it, vi } from "vitest";

import { PostwaveClient } from "../src/index.js";
import {
  isSequenceVersion,
  sequenceIfMatch,
  sequencePositionPathSegment,
} from "../src/resources/sequences.js";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SequencesResource path safety", () => {
  it("validates regeneration positions before building a path", () => {
    expect(sequencePositionPathSegment(1)).toBe("1");
    expect(sequencePositionPathSegment(12)).toBe("12");
    expect(() => sequencePositionPathSegment(0)).toThrow(/positive integer/);
    expect(() => sequencePositionPathSegment(1.5)).toThrow(/positive integer/);
    expect(() => sequencePositionPathSegment(Number.NaN)).toThrow(/positive integer/);
  });

  it("encodes sequence IDs and validates positions for regenerate", async () => {
    const fetch = vi.fn(async () =>
      json({
        id: "email_1",
        position: 2,
        subject: "After",
        body: "Body",
      }),
    );
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });

    await pw.sequences.regenerate("seq/a", 2, { user_hint: "shorter" });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.moosewave.com/api/v1/voice/sequences/seq%2Fa/regenerate/2",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ user_hint: "shorter" }),
      }),
    );

    expect(() => pw.sequences.regenerate("seq/a", 0)).toThrow(/positive integer/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * The optimistic-concurrency header has ONE definition, and this pins its
 * exact bytes. `parseSequenceIfMatch` answers 428 without it and 400 for
 * anything that is not one strong ETag holding a positive integer, so a client
 * that re-implements the quoting turns every save on that client into a 400 —
 * the "412-handling bug on one surface only" failure this export exists to make
 * impossible.
 */
describe("sequence optimistic concurrency", () => {
  it("encodes a version as one strong ETag", () => {
    expect(sequenceIfMatch(1)).toBe('"1"');
    expect(sequenceIfMatch(42)).toBe('"42"');
  });

  it("refuses a version the server is certain to reject", () => {
    expect(() => sequenceIfMatch(0)).toThrow(/positive safe integer/);
    expect(() => sequenceIfMatch(-1)).toThrow(/positive safe integer/);
    expect(() => sequenceIfMatch(1.5)).toThrow(/positive safe integer/);
    expect(() => sequenceIfMatch(Number.NaN)).toThrow(/positive safe integer/);
    expect(() => sequenceIfMatch(Number.MAX_SAFE_INTEGER + 2)).toThrow(
      /positive safe integer/,
    );
  });

  it("isSequenceVersion agrees with the encoder, without throwing", () => {
    // A UI needs the predicate WITHOUT the throw, so it can disable a control
    // rather than crash a render.
    for (const good of [1, 2, 999]) {
      expect(isSequenceVersion(good)).toBe(true);
      expect(() => sequenceIfMatch(good)).not.toThrow();
    }
    for (const bad of [0, -1, 1.5, Number.NaN, null, undefined, "3"]) {
      expect(isSequenceVersion(bad)).toBe(false);
    }
  });

  it("sends the header on update and on delete", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ id: "s1", version: 3 }));
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });

    await pw.sequences.update("s1", { name: "Renamed" }, 2);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "PATCH",
      headers: expect.objectContaining({ "If-Match": '"2"' }),
    });

    await pw.sequences.delete("s1", 3);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: "DELETE",
      headers: expect.objectContaining({ "If-Match": '"3"' }),
    });
  });
});

describe("the sequence reads mobile needed and the SDK did not have", () => {
  it("builds a participants URL that omits every server default", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ items: [], total: 0, page: 1, per_page: 25 }));
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });

    await pw.sequences.participants("seq/a");
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.moosewave.com/api/v1/voice/sequences/seq%2Fa/participants",
    );

    await pw.sequences.participants("s1", {
      status: "active",
      page: 2,
      perPage: 50,
      sort: "last_event_at_asc",
    });
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.moosewave.com/api/v1/voice/sequences/s1/participants?status=active&sort=last_event_at_asc&page=2&per_page=50",
    );

    // page=1 IS the default; sending it makes two identical reads look
    // different in a log for no benefit.
    await pw.sequences.participants("s1", { page: 1 });
    expect(fetch.mock.calls[2]?.[0]).toBe(
      "https://api.moosewave.com/api/v1/voice/sequences/s1/participants",
    );
  });

  it("reads the funnel and the stuck report, encoding the id in both", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ items: [], threshold_days: 7 }));
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });

    await pw.sequences.funnel("seq/a");
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://api.moosewave.com/api/v1/voice/sequences/seq%2Fa/funnel",
    );

    await pw.sequences.stuck("seq/a");
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://api.moosewave.com/api/v1/voice/sequences/seq%2Fa/stuck",
    );

    await pw.sequences.stuck("s1", 14);
    expect(fetch.mock.calls[2]?.[0]).toBe(
      "https://api.moosewave.com/api/v1/voice/sequences/s1/stuck?days=14",
    );

    // A non-positive override is not an override — it must not become
    // `?days=0`, which the handler treats as "no override supplied" anyway
    // and which reads as a deliberate zero to anyone looking at the log.
    await pw.sequences.stuck("s1", 0);
    expect(fetch.mock.calls[3]?.[0]).toBe(
      "https://api.moosewave.com/api/v1/voice/sequences/s1/stuck",
    );
  });

  it("createDraft takes the no-LLM fork and never sends a template_id", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({ id: "s1", name: "Welcome", version: 1 }));
    const pw = new PostwaveClient({ apiKey: "k", tenantId: "t", fetch, retries: 0 });

    await pw.sequences.createDraft({ name: "Welcome" });

    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ steps: [], name: "Welcome" });
    // `template_id` would take the GENERATION branch, which answers 503 until a
    // durable worker is configured. `description` is not a field on the request
    // struct and the body is decoded with DisallowUnknownFields, so either one
    // turns a create into a guaranteed failure.
    expect(body).not.toHaveProperty("template_id");
    expect(body).not.toHaveProperty("description");
  });
});
