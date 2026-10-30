// SPDX-License-Identifier: AGPL-3.0-only
//
// The three tenant translation WRITES the web client had no function for:
// PUT /settings, POST /dictionary, DELETE /dictionary/{id}. Asserted at the
// wire because the settings PUT is whole-body — one bad field discards the
// other four — and the delete addresses an entry by an id that must survive
// URL encoding.

import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  put: vi.fn(),
  post: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: transport }));

import {
  deleteTranslationEntry,
  isValidTranslationLocale,
  parseLocaleList,
  saveTranslationSettings,
  upsertTranslationEntry,
} from "@/lib/translations-api";

beforeEach(() => {
  transport.put.mockReset();
  transport.post.mockReset();
  transport.delete.mockReset();
});

describe("saveTranslationSettings", () => {
  it("PUTs the whole settings body and returns what the server stored", async () => {
    transport.put.mockResolvedValue({
      tenant_id: "tenant-1",
      enabled: true,
      default_locale: "en",
      supported_locales: ["en", "fr"],
      fallback_strategy: "default_only",
      locale_attribute: "language",
      updated_at: "2026-01-02T03:04:05Z",
    });

    await expect(
      saveTranslationSettings({
        enabled: true,
        default_locale: "en",
        supported_locales: ["en", "fr"],
        fallback_strategy: "default_only",
        locale_attribute: "language",
      }),
    ).resolves.toMatchObject({
      enabled: true,
      supported_locales: ["en", "fr"],
      fallback_strategy: "default_only",
    });

    expect(transport.put).toHaveBeenCalledWith(
      "/api/v1/translations/settings",
      {
        enabled: true,
        default_locale: "en",
        supported_locales: ["en", "fr"],
        fallback_strategy: "default_only",
        locale_attribute: "language",
      },
    );
  });

  it("never hands the caller a non-array supported_locales to render", async () => {
    // The page joins this list. A null would print "null" or throw; treating
    // it as an empty list is the only reading that cannot lie about coverage.
    transport.put.mockResolvedValue({
      tenant_id: "tenant-1",
      enabled: false,
      default_locale: "en",
      supported_locales: null,
      fallback_strategy: "subscriber_locale",
      locale_attribute: "language",
    });
    const saved = await saveTranslationSettings({
      enabled: false,
      default_locale: "en",
      supported_locales: [],
      fallback_strategy: "subscriber_locale",
      locale_attribute: "language",
    });
    expect(saved.supported_locales).toEqual([]);
  });
});

describe("upsertTranslationEntry", () => {
  it("POSTs the term, its locale map, the case flag and the notes", async () => {
    transport.post.mockResolvedValue({
      id: "entry-1",
      term: "Moosewave",
      translations: {},
      case_sensitive: true,
      notes: "Trademark",
    });

    await expect(
      upsertTranslationEntry({
        term: "Moosewave",
        translations: {},
        case_sensitive: true,
        notes: "Trademark",
      }),
    ).resolves.toMatchObject({ id: "entry-1", term: "Moosewave" });

    expect(transport.post).toHaveBeenCalledWith(
      "/api/v1/translations/dictionary",
      {
        term: "Moosewave",
        translations: {},
        case_sensitive: true,
        notes: "Trademark",
      },
    );
  });

  it("sends an empty translations map as a protected term, not as absent", async () => {
    // An entry with no locale rows is the dictionary's PRIMARY use: a term the
    // translator must leave untouched. Omitting the key would be a different
    // request.
    transport.post.mockResolvedValue({ id: "entry-2", term: "Pro plan" });
    await upsertTranslationEntry({
      term: "Pro plan",
      translations: {},
      case_sensitive: false,
      notes: "",
    });
    const [, body] = transport.post.mock.calls[0]!;
    expect(body).toHaveProperty("translations");
    expect((body as { translations: unknown }).translations).toEqual({});
  });
});

describe("deleteTranslationEntry", () => {
  it("DELETEs the entry's own path", async () => {
    transport.delete.mockResolvedValue(undefined);
    await deleteTranslationEntry("9d0f0b6e-0000-4000-8000-000000000000");
    expect(transport.delete).toHaveBeenCalledWith(
      "/api/v1/translations/dictionary/9d0f0b6e-0000-4000-8000-000000000000",
    );
  });

  it("percent-encodes the id segment", async () => {
    transport.delete.mockResolvedValue(undefined);
    await deleteTranslationEntry("a/b");
    expect(transport.delete).toHaveBeenCalledWith(
      "/api/v1/translations/dictionary/a%2Fb",
    );
  });
});

describe("locale helpers mirror the server's validateLocale", () => {
  it("accepts 2..16 alphanumerics plus - and _", () => {
    expect(isValidTranslationLocale("en")).toBe(true);
    expect(isValidTranslationLocale("fr-CA")).toBe(true);
    expect(isValidTranslationLocale("en_US")).toBe(true);
    expect(isValidTranslationLocale("e")).toBe(false);
    expect(isValidTranslationLocale("a".repeat(17))).toBe(false);
    expect(isValidTranslationLocale("fr CA")).toBe(false);
    expect(isValidTranslationLocale("fr.CA")).toBe(false);
  });

  it("splits an operator's list on commas and spaces, keeping first-seen order", () => {
    expect(parseLocaleList(" en, fr-CA  es , en ")).toEqual([
      "en",
      "fr-CA",
      "es",
    ]);
    expect(parseLocaleList("")).toEqual([]);
  });
});
