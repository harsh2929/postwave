/**
 * The remix reader: bodiless assets are dropped (nothing to copy), channels
 * get their human labels, and unknown channels keep their raw id rather
 * than vanishing.
 */
import { describe, expect, it } from "vitest";

import { readRemixAssets, remixChannelLabel } from "./campaignRemix";

describe("readRemixAssets", () => {
  it("reads the {assets: [...]} response with labels", () => {
    const rows = readRemixAssets({
      campaign_id: "c1",
      assets: [
        { channel: "sms", title: "", body: "Short and sweet." },
        { channel: "web_teaser", title: "Teaser", body: "Read more…" },
        { channel: "social", title: "x", body: "  " },
        "junk",
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.label).toBe("SMS");
    expect(rows[1]!.label).toBe("Web teaser");
    expect(rows[0]!.key).not.toBe(rows[1]!.key);
  });
  it("empty for junk", () => {
    expect(readRemixAssets(null)).toEqual([]);
    expect(readRemixAssets({ assets: "x" })).toEqual([]);
  });
});

describe("remixChannelLabel", () => {
  it("labels the four server channels and passes unknowns through", () => {
    expect(remixChannelLabel("podcast_outline")).toBe("Podcast outline");
    expect(remixChannelLabel("carrier_pigeon")).toBe("carrier_pigeon");
  });
});
