// SPDX-License-Identifier: AGPL-3.0-only
//
// Pure-logic tests for topic slug helpers (SETA-019).

import { describe, it, expect } from "vitest";

import { isDuplicateSlug, isValidSlug, slugify } from "@/lib/topic-slug";

describe("slugify", () => {
  it("kebab-cases a display name", () => {
    expect(slugify("Weekly Digest")).toBe("weekly-digest");
    expect(slugify("Product   Updates!")).toBe("product-updates");
  });
  it("strips leading/trailing separators", () => {
    expect(slugify("  Hello  ")).toBe("hello");
    expect(slugify("--News--")).toBe("news");
  });
  it("strips accents", () => {
    expect(slugify("Café Réservé")).toBe("cafe-reserve");
  });
  it("returns empty for punctuation-only input", () => {
    expect(slugify("!!!")).toBe("");
  });
});

describe("isValidSlug", () => {
  it("accepts kebab-case slugs", () => {
    expect(isValidSlug("weekly-digest")).toBe(true);
    expect(isValidSlug("news")).toBe(true);
    expect(isValidSlug("a1-b2-c3")).toBe(true);
  });
  it("rejects malformed slugs", () => {
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("Weekly Digest")).toBe(false);
    expect(isValidSlug("-leading")).toBe(false);
    expect(isValidSlug("trailing-")).toBe(false);
    expect(isValidSlug("double--dash")).toBe(false);
    expect(isValidSlug("Upper")).toBe(false);
    expect(isValidSlug("under_score")).toBe(false);
  });
});

describe("isDuplicateSlug", () => {
  const existing = [
    { id: "1", slug: "weekly-digest" },
    { id: "2", slug: "product-updates" },
  ];
  it("detects an existing slug (case-insensitive, trimmed)", () => {
    expect(isDuplicateSlug("weekly-digest", existing)).toBe(true);
    expect(isDuplicateSlug("  WEEKLY-DIGEST ", existing)).toBe(true);
  });
  it("returns false for a new slug", () => {
    expect(isDuplicateSlug("news", existing)).toBe(false);
  });
  it("ignores the topic being edited", () => {
    expect(isDuplicateSlug("weekly-digest", existing, "1")).toBe(false);
    expect(isDuplicateSlug("weekly-digest", existing, "2")).toBe(true);
  });
  it("returns false for an empty slug", () => {
    expect(isDuplicateSlug("", existing)).toBe(false);
  });
});
