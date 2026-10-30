import { describe, expect, it } from "vitest";

import {
  createListBody,
  createListFailure,
  LIST_NAME_MAX,
  LIST_OPTIN_OPTIONS,
  LIST_TYPE_OPTIONS,
  listNameProblem,
} from "./listCreate";

describe("listNameProblem", () => {
  it("mirrors the server's only required field", () => {
    // Create :262-266 — trims, then 400 missing_name on empty.
    expect(listNameProblem("   ")).toBe("Give the list a name.");
    expect(listNameProblem("")).toBe("Give the list a name.");
    expect(listNameProblem(" Newsletter ")).toBeNull();
  });

  it("caps the name on a RUNE boundary before the write, not after", () => {
    expect(listNameProblem("a".repeat(LIST_NAME_MAX))).toBeNull();
    expect(listNameProblem("a".repeat(LIST_NAME_MAX + 1))).toContain(
      String(LIST_NAME_MAX),
    );
    // Emoji are one rune each; a UTF-16 length check would reject at half.
    expect(listNameProblem("😀".repeat(LIST_NAME_MAX))).toBeNull();
  });
});

describe("createListBody", () => {
  it("always sends type and optin so the choice is explicit", () => {
    expect(
      createListBody({ name: " News ", type: "public", optin: "double" }),
    ).toEqual({ name: "News", type: "public", optin: "double" });
  });

  it("carries the server's own defaults when the user does not change them", () => {
    expect(
      createListBody({ name: "x", type: "private", optin: "single" }),
    ).toEqual({ name: "x", type: "private", optin: "single" });
  });
});

describe("option copy", () => {
  it("warns that a PUBLIC list is reachable from outside Moosewave", () => {
    const pub = LIST_TYPE_OPTIONS.find((o) => o.value === "public");
    expect(pub?.hint).toContain("anyone with the link");
  });

  it("explains that DOUBLE opt-in blocks sending until confirmation", () => {
    const dbl = LIST_OPTIN_OPTIONS.find((o) => o.value === "double");
    expect(dbl?.hint).toContain("confirm");
  });
});

describe("createListFailure", () => {
  it("says NOTHING WAS CREATED for repo_unavailable — the handler guarantees it", () => {
    const text = createListFailure({
      status: 503,
      code: "repo_unavailable",
      message: "list identity repository is unavailable",
    });
    expect(text).toContain("Nothing was created");
  });

  it("names the role boundary on a 403", () => {
    expect(createListFailure({ status: 403, message: "forbidden" })).toContain(
      "editor role",
    );
  });

  it("maps the server's own validation code", () => {
    expect(
      createListFailure({ status: 400, code: "missing_name", message: "x" }),
    ).toBe("Give the list a name.");
  });

  it("falls back to the server's message", () => {
    expect(createListFailure({ status: 418, message: "teapot" })).toBe(
      "teapot",
    );
  });
});
