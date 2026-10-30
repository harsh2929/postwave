import { describe, expect, it } from "vitest";

import {
  formStatusPresentation,
  matchesFormQuery,
  safeHostedFormUrl,
} from "./formStatus";

describe("formStatusPresentation", () => {
  it("names the two states an operator actually cares about", () => {
    expect(formStatusPresentation("published")).toEqual({
      label: "Live",
      tone: "success",
      live: true,
    });
    expect(formStatusPresentation("draft")).toMatchObject({
      label: "Draft",
      live: false,
    });
    expect(formStatusPresentation("archived")).toMatchObject({
      label: "Archived",
      live: false,
    });
  });

  it("treats an absent status as draft, matching the server's own default", () => {
    expect(formStatusPresentation(undefined).label).toBe("Draft");
    expect(formStatusPresentation("   ").label).toBe("Draft");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(formStatusPresentation("  PUBLISHED ").live).toBe(true);
  });

  it("reports an unknown status as unknown instead of guessing 'Draft'", () => {
    expect(formStatusPresentation("quarantined")).toEqual({
      label: "Unrecognised status",
      tone: "warning",
      live: false,
    });
  });
});

describe("matchesFormQuery", () => {
  it("matches on name or slug, folding case and diacritics", () => {
    const form = { name: "Café signup", slug: "cafe-signup" };
    expect(matchesFormQuery(form, "cafe")).toBe(true);
    expect(matchesFormQuery(form, "CAFÉ")).toBe(true);
    expect(matchesFormQuery(form, "signup")).toBe(true);
    expect(matchesFormQuery(form, "newsletter")).toBe(false);
  });

  it("treats a blank or whitespace query as matching everything", () => {
    expect(matchesFormQuery({}, "")).toBe(true);
    expect(matchesFormQuery({}, "   ")).toBe(true);
  });

  it("does not crash on a row missing both fields", () => {
    expect(matchesFormQuery({}, "anything")).toBe(false);
  });
});

describe("safeHostedFormUrl", () => {
  it("accepts only an absolute http(s) URL the server produced", () => {
    expect(safeHostedFormUrl("https://forms.example.com/forms/a")).toBe(
      "https://forms.example.com/forms/a",
    );
    expect(safeHostedFormUrl("  http://localhost:8080/forms/a  ")).toBe(
      "http://localhost:8080/forms/a",
    );
  });

  it("rejects anything that is not an absolute web URL", () => {
    // A "View live page" button that opens a 404 — or a javascript: URL — is
    // worse than no button, so this fails closed rather than guessing a host.
    expect(safeHostedFormUrl(undefined)).toBeNull();
    expect(safeHostedFormUrl("")).toBeNull();
    expect(safeHostedFormUrl("/forms/a")).toBeNull();
    expect(safeHostedFormUrl("forms.example.com/forms/a")).toBeNull();
    expect(safeHostedFormUrl("javascript:alert(1)")).toBeNull();
    expect(safeHostedFormUrl("https://")).toBeNull();
  });
});
