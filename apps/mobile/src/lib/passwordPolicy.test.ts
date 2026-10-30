import { describe, expect, it } from "vitest";

import {
  MIN_PASSWORD_LENGTH,
  passwordBlockingError,
  passwordRules,
  passwordScore,
  unmetAdvisoryRules,
} from "./passwordPolicy";

describe("passwordBlockingError", () => {
  it("blocks only on the server's rule — length", () => {
    expect(passwordBlockingError("short")).toMatch(/at least 12/);
    expect(passwordBlockingError("a".repeat(MIN_PASSWORD_LENGTH))).toBeNull();
  });

  it("accepts the long all-lowercase passphrase sign-up used to reject", () => {
    // The exact regression: a diceware passphrase is stronger than
    // "Passw0rd!" and was blocked by a greyed-out button with no message.
    expect(passwordBlockingError("correct horse battery staple")).toBeNull();
  });

  it("names the empty case rather than returning a bare boolean", () => {
    expect(passwordBlockingError("")).toBe("Enter a password.");
  });
});

describe("passwordRules", () => {
  it("marks only the length rule as blocking", () => {
    const rules = passwordRules("correct horse battery staple");
    expect(rules.filter((r) => r.blocking).map((r) => r.key)).toEqual([
      "length",
    ]);
  });

  it("still reports the unmet advisory rules so the UI can guide", () => {
    // The space counts as a symbol, so a passphrase is short only of an
    // uppercase letter and a digit — and neither of those blocks submission.
    expect(unmetAdvisoryRules("correct horse battery staple").map((r) => r.key)).toEqual([
      "upper",
      "number",
    ]);
    expect(unmetAdvisoryRules("alllowercasenospace").map((r) => r.key)).toEqual([
      "upper",
      "number",
      "symbol",
    ]);
    expect(unmetAdvisoryRules("Passw0rd!aaaa")).toEqual([]);
  });
});

describe("passwordScore", () => {
  it("gives a long passphrase a strong score without symbols", () => {
    expect(passwordScore("correct horse battery staple").score).toBeGreaterThanOrEqual(
      3,
    );
  });

  it("scores an empty password at zero with no label", () => {
    expect(passwordScore("")).toEqual({ score: 0, label: "" });
  });

  it("never exceeds the 0–4 range", () => {
    const strong = passwordScore("Correct!Horse9Battery$Staple#Extra");
    expect(strong.score).toBe(4);
    expect(strong.label).toBe("strong");
  });

  it("rates a short mixed password below a long simple one", () => {
    expect(passwordScore("Ab1!").score).toBeLessThan(
      passwordScore("correct horse battery staple").score,
    );
  });
});
