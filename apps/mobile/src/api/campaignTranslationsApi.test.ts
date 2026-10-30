/**
 * The locale-variant writes: PUT carries all three fields (the full-row
 * replace means a body left out is a body ERASED), and both paths encode the
 * locale.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteCampaignTranslation,
  upsertCampaignTranslation,
} from "./campaignTranslationsApi";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({ rawRequest }));

beforeEach(() => {
  rawRequest.mockReset();
  rawRequest.mockResolvedValue({ data: {}, error: null });
});

describe("campaign translations transport", () => {
  it("PUT …/translations/{locale} with subject AND both bodies", async () => {
    await upsertCampaignTranslation("c1", "fr-CA", {
      subject: "Objet",
      body_html: "<p>corps</p>",
      body_mjml: "",
    });
    expect(rawRequest).toHaveBeenCalledWith(
      "PUT",
      "/api/v1/campaigns/c1/translations/fr-CA",
      { subject: "Objet", body_html: "<p>corps</p>", body_mjml: "" },
    );
  });

  it("DELETE …/translations/{locale}", async () => {
    await deleteCampaignTranslation("c1", "es");
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/campaigns/c1/translations/es",
    );
  });
});
