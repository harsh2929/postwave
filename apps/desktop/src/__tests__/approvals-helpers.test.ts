import { describe, expect, it } from "vitest";

import {
  APPROVAL_LIST_CAP,
  approvalResourceLabel,
  approvalStatusLabel,
  decodeApprovalDetail,
  decodeApprovalList,
} from "../lib/approvals-helpers";
import { capabilityForSection } from "../lib/desktop-capabilities";

const METADATA_CANARY = "metadata-secret-canary";
const UNKNOWN_FIELD_CANARY = "unknown-field-secret-canary";

const approval = {
  id: "approval-1",
  tenantId: "tenant-secret-canary",
  resourceType: "campaign",
  resourceId: "campaign-1",
  requestedByActorType: "api_key",
  requestedByActorLabel: "  Release operator  ",
  requestedByApiKeyId: "api-key-secret-canary",
  requestedByUserId: "user-secret-canary",
  status: "pending",
  requestedAt: "2026-08-11T08:30:00.123456789Z",
  expiresAt: "2026-08-12T08:30:00Z",
  metadata: { credentials: METADATA_CANARY },
  arbitraryServerField: UNKNOWN_FIELD_CANARY,
};

function successfulDetail(
  value: unknown,
): ReturnType<typeof decodeApprovalDetail> & { ok: true } {
  const decoded = decodeApprovalDetail(value);
  expect(decoded.ok).toBe(true);
  if (!decoded.ok) throw new Error(`Unexpected failure: ${decoded.reason}`);
  return decoded;
}

describe("approval response boundary", () => {
  it("projects a valid detail into bounded known fields only", () => {
    const decoded = successfulDetail({
      ...approval,
      notes: "  Scope reviewed\nby governance  ",
      decidedAt: null,
    });

    expect(decoded.data).toEqual({
      id: "approval-1",
      resourceType: "campaign",
      resourceId: "campaign-1",
      resourceLabel: "Campaign",
      status: "pending",
      statusLabel: "Pending review",
      actionable: true,
      requestedAt: "2026-08-11T08:30:00.123456789Z",
      requestedByActorType: "api_key",
      requestedByActorLabel: "Release operator",
      notes: "Scope reviewed by governance",
      expiresAt: "2026-08-12T08:30:00Z",
    });
    const renderedProjection = JSON.stringify(decoded.data);
    expect(renderedProjection).not.toContain(METADATA_CANARY);
    expect(renderedProjection).not.toContain(UNKNOWN_FIELD_CANARY);
    expect(renderedProjection).not.toContain("tenant-secret-canary");
    expect(renderedProjection).not.toContain("api-key-secret-canary");
    expect(renderedProjection).not.toContain("user-secret-canary");
  });

  it("accepts the server's identical duplicated aliases but emits one canonical key", () => {
    const decoded = decodeApprovalList({
      approvals: [approval],
      items: [{ ...approval }],
    });

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(Object.keys(decoded.data)).toEqual(["approvals"]);
    expect(decoded.data.approvals).toHaveLength(1);
  });

  it("accepts one bounded legacy alias and canonicalizes it", () => {
    const decoded = decodeApprovalList({ results: [approval] });
    expect(decoded).toMatchObject({
      ok: true,
      data: { approvals: [{ id: "approval-1" }] },
    });
  });

  it("distinguishes verified empty from malformed list responses", () => {
    expect(decodeApprovalList({ approvals: [] })).toEqual({
      ok: true,
      data: { approvals: [] },
    });
    expect(decodeApprovalList({})).toEqual({
      ok: false,
      reason: "missing-list",
    });
    expect(decodeApprovalList([])).toEqual({
      ok: false,
      reason: "invalid-envelope",
    });
    expect(decodeApprovalList({ approvals: null })).toEqual({
      ok: false,
      reason: "invalid-envelope",
    });
  });

  it("rejects conflicting duplicated list keys, including distinct unknown statuses", () => {
    expect(
      decodeApprovalList({
        approvals: [approval],
        items: [{ ...approval, status: "approved" }],
      }),
    ).toEqual({ ok: false, reason: "conflicting-list-keys" });
    expect(
      decodeApprovalList({
        approvals: [{ ...approval, status: "future_one" }],
        items: [{ ...approval, status: "future_two" }],
      }),
    ).toEqual({ ok: false, reason: "conflicting-list-keys" });
  });

  it("rejects duplicate approval identities", () => {
    expect(
      decodeApprovalList({
        approvals: [approval, { ...approval, resourceId: "campaign-2" }],
      }),
    ).toEqual({
      ok: false,
      reason: "duplicate-identity",
      recordIndex: 1,
    });
  });

  it("rejects oversized arrays and envelopes instead of truncating", () => {
    expect(
      decodeApprovalList({
        approvals: Array.from(
          { length: APPROVAL_LIST_CAP + 1 },
          (_, index) => ({ ...approval, id: `approval-${index}` }),
        ),
      }),
    ).toEqual({ ok: false, reason: "too-many-records" });

    const oversizedEnvelope = Object.fromEntries(
      Array.from({ length: 13 }, (_, index) => [`key-${index}`, index]),
    );
    expect(decodeApprovalList({ ...oversizedEnvelope, approvals: [] })).toEqual(
      { ok: false, reason: "invalid-envelope" },
    );
  });

  it.each([
    ["missing id", { ...approval, id: undefined }],
    ["oversized id", { ...approval, id: "a".repeat(129) }],
    ["unsafe id", { ...approval, id: "approval/secret" }],
    ["missing status", { ...approval, status: undefined }],
    ["non-string status", { ...approval, status: 1 }],
    ["oversized status", { ...approval, status: "s".repeat(33) }],
    ["missing requested time", { ...approval, requestedAt: undefined }],
    [
      "invalid requested time",
      { ...approval, requestedAt: "2026-02-30T00:00:00Z" },
    ],
    ["missing resource type", { ...approval, resourceType: undefined }],
    ["unsafe resource type", { ...approval, resourceType: "campaign secret" }],
    ["missing resource id", { ...approval, resourceId: undefined }],
    ["oversized resource id", { ...approval, resourceId: "r".repeat(129) }],
  ])("returns an explicit failure for %s", (_label, candidate) => {
    expect(decodeApprovalDetail(candidate)).toEqual({
      ok: false,
      reason: "invalid-record",
    });
  });

  it.each([
    ["actor type", { ...approval, requestedByActorType: "x".repeat(65) }],
    ["unsafe actor type", { ...approval, requestedByActorType: "api key" }],
    ["actor label", { ...approval, requestedByActorLabel: "x".repeat(161) }],
    ["decision notes", { ...approval, notes: "x".repeat(2_001) }],
    ["unsafe display control", { ...approval, notes: "safe\u202esecret" }],
    ["invalid decided time", { ...approval, decidedAt: "yesterday" }],
    ["invalid expiry time", { ...approval, expiresAt: "tomorrow" }],
  ])("rejects an invalid optional %s", (_label, candidate) => {
    expect(decodeApprovalDetail(candidate)).toEqual({
      ok: false,
      reason: "invalid-record",
    });
  });

  it("caps record shape without traversing or passing through metadata", () => {
    const tooManyFields = { ...approval } as Record<string, unknown>;
    for (let index = 0; index < 33; index += 1) {
      tooManyFields[`extra_${index}`] = `canary-${index}`;
    }
    expect(decodeApprovalDetail(tooManyFields)).toEqual({
      ok: false,
      reason: "invalid-record",
    });
  });

  it("rejects required identity inherited through a prototype", () => {
    const inherited = Object.create(approval) as Record<string, unknown>;
    inherited.notes = "own optional field";
    expect(decodeApprovalDetail(inherited)).toEqual({
      ok: false,
      reason: "invalid-record",
    });
  });

  it("maps every allowlisted status and makes only verified pending actionable", () => {
    const expectations = [
      ["pending", "Pending review", true],
      ["approved", "Approved", false],
      ["rejected", "Rejected", false],
      ["expired", "Expired", false],
    ] as const;
    for (const [status, label, actionable] of expectations) {
      expect(successfulDetail({ ...approval, status }).data).toMatchObject({
        status,
        statusLabel: label,
        actionable,
      });
    }
  });

  it("maps a bounded unknown status to non-actionable local copy", () => {
    const statusCanary = "future_status_canary";
    const decoded = successfulDetail({ ...approval, status: statusCanary });
    expect(decoded.data.status).toBe("unverified");
    expect(decoded.data.statusLabel).toBe("Status unverified");
    expect(decoded.data.actionable).toBe(false);
    expect(JSON.stringify(decoded.data)).not.toContain(statusCanary);
  });

  it("fails closed for an unknown resource kind and uses a local label", () => {
    const typeCanary = "future_resource_canary";
    const decoded = successfulDetail({
      ...approval,
      resourceType: typeCanary,
    });
    expect(decoded.data.resourceType).toBe("unverified");
    expect(decoded.data.resourceLabel).toBe("Resource");
    expect(decoded.data.actionable).toBe(false);
    expect(JSON.stringify(decoded.data)).not.toContain(typeCanary);
  });

  it("returns local human labels without reflecting unknown values", () => {
    expect(approvalStatusLabel("pending")).toBe("Pending review");
    expect(approvalStatusLabel("status-label-canary")).toBe(
      "Status unverified",
    );
    expect(approvalResourceLabel("automation_send")).toBe("Automation send");
    expect(approvalResourceLabel("resource-label-canary")).toBe("Resource");
  });
});

describe("approvals capability truth", () => {
  it("is admin-entry, online-only, and explicitly mixed", () => {
    const capability = capabilityForSection("approvals");
    expect(capability.readiness).toBe("mixed");
    expect(capability.offline).toBe("online-required");
    expect(capability.entryRole).toBe("admin");
    expect(capability.limitation).toContain("approval execution");
    expect(capability.limitation).toContain("immutable review bundles");
    expect(capability.limitation).toContain("follow-up receipts");
  });
});
