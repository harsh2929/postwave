/**
 * subscriberGpp — verbatim-storage honesty and the desktop-mirrored source
 * vocabulary.
 */
import { describe, expect, it } from "vitest";

import { gppSourceLabel, parseGpp } from "./subscriberGpp";

describe("parseGpp", () => {
  it("keeps section strings verbatim, sorted by jurisdiction", () => {
    const view = parseGpp({
      subscriber_id: "sub-1",
      sections: { usca: "DBABBg~BVQqAAAA", eutcf: "CPz~cAAPz~cAA" },
      audit: [
        {
          jurisdiction: "usca",
          source: "cmp_webhook",
          created_at: "2026-08-01T00:00:00Z",
        },
      ],
    });
    expect(view.sections).toEqual([
      { jurisdiction: "eutcf", value: "CPz~cAAPz~cAA" },
      { jurisdiction: "usca", value: "DBABBg~BVQqAAAA" },
    ]);
    expect(view.audit).toEqual([
      {
        jurisdiction: "usca",
        source: "cmp_webhook",
        createdAt: "2026-08-01T00:00:00Z",
      },
    ]);
  });

  it("drops empty-string sections (the server's delete marker) and survives junk", () => {
    expect(parseGpp({ sections: { usca: "" } }).sections).toEqual([]);
    expect(parseGpp(null)).toEqual({ sections: [], audit: [] });
  });
});

describe("gppSourceLabel — desktop's map, verbatim", () => {
  it("labels the known provenances and passes unknowns through", () => {
    expect(gppSourceLabel("cmp_webhook")).toBe("CMP webhook");
    expect(gppSourceLabel("manual_override")).toBe("Admin");
    expect(gppSourceLabel("import")).toBe("Import");
    expect(gppSourceLabel("api")).toBe("API");
    expect(gppSourceLabel("sdk_v2")).toBe("sdk_v2");
  });
});
