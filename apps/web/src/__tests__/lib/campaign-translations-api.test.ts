// SPDX-License-Identifier: AGPL-3.0-only
//
// The three per-campaign locale-variant routes, asserted at the wire: the
// method, the exact path (including the encoded id and locale segments), and
// the body. `campaign_translations` addresses a variant BY LOCALE in the URL,
// so a path built from an un-normalized or unencoded value writes to a row the
// operator never chose.

import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: transport }));

import {
  deleteCampaignTranslation,
  isValidCampaignLocale,
  listCampaignTranslations,
  normalizeCampaignLocale,
  saveCampaignTranslation,
} from "@/lib/campaign-translations-api";

const CAMPAIGN = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  transport.get.mockReset();
  transport.put.mockReset();
  transport.delete.mockReset();
});

describe("listCampaignTranslations", () => {
  it("reads the campaign's variants and parses the server's envelope", async () => {
    transport.get.mockResolvedValue({
      campaign_id: CAMPAIGN,
      translations: [
        {
          locale: "fr-CA",
          subject: "Bonjour",
          body_html: "<p>Bonjour</p>",
          body_mjml: "",
          updated_at: "2026-01-02T03:04:05Z",
        },
      ],
    });

    await expect(listCampaignTranslations(CAMPAIGN)).resolves.toEqual([
      {
        locale: "fr-CA",
        subject: "Bonjour",
        body_html: "<p>Bonjour</p>",
        body_mjml: "",
        updated_at: "2026-01-02T03:04:05Z",
      },
    ]);
    expect(transport.get).toHaveBeenCalledWith(
      `/api/v1/campaigns/${CAMPAIGN}/translations`,
    );
  });

  it("drops a row with no locale rather than rendering an uneditable line", async () => {
    // Both writes address a variant by its locale segment, so a locale-less
    // row would render an Edit and a Delete that can never resolve.
    transport.get.mockResolvedValue({
      translations: [
        { locale: "", subject: "orphan" },
        { locale: "es", subject: "Hola" },
      ],
    });
    const rows = await listCampaignTranslations(CAMPAIGN);
    expect(rows.map((row) => row.locale)).toEqual(["es"]);
  });

  it("treats a missing translations field as none, not as a crash", async () => {
    transport.get.mockResolvedValue({ campaign_id: CAMPAIGN });
    await expect(listCampaignTranslations(CAMPAIGN)).resolves.toEqual([]);
  });
});

describe("saveCampaignTranslation", () => {
  it("PUTs the subject and body to the locale's own path", async () => {
    transport.put.mockResolvedValue({
      locale: "es",
      subject: "Hola",
      body_html: "<p>Hola</p>",
      body_mjml: "",
      updated_at: "2026-01-02T03:04:05Z",
    });

    await expect(
      saveCampaignTranslation(CAMPAIGN, "es", {
        subject: "Hola",
        body_html: "<p>Hola</p>",
      }),
    ).resolves.toMatchObject({ locale: "es", subject: "Hola" });

    expect(transport.put).toHaveBeenCalledWith(
      `/api/v1/campaigns/${CAMPAIGN}/translations/es`,
      { subject: "Hola", body_html: "<p>Hola</p>" },
    );
  });

  it("percent-encodes the id and locale segments", async () => {
    transport.put.mockResolvedValue({});
    await saveCampaignTranslation("a/b", "fr-CA", {
      subject: "",
      body_html: "",
    });
    expect(transport.put.mock.calls[0]![0]).toBe(
      "/api/v1/campaigns/a%2Fb/translations/fr-CA",
    );
  });
});

describe("deleteCampaignTranslation", () => {
  it("DELETEs the locale's own path", async () => {
    transport.delete.mockResolvedValue({ ok: true, locale: "es" });
    await deleteCampaignTranslation(CAMPAIGN, "es");
    expect(transport.delete).toHaveBeenCalledWith(
      `/api/v1/campaigns/${CAMPAIGN}/translations/es`,
    );
  });
});

describe("locale rules mirror the server", () => {
  it("accepts language and language-Region, rejects what the server rejects", () => {
    expect(isValidCampaignLocale("es")).toBe(true);
    expect(isValidCampaignLocale("fr-CA")).toBe(true);
    expect(isValidCampaignLocale("pt-BR")).toBe(true);
    // The tenant glossary allows underscores; this surface does not, and the
    // difference is why the check is duplicated rather than shared.
    expect(isValidCampaignLocale("en_US")).toBe(false);
    expect(isValidCampaignLocale("e")).toBe(false);
    expect(isValidCampaignLocale("")).toBe(false);
    expect(isValidCampaignLocale("français")).toBe(false);
  });

  it("collapses case the way the server's normalizeLocale does", () => {
    expect(normalizeCampaignLocale("ES-mx")).toBe("es-MX");
    expect(normalizeCampaignLocale(" fr ")).toBe("fr");
    expect(normalizeCampaignLocale("")).toBe("");
  });
});
