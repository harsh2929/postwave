/**
 * lib/subjectLabSeed.ts — the `?seed` / `?campaignId` grammar between the
 * campaign subject sheet and the Subject Lab tab.
 *
 * Desktop opens its SubjectLab overlay inside the same React tree as the
 * draft, so the seed is a prop (CampaignCreateOverlays.tsx:376
 * `seedSubject={state.draft.subject}`). Mobile's lab is a TAB, so the seam is
 * a route param — and a route param is a contract with two sides that drift
 * apart silently: the link encodes, the screen decodes, and nothing else ever
 * checks they agree. Both halves live here so one round-trip test can.
 *
 * What the pair guarantees:
 *   - whitespace is trimmed on the way out AND on the way in, so a subject
 *     typed with a trailing newline does not arrive as a seed the generator's
 *     floor (SUBJECT_LAB_SEED_MIN) measures differently from the sheet;
 *   - an empty subject sends NO seed key rather than an empty string the
 *     screen would then have to treat as absent anyway;
 *   - a seed is clamped to CAMPAIGN_SUBJECT_MAX on both sides, so a
 *     hand-built link cannot put more into the lab's boxes than a campaign
 *     subject can hold;
 *   - a repeated key (expo-router hands `?seed=a&seed=b` back as string[]) is
 *     read as its FIRST value, never joined or dropped.
 *
 * Pure: no react-native / expo import, node vitest reaches it.
 */
import { CAMPAIGN_SUBJECT_MAX } from "@/lib/campaignCreate";

/**
 * The params the subject sheet's link pushes onto /(tabs)/subject-lab. A type
 * literal, not an interface: expo-router's `router.push` params are an
 * index-signature Record, and only object-literal types get the implicit index
 * signature that makes the two assignable.
 */
export type SubjectLabSeedParams = {
  seed?: string;
  campaignId?: string;
};

/** What the screen reads back out of useLocalSearchParams. */
export interface SubjectLabArrival {
  /** The campaign's subject to seed both lab boxes with; null when absent. */
  seed: string | null;
  /** Arms the lab → bandit handoff against this campaign; undefined when absent. */
  campaignId: string | undefined;
}

function clampSeed(raw: unknown): string {
  const text = firstString(raw).trim();
  return text.length > CAMPAIGN_SUBJECT_MAX
    ? text.slice(0, CAMPAIGN_SUBJECT_MAX)
    : text;
}

/** A string as itself, a string[] as its first string, anything else as "". */
function firstString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === "string");
    return typeof first === "string" ? first : "";
  }
  return "";
}

/**
 * Encode: the exact params CampaignSubjectLabLink pushes. Keys are OMITTED,
 * never sent empty, so `?seed=` can never reach the screen.
 */
export function subjectLabSeedParams(
  subject: string | null | undefined,
  campaignId: string | null | undefined,
): SubjectLabSeedParams {
  const seed = clampSeed(subject);
  const id = firstString(campaignId).trim();
  return {
    ...(seed ? { seed } : {}),
    ...(id ? { campaignId: id } : {}),
  };
}

/**
 * Decode: what app/(tabs)/subject-lab.tsx reads out of its route params.
 * Accepts the raw params object (values may be string, string[] or absent)
 * and applies the SAME trim + clamp the encoder did, so a link built by hand
 * lands exactly where a link built by the sheet would.
 */
export function readSubjectLabArrival(params: unknown): SubjectLabArrival {
  const record =
    params && typeof params === "object"
      ? (params as Readonly<Record<string, unknown>>)
      : {};
  const seed = clampSeed(record.seed);
  const campaignId = firstString(record.campaignId).trim();
  return {
    seed: seed ? seed : null,
    campaignId: campaignId ? campaignId : undefined,
  };
}
