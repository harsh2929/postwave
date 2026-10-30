// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/api", () => ({ api: apiMock }));

import {
  decodePushSuppressions,
  getPushSuppressions,
} from "@/lib/consent-evidence-api";

const TENANT = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT = "2026-08-29T10:00:00Z";

function row(over: Record<string, unknown> = {}) {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    tenant_id: TENANT,
    device_token_hash: "0123456789abcdef",
    platform: "apns",
    reason: "manual",
    source: "dashboard",
    created_at: "2026-08-29T09:00:00Z",
    updated_at: "2026-08-29T09:00:00Z",
    version: 1,
    reversible: true,
    ...over,
  };
}

function page(items: unknown[], over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    items,
    total: items.length,
    snapshotAt: SNAPSHOT,
    ...over,
  };
}

beforeEach(() => apiMock.get.mockReset());

describe("web Route43 registry boundary", () => {
  it("decodes the tenant-bound envelope and 16-hex fingerprint", () => {
    expect(decodePushSuppressions(page([row()]), TENANT)).toMatchObject({
      tenantId: TENANT,
      total: 1,
      items: [
        {
          fingerprint: "0123456789abcdef",
          platform: "apns",
          reversible: true,
        },
      ],
    });
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
        decodePushSuppressions(
          page([row({ ...variant, reversible: false })]),
          TENANT,
        ).items[0],
      ).toMatchObject({
        source: variant.source,
        reason: variant.reason,
        lockedReason: variant.locked_reason,
        reversible: false,
      });
    }
  });

  it("accepts revision-snapshot rows after clock rollback but keeps row time ordered", () => {
    const futureDated = row({
      created_at: "2026-08-29T11:00:00Z",
      updated_at: "2026-08-29T11:00:01Z",
    });
    expect(
      decodePushSuppressions(
        page([futureDated], { snapshotAt: "2026-08-29T10:00:00Z" }),
        TENANT,
      ).items[0],
    ).toMatchObject({
      createdAt: "2026-08-29T11:00:00Z",
      updatedAt: "2026-08-29T11:00:01Z",
    });
    expect(() =>
      decodePushSuppressions(
        page([
          row({
            created_at: "2026-08-29T11:00:01Z",
            updated_at: "2026-08-29T11:00:00Z",
          }),
        ]),
        TENANT,
      ),
    ).toThrow(/unverifiable response/iu);
  });

  it("fails closed instead of turning malformed success into zero", () => {
    for (const malformed of [
      {},
      { items: [], total: 0 },
      page([row({ device_token_hash: "a".repeat(64) })]),
      page([row({ tenant_id: "00000000-0000-0000-0000-000000000001" })]),
      page([row({ extra: true })]),
      page([row({ source: "internal-provider-name" })]),
      page([
        row({
          reason: "user_opt_out",
          source: "user",
          reversible: false,
          locked_reason: "provider_authority",
        }),
      ]),
      page([
        row({
          reason: "complaint",
          source: "provider",
          reversible: false,
          locked_reason: "provider_authority",
        }),
      ]),
      page([
        row({
          reason: "user_opt_out",
          source: "legacy",
          reversible: false,
          locked_reason: "complaint_authority",
        }),
      ]),
      page([row({ created_at: "2026-02-31T09:00:00Z" })]),
    ]) {
      expect(() => decodePushSuppressions(malformed, TENANT)).toThrow(
        /unverifiable response/iu,
      );
    }
  });

  it("accepts zero only from a complete verified snapshot", () => {
    expect(decodePushSuppressions(page([]), TENANT)).toEqual({
      tenantId: TENANT,
      items: [],
      total: 0,
      snapshotAt: SNAPSHOT,
    });
    expect(() =>
      decodePushSuppressions(page([], { total: 1 }), TENANT),
    ).toThrow();
  });

  it("binds transport to the expected tenant and forwards cancellation", async () => {
    apiMock.get.mockResolvedValue(page([]));
    const controller = new AbortController();
    await expect(
      getPushSuppressions(TENANT, { signal: controller.signal }),
    ).resolves.toMatchObject({ total: 0 });
    expect(apiMock.get).toHaveBeenCalledWith(
      "/api/v1/push/suppressions?limit=100",
      { signal: controller.signal },
    );
    await expect(getPushSuppressions("tenant")).rejects.toThrow(
      /unverifiable response/iu,
    );
    expect(apiMock.get).toHaveBeenCalledTimes(1);
  });
});
