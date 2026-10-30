/**
 * The send sheet's reaction to the unified pre-send verdict. The load-bearing
 * rule: only CRITICAL escalates; every other outcome — warn, incomplete, a
 * 502 from an absent sidecar, a 404, a 503 — is a sentence that ends with
 * "Sending will proceed without it."
 */
import { describe, expect, it } from "vitest";

import { readPresendVerdict, type PresendVerdictReading } from "./campaignVerdict";
import {
  canRunPresendVerdict,
  presendFromAddress,
  presendVerdictBlocks,
  presendVerdictConsequence,
  presendVerdictFailureNotice,
  presendVerdictPillLabel,
  presendVerdictSpoken,
  presendVerdictStandingNotice,
} from "./presendVerdictGate";

function reading(
  verdict: PresendVerdictReading["verdict"],
  extra: Partial<PresendVerdictReading> = {},
): PresendVerdictReading {
  return {
    verdict,
    summary: "",
    complete: verdict !== "incomplete",
    components: [],
    ...extra,
  };
}

/** The wire body verdict.go returns when the voice sidecar is absent. */
const INCOMPLETE_WIRE = {
  verdict: "incomplete",
  complete: false,
  summary: "Pre-send checks incomplete. Unavailable: voice_drift.",
  components: [
    { name: "eq_score", status: "ok", score: 88 },
    { name: "voice_drift", status: "skipped", message: "Voice drift check is not configured." },
    { name: "placement", status: "ok", score: 0.71 },
  ],
  computed_at: "2026-09-02T10:00:00Z",
};

describe("presendFromAddress", () => {
  it("extracts the bare address from the space-joined form the sheet is handed", () => {
    // CampaignDetailModals builds `[from_name, email].join(" ")` — no angle
    // brackets, so mail.ParseAddress server-side would reject it whole.
    expect(presendFromAddress("Acme News hello@acme.com")).toBe("hello@acme.com");
  });

  it("accepts the RFC 5322 display-name form and a bare address", () => {
    expect(presendFromAddress("Acme <hello@acme.com>")).toBe("hello@acme.com");
    expect(presendFromAddress("  hello@acme.com ")).toBe("hello@acme.com");
  });

  it("returns an empty string when no address is present", () => {
    expect(presendFromAddress("Acme News")).toBe("");
    expect(presendFromAddress("")).toBe("");
    expect(presendFromAddress(undefined)).toBe("");
  });
});

describe("canRunPresendVerdict", () => {
  it("needs a non-blank body", () => {
    expect(canRunPresendVerdict("<p>hi</p>")).toBe(true);
    expect(canRunPresendVerdict("   ")).toBe(false);
    expect(canRunPresendVerdict(null)).toBe(false);
  });
});

describe("presendVerdictBlocks", () => {
  it("escalates only a critical verdict", () => {
    expect(presendVerdictBlocks(reading("critical"))).toBe(true);
    expect(presendVerdictBlocks(reading("warn"))).toBe(false);
    expect(presendVerdictBlocks(reading("incomplete"))).toBe(false);
    expect(presendVerdictBlocks(reading("ok"))).toBe(false);
    expect(presendVerdictBlocks(null)).toBe(false);
  });

  it("treats a critical component under a softer verdict as critical (desktop parity)", () => {
    expect(
      presendVerdictBlocks(
        reading("warn", {
          components: [
            { name: "placement", label: "Placement", status: "critical", scoreLabel: "12/100", message: "" },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("never escalates the absent-sidecar answer", () => {
    expect(presendVerdictBlocks(readPresendVerdict(INCOMPLETE_WIRE))).toBe(false);
  });
});

describe("presendVerdictConsequence", () => {
  it("renders the server's summary verbatim on a critical verdict", () => {
    const summary =
      "Critical issues detected. Predicted Primary placement is below 30%. | Checks incomplete: voice_drift.";
    expect(presendVerdictConsequence(reading("critical", { summary }))).toBe(summary);
  });

  it("falls back to a fixed sentence only when the server sent no summary", () => {
    expect(presendVerdictConsequence(reading("critical", { summary: "  " }))).toBe(
      "The pre-send verdict found a critical issue.",
    );
  });

  it("is null for anything that does not escalate", () => {
    expect(presendVerdictConsequence(reading("warn", { summary: "Warnings: x" }))).toBeNull();
    expect(presendVerdictConsequence(null)).toBeNull();
  });
});

describe("presendVerdictFailureNotice", () => {
  const withStatus = (status: number, code?: string) =>
    Object.assign(new Error("boom"), { status, ...(code ? { code } : {}) });

  it("maps a 502 / upstream_unavailable to the upstream notice", () => {
    expect(presendVerdictFailureNotice(withStatus(502)).kind).toBe("upstream");
    // The code wins even when a proxy in front rewrote the status.
    expect(presendVerdictFailureNotice(withStatus(500, "upstream_unavailable")).kind).toBe(
      "upstream",
    );
    expect(presendVerdictFailureNotice(withStatus(502)).text).toBe(
      "The pre-send checks couldn't reach a service they depend on. Sending will proceed without it.",
    );
  });

  it("maps 404/405/501 to absent, 503 to held, 401/403 to denied", () => {
    expect(presendVerdictFailureNotice(withStatus(404)).kind).toBe("absent");
    expect(presendVerdictFailureNotice(withStatus(405)).kind).toBe("absent");
    expect(presendVerdictFailureNotice(withStatus(501)).kind).toBe("absent");
    expect(presendVerdictFailureNotice(withStatus(503)).kind).toBe("held");
    expect(presendVerdictFailureNotice(withStatus(401)).kind).toBe("denied");
    expect(presendVerdictFailureNotice(withStatus(403)).kind).toBe("denied");
  });

  it("everything else is a plain failure, and no notice ever claims to block", () => {
    expect(presendVerdictFailureNotice(withStatus(500)).kind).toBe("failed");
    expect(presendVerdictFailureNotice(new Error("network")).kind).toBe("failed");
    for (const status of [0, 401, 403, 404, 405, 500, 501, 502, 503]) {
      expect(presendVerdictFailureNotice(withStatus(status)).text).toMatch(
        /Sending will proceed without it\.$/,
      );
    }
  });
});

describe("presendVerdictStandingNotice", () => {
  it("names incompleteness — and only incompleteness", () => {
    expect(presendVerdictStandingNotice(readPresendVerdict(INCOMPLETE_WIRE))).toBe(
      "Not every check could run. This doesn't block sending — but don't read it as a pass.",
    );
    // A verdict that says ok but admits it is not complete is still not a pass.
    expect(presendVerdictStandingNotice(reading("ok", { complete: false }))).not.toBeNull();
    expect(presendVerdictStandingNotice(reading("ok"))).toBeNull();
    expect(presendVerdictStandingNotice(reading("warn"))).toBeNull();
    expect(presendVerdictStandingNotice(reading("critical"))).toBeNull();
    expect(presendVerdictStandingNotice(null)).toBeNull();
  });
});

describe("presendVerdictPillLabel / presendVerdictSpoken", () => {
  it("labels the four verdicts distinctly", () => {
    expect(presendVerdictPillLabel(reading("ok"))).toBe("Passed");
    expect(presendVerdictPillLabel(reading("warn"))).toBe("Review");
    expect(presendVerdictPillLabel(reading("critical"))).toBe("Critical");
    expect(presendVerdictPillLabel(reading("incomplete"))).toBe("Incomplete");
  });

  it("speaks the verdict, the server summary and every leg as one sentence", () => {
    const spoken = presendVerdictSpoken(readPresendVerdict(INCOMPLETE_WIRE));
    expect(spoken).toBe(
      "Pre-send verdict: Incomplete. Pre-send checks incomplete. Unavailable: voice_drift. EQ score 88/100 ok. Voice drift skipped. Placement 71/100 ok.",
    );
    expect(presendVerdictSpoken(null)).toBe("Pre-send verdict has not been run.");
  });
});
