import { describe, expect, it } from "vitest";

import {
  canScoreVoiceDrift,
  readVoiceDrift,
  voiceDriftBlocks,
  voiceDriftConsequence,
  voiceDriftSpoken,
  VOICE_DRIFT_CRITICAL_BELOW,
} from "@/lib/voiceDrift";

/**
 * The exact body services/voice/internal/handlers/drift.go returns when the
 * tenant has NO voice profile: 200, score 100, severity ok, zero breakdown.
 * If this ever renders as a passing 100/100 the check is lying.
 */
const NO_PROFILE_RESPONSE = {
  score: 100,
  severity: "ok",
  suggestions: [
    "No voice profile yet — drift check is inactive. Build a voice profile under Settings → Voice to enable warnings.",
  ],
};

const SCORED_RESPONSE = {
  score: 71.4,
  severity: "ok",
  warn: false,
  critical: false,
  breakdown: {
    embedding_similarity: 0.5,
    stylistic_distance: 0.82,
    vocabulary_overlap: 0.31,
    structural_match: 0.64,
    combined: 0.714,
  },
  profile_id: "bv-1",
};

describe("readVoiceDrift", () => {
  it("never reports the no-profile answer as a perfect score", () => {
    const reading = readVoiceDrift(NO_PROFILE_RESPONSE);
    expect(reading.state).toBe("inactive");
    expect(reading.score).toBeNull();
    expect(reading.scoreLabel).toBe("—");
    expect(reading.headline).toBe("Voice check inactive");
    // The server's own hint is what the operator needs to act on.
    expect(reading.detail).toContain("No voice profile yet");
    expect(voiceDriftBlocks(reading)).toBe(false);
  });

  it("treats a missing/garbage body as unmeasured rather than zero", () => {
    for (const raw of [null, undefined, {}, 42, "nope"]) {
      const reading = readVoiceDrift(raw);
      expect(reading.state).toBe("inactive");
      expect(reading.score).toBeNull();
      expect(reading.scoreLabel).toBe("—");
    }
  });

  it("reads a real score and scales 0..1 components to percentages", () => {
    const reading = readVoiceDrift(SCORED_RESPONSE);
    expect(reading.state).toBe("ok");
    expect(reading.score).toBe(71);
    expect(reading.scoreLabel).toBe("71");
    expect(reading.profileId).toBe("bv-1");
    expect(reading.components).toEqual([
      { key: "stylistic_distance", label: "Sentence style", pct: 82 },
      { key: "vocabulary_overlap", label: "Vocabulary", pct: 31 },
      { key: "structural_match", label: "Structure", pct: 64 },
      { key: "embedding_similarity", label: "Semantic style", pct: 50 },
    ]);
    expect(reading.authoredAdjustment).toBeNull();
  });

  it("classifies warn and critical from the server severity", () => {
    expect(
      readVoiceDrift({
        ...SCORED_RESPONSE,
        score: 52,
        severity: "warn",
        warn: true,
      }).state,
    ).toBe("warn");
    const critical = readVoiceDrift({
      ...SCORED_RESPONSE,
      score: 22,
      severity: "critical",
      critical: true,
      warn: true,
      authored_adjustment: -20,
      suggestions: [
        "Wording includes terms your brand-voice profile flags as off-voice — replace them.",
      ],
    });
    expect(critical.state).toBe("critical");
    expect(critical.headline).toBe("This doesn't sound like you");
    expect(critical.authoredAdjustment).toBe(-20);
    expect(voiceDriftBlocks(critical)).toBe(true);
  });

  it("falls back to the published thresholds when severity is absent", () => {
    expect(
      readVoiceDrift({ score: 30, breakdown: { stylistic_distance: 0.2 } }).state,
    ).toBe("critical");
    expect(
      readVoiceDrift({ score: 50, breakdown: { stylistic_distance: 0.4 } }).state,
    ).toBe("warn");
    expect(
      readVoiceDrift({ score: 90, breakdown: { stylistic_distance: 0.9 } }).state,
    ).toBe("ok");
  });

  it("clamps out-of-range scores instead of rendering them", () => {
    expect(
      readVoiceDrift({ score: 143, breakdown: { combined: 1 } }).score,
    ).toBe(100);
    expect(readVoiceDrift({ score: -8, breakdown: { combined: 1 } }).score).toBe(
      0,
    );
  });
});

describe("voiceDriftConsequence", () => {
  it("is null unless the reading is critical", () => {
    expect(voiceDriftConsequence(null)).toBeNull();
    expect(voiceDriftConsequence(readVoiceDrift(SCORED_RESPONSE))).toBeNull();
    expect(voiceDriftConsequence(readVoiceDrift(NO_PROFILE_RESPONSE))).toBeNull();
  });

  it("names the score, the banned-term overlay and the top fix", () => {
    const reading = readVoiceDrift({
      score: 18,
      severity: "critical",
      breakdown: { stylistic_distance: 0.2, combined: 0.18 },
      authored_adjustment: -30,
      suggestions: ["Shorten or tighten."],
    });
    const line = voiceDriftConsequence(reading);
    expect(line).toContain("18/100");
    expect(line).toContain(String(VOICE_DRIFT_CRITICAL_BELOW));
    expect(line).toContain("off-voice");
    expect(line).toContain("Shorten or tighten.");
  });
});

describe("voiceDriftSpoken", () => {
  it("announces the unmeasured case as not measured", () => {
    expect(voiceDriftSpoken(readVoiceDrift(NO_PROFILE_RESPONSE))).toContain(
      "not measured",
    );
    expect(voiceDriftSpoken(null)).toBe("Voice fidelity has not been checked.");
  });

  it("announces the score and each component", () => {
    const spoken = voiceDriftSpoken(readVoiceDrift(SCORED_RESPONSE));
    expect(spoken).toContain("71 out of 100");
    expect(spoken).toContain("Vocabulary 31 percent");
  });
});

describe("canScoreVoiceDrift", () => {
  it("refuses an empty body — the server 400s on one", () => {
    expect(canScoreVoiceDrift("")).toBe(false);
    expect(canScoreVoiceDrift("   ")).toBe(false);
    expect(canScoreVoiceDrift(null)).toBe(false);
    expect(canScoreVoiceDrift(undefined)).toBe(false);
    expect(canScoreVoiceDrift("<p>hi</p>")).toBe(true);
  });
});
