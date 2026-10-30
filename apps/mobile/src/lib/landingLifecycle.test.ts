import { describe, expect, it } from "vitest";

import {
  LANDING_WRITE_MINIMUM_ROLE,
  archiveLandingCopy,
  createLandingDraftProblem,
  landingStatusVerb,
  suggestLandingSlug,
} from "./landingLifecycle";

describe("landingStatusVerb", () => {
  it("unpublishes a published page to draft, destructively", () => {
    const verb = landingStatusVerb("published", "Launch");
    expect(verb).toMatchObject({
      target: "draft",
      label: "Unpublish",
      destructive: true,
    });
    // The consequence is a 404 on a link someone may have paid to place.
    expect(verb?.confirmMessage).toContain("Not Found");
  });

  it("restores an archived page to DRAFT — never straight to published", () => {
    // Desktop's statusAction (landing-pages-helpers.ts:177-185): archived's
    // only exit is draft, so a restored page cannot silently go live.
    expect(landingStatusVerb("archived", "Launch")).toMatchObject({
      target: "draft",
      label: "Restore to draft",
      destructive: false,
    });
  });

  it("publishes a draft", () => {
    expect(landingStatusVerb("draft", "Launch")).toMatchObject({
      target: "published",
      label: "Publish",
      destructive: false,
    });
  });

  it("normalises case/whitespace and refuses unknown statuses", () => {
    expect(landingStatusVerb(" Published ")?.label).toBe("Unpublish");
    expect(landingStatusVerb("retired")).toBeNull();
    expect(landingStatusVerb(undefined)).toBeNull();
  });
});

describe("archiveLandingCopy", () => {
  it("says the archive is reversible and keeps leads", () => {
    const copy = archiveLandingCopy("Launch");
    expect(copy.confirmTitle).toBe("Archive Launch?");
    expect(copy.confirmMessage).toContain("restored to a draft");
    expect(copy.confirmMessage).toContain("kept");
  });
});

describe("create draft validation", () => {
  it("requires name and a url-safe slug", () => {
    expect(
      createLandingDraftProblem({ name: "Launch", slug: "launch-2026" }),
    ).toBeNull();
    expect(createLandingDraftProblem({ name: " ", slug: "x" })).toContain(
      "name",
    );
    expect(createLandingDraftProblem({ name: "X", slug: "" })).toContain(
      "slug",
    );
    expect(
      createLandingDraftProblem({ name: "X", slug: "Has Space" }),
    ).toContain("lowercase");
  });

  it("suggests a slug from the name", () => {
    expect(suggestLandingSlug("  Spring Launch! ")).toBe("spring-launch");
  });
});

describe("role floor", () => {
  it("every landing write is admin", () => {
    expect(LANDING_WRITE_MINIMUM_ROLE).toBe("admin");
  });
});
