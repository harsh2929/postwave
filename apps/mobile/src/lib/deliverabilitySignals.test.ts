import { describe, expect, it } from "vitest";

import {
  blocklistTierLabel,
  blocklistTone,
  dnsMechanisms,
  gradeTone,
  indexByDomain,
  meterState,
  quietHoursState,
  scoreTone,
  severityRank,
  severityTone,
  sideSignalNotice,
  sortBySeverity,
  trendTone,
  writeFailureMessage,
} from "./deliverabilitySignals";

describe("writeFailureMessage", () => {
  it("turns a 429 into wait-guidance, not an apparent failure of the check", () => {
    expect(writeFailureMessage({ status: 429 }, "Verify failed")).toContain(
      "wait a minute",
    );
  });

  it("explains a permission failure instead of echoing the raw body", () => {
    expect(writeFailureMessage({ status: 403 }, "x")).toContain("role");
    expect(writeFailureMessage({ status: 401 }, "x")).toContain("session");
  });

  it("prefers the refusal message from an offline guard", () => {
    const offline = Object.assign(new Error("Reconnect and try again."), {
      code: "offline_write_refused",
    });
    expect(writeFailureMessage(offline, "x")).toBe("Reconnect and try again.");
  });

  it("falls back to the error message, then to the caller's fallback", () => {
    expect(writeFailureMessage(new Error("boom"), "fallback")).toBe("boom");
    expect(writeFailureMessage(new Error("  "), "fallback")).toBe("fallback");
    expect(writeFailureMessage(undefined, "fallback")).toBe("fallback");
  });
});

describe("scoreTone / gradeTone", () => {
  it("maps the score bands", () => {
    expect(scoreTone(97)).toBe("success");
    expect(scoreTone(80)).toBe("info");
    expect(scoreTone(60)).toBe("warning");
    expect(scoreTone(12)).toBe("danger");
  });

  it("never invents a tone for a missing or NaN score", () => {
    expect(scoreTone(undefined)).toBe("neutral");
    expect(scoreTone(Number.NaN)).toBe("neutral");
    expect(scoreTone("88")).toBe("neutral");
  });

  it("maps the server's word grades and stays neutral on the unknown", () => {
    expect(gradeTone("Excellent")).toBe("success");
    expect(gradeTone("good")).toBe("info");
    expect(gradeTone("Fair")).toBe("warning");
    expect(gradeTone("Critical")).toBe("danger");
    expect(gradeTone("wat")).toBe("neutral");
    expect(gradeTone(undefined)).toBe("neutral");
  });
});

describe("severity", () => {
  it("tones and ranks the hub's three severities", () => {
    expect(severityTone("critical")).toBe("danger");
    expect(severityTone("warn")).toBe("warning");
    expect(severityTone("info")).toBe("info");
    expect(severityTone(null)).toBe("neutral");
    expect(severityRank("critical")).toBeLessThan(severityRank("warn"));
    expect(severityRank("warn")).toBeLessThan(severityRank("info"));
    expect(severityRank("nonsense")).toBeGreaterThan(severityRank("info"));
  });

  it("sorts most severe first and is stable by title within a severity", () => {
    const sorted = sortBySeverity([
      { severity: "info", title: "b" },
      { severity: "critical", title: "z" },
      { severity: "warn", title: "b" },
      { severity: "warn", title: "a" },
    ]);
    expect(sorted.map((r) => r.title)).toEqual(["z", "a", "b", "b"]);
  });

  it("does not mutate its input", () => {
    const rows = [{ severity: "info" }, { severity: "critical" }];
    sortBySeverity(rows);
    expect(rows[0]?.severity).toBe("info");
  });
});

describe("trendTone", () => {
  it("flips meaning for metrics where lower is better", () => {
    expect(trendTone("up")).toBe("success");
    expect(trendTone("up", { higherIsBetter: false })).toBe("danger");
    expect(trendTone("down")).toBe("danger");
    expect(trendTone("down", { higherIsBetter: false })).toBe("success");
    expect(trendTone("flat")).toBe("neutral");
  });
});

describe("meterState", () => {
  it("returns a null fraction when there is no cap — uncapped is not zero", () => {
    expect(meterState(1200, null)).toEqual({
      fraction: null,
      tone: "neutral",
      percent: null,
    });
    expect(meterState(1200, 0).fraction).toBeNull();
    expect(meterState(1200, undefined).fraction).toBeNull();
  });

  it("uses desktop's 60 / 90 thresholds", () => {
    expect(meterState(100, 1000).tone).toBe("success");
    expect(meterState(600, 1000).tone).toBe("warning");
    expect(meterState(899, 1000).tone).toBe("warning");
    expect(meterState(900, 1000).tone).toBe("danger");
  });

  it("clamps an over-cap bucket rather than overflowing the bar", () => {
    const over = meterState(5000, 1000);
    expect(over.fraction).toBe(1);
    expect(over.percent).toBe(100);
    expect(over.tone).toBe("danger");
  });

  it("treats a negative or non-numeric bucket as zero used", () => {
    expect(meterState(-5, 1000).percent).toBe(0);
    expect(meterState("many", 1000).percent).toBe(0);
  });
});

describe("quietHoursState", () => {
  it("keeps 'unknown' distinct from 'not in quiet hours'", () => {
    const unknown = quietHoursState(undefined, {
      start: "22:00",
      end: "07:00",
    });
    expect(unknown.active).toBeNull();
    expect(unknown.tone).toBe("neutral");
    expect(unknown.label).toContain("22:00–07:00");
  });

  it("reports the paused state with a warning tone", () => {
    const paused = quietHoursState(true, { start: "22:00", end: "07:00" });
    expect(paused.active).toBe(true);
    expect(paused.tone).toBe("warning");
    expect(paused.label).toContain("Paused");
  });

  it("reports the sending state and copes with no configured window", () => {
    expect(quietHoursState(false).tone).toBe("success");
    expect(quietHoursState(false).label).toBe("Sending");
    expect(quietHoursState(undefined).label).toBe("No quiet hours");
  });
});

describe("dnsMechanisms", () => {
  it("reads per-mechanism verified-at timestamps, not a single boolean", () => {
    const mechanisms = dnsMechanisms({
      domain: "mail.acme.com",
      dkim_verified_at: "2026-07-01T00:00:00Z",
      spf_verified_at: "",
      dmarc_verified_at: null,
    });
    expect(mechanisms.map((m) => [m.key, m.ok])).toEqual([
      ["SPF", false],
      ["DKIM", true],
      ["DMARC", false],
    ]);
  });

  it("always carries a spoken label so a colour is never the only signal", () => {
    for (const mechanism of dnsMechanisms(undefined)) {
      expect(mechanism.accessibilityLabel).toMatch(/missing$/);
      expect(mechanism.tone).toBe("danger");
    }
  });
});

describe("indexByDomain", () => {
  it("lowercases the key and drops rows with no domain", () => {
    const index = indexByDomain([
      { domain: "MAIL.Acme.com", score: 1 },
      { domain: "  ", score: 2 },
      { score: 3 },
    ] as { domain?: string; score: number }[]);
    expect(Object.keys(index)).toEqual(["mail.acme.com"]);
    expect(index["mail.acme.com"]?.score).toBe(1);
  });

  it("returns an empty index rather than throwing on undefined", () => {
    expect(indexByDomain(undefined)).toEqual({});
  });
});

describe("blocklist + side-signal notices", () => {
  it("labels and tones the tiers", () => {
    expect(blocklistTierLabel(true)).toBe("Tier 1");
    expect(blocklistTierLabel(false)).toBe("Tier 2");
    expect(blocklistTone(true)).toBe("danger");
    expect(blocklistTone(undefined)).toBe("warning");
  });

  it("says nothing when the side fetch succeeded", () => {
    expect(sideSignalNotice("DNS health", false, false)).toBeNull();
  });

  it("distinguishes an offline miss from a failure", () => {
    expect(sideSignalNotice("DNS health", true, true)).toContain("offline");
    expect(sideSignalNotice("DNS health", true, false)).toContain("couldn't");
  });
});
