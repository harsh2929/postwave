// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// AEO Sensor client (analytics-1..10 parity).
//
// Two halves. The parsers are held to the desktop contract
// (apps/desktop/src/pages/aeo-summary-contract.ts): the recorded shapes pass,
// and every field the contract names rejects when broken — a parser that only
// accepts is not a contract. The transport is asserted at global fetch —
// method, path, query and JSON body — because a parser test plus a
// mocked-hook test leaves the api function itself uncovered.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AeoContractError,
  createAeoPrompt,
  deleteAeoCompetitor,
  deleteAeoPrompt,
  getAeoSummary,
  isAeoContractError,
  listAeoCompetitors,
  listAeoProbes,
  listAeoPrompts,
  parseAeoCompetitorList,
  parseAeoCompetitors,
  parseAeoProbes,
  parseAeoPrompts,
  parseAeoRunNow,
  parseAeoSummary,
  putAeoSettings,
  runAeoNow,
  toggleAeoPrompt,
  upsertAeoCompetitor,
} from "@/lib/aeo-api";

/* ---------- fixtures: the shapes handlers.go answers with ------------- */

const ROLLUP = {
  engine: "chatgpt",
  day: "2026-09-11",
  mention_rate: 0.4235,
  citation_rate: 0.1,
  volatility_score: 12.34,
  ai_referral_pct: 0.05,
  sample_size: 40,
  computed_at: "2026-09-11T06:00:00Z",
};

const SETTINGS = {
  enabled: true,
  brand_terms: ["Moosewave", "postwave"],
  brand_domain: "moosewave.com",
  probe_prompt_pack: "starter",
  probe_interval_hours: 24,
  engines: [
    { key: "chatgpt", enabled: true },
    { key: "gemini", enabled: true },
    { key: "perplexity", enabled: false },
  ],
  volatility_window_days: 14,
  credentials_status: "partial",
};

const SUMMARY = {
  settings: SETTINGS,
  latest_rollups: [ROLLUP, { ...ROLLUP, engine: "gemini", mention_rate: 0.2 }],
  overall_mention_rate: 0.4235,
  overall_citation_rate: 0.1,
  volatility_score: 12.34,
  ai_referral_pct: 0.05,
  competitor_board: [
    { key: "acme", display_name: "Acme Mail", mention_rate: 0.25, domain: "acme.com" },
  ],
  warning_banner:
    "AEO Sensor is disabled. Enable it in Settings to start tracking ChatGPT / Gemini / Perplexity citations.",
};

const PROMPT = {
  id: "p1",
  category: "discovery",
  prompt_text: "Best email marketing platform for ecommerce?",
  enabled: true,
  source: "starter",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

const PROBE = {
  id: 101,
  prompt_id: "p1",
  engine: "chatgpt",
  response_text: "Moosewave is one option…",
  mentioned: true,
  cited: false,
  competitor_hits: { acme: 1 },
  latency_ms: 812,
  token_count: 210,
  status: "ok",
  probed_at: "2026-09-11T05:59:00Z",
};

const COMPETITOR = {
  id: "c1",
  competitor_key: "acme",
  display_name: "Acme Mail",
  terms: ["Acme", "AcmeMail"],
  domain: "acme.com",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
};

function without<T extends Record<string, unknown>>(obj: T, key: keyof T): Omit<T, keyof T> {
  const copy: Record<string, unknown> = { ...obj };
  delete copy[key as string];
  return copy as Omit<T, keyof T>;
}

/* ---------- parsers ------------------------------------------------- */

describe("parseAeoSummary", () => {
  it("accepts the desktop fixture shape, banner included", () => {
    const parsed = parseAeoSummary(SUMMARY);
    expect(parsed).not.toBeNull();
    expect(parsed?.warning_banner).toBe(SUMMARY.warning_banner);
    expect(parsed?.latest_rollups).toHaveLength(2);
  });

  it("accepts a summary with no banner (the populated case)", () => {
    expect(parseAeoSummary(without(SUMMARY, "warning_banner"))).not.toBeNull();
  });

  it.each<[string, unknown]>([
    ["not an object", "nope"],
    ["null", null],
    ["array", []],
    ["settings missing", without(SUMMARY, "settings")],
    ["settings.enabled not boolean", { ...SUMMARY, settings: { ...SETTINGS, enabled: "yes" } }],
    ["settings.brand_domain not string", { ...SUMMARY, settings: { ...SETTINGS, brand_domain: 7 } }],
    ["settings.brand_terms not array", { ...SUMMARY, settings: { ...SETTINGS, brand_terms: "a,b" } }],
    ["settings.brand_terms has non-string", { ...SUMMARY, settings: { ...SETTINGS, brand_terms: ["a", 1] } }],
    ["settings.credentials_status unknown", { ...SUMMARY, settings: { ...SETTINGS, credentials_status: "ok" } }],
    ["latest_rollups not array", { ...SUMMARY, latest_rollups: {} }],
    ["rollup engine unknown", { ...SUMMARY, latest_rollups: [{ ...ROLLUP, engine: "bing" }] }],
    ["rollup mention_rate NaN", { ...SUMMARY, latest_rollups: [{ ...ROLLUP, mention_rate: Number.NaN }] }],
    ["rollup sample_size string", { ...SUMMARY, latest_rollups: [{ ...ROLLUP, sample_size: "40" }] }],
    ["rollup computed_at missing", { ...SUMMARY, latest_rollups: [without(ROLLUP, "computed_at")] }],
    ["competitor_board not array", { ...SUMMARY, competitor_board: null }],
    ["competitor score key missing", { ...SUMMARY, competitor_board: [{ display_name: "x", mention_rate: 0 }] }],
    ["competitor score mention_rate string", { ...SUMMARY, competitor_board: [{ key: "a", display_name: "x", mention_rate: "0" }] }],
    ["competitor score domain not string", { ...SUMMARY, competitor_board: [{ key: "a", display_name: "x", mention_rate: 0, domain: 1 }] }],
    ["overall_mention_rate string", { ...SUMMARY, overall_mention_rate: "0.4" }],
    ["overall_citation_rate missing", without(SUMMARY, "overall_citation_rate")],
    ["volatility_score Infinity", { ...SUMMARY, volatility_score: Number.POSITIVE_INFINITY }],
    ["ai_referral_pct null", { ...SUMMARY, ai_referral_pct: null }],
    ["warning_banner not string", { ...SUMMARY, warning_banner: 1 }],
  ])("rejects %s", (_label, value) => {
    expect(parseAeoSummary(value)).toBeNull();
  });
});

describe("parseAeoPrompts", () => {
  it("accepts the fixture envelope", () => {
    expect(parseAeoPrompts({ items: [PROMPT] })).toEqual([PROMPT]);
  });

  it.each<[string, unknown]>([
    ["bare array", [PROMPT]],
    ["items not array", { items: PROMPT }],
    ["id not string", { items: [{ ...PROMPT, id: 1 }] }],
    ["category unknown", { items: [{ ...PROMPT, category: "sales" }] }],
    ["prompt_text missing", { items: [without(PROMPT, "prompt_text")] }],
    ["enabled not boolean", { items: [{ ...PROMPT, enabled: "true" }] }],
    ["source unknown", { items: [{ ...PROMPT, source: "imported" }] }],
    ["created_at missing", { items: [without(PROMPT, "created_at")] }],
    ["updated_at not string", { items: [{ ...PROMPT, updated_at: 0 }] }],
    ["one bad row poisons the list", { items: [PROMPT, { ...PROMPT, id: 2 }] }],
  ])("rejects %s", (_label, value) => {
    expect(parseAeoPrompts(value)).toBeNull();
  });
});

describe("parseAeoProbes", () => {
  it("accepts the fixture envelope", () => {
    expect(parseAeoProbes({ items: [PROBE] })).toEqual([PROBE]);
  });

  it.each<[string, unknown]>([
    ["id not number", { items: [{ ...PROBE, id: "101" }] }],
    ["prompt_id missing", { items: [without(PROBE, "prompt_id")] }],
    ["engine unknown", { items: [{ ...PROBE, engine: "claude" }] }],
    ["response_text not string", { items: [{ ...PROBE, response_text: null }] }],
    ["mentioned not boolean", { items: [{ ...PROBE, mentioned: 1 }] }],
    ["cited not boolean", { items: [{ ...PROBE, cited: "no" }] }],
    ["competitor_hits not object", { items: [{ ...PROBE, competitor_hits: [] }] }],
    ["competitor_hits value not number", { items: [{ ...PROBE, competitor_hits: { acme: "1" } }] }],
    ["latency_ms NaN", { items: [{ ...PROBE, latency_ms: Number.NaN }] }],
    ["token_count missing", { items: [without(PROBE, "token_count")] }],
    ["status unknown", { items: [{ ...PROBE, status: "timeout" }] }],
    ["probed_at missing", { items: [without(PROBE, "probed_at")] }],
  ])("rejects %s", (_label, value) => {
    expect(parseAeoProbes(value)).toBeNull();
  });
});

describe("parseAeoCompetitors / parseAeoCompetitorList", () => {
  it("accepts the fixture envelope and reads the cap", () => {
    expect(parseAeoCompetitors({ items: [COMPETITOR], max: 5 })).toEqual([COMPETITOR]);
    expect(parseAeoCompetitorList({ items: [COMPETITOR], max: 5 })).toEqual({
      items: [COMPETITOR],
      max: 5,
    });
    expect(parseAeoCompetitorList({ items: [], max: 5 })).toEqual({ items: [], max: 5 });
  });

  it.each<[string, unknown]>([
    ["competitor_key missing", { items: [without(COMPETITOR, "competitor_key")], max: 5 }],
    ["display_name not string", { items: [{ ...COMPETITOR, display_name: 1 }], max: 5 }],
    ["terms not array", { items: [{ ...COMPETITOR, terms: "a" }], max: 5 }],
    ["terms has non-string", { items: [{ ...COMPETITOR, terms: [1] }], max: 5 }],
    ["domain missing", { items: [without(COMPETITOR, "domain")], max: 5 }],
    ["id not string", { items: [{ ...COMPETITOR, id: 1 }], max: 5 }],
    ["created_at not string", { items: [{ ...COMPETITOR, created_at: 0 }], max: 5 }],
    ["updated_at not string", { items: [{ ...COMPETITOR, updated_at: 0 }], max: 5 }],
  ])("rejects %s", (_label, value) => {
    expect(parseAeoCompetitors(value)).toBeNull();
    expect(parseAeoCompetitorList(value)).toBeNull();
  });

  it("the list envelope also requires a finite max", () => {
    expect(parseAeoCompetitorList({ items: [COMPETITOR] })).toBeNull();
    expect(parseAeoCompetitorList({ items: [COMPETITOR], max: "5" })).toBeNull();
  });
});

describe("parseAeoRunNow", () => {
  it("accepts {probes, rollups}", () => {
    expect(parseAeoRunNow({ probes: 12, rollups: [ROLLUP] })).toEqual({
      probes: 12,
      rollups: [ROLLUP],
    });
    expect(parseAeoRunNow({ probes: 0, rollups: [] })).toEqual({ probes: 0, rollups: [] });
  });

  it.each<[string, unknown]>([
    ["probes missing", { rollups: [] }],
    ["probes string", { probes: "12", rollups: [] }],
    ["rollups missing", { probes: 12 }],
    ["rollups has bad row", { probes: 12, rollups: [{ ...ROLLUP, day: 1 }] }],
  ])("rejects %s", (_label, value) => {
    expect(parseAeoRunNow(value)).toBeNull();
  });
});

/* ---------- transport ----------------------------------------------- */

interface Sent {
  method: string;
  path: string;
  query: string;
  body: unknown;
}

function stubFetch(reply: unknown, status = 200): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const url = new URL(raw, "http://localhost");
      let body: unknown;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      sent.push({
        method: (init?.method ?? "GET").toUpperCase(),
        path: url.pathname,
        query: url.search,
        body,
      });
      return new Response(JSON.stringify(reply), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("aeo transport — request shapes at global fetch", () => {
  it("GET /api/v1/aeo/summary parses the summary", async () => {
    const sent = stubFetch(SUMMARY);
    const out = await getAeoSummary();
    expect(sent).toEqual([{ method: "GET", path: "/api/v1/aeo/summary", query: "", body: undefined }]);
    expect(out.overall_mention_rate).toBe(0.4235);
  });

  it("GET /api/v1/aeo/prompts unwraps items", async () => {
    const sent = stubFetch({ items: [PROMPT] });
    expect(await listAeoPrompts()).toEqual([PROMPT]);
    expect(sent[0]).toMatchObject({ method: "GET", path: "/api/v1/aeo/prompts" });
  });

  it("GET /api/v1/aeo/probes?limit=50 unwraps items", async () => {
    const sent = stubFetch({ items: [PROBE] });
    expect(await listAeoProbes(50)).toEqual([PROBE]);
    expect(sent[0]).toMatchObject({ method: "GET", path: "/api/v1/aeo/probes", query: "?limit=50" });
  });

  it("GET /api/v1/aeo/competitors keeps items and max", async () => {
    const sent = stubFetch({ items: [COMPETITOR], max: 5 });
    expect(await listAeoCompetitors()).toEqual({ items: [COMPETITOR], max: 5 });
    expect(sent[0]).toMatchObject({ method: "GET", path: "/api/v1/aeo/competitors" });
  });

  it("PUT /api/v1/aeo/settings sends the partial settings object as-is", async () => {
    const sent = stubFetch(SETTINGS);
    const input = { enabled: true, brand_domain: "moosewave.com", brand_terms: ["Moosewave"] };
    await putAeoSettings(input);
    expect(sent).toEqual([{ method: "PUT", path: "/api/v1/aeo/settings", query: "", body: input }]);
  });

  it("PUT /api/v1/aeo/competitors upserts by competitor_key", async () => {
    const sent = stubFetch(COMPETITOR);
    const input = { competitor_key: "acme", display_name: "Acme Mail", terms: ["Acme"], domain: "acme.com" };
    await upsertAeoCompetitor(input);
    expect(sent).toEqual([{ method: "PUT", path: "/api/v1/aeo/competitors", query: "", body: input }]);
  });

  it("DELETE /api/v1/aeo/competitors/{key} encodes the key", async () => {
    const sent = stubFetch({ ok: true });
    await deleteAeoCompetitor("acme mail/x");
    expect(sent[0]).toMatchObject({ method: "DELETE", path: "/api/v1/aeo/competitors/acme%20mail%2Fx" });
  });

  it("POST /api/v1/aeo/prompts sends {category, prompt_text}", async () => {
    const sent = stubFetch(PROMPT);
    await createAeoPrompt({ category: "comparison", prompt_text: "Moosewave vs Acme?" });
    expect(sent).toEqual([
      {
        method: "POST",
        path: "/api/v1/aeo/prompts",
        query: "",
        body: { category: "comparison", prompt_text: "Moosewave vs Acme?" },
      },
    ]);
  });

  it("POST /api/v1/aeo/prompts/{id}/toggle sends {enabled}", async () => {
    const sent = stubFetch({ ok: true });
    await toggleAeoPrompt("p 1", false);
    expect(sent).toEqual([
      { method: "POST", path: "/api/v1/aeo/prompts/p%201/toggle", query: "", body: { enabled: false } },
    ]);
  });

  it("DELETE /api/v1/aeo/prompts/{id}", async () => {
    const sent = stubFetch({ ok: true });
    await deleteAeoPrompt("p1");
    expect(sent[0]).toMatchObject({ method: "DELETE", path: "/api/v1/aeo/prompts/p1" });
  });

  it("POST /api/v1/aeo/run-now sends {} and parses {probes, rollups}", async () => {
    const sent = stubFetch({ probes: 12, rollups: [ROLLUP] });
    const out = await runAeoNow();
    expect(sent).toEqual([{ method: "POST", path: "/api/v1/aeo/run-now", query: "", body: {} }]);
    expect(out).toEqual({ probes: 12, rollups: [ROLLUP] });
  });
});

describe("aeo transport — contract failures are errors, never empty data", () => {
  it("a 200 with a malformed summary throws AeoContractError, not an empty summary", async () => {
    stubFetch({ ...SUMMARY, overall_mention_rate: "0.4" });
    await expect(getAeoSummary()).rejects.toBeInstanceOf(AeoContractError);
    await expect(getAeoSummary()).rejects.toThrow("AEO summary response was malformed.");
  });

  it("a bare array of prompts is a contract error (the envelope is the contract)", async () => {
    stubFetch([PROMPT]);
    await expect(listAeoPrompts()).rejects.toThrow("AEO prompts response was malformed.");
  });

  it("a probe list with one bad row is a contract error", async () => {
    stubFetch({ items: [PROBE, { ...PROBE, status: "meh" }] });
    await expect(listAeoProbes(50)).rejects.toThrow("AEO probes response was malformed.");
  });

  it("a competitor list without max is a contract error", async () => {
    stubFetch({ items: [COMPETITOR] });
    await expect(listAeoCompetitors()).rejects.toThrow("AEO competitors response was malformed.");
  });

  it("a run-now reply without rollups is a contract error", async () => {
    stubFetch({ probes: 3 });
    const err = await runAeoNow().catch((e: unknown) => e);
    expect(isAeoContractError(err)).toBe(true);
    expect((err as AeoContractError).surface).toBe("run-now");
  });
});
