import { describe, expect, it } from "vitest";

import {
  decodeSmsBroadcastProgress,
  decodeSmsBroadcastsPage,
  smsBroadcastAudienceLine,
  smsBroadcastBodyError,
  smsBroadcastNameError,
  smsBroadcastUpsertBody,
} from "./smsBroadcastWire";

const TENANT = "11111111-1111-4111-8111-111111111111";
const ID = "44444444-4444-4444-8444-444444444444";
const LIST = "55555555-5555-4555-8555-555555555555";
const AT = "2026-08-21T09:00:00Z";

function broadcast(over: Record<string, unknown> = {}) {
  return {
    id: ID,
    name: "August promo",
    body: "20% off this week only",
    list_ids: [],
    status: "draft",
    sent_count: 0,
    failed_count: 0,
    held_count: 0,
    segments_per_message: 1,
    created_at: AT,
    updated_at: AT,
    ...over,
  };
}

function page(over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    items: [broadcast()],
    snapshotAt: AT,
    broadcastDispatchAvailable: false,
    broadcastDispatchUnavailableReason: "sms_broadcast_dispatch_release_held",
    ...over,
  };
}

describe("validators", () => {
  it("requires a name and allows a bodyless draft", () => {
    expect(smsBroadcastNameError("August promo")).toBeNull();
    expect(smsBroadcastNameError("  ")).toContain("needs a name");
    expect(smsBroadcastBodyError("")).toBeNull();
    expect(smsBroadcastBodyError("hello")).toBeNull();
  });

  it("refuses a body over 10 segments", () => {
    expect(smsBroadcastBodyError("a".repeat(160 * 11))).toContain(
      "10 SMS segments",
    );
  });
});

describe("decodeSmsBroadcastsPage", () => {
  it("decodes items and the dispatch-hold reason", () => {
    const decoded = decodeSmsBroadcastsPage(page(), { tenantId: TENANT });
    expect(decoded.items[0]?.name).toBe("August promo");
    expect(decoded.dispatchAvailable).toBe(false);
    expect(decoded.dispatchUnavailableReason).toBe(
      "sms_broadcast_dispatch_release_held",
    );
  });

  it("refuses an inconsistent availability claim and unknown status", () => {
    expect(() =>
      decodeSmsBroadcastsPage(
        page({ broadcastDispatchAvailable: true }),
        { tenantId: TENANT },
      ),
    ).toThrow(/inconsistent/);
    expect(() =>
      decodeSmsBroadcastsPage(
        page({ items: [broadcast({ status: "queued" })] }),
        { tenantId: TENANT },
      ),
    ).toThrow(/status is unknown/);
  });
});

describe("audience line", () => {
  it("names exactly one dimension or its absence", () => {
    expect(
      smsBroadcastAudienceLine({ listIds: [LIST], tag: undefined, segmentId: undefined }),
    ).toBe("Audience: 1 list");
    expect(
      smsBroadcastAudienceLine({ listIds: [], segmentId: LIST, tag: undefined }),
    ).toBe("Audience: a segment");
    expect(
      smsBroadcastAudienceLine({ listIds: [], segmentId: undefined, tag: "vip" }),
    ).toBe("Audience: tag “vip”");
    expect(
      smsBroadcastAudienceLine({ listIds: [], segmentId: undefined, tag: undefined }),
    ).toBe("No audience selected yet");
  });
});

describe("smsBroadcastUpsertBody", () => {
  it("sends only supplied fields, trimmed", () => {
    expect(
      smsBroadcastUpsertBody({ name: "  August promo  ", body: " hi " }),
    ).toEqual({ name: "August promo", body: "hi" });
    expect(smsBroadcastUpsertBody({ tag: "vip" })).toEqual({ tag: "vip" });
  });

  it("enforces the one-audience-dimension rule before the request", () => {
    expect(() =>
      smsBroadcastUpsertBody(
        { tag: "vip" },
        { listIds: [LIST], segmentId: undefined },
      ),
    ).toThrow(/one audience dimension/);
    // Clearing the tag is always allowed.
    expect(
      smsBroadcastUpsertBody(
        { tag: "" },
        { listIds: [LIST], segmentId: undefined },
      ),
    ).toEqual({ tag: "" });
  });

  it("refuses an empty patch and an invalid name", () => {
    expect(() => smsBroadcastUpsertBody({})).toThrow(/Nothing to save/);
    expect(() => smsBroadcastUpsertBody({ name: " " })).toThrow(/needs a name/);
  });
});

describe("decodeSmsBroadcastProgress", () => {
  it("decodes and bounds the counters", () => {
    expect(
      decodeSmsBroadcastProgress({
        status: "sending",
        sent: 5,
        failed: 1,
        held: 0,
        total: 10,
      }),
    ).toEqual({ status: "sending", sent: 5, failed: 1, held: 0, total: 10 });
    expect(() =>
      decodeSmsBroadcastProgress({
        status: "sending",
        sent: 9,
        failed: 2,
        held: 0,
        total: 10,
      }),
    ).toThrow(/exceed the recorded total/);
  });
});
