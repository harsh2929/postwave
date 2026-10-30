import { describe, expect, it } from "vitest";

import {
  deviceHandle,
  deviceHandleSpoken,
  isReversibleManualPushSuppression,
  mergePushSuppressionPages,
  parsePushSuppressionRemovalReceipt,
  parsePushSuppressions,
  pushPlatformLabel,
  pushReasonHint,
  pushReasonLabel,
  pushUnsuppressCopy,
  PUSH_PLATFORM_FILTERS,
  PUSH_PLATFORMS,
  PUSH_SUPPRESSION_REASONS,
  PUSH_SUPPRESSION_SOURCES,
} from "./pushSuppressions";

const TENANT = "11111111-1111-4111-8111-111111111111";
const MANUAL_ID = "33333333-3333-4333-8333-333333333333";
const LOCKED_ID = "22222222-2222-4222-8222-222222222222";
const SNAPSHOT = "2026-08-29T10:00:00Z";

function manualRow(over: Record<string, unknown> = {}) {
  return {
    id: MANUAL_ID,
    tenant_id: TENANT,
    device_token_hash: "0123456789abcdef",
    platform: "apns",
    reason: "manual",
    source: "dashboard",
    created_at: "2026-08-29T09:00:00Z",
    updated_at: "2026-08-29T09:00:00Z",
    version: 4,
    reversible: true,
    ...over,
  };
}

function lockedRow(over: Record<string, unknown> = {}) {
  return {
    id: LOCKED_ID,
    tenant_id: TENANT,
    device_token_hash: "fedcba9876543210",
    platform: "fcm",
    reason: "user_opt_out",
    source: "user",
    created_at: "2026-08-29T08:00:00Z",
    updated_at: "2026-08-29T08:30:00Z",
    version: 2,
    reversible: false,
    locked_reason: "user_opt_out_authority",
    ...over,
  };
}

function envelope(items: unknown[], over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    items,
    total: items.length,
    snapshotAt: SNAPSHOT,
    ...over,
  };
}

describe("Route43 vocabulary", () => {
  it("matches the server platform and reason enums", () => {
    expect([...PUSH_PLATFORMS]).toEqual(["apns", "fcm", "web"]);
    expect([...PUSH_SUPPRESSION_REASONS]).toEqual([
      "manual",
      "unregistered",
      "expired",
      "complaint",
      "user_opt_out",
    ]);
    expect([...PUSH_SUPPRESSION_SOURCES]).toEqual([
      "dashboard",
      "provider",
      "user",
      "complaint",
      "legacy",
    ]);
    expect(PUSH_PLATFORM_FILTERS.map((item) => item.key)).toEqual([
      "all",
      "apns",
      "fcm",
      "web",
    ]);
  });
});

describe("parsePushSuppressions", () => {
  it("strictly decodes tenant-bound manual and locked authority rows", () => {
    const page = parsePushSuppressions(
      envelope([manualRow(), lockedRow()]),
      TENANT,
    );
    expect(page.total).toBe(2);
    expect(page.items[0]).toMatchObject({
      id: MANUAL_ID,
      tenantId: TENANT,
      deviceTokenHash: "0123456789abcdef",
      version: 4,
      reversible: true,
    });
    expect(isReversibleManualPushSuppression(page.items[0]!)).toBe(true);
    expect(page.items[1]).toMatchObject({
      lockedReason: "user_opt_out_authority",
      reversible: false,
    });
    expect(isReversibleManualPushSuppression(page.items[1]!)).toBe(false);
  });

  it("accepts every exact finite server authority projection", () => {
    const variants = [
      {
        source: "provider",
        reason: "unregistered",
        locked_reason: "provider_authority",
      },
      {
        source: "provider",
        reason: "expired",
        locked_reason: "provider_authority",
      },
      {
        source: "user",
        reason: "user_opt_out",
        locked_reason: "user_opt_out_authority",
      },
      {
        source: "complaint",
        reason: "complaint",
        locked_reason: "complaint_authority",
      },
      {
        source: "legacy",
        reason: "manual",
        locked_reason: "legacy_authority_requires_review",
      },
    ];
    for (const variant of variants) {
      expect(
        parsePushSuppressions(envelope([lockedRow(variant)]), TENANT).items[0],
      ).toMatchObject({
        source: variant.source,
        reason: variant.reason,
        lockedReason: variant.locked_reason,
        reversible: false,
      });
    }
  });

  it("accepts revision-snapshot rows after clock rollback but keeps row time ordered", () => {
    const futureDated = manualRow({
      created_at: "2026-08-29T11:00:00Z",
      updated_at: "2026-08-29T11:00:01Z",
    });
    expect(
      parsePushSuppressions(
        envelope([futureDated], { snapshotAt: "2026-08-29T10:00:00Z" }),
        TENANT,
      ).items[0],
    ).toMatchObject({
      createdAt: "2026-08-29T11:00:00Z",
      updatedAt: "2026-08-29T11:00:01Z",
    });
    expect(() =>
      parsePushSuppressions(
        envelope([
          manualRow({
            created_at: "2026-08-29T11:00:01Z",
            updated_at: "2026-08-29T11:00:00Z",
          }),
        ]),
        TENANT,
      ),
    ).toThrow();
  });

  it("fails the whole page on tenant drift, unknown fields, or non-16-hex fingerprints", () => {
    expect(() => parsePushSuppressions(envelope([]), "tenant")).toThrow();
    expect(() =>
      parsePushSuppressions(
        { ...envelope([]), tenantId: "00000000-0000-0000-0000-000000000001" },
        TENANT,
      ),
    ).toThrow();
    expect(() =>
      parsePushSuppressions(envelope([manualRow({ extra: true })]), TENANT),
    ).toThrow();
    expect(() =>
      parsePushSuppressions(
        envelope([manualRow({ device_token_hash: "a".repeat(64) })]),
        TENANT,
      ),
    ).toThrow();
  });

  it("rejects authority projections that make locked rows reversible", () => {
    expect(() =>
      parsePushSuppressions(
        envelope([lockedRow({ reversible: true, locked_reason: undefined })]),
        TENANT,
      ),
    ).toThrow();
    expect(() =>
      parsePushSuppressions(
        envelope([manualRow({ locked_reason: "authority_requires_review" })]),
        TENANT,
      ),
    ).toThrow();
    expect(() =>
      parsePushSuppressions(
        envelope([lockedRow({ source: "preference_center" })]),
        TENANT,
      ),
    ).toThrow();
    expect(() =>
      parsePushSuppressions(
        envelope([lockedRow({ locked_reason: "provider_authority" })]),
        TENANT,
      ),
    ).toThrow();
    expect(() =>
      parsePushSuppressions(
        envelope([
          lockedRow({
            source: "provider",
            reason: "complaint",
            locked_reason: "provider_authority",
          }),
        ]),
        TENANT,
      ),
    ).toThrow();
    expect(() =>
      parsePushSuppressions(
        envelope([
          lockedRow({
            source: "legacy",
            locked_reason: "complaint_authority",
          }),
        ]),
        TENANT,
      ),
    ).toThrow();
  });

  it("merges only one tenant/snapshot/total and proves the final count", () => {
    const first = parsePushSuppressions(
      envelope([manualRow()], { total: 2, nextCursor: "eyJ2IjoxfQ" }),
      TENANT,
      1,
    );
    const second = parsePushSuppressions(
      envelope([lockedRow()], { total: 2 }),
      TENANT,
      1,
    );
    expect(mergePushSuppressionPages([first, second])).toMatchObject({
      total: 2,
      hasMore: false,
      items: [{ id: MANUAL_ID }, { id: LOCKED_ID }],
    });
    expect(() =>
      mergePushSuppressionPages([
        { ...first, snapshotAt: "2026-08-29T09:59:00Z" },
        second,
      ]),
    ).toThrow();
  });
});

describe("versioned removal receipt", () => {
  it("requires exact tenant, id, next version, and stillSuppressed boolean", () => {
    const receipt = {
      ok: true,
      tenantId: TENANT,
      id: MANUAL_ID,
      version: 5,
      stillSuppressed: true,
    };
    expect(
      parsePushSuppressionRemovalReceipt(receipt, {
        tenantId: TENANT,
        id: MANUAL_ID,
        version: 4,
      }),
    ).toEqual(receipt);
    expect(() =>
      parsePushSuppressionRemovalReceipt(
        { ...receipt, version: 4 },
        {
          tenantId: TENANT,
          id: MANUAL_ID,
          version: 4,
        },
      ),
    ).toThrow();
    expect(() =>
      parsePushSuppressionRemovalReceipt(
        { ...receipt, extra: 1 },
        {
          tenantId: TENANT,
          id: MANUAL_ID,
          version: 4,
        },
      ),
    ).toThrow();
  });
});

describe("truthful copy", () => {
  it("names customer providers and never promises a resumed send", () => {
    expect(pushPlatformLabel("apns")).toBe("iOS / APNs");
    expect(pushPlatformLabel("fcm")).toBe("Android / FCM");
    expect(pushReasonLabel("user_opt_out")).toMatch(/authority/iu);
    expect(pushReasonHint("unregistered")).toMatch(
      /feedback is not available/iu,
    );
    expect(pushUnsuppressCopy().message).toMatch(
      /delivery remains release-held/iu,
    );
    expect(pushUnsuppressCopy().message).not.toMatch(/attempted again/iu);
  });

  it("shows and speaks the complete bounded fingerprint", () => {
    expect(deviceHandle("0123456789abcdef")).toBe("0123456789abcdef");
    expect(deviceHandle("a".repeat(64))).toBe("Unknown device fingerprint");
    expect(deviceHandleSpoken("0123456789abcdef")).toMatch(/0 1 2 3/);
  });
});
