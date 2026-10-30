import { describe, expect, it, vi } from "vitest";

vi.mock("./request", () => ({ rawRequest: vi.fn() }));

const {
  isDelegationActive,
  normalizeEscalationPolicy,
  sortDelegations,
} = await import("./approvalGovernance");

const HOUR = 3600_000;
const NOW = Date.parse("2026-07-25T12:00:00.000Z");

const delegation = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: "d1",
    fromUserId: "u1",
    toUserId: "u2",
    startsAt: new Date(NOW - HOUR).toISOString(),
    createdAt: new Date(NOW - HOUR).toISOString(),
    ...over,
  }) as Parameters<typeof isDelegationActive>[0];

describe("isDelegationActive", () => {
  it("is active with no end date and a past start", () => {
    expect(isDelegationActive(delegation(), NOW)).toBe(true);
  });

  it("is inactive once revoked, even inside its window", () => {
    expect(
      isDelegationActive(
        delegation({ revokedAt: new Date(NOW - 1).toISOString() }),
        NOW,
      ),
    ).toBe(false);
  });

  it("is inactive before it starts", () => {
    expect(
      isDelegationActive(
        delegation({ startsAt: new Date(NOW + HOUR).toISOString() }),
        NOW,
      ),
    ).toBe(false);
  });

  it("is inactive after it ends and active before", () => {
    expect(
      isDelegationActive(
        delegation({ endsAt: new Date(NOW - 1).toISOString() }),
        NOW,
      ),
    ).toBe(false);
    expect(
      isDelegationActive(
        delegation({ endsAt: new Date(NOW + HOUR).toISOString() }),
        NOW,
      ),
    ).toBe(true);
  });

  it("treats an unparseable end date as open-ended rather than expired", () => {
    expect(isDelegationActive(delegation({ endsAt: "not-a-date" }), NOW)).toBe(
      true,
    );
  });
});

describe("sortDelegations", () => {
  it("puts active rows above revoked ones regardless of age", () => {
    const revokedRecent = delegation({
      id: "revoked",
      createdAt: new Date(NOW).toISOString(),
      revokedAt: new Date(NOW).toISOString(),
    });
    const activeOld = delegation({
      id: "active",
      createdAt: new Date(NOW - 100 * HOUR).toISOString(),
    });
    expect(
      sortDelegations([revokedRecent, activeOld], NOW).map((d) => d.id),
    ).toEqual(["active", "revoked"]);
  });

  it("orders newest first within the same group and does not mutate the input", () => {
    const older = delegation({
      id: "older",
      createdAt: new Date(NOW - 10 * HOUR).toISOString(),
    });
    const newer = delegation({
      id: "newer",
      createdAt: new Date(NOW - HOUR).toISOString(),
    });
    const input = [older, newer];
    expect(sortDelegations(input, NOW).map((d) => d.id)).toEqual([
      "newer",
      "older",
    ]);
    expect(input[0]?.id).toBe("older");
  });
});

describe("normalizeEscalationPolicy", () => {
  it("treats missing, zero and negative hours as disabled", () => {
    expect(normalizeEscalationPolicy(undefined).escalateAfterHours).toBeNull();
    expect(
      normalizeEscalationPolicy({ escalateAfterHours: 0, notifyOwners: true })
        .escalateAfterHours,
    ).toBeNull();
    expect(
      normalizeEscalationPolicy({ escalateAfterHours: -4, notifyOwners: true })
        .escalateAfterHours,
    ).toBeNull();
  });

  it("rounds a fractional hour value", () => {
    expect(
      normalizeEscalationPolicy({
        escalateAfterHours: 23.6,
        notifyOwners: false,
      }).escalateAfterHours,
    ).toBe(24);
  });

  it("coerces notifyOwners to a real boolean", () => {
    expect(normalizeEscalationPolicy(undefined).notifyOwners).toBe(false);
    expect(
      normalizeEscalationPolicy({ notifyOwners: true }).notifyOwners,
    ).toBe(true);
  });
});
