/**
 * The pre-send AI verdict reader. The load-bearing rule: `incomplete` never
 * collapses to ok — a check that could not run is not a check that passed.
 */
import { describe, expect, it } from "vitest";

import {
  readPresendVerdict,
  verdictHeadline,
  verdictTone,
} from "./campaignVerdict";

describe("readPresendVerdict", () => {
  it("reads verdict, summary and component rows with normalized scores", () => {
    const reading = readPresendVerdict({
      verdict: "warn",
      summary: "One component flagged.",
      complete: true,
      components: [
        { name: "eq_score", status: "ok", score: 0.82 },
        { name: "voice_drift", status: "warn", score: 41, message: "drifting" },
        { name: "", status: "dropped" },
      ],
    });
    expect(reading).not.toBeNull();
    expect(reading!.verdict).toBe("warn");
    expect(reading!.components).toHaveLength(2);
    expect(reading!.components[0]!.label).toBe("EQ score");
    expect(reading!.components[0]!.scoreLabel).toBe("82/100");
    expect(reading!.components[1]!.scoreLabel).toBe("41/100");
    expect(reading!.components[1]!.message).toBe("drifting");
  });

  it("accepts every verdict the server can utter — 'ok' included", () => {
    // "ok" is the happy path an operator sees most; a reader that rejects it
    // turns every clean campaign into "unexpected shape".
    for (const v of ["ok", "warn", "critical", "incomplete"] as const) {
      expect(readPresendVerdict({ verdict: v })?.verdict).toBe(v);
    }
  });

  it("refuses an unknown verdict outright", () => {
    expect(readPresendVerdict({ verdict: "fine" })).toBeNull();
    expect(readPresendVerdict(null)).toBeNull();
  });

  it("incomplete stays incomplete — it never reads as ok", () => {
    const reading = readPresendVerdict({ verdict: "incomplete" })!;
    expect(reading.verdict).toBe("incomplete");
    expect(verdictTone("incomplete")).toBe("neutral");
    expect(verdictHeadline(reading)).toMatch(/not every check could run/);
  });

  it("tones escalate with the verdict", () => {
    expect(verdictTone("ok")).toBe("success");
    expect(verdictTone("warn")).toBe("warning");
    expect(verdictTone("critical")).toBe("danger");
  });
});
