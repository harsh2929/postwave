// SPDX-License-Identifier: AGPL-3.0-only
//
// Values the registry's predicate-specific comparators take, and how the
// builder and the read-only definition describe them. The compiler's shapes
// (compile.go engagementWindowDays, predicates.ParseLifecycleValue,
// composableSegmentID) are the contract: a day count, { tag, days }, a
// segment id.
import { describe, expect, it } from "vitest";

import registry from "./fixtures/segments/predicate-registry.json";
import { conditionLabel } from "@/components/segments/segment-definition-view";
import {
  registryToFieldDefs,
  emptyValueFor,
  valueFits,
} from "@/components/segments/segment-catalogue";
import {
  isIncompleteCondition,
  blocksSegmentDelete,
  segmentDeleteDescription,
} from "@/components/segments/segment-logic";
import type {
  PredicateDefinition,
  SegmentCondition,
  SegmentUsageReference,
} from "@/lib/segments-api";

const fields = registryToFieldDefs(
  registry.predicates as PredicateDefinition[],
);
const def = (key: string) => fields.find((f) => f.value === key);

function rule(partial: Partial<SegmentCondition>): SegmentCondition {
  return {
    op: "condition",
    field: "email",
    comparator: "equals",
    value: "",
    ...partial,
  };
}

describe("rules on predicate-specific comparators are complete only with the value the compiler needs", () => {
  it("engagement windows need a whole number of days", () => {
    expect(
      isIncompleteCondition(
        rule({
          field: "last_opened_at",
          comparator: "in_last_days",
          value: 30,
        }),
      ),
    ).toBe(false);
    expect(
      isIncompleteCondition(
        rule({
          field: "last_opened_at",
          comparator: "in_last_days",
          value: "",
        }),
      ),
    ).toBe(true);
    expect(
      isIncompleteCondition(
        rule({ field: "last_opened_at", comparator: "in_last_days", value: 0 }),
      ),
    ).toBe(true);
    expect(
      isIncompleteCondition(
        rule({
          field: "last_opened_at",
          comparator: "more_than_days_ago",
          value: 1.5,
        }),
      ),
    ).toBe(true);
  });

  it("ever / never take no value", () => {
    expect(
      isIncompleteCondition(
        rule({ field: "last_clicked_at", comparator: "never", value: "" }),
      ),
    ).toBe(false);
  });

  it("tag history needs both a tag and a window", () => {
    expect(
      isIncompleteCondition(
        rule({
          field: "tags",
          comparator: "added_in_last_days",
          value: { tag: "vip", days: 7 },
        }),
      ),
    ).toBe(false);
    expect(
      isIncompleteCondition(
        rule({
          field: "tags",
          comparator: "added_in_last_days",
          value: { tag: " ", days: 7 },
        }),
      ),
    ).toBe(true);
    expect(
      isIncompleteCondition(
        rule({
          field: "tags",
          comparator: "removed_in_last_days",
          value: { tag: "vip" },
        }),
      ),
    ).toBe(true);
  });

  it("a segment reference needs a segment", () => {
    expect(
      isIncompleteCondition(
        rule({ field: "segment_id", comparator: "in_segment", value: "" }),
      ),
    ).toBe(true);
    expect(
      isIncompleteCondition(
        rule({ field: "segment_id", comparator: "in_segment", value: "seg-1" }),
      ),
    ).toBe(false);
  });

  it("event counts need a count; their window is optional but must be valid", () => {
    const field = "metric.track.placed_order.count";
    expect(
      isIncompleteCondition(
        rule({ field, comparator: "gte", value: { count: 2 } }),
      ),
    ).toBe(false);
    expect(
      isIncompleteCondition(
        rule({ field, comparator: "gte", value: { count: 2, days: 30 } }),
      ),
    ).toBe(false);
    expect(
      isIncompleteCondition(rule({ field, comparator: "gte", value: {} })),
    ).toBe(true);
    expect(
      isIncompleteCondition(
        rule({ field, comparator: "gte", value: { count: 2, days: 0 } }),
      ),
    ).toBe(true);
    expect(
      isIncompleteCondition(
        rule({ field, comparator: "in_last_days", value: { days: 30 } }),
      ),
    ).toBe(false);
  });
});

describe("changing comparator reshapes a value that no longer fits", () => {
  it("starts each comparator from the value shape it takes", () => {
    expect(emptyValueFor("in_segment", def("segment_id"))).toBe("");
    expect(emptyValueFor("in_last_days", def("last_opened_at"))).toBe(30);
    expect(emptyValueFor("added_in_last_days", def("tags"))).toEqual({
      tag: "",
      days: 30,
    });
    // The recorded registry tracks the event as "Placed Order" (source_ref)
    // under the slug key, so an event-count value names it.
    expect(
      emptyValueFor("gte", def("metric.track.placed_order.count")),
    ).toEqual({ event_name: "Placed Order" });
    expect(
      emptyValueFor("in_last_days", def("metric.track.placed_order.count")),
    ).toEqual({ days: 30, event_name: "Placed Order" });
    expect(emptyValueFor("in", def("email"))).toEqual([]);
  });

  it("keeps a value that still fits and drops one that does not", () => {
    expect(valueFits("contains", "vip", def("tags"))).toBe(true);
    expect(valueFits("added_in_last_days", "vip", def("tags"))).toBe(false);
    expect(valueFits("equals", { tag: "vip", days: 3 }, def("tags"))).toBe(
      false,
    );
    expect(valueFits("in", "a", def("email"))).toBe(false);
  });
});

describe("the definition reads as sentences, not keys and ids", () => {
  const context = {
    fields,
    segmentNames: new Map([["seg-1", "Engaged readers"]]),
  };

  it("names registry fields by their label", () => {
    expect(
      conditionLabel(
        rule({
          field: "rfm.segment_key",
          comparator: "equals",
          value: "champions",
        }),
        context,
      ),
    ).toBe("RFM segment is champions");
  });

  it("names the referenced segment, or says it is gone", () => {
    expect(
      conditionLabel(
        rule({ field: "segment_id", comparator: "in_segment", value: "seg-1" }),
        context,
      ),
    ).toBe('Member of segment is in "Engaged readers"');
    expect(
      conditionLabel(
        rule({
          field: "segment_id",
          comparator: "not_in_segment",
          value: "gone",
        }),
        context,
      ),
    ).toBe("Member of segment is not in a segment that no longer exists");
  });

  it("describes windows and tag history", () => {
    expect(
      conditionLabel(
        rule({
          field: "last_opened_at",
          comparator: "in_last_days",
          value: 14,
        }),
        context,
      ),
    ).toBe("Last opened in the last 14 days");
    expect(
      conditionLabel(
        rule({ field: "last_opened_at", comparator: "never", value: "" }),
        context,
      ),
    ).toBe("Last opened never");
    expect(
      conditionLabel(
        rule({
          field: "tags",
          comparator: "added_in_last_days",
          value: { tag: "vip", days: 7 },
        }),
        context,
      ),
    ).toBe('Tag "vip" was added in the last 7 days');
    expect(
      conditionLabel(
        rule({
          field: "metric.track.placed_order.count",
          comparator: "gte",
          value: { count: 2, days: 30 },
        }),
        context,
      ),
    ).toBe("Placed Order count is at least 2 in the last 30 days");
  });

  it("never shows a raw key for a field the catalogue does not know", () => {
    expect(
      conditionLabel(
        rule({
          field: "custom.loyalty_tier",
          comparator: "equals",
          value: "gold",
        }),
      ),
    ).toBe("Loyalty tier is gold");
  });
});

describe("delete confirmation names what the refusal will be about", () => {
  it("names the campaigns the server says will refuse the delete", () => {
    const usage: SegmentUsageReference[] = [
      {
        kind: "campaign",
        id: "c1",
        name: "Spring launch",
        status: "draft",
        blocks_delete: true,
      },
      // Paused after it began sending: the refusal ignores it, whatever the status says.
      {
        kind: "campaign",
        id: "c2",
        name: "Paused mid-send",
        status: "paused",
        blocks_delete: false,
      },
      {
        kind: "campaign",
        id: "c3",
        name: "Last winter",
        status: "sent",
        blocks_delete: false,
      },
      { kind: "flow", id: "f1", name: "Welcome", status: "active" },
    ];
    const text = segmentDeleteDescription("Spring audience", usage);
    expect(text).toContain(
      `"Spring audience" is the audience of a campaign that hasn't started sending: "Spring launch". It can't be deleted until you move that campaign to another audience or delete it.`,
    );
    expect(text).not.toContain("Paused mid-send");
    expect(text).not.toContain("Last winter");
    expect(text).toContain(
      '1 other item uses it ("Welcome") and will need a new audience.',
    );
    expect(usage.filter(blocksSegmentDelete).map((d) => d.id)).toEqual(["c1"]);
  });

  it("falls back to the campaign status when the server does not say", () => {
    expect(
      blocksSegmentDelete({
        kind: "campaign",
        id: "c1",
        name: "Draft",
        status: "draft",
      }),
    ).toBe(true);
    expect(
      blocksSegmentDelete({
        kind: "campaign",
        id: "c2",
        name: "Sent",
        status: "sent",
      }),
    ).toBe(false);
    expect(
      blocksSegmentDelete({
        kind: "form",
        id: "f1",
        name: "Signup",
        blocks_delete: true,
      }),
    ).toBe(false);
  });

  it("offers undo when nothing blocks the delete", () => {
    expect(segmentDeleteDescription("Old audience", [])).toBe(
      '"Old audience" will be permanently deleted. A short Undo is offered afterwards.',
    );
  });
});
