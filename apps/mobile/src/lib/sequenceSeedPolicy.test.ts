import { describe, expect, it } from "vitest";

import { fetchedSequenceVersion, seedableSteps } from "./sequenceSeedPolicy";

describe("fetchedSequenceVersion — an If-Match token or nothing", () => {
  it("accepts a positive integer version", () => {
    expect(fetchedSequenceVersion({ version: 7 })).toBe(7);
  });

  it("rejects 0, which no write may claim as authority", () => {
    // `0` looks like a number and reads as falsy; sent as If-Match it matches
    // nothing, so the write is rejected or silently ignored. Null instead
    // makes the save path fail closed and say so.
    expect(fetchedSequenceVersion({ version: 0 })).toBeNull();
  });

  it("rejects negatives, floats and NaN rather than coercing them", () => {
    expect(fetchedSequenceVersion({ version: -1 })).toBeNull();
    expect(fetchedSequenceVersion({ version: 1.5 })).toBeNull();
    expect(fetchedSequenceVersion({ version: Number.NaN })).toBeNull();
  });

  it("treats an absent version as absent — the offline-projection case", () => {
    // A stored projection deliberately carries no version, which is exactly
    // what stops a cached sequence from being saved over the live one.
    expect(fetchedSequenceVersion({})).toBeNull();
    expect(fetchedSequenceVersion({ version: undefined })).toBeNull();
  });
});

describe("seedableSteps — branchable shape wins, legacy is a fallback", () => {
  it("prefers `steps` when it has content", () => {
    const steps = [{ id: "a" }];
    expect(seedableSteps({ steps, emails: [{ id: "legacy" }] })).toBe(steps);
  });

  it("falls back to legacy `emails` when there are no steps at all", () => {
    const emails = [{ id: "legacy" }];
    expect(seedableSteps({ emails })).toEqual(emails);
  });

  it("returns empty when neither field carries anything", () => {
    expect(seedableSteps({})).toEqual([]);
    expect(seedableSteps({ steps: [] })).toEqual([]);
  });

  it("treats an EMPTY `steps` as 'unmigrated', not as 'no steps'", () => {
    // The Voice gateway returns `steps: []` for pre-step-model sequences, so
    // empty-as-authoritative would blank a journey the user can see on
    // desktop. The route test asserts the visible consequence ("Paused · 2
    // steps"); this pins the rule it rests on.
    expect(seedableSteps({ steps: [], emails: [{ id: "old" }] })).toEqual([
      { id: "old" },
    ]);
  });

  it("tolerates a non-array `emails` from a malformed body", () => {
    expect(seedableSteps({ emails: { nope: true } })).toEqual([]);
  });
});
