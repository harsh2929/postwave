import { describe, expect, it } from "vitest";

import {
  conflictValueLabel,
  isUsablePlanFingerprint,
  mergeConfirmCopy,
  mergeErrorMessage,
  mergeSuccessMessage,
  normalizeDuplicateMergePlan,
  planIsApplyable,
} from "@/lib/duplicateMergePlan";

const FINGERPRINT = `sha256:${"a".repeat(64)}`;

const RESPONSE = {
  primary_id: "aaaaaaaa-1111-4111-8111-111111111111",
  duplicate_id: "bbbbbbbb-2222-4222-8222-222222222222",
  dry_run: true,
  plan: {
    tags: ["vip", "newsletter"],
    custom_fields: { plan: "pro", seats: 4 },
    status: "blocklisted",
    consent_timestamp: "2024-03-01T00:00:00Z",
    gdpr_permissions: [{ marketing: false }],
    conflicts: [
      {
        field: "custom_fields.plan",
        primary_value: "pro",
        duplicate_value: "free",
        resolution: "primary_wins",
      },
      {
        field: "status",
        primary_value: "enabled",
        duplicate_value: "blocklisted",
        resolution: "most_restrictive_wins",
      },
    ],
    preserved_on_duplicate: [
      "email and profile identifiers",
      "list memberships, notes, and ID-keyed history",
    ],
  },
  events_moved: 0,
  suppressions_moved: 0,
  loser_soft_deleted: false,
  primary_updated_at: "2026-07-20T00:00:00Z",
  duplicate_updated_at: "2026-07-21T00:00:00Z",
  plan_fingerprint: FINGERPRINT,
};

describe("normalizeDuplicateMergePlan", () => {
  it("reads the apply response shape the Go handler returns", () => {
    const plan = normalizeDuplicateMergePlan(RESPONSE);
    expect(plan?.status).toBe("blocklisted");
    expect(plan?.tags).toEqual(["vip", "newsletter"]);
    expect(plan?.customFieldCount).toBe(2);
    expect(plan?.gdprPermissionCount).toBe(1);
    expect(plan?.conflicts).toHaveLength(2);
    expect(plan?.conflicts[0]?.survivorValue).toBe("pro");
    expect(plan?.conflicts[0]?.duplicateValue).toBe("free");
    expect(plan?.preserved).toHaveLength(2);
    expect(plan?.planFingerprint).toBe(FINGERPRINT);
  });

  it("keeps an absent custom_fields map null instead of calling it empty", () => {
    const plan = normalizeDuplicateMergePlan({
      ...RESPONSE,
      plan: { ...RESPONSE.plan, custom_fields: undefined },
    });
    // "0 custom fields" and "the server did not say" are different claims.
    expect(plan?.customFieldCount).toBeNull();
    // An EMPTY object is a real measurement and stays 0.
    expect(
      normalizeDuplicateMergePlan({
        ...RESPONSE,
        plan: { ...RESPONSE.plan, custom_fields: {} },
      })?.customFieldCount,
    ).toBe(0);
  });

  it("is null without both ids", () => {
    expect(
      normalizeDuplicateMergePlan({ ...RESPONSE, duplicate_id: "" }),
    ).toBeNull();
    expect(normalizeDuplicateMergePlan(null)).toBeNull();
  });
});

describe("planIsApplyable", () => {
  it("requires a dry run with a replayable fingerprint and both instants", () => {
    expect(planIsApplyable(normalizeDuplicateMergePlan(RESPONSE))).toBe(true);
  });

  it("refuses a plan whose fingerprint can only be rejected", () => {
    for (const fingerprint of ["", "sha256:zz", "abc", "sha256:" + "A".repeat(64)]) {
      expect(
        planIsApplyable(
          normalizeDuplicateMergePlan({
            ...RESPONSE,
            plan_fingerprint: fingerprint,
          }),
        ),
        fingerprint,
      ).toBe(false);
    }
  });

  it("refuses an APPLIED response — it is a receipt, not a plan to agree to", () => {
    expect(
      planIsApplyable(
        normalizeDuplicateMergePlan({ ...RESPONSE, dry_run: false }),
      ),
    ).toBe(false);
  });

  it("refuses a plan missing an instant the precondition needs", () => {
    expect(
      planIsApplyable(
        normalizeDuplicateMergePlan({ ...RESPONSE, duplicate_updated_at: "" }),
      ),
    ).toBe(false);
  });
});

describe("isUsablePlanFingerprint", () => {
  it("matches exactly the server's sha256:<64 hex> shape", () => {
    expect(isUsablePlanFingerprint(FINGERPRINT)).toBe(true);
    expect(isUsablePlanFingerprint(`sha256:${"a".repeat(63)}`)).toBe(false);
    expect(isUsablePlanFingerprint(`sha1:${"a".repeat(64)}`)).toBe(false);
  });
});

describe("conflictValueLabel", () => {
  it("shows scalars and NAMES anything a 390pt row cannot show", () => {
    expect(conflictValueLabel("pro")).toBe("pro");
    expect(conflictValueLabel(4)).toBe("4");
    expect(conflictValueLabel(true)).toBe("true");
    expect(conflictValueLabel("")).toBe("empty");
    expect(conflictValueLabel(null)).toBe("not set");
    expect(conflictValueLabel(undefined)).toBe("not set");
    expect(conflictValueLabel([1, 2, 3])).toBe("a 3-item list");
    expect(conflictValueLabel({ nested: true })).toBe("a structured value");
  });
});

describe("mergeConfirmCopy", () => {
  const plan = normalizeDuplicateMergePlan(RESPONSE);

  it("names the survivor AND the loser, in both directions", () => {
    const copy = mergeConfirmCopy({
      survivorEmail: "ada@example.com",
      loserEmail: "Ada@example.com",
      plan,
    });
    expect(copy.consequence).toContain(
      "ada@example.com survives and keeps its address and id",
    );
    expect(copy.consequence).toContain("Ada@example.com is closed");
    expect(copy.message).toContain("Only ada@example.com will be reachable");
  });

  it("says the loser is CLOSED, not deleted — apply.go soft-deletes it", () => {
    const copy = mergeConfirmCopy({
      survivorEmail: "a@example.com",
      loserEmail: "b@example.com",
      plan,
    });
    expect(copy.consequence).toContain("status becomes disabled");
    expect(copy.consequence).toContain("tagged pw:merged");
    expect(copy.consequence).toContain("kept for audit, not deleted");
  });

  it("states the part that genuinely does not come back", () => {
    const copy = mergeConfirmCopy({
      survivorEmail: "a@example.com",
      loserEmail: "b@example.com",
      plan,
    });
    expect(copy.consequence).toContain("does not move back");
  });

  it("carries the plan's resulting status and conflict count", () => {
    const copy = mergeConfirmCopy({
      survivorEmail: "a@example.com",
      loserEmail: "b@example.com",
      plan,
    });
    expect(copy.consequence).toContain("ends up blocklisted");
    expect(copy.consequence).toContain("2 fields disagree");
  });

  it("still names both records when no plan loaded", () => {
    const copy = mergeConfirmCopy({
      survivorEmail: "",
      loserEmail: "",
      plan: null,
    });
    expect(copy.consequence).toContain("the surviving record survives");
    expect(copy.consequence).toContain("the duplicate record is closed");
    expect(copy.confirmLabel).toBe("Merge");
  });
});

describe("mergeErrorMessage", () => {
  it("distinguishes the three 409s, which need different actions", () => {
    expect(mergeErrorMessage({ status: 409, code: "already_merged" })).toContain(
      "already merged into another record",
    );
    expect(mergeErrorMessage({ status: 409, code: "stale_review" })).toContain(
      "changed while you were reviewing",
    );
    expect(
      mergeErrorMessage({ status: 409, code: "candidate_stale" }),
    ).toContain("no longer part of the reviewed scan");
  });

  it("names the missing permission for a 403 rather than saying 'failed'", () => {
    expect(mergeErrorMessage({ status: 403 })).toContain(
      "needs an owner or admin session",
    );
  });

  it("handles 428 review_required and the 503 product boundary", () => {
    expect(mergeErrorMessage({ status: 428 })).toContain("reviewed plan");
    expect(mergeErrorMessage({ status: 503 })).toContain("not available");
  });

  it("says NOTHING WAS MERGED in every branch, including the unknown one", () => {
    for (const error of [
      { status: 409, code: "already_merged" },
      { status: 403 },
      { status: 404 },
      { status: 0 },
      { status: 500, message: "boom" },
      {},
    ]) {
      const message = mergeErrorMessage(error);
      expect(
        /Nothing was merged|nothing was merged|Re-run the scan/u.test(message),
        JSON.stringify(error),
      ).toBe(true);
    }
  });
});

describe("mergeSuccessMessage", () => {
  it("reports only what the server returned", () => {
    const applied = normalizeDuplicateMergePlan({
      ...RESPONSE,
      dry_run: false,
      events_moved: 12,
      loser_soft_deleted: true,
    });
    expect(mergeSuccessMessage("ada@example.com", applied)).toBe(
      "Merged into ada@example.com. 12 events moved.",
    );
  });

  it("omits a count the server did not send instead of printing zero", () => {
    const applied = normalizeDuplicateMergePlan({
      ...RESPONSE,
      dry_run: false,
      events_moved: undefined,
    });
    expect(mergeSuccessMessage("ada@example.com", applied)).toBe(
      "Merged into ada@example.com.",
    );
  });

  it("singularises one event", () => {
    const applied = normalizeDuplicateMergePlan({
      ...RESPONSE,
      dry_run: false,
      events_moved: 1,
    });
    expect(mergeSuccessMessage("a@example.com", applied)).toContain(
      "1 event moved",
    );
  });
});
