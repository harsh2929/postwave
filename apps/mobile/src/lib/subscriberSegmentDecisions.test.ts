/**
 * subscriberSegmentDecisions — the SUB-070 explanation surfaces. The
 * server's sentences travel VERBATIM (this layer must never re-derive a
 * decision it explains), and the operator-defined snapshot JSON prints as
 * rows without assuming a shape.
 */
import { describe, expect, it } from "vitest";

import {
  decisionTypeLabel,
  parseDecisionExplanations,
  parseSegmentMemberships,
} from "./subscriberSegmentDecisions";

describe("parseSegmentMemberships", () => {
  it("keeps the server's summary and per-condition sentences verbatim", () => {
    const rows = parseSegmentMemberships({
      subscriber_id: "sub-1",
      segments: [
        {
          segment_id: "seg-1",
          segment_name: "High-Engagement",
          is_member: false,
          matched_count: 3,
          total_conditions: 5,
          summary: "matched 3 of 5 conditions in 'High-Engagement'",
          conditions: [
            {
              field: "engagement_score",
              comparator: ">",
              matched: true,
              description: "engagement score 82 is greater than 50",
            },
            {
              field: "country",
              comparator: "=",
              matched: false,
              description: "country 'SE' does not match 'DE'",
            },
          ],
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe(
      "matched 3 of 5 conditions in 'High-Engagement'",
    );
    expect(rows[0]!.isMember).toBe(false);
    expect(rows[0]!.conditions).toEqual([
      { matched: true, description: "engagement score 82 is greater than 50" },
      { matched: false, description: "country 'SE' does not match 'DE'" },
    ]);
  });

  it("returns [] for junk", () => {
    expect(parseSegmentMemberships(null)).toEqual([]);
  });
});

describe("parseDecisionExplanations", () => {
  it("prints the freeform snapshot as rows, stringifying non-scalars", () => {
    const rows = parseDecisionExplanations({
      subscriber_id: "sub-1",
      items: [
        {
          id: "dec-1",
          decision_type: "segment",
          target_id: "seg-1",
          created_at: "2026-08-01T00:00:00Z",
          reasoning_snapshot: {
            model: "rules_v2",
            weights: { recency: 0.4 },
            note: null,
          },
        },
      ],
    });
    expect(rows[0]!.typeLabel).toBe("Segment");
    expect(rows[0]!.snapshot).toEqual([
      ["model", "rules_v2"],
      ["weights", '{"recency":0.4}'],
      ["note", "—"],
    ]);
  });

  it("labels the two known decision types and passes unknowns through", () => {
    expect(decisionTypeLabel("segment")).toBe("Segment");
    expect(decisionTypeLabel("campaign")).toBe("Campaign");
    expect(decisionTypeLabel("journey")).toBe("journey");
  });
});
