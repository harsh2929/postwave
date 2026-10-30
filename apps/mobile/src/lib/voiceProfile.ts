import type { CachedSessionNoticeContent } from "@/components/CachedSessionNotice";
import type { VoiceProfile } from "@/hooks/useVoice";

function score(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function voiceToneSummary(profile: VoiceProfile): string {
  const labels: string[] = [];
  const tonal = profile.tonal;
  const warmth = score(tonal?.warmth);
  const directness = score(tonal?.directness);
  const formality = score(tonal?.formality);
  const humor = score(tonal?.humor);
  const optimism = score(tonal?.optimism);

  if (warmth != null) labels.push(warmth >= 0.6 ? "warm" : "reserved");
  if (directness != null) {
    labels.push(directness >= 0.6 ? "direct" : "exploratory");
  }
  if (formality != null) labels.push(formality >= 0.6 ? "formal" : "casual");
  if (humor != null && humor >= 0.55) labels.push("playful");
  if (optimism != null && optimism >= 0.6) labels.push("optimistic");

  return labels.slice(0, 3).join(" · ") || "Measured voice profile";
}

export function voicePersonaSummary(profile: VoiceProfile): string | null {
  const themes = profile.persona?.recurring_themes
    ?.map((theme) => theme.trim())
    .filter(Boolean);
  if (themes?.length) return themes.slice(0, 4).join(" · ");

  const pronouns = Object.entries(profile.persona?.pronoun_usage ?? {}).filter(
    ([, value]) => Number.isFinite(value),
  );
  pronouns.sort((a, b) => b[1] - a[1]);
  const lead = pronouns[0]?.[0]?.toLowerCase();
  if (lead === "you") return "Reader-focused";
  if (lead === "we") return "Community-focused";
  if (lead === "i") return "First-person perspective";
  return null;
}

/* ------------------------------------------------------------------ *
 * Measured fingerprint — the six wire sections the screen used to drop
 * ------------------------------------------------------------------ */

/** One 0..1 tonal axis, ready to draw as a labelled bar. */
export interface VoiceAxis {
  key: string;
  label: string;
  /** 0..1, clamped. */
  value: number;
  /** Spoken/percent form for assistive tech — a bar width says nothing. */
  spoken: string;
  /** Which end of the axis this reading sits at, in words. */
  reading: string;
}

const AXES: readonly {
  key: keyof NonNullable<VoiceProfile["tonal"]>;
  label: string;
  low: string;
  high: string;
}[] = [
  { key: "warmth", label: "Warmth", low: "clinical", high: "warm" },
  { key: "directness", label: "Directness", low: "exploratory", high: "direct" },
  { key: "formality", label: "Formality", low: "casual", high: "formal" },
  { key: "humor", label: "Humor", low: "straight", high: "playful" },
  { key: "optimism", label: "Optimism", low: "measured", high: "optimistic" },
  {
    key: "personal_vs_observational",
    label: "Personal voice",
    low: "observational",
    high: "personal",
  },
];

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * The tonal vector as drawable axes. Axes the server did not measure are
 * OMITTED rather than drawn at zero — a missing measurement and a measured
 * zero are different claims, and rendering them identically is a lie.
 */
export function voiceToneAxes(profile: VoiceProfile): VoiceAxis[] {
  const tonal = profile.tonal;
  const out: VoiceAxis[] = [];
  for (const axis of AXES) {
    const raw = score(tonal?.[axis.key]);
    if (raw === null) continue;
    const value = clamp01(raw);
    out.push({
      key: String(axis.key),
      label: axis.label,
      value,
      spoken: `${Math.round(value * 100)} out of 100`,
      reading: value >= 0.5 ? axis.high : axis.low,
    });
  }
  return out;
}

export interface VoiceStatLine {
  key: string;
  label: string;
  value: string;
}

function round(value: number, places: number): string {
  return value.toFixed(places).replace(/\.0+$/, "");
}

/**
 * Stylistic + structural measurements as display rows. Every value is guarded
 * with the same finite check the tone summary uses, so a missing or malformed
 * server field disappears instead of rendering "NaN".
 */
export function voiceStyleStats(profile: VoiceProfile): VoiceStatLine[] {
  const out: VoiceStatLine[] = [];
  const s = profile.stylistic;
  const avg = score(s?.avg_sentence_length);
  if (avg !== null) {
    out.push({
      key: "avg_sentence_length",
      label: "Avg sentence",
      value: `${round(avg, 1)} words`,
    });
  }
  const passive = score(s?.passive_voice_pct);
  if (passive !== null) {
    out.push({
      key: "passive_voice_pct",
      label: "Passive voice",
      // The server emits a 0..1 fraction; render it as a percentage.
      value: `${Math.round(clamp01(passive) * 100)}%`,
    });
  }
  const hedging = score(s?.hedging_frequency);
  if (hedging !== null) {
    out.push({
      key: "hedging_frequency",
      label: "Hedging",
      value: `${round(hedging, 1)} / 1k words`,
    });
  }
  const opening = profile.structural?.opening_hook_style?.trim();
  if (opening) {
    out.push({ key: "opening_hook_style", label: "Opens with", value: opening });
  }
  const closing = profile.structural?.closing_pattern?.trim();
  if (closing) {
    out.push({ key: "closing_pattern", label: "Closes with", value: closing });
  }
  return out;
}

/** Top distinctive terms, de-duplicated and trimmed. */
export function voiceDistinctiveTerms(
  profile: VoiceProfile,
  limit = 12,
): string[] {
  const terms = profile.vocabulary?.distinctive_terms;
  if (!Array.isArray(terms)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of terms) {
    const term = typeof entry?.term === "string" ? entry.term.trim() : "";
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= limit) break;
  }
  return out;
}

export interface VoiceSourceLine {
  key: string;
  label: string;
  detail: string;
}

/** Per-source ingest stats, biggest corpus first. */
export function voiceSourceLines(profile: VoiceProfile): VoiceSourceLine[] {
  const summary = profile.source_summary;
  if (!summary || typeof summary !== "object") return [];
  return Object.entries(summary)
    .map(([key, stat]) => {
      const words = score(stat?.word_count) ?? 0;
      const items = score(stat?.item_count) ?? 0;
      return {
        key,
        label: key.replace(/[_-]+/g, " "),
        words,
        detail: `${Math.round(items)} ${Math.round(items) === 1 ? "item" : "items"} · ${Math.round(words)} words`,
      };
    })
    .sort((a, b) => b.words - a.words)
    .map(({ key, label, detail }) => ({ key, label, detail }));
}

export interface VoiceSample {
  key: string;
  text: string;
  sourceType: string | null;
}

/** Representative passages, trimmed and capped so a card stays readable. */
export function voiceSamples(profile: VoiceProfile, limit = 3): VoiceSample[] {
  const samples = profile.representative_samples;
  if (!Array.isArray(samples)) return [];
  const out: VoiceSample[] = [];
  for (const [index, sample] of samples.entries()) {
    const text = typeof sample?.text === "string" ? sample.text.trim() : "";
    if (!text) continue;
    const sourceType =
      typeof sample?.source_type === "string" && sample.source_type.trim()
        ? sample.source_type.trim()
        : null;
    out.push({
      key: typeof sample?.id === "string" && sample.id ? sample.id : `s${index}`,
      text,
      sourceType,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Offline / cached-session copy
 * ------------------------------------------------------------------ */

/**
 * The Voice tab's cached-session copy.
 *
 * Kept here rather than in the shared CachedSessionNotice surface table so the
 * automation cluster owns its own wording. The bug this closes: with the online
 * gate closed the query never runs, so `data` is `undefined` and the screen
 * fell through to "No voice profile yet" — a manufactured negative claim about
 * tenant state made without ever talking to the server.
 */
export const VOICE_CACHED_SESSION_COPY: CachedSessionNoticeContent = {
  title: "Reconnect to load your voice profile",
  description:
    "This cached session has not been validated online yet, so we can't tell whether a voice profile exists. Reconnect to load it.",
  staleMessage:
    "Reconnect before refreshing your voice profile. Showing the last loaded measurement.",
};

export function voiceCachedSessionNotice({
  gateEnabled,
  hasTenant,
}: {
  gateEnabled: boolean;
  hasTenant: boolean;
}): CachedSessionNoticeContent | null {
  if (gateEnabled) return null;
  if (!hasTenant) {
    return {
      title: "Reconnect your workspace",
      description:
        "This screen needs an authenticated workspace before it can refresh.",
      staleMessage:
        "Reconnect your workspace before refreshing. Showing anything already cached.",
    };
  }
  return VOICE_CACHED_SESSION_COPY;
}
