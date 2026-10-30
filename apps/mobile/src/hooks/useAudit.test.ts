import { describe, expect, it, vi } from "vitest";
import {
  anomalyIndex,
  auditLogPath,
  auditSnapshotSlot,
  hasAuditPiiScope,
  hasAuditReadScope,
  isAuditSnapshotEligible,
  normalizeAuditPage,
} from "./useAudit";

vi.mock("@/api/client", () => ({
  getClient: vi.fn(),
}));

vi.mock("@/hooks/useOnlineQueryGate", () => ({ useOnlineQueryGate: vi.fn() }));

vi.mock("@/lib/connectivity", () => ({
  isProbablyOnline: () => true,
}));

vi.mock("@/lib/secureVault", () => ({
  vaultGetJSON: vi.fn(),
  vaultSetJSON: vi.fn(),
  vaultScopeForClient: vi.fn(),
}));

describe("auditLogPath", () => {
  it("serializes and bounds audit limits safely", () => {
    expect(auditLogPath(25)).toBe("/api/v1/audit?limit=25");
    expect(auditLogPath(9999)).toBe("/api/v1/audit?limit=500");
    expect(auditLogPath(0)).toBe("/api/v1/audit?limit=100");
    expect(auditLogPath(Number.NaN)).toBe("/api/v1/audit?limit=100");
  });

  it("appends the cursor only when one is supplied", () => {
    expect(auditLogPath(50, null)).toBe("/api/v1/audit?limit=50");
    expect(auditLogPath(50, "")).toBe("/api/v1/audit?limit=50");
    expect(auditLogPath(50, "912")).toBe("/api/v1/audit?limit=50&cursor=912");
  });

  it("pushes actor_type and since to the server when present", () => {
    expect(
      auditLogPath(50, null, {
        actorType: "agent",
        since: "2026-07-18T00:00:00.000Z",
      }),
    ).toBe(
      "/api/v1/audit?limit=50&actor_type=agent&since=2026-07-18T00%3A00%3A00.000Z",
    );
  });

  it("omits undefined filters rather than sending empty params", () => {
    expect(auditLogPath(50, null, { actorType: undefined })).toBe(
      "/api/v1/audit?limit=50",
    );
  });

  it("pushes the four advanced facets to the server as real query params", () => {
    // The whole point of the advanced sheet: these narrow the QUERY, not the
    // loaded pages, so "every event touching subscriber X" no longer means
    // paging the full history to the phone first.
    expect(
      auditLogPath(50, null, {
        action: "export",
        resourceType: "campaign",
        resourceId: "12",
        actorLabel: "ops@example.com",
      }),
    ).toBe(
      "/api/v1/audit?limit=50&action=export&resource_type=campaign&resource_id=12&actor_label=ops%40example.com",
    );
  });
});

describe("normalizeAuditPage", () => {
  it("tolerates a missing, null or malformed payload", () => {
    expect(normalizeAuditPage(null)).toEqual({ rows: [], nextCursor: null });
    expect(normalizeAuditPage({})).toEqual({ rows: [], nextCursor: null });
    expect(normalizeAuditPage({ rows: "nope" })).toEqual({
      rows: [],
      nextCursor: null,
    });
  });

  it("treats an empty-string or non-string cursor as no more pages", () => {
    expect(
      normalizeAuditPage({ rows: [], nextCursor: "" }).nextCursor,
    ).toBeNull();
    expect(
      normalizeAuditPage({ rows: [], nextCursor: 12 }).nextCursor,
    ).toBeNull();
    expect(normalizeAuditPage({ rows: [], nextCursor: "7" }).nextCursor).toBe(
      "7",
    );
  });
});

describe("audit scope derivation", () => {
  it("returns null while the scope answer is unknown", () => {
    expect(hasAuditReadScope(null)).toBeNull();
    expect(hasAuditReadScope(undefined)).toBeNull();
  });

  it("admits an admin regardless of the explicit audit scope list", () => {
    expect(
      hasAuditReadScope({ scopes: [], auditScopes: [], isAdmin: true }),
    ).toBe(true);
    expect(
      hasAuditPiiScope({ scopes: [], auditScopes: [], isAdmin: true }),
    ).toBe(true);
  });

  it("reads the explicit scopes for a non-admin", () => {
    expect(
      hasAuditReadScope({
        scopes: ["audit:read"],
        auditScopes: ["audit:read"],
        isAdmin: false,
      }),
    ).toBe(true);
    expect(
      hasAuditReadScope({
        scopes: ["campaigns:read"],
        auditScopes: [],
        isAdmin: false,
      }),
    ).toBe(false);
    expect(
      hasAuditPiiScope({
        scopes: [],
        auditScopes: ["audit:read"],
        isAdmin: false,
      }),
    ).toBe(false);
  });
});

describe("anomalyIndex", () => {
  it("keys assessments by audit id and drops non-numeric ids", () => {
    const index = anomalyIndex([
      { auditId: 7, score: 80, bucket: "high" },
      { auditId: "x" as unknown as number, score: 1, bucket: "low" },
    ]);
    expect(index.get(7)?.bucket).toBe("high");
    expect(index.size).toBe(1);
  });

  it("returns an empty map for undefined input", () => {
    expect(anomalyIndex(undefined).size).toBe(0);
  });
});

describe("audit offline-snapshot eligibility", () => {
  // Regression: eligibility was `!actorType && !since`. The screen's default
  // 7d window puts a `since` on EVERY render, so the audit log's offline
  // read went dead — nothing written to the vault, nothing read back, and
  // the "showing the last saved audit snapshot" banner unreachable.
  it("still caches a window-narrowed page one", () => {
    expect(
      isAuditSnapshotEligible({ since: "2026-07-18T00:00:00.000Z" }),
    ).toBe(true);
  });

  it("caches the wholly unfiltered page one", () => {
    expect(isAuditSnapshotEligible()).toBe(true);
    expect(isAuditSnapshotEligible({})).toBe(true);
  });

  it("never makes an actor-filtered investigation the offline baseline", () => {
    expect(isAuditSnapshotEligible({ actorType: "agent" })).toBe(false);
    expect(
      isAuditSnapshotEligible({
        actorType: "agent",
        since: "2026-07-18T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("never makes an advanced-facet investigation the offline baseline either", () => {
    // Page one of "everything that touched campaign 12" must not become the
    // workspace's cached audit log.
    expect(isAuditSnapshotEligible({ action: "export" })).toBe(false);
    expect(isAuditSnapshotEligible({ resourceType: "campaign" })).toBe(false);
    expect(isAuditSnapshotEligible({ resourceId: "12" })).toBe(false);
    expect(isAuditSnapshotEligible({ actorLabel: "ops@example.com" })).toBe(
      false,
    );
  });
});

describe("auditSnapshotSlot", () => {
  it("scopes the slot by window so a 24h capture is not served as All", () => {
    expect(auditSnapshotSlot(100, "24h")).toBe("latest-100-24h");
    expect(auditSnapshotSlot(100, "all")).toBe("latest-100-all");
    expect(auditSnapshotSlot(100, "24h")).not.toBe(
      auditSnapshotSlot(100, "all"),
    );
  });

  it("keeps the historic unsuffixed slot for callers with no window", () => {
    expect(auditSnapshotSlot(6)).toBe("latest-6");
    expect(auditSnapshotSlot(6, undefined)).toBe("latest-6");
  });
});
