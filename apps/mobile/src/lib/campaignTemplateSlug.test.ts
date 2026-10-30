import { describe, expect, it } from "vitest";

import {
  isValidTemplateSlug,
  saveAsTemplateProblem,
  slugifyTemplateName,
  TEMPLATE_SLUG_MAX,
  templateSlugProblem,
} from "./campaignTemplateSlug";

describe("slugifyTemplateName", () => {
  it("derives a slug the gateway's own regex accepts", () => {
    for (const name of [
      "Spring Launch 2026",
      "  Weekly   Newsletter  ",
      "Black Friday — 50% off!",
      "Café update",
    ]) {
      const slug = slugifyTemplateName(name);
      expect(slug, name).not.toBe("");
      expect(isValidTemplateSlug(slug), `${name} → ${slug}`).toBe(true);
    }
  });

  it("produces the obvious slug for an obvious name", () => {
    expect(slugifyTemplateName("Spring Launch 2026")).toBe(
      "spring-launch-2026",
    );
    expect(slugifyTemplateName("Café update")).toBe("cafe-update");
  });

  it("drops leading non-letters, which the pattern forbids", () => {
    // "2026 Recap" truncated would start with a digit and 400 on the server.
    expect(slugifyTemplateName("2026 Recap")).toBe("recap");
    expect(slugifyTemplateName("-- draft --")).toBe("draft");
  });

  it("returns empty when nothing usable survives, instead of a slug that 400s", () => {
    expect(slugifyTemplateName("!!!")).toBe("");
    expect(slugifyTemplateName("   ")).toBe("");
    expect(slugifyTemplateName("2026")).toBe("");
  });

  it("truncates to the server's ceiling without leaving a trailing dash", () => {
    const slug = slugifyTemplateName(`${"a".repeat(78)} tail`);
    expect(slug.length).toBeLessThanOrEqual(TEMPLATE_SLUG_MAX);
    expect(slug.endsWith("-")).toBe(false);
    expect(isValidTemplateSlug(slug)).toBe(true);
  });
});

describe("templateSlugProblem", () => {
  it("accepts a valid slug", () => {
    expect(templateSlugProblem("spring-launch-2026")).toBeNull();
  });

  it("names each rejection the server would make, before the round trip", () => {
    expect(templateSlugProblem("")).toContain("required");
    expect(templateSlugProblem("2026-recap")).toContain(
      "start with a lowercase letter",
    );
    expect(templateSlugProblem("Spring Launch")).toContain(
      "start with a lowercase letter",
    );
    expect(templateSlugProblem("spring launch")).toContain(
      "lowercase letters, numbers and dashes",
    );
    expect(templateSlugProblem("a".repeat(81))).toContain("at most 80");
  });
});

describe("saveAsTemplateProblem", () => {
  it("gives the conflict — the one an operator will actually hit — a next step", () => {
    expect(saveAsTemplateProblem(409, "slug_conflict", "exists")).toContain(
      "Pick a different one",
    );
  });

  it("classifies validation, absence and permission apart", () => {
    expect(saveAsTemplateProblem(400, "invalid_slug", "x")).toContain(
      "isn't valid",
    );
    expect(saveAsTemplateProblem(400, "missing_slug", "x")).toContain(
      "required",
    );
    expect(saveAsTemplateProblem(404, "campaign_not_found", "x")).toBe(
      "This campaign no longer exists.",
    );
    expect(saveAsTemplateProblem(403, undefined, "x")).toContain("admin-only");
  });

  it("keeps an unexpected server message visible", () => {
    expect(saveAsTemplateProblem(500, undefined, "boom")).toContain("boom");
    expect(saveAsTemplateProblem(0, undefined, " ")).toBe(
      "Couldn't save the template.",
    );
  });
});
