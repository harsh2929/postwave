/**
 * The UTM transport seam — method, path (id encoded), body verbatim — with
 * rawRequest mocked (idiom: src/api/audienceDestinations.test.ts). The
 * workspace-default upsert (POST /utm-templates) and the template delete are
 * the rows desktop's UTMTemplatesPanel had and mobile lacked; this file is
 * what makes their transport falsifiable.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteUtmTemplate,
  listUtmTemplates,
  previewUtmLink,
  upsertCampaignUtm,
  upsertDefaultUtm,
} from "./campaignUtm";

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }));
vi.mock("@/api/request", () => ({
  rawRequest,
  checkedApiResult: async (promise: Promise<{ data: unknown; error: unknown }>) => {
    const res = await promise;
    if (res.error) throw res.error;
    return res;
  },
}));

beforeEach(() => {
  rawRequest.mockReset();
  rawRequest.mockResolvedValue({ data: {}, error: null });
});

describe("utm transport", () => {
  it("GET /api/v1/utm-templates parses the {templates} body", async () => {
    rawRequest.mockResolvedValue({
      data: {
        templates: [
          {
            id: "u-1",
            campaign_id: "",
            utm_source: "newsletter",
            utm_medium: "email",
            utm_campaign: "{{campaign_slug}}",
            utm_term: "",
            utm_content: "",
          },
        ],
        count: 1,
      },
      error: null,
    });
    const rows = await listUtmTemplates();
    expect(rawRequest).toHaveBeenCalledWith("GET", "/api/v1/utm-templates");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("newsletter");
    // campaign_id "" IS the workspace default — recomputed, not trusted.
    expect(rows[0]?.isDefault).toBe(true);
  });

  it("POST /preview sends {url, campaign_id} and falls back to the original", async () => {
    rawRequest.mockResolvedValue({ data: { original: "https://x.test" }, error: null });
    const out = await previewUtmLink("https://x.test", "c1");
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/utm-templates/preview",
      { url: "https://x.test", campaign_id: "c1" },
    );
    expect(out.rewritten).toBe("https://x.test");
  });

  it("POST /utm-templates/campaign/{id} with the values verbatim, id encoded", async () => {
    await upsertCampaignUtm("c 1", { utm_source: "s" });
    expect(rawRequest).toHaveBeenCalledWith(
      "POST",
      "/api/v1/utm-templates/campaign/c%201",
      { utm_source: "s" },
    );
  });

  it("POST /api/v1/utm-templates — the WORKSPACE default upsert", async () => {
    await upsertDefaultUtm({ utm_source: "newsletter", utm_medium: "email" });
    expect(rawRequest).toHaveBeenCalledWith("POST", "/api/v1/utm-templates", {
      utm_source: "newsletter",
      utm_medium: "email",
    });
  });

  it("DELETE /api/v1/utm-templates/{id}, id encoded", async () => {
    await deleteUtmTemplate("t 9");
    expect(rawRequest).toHaveBeenCalledWith(
      "DELETE",
      "/api/v1/utm-templates/t%209",
    );
  });

  it("throws the envelope error instead of swallowing it", async () => {
    rawRequest.mockResolvedValue({
      data: null,
      error: { status: 403, message: "admin only" },
    });
    await expect(upsertDefaultUtm({ utm_source: "s" })).rejects.toMatchObject({
      status: 403,
    });
  });
});
