import { describe, expect, it } from "vitest";

import type { CampaignTemplate } from "../../lib/api-client";
import {
  campaignTemplateCardPreviewUrl,
  campaignTemplatePreviewUrl,
  trustedCampaignTemplatePreviewUrl,
  trustedReferenceTemplatePreviewUrl,
} from "../../lib/campaign-template-previews";

const ASSET_BASE = "https://assets.postwave.test/hosted";
const REFERENCE_ORIGIN =
  "https://pro-really-good-emails.s3.eu-west-1.amazonaws.com";

const template: CampaignTemplate = {
  id: "reference-1",
  slug: "reference-1",
  name: "Reference",
  subject: "A reference",
  thumbnail_url: "https://provider.example/unsafe.png",
  preview_assets: [
    {
      variant: "desktop",
      url: `${ASSET_BASE}/campaign-template-previews/desktop.png`,
      mime_type: "image/png",
      width: 1200,
      height: 2400,
      size_bytes: 80_000,
      status: "ready",
    },
    {
      variant: "card",
      url: `${ASSET_BASE}/campaign-template-previews/card.webp`,
      mime_type: "image/webp",
      width: 600,
      height: 800,
      size_bytes: 32_000,
      status: "source_missing",
    },
  ],
};

describe("campaign template hosted preview trust boundary", () => {
  it("selects the requested retained variant only under the exact asset base", () => {
    expect(campaignTemplatePreviewUrl(template, ["desktop"], ASSET_BASE)).toBe(
      `${ASSET_BASE}/campaign-template-previews/desktop.png`,
    );
    expect(campaignTemplateCardPreviewUrl(template, ASSET_BASE)).toBe(
      `${ASSET_BASE}/campaign-template-previews/card.webp`,
    );
  });

  it("rejects third-party, sibling-path, credential, query, and traversal URLs", () => {
    for (const candidate of [
      "https://provider.example/preview.png",
      "https://assets.postwave.test/other/preview.png",
      "https://user:secret@assets.postwave.test/hosted/preview.png",
      "https://assets.postwave.test/hosted/preview.png?token=secret",
      "https://assets.postwave.test/hosted/%2e%2e/private.png",
    ]) {
      expect(
        trustedCampaignTemplatePreviewUrl(candidate, ASSET_BASE),
      ).toBeNull();
    }
  });

  it("fails closed when only a provider thumbnail or invalid asset remains", () => {
    expect(
      campaignTemplatePreviewUrl(
        {
          thumbnail_url: "https://provider.example/unsafe.png",
          preview_assets: [
            {
              ...template.preview_assets![0],
              mime_type: "image/svg+xml" as "image/png",
            },
          ],
        },
        ["desktop"],
        ASSET_BASE,
      ),
    ).toBeNull();
  });

  it("allows the exact configured RGE image origin only for RGE references", () => {
    const sourceUrl = `${REFERENCE_ORIGIN}/emails/demo-reference.png`;
    expect(
      trustedReferenceTemplatePreviewUrl(
        sourceUrl,
        "really_good_emails",
        REFERENCE_ORIGIN,
      ),
    ).toBe(sourceUrl);
    expect(
      campaignTemplateCardPreviewUrl(
        {
          source_provider: "really_good_emails",
          thumbnail_url: sourceUrl,
        },
        null,
        REFERENCE_ORIGIN,
      ),
    ).toBe(sourceUrl);

    for (const candidate of [
      `${REFERENCE_ORIGIN}/other/demo-reference.png`,
      `${REFERENCE_ORIGIN}/emails/demo-reference.png?token=secret`,
      `${REFERENCE_ORIGIN}/emails/%2e%2e/private.png`,
      "https://provider.example/emails/demo-reference.png",
    ]) {
      expect(
        trustedReferenceTemplatePreviewUrl(
          candidate,
          "really_good_emails",
          REFERENCE_ORIGIN,
        ),
      ).toBeNull();
    }
    expect(
      trustedReferenceTemplatePreviewUrl(
        sourceUrl,
        "another_provider",
        REFERENCE_ORIGIN,
      ),
    ).toBeNull();
  });
});
