import { describe, expect, it } from "vitest";

import {
  filterForms,
  formatCount,
  nextSort,
  paginate,
  sortForms,
  totalPages,
} from "@/lib/forms-list-helpers";
import type { FormListItem } from "@/lib/forms-types";

function form(over: Partial<FormListItem>): FormListItem {
  return {
    id: over.id ?? "1",
    tenantId: "t",
    slug: over.slug ?? "slug",
    name: over.name ?? "Form",
    optInMode: "double",
    structure: { fields: [] },
    settings: { successMessage: "" },
    status: over.status ?? "draft",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: over.updatedAt ?? "2026-01-01T00:00:00Z",
    submissions30d: over.submissions30d ?? 0,
    visits30d: over.visits30d ?? 0,
    conversionRate: over.conversionRate ?? 0,
  };
}

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(1234567)).toBe((1234567).toLocaleString());
    expect(formatCount(0)).toBe("0");
  });
  it("is defensive against NaN", () => {
    expect(formatCount(Number.NaN)).toBe("0");
  });
});

describe("filterForms", () => {
  const forms = [
    form({ id: "a", name: "Newsletter", slug: "news", status: "published" }),
    form({ id: "b", name: "Waitlist", slug: "wait", status: "draft" }),
    form({ id: "c", name: "Old", slug: "old", status: "archived" }),
  ];

  it("filters by name or slug (case-insensitive)", () => {
    expect(filterForms(forms, { q: "news" }).map((f) => f.id)).toEqual(["a"]);
    expect(filterForms(forms, { q: "WAIT" }).map((f) => f.id)).toEqual(["b"]);
  });

  it("filters by status", () => {
    expect(filterForms(forms, { status: "archived" }).map((f) => f.id)).toEqual([
      "c",
    ]);
    expect(filterForms(forms, { status: "all" })).toHaveLength(3);
  });

  it("combines status + query", () => {
    expect(
      filterForms(forms, { q: "o", status: "archived" }).map((f) => f.id),
    ).toEqual(["c"]);
    expect(filterForms(forms, { q: "news", status: "draft" })).toEqual([]);
  });
});

describe("sortForms", () => {
  const forms = [
    form({ id: "a", name: "Beta", submissions30d: 5, updatedAt: "2026-02-01T00:00:00Z" }),
    form({ id: "b", name: "Alpha", submissions30d: 50, updatedAt: "2026-03-01T00:00:00Z" }),
    form({ id: "c", name: "Gamma", submissions30d: 5, updatedAt: "2026-01-01T00:00:00Z" }),
  ];

  it("sorts by name ascending", () => {
    expect(sortForms(forms, "name", "asc").map((f) => f.name)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
  });

  it("sorts by submissions descending with a stable name tie-break", () => {
    expect(sortForms(forms, "submissions30d", "desc").map((f) => f.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("sorts by updatedAt", () => {
    expect(sortForms(forms, "updatedAt", "desc").map((f) => f.id)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("does not mutate the input", () => {
    const before = forms.map((f) => f.id);
    sortForms(forms, "name", "asc");
    expect(forms.map((f) => f.id)).toEqual(before);
  });
});

describe("nextSort", () => {
  it("flips direction when clicking the active column", () => {
    expect(nextSort({ sort: "name", order: "asc" }, "name")).toEqual({
      sort: "name",
      order: "desc",
    });
  });
  it("uses the natural default direction for a new column", () => {
    expect(nextSort({ sort: "name", order: "asc" }, "submissions30d")).toEqual({
      sort: "submissions30d",
      order: "desc",
    });
    expect(nextSort({ sort: "submissions30d", order: "desc" }, "name")).toEqual({
      sort: "name",
      order: "asc",
    });
  });
});

describe("paginate / totalPages", () => {
  const items = [1, 2, 3, 4, 5];
  it("slices a page", () => {
    expect(paginate(items, 1, 2)).toEqual([1, 2]);
    expect(paginate(items, 3, 2)).toEqual([5]);
  });
  it("computes page count with a floor of 1", () => {
    expect(totalPages(0, 10)).toBe(1);
    expect(totalPages(21, 10)).toBe(3);
  });
});
