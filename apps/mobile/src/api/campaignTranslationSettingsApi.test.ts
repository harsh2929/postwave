/**
 * The tenant-translations transport seam: method, path (id URL-encoded), and
 * bodies passed verbatim — with rawRequest mocked, the idiom
 * src/api/audienceDestinations.test.ts established.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteTranslationDictionaryEntry,
  getTranslationSettings,
  listTranslationDictionary,
  previewTranslationRender,
  putTranslationSettings,
  upsertTranslationDictionaryEntry,
} from "./campaignTranslationSettingsApi";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => {
  rawRequest.mockReset();
  rawRequest.mockResolvedValue({ data: { ok: true }, error: null });
});

describe("tenant translations transport", () => {
  it("GET /api/v1/translations/settings", async () => {
    await getTranslationSettings();
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/translations/settings",
    );
  });

  it("PUT /api/v1/translations/settings with the partial body verbatim", async () => {
    const body = { enabled: true, supported_locales: ["en", "es"] };
    await putTranslationSettings(body);
    expect(rawRequest).toHaveBeenCalledWith(
      "PUT",
      "/api/v1/translations/settings",
      body,
    );
  });

  it("GET /api/v1/translations/dictionary", async () => {
    await listTranslationDictionary();
    expect(rawRequest).toHaveBeenCalledWith(
      "GET",
      "/api/v1/translations/dictionary",
    );
  });

  it("POST /api/v1/translations/dictionary with the entry verbatim", async () => {
    const body = {
      term: "Moosewave Pro",
      translations: { es: "Moosewave Pro" },
      case_sensitive: true,
      notes: "",
    };
    await upsertTranslationDictionaryEntry(body);
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/translations/dictionary",
      body,
    );
  });

  it("DELETE /api/v1/translations/dictionary/{id}, id encoded", async () => {
    await deleteTranslationDictionaryEntry("d 1/x");
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/translations/dictionary/d%201%2Fx",
    );
  });

  it("POST /api/v1/translations/preview with body+locale", async () => {
    await previewTranslationRender({ body: "<p>Hi</p>", locale: "es" });
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/translations/preview",
      { body: "<p>Hi</p>", locale: "es" },
    );
  });
});
