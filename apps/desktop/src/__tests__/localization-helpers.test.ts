import { describe, expect, it } from "vitest";
import {
  buildLocalizationPatch,
  localizationDraftFrom,
  localizationDirty,
  normalizeCountry,
  normalizeLanguage,
  normalizeLocale,
  validateLocalization,
} from "../lib/localization-helpers";

describe("localization normalize", () => {
  it("language → lowercase 2-letter", () => {
    expect(normalizeLanguage(" EN ")).toBe("en");
    expect(normalizeLanguage("eng")).toBe("en");
  });
  it("country → uppercase 2-letter", () => {
    expect(normalizeCountry(" us ")).toBe("US");
    expect(normalizeCountry("usa")).toBe("US");
  });
  it("locale → BCP-47 casing", () => {
    expect(normalizeLocale("EN_us")).toBe("en-US");
    expect(normalizeLocale("pt-br")).toBe("pt-BR");
    expect(normalizeLocale("")).toBe("");
  });
});

describe("localization validate", () => {
  it("accepts empty + well-formed", () => {
    expect(validateLocalization({ locale: "", language: "", country: "", region: "" })).toBeNull();
    expect(validateLocalization({ locale: "en-US", language: "en", country: "US", region: "California" })).toBeNull();
  });
  it("rejects malformed", () => {
    expect(validateLocalization({ locale: "", language: "eng", country: "", region: "" })).toMatch(/Language/);
    expect(validateLocalization({ locale: "", language: "", country: "USA", region: "" })).toMatch(/Country/);
    expect(validateLocalization({ locale: "not a locale!", language: "", country: "", region: "" })).toMatch(/Locale/);
  });
});

describe("localization dirty + patch", () => {
  it("dirty detects a change vs the source (nulls → '')", () => {
    const src = { locale: null, language: "en", country: null, region: undefined };
    expect(localizationDirty(localizationDraftFrom(src), src)).toBe(false);
    expect(localizationDirty({ locale: "", language: "fr", country: "", region: "" }, src)).toBe(true);
  });
  it("buildLocalizationPatch normalizes", () => {
    const patch = buildLocalizationPatch({ locale: "en_us", language: "EN", country: "us", region: " CA " });
    expect(patch).toEqual({ locale: "en-US", language: "en", country: "US", region: "CA" });
  });
});
