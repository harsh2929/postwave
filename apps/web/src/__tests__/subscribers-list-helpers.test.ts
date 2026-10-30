// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";

import {
  formatListDate,
  nextSort,
  statusFilterToParam,
  subscriberStatusVariant,
} from "@/app/(dashboard)/app/subscribers/subscribers-list-helpers";

describe("subscriberStatusVariant", () => {
  it("maps lifecycle statuses to semantic badge variants", () => {
    expect(subscriberStatusVariant("enabled")).toBe("success");
    expect(subscriberStatusVariant("blocklisted")).toBe("destructive");
    expect(subscriberStatusVariant("unconfirmed")).toBe("secondary");
    expect(subscriberStatusVariant("disabled")).toBe("outline");
  });
});

describe("statusFilterToParam", () => {
  it("maps UI filters to backend status params", () => {
    expect(statusFilterToParam("all")).toBeUndefined();
    expect(statusFilterToParam("enabled")).toBe("enabled");
    expect(statusFilterToParam("suppressed")).toBe("blocklisted");
    expect(statusFilterToParam("pending")).toBe("unconfirmed");
  });
});

describe("nextSort", () => {
  it("toggles order when the same column is clicked", () => {
    expect(nextSort({ sort: "email", order: "asc" }, "email")).toEqual({
      sort: "email",
      order: "desc",
    });
    expect(nextSort({ sort: "email", order: "desc" }, "email")).toEqual({
      sort: "email",
      order: "asc",
    });
  });

  it("switches column and starts descending", () => {
    expect(nextSort({ sort: "email", order: "asc" }, "updated_at")).toEqual({
      sort: "updated_at",
      order: "desc",
    });
  });
});

describe("formatListDate", () => {
  it("renders an unambiguous month-day-year label", () => {
    expect(formatListDate("2026-05-01T10:00:00Z")).toMatch(/2026/);
    expect(formatListDate("2026-05-01T10:00:00Z")).toMatch(/May/);
  });

  it("guards missing / invalid values with a dash", () => {
    expect(formatListDate(undefined)).toBe("-");
    expect(formatListDate("not-a-date")).toBe("-");
  });
});
