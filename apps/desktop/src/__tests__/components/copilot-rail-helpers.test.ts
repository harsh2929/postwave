/**
 * copilot-rail-helpers — pure logic behind composer/CopilotRail.tsx.
 *
 * High-stakes invariants:
 *   1. The status palette mirrors ai/PresendCheckPanel exactly —
 *      ok=accent / warn=warning / critical=danger; error/skipped/
 *      unknown render MUTED (an unavailable check is an absence, not
 *      a failure of the draft).
 *   2. Score normalisation matches the panel: >1 renders as-is,
 *      ≤1 renders ×100, absent → em dash.
 *   3. verdictReadiness blocks the Run button with an actionable
 *      reason for every missing required field (subject/from/body),
 *      mirroring POST /presend/verdict's input contract.
 *   4. The Subject Lab seed gate is 10 chars (SubjectLab's own
 *      Generate threshold) so the rail's hint never contradicts the
 *      Lab's behaviour.
 */

import { describe, expect, it } from "vitest";

import {
  RAIL_SECTIONS,
  SUBJECT_LAB_MIN_SEED,
  componentDisplayName,
  formatComponentScore,
  presendStatusColor,
  presendStatusLabel,
  subjectLabSeedReady,
  verdictReadiness,
} from "../../components/composer/copilot-rail-helpers";

describe("RAIL_SECTIONS", () => {
  it("covers the four mandated sections in order", () => {
    expect(RAIL_SECTIONS.map((s) => s.id)).toEqual([
      "verdict",
      "subject",
      "voice",
      "inbox",
    ]);
  });
});

describe("presendStatusColor", () => {
  it("mirrors PresendCheckPanel's palette", () => {
    expect(presendStatusColor("ok")).toBe("var(--pw-accent)");
    expect(presendStatusColor("warn")).toBe("var(--pw-warning)");
    expect(presendStatusColor("critical")).toBe("var(--pw-danger)");
  });

  it("error / skipped / unknown render muted, not red", () => {
    expect(presendStatusColor("error")).toBe("var(--pw-fg-muted)");
    expect(presendStatusColor("skipped")).toBe("var(--pw-fg-muted)");
    expect(presendStatusColor(undefined)).toBe("var(--pw-fg-muted)");
  });
});

describe("presendStatusLabel", () => {
  it("labels the full PresendComponent status set", () => {
    expect(presendStatusLabel("ok")).toBe("Passing");
    expect(presendStatusLabel("warn")).toBe("Caution");
    expect(presendStatusLabel("critical")).toBe("Failing");
    expect(presendStatusLabel("error")).toBe("Error");
    expect(presendStatusLabel("skipped")).toBe("Skipped");
    expect(presendStatusLabel(undefined)).toBe("Unknown");
  });
});

describe("componentDisplayName", () => {
  it("maps the three wire component names", () => {
    expect(componentDisplayName("eq_score")).toBe("EQ Score");
    expect(componentDisplayName("voice_drift")).toBe("Voice drift");
    expect(componentDisplayName("placement")).toBe("Placement");
    expect(componentDisplayName("campaign_assurance")).toBe(
      "Campaign Assurance",
    );
  });

  it("de-snakes unknown names and tolerates absence", () => {
    expect(componentDisplayName("spam_words")).toBe("spam words");
    expect(componentDisplayName(undefined)).toBe("Check");
  });
});

describe("formatComponentScore", () => {
  it("renders 0..1 fractions as ×100 and >1 values as-is", () => {
    expect(formatComponentScore(0.82)).toBe("82");
    expect(formatComponentScore(1)).toBe("100");
    expect(formatComponentScore(73)).toBe("73");
  });

  it("em-dashes absent / NaN scores", () => {
    expect(formatComponentScore(undefined)).toBe("—");
    expect(formatComponentScore(null)).toBe("—");
    expect(formatComponentScore(Number.NaN)).toBe("—");
  });
});

describe("verdictReadiness", () => {
  const SUBJ = "Hello there";
  const FROM = "hi@example.com";
  const BODY = "<p>Body</p>";

  it("ok when subject + from + body are present", () => {
    expect(verdictReadiness(SUBJ, FROM, BODY)).toEqual({ ok: true });
  });

  it("gives an actionable reason per missing field, in order", () => {
    expect(verdictReadiness("", FROM, BODY).reason).toMatch(/subject/i);
    expect(verdictReadiness(SUBJ, "  ", BODY).reason).toMatch(/from/i);
    expect(verdictReadiness(SUBJ, FROM, "").reason).toMatch(/body/i);
  });

  it("whitespace-only fields don't count as present", () => {
    expect(verdictReadiness("   ", FROM, BODY).ok).toBe(false);
  });
});

describe("subjectLabSeedReady", () => {
  it("gates at the Lab's own 10-char Generate threshold", () => {
    expect(SUBJECT_LAB_MIN_SEED).toBe(10);
    expect(subjectLabSeedReady("123456789")).toBe(false);
    expect(subjectLabSeedReady("1234567890")).toBe(true);
    expect(subjectLabSeedReady("  1234567890  ")).toBe(true);
    expect(subjectLabSeedReady("         x")).toBe(false);
  });
});
