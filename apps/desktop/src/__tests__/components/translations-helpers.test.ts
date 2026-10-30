/**
 * translations-helpers — coverage for the locale-list and dictionary
 * pair conversions behind composer/TranslationsPanel (full-surface
 * wiring #4), plus the honest 429/503 preview error copy.
 */

import { describe, expect, it } from "vitest";

import {
  dictionaryEntryValid,
  formatLocaleList,
  pairsFromTranslations,
  parseLocaleList,
  translatePreviewErrorCopy,
  translationsFromPairs,
} from "../../components/composer/translations-helpers";

describe("parseLocaleList / formatLocaleList", () => {
  it("splits on commas and whitespace, trimming empties", () => {
    expect(parseLocaleList("en, sv-SE de , fr-CA")).toEqual([
      "en",
      "sv-SE",
      "de",
      "fr-CA",
    ]);
  });

  it("dedupes case-insensitively keeping the first spelling", () => {
    expect(parseLocaleList("en, EN, sv, SV-se, sv-SE")).toEqual([
      "en",
      "sv",
      "SV-se",
    ]);
  });

  it("round-trips through formatLocaleList", () => {
    const locales = parseLocaleList("en, sv");
    expect(parseLocaleList(formatLocaleList(locales))).toEqual(locales);
  });

  it("handles the empty input", () => {
    expect(parseLocaleList("")).toEqual([]);
    expect(parseLocaleList("  ,  ,")).toEqual([]);
  });
});

describe("pairsFromTranslations / translationsFromPairs", () => {
  it("record → sorted pairs → record round-trips", () => {
    const rec = { sv: "Hej", de: "Hallo" };
    const pairs = pairsFromTranslations(rec);
    expect(pairs).toEqual([
      { locale: "de", value: "Hallo" },
      { locale: "sv", value: "Hej" },
    ]);
    expect(translationsFromPairs(pairs)).toEqual(rec);
  });

  it("drops half-filled rows instead of corrupting the entry", () => {
    expect(
      translationsFromPairs([
        { locale: "sv", value: "Hej" },
        { locale: "", value: "orphan" },
        { locale: "de", value: "  " },
      ]),
    ).toEqual({ sv: "Hej" });
  });

  it("duplicate locales keep the last row (what-you-see-last saves)", () => {
    expect(
      translationsFromPairs([
        { locale: "sv", value: "Hej" },
        { locale: "sv", value: "Hejsan" },
      ]),
    ).toEqual({ sv: "Hejsan" });
  });
});

describe("dictionaryEntryValid", () => {
  it("requires a term plus at least one complete pair", () => {
    expect(dictionaryEntryValid("", [{ locale: "sv", value: "Hej" }])).toBe(
      false,
    );
    expect(dictionaryEntryValid("Brand", [{ locale: "", value: "" }])).toBe(
      false,
    );
    expect(dictionaryEntryValid("Brand", [{ locale: "sv", value: "Hej" }])).toBe(
      true,
    );
  });
});

describe("translatePreviewErrorCopy", () => {
  it("429 → rate-limit copy, honoring Retry-After when present", () => {
    expect(
      translatePreviewErrorCopy({ status: 429, message: "too many" }),
    ).toBe("Translation rate-limited. Try again in a moment.");
    expect(
      translatePreviewErrorCopy({
        status: 429,
        message: "too many",
        retryAfterSeconds: 30,
      }),
    ).toBe("Translation rate-limited. Try again in ~30s.");
  });

  it("503 → model-not-configured copy", () => {
    expect(
      translatePreviewErrorCopy({ status: 503, message: "LLM not wired" }),
    ).toMatch(/isn't configured/);
  });

  it("anything else passes the server message through verbatim", () => {
    expect(
      translatePreviewErrorCopy({ status: 400, message: "bad locale" }),
    ).toBe("bad locale");
    expect(translatePreviewErrorCopy({ message: "network down" })).toBe(
      "network down",
    );
  });
});
