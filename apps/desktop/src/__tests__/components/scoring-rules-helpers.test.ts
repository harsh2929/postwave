// Lead-scoring helpers (full-surface wiring #18): draft ↔ wire
// conversion, validation mirroring scoring.go's PutRules checks, semantic
// diffing, and strict runtime parsing of the versioned server contract.

import { describe, expect, it } from "vitest";

import {
  SCORING_NOTE_MAX_CHARACTERS,
  SCORING_WEIGHT_MAX,
  SCORING_WEIGHT_MIN,
  type ScoringRuleDraft,
  diffScoringDrafts,
  draftFromScoringRule,
  draftsToScoringRules,
  emptyScoringDraft,
  normalizeScoringDefaults,
  parseScoringRulesResponse,
  parseScoringSaveResponse,
  scoringDraftsEqual,
  validateScoringDrafts,
} from "../../components/subscribers/scoring-rules-helpers";

function draft(over: Partial<ScoringRuleDraft>): ScoringRuleDraft {
  return { id: "", event_type: "clicked", weight: "5", note: "", ...over };
}

describe("validateScoringDrafts", () => {
  it("accepts a valid set", () => {
    expect(
      validateScoringDrafts([
        draft({ event_type: "opened", weight: "1" }),
        draft({ event_type: "clicked", weight: "5" }),
        draft({ event_type: "complained", weight: "-50" }),
      ]),
    ).toEqual({});
  });

  it("rejects an empty (or whitespace-only) event_type, mirroring the server", () => {
    const errors = validateScoringDrafts([draft({ event_type: "   " })]);
    expect(errors[0]).toMatch(/event type is required/i);
  });

  it("rejects non-integer and out-of-range weights", () => {
    expect(validateScoringDrafts([draft({ weight: "1.5" })])[0]).toMatch(
      /whole number/i,
    );
    expect(validateScoringDrafts([draft({ weight: "" })])[0]).toMatch(
      /whole number/i,
    );
    expect(
      validateScoringDrafts([
        draft({ weight: String(SCORING_WEIGHT_MAX + 1) }),
      ])[0],
    ).toMatch(/-1000\.\.1000/);
    expect(
      validateScoringDrafts([
        draft({ weight: String(SCORING_WEIGHT_MIN - 1) }),
      ])[0],
    ).toMatch(/-1000\.\.1000/);
    // Bounds themselves are legal.
    expect(
      validateScoringDrafts([
        draft({ event_type: "a", weight: String(SCORING_WEIGHT_MIN) }),
        draft({ event_type: "b", weight: String(SCORING_WEIGHT_MAX) }),
      ]),
    ).toEqual({});
  });

  it("flags duplicate event_types on the LATER row (engine keeps one weight per event)", () => {
    const errors = validateScoringDrafts([
      draft({ event_type: "clicked" }),
      draft({ event_type: "opened" }),
      draft({ event_type: "clicked", weight: "9" }),
    ]);
    expect(errors[0]).toBeUndefined();
    expect(errors[1]).toBeUndefined();
    expect(errors[2]).toMatch(/duplicate/i);
  });

  it("keys errors by row index and validates every row", () => {
    const errors = validateScoringDrafts([
      draft({ event_type: "" }),
      draft({ event_type: "ok" }),
      draft({ weight: "9999", event_type: "big" }),
    ]);
    expect(Object.keys(errors).sort()).toEqual(["0", "2"]);
  });

  it("enforces the server event catalog and note bounds", () => {
    const catalog = new Set(["opened", "clicked"]);
    expect(
      validateScoringDrafts([draft({ event_type: "form_submit" })], catalog)[0],
    ).toMatch(/server catalog/i);
    expect(
      validateScoringDrafts(
        [draft({ note: "x".repeat(SCORING_NOTE_MAX_CHARACTERS + 1) })],
        catalog,
      )[0],
    ).toMatch(/at most 240/i);
    expect(
      validateScoringDrafts([draft({ note: "one\ntwo" })], catalog)[0],
    ).toMatch(/control characters/i);
  });
});

describe("draftsToScoringRules / draftFromScoringRule", () => {
  it("trims fields, parses weight, and omits empty notes", () => {
    const rules = draftsToScoringRules([
      draft({ id: "r1", event_type: " clicked ", weight: "5", note: "  " }),
      draft({ event_type: "opened", weight: "-10", note: " hot lead " }),
    ]);
    expect(rules).toEqual([
      { id: "r1", event_type: "clicked", weight: 5 },
      { id: "", event_type: "opened", weight: -10, note: "hot lead" },
    ]);
  });

  it("round-trips a server rule through a draft", () => {
    const rule = { id: "abc", event_type: "replied", weight: 10, note: "n" };
    expect(draftsToScoringRules([draftFromScoringRule(rule)])).toEqual([rule]);
  });

  it("emptyScoringDraft starts valid except for the missing event_type", () => {
    const errors = validateScoringDrafts([emptyScoringDraft()]);
    expect(errors[0]).toMatch(/event type is required/i);
  });
});

describe("scoring draft diff", () => {
  it("is semantic across ids, ordering, and harmless whitespace", () => {
    const before = [
      draft({ id: "a", event_type: "clicked", weight: "5", note: "signal" }),
      draft({ id: "b", event_type: "opened", weight: "1" }),
    ];
    const equivalent = [
      draft({ id: "new", event_type: " opened ", weight: "1", note: " " }),
      draft({
        id: "other",
        event_type: "clicked",
        weight: "5",
        note: " signal ",
      }),
    ];
    expect(scoringDraftsEqual(before, equivalent)).toBe(true);
    expect(diffScoringDrafts(before, equivalent)).toEqual({
      added: 0,
      changed: 0,
      removed: 0,
      unchanged: 2,
      switchesToDefaults: false,
    });
  });

  it("counts added, changed, removed, and default fallback truthfully", () => {
    const baseline = [
      draft({ event_type: "clicked", weight: "5" }),
      draft({ event_type: "opened", weight: "1" }),
    ];
    expect(
      diffScoringDrafts(baseline, [
        draft({ event_type: "clicked", weight: "7" }),
        draft({ event_type: "replied", weight: "10" }),
      ]),
    ).toEqual({
      added: 1,
      changed: 1,
      removed: 1,
      unchanged: 0,
      switchesToDefaults: false,
    });
    expect(diffScoringDrafts(baseline, []).switchesToDefaults).toBe(true);
  });
});

describe("normalizeScoringDefaults", () => {
  it("normalizes a legacy map shape for migration-only callers", () => {
    expect(
      normalizeScoringDefaults({ opened: 1, clicked: 5, complained: -50 }),
    ).toEqual([
      { event_type: "clicked", weight: 5 },
      { event_type: "complained", weight: -50 },
      { event_type: "opened", weight: 1 },
    ]);
  });

  it("accepts the canonical array-of-rules shape", () => {
    expect(
      normalizeScoringDefaults([
        { id: "x", event_type: "opened", weight: 1 },
        { id: "y", event_type: "bounced", weight: -10 },
      ]),
    ).toEqual([
      { event_type: "bounced", weight: -10 },
      { event_type: "opened", weight: 1 },
    ]);
  });

  it("drops malformed entries and tolerates junk input", () => {
    expect(normalizeScoringDefaults(null)).toEqual([]);
    expect(normalizeScoringDefaults("nope")).toEqual([]);
    expect(
      normalizeScoringDefaults([
        { event_type: "", weight: 1 },
        { weight: 2 },
        null,
      ]),
    ).toEqual([]);
    expect(normalizeScoringDefaults({ opened: "high" })).toEqual([]);
  });
});

describe("versioned scoring response parsing", () => {
  const version = `sha256:${"a".repeat(64)}`;
  const valid = {
    rules: [{ id: "r1", event_type: "clicked", weight: 5 }],
    defaults: [{ id: "", event_type: "opened", weight: 1 }],
    event_catalog: [
      {
        event_type: "opened",
        label: "Email opened",
        category: "engagement",
      },
      {
        event_type: "clicked",
        label: "Link clicked",
        category: "engagement",
      },
    ],
    version,
    window_days: 90,
  };

  it("accepts a complete internally consistent contract and clones it", () => {
    expect(parseScoringRulesResponse(valid)).toEqual(valid);
    expect(parseScoringSaveResponse({ saved: 1, version }, 1)).toEqual({
      saved: 1,
      version,
    });
  });

  it.each([
    ["bad version", { ...valid, version: "legacy" }],
    ["empty defaults", { ...valid, defaults: [] }],
    [
      "duplicate catalog",
      {
        ...valid,
        event_catalog: [valid.event_catalog[0], valid.event_catalog[0]],
      },
    ],
    [
      "rule outside catalog",
      {
        ...valid,
        rules: [{ id: "r2", event_type: "form_submit", weight: 1 }],
      },
    ],
    ["duplicate rules", { ...valid, rules: [valid.rules[0], valid.rules[0]] }],
    [
      "fractional weight",
      {
        ...valid,
        rules: [{ id: "r1", event_type: "clicked", weight: 1.5 }],
      },
    ],
    [
      "control note",
      {
        ...valid,
        rules: [
          { id: "r1", event_type: "clicked", weight: 5, note: "one\ntwo" },
        ],
      },
    ],
    ["invalid window", { ...valid, window_days: 0 }],
  ])("rejects %s", (_name, candidate) => {
    expect(parseScoringRulesResponse(candidate)).toBeNull();
  });

  it("rejects save receipts with the wrong count or an invalid version", () => {
    expect(parseScoringSaveResponse({ saved: 2, version }, 1)).toBeNull();
    expect(
      parseScoringSaveResponse({ saved: 1, version: "legacy" }, 1),
    ).toBeNull();
  });
});
