// SPDX-License-Identifier: AGPL-3.0-only
//
// The wording and key rules the import wizard and paste dialog share with the
// API. Key suggestions must agree with the preview's server-side suggestions
// (subscriber_import/custom_field_policy_test.go pins the same headers), or a
// column switched to "Custom field" on the web would get a different key than
// the same column detected by the preview.
import { describe, expect, it } from "vitest";

import {
  customFieldMappingProblem,
  isValidCustomFieldKey,
  suggestCustomFieldKey,
  undeclaredCustomFieldKeys,
} from "@/lib/subscriber-imports-api";
import {
  describeSubscriberRowError,
  summarizeSubscriberRowFailures,
} from "@/lib/subscriber-row-errors";

describe("custom field keys", () => {
  it("suggests the same valid key the preview does", () => {
    expect(suggestCustomFieldKey("Plan Type", 1)).toBe("plan_type");
    expect(suggestCustomFieldKey("Plan-Type", 2)).toBe("plan_type");
    expect(suggestCustomFieldKey("2024 Spend", 3)).toBe("field_2024_spend");
    expect(suggestCustomFieldKey("!!!", 4)).toBe("column_5");
    expect(suggestCustomFieldKey("Préférence", 5)).toBe("pr_f_rence");
    const long = suggestCustomFieldKey("Quarterly revenue ".repeat(8), 6);
    expect(long.length).toBeLessThanOrEqual(64);
    expect(isValidCustomFieldKey(long)).toBe(true);
  });

  it("explains an invalid or doubled key before the PATCH would", () => {
    expect(
      customFieldMappingProblem([
        { index: 0, name: "email", kind: "email" },
        { index: 1, name: "Plan", kind: "custom", custom_key: "plan-type" },
      ]),
    ).toBe(
      "Give “Plan” a custom field key that starts with a lower-case letter and uses only a–z, 0–9 and underscores.",
    );
    expect(
      customFieldMappingProblem([
        { index: 1, name: "Plan", kind: "custom", custom_key: "plan" },
        { index: 2, name: "Tier", kind: "custom", custom_key: "PLAN" },
      ]),
    ).toBe("“Plan” and “Tier” both map to the custom field “plan”. Give each column its own key.");
    expect(
      customFieldMappingProblem([{ index: 1, name: "Plan", kind: "custom", custom_key: "Plan" }]),
    ).toBeNull();
  });

  it("lists only valid mapped keys the workspace hasn't defined", () => {
    expect(
      undeclaredCustomFieldKeys(
        [
          { index: 0, name: "email", kind: "email" },
          { index: 1, name: "Tier", kind: "custom", custom_key: "tier" },
          { index: 2, name: "Age", kind: "custom", custom_key: "age" },
          { index: 3, name: "plan", kind: "custom" },
          { index: 4, name: "Notes", kind: "ignore", custom_key: "notes" },
          { index: 5, name: "Bad", kind: "custom", custom_key: "bad-key" },
        ],
        [{ key: "age" }],
      ),
    ).toEqual(["plan", "tier"]);
  });
});

describe("row failure reasons", () => {
  it("words known codes from the operator's side and falls back to the server's sentence", () => {
    expect(describeSubscriberRowError({ error_code: "erasure_blocked", error: "legacy text" })).toBe(
      "Permanently erased when the contact was deleted or by a privacy request, so it can't be added again.",
    );
    expect(
      describeSubscriberRowError({
        error_code: "unknown_custom_field",
        error: 'Custom field "plan" isn\'t defined. Let the import create it, add it under Settings › Custom fields, or skip the column.',
      }),
    ).toBe(
      'Custom field "plan" isn\'t defined. Let the import create it, add it under Settings › Custom fields, or skip the column.',
    );
    expect(describeSubscriberRowError({ error_code: "validation_failed", error: "email must be a valid mailbox address" })).toBe(
      "Email must be a valid mailbox address.",
    );
    expect(describeSubscriberRowError({})).toBe("Couldn't be added.");
  });

  it("summarises failures by cause for a toast", () => {
    expect(summarizeSubscriberRowFailures([])).toBe("");
    expect(summarizeSubscriberRowFailures([{ error_code: "erasure_blocked" }, { error_code: "erasure_blocked" }])).toBe(
      "2 were permanently erased and can't be added again.",
    );
    expect(
      summarizeSubscriberRowFailures([{ error_code: "erasure_blocked" }, { error_code: "validation_failed" }]),
    ).toBe("1 was permanently erased and can't be added again; 1 couldn't be added.");
  });
});
