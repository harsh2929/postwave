/**
 * The governance endpoints at the transport boundary — asserted against what
 * `rawRequest` resolves to (the `{data,error}` ENVELOPE), because that seam is
 * exactly what the parser tests cannot see (the audienceDestinations lesson).
 *
 * Contracts under test:
 *  - the retention PUT carries `{retentionDays}` VERBATIM, null included —
 *    null is the "use the deployment default" instruction, not an omission;
 *  - the portal revoke DELETEs the id percent-encoded;
 *  - a refused read throws with its status attached, never resolving empty.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT_ACCESS_REQUESTS_PATH,
  AUDIT_PORTAL_SESSIONS_PATH,
  AUDIT_RETENTION_PATH,
  fetchAuditAccessRequests,
  fetchAuditPortalSessions,
  fetchAuditRetention,
  revokeAuditPortalSession,
  setAuditRetention,
} from "./auditGovernance";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({
  rawRequest,
  checkedApiResult: async (
    promise: Promise<{
      data: unknown;
      error: { status: number; message: string; code?: string } | null;
    }>,
  ) => {
    const result = await promise;
    if (result.error) {
      throw Object.assign(new Error(result.error.message), {
        status: result.error.status,
        ...(result.error.code ? { code: result.error.code } : {}),
      });
    }
    return result;
  },
}));

beforeEach(() => rawRequest.mockReset());

describe("retention policy transport", () => {
  it("parses the policy off the envelope body", async () => {
    rawRequest.mockResolvedValue({
      data: { retentionDays: 365, defaultDays: 90 },
      error: null,
    });
    await expect(fetchAuditRetention()).resolves.toEqual({
      retentionDays: 365,
      defaultDays: 90,
    });
    expect(rawRequest).toHaveBeenCalledWith("GET", AUDIT_RETENTION_PATH);
  });

  it("PUTs the days verbatim — null means 'use the deployment default'", async () => {
    rawRequest.mockResolvedValue({ data: { retentionDays: null }, error: null });
    await setAuditRetention(null);
    expect(rawRequest).toHaveBeenCalledWith("PUT", AUDIT_RETENTION_PATH, {
      retentionDays: null,
    });
    await setAuditRetention(2555);
    expect(rawRequest).toHaveBeenLastCalledWith("PUT", AUDIT_RETENTION_PATH, {
      retentionDays: 2555,
    });
  });

  it("a refused write rejects with the permission status attached", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "forbidden" },
    });
    await expect(setAuditRetention(90)).rejects.toMatchObject({ status: 403 });
  });
});

describe("portal session transport", () => {
  it("unwraps the {sessions} envelope into parsed sessions", async () => {
    rawRequest.mockResolvedValue({
      data: {
        sessions: [
          { id: "s1", scope: "read", expiresAt: "2026-09-01T00:00:00Z" },
        ],
      },
      error: null,
    });
    const sessions = await fetchAuditPortalSessions();
    expect(rawRequest).toHaveBeenCalledWith("GET", AUDIT_PORTAL_SESSIONS_PATH);
    expect(sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  it("DELETEs the revoke target id-encoded", async () => {
    rawRequest.mockResolvedValue({ data: { ok: true }, error: null });
    await revokeAuditPortalSession("a/b c");
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      `${AUDIT_PORTAL_SESSIONS_PATH}/a%2Fb%20c`,
    );
  });
});

describe("access request transport", () => {
  it("unwraps the {items} envelope", async () => {
    rawRequest.mockResolvedValue({
      data: { items: [{ id: "r1", userEmail: "a@b.co", status: "pending" }] },
      error: null,
    });
    const items = await fetchAuditAccessRequests();
    expect(rawRequest).toHaveBeenCalledWith("GET", AUDIT_ACCESS_REQUESTS_PATH);
    expect(items).toHaveLength(1);
  });

  it("a refused read throws, never resolving as an empty queue", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "forbidden" },
    });
    await expect(fetchAuditAccessRequests()).rejects.toMatchObject({
      status: 403,
    });
  });
});
