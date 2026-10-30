// SPDX-License-Identifier: AGPL-3.0-only
//
// The fixture's own coverage of the SHARED RULE.
//
// This proves the rule is right. It deliberately does NOT prove any engine
// obeys it — every case here calls `isSuppressedByTombstone` directly with
// well-formed arguments, which is precisely the assumption an engine's call
// site can violate. The engines run the same CASES through their real replay
// paths in their own suites; see conformance.ts.

import { describe, expect, it } from "vitest";

import { conformanceCases, failureScenarios, scriptedReplay } from "./conformance";
import { isSuppressedByTombstone } from "./tombstone";

describe("tombstone conformance", () => {
  it("has cases", () => {
    expect(conformanceCases().length).toBeGreaterThan(5);
  });

  for (const c of conformanceCases()) {
    it(`${c.name}: ${c.suppressed ? "suppressed" : "sent"}`, () => {
      expect(isSuppressedByTombstone(c.mutation, c.tombstones), c.why).toBe(c.suppressed);
    });
  }
});

describe("failure-injection fixture", () => {
  it("covers every injectable outcome, so no engine is certified against a subset", () => {
    const used = new Set(failureScenarios().flatMap((s) => Object.values(s.script)));
    for (const outcome of ["failed", "conflict", "throw"] as const) {
      expect(used.has(outcome), `no scenario injects "${outcome}"`).toBe(true);
    }
  });

  it("every scenario's queue ids are unique, so an attempt assertion is unambiguous", () => {
    for (const s of failureScenarios()) {
      const ids = s.queue.map((q) => q.id);
      expect(new Set(ids).size, `${s.name} reuses an id`).toBe(ids.length);
    }
  });

  it("scriptedReplay records attempts and turns `throw` into a real rejection", async () => {
    const scenario = failureScenarios().find((s) => s.script["a"] === "throw");
    expect(scenario, "no throwing scenario to check the harness against").toBeDefined();
    const { replay, attempted } = scriptedReplay(scenario!);
    await expect(replay({ id: "a" })).rejects.toThrow(/injected/);
    expect(attempted).toEqual(["a"]);
  });

  it("defaults unscripted items to a successful replay", async () => {
    const { replay } = scriptedReplay(failureScenarios()[0]!);
    await expect(replay({ id: "not-in-script" })).resolves.toBe("replayed");
  });
});
