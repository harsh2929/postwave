import { describe, expect, it } from "vitest";

import {
  parseAeoCompetitors,
  parseAeoProbes,
  parseAeoPrompts,
  parseAeoSummary,
} from "../../pages/aeo-summary-contract";

const summary = {
  settings: {
    enabled: false,
    brand_terms: ["Moosewave"],
    brand_domain: "moosewave.com",
    credentials_status: "missing",
  },
  latest_rollups: [],
  overall_mention_rate: 0,
  overall_citation_rate: 0,
  volatility_score: 0,
  ai_referral_pct: 0,
  competitor_board: [],
};

describe("AEO summary runtime contract", () => {
  it("accepts the renderer's required summary shape", () => {
    expect(parseAeoSummary(summary)).toEqual(summary);
  });

  it("rejects incomplete and non-finite successful payloads", () => {
    expect(parseAeoSummary({})).toBeNull();
    expect(parseAeoSummary({ ...summary, settings: {} })).toBeNull();
    expect(
      parseAeoSummary({ ...summary, volatility_score: Number.NaN }),
    ).toBeNull();
  });

  it("validates prompt, probe, and competitor collection envelopes", () => {
    const prompt = {
      id: "prompt-1",
      category: "discovery",
      prompt_text: "Best newsletter platform?",
      enabled: true,
      source: "custom",
      created_at: "2026-07-14T00:00:00Z",
      updated_at: "2026-07-14T00:00:00Z",
    };
    const probe = {
      id: 1,
      prompt_id: "prompt-1",
      engine: "chatgpt",
      response_text: "Moosewave",
      mentioned: true,
      cited: false,
      competitor_hits: {},
      latency_ms: 250,
      token_count: 30,
      status: "ok",
      probed_at: "2026-07-14T00:00:00Z",
    };
    const competitor = {
      competitor_key: "example",
      display_name: "Example",
      terms: ["Example"],
      domain: "example.com",
    };
    expect(parseAeoPrompts({ items: [prompt] })).toEqual([prompt]);
    expect(parseAeoProbes({ items: [probe] })).toEqual([probe]);
    expect(parseAeoCompetitors({ items: [competitor], max: 5 })).toEqual([
      competitor,
    ]);
  });

  it("rejects missing collection arrays and malformed rows", () => {
    expect(parseAeoPrompts({})).toBeNull();
    expect(parseAeoProbes({ items: [{}] })).toBeNull();
    expect(parseAeoCompetitors({ items: [{ terms: null }] })).toBeNull();
  });
});
