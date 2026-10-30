import { describe, expect, it } from "vitest";

import {
  FORM_ARCHIVED_TERMINAL_NOTE,
  FORM_DELETE_MINIMUM_ROLE,
  FORM_LIFECYCLE_MINIMUM_ROLE,
  createFormDraftProblem,
  formLifecycleActions,
  suggestFormSlug,
} from "./formLifecycle";

describe("formLifecycleActions", () => {
  it("offers publish and archive on a draft", () => {
    const actions = formLifecycleActions("draft", "Spring popup");
    expect(actions.map((a) => a.target)).toEqual(["published", "archived"]);
    expect(actions[0]?.label).toBe("Publish");
    expect(actions[0]?.destructive).toBe(false);
  });

  it("offers move-to-draft and archive on a published form, both destructive", () => {
    const actions = formLifecycleActions("published", "Spring popup");
    expect(actions.map((a) => a.target)).toEqual(["draft", "archived"]);
    // Pulling a LIVE form off the public internet is the consequential
    // direction; both verbs must paint the danger colour.
    expect(actions.every((a) => a.destructive)).toBe(true);
  });

  it("offers NOTHING on an archived form — the server has no transition out", () => {
    // forms.go:141-154 AllowedTransition: archived is terminal, and an
    // attempted transition surfaces as a 500. A verb here is a trap.
    expect(formLifecycleActions("archived", "Spring popup")).toEqual([]);
    expect(FORM_ARCHIVED_TERMINAL_NOTE).toContain("permanent");
  });

  it("tells the archive confirm that the state is permanent", () => {
    const archive = formLifecycleActions("draft", "F").find(
      (a) => a.target === "archived",
    );
    expect(archive?.confirmMessage).toContain("PERMANENT");
    expect(archive?.destructive).toBe(true);
  });

  it("normalises case and whitespace before matching", () => {
    expect(formLifecycleActions("  Published ").map((a) => a.target)).toEqual([
      "draft",
      "archived",
    ]);
  });

  it("returns NO verbs for an unknown status rather than guessing", () => {
    expect(formLifecycleActions("suspended")).toEqual([]);
    expect(formLifecycleActions(undefined)).toEqual([]);
    expect(formLifecycleActions(null)).toEqual([]);
    expect(formLifecycleActions("")).toEqual([]);
  });

  it("names the form in the confirm copy, with a fallback", () => {
    expect(formLifecycleActions("draft", "Spring popup")[0]?.confirmTitle).toBe(
      "Publish Spring popup?",
    );
    expect(formLifecycleActions("draft", "  ")[0]?.confirmTitle).toBe(
      "Publish this form?",
    );
  });

  it("tells a published form's move-to-draft what it stops, not just what it renames", () => {
    const toDraft = formLifecycleActions("published", "F")[0];
    expect(toDraft?.confirmMessage).toContain("stops being served");
  });
});

describe("suggestFormSlug", () => {
  it("lowers, hyphenates and bounds the name", () => {
    expect(suggestFormSlug("  Spring Popup! 2026  ")).toBe("spring-popup-2026");
    expect(suggestFormSlug("Æ")).toBe("");
    expect(suggestFormSlug("a".repeat(300)).length).toBe(128);
  });

  it("drops apostrophes instead of hyphenating mid-word", () => {
    expect(suggestFormSlug("Ada's list")).toBe("adas-list");
  });
});

describe("createFormDraftProblem", () => {
  const good = {
    name: "Spring popup",
    slug: "spring-popup",
    optInMode: "double" as const,
    successMessage: "",
  };

  it("accepts a valid draft", () => {
    expect(createFormDraftProblem(good)).toBeNull();
  });

  it("requires a name and a slug", () => {
    expect(createFormDraftProblem({ ...good, name: " " })).toContain("name");
    expect(createFormDraftProblem({ ...good, slug: "" })).toContain("slug");
  });

  it("refuses the characters the server's validateSlug refuses", () => {
    expect(createFormDraftProblem({ ...good, slug: "Spring Popup" })).toContain(
      "lowercase",
    );
    expect(createFormDraftProblem({ ...good, slug: "a/b" })).not.toBeNull();
  });

  it("enforces the server's length caps", () => {
    expect(
      createFormDraftProblem({ ...good, name: "a".repeat(201) }),
    ).toContain("200");
    expect(
      createFormDraftProblem({ ...good, slug: "a".repeat(129) }),
    ).toContain("128");
  });
});

describe("role floors", () => {
  // These constants ARE the manifest floors; a screen gating on them is
  // gating on the server's rule. If either drifts, the affordance either
  // hides from people who may act or promises a guaranteed 403.
  it("PATCH is editor, DELETE is admin — the manifest floors", () => {
    expect(FORM_LIFECYCLE_MINIMUM_ROLE).toBe("editor");
    expect(FORM_DELETE_MINIMUM_ROLE).toBe("admin");
  });
});
