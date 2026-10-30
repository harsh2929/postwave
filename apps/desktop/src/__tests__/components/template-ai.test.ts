/**
 * template-ai — pure logic behind the Templates page "Generate with
 * AI" modal. Contracts under test:
 *
 *   - input validation mirrors the Go handler's rune-counted caps
 *     (generate brief ≤ 8000, adaptation instructions ≤ 4000,
 *     tone ≤ 500, brief required);
 *   - error copy is status-honest: 429 = AI quota (with retry-after
 *     when sent), 503 = LLM unconfigured on this deployment,
 *     timeout = 60s budget elapsed, else verbatim;
 *   - committed designs use deterministic, server-valid slugs.
 */

import { describe, expect, it } from "vitest";

import {
  TEMPLATE_GEN_BRIEF_MAX,
  TEMPLATE_GEN_TONE_MAX,
  aiTemplateSlug,
  buildTemplateDirection,
  describeTemplateGenError,
  reviewGeneratedTemplateDraft,
  runeCount,
  validateTemplateGenInput,
} from "../../components/templates/template-ai";

const SLUG_RE = /^[a-z][a-z0-9-]{0,79}$/;

describe("runeCount", () => {
  it("counts code points, not UTF-16 units", () => {
    expect(runeCount("abc")).toBe(3);
    // 🎉 is one rune but two UTF-16 units — Go's RuneCountInString
    // says 1, so we must too.
    expect("🎉".length).toBe(2);
    expect(runeCount("🎉")).toBe(1);
    expect(runeCount("")).toBe(0);
  });
});

describe("validateTemplateGenInput", () => {
  it("requires a non-blank brief", () => {
    expect(validateTemplateGenInput({ brief: "" })).toMatch(/describe/i);
    expect(validateTemplateGenInput({ brief: "   " })).toMatch(/describe/i);
  });

  it("accepts a brief at exactly the cap", () => {
    const brief = "a".repeat(TEMPLATE_GEN_BRIEF_MAX);
    expect(validateTemplateGenInput({ brief })).toBeNull();
  });

  it("rejects a brief over the cap — counted in runes", () => {
    // 8000 emoji = 16000 UTF-16 units but exactly 8000 runes → valid.
    const emojiBrief = "🎉".repeat(TEMPLATE_GEN_BRIEF_MAX);
    expect(validateTemplateGenInput({ brief: emojiBrief })).toBeNull();
    expect(validateTemplateGenInput({ brief: emojiBrief + "x" })).toMatch(
      /too long/i,
    );
  });

  it("rejects an over-long tone but allows the cap", () => {
    const brief = "monthly digest for runners";
    expect(
      validateTemplateGenInput({
        brief,
        tone: "t".repeat(TEMPLATE_GEN_TONE_MAX),
      }),
    ).toBeNull();
    expect(
      validateTemplateGenInput({
        brief,
        tone: "t".repeat(TEMPLATE_GEN_TONE_MAX + 1),
      }),
    ).toMatch(/tone is too long/i);
  });
});

describe("guided template direction", () => {
  it("builds one bounded, explicit instruction from the wizard fields", () => {
    const direction = buildTemplateDirection({
      brief: "Adapt the July newsletter.",
      audience: "Existing customers",
      keySections: "Opening\nUpdates\nCustomer story",
      cta: "Explore the release",
      fidelity: "layout",
      refinement: "Shorten the opening",
    });
    expect(direction).toContain("preserve the source's broad section order");
    expect(direction).toContain("Audience: Existing customers");
    expect(direction).toContain(
      "Key sections: Opening\nUpdates\nCustomer story",
    );
    expect(direction).toContain("Primary call to action: Explore the release");
    expect(direction).toContain("Next-version refinement: Shorten the opening");
  });

  it("surfaces heuristic accessibility, merge-tag, and compliance reminders", () => {
    const checks = reviewGeneratedTemplateDraft({
      body_html:
        '<p><img src="data:image/png;base64,AA">Hello {{first_name}} {{unknown_tag}}</p>',
      variables: { first_name: "Ada" },
      unresolved_variables: ["company"],
    });
    expect(checks.accessibility.join(" ")).toContain("may be missing alt text");
    expect(checks.accessibility.join(" ")).toContain("No heading");
    expect(checks.mergeTags.join(" ")).toContain(
      "Values are still needed for: company",
    );
    expect(checks.mergeTags.join(" ")).toContain("unknown_tag");
    expect(checks.compliance.join(" ")).toContain("unsubscribe");
    expect(checks.compliance.join(" ")).toContain("postal-address");
  });
});

describe("describeTemplateGenError", () => {
  it("429 → AI quota copy with rounded-up retry-after", () => {
    const msg = describeTemplateGenError({
      message: "daily AI budget exhausted",
      status: 429,
      retryAfterSeconds: 90.2,
    });
    expect(msg).toMatch(/quota/i);
    expect(msg).toContain("daily AI budget exhausted");
    expect(msg).toContain("~91s");
  });

  it("429 without retry-after still reads as quota, not outage", () => {
    const msg = describeTemplateGenError({
      message: "over quota",
      status: 429,
    });
    expect(msg).toMatch(/quota/i);
    expect(msg).toMatch(/try again later/i);
    expect(msg).not.toContain("~");
  });

  it("503 → unconfigured copy keeping the server reason", () => {
    const msg = describeTemplateGenError({
      message: "llm not configured",
      status: 503,
    });
    expect(msg).toMatch(/isn't configured on this server/i);
    expect(msg).toContain("llm not configured");
  });

  it("timeout kind → 60s budget copy", () => {
    const msg = describeTemplateGenError({
      message: "request timed out",
      kind: "timeout",
    });
    expect(msg).toMatch(/60 seconds/);
    expect(msg).toMatch(/no draft/i);
  });

  it("anything else keeps the verbatim message", () => {
    const msg = describeTemplateGenError({ message: "boom", status: 500 });
    expect(msg).toContain("boom");
  });
});

describe("aiTemplateSlug", () => {
  it("slugifies the name and appends the uniqueness suffix", () => {
    const slug = aiTemplateSlug("Spring Sale Announcement!", "m4k2x");
    expect(slug).toBe("spring-sale-announcement-m4k2x");
    expect(slug).toMatch(SLUG_RE);
  });

  it("falls back when the name slugifies to nothing", () => {
    const slug = aiTemplateSlug("🎉🎉🎉", "abc");
    expect(slug).toBe("ai-template-abc");
    expect(slug).toMatch(SLUG_RE);
  });

  it("prefixes names that slugify to a non-letter start", () => {
    const slug = aiTemplateSlug("2026 Roadmap", "z9");
    expect(slug).toBe("ai-2026-roadmap-z9");
    expect(slug).toMatch(SLUG_RE);
  });

  it("stays within the 80-char server cap, keeping the suffix intact", () => {
    const slug = aiTemplateSlug("very long name ".repeat(20), "suf123");
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith("-suf123")).toBe(true);
    expect(slug).toMatch(SLUG_RE);
  });
});
