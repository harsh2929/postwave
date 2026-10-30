import { describe, expect, it } from "vitest";

import {
  campaignShareText,
  campaignShareTitle,
  hasPublicArchive,
} from "./campaignShare";

describe("campaignShareTitle", () => {
  it("prefers the subject, falls back to the name, then a generic word", () => {
    expect(campaignShareTitle({ subject: "Spring Sale", name: "spring" })).toBe(
      "Spring Sale",
    );
    expect(campaignShareTitle({ subject: "  ", name: "spring" })).toBe("spring");
    expect(campaignShareTitle({})).toBe("Campaign");
  });
});

describe("campaignShareText", () => {
  /**
   * The rates here come from GET /api/v1/campaigns/{id}/report, which builds
   * every rate through analytics.go:1460 `pct` — already scaled to 0..100.
   * The fixture was previously written as 0.412 and asserted 41.2%, which only
   * passed because campaignRate used to GUESS the scale from magnitude; under
   * that guess a genuine 0.412% report figure shared as a 41.2% triumph.
   */
  it("builds a pasteable summary from the report's already-scaled percents", () => {
    const text = campaignShareText({
      subject: "Spring Sale",
      sent: 12483,
      openRate: 41.2,
      clickRate: 6.1,
      bounces: 12,
      archiveUrl: "https://app.example.com/archive/acme/spring",
    });
    expect(text.split("\n")[0]).toBe("Spring Sale");
    expect(text).toContain("Sent 12,483");
    expect(text).toContain("Open 41.2%");
    expect(text).toContain("Click 6.1%");
    expect(text).toContain("https://app.example.com/archive/acme/spring");
  });

  it("does not inflate a genuinely low report rate", () => {
    expect(campaignShareText({ subject: "S", openRate: 0.4 })).toContain(
      "Open 0.4%",
    );
  });

  it("omits metrics that are absent rather than sharing em-dashes", () => {
    const text = campaignShareText({ subject: "Draft" });
    expect(text).toBe("Draft");
    expect(text).not.toContain("—");
  });

  it("keeps a measured zero", () => {
    expect(campaignShareText({ subject: "S", bounces: 0 })).toContain(
      "Bounces 0",
    );
  });

  it("drops a blank archive url", () => {
    expect(campaignShareText({ subject: "S", archiveUrl: "  " })).toBe("S");
  });

  it("ignores non-finite metrics", () => {
    expect(campaignShareText({ subject: "S", sent: Number.NaN })).toBe("S");
  });
});

describe("hasPublicArchive", () => {
  it("requires both the flag and a non-empty slug", () => {
    expect(hasPublicArchive({ archive_public: true, archive_slug: "s" })).toBe(
      true,
    );
    expect(hasPublicArchive({ archive_public: true, archive_slug: " " })).toBe(
      false,
    );
    expect(hasPublicArchive({ archive_public: false, archive_slug: "s" })).toBe(
      false,
    );
    expect(hasPublicArchive({})).toBe(false);
  });
});
