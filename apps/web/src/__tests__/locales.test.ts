// Tests the locale identification helpers. Two regressions we want to
// catch:
//   1. A new locale gets added to `locales` but `localeLabels` doesn't
//      get a matching entry — TS catches this at compile time but the
//      shape test below runs as a belt-and-braces guard.
//   2. `isLocale` accidentally accepts any string. The middleware
//      uses this as a guard before reading the URL ?lang= param,
//      so a permissive false positive opens us up to header injection
//      via locale-prefixed paths like /esattacker/.

import { describe, expect, it } from "vitest";

import {
  defaultLocale,
  isLocale,
  localeLabels,
  locales,
} from "@/i18n/locales";
import { documentLocaleFromParams } from "@/lib/document-locale";

describe("locales", () => {
  it("defaultLocale is in the set", () => {
    expect(locales).toContain(defaultLocale);
  });

  it("every locale has a label", () => {
    for (const l of locales) {
      expect(localeLabels[l]).toBeTruthy();
      expect(typeof localeLabels[l]).toBe("string");
    }
  });

  it("labels are rendered in their own language", () => {
    expect(localeLabels.en).toBe("English");
    expect(localeLabels.es).toMatch(/Español/);
    expect(localeLabels.ja).toMatch(/日本語/);
  });
});

describe("isLocale", () => {
  it("accepts every shipped locale", () => {
    for (const l of locales) {
      expect(isLocale(l)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isLocale("klingon")).toBe(false);
    expect(isLocale("")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it("does not accept a locale prefix that just starts with a known locale", () => {
    // Defensive: "en-attacker" is not a known locale even though it
    // starts with "en". Without the strict equality check, header-
    // injection style payloads could route into the en bundle.
    expect(isLocale("en-attacker")).toBe(false);
    expect(isLocale("esattacker")).toBe(false);
  });
});

describe("documentLocaleFromParams", () => {
  it("uses the locale route param for localized public pages", () => {
    expect(documentLocaleFromParams({ locale: "es" })).toBe("es");
    expect(documentLocaleFromParams({ locale: "ja" })).toBe("ja");
  });

  it("falls back to the default locale for unlocalized routes", () => {
    expect(documentLocaleFromParams(undefined)).toBe(defaultLocale);
    expect(documentLocaleFromParams({ locale: "esattacker" })).toBe(
      defaultLocale,
    );
  });
});
