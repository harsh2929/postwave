import { describe, expect, it } from "vitest";

import type { CampaignTemplate } from "../lib/api-client";
import {
  appendCampaignTemplatePage,
  CAMPAIGN_TEMPLATE_PAGE_SIZE,
  hasMoreCampaignTemplates,
} from "../lib/campaign-template-pagination";

function template(id: number, name = `Template ${id}`): CampaignTemplate {
  return {
    id: String(id),
    slug: `template-${id}`,
    name,
    subject: `Subject ${id}`,
  };
}

describe("campaign template catalog pagination", () => {
  it("can accumulate every row in the 3,194-template capture", () => {
    const total = 3_194;
    let loaded: CampaignTemplate[] = [];

    for (let start = 0; start < total; start += CAMPAIGN_TEMPLATE_PAGE_SIZE) {
      expect(hasMoreCampaignTemplates(loaded.length, total)).toBe(true);
      const page = Array.from(
        { length: Math.min(CAMPAIGN_TEMPLATE_PAGE_SIZE, total - start) },
        (_, index) => template(start + index + 1),
      );
      loaded = appendCampaignTemplatePage(loaded, page);
    }

    expect(loaded).toHaveLength(total);
    expect(loaded.at(-1)?.id).toBe("3194");
    expect(hasMoreCampaignTemplates(loaded.length, total)).toBe(false);
  });

  it("refreshes duplicate boundary rows without changing catalog order", () => {
    const loaded = appendCampaignTemplatePage(
      [template(1), template(2)],
      [template(2, "Template 2 refreshed"), template(3)],
    );

    expect(loaded.map(({ id }) => id)).toEqual(["1", "2", "3"]);
    expect(loaded[1]?.name).toBe("Template 2 refreshed");
  });
});
