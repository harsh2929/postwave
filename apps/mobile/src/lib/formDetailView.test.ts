import { describe, expect, it } from "vitest";

import {
  analyticsErrorMessage,
  formFetchState,
  formHeaderText,
  submissionsErrorMessage,
} from "./formDetailView";

const rel = (v: unknown) => `rel(${String(v)})`;

describe("formFetchState", () => {
  it("separates 'not deployed / gone' from a retryable fault", () => {
    for (const status of [404, 405, 501]) {
      expect(
        formFetchState({
          error: { status, message: "nope" },
          threw: false,
          hasId: true,
        }),
      ).toMatchObject({ unavailable: true, hardError: false });
    }
    expect(
      formFetchState({
        error: { status: 500, message: "boom" },
        threw: false,
        hasId: true,
      }),
    ).toMatchObject({ unavailable: false, hardError: true, errorMessage: "boom" });
  });

  it("treats a thrown query as a hard error even with no envelope", () => {
    expect(
      formFetchState({ error: null, threw: true, hasId: true }),
    ).toMatchObject({ unavailable: false, hardError: true });
  });

  it("is a hard error with a specific message when no id was routed", () => {
    const state = formFetchState({ error: null, threw: false, hasId: false });
    expect(state.hardError).toBe(true);
    expect(state.errorMessage).toContain("No form was selected");
  });

  it("is neither state on a clean fetch", () => {
    expect(
      formFetchState({ error: null, threw: false, hasId: true }),
    ).toMatchObject({ unavailable: false, hardError: false });
  });
});

describe("analyticsErrorMessage", () => {
  it("names a 403 as a role boundary, not a breakage", () => {
    expect(analyticsErrorMessage({ status: 403, message: "forbidden" })).toBe(
      "Visit analytics unavailable — your role can't read reports.",
    );
  });

  it("passes any other failure through verbatim", () => {
    expect(analyticsErrorMessage({ status: 500, message: "db down" })).toBe(
      "Visit analytics unavailable: db down",
    );
    expect(analyticsErrorMessage(null)).toBeNull();
  });
});

describe("submissionsErrorMessage", () => {
  it("prefers the server envelope over the generic fallback", () => {
    expect(submissionsErrorMessage({ status: 500, message: "oops" }, true)).toBe(
      "oops",
    );
    expect(submissionsErrorMessage(null, true)).toBe(
      "Couldn't load submissions.",
    );
    expect(submissionsErrorMessage(null, false)).toBeNull();
  });
});

describe("formHeaderText", () => {
  it("asserts no status before the row has loaded", () => {
    expect(formHeaderText(null, rel)).toEqual({
      title: "Form",
      subtitle: undefined,
    });
  });

  it("falls back name → slug → 'Form' and ignores whitespace-only names", () => {
    expect(formHeaderText({ name: "  ", slug: "newsletter" }, rel).title).toBe(
      "newsletter",
    );
    expect(formHeaderText({ name: "Signup" }, rel).title).toBe("Signup");
    expect(formHeaderText({}, rel).title).toBe("Form");
  });

  it("appends a relative updated time only when one exists", () => {
    expect(
      formHeaderText({ status: "published", updatedAt: "2026-07-01" }, rel)
        .subtitle,
    ).toBe("Live · updated rel(2026-07-01)");
    expect(formHeaderText({ status: "draft" }, rel).subtitle).toBe("Draft");
  });
});
