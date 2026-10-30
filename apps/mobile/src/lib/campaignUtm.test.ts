import { describe, expect, it } from "vitest";

import {
  parseUtmTemplates,
  resolveCampaignUtm,
  utmOverrideBody,
  utmParamRows,
  utmPreviewProblem,
  type UtmTemplate,
} from "./campaignUtm";

function tpl(over: Partial<UtmTemplate>): UtmTemplate {
  return {
    id: "t",
    campaignId: "",
    isDefault: true,
    source: "",
    medium: "",
    campaign: "",
    term: "",
    content: "",
    enabled: true,
    ...over,
  };
}

describe("parseUtmTemplates", () => {
  it("reads the { templates } envelope and derives isDefault from campaign_id", () => {
    const rows = parseUtmTemplates({
      templates: [
        { id: "a", campaign_id: "", utm_source: "newsletter", enabled: true },
        { id: "b", campaign_id: "c1", utm_source: "promo", enabled: true },
      ],
    });
    expect(rows[0]?.isDefault).toBe(true);
    expect(rows[1]?.isDefault).toBe(false);
    expect(rows[1]?.campaignId).toBe("c1");
  });

  it("treats a missing enabled flag as OFF rather than assuming tagging runs", () => {
    expect(parseUtmTemplates({ templates: [{ id: "a" }] })[0]?.enabled).toBe(
      false,
    );
  });

  it("drops rows with no id", () => {
    expect(parseUtmTemplates({ templates: [{ utm_source: "x" }] })).toEqual([]);
  });
});

describe("resolveCampaignUtm", () => {
  it("prefers a campaign override over the workspace default", () => {
    const r = resolveCampaignUtm(
      [
        tpl({ id: "d", source: "default" }),
        tpl({ id: "o", campaignId: "c1", isDefault: false, source: "over" }),
      ],
      "c1",
    );
    expect(r.effective?.source).toBe("over");
    expect(r.overridden).toBe(true);
    expect(r.summary).toContain("its own tagging");
  });

  it("falls back to the default for a campaign with no override", () => {
    const r = resolveCampaignUtm([tpl({ id: "d", source: "default" })], "c1");
    expect(r.effective?.source).toBe("default");
    expect(r.overridden).toBe(false);
  });

  /**
   * A disabled row is NOT applied by the server, so showing its values as
   * "what will be added" would be false confidence on the last screen before
   * a send.
   */
  it("reports a disabled override as no tagging at all", () => {
    const r = resolveCampaignUtm(
      [
        tpl({ id: "d", source: "default" }),
        tpl({
          id: "o",
          campaignId: "c1",
          isDefault: false,
          source: "over",
          enabled: false,
        }),
      ],
      "c1",
    );
    expect(r.effective).toBeNull();
    expect(r.summary).toContain("switched OFF");
  });

  it("says plainly when nothing is configured", () => {
    const r = resolveCampaignUtm([], "c1");
    expect(r.effective).toBeNull();
    expect(r.summary).toContain("No UTM tagging");
  });
});

describe("utmParamRows", () => {
  it("keeps all five rows and dashes the unset ones", () => {
    const rows = utmParamRows(tpl({ source: "newsletter" }));
    expect(rows).toHaveLength(5);
    expect(rows[0]?.value).toBe("newsletter");
    expect(rows[3]?.value).toBe("—");
  });

  it("dashes every row when nothing resolves", () => {
    expect(utmParamRows(null).every((r) => r.value === "—")).toBe(true);
  });
});

describe("utmOverrideBody", () => {
  it("copies the five values the upsert route expects", () => {
    expect(utmOverrideBody(tpl({ source: "s", medium: "m" }))).toEqual({
      utm_source: "s",
      utm_medium: "m",
      utm_campaign: "",
      utm_term: "",
      utm_content: "",
    });
  });
});

describe("utmPreviewProblem", () => {
  it("mirrors the server's absolute-http(s) rule", () => {
    expect(utmPreviewProblem("https://example.com/a")).toBeNull();
    expect(utmPreviewProblem("example.com")).toContain("http://");
    expect(utmPreviewProblem("ftp://example.com")).toContain("http://");
    expect(utmPreviewProblem("https://")).toContain("no domain");
  });

  it("stays silent on an empty field rather than nagging before typing", () => {
    expect(utmPreviewProblem("   ")).toBeNull();
  });
});
