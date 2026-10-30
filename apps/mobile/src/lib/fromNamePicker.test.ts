/**
 * GET /api/v1/from-name-picker parse rules.
 *
 * The quiet failure: the server answers `{from_names: [...]}`
 * (from_name_picker.go), and a parser reading the wrong envelope key would
 * return [] forever — the strip simply never renders, which is
 * indistinguishable from a workspace without enough history.
 */
import { describe, expect, it } from "vitest";

import {
  FROM_NAME_SUGGESTION_LIMIT,
  fromNameSuggestionLabel,
  parseFromNameSuggestions,
} from "./fromNamePicker";

describe("parseFromNameSuggestions", () => {
  it("reads the from_names envelope", () => {
    const rows = parseFromNameSuggestions({
      from_names: [
        { from_name: "Acme Team", campaigns_using: 12, open_rate: 0.31, rank: 1 },
        { from_name: "Jane", campaigns_using: 4, open_rate: 0.22, rank: 2 },
      ],
    });
    expect(rows.map((r) => r.fromName)).toEqual(["Acme Team", "Jane"]);
    expect(rows[0]?.openRate).toBe(0.31);
    expect(rows[0]?.campaignsUsing).toBe(12);
  });

  it("drops nameless rows and caps at desktop's five chips", () => {
    const rows = parseFromNameSuggestions({
      from_names: [
        { from_name: "  " },
        ...Array.from({ length: 9 }, (_v, i) => ({
          from_name: `Sender ${i}`,
          campaigns_using: 1,
        })),
      ],
    });
    expect(rows).toHaveLength(FROM_NAME_SUGGESTION_LIMIT);
    expect(rows[0]?.fromName).toBe("Sender 0");
  });

  it("returns [] — never placeholders — for junk", () => {
    expect(parseFromNameSuggestions(null)).toEqual([]);
    expect(parseFromNameSuggestions({ data: 1 })).toEqual([]);
  });

  it("says the open rate or its absence in the chip label", () => {
    expect(
      fromNameSuggestionLabel({
        fromName: "Acme",
        campaignsUsing: 3,
        openRate: 0.305,
        rank: 1,
      }),
    ).toBe("Acme, 30.5% open rate across 3 campaigns");
    expect(
      fromNameSuggestionLabel({
        fromName: "Acme",
        campaignsUsing: 1,
        openRate: null,
        rank: 1,
      }),
    ).toContain("open rate unmeasured");
  });
});
