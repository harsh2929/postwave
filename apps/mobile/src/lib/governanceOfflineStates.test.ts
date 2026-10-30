import { describe, expect, it } from "vitest";

import { EN_MESSAGES } from "@/lib/messagesEn";
import {
  GOVERNANCE_OFFLINE_SURFACES,
  governanceMetricsUnavailable,
  governanceOfflineEmptyCopy,
  governanceOfflineNotice,
  type GovernanceOfflineSurface,
} from "@/lib/governanceOfflineStates";

const surfaces = GOVERNANCE_OFFLINE_SURFACES;

describe("governanceOfflineNotice", () => {
  it("says nothing while the gate is open", () => {
    for (const surface of surfaces) {
      expect(
        governanceOfflineNotice({
          gateEnabled: true,
          hasTenant: true,
          surface,
        }),
      ).toBeNull();
      // Even with no tenant: an open gate means the query may run, and its
      // own error state must not be pre-empted by an offline claim.
      expect(
        governanceOfflineNotice({
          gateEnabled: true,
          hasTenant: false,
          surface,
        }),
      ).toBeNull();
    }
  });

  it("reports a missing workspace before a missing connection", () => {
    for (const surface of surfaces) {
      const notice = governanceOfflineNotice({
        gateEnabled: false,
        hasTenant: false,
        surface,
      });
      expect(notice?.title).toBe("Reconnect your workspace");
    }
  });

  it("gives every surface distinct, non-empty, catalogue-backed copy", () => {
    const titles = new Set<string>();
    for (const surface of surfaces) {
      const notice = governanceOfflineNotice({
        gateEnabled: false,
        hasTenant: true,
        surface,
      });
      expect(notice).not.toBeNull();
      expect(notice!.title.length).toBeGreaterThan(0);
      expect(notice!.description.length).toBeGreaterThan(0);
      expect(notice!.staleMessage.length).toBeGreaterThan(0);
      // A missing catalogue entry makes `msg` return the key itself; that is
      // deliberately ugly on screen, and must be a test failure here.
      expect(notice!.title).not.toContain("governance.offline.");
      expect(notice!.description).not.toContain("governance.offline.");
      expect(notice!.staleMessage).not.toContain("governance.offline.");
      titles.add(notice!.title);
    }
    expect(titles.size).toBe(surfaces.length);
  });

  it("never restates the empty-state lie it exists to replace", () => {
    for (const surface of surfaces) {
      const notice = governanceOfflineNotice({
        gateEnabled: false,
        hasTenant: true,
        surface,
      })!;
      const text = `${notice.title} ${notice.description}`.toLowerCase();
      expect(text).not.toMatch(/\bno (migration jobs|jobs|children)\b/u);
      expect(text).toContain("reconnect");
    }
  });

  it("keeps the catalogue and the key table in step", () => {
    for (const surface of surfaces) {
      for (const suffix of ["title", "body", "stale"]) {
        expect(
          Object.prototype.hasOwnProperty.call(
            EN_MESSAGES,
            `governance.offline.${surface}.${suffix}`,
          ),
        ).toBe(true);
      }
    }
  });

  it("narrows to the EmptyState shape without leaking the stale sentence", () => {
    const notice = governanceOfflineNotice({
      gateEnabled: false,
      hasTenant: true,
      surface: "migrationJobs" satisfies GovernanceOfflineSurface,
    })!;
    const copy = governanceOfflineEmptyCopy(notice);
    expect(Object.keys(copy).sort()).toEqual(["description", "title"]);
    expect(JSON.stringify(copy)).not.toContain(notice.staleMessage);
  });
});

describe("governanceMetricsUnavailable", () => {
  it("renders an em-dash rather than a confident zero when nothing was read", () => {
    expect(
      governanceMetricsUnavailable({
        failed: false,
        offline: true,
        cachedRowCount: 0,
      }),
    ).toBe(true);
    expect(
      governanceMetricsUnavailable({
        failed: true,
        offline: false,
        cachedRowCount: 0,
      }),
    ).toBe(true);
  });

  it("trusts counts derived from rows that are actually on screen", () => {
    expect(
      governanceMetricsUnavailable({
        failed: true,
        offline: true,
        cachedRowCount: 3,
      }),
    ).toBe(false);
  });

  it("reports a real zero as a measurement", () => {
    expect(
      governanceMetricsUnavailable({
        failed: false,
        offline: false,
        cachedRowCount: 0,
      }),
    ).toBe(false);
  });
});
