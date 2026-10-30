import { afterEach, describe, expect, it } from "vitest";

import {
  activeMessageLocale,
  interpolate,
  messageCatalogueSummary,
  missingMessageKeys,
  msg,
  pluralMsg,
  registerCatalogue,
  setMessageLocale,
  type Catalogue,
} from "./i18n";

afterEach(() => {
  // The module holds process-wide state on purpose (it is read from worklet-
  // free render paths thousands of times a session); each test resets it.
  setMessageLocale(undefined);
});

describe("interpolate", () => {
  it("groups numbers so a sentence agrees with every other number on screen", () => {
    // The banner this replaced printed a raw `${count}`, so a queue of 1200
    // read "1200 changes" next to "1,200" everywhere else in the app.
    expect(interpolate("{count} changes", { count: 1200 })).toBe(
      "1,200 changes",
    );
  });

  it("passes strings through untouched", () => {
    expect(interpolate("Showing {loaded} of {total}", {
      loaded: 25,
      total: "1,340 subscribers",
    })).toBe("Showing 25 of 1,340 subscribers");
  });

  it("leaves an unsupplied placeholder VISIBLE rather than blanking it", () => {
    // A literal brace in QA is a bug report; a silent gap is a sentence that
    // lost its number and nobody noticed.
    expect(interpolate("{count} left", {})).toBe("{count} left");
  });
});

describe("pluralMsg", () => {
  it("selects the English one/other forms", () => {
    expect(pluralMsg("offline.pending", 1)).toContain("1 change waiting");
    expect(pluralMsg("offline.pending", 3)).toContain("3 changes waiting");
  });

  it("swaps the whole SENTENCE, not a suffix", () => {
    // The pronoun moves with the count. A `${n===1?"":"s"}` suffix cannot do
    // this, which is the concrete reason the old copy was untranslatable.
    expect(pluralMsg("offline.pending", 1)).toContain("it will go out");
    expect(pluralMsg("offline.pending", 3)).toContain("they will go out");
  });

  it("merges count into the params so {count} needs passing once", () => {
    expect(pluralMsg("subscribers.count.filtered", 3, { noun: "bounced" })).toBe(
      "3 bounced subscribers",
    );
  });

  it("uses CLDR categories, not a binary rule, for the active locale", () => {
    // Russian: 1 → one, 2 → few, 5 → many. A binary rule cannot express this,
    // and that is the whole point of the plural entry shape.
    const ru: Catalogue = {
      "offline.pending": {
        one: "{count} изменение",
        few: "{count} изменения",
        many: "{count} изменений",
        other: "{count} изменения",
      },
    };
    registerCatalogue("ru", ru);
    setMessageLocale("ru-RU");
    expect(pluralMsg("offline.pending", 1)).toBe("1 изменение");
    expect(pluralMsg("offline.pending", 2)).toBe("2 изменения");
    expect(pluralMsg("offline.pending", 5)).toBe("5 изменений");
  });

  it("falls back to `other` for a category the translator did not fill in", () => {
    registerCatalogue("pl", {
      "offline.pending": { other: "{count} zmian" },
    });
    setMessageLocale("pl");
    expect(pluralMsg("offline.pending", 1)).toBe("1 zmian");
    expect(pluralMsg("offline.pending", 3)).toBe("3 zmian");
  });

  it("selects ENGLISH rules while rendering English text under a foreign tag", () => {
    // Device is ja-JP and no Japanese catalogue is registered, so the sentence
    // is English. Japanese has ONE category, so selecting with the device tag
    // would send count=1 to `other` and render "1 changes" — an English clause
    // the catalogue never wrote, produced by a locale it is not written in.
    setMessageLocale("ja-JP");
    expect(pluralMsg("offline.pending", 1)).toContain("1 change waiting");
    expect(pluralMsg("offline.pending", 2)).toContain("2 changes waiting");
  });
});

describe("catalogue resolution", () => {
  it("prefers an exact regional catalogue", () => {
    registerCatalogue("pt", { "offline.title": "Sem ligação" });
    registerCatalogue("pt-br", { "offline.title": "Sem conexão" });
    setMessageLocale("pt-BR");
    expect(msg("offline.title")).toBe("Sem conexão");
    expect(activeMessageLocale()).toBe("pt-BR");
  });

  it("falls back from a region we lack to the language we have", () => {
    registerCatalogue("pt", { "offline.title": "Sem ligação" });
    setMessageLocale("pt-PT");
    expect(msg("offline.title")).toBe("Sem ligação");
  });

  it("falls back to the base catalogue for an unknown locale", () => {
    setMessageLocale("qq-ZZ");
    expect(msg("offline.title")).toBe("No connection");
    // The tag is reported as "not translated", not as the active catalogue —
    // otherwise diagnostics would claim a translation that is not there.
    expect(activeMessageLocale()).toBeNull();
  });

  it("degrades KEY BY KEY, so a partial catalogue is not a blank screen", () => {
    registerCatalogue("de", { "offline.title": "Keine Verbindung" });
    setMessageLocale("de");
    expect(msg("offline.title")).toBe("Keine Verbindung");
    expect(msg("offline.action.recheck")).toBe("Check again");
  });
});

describe("missing keys", () => {
  it("returns the key and records it rather than rendering empty", () => {
    // Keys are literal-typed off the base catalogue, so this can only happen
    // through a cast — which is exactly the case worth surviving.
    const unknown = "does.not.exist" as Parameters<typeof msg>[0];
    expect(msg(unknown)).toBe("does.not.exist");
    expect(missingMessageKeys()).toContain("does.not.exist");
    expect(messageCatalogueSummary()).toContain("missing");
  });

  it("reports a clean catalogue with no gap count", () => {
    expect(msg("offline.title")).toBe("No connection");
    expect(messageCatalogueSummary()).toBe("en (base)");
  });
});

describe("the strings this seam was built to fix", () => {
  it("reproduces the subscribers count line exactly", () => {
    expect(
      msg("subscribers.count.showing", {
        loaded: 25,
        total: pluralMsg("subscribers.count.all", 1340),
      }),
    ).toBe("Showing 25 of 1,340 subscribers");
  });

  it("keeps the adjective a PARAMETER so word order can move", () => {
    registerCatalogue("fr", {
      // French puts the qualifier after the noun.
      "subscribers.count.filtered": {
        one: "{count} abonné {noun}",
        other: "{count} abonnés {noun}",
      },
    });
    setMessageLocale("fr");
    expect(
      pluralMsg("subscribers.count.filtered", 3, { noun: "désabonnés" }),
    ).toBe("3 abonnés désabonnés");
  });
});
