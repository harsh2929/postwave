// Merge-apply helpers (R14 full-surface wiring): verbatim plan-row
// rendering (tags union, custom fields, status, consent, gdpr),
// honest dry-run vs applied counter copy, the soft-delete result
// toast, and 409 already_merged detection.

import { describe, expect, it } from "vitest";

import type { MergeApplyResponse, MergePlan } from "../../lib/api-client";
import {
  buildPlanRows,
  isAlreadyMerged,
  mergeResultCopy,
  moveCountersCopy,
} from "../../components/subscribers/merge-plan-helpers";

function plan(over: Partial<MergePlan> = {}): MergePlan {
  return {
    tags: ["vip", "newsletter"],
    custom_fields: { first_name: "Jane", plan: "pro" },
    status: "enabled",
    consent_timestamp: "2025-01-02T03:04:05Z",
    gdpr_permissions: [{ marketing: false }],
    conflicts: [],
    preserved_on_duplicate: ["profile identifiers"],
    ...over,
  };
}

function resp(over: Partial<MergeApplyResponse> = {}): MergeApplyResponse {
  return {
    primary_id: "p1",
    duplicate_id: "d1",
    dry_run: false,
    plan: plan(),
    events_moved: 12,
    suppressions_moved: 1,
    loser_soft_deleted: true,
    primary_updated_at: "2026-07-18T12:00:00Z",
    duplicate_updated_at: "2026-07-18T12:01:00Z",
    plan_fingerprint: `sha256:${"a".repeat(64)}`,
    ...over,
  };
}

describe("buildPlanRows", () => {
  it("renders every plan dimension verbatim", () => {
    const rows = buildPlanRows(plan());
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel["Tags (union)"]).toBe("vip, newsletter");
    expect(byLabel["Field · first_name"]).toBe("Jane");
    expect(byLabel["Field · plan"]).toBe("pro");
    expect(byLabel["Status"]).toBe("enabled");
    expect(byLabel["Consent timestamp"]).toBe("2025-01-02T03:04:05Z");
    expect(byLabel["GDPR permissions"]).toBe('{"marketing":false}');
  });

  it("is honest about empty dimensions instead of omitting them", () => {
    const rows = buildPlanRows(
      plan({
        tags: [],
        custom_fields: {},
        consent_timestamp: null,
        gdpr_permissions: [],
      }),
    );
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel["Tags (union)"]).toBe("(none)");
    expect(byLabel["Custom fields"]).toBe("(none)");
    expect(byLabel["Consent timestamp"]).toBe("(none recorded)");
    expect(byLabel["GDPR permissions"]).toBe("(none)");
  });

  it("serialises non-string field values instead of [object Object]", () => {
    const rows = buildPlanRows(
      plan({ custom_fields: { meta: { a: 1 }, n: 4, none: null } }),
    );
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel["Field · meta"]).toBe('{"a":1}');
    expect(byLabel["Field · n"]).toBe("4");
    expect(byLabel["Field · none"]).toBe("—");
  });
});

describe("moveCountersCopy", () => {
  it("dry run: explains the zero counters instead of presenting them as fact", () => {
    expect(moveCountersCopy(resp({ dry_run: true, events_moved: 0 }))).toMatch(
      /dry run writes nothing/i,
    );
  });

  it("applied: reports the server's counters verbatim", () => {
    expect(moveCountersCopy(resp())).toBe(
      "12 events and 1 suppression moved to the primary.",
    );
  });
});

describe("mergeResultCopy", () => {
  it("states the soft delete (NOT a hard delete)", () => {
    const c = mergeResultCopy(resp(), "keep@x.com", "dupe@x.com");
    expect(c.message).toBe("Subscriber rows merged");
    expect(c.message).not.toContain("@");
    expect(c.detail).toMatch(/soft-deleted \(disabled\), not erased/i);
  });

  it("flags a missing loser_soft_deleted instead of asserting it", () => {
    const c = mergeResultCopy(
      resp({ loser_soft_deleted: false }),
      "keep@x.com",
      "dupe@x.com",
    );
    expect(c.detail).toMatch(/did NOT report/i);
  });
});

describe("isAlreadyMerged", () => {
  it("matches the typed 409 already_merged", () => {
    expect(
      isAlreadyMerged({
        error: {
          message: "x",
          status: 409,
          code: "already_merged",
          kind: "http",
        },
      }),
    ).toBe(true);
    // A bare 409 may be stale_review/candidate_stale and must never be
    // presented as a successful merge.
    expect(
      isAlreadyMerged({ error: { message: "x", status: 409, kind: "http" } }),
    ).toBe(false);
    expect(
      isAlreadyMerged({ error: { message: "x", code: "already_merged" } }),
    ).toBe(true);
  });

  it("ignores successes and other errors", () => {
    expect(isAlreadyMerged({ data: resp() })).toBe(false);
    expect(
      isAlreadyMerged({
        error: { message: "boom", status: 500, kind: "http" },
      }),
    ).toBe(false);
  });
});
