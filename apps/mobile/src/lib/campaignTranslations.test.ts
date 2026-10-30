import { describe, expect, it } from "vitest";

import {
  EMPTY_TRANSLATIONS,
  normalizeLocale,
  readCampaignTranslations,
  translationFallbackNote,
  translationUpsertBody,
  translationsSummary,
} from "./campaignTranslations";

describe("translationUpsertBody", () => {
  it("carries the existing bodies forward — the PUT is a full-row replace", () => {
    // The load-bearing contract of the subject edit: the server replaces the
    // WHOLE row, so a body dropped here is a body erased for every recipient
    // in the locale. (The subscribers PATCH bug, in miniature.)
    expect(
      translationUpsertBody(
        {
          locale: "es",
          subject: "old",
          bodyHtml: "<p>hola</p>",
          bodyMjml: "<mj-text>hola</mj-text>",
        },
        "  Nueva oferta  ",
      ),
    ).toEqual({
      subject: "Nueva oferta",
      body_html: "<p>hola</p>",
      body_mjml: "<mj-text>hola</mj-text>",
    });
  });
});

describe("normalizeLocale", () => {
  it("mirrors the gateway: lowercase language, uppercase region", () => {
    expect(normalizeLocale("ES")).toBe("es");
    expect(normalizeLocale("fr-ca")).toBe("fr-CA");
    expect(normalizeLocale("  PT-br  ")).toBe("pt-BR");
  });
  it("splits on the FIRST hyphen only", () => {
    expect(normalizeLocale("zh-hant-tw")).toBe("zh-HANT-TW");
  });
  it("is empty for junk", () => {
    expect(normalizeLocale("")).toBe("");
    expect(normalizeLocale("   ")).toBe("");
    expect(normalizeLocale(42)).toBe("");
    expect(normalizeLocale(null)).toBe("");
  });
});

describe("readCampaignTranslations", () => {
  it("returns the empty reading for absent / malformed payloads", () => {
    expect(readCampaignTranslations(null)).toEqual(EMPTY_TRANSLATIONS);
    expect(readCampaignTranslations({})).toEqual(EMPTY_TRANSLATIONS);
    expect(readCampaignTranslations({ translations: "no" })).toEqual(
      EMPTY_TRANSLATIONS,
    );
    expect(readCampaignTranslations({ translations: [] })).toEqual(
      EMPTY_TRANSLATIONS,
    );
  });

  it("reports a BLANK subject as 'uses the default', not as 'no subject'", () => {
    // The gateway's pick() substitutes the default for an empty field, so this
    // locale's recipients read an English subject over a Spanish body.
    const r = readCampaignTranslations({
      translations: [{ locale: "es", subject: "", body_html: "<p>hola</p>" }],
    });
    expect(r.rows[0]?.usesDefaultSubject).toBe(true);
    expect(r.rows[0]?.usesDefaultBody).toBe(false);
    expect(r.partialCount).toBe(1);
  });

  it("treats body_mjml alone as a real body", () => {
    const r = readCampaignTranslations({
      translations: [{ locale: "fr", subject: "Bonjour", body_mjml: "<mj/>" }],
    });
    expect(r.rows[0]?.usesDefaultBody).toBe(false);
    expect(r.partialCount).toBe(0);
  });

  it("flags a row with neither body field", () => {
    const r = readCampaignTranslations({
      translations: [
        { locale: "de", subject: "Hallo", body_html: "  ", body_mjml: "" },
      ],
    });
    expect(r.rows[0]?.usesDefaultBody).toBe(true);
  });

  it("drops locale-less rows and de-duplicates after normalisation", () => {
    const r = readCampaignTranslations({
      translations: [
        { locale: "", subject: "orphan" },
        { locale: "fr-CA", subject: "a", body_html: "x" },
        { locale: "FR-ca", subject: "b", body_html: "y" },
        null,
      ],
    });
    expect(r.rows.map((x) => x.locale)).toEqual(["fr-CA"]);
    // First wins — the list arrives ordered by locale from the server.
    expect(r.rows[0]?.subject).toBe("a");
  });

  it("sorts locales so the list is stable across renders", () => {
    const r = readCampaignTranslations({
      translations: [
        { locale: "pt", subject: "p", body_html: "x" },
        { locale: "de", subject: "d", body_html: "x" },
        { locale: "es", subject: "e", body_html: "x" },
      ],
    });
    expect(r.rows.map((x) => x.locale)).toEqual(["de", "es", "pt"]);
  });
});

describe("translationsSummary", () => {
  it("is null when there is nothing multilingual to warn about", () => {
    expect(translationsSummary(EMPTY_TRANSLATIONS)).toBeNull();
  });

  it("names the locales, and stops short of reassurance when any fall back", () => {
    const complete = readCampaignTranslations({
      translations: [
        { locale: "es", subject: "Hola", body_html: "x" },
        { locale: "fr", subject: "Salut", body_html: "y" },
      ],
    });
    expect(translationsSummary(complete)).toBe("2 translations: es, fr.");

    const partial = readCampaignTranslations({
      translations: [
        { locale: "es", subject: "", body_html: "x" },
        { locale: "fr", subject: "Salut", body_html: "y" },
      ],
    });
    expect(translationsSummary(partial)).toContain("1 of them falls back");
  });

  it("pluralises a single translation correctly", () => {
    const one = readCampaignTranslations({
      translations: [{ locale: "es", subject: "Hola", body_html: "x" }],
    });
    expect(translationsSummary(one)).toBe("1 translation: es.");
  });
});

describe("translationFallbackNote", () => {
  const row = (
    usesDefaultSubject: boolean,
    usesDefaultBody: boolean,
  ) => ({
    locale: "es",
    subject: "",
    usesDefaultSubject,
    usesDefaultBody,
    updatedAt: null,
  });

  it("says nothing when the translation is complete", () => {
    expect(translationFallbackNote(row(false, false))).toBeNull();
  });
  it("distinguishes all three incomplete shapes", () => {
    expect(translationFallbackNote(row(true, true))).toContain(
      "no content yet",
    );
    expect(translationFallbackNote(row(true, false))).toContain(
      "default subject with the translated body",
    );
    expect(translationFallbackNote(row(false, true))).toContain(
      "translated subject with the default body",
    );
  });
});
