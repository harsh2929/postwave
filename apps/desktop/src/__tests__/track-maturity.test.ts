import { describe, expect, it } from "vitest";

import {
  boundedJsonPreview,
  isConfirmedRevocation,
  isProductEvent,
  isUncertainMutationFailure,
  parseConversionKeys,
  parseConversionRows,
  parseCreatedSecret,
  parseProductEventCatalog,
  parseProductEventStats,
  parseProductEvents,
  parseSubscriberChoices,
  safeTrackFailure,
} from "../components/track/track-maturity";

const event = {
  id: "event-complete-id",
  eventName: "checkout.completed",
  subscriberId: "subscriber-complete-id",
  properties: { plan: "enterprise" },
  occurredAt: "2026-07-16T05:15:30.000Z",
};

describe("Track wire validation", () => {
  it("distinguishes verified empty lists from malformed event envelopes", () => {
    expect(parseProductEvents({ items: [] })).toEqual([]);
    expect(parseProductEvents({ items: [event] })).toEqual([event]);
    expect(parseProductEvents({ items: [{ ...event, id: null }] })).toBeNull();
    expect(parseProductEvents({ unexpected: [] })).toBeNull();
    expect(isProductEvent({ ...event, properties: [] })).toBe(false);
  });

  it("requires complete, finite catalog and statistics evidence", () => {
    const daily = [
      { date: "2026-07-10", count: 0 },
      { date: "2026-07-11", count: 0 },
      { date: "2026-07-12", count: 1 },
      { date: "2026-07-13", count: 0 },
      { date: "2026-07-14", count: 0 },
      { date: "2026-07-15", count: 0 },
      { date: "2026-07-16", count: 9 },
    ];
    const catalogMetadata = {
      totalDistinctEventNames: 1,
      periodDays: 7,
      dailySeriesPeriodDays: 7,
      eventBoundsScope: "period",
      timeZone: "UTC",
      asOf: "2026-07-16T12:00:00Z",
    };
    expect(
      parseProductEventCatalog({
        ...catalogMetadata,
        items: [
          {
            eventName: "checkout.completed",
            count: 9,
            uniqueSubscribers: 7,
            firstSeen: "2026-07-15T00:00:00Z",
            lastSeen: "2026-07-16T00:00:00Z",
            daily,
          },
        ],
      }),
    ).toMatchObject({ items: [{ eventName: "checkout.completed" }] });
    expect(
      parseProductEventCatalog({
        ...catalogMetadata,
        items: [{ eventName: "checkout.completed", count: Number.NaN }],
      }),
    ).toBeNull();
    expect(
      parseProductEventStats({
        periodDays: 7,
        totalEvents: 9,
        uniqueSubscribers: 7,
        uniqueEventNames: 1,
        daily,
        timeZone: "UTC",
        asOf: "2026-07-16T12:00:00Z",
      }),
    ).not.toBeNull();
    expect(
      parseProductEventStats({
        periodDays: 7,
        totalEvents: -1,
        uniqueSubscribers: 7,
        uniqueEventNames: 1,
        daily,
        timeZone: "UTC",
        asOf: "2026-07-16T12:00:00Z",
      }),
    ).toBeNull();
    expect(
      parseProductEventStats({
        periodDays: 0,
        totalEvents: 0,
        uniqueSubscribers: 0,
        uniqueEventNames: 0,
        daily: [],
        timeZone: "UTC",
        asOf: "2026-07-16T12:00:00Z",
      }),
    ).toBeNull();
    expect(
      parseProductEventCatalog({
        ...catalogMetadata,
        totalDistinctEventNames: 201,
        items: Array.from({ length: 201 }, () => ({
          eventName: "checkout.completed",
          count: 1,
          uniqueSubscribers: 1,
          firstSeen: "2026-07-15T00:00:00Z",
          lastSeen: "2026-07-16T00:00:00Z",
          daily,
        })),
      }),
    ).toBeNull();
  });

  it("accepts only bounded subscriber choices used by the picker", () => {
    expect(
      parseSubscriberChoices({
        items: [{ id: "subscriber-1", email: "person@example.com" }],
      }),
    ).toHaveLength(1);
    expect(
      parseSubscriberChoices({ items: [{ id: {}, email: 42 }] }),
    ).toBeNull();
  });

  it("rejects malformed conversion and credential responses", () => {
    const conversion = {
      id: 9,
      tenant_id: "tenant-1",
      subscriber_email: "person@example.com",
      event_name: "purchase",
      amount_cents: 4900,
      currency: "USD",
      campaign_id: "campaign-1",
      attributed_via: "last_touch",
      properties: { sku: "PW-1" },
      occurred_at: "2026-07-16T05:15:30.000Z",
    };
    const key = {
      id: "key-1",
      tenant_id: "tenant-1",
      label: "checkout backend",
      prefix: "pwck_safe",
      created_at: "2026-07-16T05:15:30.000Z",
    };
    expect(parseConversionRows([conversion])).toEqual([conversion]);
    expect(
      parseConversionRows([{ ...conversion, amount_cents: Infinity }]),
    ).toBeNull();
    expect(
      parseConversionRows([{ ...conversion, attributed_via: "certain" }]),
    ).toBeNull();
    expect(parseConversionKeys([key])).toEqual([key]);
    expect(
      parseConversionKeys([{ ...key, label: "x".repeat(121) }]),
    ).toBeNull();
    expect(parseCreatedSecret({ plaintext: "pw_secret" })).toBe("pw_secret");
    expect(parseCreatedSecret({ plaintext: "x".repeat(4_097) })).toBeNull();
    expect(isConfirmedRevocation({ ok: true })).toBe(true);
    expect(isConfirmedRevocation({ ok: false })).toBe(false);
  });
});

describe("Track safe presentation", () => {
  it("never reflects backend messages and keeps only safe diagnostics", () => {
    const rendered = safeTrackFailure(
      {
        message: "postgres password=server-secret",
        code: "unsafe code with spaces",
        requestId: "req-safe-123",
      },
      "The operation could not be verified.",
    );
    expect(rendered).toContain("The operation could not be verified.");
    expect(rendered).toContain("Reference: req-safe-123.");
    expect(rendered).not.toContain("postgres");
    expect(rendered).not.toContain("unsafe code");
  });

  it("distinguishes uncertain write acknowledgements from known rejections", () => {
    expect(
      isUncertainMutationFailure({
        kind: "network",
        code: "connection_reset",
      }),
    ).toBe(true);
    expect(isUncertainMutationFailure({ kind: "parse" })).toBe(true);
    expect(
      isUncertainMutationFailure({ kind: "network", code: "offline" }),
    ).toBe(false);
    expect(isUncertainMutationFailure({ status: 422 })).toBe(false);
  });

  it("bounds large or cyclic property previews", () => {
    expect(boundedJsonPreview({ value: "x".repeat(100) }, 40)).toContain(
      "Preview truncated",
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(boundedJsonPreview(cyclic)).toBe(
      "Properties could not be displayed safely.",
    );
  });
});
