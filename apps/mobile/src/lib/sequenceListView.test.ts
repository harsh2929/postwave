import { describe, expect, it } from "vitest";


import type { SequenceRowLike } from "./sequenceListView";
import {
  DEFAULT_SEQUENCE_LIST_PREFS,
  deriveSequenceListView,
  foldForSearch,
  isDraftSequence,
  sequenceRowStepCount,
  truncationNotice,
} from "./sequenceListView";

function seq(over: Partial<SequenceRowLike>): SequenceRowLike {
  return { id: over.name ?? "id", ...over };
}

const rows: SequenceRowLike[] = [
  seq({ name: "Welcome", status: "draft", updated_at: "2026-07-01T00:00:00Z", steps: 3 }),
  seq({ name: "Win-back", status: "active", updated_at: "2026-07-05T00:00:00Z", steps: 9 }),
  seq({ name: "Café loyalty", status: "paused", updated_at: "2026-06-01T00:00:00Z", steps: 1 }),
  seq({ name: "Onboarding", status: "DRAFT", updated_at: "2026-07-09T00:00:00Z", steps: 5 }),
];

describe("isDraftSequence", () => {
  it("is case- and whitespace-insensitive", () => {
    expect(isDraftSequence(seq({ status: " Draft " }))).toBe(true);
    expect(isDraftSequence(seq({ status: "archived" }))).toBe(false);
    expect(isDraftSequence(seq({}))).toBe(false);
  });
});

describe("foldForSearch", () => {
  it("folds case and diacritics", () => {
    expect(foldForSearch("Café")).toBe("cafe");
    expect(foldForSearch("ÑOÑO")).toBe("nono");
  });
});

describe("deriveSequenceListView", () => {
  it("counts drafts and read-only rows over the FULL set, not the filtered one", () => {
    const view = deriveSequenceListView(rows, { filter: "drafts", sort: "updated" }, "");
    expect(view.total).toBe(4);
    expect(view.draftCount).toBe(2);
    expect(view.readOnlyCount).toBe(2);
    expect(view.rows.map((r) => r.name)).toEqual(["Onboarding", "Welcome"]);
  });

  it("sorts by updated desc, name asc, or step count desc", () => {
    expect(
      deriveSequenceListView(rows, DEFAULT_SEQUENCE_LIST_PREFS, "").rows.map(
        (r) => r.name,
      ),
    ).toEqual(["Onboarding", "Win-back", "Welcome", "Café loyalty"]);
    expect(
      deriveSequenceListView(rows, { filter: "all", sort: "name" }, "").rows.map(
        (r) => r.name,
      ),
    ).toEqual(["Café loyalty", "Onboarding", "Welcome", "Win-back"]);
    expect(
      deriveSequenceListView(rows, { filter: "all", sort: "steps" }, "").rows.map(
        (r) => r.name,
      ),
    ).toEqual(["Win-back", "Onboarding", "Welcome", "Café loyalty"]);
  });

  it("searches case- and diacritic-insensitively across name and status", () => {
    expect(
      deriveSequenceListView(rows, DEFAULT_SEQUENCE_LIST_PREFS, "cafe").rows.map(
        (r) => r.name,
      ),
    ).toEqual(["Café loyalty"]);
    expect(
      deriveSequenceListView(rows, DEFAULT_SEQUENCE_LIST_PREFS, "  PAUSED ").rows,
    ).toHaveLength(1);
    expect(
      deriveSequenceListView(rows, DEFAULT_SEQUENCE_LIST_PREFS, "nothing").rows,
    ).toHaveLength(0);
  });

  it("treats a blank query as no query", () => {
    expect(
      deriveSequenceListView(rows, DEFAULT_SEQUENCE_LIST_PREFS, "   ").rows,
    ).toHaveLength(4);
  });

  it("caps an unbounded server response and says so", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      seq({ name: `s${i}`, status: "draft", updated_at: "2026-07-01T00:00:00Z" }),
    );
    const view = deriveSequenceListView(many, DEFAULT_SEQUENCE_LIST_PREFS, "", 5);
    expect(view.rows).toHaveLength(5);
    expect(view.matched).toBe(12);
    expect(view.truncated).toBe(true);
    expect(truncationNotice(view)).toBe(
      "Showing the first 5 of 12 matches — narrow with search.",
    );
  });

  it("says nothing when nothing was hidden", () => {
    const view = deriveSequenceListView(rows, DEFAULT_SEQUENCE_LIST_PREFS, "");
    expect(view.truncated).toBe(false);
    expect(truncationNotice(view)).toBeNull();
  });

  it("handles an empty response without dividing by anything", () => {
    const view = deriveSequenceListView([], DEFAULT_SEQUENCE_LIST_PREFS, "");
    expect(view).toMatchObject({ total: 0, draftCount: 0, readOnlyCount: 0, matched: 0 });
  });

  it("sorts rows missing updated_at last rather than crashing", () => {
    const mixed: SequenceRowLike[] = [seq({ name: "no date" }), seq({ name: "dated", updated_at: "2026-07-01T00:00:00Z" })];
    expect(
      deriveSequenceListView(mixed, DEFAULT_SEQUENCE_LIST_PREFS, "").rows.map(
        (r) => r.name,
      ),
    ).toEqual(["dated", "no date"]);
  });
});

describe("sequenceRowStepCount", () => {
  it("counts nested condition branches, which the row's steps.length omits", () => {
    // GET /api/v1/voice/sequences returns whole generation.Sequence rows, so
    // `steps` is the nested ARRAY. A journey whose body lives inside one
    // condition used to render as "1 step" here while the detail header —
    // which recurses — said 4.
    const row: SequenceRowLike = {
      id: "s1",
      steps: [
        {
          type: "condition",
          position: 1,
          condition: {
            predicate: "opened_previous",
            yes_branch: [
              { type: "email", position: 1 },
              {
                type: "condition",
                position: 2,
                condition: {
                  predicate: "clicked_any",
                  yes_branch: [{ type: "exit", position: 1 }],
                  no_branch: [],
                },
              },
            ],
            no_branch: [{ type: "email", position: 1 }],
          },
        },
      ],
    };
    expect((row.steps as readonly unknown[]).length).toBe(1);
    expect(sequenceRowStepCount(row)).toBe(5);
  });

  it("reads the legacy flat branch shape too", () => {
    expect(
      sequenceRowStepCount({
        id: "s2",
        steps: [
          {
            type: "condition",
            yes_branch: [{ type: "email" }],
            no_branch: [{ type: "email" }],
          },
        ],
      }),
    ).toBe(3);
  });

  it("survives hostile and missing shapes", () => {
    expect(sequenceRowStepCount({ id: "a" })).toBe(0);
    expect(
      sequenceRowStepCount({ id: "b", steps: [null, undefined, 7] as unknown[] }),
    ).toBe(0);
    expect(sequenceRowStepCount({ id: "c", emails: [{}, {}] })).toBe(2);
    expect(sequenceRowStepCount({ id: "d", steps: 13 })).toBe(13);
  });

  it("stops at the depth ceiling instead of recursing forever", () => {
    type Nested = { type: string; condition: { yes_branch: Nested[]; no_branch: [] } };
    let deepest: Nested = {
      type: "condition",
      condition: { yes_branch: [], no_branch: [] },
    };
    for (let i = 0; i < 200; i += 1) {
      deepest = {
        type: "condition",
        condition: { yes_branch: [deepest], no_branch: [] },
      };
    }
    expect(() =>
      sequenceRowStepCount({ id: "deep", steps: [deepest] }),
    ).not.toThrow();
  });
});
