/**
 * lib/auditGovernance — the policy and parse layer for the workspace-level
 * governance sheet (retention policy / portal sessions / access requests).
 *
 * Three behaviours here are contracts, not conveniences:
 *  - REVOKED WINS OVER EXPIRED: a session that is both must read as revoked,
 *    because "we cut this off" and "it lapsed" are different governance answers.
 *  - A REDUCTION IS MEASURED AGAINST THE EFFECTIVE WINDOW (override or
 *    default), because that is the window the purge job actually applies.
 *  - THE BANNER RENDERS NOTHING ON ZERO — a governance banner that shows on an
 *    empty queue trains everyone to skip it.
 */
import { describe, expect, it } from "vitest";

import {
  accessRequestsBannerLine,
  accessRequesterLabel,
  effectiveRetentionDays,
  isPortalSessionRevocable,
  isRetentionReduction,
  parseAccessRequests,
  parseAuditRetention,
  parsePortalSessions,
  portalRevokeAccess,
  portalSessionState,
  retentionPolicyWriteAccess,
  retentionSummaryLine,
  validAuditRetentionDays,
  type AuditPortalSession,
} from "./auditGovernance";

const NOW = Date.parse("2026-08-30T12:00:00Z");

function session(over: Partial<AuditPortalSession>): AuditPortalSession {
  return {
    id: "s1",
    scope: "read",
    expiresAt: "2026-09-01T00:00:00Z",
    createdAt: "2026-08-29T00:00:00Z",
    accessedAt: null,
    revokedAt: null,
    ...over,
  };
}

describe("parseAuditRetention", () => {
  it("reads the wire fields and treats a missing override as the default", () => {
    expect(parseAuditRetention({ retentionDays: 365, defaultDays: 90 })).toEqual(
      { retentionDays: 365, defaultDays: 90 },
    );
    expect(parseAuditRetention({ retentionDays: null, defaultDays: 90 })).toEqual(
      { retentionDays: null, defaultDays: 90 },
    );
  });

  it("survives a malformed body without inventing an override", () => {
    const parsed = parseAuditRetention({ retentionDays: "365" });
    expect(parsed.retentionDays).toBeNull();
    expect(parsed.defaultDays).toBe(90);
  });
});

describe("retention window arithmetic", () => {
  it("mirrors the server bound 1..3650", () => {
    expect(validAuditRetentionDays(1)).toBe(true);
    expect(validAuditRetentionDays(3650)).toBe(true);
    expect(validAuditRetentionDays(0)).toBe(false);
    expect(validAuditRetentionDays(3651)).toBe(false);
    expect(validAuditRetentionDays(90.5)).toBe(false);
  });

  it("measures a reduction against the EFFECTIVE window, not only an override", () => {
    const defaulted = { retentionDays: null, defaultDays: 90 };
    expect(effectiveRetentionDays(defaulted)).toBe(90);
    // 30 < the default 90 that is actually in force — this destroys data.
    expect(isRetentionReduction(defaulted, 30)).toBe(true);
    expect(isRetentionReduction(defaulted, 365)).toBe(false);
    const overridden = { retentionDays: 2555, defaultDays: 90 };
    expect(isRetentionReduction(overridden, 365)).toBe(true);
  });

  it("says which policy is in force, not just a number", () => {
    expect(retentionSummaryLine({ retentionDays: null, defaultDays: 90 })).toContain(
      "deployment default",
    );
    expect(
      retentionSummaryLine({ retentionDays: 365, defaultDays: 90 }),
    ).toContain("workspace override");
  });
});

describe("retentionPolicyWriteAccess", () => {
  const adminScopes = { auditScopes: ["audit:read"], isAdmin: true };

  it("is unknown (not refused) while the scope answer is in flight", () => {
    expect(
      retentionPolicyWriteAccess({ scopes: null, mode: "session", online: true }),
    ).toEqual({ allowed: false, known: false, notice: null });
  });

  it("refuses a non-admin session with a rule, never a generic failure", () => {
    const verdict = retentionPolicyWriteAccess({
      scopes: { auditScopes: ["audit:read"], isAdmin: false },
      mode: "session",
      online: true,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.known).toBe(true);
    expect(verdict.notice).toContain("owners and admins");
  });

  it("lets an API key through on audit:read + audit:configure_retention", () => {
    const key = {
      auditScopes: ["audit:read", "audit:configure_retention"],
      isAdmin: false,
    };
    expect(
      retentionPolicyWriteAccess({ scopes: key, mode: "api_key", online: true })
        .allowed,
    ).toBe(true);
    // The same pair on a SESSION is not enough — the manifest floor is admin.
    expect(
      retentionPolicyWriteAccess({ scopes: key, mode: "session", online: true })
        .allowed,
    ).toBe(false);
  });

  it("refuses offline even for admins — a purge-policy change is never queued", () => {
    const verdict = retentionPolicyWriteAccess({
      scopes: adminScopes,
      mode: "session",
      online: false,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.notice).toContain("offline");
  });

  it("allows an online admin", () => {
    expect(
      retentionPolicyWriteAccess({
        scopes: adminScopes,
        mode: "session",
        online: true,
      }),
    ).toEqual({ allowed: true, known: true, notice: null });
  });
});

describe("portal sessions", () => {
  it("parses the {sessions} envelope and drops rows with no id", () => {
    const parsed = parsePortalSessions({
      sessions: [
        { id: "a", scope: "read", expiresAt: "2026-09-01T00:00:00Z" },
        { scope: "read" },
        null,
      ],
    });
    expect(parsed.map((s) => s.id)).toEqual(["a"]);
    expect(parsed[0]?.accessedAt).toBeNull();
  });

  it("answers an empty list for a malformed body, never throws", () => {
    expect(parsePortalSessions(null)).toEqual([]);
    expect(parsePortalSessions({ sessions: "nope" })).toEqual([]);
  });

  it("revoked wins over expired", () => {
    const both = session({
      expiresAt: "2026-08-01T00:00:00Z",
      revokedAt: "2026-08-02T00:00:00Z",
    });
    expect(portalSessionState(both, NOW)).toBe("revoked");
  });

  it("a lapsed session reads expired; a future one reads active", () => {
    expect(
      portalSessionState(session({ expiresAt: "2026-08-01T00:00:00Z" }), NOW),
    ).toBe("expired");
    expect(portalSessionState(session({}), NOW)).toBe("active");
  });

  it("only an ACTIVE session is revocable", () => {
    expect(isPortalSessionRevocable(session({}), NOW)).toBe(true);
    expect(
      isPortalSessionRevocable(
        session({ expiresAt: "2026-08-01T00:00:00Z" }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isPortalSessionRevocable(session({ revokedAt: "2026-08-02T00:00:00Z" }), NOW),
    ).toBe(false);
  });

  it("revoke is admin on every path and refused offline", () => {
    expect(
      portalRevokeAccess({
        scopes: { auditScopes: [], isAdmin: false },
        mode: "session",
        online: true,
      }).allowed,
    ).toBe(false);
    expect(
      portalRevokeAccess({
        scopes: { auditScopes: [], isAdmin: true },
        mode: "session",
        online: false,
      }).allowed,
    ).toBe(false);
    expect(
      portalRevokeAccess({
        scopes: { auditScopes: [], isAdmin: true },
        mode: "session",
        online: true,
      }).allowed,
    ).toBe(true);
  });
});

describe("access requests", () => {
  it("parses the {items} envelope and drops rows with no id", () => {
    const parsed = parseAccessRequests({
      items: [
        { id: "r1", userEmail: "a@b.co", status: "pending" },
        { userEmail: "ghost@b.co" },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.userEmail).toBe("a@b.co");
  });

  it("labels a requester by email, then actor label, then a fallback", () => {
    expect(
      accessRequesterLabel({
        id: "r",
        userEmail: "a@b.co",
        actorLabel: "key-1",
        note: "",
        status: "pending",
        createdAt: "",
      }),
    ).toBe("a@b.co");
    expect(
      accessRequesterLabel({
        id: "r",
        userEmail: "",
        actorLabel: "key-1",
        note: "",
        status: "pending",
        createdAt: "",
      }),
    ).toBe("key-1");
  });

  it("the banner renders NOTHING on zero and counts on many", () => {
    expect(accessRequestsBannerLine(undefined)).toBeNull();
    expect(accessRequestsBannerLine([])).toBeNull();
    const one = [
      {
        id: "r1",
        userEmail: "a@b.co",
        actorLabel: "",
        note: "",
        status: "pending",
        createdAt: "",
      },
    ];
    expect(accessRequestsBannerLine(one)).toBe(
      "a@b.co is waiting on audit access.",
    );
    expect(
      accessRequestsBannerLine([...one, { ...one[0]!, id: "r2" }]),
    ).toBe("2 teammates are waiting on audit access.");
  });
});
