/**
 * Every exported list-shaper must survive a TRUTHY NON-ARRAY payload.
 *
 * WHY THIS CLASS KEEPS RECURRING. Screens write `query.data ?? []`, which is a
 * NULLISH guard: it catches undefined and null and passes `{}` or
 * `{items: []}` straight through. The receiving function then spreads or
 * iterates it and takes the whole screen down. It is reachable from a restored
 * persisted cache written by an older response shape, which is exactly how this
 * repo shipped MaintenanceBanner's "windows.find is not a function" and
 * api-keys' "Invalid attempt to spread non-iterable instance".
 *
 * Measured before this file existed: of four sorters reachable from a query
 * result, THREE threw (sortMandates, sortScheduledReports, sortDefinitions) and
 * only sortIdempotencyKeys had the Array.isArray guard.
 *
 * This is a table rather than four separate tests so a NEW sorter is covered by
 * adding one line, and the vacuity floor below fails if the table is emptied.
 */
import { describe, expect, it } from "vitest";

import { sortMandates } from "@/lib/agentMandates";
import { sortIdempotencyKeys } from "@/lib/idempotencyKeys";
import { sortScheduledReports } from "@/lib/scheduledReports";
import { sortDefinitions, latestRunFor } from "@/lib/savedReports";
import { indexByDomain } from "@/lib/deliverabilitySignals";

/** Payloads that pass `?? []` and are not arrays. */
const HOSTILE: readonly unknown[] = [
  {},
  { items: [] },
  { data: [] },
  "not an array",
  42,
  true,
];

const SHAPERS: readonly [string, (bad: never) => unknown][] = [
  ["sortMandates", (bad) => sortMandates(bad)],
  ["sortIdempotencyKeys", (bad) => sortIdempotencyKeys(bad)],
  ["sortScheduledReports", (bad) => sortScheduledReports(bad, Date.now())],
  ["sortDefinitions", (bad) => sortDefinitions(bad, bad)],
  ["latestRunFor", (bad) => latestRunFor(bad, "some-id")],
  // Added after the per-screen pass: custom-domains passes `health.data ?? []`
  // into this, and a for-of over a truthy non-array throws "is not iterable".
  ["indexByDomain", (bad) => indexByDomain(bad)],
];

describe("wire list-shapers survive a non-array payload", () => {
  it("has shapers to check", () => {
    // Vacuity floor: an empty table would pass every assertion below.
    expect(SHAPERS.length).toBeGreaterThan(4);
  });

  for (const [name, call] of SHAPERS) {
    it(`${name} does not throw`, () => {
      for (const bad of HOSTILE) {
        expect(
          () => call(bad as never),
          `${name} threw on ${JSON.stringify(bad)}`,
        ).not.toThrow();
      }
    });
  }

  it("still sorts a REAL array — the guard must not swallow good input", () => {
    // A guard that returned [] unconditionally would pass every test above.
    const rows = sortIdempotencyKeys([
      { key: "b", state: "settled" },
      { key: "a", state: "pending" },
    ] as never);
    expect(rows).toHaveLength(2);
    expect((rows[0] as { state: string }).state).toBe("pending");
  });
});
