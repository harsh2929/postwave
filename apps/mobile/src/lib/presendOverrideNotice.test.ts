/**
 * The reason line under an escalated Send button: one sentence, chosen in
 * the sheet's order of irreversibility, always ending with the same promise.
 */
import { describe, expect, it } from "vitest";

import {
  presendOverrideReason,
  type PresendOverrideFlags,
} from "./presendOverrideNotice";

const NONE: PresendOverrideFlags = {
  blockedByChecks: false,
  brokenLinks: false,
  offVoice: false,
  verdictCritical: false,
};

const PROMISE = "You'll be asked to confirm before this sends.";

describe("presendOverrideReason", () => {
  it("names the critical pre-send verdict when it is the only reason", () => {
    expect(presendOverrideReason({ ...NONE, verdictCritical: true })).toBe(
      `The pre-send verdict found a critical issue. ${PROMISE}`,
    );
  });

  it("falls through to the daily cap when nothing else escalated", () => {
    expect(presendOverrideReason(NONE)).toBe(
      `This send exceeds today's cap. ${PROMISE}`,
    );
  });

  it("tells the operator the worst thing first: checks > links > voice > verdict > cap", () => {
    const all: PresendOverrideFlags = {
      blockedByChecks: true,
      brokenLinks: true,
      offVoice: true,
      verdictCritical: true,
    };
    expect(presendOverrideReason(all)).toMatch(/^One or more pre-send checks failed\./);
    expect(presendOverrideReason({ ...all, blockedByChecks: false })).toMatch(
      /^One or more links in this campaign didn't resolve\./,
    );
    expect(
      presendOverrideReason({ ...all, blockedByChecks: false, brokenLinks: false }),
    ).toMatch(/^This draft scored far below your workspace's measured brand voice\./);
    expect(
      presendOverrideReason({
        ...all,
        blockedByChecks: false,
        brokenLinks: false,
        offVoice: false,
      }),
    ).toMatch(/^The pre-send verdict found a critical issue\./);
  });

  it("every branch ends with the same promise — the notice is not a second gate", () => {
    const keys = Object.keys(NONE) as (keyof PresendOverrideFlags)[];
    const cases: PresendOverrideFlags[] = [NONE, ...keys.map((k) => ({ ...NONE, [k]: true }))];
    const sentences = new Set<string>();
    for (const flags of cases) {
      const text = presendOverrideReason(flags);
      expect(text.endsWith(` ${PROMISE}`)).toBe(true);
      sentences.add(text);
    }
    // Five distinct reasons — no two flags collapse to the same sentence.
    expect(sentences.size).toBe(5);
  });
});
