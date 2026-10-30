/**
 * The multivariate axis rules the A/B hand-off posts (G14 parity).
 *
 * What must not regress silently:
 *   - the ≤8-combo pre-check (the server 400s ABOVE 8, and a client that stops
 *     refusing loses the operator's streamed variants to that 400);
 *   - the 1-name-is-not-an-axis fallback (one from-name crossed with anything
 *     is a scalar, and sending it as an axis relabels every arm for nothing);
 *   - the scalar/axis exclusivity in the payload (sending both misstates which
 *     sender identity each arm carries);
 *   - the bandit's delivery_settings (the server stores the map verbatim, so a
 *     drifted policy name would arm nothing while claiming to).
 */
import { describe, expect, it } from "vitest";

import {
  AB_BANDIT_DELIVERY_SETTINGS,
  AB_MAX_COMBOS,
  abComboBlockReason,
  abComboCount,
  buildAbHandoffPayload,
  parseFromNameVariants,
} from "./campaignAbVariants";

const CAMPAIGN = {
  id: "cmp_1",
  name: "August",
  subject: "Hello",
  body_html: "<p>hi</p>",
  body_mjml: "",
  plain_text: "",
  preview_text: "",
  from_name: "Acme Team",
  reply_to: "",
  list_id: "list_1",
  segment_id: "",
};

describe("parseFromNameVariants", () => {
  it("splits per line, trims, and drops blanks", () => {
    expect(parseFromNameVariants(" Acme Team \n\n  Jane at Acme\n")).toEqual([
      "Acme Team",
      "Jane at Acme",
    ]);
  });
  it("is empty for null/undefined", () => {
    expect(parseFromNameVariants(null)).toEqual([]);
    expect(parseFromNameVariants(undefined)).toEqual([]);
  });
});

describe("the ≤8-combo cap", () => {
  it("counts a single from-name as no axis (server axisLen fallback)", () => {
    expect(abComboCount(4, 1)).toBe(4);
    expect(abComboCount(4, 0)).toBe(4);
  });
  it("crosses at 2+ from-names", () => {
    expect(abComboCount(3, 2)).toBe(6);
  });
  it("allows exactly the server cap and refuses one past it", () => {
    expect(abComboBlockReason(4, ["A", "B"])).toBeNull(); // 8 == cap
    const blocked = abComboBlockReason(3, ["A", "B", "C"]); // 9 > cap
    expect(blocked).toContain(String(AB_MAX_COMBOS));
    expect(blocked).toContain("9");
  });
});

describe("buildAbHandoffPayload", () => {
  it("sends the scalar from_name when the axis is inactive", () => {
    const payload = buildAbHandoffPayload(CAMPAIGN, ["S1", "S2"], {
      splitPercentage: 20,
      fromNameVariants: ["Only One"],
    });
    expect(payload.from_name).toBe("Acme Team");
    expect(payload.from_name_variants).toBeUndefined();
    expect(payload.split_percentage).toBe(20);
    expect(payload.audience_list_id).toBe("list_1");
  });

  it("sends the axis — and NOT the scalar — at 2+ from-names", () => {
    const payload = buildAbHandoffPayload(CAMPAIGN, ["S1", "S2"], {
      splitPercentage: null,
      fromNameVariants: [" Acme Team ", "Jane at Acme"],
    });
    expect(payload.from_name_variants).toEqual(["Acme Team", "Jane at Acme"]);
    expect(payload.from_name).toBeUndefined();
    expect(payload.split_percentage).toBeUndefined();
  });

  it("omits empty optional fields rather than sending them blank", () => {
    const payload = buildAbHandoffPayload(CAMPAIGN, ["S1", "S2"], {
      splitPercentage: null,
    });
    expect("body_mjml" in payload).toBe(false);
    expect("plain_text" in payload).toBe(false);
    expect("audience_segment_id" in payload).toBe(false);
    expect(payload.delivery_settings).toBeUndefined();
  });

  it("arms the bandit with desktop's exact delivery_settings", () => {
    const payload = buildAbHandoffPayload(CAMPAIGN, ["S1", "S2", "S3"], {
      splitPercentage: null,
      bandit: true,
    });
    expect(payload.delivery_settings).toEqual({
      ab_test: { bandit: true, policy: "thompson_opens", explore_floor: 0.1 },
    });
    expect(payload.delivery_settings).toEqual(AB_BANDIT_DELIVERY_SETTINGS);
  });
});
