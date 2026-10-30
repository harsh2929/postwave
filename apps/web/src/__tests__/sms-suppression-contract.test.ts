// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
  decodeSmsSuppressions,
  isReversibleManualSmsSuppression,
  mergeSmsSuppressionPages,
} from "@/lib/sms-suppression-contract";

const TENANT = "11111111-1111-4111-8111-111111111111";
const DEMO_TENANT = "00000000-0000-0000-0000-000000000001";
const SNAPSHOT = "2026-08-21T10:00:00.123456789Z";

const manual = {
  id: "33333333-3333-4333-8333-333333333333",
  phone_e164: "+15552345678",
  reason: "manual",
  source: "manual",
  created_at: "2026-08-21T09:00:00.123456+00:00",
  reversible: true,
};
const locked = {
  id: "22222222-2222-4222-8222-222222222222",
  phone_e164: "+15559876543",
  reason: "stop_keyword",
  source: "twilio",
  created_at: "2026-08-21T08:00:00Z",
  reversible: false,
  locked_reason: "carrier_or_system_authority",
};

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    items: [manual, locked],
    total: 2,
    snapshotAt: SNAPSHOT,
    ...overrides,
  };
}

describe("web SMS suppression contract", () => {
  it("decodes tenant-bound RFC3339Nano rows and exact authority", () => {
    const page = decodeSmsSuppressions(envelope(), TENANT);
    expect(page.items).toHaveLength(2);
    expect(isReversibleManualSmsSuppression(page.items[0]!)).toBe(true);
    expect(isReversibleManualSmsSuppression(page.items[1]!)).toBe(false);
  });

  it("accepts the authoritative canonical non-v4 demo tenant", () => {
    expect(
      decodeSmsSuppressions(envelope({ tenantId: DEMO_TENANT }), DEMO_TENANT),
    ).toMatchObject({ tenantId: DEMO_TENANT });
  });

  it.each([
    [
      "wrong tenant",
      envelope({ tenantId: "99999999-9999-4999-8999-999999999999" }),
    ],
    ["malformed tenant", envelope({ tenantId: "tenant" })],
    [
      "removed phone alias",
      envelope({ items: [{ ...manual, phone: "+15552345678" }] }),
    ],
    [
      "removed event alias",
      envelope({ items: [{ ...manual, source_event_id: "evt" }] }),
    ],
    [
      "UUIDv1",
      envelope({
        items: [{ ...manual, id: "33333333-3333-1333-8333-333333333333" }],
      }),
    ],
    [
      "non-NXX exchange",
      envelope({ items: [{ ...manual, phone_e164: "+15551234567" }] }),
    ],
    [
      "PG timestamp text",
      envelope({
        items: [{ ...manual, created_at: "2026-08-21 09:00:00+00" }],
      }),
    ],
    [
      "RFC3339 offset beyond 14 hours",
      envelope({
        items: [{ ...manual, created_at: "2026-08-21T09:00:00+14:01" }],
      }),
    ],
    [
      "locked without reason",
      envelope({ items: [{ ...locked, locked_reason: undefined }] }),
    ],
    [
      "invented authority source",
      envelope({ items: [{ ...locked, source: "provider_webhook" }] }),
    ],
    [
      "invented locked reason",
      envelope({ items: [{ ...locked, locked_reason: "support_override" }] }),
    ],
    [
      "system marked reversible",
      envelope({ items: [{ ...locked, reversible: true }] }),
    ],
  ])("rejects %s", (_label, value) => {
    expect(() => decodeSmsSuppressions(value, TENANT)).toThrow(
      /Invalid SMS suppression response/u,
    );
  });

  it("binds returned rows to requested reason and exact-phone uniqueness", () => {
    expect(() =>
      decodeSmsSuppressions(
        envelope({ items: [manual], total: 1 }),
        TENANT,
        100,
        "complaint",
      ),
    ).toThrow(/Invalid SMS suppression response/u);
    expect(() =>
      decodeSmsSuppressions(
        envelope({ items: [manual], total: 2 }),
        TENANT,
        100,
        undefined,
        manual.phone_e164,
      ),
    ).toThrow(/Invalid SMS suppression response/u);
  });

  it("keeps pagination response-cutoff-bound and never invents terminal completeness", () => {
    const first = decodeSmsSuppressions(
      envelope({ items: [manual], total: 2, nextCursor: "v1.b3BhcXVl" }),
      TENANT,
      1,
    );
    const second = decodeSmsSuppressions(
      envelope({ items: [locked], total: 2 }),
      TENANT,
    );
    expect(mergeSmsSuppressionPages([first, second])).toMatchObject({
      total: 2,
      hasMore: false,
      items: [manual, locked],
    });
    expect(mergeSmsSuppressionPages([first])).toMatchObject({
      hasMore: true,
      total: 2,
    });
    const truncated = decodeSmsSuppressions(
      envelope({ items: [manual], total: 2 }),
      TENANT,
    );
    expect(() => mergeSmsSuppressionPages([truncated])).toThrow(
      /Invalid SMS suppression response/u,
    );
    expect(() =>
      mergeSmsSuppressionPages([
        first,
        { ...second, snapshotAt: "2026-08-21T11:00:00Z" },
      ]),
    ).toThrow(/Invalid SMS suppression response/u);
  });

  it("rejects cursor and projection-time poison plus exact-phone continuation", () => {
    for (const nextCursor of ["opaque", "v2.token", "v1.bad.token", "v1."]) {
      expect(() =>
        decodeSmsSuppressions(
          envelope({ items: [manual], total: 2, nextCursor }),
          TENANT,
          1,
        ),
      ).toThrow(/Invalid SMS suppression response/u);
    }
    for (const created_at of [
      "1999-12-31T23:59:59Z",
      "2100-01-01T00:00:00Z",
      "2000-01-01T00:00:00+14:00",
      "2099-12-31T23:59:59-14:00",
    ]) {
      expect(() =>
        decodeSmsSuppressions(
          envelope({ items: [{ ...manual, created_at }], total: 1 }),
          TENANT,
        ),
      ).toThrow(/Invalid SMS suppression response/u);
    }
    expect(() =>
      decodeSmsSuppressions(
        envelope({
          items: [manual],
          total: 2,
          nextCursor: "v1.b3BhcXVl",
        }),
        TENANT,
        1,
        undefined,
        manual.phone_e164,
      ),
    ).toThrow(/Invalid SMS suppression response/u);
  });
});
