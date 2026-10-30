/**
 * subject-analyzer-helpers — coverage for the bucket grouping and the
 * attribute explanation behind SubjectLab / SubjectLineAssistant
 * (full-surface wiring #8).
 *
 * The bucket attribute keys mirror apps/api/internal/subject_analyzer
 * exactly: length / has_question / has_personalize / has_emoji /
 * all_caps, with boolean buckets serialized "yes"/"no".
 */

import { describe, expect, it } from "vitest";

import type { SubjectAttrs, SubjectBucket } from "../../lib/api-client";
import {
  bucketAttributeLabel,
  bucketValueLabel,
  explainSubjectAttributes,
  formatRate,
  groupSubjectBuckets,
  scoreSummaryLine,
} from "../../components/subject-analyzer-helpers";

const attrs = (over: Partial<SubjectAttrs> = {}): SubjectAttrs => ({
  length: 42,
  length_bucket: "medium",
  word_count: 7,
  emoji_count: 0,
  has_question: false,
  has_personalize: false,
  uppercase_ratio: 0.1,
  all_caps: false,
  ...over,
});

describe("explainSubjectAttributes", () => {
  it("describes the neutral case factually", () => {
    expect(explainSubjectAttributes(attrs())).toEqual([
      "42 characters (medium)",
      "7 words",
      "No emoji",
      "No question",
      "No personalization",
    ]);
  });

  it("flips each line when the attribute is present", () => {
    const lines = explainSubjectAttributes(
      attrs({
        word_count: 1,
        emoji_count: 2,
        has_question: true,
        has_personalize: true,
        all_caps: true,
      }),
    );
    expect(lines).toContain("1 word");
    expect(lines).toContain("2 emoji");
    expect(lines).toContain("Asks a question");
    expect(lines).toContain("Uses personalization");
    expect(lines).toContain("ALL CAPS");
  });
});

describe("groupSubjectBuckets", () => {
  const bucket = (
    attribute: string,
    bucketVal: string,
    campaigns: number,
  ): SubjectBucket => ({
    attribute,
    bucket: bucketVal,
    campaigns,
    open_rate: 0.4,
    click_rate: 0.05,
  });

  it("groups in canonical attribute order and sorts rows by campaigns desc", () => {
    const groups = groupSubjectBuckets([
      bucket("has_emoji", "no", 10),
      bucket("length", "short", 3),
      bucket("length", "medium", 8),
      bucket("has_emoji", "yes", 2),
    ]);
    expect(groups.map((g) => g.attribute)).toEqual(["length", "has_emoji"]);
    expect(groups[0]!.rows.map((r) => r.bucket)).toEqual(["medium", "short"]);
    expect(groups[1]!.label).toBe("Emoji");
  });

  it("keeps unknown attributes (forward compat) after the known set", () => {
    const groups = groupSubjectBuckets([
      bucket("brand_voice", "calm", 1),
      bucket("length", "long", 2),
    ]);
    expect(groups.map((g) => g.attribute)).toEqual(["length", "brand_voice"]);
    expect(groups[1]!.label).toBe("brand_voice"); // honest passthrough
  });

  it("drops empty groups entirely", () => {
    expect(groupSubjectBuckets([])).toEqual([]);
  });
});

describe("labels and formatting", () => {
  it("maps yes/no buckets to Yes/No and passes length buckets through", () => {
    expect(bucketValueLabel("yes")).toBe("Yes");
    expect(bucketValueLabel("no")).toBe("No");
    expect(bucketValueLabel("short")).toBe("short");
  });

  it("formats rates as one-decimal percentages", () => {
    expect(formatRate(0.421)).toBe("42.1%");
    expect(formatRate(0.4567)).toBe("45.7%");
    expect(formatRate(0)).toBe("0.0%");
  });

  it("attribute labels cover the Go rollup keys", () => {
    expect(bucketAttributeLabel("has_personalize")).toBe("Personalization");
    expect(bucketAttributeLabel("all_caps")).toBe("ALL CAPS");
    expect(bucketAttributeLabel("mystery")).toBe("mystery");
  });
});

describe("scoreSummaryLine", () => {
  it("renders the projection with the matched-history sample", () => {
    expect(
      scoreSummaryLine({
        subject: "Hello there friends",
        attributes: attrs(),
        expected_open: 0.412,
        expected_click: 0.051,
        matched_history: 12,
        suggestions: [],
      }),
    ).toBe("~41.2% open · ~5.1% click · matched 12 campaigns");
  });

  it("singularizes a single matched campaign", () => {
    expect(
      scoreSummaryLine({
        subject: "x",
        attributes: attrs(),
        expected_open: 0.1,
        expected_click: 0.01,
        matched_history: 1,
        suggestions: [],
      }),
    ).toMatch(/matched 1 campaign$/);
  });

  it("is honest when no history matched", () => {
    expect(
      scoreSummaryLine({
        subject: "x",
        attributes: attrs(),
        expected_open: 0,
        expected_click: 0,
        matched_history: 0,
        suggestions: [],
      }),
    ).toBe("No matching history — projection unavailable");
  });
});
