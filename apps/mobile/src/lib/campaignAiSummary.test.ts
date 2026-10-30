import { describe, expect, it } from "vitest";

import {
  parseSummaryMarkdown,
  parseSummarySpans,
  readCampaignSummary,
  summaryPlainText,
  SUMMARY_MAX_BLOCKS,
  SUMMARY_MAX_CHARS,
} from "./campaignAiSummary";

describe("readCampaignSummary", () => {
  it("reports no body for absent / malformed payloads", () => {
    for (const body of [null, undefined, {}, { body_markdown: 42 }]) {
      expect(readCampaignSummary(body).hasBody).toBe(false);
    }
  });

  it("keeps the source distinction the AI disclosure depends on", () => {
    expect(readCampaignSummary({ source: "voice" }).source).toBe("voice");
    expect(readCampaignSummary({ source: "deterministic" }).source).toBe(
      "deterministic",
    );
    // Anything unrecognised must NOT be reported as model-generated.
    expect(readCampaignSummary({ source: "wat" }).source).toBe("deterministic");
    expect(readCampaignSummary({}).source).toBe("deterministic");
  });

  it("parses the RFC3339 timestamp Go marshals, and tolerates junk", () => {
    expect(
      readCampaignSummary({ generated_at: "2026-07-01T09:00:00Z" }).generatedAt,
    ).toBe(Date.parse("2026-07-01T09:00:00Z"));
    expect(readCampaignSummary({ generated_at: "nope" }).generatedAt).toBeNull();
    expect(readCampaignSummary({ generated_at: {} }).generatedAt).toBeNull();
  });

  it("bounds a pathological body instead of handing it to the renderer", () => {
    const huge = "x".repeat(SUMMARY_MAX_CHARS + 500);
    const r = readCampaignSummary({ body_markdown: huge });
    expect(r.markdown.length).toBe(SUMMARY_MAX_CHARS + 1); // + the ellipsis
    expect(r.markdown.endsWith("…")).toBe(true);
  });
});

describe("parseSummarySpans", () => {
  it("splits the bold runs the deterministic renderer emits", () => {
    expect(parseSummarySpans("Open rate **41.2%** — strong.")).toEqual([
      { text: "Open rate ", bold: false, code: false },
      { text: "41.2%", bold: true, code: false },
      { text: " — strong.", bold: false, code: false },
    ]);
  });

  it("splits backticked link URLs", () => {
    const spans = parseSummarySpans("top link `https://a.example/x` carried");
    expect(spans[1]).toEqual({
      text: "https://a.example/x",
      bold: false,
      code: true,
    });
  });

  it("emits an UNCLOSED delimiter as literal text, not as a swallowed rest", () => {
    // The classic hand-rolled-Markdown failure: `indexOf` misses, and the
    // parser eats everything to the end of the paragraph.
    expect(parseSummarySpans("a ** b")).toEqual([
      { text: "a ** b", bold: false, code: false },
    ]);
    expect(parseSummarySpans("a ` b")).toEqual([
      { text: "a ` b", bold: false, code: false },
    ]);
  });

  it("treats an empty delimiter pair as literal", () => {
    expect(parseSummarySpans("a **** b")).toEqual([
      { text: "a **** b", bold: false, code: false },
    ]);
  });
});

describe("parseSummaryMarkdown", () => {
  it("is empty for empty input", () => {
    expect(parseSummaryMarkdown("")).toEqual([]);
    expect(parseSummaryMarkdown("   \n\n  ")).toEqual([]);
  });

  it("splits the real deterministic shape into paragraphs", () => {
    const md =
      "Open rate **41.2%** — **+3.1 pp vs 38.1% baseline**. Strong send." +
      "\n\nClick rate **6.0%**." +
      "\n\nSuggested next: Resend to non-openers in 48h.";
    const blocks = parseSummaryMarkdown(md);
    expect(blocks).toHaveLength(3);
    expect(blocks.every((b) => b.kind === "paragraph")).toBe(true);
    expect(blocks[2]?.spans[0]?.text).toContain("Suggested next");
  });

  it("recognises the bullets the voice path may add", () => {
    const blocks = parseSummaryMarkdown("Header\n\n- one **two**\n* three");
    expect(blocks.map((b) => b.kind)).toEqual([
      "paragraph",
      "bullet",
      "bullet",
    ]);
    expect(blocks[1]?.spans[0]?.text).toBe("one ");
    expect(blocks[1]?.spans[1]).toEqual({
      text: "two",
      bold: true,
      code: false,
    });
  });

  it("caps block count so a runaway model body cannot stall the render", () => {
    const md = Array.from({ length: SUMMARY_MAX_BLOCKS + 25 }, (_, i) => `p${i}`)
      .join("\n\n");
    expect(parseSummaryMarkdown(md)).toHaveLength(SUMMARY_MAX_BLOCKS);
  });
});

describe("summaryPlainText", () => {
  it("gives a screen reader the sentence, not the asterisks", () => {
    const blocks = parseSummaryMarkdown("Open rate **41.2%**.\n\n- next step");
    expect(summaryPlainText(blocks)).toBe("Open rate 41.2%. next step");
  });
});
