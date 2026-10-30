// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from "vitest";

import {
  AUTH_PROTOCOL_INFO,
  assessSubject,
  extractLinks,
  isPlacementReportEmpty,
  isProviderMeasured,
  looksLikeHtml,
  normalizePredictedImpact,
  overallPlacementSummary,
  parseBlocklistHit,
  reputationSourceLabel,
  riskBand,
  riskFactorRows,
} from "@/lib/inbox-reality-helpers";
import type { RiskBreakdown } from "@/lib/inbox-reality-types";

describe("extractLinks", () => {
  it("pulls hrefs from anchors in document order", () => {
    expect(
      extractLinks(
        `<a href="https://a.example">x</a><p>y</p><a href='https://b.example'>z</a>`,
      ),
    ).toEqual(["https://a.example", "https://b.example"]);
  });

  it("dedupes repeated links and trims whitespace", () => {
    expect(
      extractLinks(
        `<a href="https://a.example">1</a><a href=" https://a.example ">2</a>`,
      ),
    ).toEqual(["https://a.example"]);
  });

  it("ignores empty hrefs and in-page anchors", () => {
    expect(extractLinks(`<a href="">a</a><a href="#top">b</a>`)).toEqual([]);
  });

  it("returns an empty array for non-HTML / empty input", () => {
    expect(extractLinks("")).toEqual([]);
    expect(extractLinks("just some plain text")).toEqual([]);
  });
});

describe("looksLikeHtml", () => {
  it("detects markup", () => {
    expect(looksLikeHtml("<p>hi</p>")).toBe(true);
    expect(looksLikeHtml("<div>")).toBe(true);
  });
  it("rejects plain text and empty", () => {
    expect(looksLikeHtml("hello world")).toBe(false);
    expect(looksLikeHtml("")).toBe(false);
    expect(looksLikeHtml("2 < 3 and 4 > 1")).toBe(false);
  });
});

describe("assessSubject", () => {
  it("flags an empty subject", () => {
    const a = assessSubject("   ");
    expect(a.band).toBe("empty");
    expect(a.tone).toBe("warn");
    expect(a.length).toBe(0);
  });
  it("rates an ideal-length subject", () => {
    const a = assessSubject("Your April edit is here — 5 stories inside");
    expect(a.band).toBe("ideal");
    expect(a.tone).toBe("ok");
  });
  it("warns on an over-long subject", () => {
    const a = assessSubject("x".repeat(75));
    expect(a.band).toBe("long");
    expect(a.tone).toBe("warn");
    expect(a.length).toBe(75);
  });
  it("marks a very short subject", () => {
    const a = assessSubject("Sale");
    expect(a.band).toBe("short");
  });
});

describe("overallPlacementSummary", () => {
  it("folds updates/social into primary and blocked/missing into spam", () => {
    expect(
      overallPlacementSummary({
        primary: 0.5,
        updates: 0.1,
        social: 0.05,
        promotions: 0.2,
        spam: 0.1,
        blocked: 0.03,
        missing: 0.02,
      }),
    ).toEqual({
      primary: 0.65,
      promotions: 0.2,
      spam: 0.15,
    });
  });
  it("treats missing buckets as zero", () => {
    expect(overallPlacementSummary({ primary: 0.62, promotions: 0.27, spam: 0.11 })).toEqual({
      primary: 0.62,
      promotions: 0.27,
      spam: 0.11,
    });
  });
});

describe("normalizePredictedImpact", () => {
  it("folds a projection record the same way as placement", () => {
    expect(
      normalizePredictedImpact({ primary: 0.85, promotions: 0.1, spam: 0.05 }),
    ).toEqual({ primary: 0.85, promotions: 0.1, spam: 0.05 });
  });
  it("guards null / non-finite values", () => {
    expect(normalizePredictedImpact(null)).toEqual({
      primary: 0,
      promotions: 0,
      spam: 0,
    });
    expect(
      normalizePredictedImpact({ primary: Number.NaN, spam: 0.2 }),
    ).toEqual({ primary: 0, promotions: 0, spam: 0.2 });
  });
});

describe("isPlacementReportEmpty", () => {
  it("is empty when there are no inboxes", () => {
    expect(
      isPlacementReportEmpty({ total_inboxes: 0, overall_pct: {} }),
    ).toBe(true);
  });
  it("is empty when the distribution is all zero", () => {
    expect(
      isPlacementReportEmpty({
        total_inboxes: 10,
        overall_pct: { primary: 0, spam: 0 },
      }),
    ).toBe(true);
  });
  it("is not empty with real data", () => {
    expect(
      isPlacementReportEmpty({
        total_inboxes: 10,
        overall_pct: { primary: 0.6, spam: 0.4 },
      }),
    ).toBe(false);
  });
});

describe("riskBand", () => {
  it("maps risk scores to bands (higher score = worse)", () => {
    expect(riskBand(0.1)).toBe("low");
    expect(riskBand(0.5)).toBe("medium");
    expect(riskBand(0.8)).toBe("high");
  });
  it("clamps out-of-range input", () => {
    expect(riskBand(-1)).toBe("low");
    expect(riskBand(5)).toBe("high");
  });
});

describe("riskFactorRows", () => {
  const risk: RiskBreakdown = {
    model: {
      name: "m",
      version: "v1",
      kind: "heuristic",
      source: "embedded",
      trained: false,
    },
    weights: { content: 0.4, reputation: 0.3, auth: 0.15, engagement: 0.15 },
    content: 0.18,
    reputation: 0.25,
    auth: 0.1,
    engagement: 0.5,
    combined: 0.237,
  };

  it("returns one row per factor with weight*score contributions", () => {
    const rows = riskFactorRows(risk);
    expect(rows.map((r) => r.key)).toEqual([
      "content",
      "reputation",
      "auth",
      "engagement",
    ]);
    const content = rows.find((r) => r.key === "content")!;
    expect(content.weight).toBe(0.4);
    expect(content.score).toBe(0.18);
    expect(content.contribution).toBeCloseTo(0.072, 6);
  });

  it("contributions sum to the combined score", () => {
    const rows = riskFactorRows(risk);
    const sum = rows.reduce((acc, r) => acc + r.contribution, 0);
    expect(sum).toBeCloseTo(risk.combined, 6);
  });
});

describe("isProviderMeasured", () => {
  it("distinguishes measured providers from untested ones", () => {
    expect(isProviderMeasured({ total: 8 })).toBe(true);
    expect(isProviderMeasured({ total: 0 })).toBe(false);
  });
});

describe("parseBlocklistHit", () => {
  it("maps a known zone to its delisting URL", () => {
    const hit = parseBlocklistHit("zen.spamhaus.org");
    expect(hit.delistingUrl).toContain("spamhaus");
    expect(hit.zone).toBe("zen.spamhaus.org");
    expect(hit.containsIp).toBe(false);
  });
  it("detects an IP in the listing", () => {
    const hit = parseBlocklistHit("203.0.113.5 listed on b.barracudacentral.org");
    expect(hit.containsIp).toBe(true);
    expect(hit.delistingUrl).toContain("barracuda");
  });
  it("returns null delisting for unknown zones", () => {
    expect(parseBlocklistHit("some.unknown.dnsbl").delistingUrl).toBeNull();
  });
});

describe("reputationSourceLabel", () => {
  it("humanizes known source keys and falls back gracefully", () => {
    expect(reputationSourceLabel("google_postmaster")).toBe("Google Postmaster");
    expect(reputationSourceLabel("senderscore")).toBe("SenderScore");
    expect(reputationSourceLabel("weird_source")).toBe("Weird source");
  });
});

describe("AUTH_PROTOCOL_INFO", () => {
  it("covers every protocol shown on the auth card", () => {
    for (const key of ["SPF", "DKIM", "DMARC", "BIMI", "PTR"] as const) {
      expect(AUTH_PROTOCOL_INFO[key].what.length).toBeGreaterThan(0);
      expect(AUTH_PROTOCOL_INFO[key].why.length).toBeGreaterThan(0);
    }
  });
});
