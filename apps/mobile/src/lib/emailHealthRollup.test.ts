/**
 * The arithmetic behind a bulk email-health read.
 *
 * Two of these tests are about the SERVER's constraints rather than about
 * presentation, and they are the ones worth having: the batch client refuses
 * a response whose `total + duplicates` does not equal what it asked for, and
 * the handler refuses more than MaxBatch addresses. Both failures look like
 * "the feature is broken" rather than "the input was wrong", so the shaping
 * that prevents them is pinned here.
 */
import { describe, expect, it } from "vitest";

import type { EmailHealth } from "@/api/emailHealth";
import {
  chunkHealthAddresses,
  EMAIL_HEALTH_MAX_BATCH,
  healthRollupHeadline,
  normalizeHealthAddresses,
  rollupEmailHealth,
} from "./emailHealthRollup";

function health(over: Partial<EmailHealth>): EmailHealth {
  return {
    email: "ada@example.test",
    grade: "A",
    recommendation: "send",
    hard_stop: false,
    send_eligible: true,
    evidence_complete: true,
    reason_codes: [],
    evidence: [],
    model_version: "v1",
    computed_at: "2026-08-27T10:00:00Z",
    ...over,
  };
}

describe("shaping the addresses before asking", () => {
  it("normalizes the way the server does, so one mailbox costs one lookup", () => {
    // And, more importantly, so the same mailbox cannot land in two chunks —
    // which would make each chunk claim a result the other asked for and trip
    // the batch client's own duplicate check.
    expect(
      normalizeHealthAddresses(["Ada@Example.com", " ada@example.com "]),
    ).toEqual(["ada@example.com"]);
  });

  it("drops what is not an address rather than failing the whole chunk", () => {
    // The handler rejects the entire request on one malformed entry, so a
    // single empty email column would cost the answer for everyone else.
    expect(
      normalizeHealthAddresses([null, undefined, "", "a", "real@example.com"]),
    ).toEqual(["real@example.com"]);
  });

  it("keeps first-seen order", () => {
    expect(
      normalizeHealthAddresses(["b@example.com", "a@example.com"]),
    ).toEqual(["b@example.com", "a@example.com"]);
  });
});

describe("chunking for MaxBatch", () => {
  it("mirrors the server's 1000-address ceiling", () => {
    expect(EMAIL_HEALTH_MAX_BATCH).toBe(1000);
    const many = Array.from({ length: 2_500 }, (_, i) => `p${i}@example.com`);
    const chunks = chunkHealthAddresses(many);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(1000);
    expect(chunks[2]).toHaveLength(500);
    // Nothing dropped and nothing repeated: the union is the input.
    expect(chunks.flat()).toEqual(many);
  });

  it("never lets a caller ask for a chunk the handler would 413", () => {
    expect(chunkHealthAddresses(["a@example.com"], 99_999)[0]).toHaveLength(1);
    const many = Array.from({ length: 1_200 }, (_, i) => `p${i}@example.com`);
    for (const chunk of chunkHealthAddresses(many, 99_999)) {
      expect(chunk.length).toBeLessThanOrEqual(EMAIL_HEALTH_MAX_BATCH);
    }
  });

  it("returns nothing for nothing, rather than one empty request", () => {
    // An empty body is a 422 from the handler: "at least one email address is
    // required".
    expect(chunkHealthAddresses([])).toEqual([]);
  });
});

describe("rolling the per-address answers up", () => {
  it("counts every grade, including the ones nobody scored", () => {
    const rollup = rollupEmailHealth([
      health({ grade: "A" }),
      health({
        grade: "D",
        recommendation: "do_not_send",
        send_eligible: false,
      }),
      health({
        grade: "F",
        recommendation: "blocked",
        hard_stop: true,
        send_eligible: false,
      }),
    ]);
    expect(rollup.total).toBe(3);
    expect(rollup.summary).toEqual({ A: 1, B: 0, C: 0, D: 1, F: 1, U: 0 });
  });

  it("counts blocked as do-not-send — both mean do not mail this person", () => {
    const rollup = rollupEmailHealth([
      health({
        grade: "D",
        recommendation: "do_not_send",
        send_eligible: false,
      }),
      health({
        grade: "F",
        recommendation: "blocked",
        send_eligible: false,
      }),
      health({ grade: "U", recommendation: "caution" }),
      health({ recommendation: "send" }),
    ]);
    expect(rollup.doNotSend).toBe(2);
  });

  it("carries hard stops and incomplete evidence separately from the grade", () => {
    // `evidence_complete: false` means the grade is provisional. Folding it
    // into the grade would present a partial answer as a measurement.
    const rollup = rollupEmailHealth([
      health({
        grade: "F",
        hard_stop: true,
        recommendation: "blocked",
        send_eligible: false,
      }),
      health({
        evidence_complete: false,
        grade: "U",
        recommendation: "caution",
        send_eligible: false,
      }),
    ]);
    expect(rollup.hardStop).toBe(1);
    expect(rollup.incompleteEvidence).toBe(1);
    expect(rollup.summary.U).toBe(1);
  });

  it("answers an empty set with zeroes, not with an absent summary", () => {
    const rollup = rollupEmailHealth([]);
    expect(rollup.total).toBe(0);
    expect(rollup.summary).toEqual({ A: 0, B: 0, C: 0, D: 0, F: 0, U: 0 });
  });
});

describe("the headline", () => {
  it("claims nothing about a set it did not check", () => {
    expect(healthRollupHeadline(rollupEmailHealth([]))).toBe(
      "No addresses were checked.",
    );
  });

  it("says how many were checked, never that the list is healthy", () => {
    const clean = rollupEmailHealth([health({}), health({})]);
    expect(healthRollupHeadline(clean)).toBe(
      "2 addresses checked — none is flagged do-not-send.",
    );
  });

  it("agrees with itself in the singular", () => {
    const one = rollupEmailHealth([
      health({
        grade: "F",
        recommendation: "blocked",
        send_eligible: false,
      }),
    ]);
    expect(healthRollupHeadline(one)).toBe(
      "1 address checked — 1 is flagged do-not-send.",
    );
  });
});
