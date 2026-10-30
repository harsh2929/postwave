import { describe, expect, it } from "vitest";

import { localizedPathForLangOverride } from "@/lib/i18n-paths";

describe("localizedPathForLangOverride", () => {
  it("prefixes unlocalized public paths with the requested locale", () => {
    expect(localizedPathForLangOverride("/preferences/tok_123", "es")).toBe(
      "/es/preferences/tok_123",
    );
  });

  it("replaces an existing locale prefix", () => {
    expect(localizedPathForLangOverride("/en/forms/signup", "fr")).toBe(
      "/fr/forms/signup",
    );
  });

  it("normalizes missing leading slashes", () => {
    expect(localizedPathForLangOverride("landing/spring", "pt")).toBe(
      "/pt/landing/spring",
    );
  });
});
