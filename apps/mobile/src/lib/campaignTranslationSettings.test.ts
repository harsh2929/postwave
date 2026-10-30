/**
 * The tenant translation settings + dictionary readers and the two validator
 * mirrors. Wire fixtures are the EXACT shapes translations.go writes
 * (Settings :141, {entries: [DictionaryEntry]} :412, RenderResult :794) —
 * hand-built here, never derived from the code under test.
 */
import { describe, expect, it } from "vitest";

import {
  dictionaryEntrySummary,
  localeProblem,
  parseLocalesList,
  readDictionaryEntries,
  readTranslationPreview,
  readTranslationSettings,
  termProblem,
  translationPreviewNote,
  translationSettingsSentence,
} from "./campaignTranslationSettings";

const WIRE_SETTINGS = {
  tenant_id: "t-1",
  enabled: true,
  default_locale: "en",
  supported_locales: ["en", "es", "pt-BR"],
  fallback_strategy: "default_only",
  locale_attribute: "locale",
  updated_at: "2026-08-29T10:00:00Z",
};

describe("readTranslationSettings", () => {
  it("reads the exact settings wire shape", () => {
    expect(readTranslationSettings(WIRE_SETTINGS)).toEqual({
      enabled: true,
      defaultLocale: "en",
      supportedLocales: ["en", "es", "pt-BR"],
      fallbackStrategy: "default_only",
      localeAttribute: "locale",
    });
  });

  it("defaults an unknown fallback strategy to subscriber_locale", () => {
    const reading = readTranslationSettings({
      ...WIRE_SETTINGS,
      fallback_strategy: "surprise",
    });
    expect(reading?.fallbackStrategy).toBe("subscriber_locale");
  });

  it("returns null when enabled is absent (the shape sentinel)", () => {
    expect(readTranslationSettings({ default_locale: "en" })).toBeNull();
    expect(readTranslationSettings(null)).toBeNull();
    expect(readTranslationSettings("nope")).toBeNull();
  });

  it("drops non-string locales rather than crashing", () => {
    const reading = readTranslationSettings({
      ...WIRE_SETTINGS,
      supported_locales: ["en", 7, null, "de"],
    });
    expect(reading?.supportedLocales).toEqual(["en", "de"]);
  });
});

describe("readDictionaryEntries", () => {
  it("reads {entries} rows and coerces the optional fields", () => {
    const rows = readDictionaryEntries({
      entries: [
        {
          id: "d-1",
          term: "Moosewave Pro",
          translations: { es: "Moosewave Pro", de: "Moosewave Pro" },
          case_sensitive: true,
          notes: "brand",
          updated_at: "2026-08-29T10:00:00Z",
        },
        { id: "d-2", term: "opt out", translations: null },
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: "d-1",
      term: "Moosewave Pro",
      translations: { es: "Moosewave Pro", de: "Moosewave Pro" },
      caseSensitive: true,
      notes: "brand",
    });
    expect(rows[1]?.translations).toEqual({});
    expect(rows[1]?.caseSensitive).toBe(false);
  });

  it("returns [] for the envelope, a bare array, and junk rows", () => {
    // The classic envelope mistake: rawRequest's {data,error} handed straight in.
    expect(readDictionaryEntries({ data: { entries: [] }, error: null })).toEqual(
      [],
    );
    expect(readDictionaryEntries([])).toEqual([]);
    expect(
      readDictionaryEntries({ entries: [{ term: "no-id" }, 42, null] }),
    ).toEqual([]);
  });
});

describe("validator mirrors", () => {
  it("localeProblem mirrors validateLocale (2..16, [a-zA-Z0-9_-])", () => {
    expect(localeProblem("en")).toBeNull();
    expect(localeProblem(" pt-BR ")).toBeNull();
    expect(localeProblem("zh_Hant")).toBeNull();
    expect(localeProblem("e")).not.toBeNull();
    expect(localeProblem("a".repeat(17))).not.toBeNull();
    expect(localeProblem("en!")).not.toBeNull();
    expect(localeProblem("en us")).not.toBeNull();
  });

  it("termProblem mirrors validateTerm (1..256, no sentinel, no control chars)", () => {
    expect(termProblem("Moosewave Pro")).toBeNull();
    expect(termProblem("")).not.toBeNull();
    expect(termProblem("x".repeat(257))).not.toBeNull();
    expect(termProblem("evil [[PWMASK_0]]")).not.toBeNull();
    expect(termProblem("closer ]]")).not.toBeNull();
    expect(termProblem("tab\tterm")).not.toBeNull();
  });

  it("parseLocalesList trims, splits on commas/whitespace and dedupes in order", () => {
    expect(parseLocalesList(" en, pt-BR de\nen ,, ")).toEqual([
      "en",
      "pt-BR",
      "de",
    ]);
    expect(parseLocalesList("")).toEqual([]);
  });
});

describe("sentences", () => {
  it("says off means default-language-for-everyone", () => {
    expect(
      translationSettingsSentence({
        enabled: false,
        defaultLocale: "en",
        supportedLocales: ["en", "es"],
        fallbackStrategy: "subscriber_locale",
        localeAttribute: "locale",
      }),
    ).toBe(
      "Automatic translation is off — every recipient gets the default language.",
    );
  });

  it("counts locales and names the fallback when on", () => {
    expect(
      translationSettingsSentence({
        enabled: true,
        defaultLocale: "en",
        supportedLocales: ["en", "es", "de"],
        fallbackStrategy: "default_only",
        localeAttribute: "locale",
      }),
    ).toBe(
      "Automatic translation is on for 3 locales (default en); unmatched recipients get the default.",
    );
  });

  it("summarizes a dictionary row with its locale count and case flag", () => {
    expect(
      dictionaryEntrySummary({
        id: "d-1",
        term: "Moosewave Pro",
        translations: { es: "x" },
        caseSensitive: true,
        notes: "",
      }),
    ).toBe("Moosewave Pro — locked in 1 locale, case-sensitive");
    expect(
      dictionaryEntrySummary({
        id: "d-2",
        term: "opt out",
        translations: {},
        caseSensitive: false,
        notes: "",
      }),
    ).toBe("opt out — no locked translations");
  });
});

describe("readTranslationPreview", () => {
  it("reads the RenderResult wire shape", () => {
    expect(
      readTranslationPreview({
        body: "Hola",
        locale: "es",
        cache_hit: true,
        dictionary_matches: 2,
        skipped: false,
      }),
    ).toEqual({
      body: "Hola",
      locale: "es",
      cacheHit: true,
      dictionaryMatches: 2,
      skipped: false,
    });
    expect(readTranslationPreview({ locale: "es" })).toBeNull();
  });

  it("phrases the meta line for skip / cache / dictionary counts", () => {
    expect(
      translationPreviewNote({
        body: "b",
        locale: "es",
        cacheHit: false,
        dictionaryMatches: 0,
        skipped: true,
      }),
    ).toBe("Translation is turned off, so the body came back unchanged.");
    expect(
      translationPreviewNote({
        body: "b",
        locale: "es",
        cacheHit: true,
        dictionaryMatches: 1,
        skipped: false,
      }),
    ).toBe("Rendered from the cache, 1 dictionary term applied.");
    expect(
      translationPreviewNote({
        body: "b",
        locale: "es",
        cacheHit: false,
        dictionaryMatches: 3,
        skipped: false,
      }),
    ).toBe("Rendered freshly translated, 3 dictionary terms applied.");
  });
});
