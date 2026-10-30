// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

import { desktopRouteIdentityScope } from "../../lib/desktop-router";
import {
  AUDIT_EXPORT_MANIFEST_PERSIST_KEY,
  AUDIT_FILTER_PERSIST_KEY,
  AUDIT_VIEW_MODE_PERSIST_KEY,
  clearAuditFilterSessionState,
  readAuditViewMode,
  readIncludeManifest,
  readPersistedAuditFilters,
  writeAuditViewMode,
  writeIncludeManifest,
  writePersistedAuditFilters,
} from "../../pages/audit/audit-page-utils";

const ALPHA = desktopRouteIdentityScope("alpha-user", "alpha-tenant")!;
const BETA = desktopRouteIdentityScope("beta-user", "beta-tenant")!;

beforeEach(() => {
  clearAuditFilterSessionState();
  localStorage.clear();
});

describe("audit preference identity isolation", () => {
  it("never adopts an ambiguous unscoped filter record", () => {
    localStorage.setItem(
      AUDIT_FILTER_PERSIST_KEY,
      JSON.stringify({ actorLabel: "other-client@example.com" }),
    );
    localStorage.setItem(
      `${AUDIT_FILTER_PERSIST_KEY}:${ALPHA}`,
      JSON.stringify({
        actorType: "user",
        actorLabel: "alpha@example.com",
        resourceId: "campaign-alpha",
        days: 7,
        category: "destructive",
      }),
    );

    expect(readPersistedAuditFilters(ALPHA)).toEqual({});
    expect(readPersistedAuditFilters(BETA)).toEqual({});
    expect(localStorage.getItem(AUDIT_FILTER_PERSIST_KEY)).toBeNull();
    const storedValues = Array.from(
      { length: localStorage.length },
      (_, index) => localStorage.getItem(localStorage.key(index) ?? "") ?? "",
    ).join("\n");
    expect(storedValues).not.toContain("alpha@example.com");
  });

  it("bounds malformed values and keeps writes inside their identity", () => {
    localStorage.setItem(
      `${AUDIT_FILTER_PERSIST_KEY}:${ALPHA}`,
      JSON.stringify({
        actorType: "owner",
        actorLabel: "x".repeat(300),
        resourceType: "campaign",
        days: 365,
        category: "unknown",
      }),
    );
    expect(readPersistedAuditFilters(ALPHA)).toEqual({});

    writePersistedAuditFilters(
      {
        actorType: "system",
        actorLabel: "private@example.com",
        actionQuery: "customer launch",
        resourceType: "campaign",
        resourceId: "campaign-private",
      },
      BETA,
    );
    expect(readPersistedAuditFilters(BETA)).toEqual({
      actorType: "system",
      actorLabel: "private@example.com",
      actionQuery: "customer launch",
      resourceType: "campaign",
      resourceId: "campaign-private",
    });
    expect(readPersistedAuditFilters(ALPHA)).toEqual({});
    const atRest = localStorage.getItem(`${AUDIT_FILTER_PERSIST_KEY}:${BETA}`);
    expect(atRest).toContain('"actorType":"system"');
    expect(atRest).not.toMatch(
      /private@example\.com|customer launch|campaign-private|resourceType|resourceId/u,
    );
  });

  it("scopes view and export preferences and refuses unresolved identity", () => {
    writeAuditViewMode("heatmap", ALPHA);
    writeIncludeManifest(true, ALPHA);
    writeAuditViewMode("calendar", BETA);
    writeIncludeManifest(false, BETA);
    writeAuditViewMode("timeline", null);
    writeIncludeManifest(true, null);

    expect(readAuditViewMode(ALPHA)).toBe("heatmap");
    expect(readIncludeManifest(ALPHA)).toBe(true);
    expect(readAuditViewMode(BETA)).toBe("calendar");
    expect(readIncludeManifest(BETA)).toBe(false);
    expect(readAuditViewMode(null)).toBe("list");
    expect(readIncludeManifest(null)).toBe(false);
    expect(localStorage.getItem(AUDIT_VIEW_MODE_PERSIST_KEY)).toBeNull();
    expect(localStorage.getItem(AUDIT_EXPORT_MANIFEST_PERSIST_KEY)).toBeNull();
  });

  it("expires and removes stale durable filter preferences", () => {
    localStorage.setItem(
      `${AUDIT_FILTER_PERSIST_KEY}:${ALPHA}`,
      JSON.stringify({
        version: 2,
        savedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
        filters: { actorType: "system", days: 7 },
      }),
    );

    expect(readPersistedAuditFilters(ALPHA)).toEqual({});
    expect(
      localStorage.getItem(`${AUDIT_FILTER_PERSIST_KEY}:${ALPHA}`),
    ).toBeNull();
  });
});
