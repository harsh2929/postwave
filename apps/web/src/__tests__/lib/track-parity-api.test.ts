// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  fetchText: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { get: mocks.get, post: mocks.post },
  fetchTextAuthed: mocks.fetchText,
}));

import {
  exportTrackEventsCsv,
  getTrackStats,
  listTrackEvents,
  parseTrackCatalog,
  parseTrackEvents,
  parseTrackPropertiesJson,
  parseTrackStats,
  sendSyntheticTrackEvent,
} from "@/lib/track-api";

const TENANT = "22222222-2222-4222-8222-222222222222";

function daily(days: number, total: number) {
  return Array.from({ length: days }, (_, index) => ({
    date: new Date(Date.UTC(2026, 7, 30 - (days - 1 - index)))
      .toISOString()
      .slice(0, 10),
    count: index === 0 ? total - (days - 1) : 1,
  }));
}

function event(id = 2) {
  return {
    id,
    tenantId: TENANT,
    subscriberId: "33333333-3333-4333-8333-333333333333",
    eventName: "checkout.started",
    properties: { source: "test", nested: { accepted: true } },
    occurredAt: "2026-08-29T12:00:00Z",
    receivedAt: "2026-08-29T12:00:01Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("track parity API", () => {
  it("accepts only dense reconciled UTC statistics", () => {
    const payload = {
      periodDays: 30,
      totalEvents: 100,
      uniqueSubscribers: 20,
      uniqueEventNames: 2,
      daily: daily(30, 100),
      timeZone: "UTC",
      asOf: "2026-08-30T10:00:00Z",
    };
    expect(parseTrackStats(payload)).toMatchObject({ totalEvents: 100 });
    expect(() => parseTrackStats({ ...payload, totalEvents: 101 })).toThrow(
      /reconcile/i,
    );
    expect(() =>
      parseTrackStats({ ...payload, timeZone: "Asia/Kolkata" }),
    ).toThrow(/malformed/i);
  });

  it("verifies catalogue scope, rows, unique names, and nested series", () => {
    const payload = {
      items: [
        {
          eventName: "checkout.started",
          count: 20,
          uniqueSubscribers: 12,
          firstSeen: "2026-08-02T10:00:00Z",
          lastSeen: "2026-08-29T10:00:00Z",
          daily: daily(7, 20),
        },
      ],
      totalDistinctEventNames: 1,
      periodDays: 30,
      dailySeriesPeriodDays: 7,
      eventBoundsScope: "period",
      timeZone: "UTC",
      asOf: "2026-08-30T10:00:00Z",
    };
    expect(parseTrackCatalog(payload).items[0]?.eventName).toBe(
      "checkout.started",
    );
    expect(() =>
      parseTrackCatalog({
        ...payload,
        totalDistinctEventNames: 2,
        items: [...payload.items, payload.items[0]],
      }),
    ).toThrow(/invalid row/i);
    expect(() =>
      parseTrackCatalog({ ...payload, eventBoundsScope: "workspace" }),
    ).toThrow(/malformed/i);
  });

  it("binds raw rows to the expected tenant and rejects unsafe properties", () => {
    expect(
      parseTrackEvents({ items: [event()] }, TENANT, 200).items,
    ).toHaveLength(1);
    expect(() =>
      parseTrackEvents(
        { items: [{ ...event(), tenantId: "another-tenant" }] },
        TENANT,
        200,
      ),
    ).toThrow(/invalid row/i);
    expect(() =>
      parseTrackEvents(
        {
          items: [
            {
              ...event(),
              properties: JSON.parse('{"__proto__":{"polluted":true}}'),
            },
          ],
        },
        TENANT,
        200,
      ),
    ).toThrow(/invalid row/i);
  });

  it("sends exact server filters with cancellation and verifies the period echo", async () => {
    const signal = new AbortController().signal;
    mocks.get
      .mockResolvedValueOnce({ items: [event()] })
      .mockResolvedValueOnce({
        periodDays: 30,
        totalEvents: 100,
        uniqueSubscribers: 20,
        uniqueEventNames: 2,
        daily: daily(30, 100),
        timeZone: "UTC",
        asOf: "2026-08-30T10:00:00Z",
      });
    await expect(
      listTrackEvents({
        tenantId: TENANT,
        filters: {
          eventName: "checkout.started",
          subscriberId: event().subscriberId,
          limit: 200,
        },
        signal,
      }),
    ).resolves.toMatchObject({ atLimit: false });
    expect(mocks.get).toHaveBeenNthCalledWith(1, "/api/v1/track/events", {
      query: {
        event_name: "checkout.started",
        subscriber_id: event().subscriberId,
        before: undefined,
        limit: 200,
      },
      signal,
    });
    await expect(getTrackStats({ days: 30, signal })).resolves.toMatchObject({
      periodDays: 30,
    });
  });

  it("bounds composer JSON and sends one stable body/header idempotency identity", async () => {
    expect(parseTrackPropertiesJson('{"safe":[1,true,null]}')).toEqual({
      safe: [1, true, null],
    });
    expect(() => parseTrackPropertiesJson("[]")).toThrow(/object/i);
    expect(() =>
      parseTrackPropertiesJson('{"constructor":{"prototype":true}}'),
    ).toThrow(/unsafe/i);

    mocks.post.mockResolvedValue({
      id: 55,
      subscriber_id: event().subscriberId,
    });
    await expect(
      sendSyntheticTrackEvent({
        subscriberId: event().subscriberId,
        eventName: "checkout_started",
        eventId: "019d4a38-1e40-7000-8000-000000000001",
        properties: { synthetic: true },
      }),
    ).resolves.toEqual({
      id: 55,
      subscriberId: event().subscriberId,
      eventId: "019d4a38-1e40-7000-8000-000000000001",
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/track",
      {
        subscriber_id: event().subscriberId,
        event_name: "checkout_started",
        event_id: "019d4a38-1e40-7000-8000-000000000001",
        properties: { synthetic: true },
      },
      {
        requireOnline: true,
        maxAttempts: 1,
        idempotencyKey: "019d4a38-1e40-7000-8000-000000000001",
      },
    );
  });

  it("downloads only a verified bounded CSV response and preserves truncation", async () => {
    mocks.fetchText.mockImplementation(
      async (
        _path: string,
        options: { onResponse?: (response: Response) => void },
      ) => {
        options.onResponse?.(
          new Response("", {
            status: 200,
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "x-postwave-truncated": "true",
              "x-postwave-export-limit": "10000",
            },
          }),
        );
        return "id,occurred_at,received_at,subscriber_id,event_name,properties_json\n";
      },
    );
    await expect(
      exportTrackEventsCsv({
        filters: {
          eventName: "checkout.started",
          occurredAfter: "2026-08-01T00:00:00Z",
        },
      }),
    ).resolves.toMatchObject({ truncated: true, serverLimit: 10_000 });
    expect(mocks.fetchText.mock.calls[0]?.[0]).toContain(
      "event_name=checkout.started",
    );
  });
});
