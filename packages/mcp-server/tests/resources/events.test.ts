// SPDX-License-Identifier: MIT
import { describe, it, expect, vi } from "vitest";

import {
  collectBatch,
  eventsStreamTemplate,
  parseEventsQuery,
} from "../../src/resources/events.js";

function makeStreamingClient(events: unknown[], opts: { delayMs?: number } = {}) {
  const stream = vi.fn(
    async function* (_p: {
      event_type?: string;
      campaign?: string;
      signal?: AbortSignal;
    }) {
      for (const e of events) {
        if (opts.delayMs) {
          await new Promise((r) => setTimeout(r, opts.delayMs));
        }
        yield e;
      }
    },
  );
  return { client: { events: { stream } }, stream };
}

describe("parseEventsQuery", () => {
  it("returns empty object for missing query", () => {
    expect(parseEventsQuery(undefined)).toEqual({});
    expect(parseEventsQuery("")).toEqual({});
  });

  it("parses type and campaign", () => {
    expect(parseEventsQuery("type=opened&campaign=cmp_1")).toEqual({
      type: "opened",
      campaign: "cmp_1",
    });
  });

  it("decodes URL-encoded values", () => {
    expect(parseEventsQuery("campaign=cmp%5F1&type=email.opened")).toEqual({
      type: "email.opened",
      campaign: "cmp_1",
    });
  });

  it("ignores unknown keys and empty values", () => {
    expect(parseEventsQuery("foo=bar&type=&campaign=ok")).toEqual({
      campaign: "ok",
    });
  });

  it("ignores malformed or unsafe query values", () => {
    expect(parseEventsQuery("campaign=%E0%A4%A&type=opened")).toEqual({
      type: "opened",
    });
    expect(parseEventsQuery("campaign=hello%20world&type=clicked")).toEqual({
      type: "clicked",
    });
    expect(parseEventsQuery("campaign=cmp_1\\evil&type=clicked")).toEqual({});
  });
});

describe("collectBatch", () => {
  it("returns up to MAX_BATCH events from the stream", async () => {
    const events = Array.from({ length: 75 }, (_, i) => ({
      id: `e_${i}`,
      ts: "2026-05-01T00:00:00Z",
      event_type: "opened",
    }));
    const { client, stream } = makeStreamingClient(events);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const batch = await collectBatch(client as any, {});
    expect(batch).toHaveLength(50);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("forwards filters to the SDK", async () => {
    const { client, stream } = makeStreamingClient([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await collectBatch(client as any, { type: "clicked", campaign: "cmp_42" });
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: "clicked", campaign: "cmp_42" }),
    );
  });

  it("respects the soft deadline and returns what it has so far", async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({ id: `e_${i}` }));
    const { client } = makeStreamingClient(events, { delayMs: 50 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const batch = await collectBatch(client as any, {}, { deadlineMs: 80 });
    expect(batch.length).toBeLessThanOrEqual(5);
  });
});

describe("eventsStreamTemplate", () => {
  it("matches the templated URI and returns parsed events", async () => {
    const events = [
      { id: "e_1", ts: "2026-05-01T00:00:00Z", event_type: "opened" },
      { id: "e_2", ts: "2026-05-01T00:00:01Z", event_type: "clicked" },
    ];
    const { client } = makeStreamingClient(events);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tmpl = eventsStreamTemplate(client as any);

    expect(tmpl.uriTemplate).toBe("moosewave://events/stream{?type,campaign}");
    expect(tmpl.mimeType).toBe("application/json");

    const m = "moosewave://events/stream?type=opened&campaign=cmp_1".match(
      tmpl.pattern,
    );
    expect(m).not.toBeNull();
    const result = (await tmpl.read(m!)) as unknown[];
    expect(result).toHaveLength(2);
    expect((result[0] as { id: string }).id).toBe("e_1");
  });

  it("matches the bare URI without query", async () => {
    const { client } = makeStreamingClient([{ id: "e_1" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tmpl = eventsStreamTemplate(client as any);
    const m = "moosewave://events/stream".match(tmpl.pattern);
    expect(m).not.toBeNull();
    const result = (await tmpl.read(m!)) as unknown[];
    expect(result).toHaveLength(1);
  });
});
