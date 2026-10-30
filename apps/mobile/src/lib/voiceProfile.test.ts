import { describe, expect, it } from "vitest";

import type { VoiceProfile } from "@/hooks/useVoice";
import {
  voiceCachedSessionNotice,
  voiceDistinctiveTerms,
  voicePersonaSummary,
  voiceSamples,
  voiceSourceLines,
  voiceStyleStats,
  voiceToneAxes,
  voiceToneSummary,
} from "./voiceProfile";

const profile = {
  generated_at: "2026-07-10T10:00:00Z",
  tonal: {
    humor: 0.7,
    optimism: 0.8,
    personal_vs_observational: 0.5,
    directness: 0.75,
    formality: 0.2,
    warmth: 0.9,
  },
  persona: {
    recurring_themes: ["shipping", "craft", "teams"],
  },
} satisfies VoiceProfile;

describe("voice profile summaries", () => {
  it("summarizes the real tonal vector", () => {
    expect(voiceToneSummary(profile)).toBe("warm · direct · casual");
  });

  it("surfaces real recurring persona themes", () => {
    expect(voicePersonaSummary(profile)).toBe("shipping · craft · teams");
  });
});

describe("voiceToneAxes", () => {
  it("returns each measured axis with an exact spoken value", () => {
    const axes = voiceToneAxes(profile);
    expect(axes.map((a) => a.key)).toEqual([
      "warmth",
      "directness",
      "formality",
      "humor",
      "optimism",
      "personal_vs_observational",
    ]);
    expect(axes[0]).toMatchObject({
      label: "Warmth",
      value: 0.9,
      spoken: "90 out of 100",
      reading: "warm",
    });
    expect(axes[2]?.reading).toBe("casual");
  });

  it("omits axes the server did not measure rather than drawing them at zero", () => {
    const partial: VoiceProfile = {
      generated_at: "",
      tonal: {
        humor: 0.4,
        optimism: 0.4,
        personal_vs_observational: 0.4,
        directness: 0.4,
      },
      persona: {},
    };
    expect(voiceToneAxes(partial).map((a) => a.key)).toEqual([
      "directness",
      "humor",
      "optimism",
      "personal_vs_observational",
    ]);
  });

  it("ignores non-finite axis values and clamps out-of-range ones", () => {
    const weird = {
      generated_at: "",
      tonal: {
        humor: Number.NaN,
        optimism: 1.4,
        personal_vs_observational: -0.5,
        directness: 0.5,
      },
      persona: {},
    } as unknown as VoiceProfile;
    const axes = voiceToneAxes(weird);
    expect(axes.find((a) => a.key === "humor")).toBeUndefined();
    expect(axes.find((a) => a.key === "optimism")?.value).toBe(1);
    expect(
      axes.find((a) => a.key === "personal_vs_observational")?.value,
    ).toBe(0);
  });
});

describe("voiceStyleStats", () => {
  it("renders measured style rows and drops malformed ones", () => {
    const p = {
      ...profile,
      stylistic: {
        avg_sentence_length: 14.25,
        passive_voice_pct: 0.12,
        hedging_frequency: Number.POSITIVE_INFINITY,
      },
      structural: { opening_hook_style: "question", closing_pattern: "  " },
    } as unknown as VoiceProfile;
    expect(voiceStyleStats(p)).toEqual([
      { key: "avg_sentence_length", label: "Avg sentence", value: "14.3 words" },
      { key: "passive_voice_pct", label: "Passive voice", value: "12%" },
      { key: "opening_hook_style", label: "Opens with", value: "question" },
    ]);
  });

  it("returns nothing when the server sent no stylistic section", () => {
    expect(voiceStyleStats(profile)).toEqual([]);
  });
});

describe("voiceDistinctiveTerms", () => {
  it("dedupes case-insensitively, trims, and caps", () => {
    const p = {
      ...profile,
      vocabulary: {
        distinctive_terms: [
          { term: " ship " },
          { term: "Ship" },
          { term: "" },
          { term: "craft" },
        ],
      },
    } as unknown as VoiceProfile;
    expect(voiceDistinctiveTerms(p)).toEqual(["ship", "craft"]);
    expect(voiceDistinctiveTerms(p, 1)).toEqual(["ship"]);
  });

  it("tolerates a missing vocabulary section", () => {
    expect(voiceDistinctiveTerms(profile)).toEqual([]);
  });
});

describe("voiceSamples", () => {
  it("skips blank passages and caps the count", () => {
    const p = {
      ...profile,
      representative_samples: [
        { id: "a", text: "  ", source_type: "blog" },
        { id: "b", text: " Real passage ", source_type: " blog " },
        { text: "second" },
        { text: "third" },
        { text: "fourth" },
      ],
    } as unknown as VoiceProfile;
    const samples = voiceSamples(p);
    expect(samples).toHaveLength(3);
    expect(samples[0]).toEqual({
      key: "b",
      text: "Real passage",
      sourceType: "blog",
    });
    expect(samples[1]?.sourceType).toBeNull();
  });
});

describe("voiceSourceLines", () => {
  it("orders sources by corpus size and humanises the key", () => {
    const p = {
      ...profile,
      source_summary: {
        past_sends: { word_count: 100, item_count: 2 },
        blog_rss: { word_count: 900, item_count: 1 },
      },
    } as unknown as VoiceProfile;
    expect(voiceSourceLines(p)).toEqual([
      { key: "blog_rss", label: "blog rss", detail: "1 item · 900 words" },
      { key: "past_sends", label: "past sends", detail: "2 items · 100 words" },
    ]);
  });
});

describe("voiceCachedSessionNotice", () => {
  it("returns null when the gate is open — the query owns the state", () => {
    expect(
      voiceCachedSessionNotice({ gateEnabled: true, hasTenant: true }),
    ).toBeNull();
  });

  it("never lets a closed gate read as 'no profile exists'", () => {
    const notice = voiceCachedSessionNotice({
      gateEnabled: false,
      hasTenant: true,
    });
    expect(notice?.title).toBe("Reconnect to load your voice profile");
    expect(notice?.description).toContain("can't tell whether");
  });

  it("distinguishes a missing workspace from an unvalidated session", () => {
    expect(
      voiceCachedSessionNotice({ gateEnabled: false, hasTenant: false })?.title,
    ).toBe("Reconnect your workspace");
  });
});
