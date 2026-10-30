import { describe, expect, it } from "vitest";

import {
  announcementFor,
  clearFieldError,
  FORM_ERROR_KEY,
  firstInvalidField,
  hasFieldErrors,
  NO_FIELD_ERRORS,
  setFieldErrors,
} from "./fieldErrors";

const ORDER = ["email", "password"] as const;

describe("setFieldErrors", () => {
  it("merges messages and drops blank ones rather than storing empty captions", () => {
    const withEmail = setFieldErrors(NO_FIELD_ERRORS, {
      email: "Enter a valid email address",
    });
    expect(withEmail).toEqual({ email: "Enter a valid email address" });

    const cleared = setFieldErrors(withEmail, { email: "   " });
    expect(hasFieldErrors(cleared)).toBe(false);
  });

  it("does not mutate the map it was given", () => {
    const before = setFieldErrors(NO_FIELD_ERRORS, { email: "bad" });
    setFieldErrors(before, { password: "worse" });
    expect(before).toEqual({ email: "bad" });
  });

  it("treats undefined as a clear, so a caller can pass a partial record", () => {
    const both = setFieldErrors(NO_FIELD_ERRORS, {
      email: "bad",
      password: "worse",
    });
    expect(setFieldErrors(both, { email: undefined })).toEqual({
      password: "worse",
    });
  });
});

describe("clearFieldError", () => {
  it("returns the SAME object when there is nothing to clear", () => {
    const errors = setFieldErrors(NO_FIELD_ERRORS, { email: "bad" });
    // Referential stability matters: this runs on every keystroke.
    expect(clearFieldError(errors, "password")).toBe(errors);
  });

  it("removes only the named key", () => {
    const errors = setFieldErrors(NO_FIELD_ERRORS, {
      email: "bad",
      password: "worse",
    });
    expect(clearFieldError(errors, "email")).toEqual({ password: "worse" });
  });
});

describe("firstInvalidField", () => {
  it("follows visual order, not insertion order", () => {
    const errors = setFieldErrors(NO_FIELD_ERRORS, {
      password: "worse",
      email: "bad",
    });
    expect(firstInvalidField(errors, ORDER)).toBe("email");
  });

  it("never focuses the form-level message, which has no control", () => {
    const errors = setFieldErrors(NO_FIELD_ERRORS, {
      [FORM_ERROR_KEY]: "Email or password is incorrect.",
    });
    expect(firstInvalidField(errors, ORDER)).toBeNull();
  });

  it("ignores keys the screen did not declare", () => {
    const errors = setFieldErrors(NO_FIELD_ERRORS, { nickname: "bad" });
    expect(firstInvalidField(errors, ORDER)).toBeNull();
  });
});

describe("announcementFor", () => {
  it("speaks one message — the first field error in visual order", () => {
    const errors = setFieldErrors(NO_FIELD_ERRORS, {
      password: "Password is required",
      email: "Enter a valid email address",
      [FORM_ERROR_KEY]: "Check the form",
    });
    expect(announcementFor(errors, ORDER)).toBe("Enter a valid email address");
  });

  it("falls back to the form-level message when no field is flagged", () => {
    const errors = setFieldErrors(NO_FIELD_ERRORS, {
      [FORM_ERROR_KEY]: "Email or password is incorrect.",
    });
    expect(announcementFor(errors, ORDER)).toBe(
      "Email or password is incorrect.",
    );
  });

  it("is empty when there is nothing to say", () => {
    expect(announcementFor(NO_FIELD_ERRORS, ORDER)).toBe("");
  });
});
