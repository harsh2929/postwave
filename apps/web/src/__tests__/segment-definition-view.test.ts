// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import { conditionLabel } from "@/components/segments/segment-definition-view";

describe("conditionLabel", () => {
  it("labels a simple equals condition with a friendly field name", () => {
    expect(
      conditionLabel({
        op: "condition",
        field: "email",
        comparator: "equals",
        value: "a@b.c",
      }),
    ).toBe("Email is a@b.c");
  });

  it("omits the value for presence operators", () => {
    expect(
      conditionLabel({
        op: "condition",
        field: "last_opened_at",
        comparator: "is_not_null",
        value: "",
      }),
    ).toBe("Last opened is set");
  });

  it("renders relative-date values in human terms", () => {
    expect(
      conditionLabel({
        op: "condition",
        field: "last_opened_at",
        comparator: "gte",
        value: "now-30d",
      }),
    ).toContain("30 days ago");
  });

  it("joins list values", () => {
    expect(
      conditionLabel({
        op: "condition",
        field: "tag",
        comparator: "in",
        value: ["vip", "beta"],
      }),
    ).toBe("Tag is one of vip, beta");
  });
});
