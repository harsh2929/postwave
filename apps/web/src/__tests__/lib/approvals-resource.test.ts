// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-logic tests for approval resource deep-linking + status counts (node env).

import { describe, it, expect } from "vitest";

import {
  countByStatus,
  isDelegationActive,
  resourceHref,
  resourceTypeLabel,
  type Approval,
  type Delegation,
} from "@/lib/approvals-api";

function approval(over: Partial<Approval>): Approval {
  return {
    id: "a1",
    tenantId: "t",
    resourceType: "campaign",
    resourceId: "c1",
    status: "pending",
    requestedAt: "2026-01-01T00:00:00Z",
    expiresAt: "2099-01-01T00:00:00Z",
    ...over,
  };
}

describe("resourceHref", () => {
  it("links campaigns, sequences, and automation sends", () => {
    expect(resourceHref("campaign", "cmp_1")).toBe("/app/campaigns/cmp_1");
    expect(resourceHref("sequence", "seq_1")).toBe("/app/automations/seq_1");
    expect(resourceHref("automation_send", "as_1")).toBe(
      "/app/automations/as_1",
    );
  });
  it("encodes the id", () => {
    expect(resourceHref("campaign", "a b/c")).toBe("/app/campaigns/a%20b%2Fc");
  });
  it("returns null for unknown types or empty ids", () => {
    expect(resourceHref("mystery", "x1")).toBeNull();
    expect(resourceHref("campaign", "")).toBeNull();
    expect(resourceHref("campaign", "   ")).toBeNull();
  });
});

describe("resourceTypeLabel", () => {
  it("title-cases and de-underscores", () => {
    expect(resourceTypeLabel("automation_send")).toBe("Automation send");
    expect(resourceTypeLabel("campaign")).toBe("Campaign");
    expect(resourceTypeLabel("")).toBe("Resource");
  });
});

describe("countByStatus", () => {
  it("tallies by status with all as the total", () => {
    const counts = countByStatus([
      approval({ status: "pending" }),
      approval({ status: "pending" }),
      approval({ status: "approved" }),
      approval({ status: "rejected" }),
      approval({ status: "expired" }),
    ]);
    expect(counts.all).toBe(5);
    expect(counts.pending).toBe(2);
    expect(counts.approved).toBe(1);
    expect(counts.rejected).toBe(1);
    expect(counts.expired).toBe(1);
    expect(counts.cancelled).toBe(0);
  });

  it("handles an empty list", () => {
    const counts = countByStatus([]);
    expect(counts.all).toBe(0);
    expect(counts.pending).toBe(0);
  });
});

describe("isDelegationActive", () => {
  const base: Delegation = {
    id: "d1",
    tenantId: "t",
    fromUserId: "u1",
    toUserId: "u2",
    startsAt: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
  };
  const now = Date.parse("2026-06-01T00:00:00Z");

  it("is active with no end date and not revoked", () => {
    expect(isDelegationActive(base, now)).toBe(true);
  });
  it("is inactive when revoked", () => {
    expect(
      isDelegationActive({ ...base, revokedAt: "2026-02-01T00:00:00Z" }, now),
    ).toBe(false);
  });
  it("is inactive when the end date has passed", () => {
    expect(
      isDelegationActive({ ...base, endsAt: "2026-03-01T00:00:00Z" }, now),
    ).toBe(false);
  });
  it("is active when the end date is in the future", () => {
    expect(
      isDelegationActive({ ...base, endsAt: "2026-12-01T00:00:00Z" }, now),
    ).toBe(true);
  });
});
