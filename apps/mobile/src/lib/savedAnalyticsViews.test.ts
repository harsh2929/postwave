/**
 * Named analytics presets: the storage half.
 *
 * Everything asserted here is about the two ways a stored preset can lie —
 * applying a vocabulary this build no longer has (which becomes a 400 on the
 * next breakdown fetch), and surviving a corrupt or foreign stored string by
 * throwing on the screen's mount.
 */
import { describe, expect, it } from "vitest";

import {
  MAX_SAVED_VIEWS,
  MAX_VIEW_NAME,
  SAVED_VIEWS_EMPTY,
  deleteViewConfirm,
  parseSavedViews,
  removeSavedView,
  savedViewNameError,
  savedViewSpoken,
  savedViewSummary,
  serializeSavedViews,
  upsertSavedView,
  viewIsActive,
  type SavedAnalyticsView,
} from "./savedAnalyticsViews";

const VOCAB = {
  ranges: ["7d", "30d", "90d"],
  dimensions: ["campaign", "domain"],
  metrics: ["opens", "clicks", "bounces"],
};

const VIEW: SavedAnalyticsView = {
  id: "v1",
  name: "Monday check",
  range: "7d",
  dimension: "campaign",
  metric: "clicks",
};

describe("parseSavedViews", () => {
  it("reads back what serializeSavedViews wrote", () => {
    expect(parseSavedViews(serializeSavedViews([VIEW]), VOCAB)).toEqual([VIEW]);
  });

  it("returns nothing for a corrupt or foreign stored value, never throwing", () => {
    for (const raw of ["", "{", "null", "{}", undefined, 4, [1, 2]]) {
      expect(parseSavedViews(raw, VOCAB)).toEqual([]);
    }
  });

  it("DROPS a preset naming a vocabulary this build no longer has", () => {
    const stored = JSON.stringify([
      VIEW,
      { ...VIEW, id: "v2", name: "Old", metric: "revenue" },
      { ...VIEW, id: "v3", name: "Older", range: "365d" },
      { ...VIEW, id: "v4", name: "Oldest", dimension: "template" },
    ]);
    // Coercing them to a default would apply "opens" under a chip labelled
    // "Revenue"; the server would 400 on the unknown value either way.
    expect(parseSavedViews(stored, VOCAB).map((v) => v.name)).toEqual([
      "Monday check",
    ]);
  });

  it("drops an unnamed preset — a nameless chip cannot be recognised", () => {
    const stored = JSON.stringify([{ ...VIEW, name: "   " }]);
    expect(parseSavedViews(stored, VOCAB)).toEqual([]);
  });

  it("caps what it reads back, so one bad write cannot flood the row", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...VIEW,
      id: `v${i}`,
      name: `View ${i}`,
    }));
    expect(parseSavedViews(JSON.stringify(many), VOCAB)).toHaveLength(
      MAX_SAVED_VIEWS,
    );
  });
});

describe("upsertSavedView", () => {
  it("puts the newest first", () => {
    const next = upsertSavedView([VIEW], { ...VIEW, id: "v2", name: "Deep dive" });
    expect(next.map((v) => v.name)).toEqual(["Deep dive", "Monday check"]);
  });

  it("REPLACES a same-name preset instead of keeping two chips alike", () => {
    const next = upsertSavedView([VIEW], {
      ...VIEW,
      id: "v2",
      name: "monday check",
      range: "90d",
    });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ name: "monday check", range: "90d" });
  });

  it("keeps the list inside its cap", () => {
    let views: SavedAnalyticsView[] = [];
    for (let i = 0; i < MAX_SAVED_VIEWS + 5; i += 1) {
      views = upsertSavedView(views, { ...VIEW, id: `v${i}`, name: `V${i}` });
    }
    expect(views).toHaveLength(MAX_SAVED_VIEWS);
  });

  it("removes by id, leaving the rest untouched", () => {
    const two = upsertSavedView([VIEW], { ...VIEW, id: "v2", name: "Other" });
    expect(removeSavedView(two, "v2").map((v) => v.id)).toEqual(["v1"]);
  });
});

describe("naming", () => {
  it("refuses an empty name and says why", () => {
    expect(savedViewNameError("   ")).toContain("Give the view a name");
  });

  it("refuses a name too long for a chip", () => {
    expect(savedViewNameError("x".repeat(MAX_VIEW_NAME + 1))).toContain(
      `${MAX_VIEW_NAME} characters`,
    );
  });

  it("accepts an ordinary name", () => {
    expect(savedViewNameError(" Monday check ")).toBeNull();
  });
});

describe("copy", () => {
  it("states what a preset restores", () => {
    expect(
      savedViewSummary({
        range: "Last 7 days",
        metric: "clicks",
        dimension: "Campaign",
      }),
    ).toBe("Last 7 days · clicks by Campaign");
  });

  it("speaks the applied state and the long-press affordance", () => {
    const labels = {
      range: "Last 7 days",
      metric: "clicks",
      dimension: "Campaign",
    };
    expect(savedViewSpoken(VIEW, labels, true)).toContain("currently applied");
    expect(savedViewSpoken(VIEW, labels, false)).toContain("press and hold");
  });

  it("names the preset in its own delete confirmation", () => {
    expect(deleteViewConfirm(VIEW).title).toBe("Delete “Monday check”?");
    expect(deleteViewConfirm(VIEW).message).toContain("not affected");
  });

  it("explains the control before one exists", () => {
    expect(SAVED_VIEWS_EMPTY).toContain("one tap");
  });
});

describe("viewIsActive", () => {
  it("is active only when all three controls match", () => {
    expect(
      viewIsActive(VIEW, { range: "7d", dimension: "campaign", metric: "clicks" }),
    ).toBe(true);
    expect(
      viewIsActive(VIEW, { range: "7d", dimension: "campaign", metric: "opens" }),
    ).toBe(false);
    expect(
      viewIsActive(VIEW, { range: "30d", dimension: "campaign", metric: "clicks" }),
    ).toBe(false);
  });
});
